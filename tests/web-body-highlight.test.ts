/**
 * tests/web-body-highlight.test.ts
 *
 * web/src/lib/body-highlight.ts のユニットテスト。
 * 契約: 生成 HTML の text content は入力段落と完全一致する
 * (escape は 1 回だけ / entity を割らない / anchor を入れ子にしない)。
 *
 * 回帰対象: escape 済み markup の上に tag ごとの regex 置換を重ねたため、
 * 短い tag が別 tag の href 内部に一致して <a> が入れ子化し、可視本文へ
 * 属性の残骸 `">` が漏れた defect (実測 64 detail pages / 211 段落)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectTagHighlightRanges,
  escapeHtml,
  highlightTagsInText,
} from "../web/src/lib/body-highlight.ts";
import { sectionizeBody } from "../web/src/lib/body-sections.ts";

const tagPath = (tag: string): string => `/t/${encodeURIComponent(tag.toLowerCase())}`;

/**
 * Strips the only markup this module may emit and undoes its escaping. Any
 * residue — a stray `">`, a truncated href, a double-escaped entity — makes the
 * round trip differ from the input. `href="[^"]*"` is deliberate: a correct
 * href never contains a raw quote, so the buggy nested output fails to strip.
 */
function visibleText(html: string): string {
  return html
    .replace(/<a class="kw" href="[^"]*">/g, "")
    .replace(/<\/a>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("escapeHtml", () => {
  it("HTML 上意味を持つ 5 文字を 1 回だけ escape する", () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &#39; f",
    );
  });

  it("idempotent ではない (呼び出しは source 文字列に対し 1 回だけという契約)", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("highlightTagsInText — escaping contract", () => {
  it("tag が無ければ escape だけを行う", () => {
    expect(highlightTagsInText('a > b & "c"', [], tagPath)).toBe(
      "a &gt; b &amp; &quot;c&quot;",
    );
  });

  it("一致した tag を anchor 化し href を escape する", () => {
    expect(highlightTagsInText("about LangChain today", ["langchain"], tagPath)).toBe(
      'about <a class="kw" href="/t/langchain">LangChain</a> today',
    );
  });

  it("regression: 長い tag の href 内部に短い tag が一致しても anchor を入れ子にしない", () => {
    // 実測 defect: tags ["local-llm", "llm"] で `\bllm\b` が
    // href="/t/local-llm" の内側に一致し、可視本文へ `">` が漏れていた。
    const html = highlightTagsInText(
      "the local-llm community",
      ["local-llm", "llm"],
      tagPath,
    );
    expect(html).toBe('the <a class="kw" href="/t/local-llm">local-llm</a> community');
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
    // markup レベルの不変条件: href 属性値の中に別の開始タグが現れない。
    // (ブラウザは <a> を入れ子にできないため DOM を見ても検出できない。)
    expect(html).not.toMatch(/href="[^"]*<a /);
    // `">local-` は正しい出力にも現れる (anchor の閉じ `>` + リンクテキスト)
    // ため、残骸の検出には使えない。破損の検出は上の href 形状検査と、
    // 下の可視テキスト一致が担う。旧実装ではこの入力の可視テキストが
    // `the llm">local-llm community` になり、両方が落ちることを実測済み。
    expect(visibleText(html)).toBe("the local-llm community");
  });

  it("regression: href が search 形式 (tag が 2 回現れる) でも入れ子にならない", () => {
    const searchHref = (tag: string): string => {
      const encoded = encodeURIComponent(tag);
      return `/search?q=${encoded}&tag=${encoded}&entry=0123456789abcdef`;
    };
    const html = highlightTagsInText(
      "minor-release notes",
      ["minor-release", "release"],
      searchHref,
    );
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
    expect(html).not.toMatch(/href="[^"]*<a /);
    expect(html).toContain("&amp;tag=minor-release");
    expect(visibleText(html)).toBe("minor-release notes");
  });

  it("regression: entity 名と同じ tag が entity を割らない", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["a > b", "gt"],
      ["a < b", "lt"],
      ["AT&T ships", "amp"],
      ['he said "no"', "quot"],
    ];
    for (const [text, tag] of cases) {
      const html = highlightTagsInText(text, [tag], tagPath);
      // 生テキストに tag は現れないので anchor は 1 つも出ない。
      // 旧実装は escape 済み文字列に regex を当てていたため `&amp;` の中の
      // `amp` に一致し得た。
      expect(html, `tag "${tag}" must not match inside an entity`).toBe(escapeHtml(text));
      expect(visibleText(html)).toBe(text);
    }
  });

  it("重なる一致は長い tag が勝ち、二重リンクしない", () => {
    expect(highlightTagsInText("open-model release", ["open-model", "model"], tagPath)).toBe(
      '<a class="kw" href="/t/open-model">open-model</a> release',
    );
  });

  it("大文字小文字を無視して一致し、表示は原文の綴りを保つ", () => {
    expect(highlightTagsInText("MCP and mcp", ["mcp"], tagPath)).toBe(
      '<a class="kw" href="/t/mcp">MCP</a> and <a class="kw" href="/t/mcp">mcp</a>',
    );
  });

  it("1 文字 tag は linkify しない", () => {
    expect(highlightTagsInText("a b c", ["a"], tagPath)).toBe("a b c");
  });

  it("href 側の特殊文字も escape され、素の quote が属性外へ出ない", () => {
    expect(highlightTagsInText("mcp", ["mcp"], () => '/t/x"y<z&w')).toBe(
      '<a class="kw" href="/t/x&quot;y&lt;z&amp;w">mcp</a>',
    );
  });
});

