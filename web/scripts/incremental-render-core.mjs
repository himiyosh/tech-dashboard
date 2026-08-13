import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  parse,
  parseFragment,
  serialize,
  serializeOuter,
} from "parse5";

export const INCREMENTAL_SHELL_VERSION = 1;
export const MAX_INCREMENTAL_ROUTE_BYTES = 5_000_000;
export const MAX_INCREMENTAL_SHELL_BYTES = 64 * 1024;
export const MAX_INCREMENTAL_SEARCH_DELTA_BYTES = 1_000_000;

function childNodes(node) {
  return Array.isArray(node?.childNodes) ? node.childNodes : [];
}

function attribute(node, name) {
  return node?.attrs?.find((candidate) => candidate.name === name)?.value ?? null;
}

function isElement(node, tagName) {
  return node?.nodeName === tagName;
}

function walk(node, visit) {
  visit(node);
  for (const child of childNodes(node)) walk(child, visit);
}

function findElement(node, tagName) {
  let found = null;
  walk(node, (candidate) => {
    if (found === null && isElement(candidate, tagName)) found = candidate;
  });
  return found;
}

function isStylesheet(node) {
  if (!isElement(node, "link")) return false;
  const rel = attribute(node, "rel")?.toLowerCase().split(/\s+/) ?? [];
  return rel.includes("stylesheet");
}

function isModuleScript(node) {
  return isElement(node, "script")
    && attribute(node, "type")?.toLowerCase() === "module";
}

function assetReference(markup) {
  const fragment = parseFragment(markup);
  const node = childNodes(fragment)[0];
  if (!node) return null;
  if (isStylesheet(node)) return attribute(node, "href");
  if (isModuleScript(node)) return attribute(node, "src");
  return null;
}

function assertGeneratedAssetReference(reference) {
  if (
    reference === null
    || !reference.startsWith("/_astro/")
    || reference.includes("..")
    || reference.includes("\\")
  ) {
    throw new Error(`incremental shell contains an invalid asset reference: ${reference}`);
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function captureDetailAssetShell({
  html,
  distDirectory,
  capturedFromPath,
  publisherFingerprint,
}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(publisherFingerprint)) {
    throw new Error("incremental shell requires the exact publisher fingerprint");
  }
  const document = parse(html);
  const head = findElement(document, "head");
  const body = findElement(document, "body");
  if (!head || !body) {
    throw new Error("incremental shell source must be a complete HTML document");
  }

  const headAssets = childNodes(head)
    .filter((node) => isElement(node, "style") || isStylesheet(node))
    .map((node) => serializeOuter(node));
  const moduleScripts = [];
  walk(document, (node) => {
    if (isModuleScript(node)) moduleScripts.push(serializeOuter(node));
  });
  if (headAssets.length === 0 || moduleScripts.length === 0) {
    throw new Error("incremental shell source is missing production assets");
  }

  const references = [...new Set([
    ...headAssets.map(assetReference),
    ...moduleScripts.map(assetReference),
  ].filter((value) => value !== null))];
  const assets = references.map((reference) => {
    assertGeneratedAssetReference(reference);
    const absolute = path.resolve(distDirectory, `.${reference}`);
    const relative = path.relative(path.resolve(distDirectory), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`incremental shell asset escapes dist: ${reference}`);
    }
    const bytes = readFileSync(absolute);
    return Object.freeze({
      path: reference,
      bytes: statSync(absolute).size,
      sha256: sha256(bytes),
    });
  });
  const shellWithoutDigest = {
    version: INCREMENTAL_SHELL_VERSION,
    routeFamily: "detail-pages",
    publisherFingerprint,
    capturedFromPath,
    headAssets,
    moduleScripts,
    assets,
  };
  const digest = sha256(JSON.stringify(shellWithoutDigest));
  const shell = Object.freeze({ ...shellWithoutDigest, digest });
  const byteLength = Buffer.byteLength(JSON.stringify(shell));
  if (byteLength > MAX_INCREMENTAL_SHELL_BYTES) {
    throw new Error(
      `incremental shell exceeds ${MAX_INCREMENTAL_SHELL_BYTES} bytes: ${byteLength}`,
    );
  }
  return shell;
}

export function validateDetailAssetShell(value, expectedFingerprint) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== INCREMENTAL_SHELL_VERSION
    || value.routeFamily !== "detail-pages"
    || value.publisherFingerprint !== expectedFingerprint
    || typeof value.capturedFromPath !== "string"
    || !Array.isArray(value.headAssets)
    || value.headAssets.some((item) => typeof item !== "string")
    || !Array.isArray(value.moduleScripts)
    || value.moduleScripts.some((item) => typeof item !== "string")
    || !Array.isArray(value.assets)
    || typeof value.digest !== "string"
  ) {
    throw new Error("incremental detail shell is invalid");
  }
  const { digest, ...withoutDigest } = value;
  if (digest !== sha256(JSON.stringify(withoutDigest))) {
    throw new Error("incremental detail shell digest mismatch");
  }
  for (const markup of [...value.headAssets, ...value.moduleScripts]) {
    const reference = assetReference(markup);
    if (reference !== null) assertGeneratedAssetReference(reference);
  }
  const byteLength = Buffer.byteLength(JSON.stringify(value));
  if (byteLength > MAX_INCREMENTAL_SHELL_BYTES) {
    throw new Error("incremental detail shell is too large");
  }
  return value;
}

