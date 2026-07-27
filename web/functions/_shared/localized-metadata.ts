export interface LocalizedMetadataContext {
  request: Request;
  next(): Promise<Response>;
}

export interface LocalizedHtmlResult {
  html: string;
  localizedKeys: string[];
}

export const REQUIRED_LOCALIZED_META_KEYS = [
  "title",
  "description",
  "og:title",
  "og:description",
  "og:url",
  "og:image:alt",
  "og:locale",
  "og:locale:alternate",
  "twitter:title",
  "twitter:description",
  "twitter:image:alt",
] as const;

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#39|#(\d+)|#x([0-9a-f]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      const named: Record<string, string> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&#39;": "'",
      };
      return named[entity.toLowerCase()] ?? entity;
    },
  );
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attributeValue(attributes: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(
    new RegExp(`${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  const encoded = match?.[1] ?? match?.[2];
  return encoded === undefined ? null : decodeHtmlAttribute(encoded);
}

function setAttribute(tag: string, name: string, value: string): string {
  const escaped = escapeHtmlAttribute(value);
  const attributePattern = new RegExp(
    `(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`,
    "i",
  );
  if (attributePattern.test(tag)) {
    return tag.replace(attributePattern, (_full, prefix: string) => `${prefix}"${escaped}"`);
  }
  return tag.replace(/\s*\/?>$/, (ending) => ` ${name}="${escaped}"${ending}`);
}

interface OpeningTag {
  start: number;
  end: number;
  source: string;
}

function openingTags(html: string, tagName: string): OpeningTag[] {
  const lower = html.toLowerCase();
  const needle = `<${tagName.toLowerCase()}`;
  const tags: OpeningTag[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = lower.indexOf(needle, cursor);
    if (start < 0) break;
    const boundary = lower[start + needle.length];
    if (boundary && !/[\s/>]/.test(boundary)) {
      cursor = start + needle.length;
      continue;
    }

    let quote: "'" | '"' | null = null;
    let end = start + needle.length;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (character === ">") {
        end += 1;
        break;
      }
    }
    if (end > html.length || html[end - 1] !== ">") break;
    tags.push({ start, end, source: html.slice(start, end) });
    cursor = end;
  }

  return tags;
}

function setHtmlLanguage(html: string, lang: "en"): string {
  const tag = openingTags(html, "html")[0];
  if (!tag) return html;
  const replacement = setAttribute(
    setAttribute(tag.source, "lang", lang),
    "data-lang",
    lang,
  );
  return `${html.slice(0, tag.start)}${replacement}${html.slice(tag.end)}`;
}

export function localizeGeneratedMetadataHtml(
  html: string,
  lang: "en",
): LocalizedHtmlResult {
  const localizedKeys: string[] = [];
  let output = setHtmlLanguage(html, lang);

  for (const key of REQUIRED_LOCALIZED_META_KEYS) {
    if (key === "title") {
      const matches = openingTags(output, "title").filter(
        (tag) => attributeValue(tag.source, "data-meta-key") === key,
      );
      if (matches.length !== 1) continue;
      const tag = matches[0];
      if (!tag) continue;
      const localized = attributeValue(tag.source, `data-meta-content-${lang}`);
      const closeStart = output.toLowerCase().indexOf("</title", tag.end);
      if (localized === null || closeStart < 0) continue;
      localizedKeys.push(key);
      output = `${output.slice(0, tag.end)}${escapeHtmlText(localized)}${output.slice(closeStart)}`;
      continue;
    }

    const matches = openingTags(output, "meta").filter(
      (tag) => attributeValue(tag.source, "data-meta-key") === key,
    );
    if (matches.length !== 1) continue;
    const tag = matches[0];
    if (!tag) continue;
    const localized = attributeValue(tag.source, `data-meta-content-${lang}`);
    if (localized === null) continue;
    localizedKeys.push(key);
    const replacement = setAttribute(tag.source, "content", localized);
    output = `${output.slice(0, tag.start)}${replacement}${output.slice(tag.end)}`;
  }

  return { html: output, localizedKeys };
}

function localizedMetadataUnavailable(): Response {
  return new Response("Localized metadata unavailable", {
    status: 500,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleLocalizedMetadataRequest(
  context: LocalizedMetadataContext,
): Promise<Response> {
  const url = new URL(context.request.url);
  if (context.request.method !== "GET" || url.searchParams.get("lang") !== "en") {
    return context.next();
  }

  const response = await context.next();
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !/^text\/html\b/i.test(contentType)) return response;

  const localized = localizeGeneratedMetadataHtml(await response.text(), "en");
  const localizedKeys = new Set(localized.localizedKeys);
  if (REQUIRED_LOCALIZED_META_KEYS.some((key) => !localizedKeys.has(key))) {
    return localizedMetadataUnavailable();
  }

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("Content-Language", "en");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(localized.html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
