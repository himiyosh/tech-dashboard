import { describe, expect, it } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  ARTICLE_EXCERPT_MAX_CHARS,
  THIN_EXCERPT_CHARS,
  capExcerpt,
  enrichThinExcerpts,
  extractArticleText,
  fetchArticleExcerpt,
  isThinExcerptCandidate,
} from "../worker/src/article-excerpt.ts";

const PARA = "この段落は本文抽出テスト用の十分に長い日本語の文章で、メニューやラベルではなく記事本文として扱われるべきものです。";

const PROSE = `<p>${PARA}</p>`.repeat(4);

function page(bodyInner: string, head = ""): string {
  return `<!doctype html><html><head><title>t</title>${head}</head><body>${bodyInner}</body></html>`;
}

function entry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "id-1",
    source: "qiita-claude",
    sourceType: "community",
    url: "https://example.com/a",
    title: "t",
    titleJa: "",
    titleEn: "t",
    summaryJa: "",
    summaryEn: "",
    lang: "ja",
    publishedAt: "2026-09-01T00:00:00.000Z",
    collectedAt: "2026-09-01T01:00:00.000Z",
    tags: [],
    category: "claude",
    importance: 1,
    ...overrides,
  };
}

function htmlResponse(body: string, init: { status?: number; type?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "text/html; charset=utf-8" },
  });
}

describe("extractArticleText", () => {
  it("prefers <article> prose and drops nav/footer/script boilerplate", () => {
    const html = page(
      `<nav><a href="/">ホーム</a><a href="/about">このサイトについて</a></nav>
       <article><h1>見出し</h1>${PROSE}<script>var x = "${PARA}";</script></article>
       <footer><p>${PARA} フッターの長い定型文です。</p></footer>`,
    );
    const text = extractArticleText(html);
    expect(text).toContain(PARA);
    expect(text).not.toContain("ホーム");
    expect(text).not.toContain("フッター");
    expect(text).not.toContain("var x");
  });

  it("falls back to <main> then <body> when there is no <article>", () => {
    const html = page(`<main><div>${PROSE}</div></main>`);
    expect(extractArticleText(html)).toContain(PARA);
    const bodyOnly = page(`<div class="post">${PROSE}</div>`);
    expect(extractArticleText(bodyOnly)).toContain(PARA);
  });

  it("drops short menu-like lines and decodes entities", () => {
    const html = page(
      `<article><ul><li>Home</li><li>Blog</li></ul><p>Tom &amp; Jerry &#x27;quote&#x27; ${PARA}</p>${PROSE}</article>`,
    );
    const text = extractArticleText(html);
    expect(text).toContain("Tom & Jerry 'quote'");
    expect(text).not.toMatch(/\bHome\b/);
  });

  it("drops unpunctuated topic menus and sponsor chrome, decodes typographic entities", () => {
    const menu = "<li>Search &amp; information retrieval systems</li><li>Programming languages &amp; software engineering</li>";
    const html = page(
      `<main><ul>${menu}</ul><p>Sponsored by: Greptile &mdash; the AI code reviewer that runs your code today.</p>${PROSE}<p>Quotes &ldquo;work&rdquo; &hellip; and dashes &ndash; too, in this long enough sentence.</p></main>`,
    );
    const text = extractArticleText(html);
    expect(text).not.toContain("information retrieval");
    expect(text).not.toContain("Sponsored by");
    expect(text).toContain("“work” … and dashes – too");
    expect(text).toContain(PARA);
  });

  it("returns meta description when the page carries no prose, and empty for shells", () => {
    const description = "A".repeat(60);
    const shell = page(`<div id="app"></div>`, `<meta property="og:description" content="${description}">`);
    expect(extractArticleText(shell)).toBe(description);
    expect(extractArticleText(page(`<div id="app"></div>`))).toBe("");
    expect(extractArticleText("")).toBe("");
  });
});

describe("capExcerpt", () => {
  it("keeps short text, and cuts long text on a sentence boundary near the cap", () => {
    expect(capExcerpt("  a  b ")).toBe("a b");
    const sentence = "これはテスト文です。";
    const long = sentence.repeat(200);
    const capped = capExcerpt(long);
    expect(capped.length).toBeLessThanOrEqual(ARTICLE_EXCERPT_MAX_CHARS);
    expect(capped.length).toBeGreaterThanOrEqual(THIN_EXCERPT_CHARS);
    expect(capped.endsWith("。")).toBe(true);
  });

  it("hard-cuts when no boundary sits past the thin threshold", () => {
    const capped = capExcerpt("x".repeat(2000));
    expect(capped).toHaveLength(ARTICLE_EXCERPT_MAX_CHARS);
  });
});

