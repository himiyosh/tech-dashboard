/**
 * article-excerpt.ts — fetch the article page behind a thin feed excerpt and
 * turn its main text into the collected excerpt (`contentSnippet`).
 *
 * Why: the body generator's length band (body-generate.ts bodyLengthPlan) is
 * proportional to the excerpt so the model cannot be asked to invent. Most
 * feeds only carry a 100-300 char description, which caps bodies at ~330 JA
 * chars however high the collector's excerpt cap is. The honest way to longer,
 * better-grounded bodies and summaries is more real material: the article
 * itself, extracted deterministically and capped at the same 900 chars the
 * collector and body generator already agree on.
 *
 * Contract:
 * - Pure extraction (`extractArticleText`) has no network and no DOM; it is
 *   regex/heuristic based so it runs identically in Node and Workers.
 * - `enrichThinExcerpts` is bounded per run (ARTICLE_FETCH_CAP), prefers this
 *   run's NEW entries, then backfills prior thin entries newest-first, and
 *   marks every attempt on the entry (`excerptOrigin`) so a failure is never
 *   retried every hour. Failures keep the feed excerpt (fail-open).
 * - Nothing here is displayed: contentSnippet is model input and grounding
 *   material only (harness/pipeline/normalize.ts documents why).
 */
import type { NormalizedEntry } from "../../harness/types.ts";

/** Mirrors DEFAULT_SNIPPET_CONTEXT_MAX (harness/pipeline/normalize.ts). */
export const ARTICLE_EXCERPT_MAX_CHARS = 900;
/** Below this the excerpt is "thin": the full length band is out of reach. */
export const THIN_EXCERPT_CHARS = 450;
/** Extracted text shorter than this is boilerplate, not an article. */
export const MIN_ARTICLE_TEXT_CHARS = 200;
export const DEFAULT_ARTICLE_FETCH_CAP = 40;
export const DEFAULT_ARTICLE_FETCH_TIMEOUT_MS = 8_000;
/** Response bytes read at most; pages beyond this are truncated, not skipped. */
export const MAX_ARTICLE_HTML_BYTES = 512 * 1024;
const FETCH_CONCURRENCY = 3;
const USER_AGENT = "tech-dashboard-bot/0.1 (+https://github.com/himiyosh/tech-dashboard)";

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&laquo;": "«",
  "&raquo;": "»",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
};

function decodeEntities(value: string): string {
  return value
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|laquo|raquo|copy|reg|trade|#39);/gi,
      (m) => ENTITY_MAP[m.toLowerCase()] ?? m,
    )
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (match, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    });
}

/** Elements whose entire subtree is never article prose. */
const DROP_SUBTREE_RE =
  /<(script|style|noscript|template|svg|iframe|nav|header|footer|aside|form|button|select|figure)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
/** Tags that end a text block; replaced by newlines before tag stripping. */
const BLOCK_RE =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|section|article|main|tr|td|th|blockquote|pre|dd|dt|dl|table|hr)\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
/** A line this short is a menu item, label, or caption, not prose. */
const MIN_LINE_CHARS = 30;
/**
 * A line without sentence punctuation is only prose when it is clearly a
 * paragraph (e.g. a heading-less wall of text); shorter unpunctuated lines
 * are topic menus, tag clouds, or breadcrumbs (Microsoft Research's research-
 * area list is 30-60 chars per item and carries no punctuation).
 */
const MIN_UNPUNCTUATED_LINE_CHARS = 80;
const SENTENCE_PUNCTUATION_RE = /[。．.!！?？]/;
/** Sponsor, consent, and account chrome that survives the structural strip. */
const BOILERPLATE_LINE_RE =
  /^(?:sponsored by|advertisement|advertising|cookie|we use cookies|subscribe|sign in|sign up|log in|share this|related (?:posts|articles)|read more)\b/i;

function isProseLine(line: string): boolean {
  if (line.length < MIN_LINE_CHARS) return false;
  if (BOILERPLATE_LINE_RE.test(line)) return false;
  return SENTENCE_PUNCTUATION_RE.test(line) || line.length >= MIN_UNPUNCTUATED_LINE_CHARS;
}

function innerHtml(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1] ?? "");
  return out;
}