export function applyDetailAssetShell(renderedHtml, shell) {
  const document = parse(renderedHtml, { sourceCodeLocationInfo: true });
  const head = findElement(document, "head");
  const body = findElement(document, "body");
  if (!head || !body) {
    throw new Error("incremental detail render must be a complete HTML document");
  }

  const assetRanges = [];
  walk(head, (node) => {
    if (isElement(node, "style") || isStylesheet(node)) {
      const location = node.sourceCodeLocation;
      if (!location) throw new Error("incremental detail asset has no source location");
      assetRanges.push([location.startOffset, location.endOffset]);
    }
  });
  const moduleRanges = [];
  walk(document, (node) => {
    if (!isModuleScript(node)) return;
    const location = node.sourceCodeLocation;
    if (!location) throw new Error("incremental detail script has no source location");
    moduleRanges.push([location.startOffset, location.endOffset]);
  });
  if (moduleRanges.length !== shell.moduleScripts.length) {
    throw new Error(
      `incremental detail module count ${moduleRanges.length} does not match shell ${shell.moduleScripts.length}`,
    );
  }
  let html = renderedHtml;
  const replacements = [
    ...assetRanges.map(([start, end]) => ({ start, end, content: "" })),
    ...moduleRanges.map(([start, end], index) => ({
      start,
      end,
      content: shell.moduleScripts[index],
    })),
  ].sort((left, right) => right.start - left.start);
  for (const replacement of replacements) {
    html = `${html.slice(0, replacement.start)}${replacement.content}${html.slice(replacement.end)}`;
  }
  const headClose = html.toLowerCase().lastIndexOf("</head>");
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (headClose < 0 || bodyClose < 0) {
    throw new Error("incremental detail render is missing a closing document tag");
  }
  html = `${html.slice(0, headClose)}${shell.headAssets.join("")}${html.slice(headClose)}`;

  const finalDocument = parse(html);
  walk(finalDocument, (node) => {
    const reference = isStylesheet(node)
      ? attribute(node, "href")
      : isModuleScript(node)
        ? attribute(node, "src")
        : null;
    if (reference !== null) assertGeneratedAssetReference(reference);
  });
  const byteLength = Buffer.byteLength(html);
  if (byteLength > MAX_INCREMENTAL_ROUTE_BYTES) {
    throw new Error(
      `incremental detail route exceeds ${MAX_INCREMENTAL_ROUTE_BYTES} bytes: ${byteLength}`,
    );
  }
  return html;
}

function normalizedText(node) {
  let text = "";
  const visit = (candidate) => {
    if (attribute(candidate, "data-relative-time") !== null) {
      text += ` RELATIVE:${attribute(candidate, "datetime") ?? attribute(candidate, "data-datetime") ?? "unknown"}`;
      return;
    }
    if (candidate?.nodeName === "#text" && typeof candidate.value === "string") {
      text += ` ${candidate.value}`;
    }
    for (const child of childNodes(candidate)) visit(child);
  };
  visit(node);
  return text.replace(/\s+/g, " ").trim();
}

function headMetadata(document) {
  const values = new Map();
  walk(findElement(document, "head"), (node) => {
    if (isElement(node, "title")) {
      values.set("title", normalizedText(node));
      return;
    }
    if (!isElement(node, "meta")) return;
    const key =
      attribute(node, "data-meta-key")
      ?? attribute(node, "property")
      ?? attribute(node, "name");
    const content = attribute(node, "content");
    if (key && content !== null) values.set(key, content);
  });
  return Object.fromEntries([...values.entries()].sort());
}

function normalizedDocumentDigest(html) {
  const document = parse(html);
  walk(document, (node) => {
    if (attribute(node, "data-relative-time") === null) return;
    const value =
      attribute(node, "datetime")
      ?? attribute(node, "data-datetime")
      ?? "unknown";
    node.childNodes = [{
      nodeName: "#text",
      value: `RELATIVE:${value}`,
      parentNode: node,
    }];
  });
  return sha256(serialize(document));
}

export function detailHtmlSemanticSnapshot(html) {
  const document = parse(html);
  const head = findElement(document, "head");
  const body = findElement(document, "body");
  const canonical = childNodes(head).find(
    (node) =>
      isElement(node, "link")
      && attribute(node, "rel")?.toLowerCase() === "canonical",
  );
  const stylesheets = [];
  const modules = [];
  walk(document, (node) => {
    if (isStylesheet(node)) stylesheets.push(attribute(node, "href"));
    if (isModuleScript(node)) {
      modules.push(attribute(node, "src") ?? sha256(serializeOuter(node)));
    }
  });
  return Object.freeze({
    canonical: canonical ? attribute(canonical, "href") : null,
    documentSha256: normalizedDocumentDigest(html),
    metadata: headMetadata(document),
    mainText: normalizedText(findElement(body, "main")),
    stylesheets,
    modules,
  });
}

export function assertDetailHtmlParity(expectedHtml, actualHtml) {
  const expected = detailHtmlSemanticSnapshot(expectedHtml);
  const actual = detailHtmlSemanticSnapshot(actualHtml);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("incremental detail HTML does not match the static semantic snapshot");
  }
}

export function buildIncrementalSearchDeltaRecord(entry, body) {
  if (!entry) return null;
  return Object.freeze({
    id: entry.id,
    path: `/e/${encodeURIComponent(entry.id)}/`,
    title: entry.title,
    titleJa: entry.titleJa,
    titleEn: entry.titleEn,
    summaryJa: entry.summaryJa,
    summaryEn: entry.summaryEn,
    bodyJa: body?.bodyJa ?? "",
    bodyEn: body?.bodyEn ?? "",
    source: entry.source,
    category: entry.category,
    tags: entry.tags,
    publishedAt: entry.publishedAt,
  });
}
