const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower);
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
    const host = normalizeHost(url.hostname);
    const path = normalizePath(url.pathname);

    if (host === "youtube.com" && path === "/watch") {
      const videoId = url.searchParams.get("v");
      return videoId ? `${host}${path}?v=${videoId}` : `${host}${path}`;
    }

    const params = [...url.searchParams.entries()]
      .filter(([name]) => !isTrackingParam(name))
      .sort(([aName, aValue], [bName, bValue]) =>
        aName === bName ? aValue.localeCompare(bValue) : aName.localeCompare(bName),
      );
    const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
    return `${host}${path}${query}`;
  } catch {
    return null;
  }
}