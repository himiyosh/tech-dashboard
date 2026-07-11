const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

const HTML_ENTITY_VALUES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower);
}

function decodeHtmlEntity(entity: string): string {
  const named = entity.match(/^&([a-z]+);$/i);
  if (named) return HTML_ENTITY_VALUES[named[1]!.toLowerCase()] ?? entity;

  const numeric = entity.match(/^&#(x[0-9a-f]+|\d+);$/i);
  if (!numeric) return entity;
  const token = numeric[1]!;
  const codePoint = token[0]!.toLowerCase() === "x"
    ? Number.parseInt(token.slice(1), 16)
    : Number.parseInt(token, 10);
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Decode only HTML entities introduced by feed/metadata serialization.
 * Percent-encoded URL content is intentionally left untouched.
 */
export function normalizeMediaUrl(rawUrl: string): string {
  let current = rawUrl.trim();
  for (let pass = 0; pass < 8; pass++) {
    const next = current.replace(
      /&(?:amp|apos|gt|lt|quot);|&#(?:x[0-9a-f]+|\d+);/gi,
      decodeHtmlEntity,
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  const withoutWww = lower.startsWith("www.") ? lower.slice(4) : lower;
  return withoutWww === "m.youtube.com" ? "youtube.com" : withoutWww;
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

export function canonicalUrlKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    let host = normalizeHost(url.hostname);
    let path = normalizePath(url.pathname);
    let netflixPublication = host === "netflixtechblog.com";

    const mediumNetflixPrefix = "/netflix-techblog/";
    if (
      host === "medium.com" &&
      path.toLowerCase().startsWith(mediumNetflixPrefix) &&
      path.length > mediumNetflixPrefix.length
    ) {
      host = "netflixtechblog.com";
      path = normalizePath(path.slice("/netflix-techblog".length));
      netflixPublication = true;
    }

    if (host === "youtube.com" && path === "/watch") {
      const videoId = url.searchParams.get("v");
      return videoId ? `${host}${path}?v=${videoId}` : `${host}${path}`;
    }

    const params = [...url.searchParams.entries()]
      .filter(([name]) => !isTrackingParam(name) && !(netflixPublication && name.toLowerCase() === "source"))
      .sort(([aName, aValue], [bName, bValue]) =>
        aName === bName ? aValue.localeCompare(bValue) : aName.localeCompare(bName),
      );
    const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
    return `${host}${path}${query}`;
  } catch {
    return null;
  }
}