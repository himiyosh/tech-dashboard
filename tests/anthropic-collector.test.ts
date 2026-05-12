import { describe, expect, it } from "vitest";
import { parseAnthropicArticleHtml } from "../harness/collectors/anthropic.ts";

describe("parseAnthropicArticleHtml", () => {
  it("記事ページから title / publishedAt / hero summary を抽出する", () => {
    const html = `
      <html><head><meta property="og:title" content="Fallback | Anthropic"></head>
      <body>
        <h1 class="headline-1">An update on recent Claude Code quality reports</h1>
        <div>Published <!-- -->Apr 23, 2026</div>
        <p class="ArticleHero__summary">We traced recent reports of Claude Code quality issues to three separate changes. Here&#x27;s what happened.</p>
        <p class="post-text">Over the past month, we have been looking into reports from users.</p>
      </body></html>
    `;

    const parsed = parseAnthropicArticleHtml(html);

    expect(parsed.title).toBe("An update on recent Claude Code quality reports");
    expect(parsed.publishedAt).toBe("2026-04-23T00:00:00.000Z");
    expect(parsed.contentSnippet).toContain("Here's what happened.");
    expect(parsed.contentSnippet).not.toContain("Over the past month");
  });
});
