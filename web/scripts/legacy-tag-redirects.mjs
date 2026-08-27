import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const COMBINING_MARK_RE = /^\p{M}$/u;
const LATIN_CHAR_RE = /^\p{Script=Latin}$/u;

function normalizeTagKey(value) {
  let normalized = "";
  let followsLatin = false;
  for (const character of String(value).trim().normalize("NFKD")) {
    if (COMBINING_MARK_RE.test(character)) {
      if (!followsLatin) normalized += character;
      continue;
    }
    normalized += character;
    followsLatin = LATIN_CHAR_RE.test(character);
  }
  return normalized.normalize("NFC").toLowerCase();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function legacyTagRedirects(
  entries,
  { legacyMinimum = 2, fullPageMinimum = 10 } = {},
) {
  const counts = new Map();
  for (const entry of entries) {
    for (const tag of new Set((entry.tags ?? []).map(normalizeTagKey).filter(Boolean))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= legacyMinimum && count < fullPageMinimum)
    .map(([tag]) => {
      const encodedTag = encodeURIComponent(tag);
      return {
        tag,
        encodedTag,
        searchHref: `/search/?q=${encodedTag}&tag=${encodedTag}`,
      };
    })
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

function redirectHtml({ tag, encodedTag, searchHref }) {
  const safeTag = escapeHtml(tag);
  const safeHref = escapeHtml(searchHref);
  // Self-referential canonical. These 860 stubs previously pointed their canonical
  // at `/search/?q=…`, consolidating every low-count tag onto one parameterised
  // shell — and robots.txt now disallows exactly that query shape, so a canonical
  // aimed there would name a URL crawlers are told not to fetch. The stub's own
  // URL is the only honest canonical; `noindex, follow` still keeps it out of the
  // index while letting the recovery link be followed.
  const safeSelfHref = escapeHtml(`/t/${encodedTag}/`);
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, follow"><meta http-equiv="refresh" content="0;url=${safeHref}"><link rel="canonical" href="${safeSelfHref}"><title>#${safeTag} - TECH Dashboard</title></head><body data-pagefind-ignore><main><h1>#${safeTag}</h1><p>このタグは検索で表示します。<a href="${safeHref}">検索結果を開く</a></p><p lang="en">This tag is available through exact search. <a href="${safeHref}">Open search results</a>.</p></main></body></html>`;
}

export function writeLegacyTagRedirects({ distDirectory, indexPath }) {
  const payload = JSON.parse(readFileSync(indexPath, "utf8"));
  const redirects = legacyTagRedirects(payload.entries ?? []);
  for (const redirect of redirects) {
    const directory = path.join(distDirectory, "t", redirect.encodedTag);
    const destination = path.join(directory, "index.html");
    if (existsSync(destination)) {
      throw new Error(`Legacy tag redirect would overwrite a generated page: ${redirect.tag}`);
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(destination, redirectHtml(redirect), "utf8");
  }
  return redirects.length;
}