describe("fetchArticleExcerpt", () => {
  it("returns capped prose for an HTML page and null for non-HTML, errors, or non-http", async () => {
    const html = page(`<article>${PROSE}</article>`);
    const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
    const text = await fetchArticleExcerpt("https://example.com/a", { fetchImpl });
    expect(text).toContain(PARA);
    expect(text!.length).toBeLessThanOrEqual(ARTICLE_EXCERPT_MAX_CHARS);

    const pdf = (async () => htmlResponse("%PDF", { type: "application/pdf" })) as unknown as typeof fetch;
    expect(await fetchArticleExcerpt("https://example.com/a.pdf", { fetchImpl: pdf })).toBeNull();
    const notFound = (async () => htmlResponse("", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchArticleExcerpt("https://example.com/missing", { fetchImpl: notFound })).toBeNull();
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchArticleExcerpt("https://example.com/a", { fetchImpl: boom })).toBeNull();
    expect(await fetchArticleExcerpt("ftp://example.com/a", { fetchImpl })).toBeNull();
  });

  it("aborts on timeout and reports null instead of hanging", async () => {
    const fetchImpl = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchArticleExcerpt("https://example.com/slow", { fetchImpl, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("enrichThinExcerpts", () => {
  const article = page(`<article>${PROSE}</article>`);

  it("flags thin excerpts and skips entries already attempted", () => {
    expect(isThinExcerptCandidate(entry({ contentSnippet: "short" }))).toBe(true);
    expect(isThinExcerptCandidate(entry({}))).toBe(true);
    expect(isThinExcerptCandidate(entry({ contentSnippet: "x".repeat(THIN_EXCERPT_CHARS) }))).toBe(false);
    expect(isThinExcerptCandidate(entry({ contentSnippet: "short", excerptOrigin: "article" }))).toBe(false);
    expect(
      isThinExcerptCandidate(entry({ contentSnippet: "short", excerptOrigin: "article-unavailable" })),
    ).toBe(false);
  });

  it("enriches new entries before prior ones, marks failures once, and honors the cap", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/fail")) return htmlResponse("", { status: 500 });
      return htmlResponse(article);
    }) as unknown as typeof fetch;
    const priorOld = entry({ id: "prior-old", url: "https://example.com/prior-old", contentSnippet: "feed", publishedAt: "2026-08-01T00:00:00.000Z" });
    const priorNew = entry({ id: "prior-new", url: "https://example.com/prior-new", contentSnippet: "feed", publishedAt: "2026-08-20T00:00:00.000Z" });
    const fresh = entry({ id: "fresh", url: "https://example.com/fresh", contentSnippet: "feed", publishedAt: "2026-07-01T00:00:00.000Z" });
    const failing = entry({ id: "fail", url: "https://example.com/fail", contentSnippet: "feed", publishedAt: "2026-09-01T00:00:00.000Z" });
    const rich = entry({ id: "rich", url: "https://example.com/rich", contentSnippet: "y".repeat(600) });
    const entries = [priorOld, priorNew, fresh, failing, rich];
    const priorIds = new Set(["prior-old", "prior-new"]);

    const stats = await enrichThinExcerpts(entries, {
      fetchImpl,
      cap: 3,
      isPrior: (candidate) => priorIds.has(candidate.id),
    });

    // New entries first (failing is newest, fresh next), then the newest prior.
    expect(calls.sort()).toEqual([
      "https://example.com/fail",
      "https://example.com/fresh",
      "https://example.com/prior-new",
    ]);
    expect(stats).toEqual({ candidates: 4, attempted: 3, enriched: 2, unavailable: 1, deferred: 1 });
    expect(fresh.excerptOrigin).toBe("article");
    expect(fresh.contentSnippet).toContain(PARA);
    expect(priorNew.excerptOrigin).toBe("article");
    expect(failing.excerptOrigin).toBe("article-unavailable");
    expect(failing.contentSnippet).toBe("feed");
    expect(priorOld.excerptOrigin).toBeUndefined();
    expect(rich.excerptOrigin).toBeUndefined();
    expect(rich.contentSnippet).toBe("y".repeat(600));
  });

  it("keeps the feed text in feedSnippet when article prose replaces contentSnippet", async () => {
    const html = `<html><body><article>${"<p>Article paragraph with enough prose to clear the minimum article text threshold for the lane.</p>".repeat(4)}</article></body></html>`;
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const target = entry({ id: "thin", url: "https://example.com/thin", contentSnippet: "Short feed text." });
    const stats = await enrichThinExcerpts([target], { fetchImpl, cap: 5, isPrior: () => false });
    expect(stats.enriched).toBe(1);
    expect(target.excerptOrigin).toBe("article");
    expect(target.feedSnippet).toBe("Short feed text.");
    expect(target.contentSnippet).not.toBe("Short feed text.");

    // An unavailable fetch records the attempt but never touches feedSnippet.
    const failing = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const other = entry({ id: "thin-2", url: "https://example.com/thin-2", contentSnippet: "Another feed text." });
    await enrichThinExcerpts([other], { fetchImpl: failing, cap: 5, isPrior: () => false });
    expect(other.excerptOrigin).toBe("article-unavailable");
    expect(other.feedSnippet).toBeUndefined();
    expect(other.contentSnippet).toBe("Another feed text.");
  });

  it("does nothing when the cap is zero", async () => {
    const target = entry({ contentSnippet: "feed" });
    const fetchImpl = (async () => htmlResponse(article)) as unknown as typeof fetch;
    const stats = await enrichThinExcerpts([target], { fetchImpl, cap: 0, isPrior: () => false });
    expect(stats.attempted).toBe(0);
    expect(stats.deferred).toBe(1);
    expect(target.excerptOrigin).toBeUndefined();
  });
});
