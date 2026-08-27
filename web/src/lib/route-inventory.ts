export const TAG_PAGE_MIN_ENTRIES = 10;

/**
 * Generated HTML routes that must never be indexed: parameterised shells and
 * design previews with no standalone content. They stay crawlable so the
 * `noindex` directive is readable, but they are kept out of the sitemap.
 * `web/scripts/validate-sitemap-dist.mjs` owns the build-time enforcement in
 * `EXPECTED_NOINDEX_PATHS` (a standalone .mjs cannot import this TypeScript
 * module); `tests/web-sitemap.test.ts` pins the two lists to each other.
 */
export const NOINDEX_PATHS = [
  "/sample/article/",
  "/search/",
] as const;

export const SITEMAP_STATIC_PATHS = [
  "/",
  "/categories/",
  "/arxiv/",
  "/knowledge/",
  "/glossary/",
  "/archive/",
  "/status/",
  "/about/",
  "/editorial-policy/",
  "/privacy/",
] as const;

export function totalPageCount(entryCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(entryCount / pageSize));
}

export function paginationPageNumbers(
  entryCount: number,
  pageSize: number,
): number[] {
  const total = totalPageCount(entryCount, pageSize);
  return Array.from(
    { length: Math.max(0, total - 1) },
    (_, index) => index + 2,
  );
}

export function timelinePagePath(page: number): string {
  return `/page/${page}/`;
}

export function categoryPath(slug: string, page = 1): string {
  const base = `/c/${encodeURIComponent(slug)}`;
  return page > 1 ? `${base}/page/${page}/` : `${base}/`;
}

export function tagPath(tag: string, page = 1): string {
  const base = `/t/${encodeURIComponent(tag)}`;
  return page > 1 ? `${base}/page/${page}/` : `${base}/`;
}

export function archiveMonthPath(month: string): string {
  return `/archive/${encodeURIComponent(month)}/`;
}

export function detailPath(id: string): string {
  return `/e/${encodeURIComponent(id)}/`;
}
