#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { getViteConfig } from "astro/config";
import { createServer } from "vite";
import {
  REQUIRED_LOCALIZED_META_KEYS,
  localizeGeneratedMetadataHtml,
} from "../functions/_shared/localized-metadata.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../../worker/src/publisher-contract.ts";
import {
  MAX_INCREMENTAL_SEARCH_DELTA_BYTES,
  applyDetailAssetShell,
  assertDetailHtmlParity,
  buildIncrementalSearchDeltaRecord,
  captureDetailAssetShell,
  sha256,
  validateDetailAssetShell,
} from "./incremental-render-core.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WEB_ROOT = path.resolve(import.meta.dirname, "..");

function usage() {
  return [
    "use one mode:",
    "  --capture-shell --dist <web/dist> --output <shell.json>",
    "  --render --impact <impact.json> --shell <shell.json> --output <directory>",
    "  --render --base-ref <40-hex-sha> --shell <shell.json> --output <directory> --full-detail-snapshot",
    "  --verify-parity --bundle <bundle.json> --dist <web/dist>",
  ].join("\n");
}

function parseArgs(args) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument?.startsWith("--")) return { ok: false, message: usage() };
    if (argument === "--full-detail-snapshot") {
      flags.add(argument);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      flags.add(argument);
      continue;
    }
    values.set(argument, value);
    index++;
  }
  const modes = ["--capture-shell", "--render", "--verify-parity"]
    .filter((mode) => flags.has(mode));
  if (modes.length !== 1) return { ok: false, message: usage() };
  const mode = modes[0];
  const required = mode === "--capture-shell"
    ? ["--dist", "--output"]
    : mode === "--render"
      ? ["--shell", "--output"]
      : ["--bundle", "--dist"];
  if (required.some((key) => !values.has(key))) {
    return { ok: false, message: usage() };
  }
  const known = new Set([
    ...required,
    ...modes,
    "--full-detail-snapshot",
    "--impact",
    "--base-ref",
  ]);
  if ([...flags, ...values.keys()].some((key) => !known.has(key))) {
    return { ok: false, message: usage() };
  }
  if (mode === "--render") {
    const hasImpact = values.has("--impact");
    const hasBaseRef = values.has("--base-ref");
    if (
      hasImpact === hasBaseRef
      || (hasBaseRef && !flags.has("--full-detail-snapshot"))
    ) {
      return { ok: false, message: usage() };
    }
  }
  return {
    ok: true,
    mode,
    values,
    fullDetailSnapshot: flags.has("--full-detail-snapshot"),
  };
}

function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function firstDetailHtml(distDirectory) {
  const detailDirectory = path.join(distDirectory, "e");
  const id = readdirSync(detailDirectory)
    .filter((name) => /^[0-9a-f]{16}$/.test(name))
    .sort()
    .find((name) => existsSync(path.join(detailDirectory, name, "index.html")));
  if (!id) throw new Error("incremental shell capture found no detail HTML");
  return {
    id,
    file: path.join(detailDirectory, id, "index.html"),
    routePath: `/e/${id}/`,
  };
}

async function captureShell(values) {
  const distDirectory = path.resolve(values.get("--dist"));
  const output = path.resolve(values.get("--output"));
  const detail = firstDetailHtml(distDirectory);
  const shell = captureDetailAssetShell({
    html: readFileSync(detail.file, "utf8"),
    distDirectory,
    capturedFromPath: detail.routePath,
    publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
  });
  atomicWrite(output, `${JSON.stringify(shell, null, 2)}\n`);
  console.log(
    `INCREMENTAL: shell family=detail-pages assets=${shell.assets.length} digest=${shell.digest}`,
  );
}

function validateImpact(value) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== 2
    || typeof value.baseRef !== "string"
    || !value.incremental
    || typeof value.incremental !== "object"
    || !Array.isArray(value.incremental.detailUpsertIds)
    || !Array.isArray(value.incremental.detailTombstoneIds)
    || !Array.isArray(value.incremental.searchDeltaIds)
    || !Array.isArray(value.incremental.blockers)
  ) {
    throw new Error("incremental renderer requires Publisher impact version 2");
  }
  return value;
}