describe("collectTagHighlightRanges", () => {
  it("重なる範囲を落とし、開始位置の昇順で返す", () => {
    expect(collectTagHighlightRanges("local-llm and llm", ["local-llm", "llm"])).toEqual([
      { start: 0, end: 9, tag: "local-llm" },
      { start: 14, end: 17, tag: "llm" },
    ]);
  });
});

describe("corpus regression guard", () => {
  it("detail route を持つ全 entry の全本文段落で text content が原文と一致する", () => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string; tags?: string[]; archiveTier?: string }>;
    };
    const bodies = JSON.parse(readFileSync("data/bodies.json", "utf8")) as {
      bodies: Record<string, { bodyJa?: string; bodyEn?: string }>;
    };
    const rows = [...index.entries];
    for (const file of readdirSync("data/archive")) {
      if (!/^\d{4}-\d{2}\.json$/.test(file)) continue;
      const month = JSON.parse(readFileSync(`data/archive/${file}`, "utf8")) as {
        entries: Array<{ id: string; tags?: string[]; archiveTier?: string }>;
      };
      rows.push(...month.entries.filter((entry) => entry.archiveTier === "warm"));
    }

    // 最も衝突しやすい href 形状 (tag が 2 回現れる search 形式) を全 tag に
    // 適用し、実際の tagHref より厳しい条件で検証する。
    const searchHref = (tag: string): string => {
      const encoded = encodeURIComponent(tag.toLowerCase());
      return `/search?q=${encoded}&tag=${encoded}&entry=0123456789abcdef`;
    };

    const seen = new Set<string>();
    const corrupted: string[] = [];
    let checkedParagraphs = 0;
    for (const entry of rows) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.archiveTier === "cold" || entry.archiveTier === "dropped") continue;
      const body = bodies.bodies[entry.id];
      if (!body) continue;
      for (const lang of ["ja", "en"] as const) {
        const text = lang === "ja" ? body.bodyJa : body.bodyEn;
        if (!text) continue;
        for (const section of sectionizeBody(text, lang)) {
          for (const paragraph of section.paragraphs) {
            checkedParagraphs += 1;
            const html = highlightTagsInText(paragraph, entry.tags ?? [], searchHref);
            if (visibleText(html) !== paragraph) corrupted.push(`${entry.id}:${lang}`);
          }
        }
      }
    }

    // 空振り防止 (実測 2026-08-26: 15,549 段落)。
    expect(checkedParagraphs, "corpus guard must inspect real paragraphs").toBeGreaterThan(1000);
    expect(corrupted).toEqual([]);
  });
});