function roleMain(html: string): string[] {
  const re = /<([a-z0-9]+)\b[^>]*\brole=["']main["'][^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[2] ?? "");
  return out;
}

function proseFromFragment(fragment: string): string {
  const cleaned = fragment.replace(COMMENT_RE, "").replace(DROP_SUBTREE_RE, " ");
  const lines = cleaned
    .replace(BLOCK_RE, "\n")
    .replace(TAG_RE, " ")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/\s+/g, " ").trim())
    .filter(isProseLine);
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function metaDescription(html: string): string {
  const re =
    /<meta\b[^>]*(?:name|property)=["'](?:og:description|description|twitter:description)["'][^>]*content=["']([^"']{40,})["'][^>]*>/i;
  const m = re.exec(html);
  return m ? decodeEntities(m[1] ?? "").replace(/\s+/g, " ").trim() : "";
}

/**
 * Main article text of an HTML document, or "" when the page carries no usable
 * prose (login walls, JS-only shells, link farms). Candidate regions in
 * priority order: <article>, <main>, [role=main], <body>; the longest prose
 * wins so a page with a stub <article> teaser still yields its real body.
 */
export function extractArticleText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return "";
  const stripped = html.replace(COMMENT_RE, "").replace(DROP_SUBTREE_RE, " ");
  const candidates = [
    ...innerHtml(stripped, "article"),
    ...innerHtml(stripped, "main"),
    ...roleMain(stripped),
    ...innerHtml(stripped, "body"),
  ];
  let best = "";
  for (const fragment of candidates) {
    const prose = proseFromFragment(fragment);
    if (prose.length > best.length) best = prose;
  }
  if (best.length < MIN_ARTICLE_TEXT_CHARS) {
    const description = metaDescription(html);
    return description.length > best.length ? description : best.length >= MIN_ARTICLE_TEXT_CHARS ? best : "";
  }
  return best;
}

/** Cap at ARTICLE_EXCERPT_MAX_CHARS on a sentence boundary when one is near. */
export function capExcerpt(text: string, max = ARTICLE_EXCERPT_MAX_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  const head = compact.slice(0, max);
  const boundary = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf(". "),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  return boundary >= THIN_EXCERPT_CHARS ? head.slice(0, boundary + 1).trim() : head.trim();
}

export interface ArticleFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetch one article page and return its capped excerpt, or null when the page
 * is unreachable, not HTML, or carries no usable prose. Never throws.
 */
export async function fetchArticleExcerpt(
  url: string,
  options: ArticleFetchOptions = {},
): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARTICLE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Language": "ja,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    const html = (await res.text()).slice(0, MAX_ARTICLE_HTML_BYTES);
    const text = extractArticleText(html);
    return text ? capExcerpt(text) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface EnrichExcerptOptions extends ArticleFetchOptions {
  /** Max article fetches this run (ARTICLE_FETCH_CAP). 0 disables the lane. */
  cap?: number;
  /** URL keys already present in the prior index: everything else is NEW. */
  isPrior: (entry: NormalizedEntry) => boolean;
}

export interface EnrichExcerptStats {
  candidates: number;
  attempted: number;
  enriched: number;
  unavailable: number;
  /** Candidates left for a later run because the cap was reached. */
  deferred: number;
}

export function isThinExcerptCandidate(entry: NormalizedEntry): boolean {
  if (entry.excerptOrigin === "article" || entry.excerptOrigin === "article-unavailable") return false;
  const length = typeof entry.contentSnippet === "string" ? entry.contentSnippet.trim().length : 0;
  return length < THIN_EXCERPT_CHARS;
}

function publishedMs(entry: NormalizedEntry): number {
  const ms = entry.publishedAt ? Date.parse(entry.publishedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Replace thin excerpts with article text, in place, within the run budget.
 * New entries first (their summary and body are generated this run), then
 * prior thin entries newest-first so the corpus backfills predictably.
 */
export async function enrichThinExcerpts(
  entries: NormalizedEntry[],
  options: EnrichExcerptOptions,
): Promise<EnrichExcerptStats> {
  const cap = Math.max(0, Math.floor(options.cap ?? DEFAULT_ARTICLE_FETCH_CAP));
  const thin = entries.filter(isThinExcerptCandidate);
  const fresh = thin.filter((entry) => !options.isPrior(entry)).sort((a, b) => publishedMs(b) - publishedMs(a));
  const prior = thin.filter((entry) => options.isPrior(entry)).sort((a, b) => publishedMs(b) - publishedMs(a));
  const queue = [...fresh, ...prior].slice(0, cap);
  const stats: EnrichExcerptStats = {
    candidates: thin.length,
    attempted: 0,
    enriched: 0,
    unavailable: 0,
    deferred: Math.max(0, thin.length - queue.length),
  };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const entry = queue[cursor++]!;
      stats.attempted += 1;
      const excerpt = await fetchArticleExcerpt(entry.url, options);
      if (excerpt && excerpt.length > (entry.contentSnippet?.trim().length ?? 0)) {
        entry.contentSnippet = excerpt;
        entry.excerptOrigin = "article";
        stats.enriched += 1;
      } else {
        entry.excerptOrigin = "article-unavailable";
        stats.unavailable += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
  return stats;
}