function writeObject(outputDirectory, extension, content) {
  const digest = sha256(content);
  const relativePath = `objects/${digest}.${extension}`;
  atomicWrite(path.join(outputDirectory, relativePath), content);
  return Object.freeze({
    digest,
    bytes: Buffer.byteLength(content),
    file: relativePath,
  });
}

function localizedEnglishHtml(html) {
  const localized = localizeGeneratedMetadataHtml(html, "en");
  const keys = new Set(localized.localizedKeys);
  const missing = REQUIRED_LOCALIZED_META_KEYS.filter((key) => !keys.has(key));
  if (missing.length > 0) {
    throw new Error(
      `incremental English metadata is missing required keys: ${missing.join(", ")}`,
    );
  }
  return localized.html;
}

async function createViteServer() {
  const configFactory = getViteConfig(
    {
      server: { middlewareMode: true },
      appType: "custom",
    },
    {
      root: WEB_ROOT,
      logLevel: "error",
    },
  );
  return createServer(
    await configFactory({ mode: "production", command: "build" }),
  );
}

async function renderBundle(values, fullDetailSnapshot) {
  const impact = values.has("--impact")
    ? validateImpact(readJson(path.resolve(values.get("--impact"))))
    : {
        version: 2,
        baseRef: values.get("--base-ref"),
        incremental: {
          detailUpsertIds: [],
          detailTombstoneIds: [],
          searchDeltaIds: [],
          shadowSafe: false,
          blockers: ["full-shadow-bootstrap"],
        },
      };
  if (!/^[a-f0-9]{40}$/.test(impact.baseRef ?? "")) {
    throw new Error("incremental renderer requires an exact lowercase base ref");
  }
  const shell = validateDetailAssetShell(
    readJson(path.resolve(values.get("--shell"))),
    DEPLOYED_PUBLISHER_FINGERPRINT,
  );
  if (!fullDetailSnapshot && impact.incremental.shadowSafe !== true) {
    throw new Error(
      `incremental shadow refused an unsafe impact: ${impact.incremental.blockers.join(", ") || "unknown blocker"}`,
    );
  }
  const outputDirectory = path.resolve(values.get("--output"));
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
    throw new Error("incremental renderer output directory must be empty");
  }
  mkdirSync(path.join(outputDirectory, "objects"), { recursive: true });
  const shellArtifact = writeObject(
    outputDirectory,
    "shell.json",
    `${JSON.stringify(shell)}\n`,
  );

  const server = await createViteServer();
  const routeArtifacts = [];
  let allPathRecords;
  try {
    const page = await server.ssrLoadModule("/src/pages/e/[id].astro");
    allPathRecords = await page.getStaticPaths();
    const byId = new Map(
      allPathRecords.map((record) => [record.params.id, record]),
    );
    const targetIds = fullDetailSnapshot
      ? [...byId.keys()].sort()
      : [...new Set(impact.incremental.detailUpsertIds)].sort();
    const container = await AstroContainer.create({
      resolve: async (specifier) =>
        (await server.pluginContainer.resolveId(specifier))?.id ?? specifier,
    });

    for (const id of targetIds) {
      const route = byId.get(id);
      if (!route) {
        throw new Error(`incremental detail upsert is not addressable: ${id}`);
      }
      const routePath = `/e/${encodeURIComponent(id)}/`;
      const rendered = await container.renderToString(page.default, {
        props: route.props,
        params: route.params,
        request: new Request(`https://techdb.studio344.net${routePath}`),
        partial: false,
      });
      const defaultHtml = applyDetailAssetShell(rendered, shell);
      const englishHtml = localizedEnglishHtml(defaultHtml);
      routeArtifacts.push({
        id,
        path: routePath,
        status: 200,
        variants: {
          default: writeObject(outputDirectory, "html", defaultHtml),
          en: writeObject(outputDirectory, "html", englishHtml),
        },
      });
    }
  } finally {
    await server.close();
  }

  const index = readJson(path.join(ROOT, "data/index.json"));
  const bodies = readJson(path.join(ROOT, "data/bodies.json"));
  const entriesById = new Map(index.entries.map((entry) => [entry.id, entry]));
  const searchRecords = impact.incremental.searchDeltaIds.map((id) => {
    const entry = entriesById.get(id);
    if (!entry) return { id, removed: true };
    return {
      removed: false,
      ...buildIncrementalSearchDeltaRecord(entry, bodies.bodies?.[id] ?? null),
    };
  });
  const searchDelta = `${JSON.stringify({
    version: 1,
    baseRef: impact.baseRef,
    records: searchRecords,
  })}\n`;
  if (Buffer.byteLength(searchDelta) > MAX_INCREMENTAL_SEARCH_DELTA_BYTES) {
    throw new Error("incremental search delta exceeds its byte budget");
  }
  const searchArtifact = searchRecords.length > 0
    ? writeObject(outputDirectory, "json", searchDelta)
    : null;
  const tombstones = [...new Set(impact.incremental.detailTombstoneIds)]
    .sort()
    .map((id) => ({ id, path: `/e/${encodeURIComponent(id)}/`, status: 404 }));
  const bundle = {
    version: 1,
    mode: "shadow",
    publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
    baseRef: impact.baseRef,
    dataGeneratedAt: index.generatedAt,
    shellDigest: shell.digest,
    shell: shellArtifact,
    fullDetailSnapshot,
    coverage: {
      routeFamilies: ["detail-pages"],
      complete: false,
      cutoverAllowed: false,
    },
    routes: routeArtifacts,
    tombstones,
    searchDelta: searchArtifact,
    unsupportedRouteFamilies: impact.incremental.blockers,
  };
  atomicWrite(
    path.join(outputDirectory, "bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  console.log(
    `INCREMENTAL: rendered=${routeArtifacts.length} tombstones=${tombstones.length} searchRecords=${searchRecords.length} full=${String(fullDetailSnapshot)}`,
  );
}

