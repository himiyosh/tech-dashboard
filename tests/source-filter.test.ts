import { describe, expect, it } from "vitest";
import { matchesKeywordFilter } from "../harness/pipeline/source-filter.ts";
import type { SourceDefinition } from "../harness/types.ts";

const source: SourceDefinition = {
  id: "qiita-vscode",
  displayName: "Qiita VSCode tag",
  category: "vscode",
  sourceType: "blog",
  defaultLang: "ja",
  autoTags: ["qiita", "vscode"],
  feedUrl: "https://qiita.com/tags/vscode/feed.atom",
  tier: 2,
  includeKeywords: ["vscode", "vs code", "visual studio code", "extension", "拡張機能"],
  excludeKeywords: ["makefile:2", "missing separator"],
  keywordFilterScope: "title",
  collect: async () => [],
};

describe("matchesKeywordFilter", () => {
  it("applies title-only include filters to old merged entries", () => {
    expect(matchesKeywordFilter({
      title: "C言語のコンパイル時に文字化けが発生する",
      url: "https://qiita.com/example/items/1",
      contentSnippet: "This entry came from a vscode tag feed but is not about VS Code.",
    }, source)).toBe(false);

    expect(matchesKeywordFilter({
      title: "VSCode 拡張機能の設定を整理する",
      url: "https://qiita.com/example/items/2",
      contentSnippet: "",
    }, source)).toBe(true);
  });
});