function verifyBundleParity(values) {
  const bundleFile = path.resolve(values.get("--bundle"));
  const bundleDirectory = path.dirname(bundleFile);
  const distDirectory = path.resolve(values.get("--dist"));
  const bundle = readJson(bundleFile);
  if (!Array.isArray(bundle.routes)) {
    throw new Error("incremental parity requires a route bundle");
  }
  const routePaths = bundle.routes.map((route) => route.path);
  if (new Set(routePaths).size !== routePaths.length) {
    throw new Error("incremental parity found duplicate route paths");
  }
  if (bundle.fullDetailSnapshot === true) {
    const expectedPaths = readdirSync(path.join(distDirectory, "e"))
      .filter((id) =>
        /^[0-9a-f]{16}$/.test(id)
        && existsSync(path.join(distDirectory, "e", id, "index.html"))
      )
      .map((id) => `/e/${id}/`)
      .sort();
    const actualPaths = [...routePaths].sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
      throw new Error(
        `incremental full detail route set mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`,
      );
    }
  }
  let verified = 0;
  for (const route of bundle.routes) {
    const expectedFile = path.join(
      distDirectory,
      route.path.replace(/^\/+|\/+$/g, ""),
      "index.html",
    );
    if (!existsSync(expectedFile)) {
      throw new Error(`incremental parity is missing static route: ${route.path}`);
    }
    const staticHtml = readFileSync(expectedFile, "utf8");
    const defaultHtml = readFileSync(
      path.join(bundleDirectory, route.variants.default.file),
      "utf8",
    );
    const englishHtml = readFileSync(
      path.join(bundleDirectory, route.variants.en.file),
      "utf8",
    );
    assertDetailHtmlParity(staticHtml, defaultHtml);
    assertDetailHtmlParity(localizedEnglishHtml(staticHtml), englishHtml);
    verified++;
  }
  console.log(`INCREMENTAL: parity verified=${verified}`);
}

export async function runIncrementalRendererCli(args) {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    console.error(`ERR: ${parsed.message}`);
    return 1;
  }
  if (parsed.mode === "--capture-shell") {
    await captureShell(parsed.values);
  } else if (parsed.mode === "--render") {
    await renderBundle(parsed.values, parsed.fullDetailSnapshot);
  } else {
    verifyBundleParity(parsed.values);
  }
  return 0;
}

const isDirectInvocation =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectInvocation) {
  runIncrementalRendererCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`ERR: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
