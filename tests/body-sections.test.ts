import { describe, expect, it } from "vitest";
import {
  sectionizeBody,
  splitBodyParagraphs,
  type BodySection,
} from "../web/src/lib/body-sections.ts";

const P = (n: number) => `第${n}段落の本文です。`;

function flatParagraphs(sections: BodySection[]): string[] {
  return sections.flatMap((s) => s.paragraphs);
}

describe("splitBodyParagraphs", () => {
  it("空行区切りで段落化し、空要素を捨てる", () => {
    expect(splitBodyParagraphs("a\n\nb\n\n\n\nc\n\n")).toEqual(["a", "b", "c"]);
    expect(splitBodyParagraphs("")).toEqual([]);
  });
});

describe("sectionizeBody — authored ('## ') mode", () => {
  it("## 見出し行をセクション見出しとして採用する", () => {
    const body = "## 発表内容\n\n中身A。\n\n中身B。\n\n## 影響\n\n中身C。";
    const sections = sectionizeBody(body, "ja");
    expect(sections.map((s) => s.heading)).toEqual(["発表内容", "影響"]);
    expect(sections.every((s) => s.source === "authored")).toBe(true);
    expect(sections[0].paragraphs).toEqual(["中身A。", "中身B。"]);
    expect(sections[1].paragraphs).toEqual(["中身C。"]);
  });

  it("見出しと本文が単一改行で連結されていても分離する", () => {
    const body = "## 見出し\n直後の段落。\n\n次の段落。";
    const sections = sectionizeBody(body, "ja");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("見出し");
    expect(sections[0].paragraphs).toEqual(["直後の段落。", "次の段落。"]);
  });

  it("最初の見出しより前の段落は見出しなしリードとして保持する", () => {
    const body = "リード文。\n\n## 詳細\n\n中身。";
    const sections = sectionizeBody(body, "ja");
    expect(sections.map((s) => s.heading)).toEqual([null, "詳細"]);
    expect(flatParagraphs(sections)).toEqual(["リード文。", "中身。"]);
  });
});

describe("sectionizeBody — derived (legacy plain-text) mode", () => {
  it("3段落未満は見出しなしの単一セクションのまま", () => {
    const sections = sectionizeBody(`${P(1)}\n\n${P(2)}`, "ja");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].paragraphs).toEqual([P(1), P(2)]);
  });

  it("典型的な5段落 (背景がP4・展望あり) を 概要/詳細/背景/今後の展望 に分ける", () => {
    const body = [
      "新製品Xが発表された。",
      "仕組みの説明。",
      "技術詳細の説明。",
      "背景には業界の動向がある。",
      "今後の展開が注目される。",
    ].join("\n\n");
    const sections = sectionizeBody(body, "ja");
    expect(sections.map((s) => s.heading)).toEqual(["概要", "詳細", "背景", "今後の展望"]);
    expect(sections.map((s) => s.paragraphs.length)).toEqual([1, 2, 1, 1]);
    expect(flatParagraphs(sections)).toEqual(splitBodyParagraphs(body));
  });

  it("背景がP2に来る場合は 概要/背景/詳細/今後の展望 の順になる", () => {
    const body = [
      "リード。",
      "背景として従来の課題がある。",
      "詳細な説明。",
      "今後の普及が期待される。",
    ].join("\n\n");
    const sections = sectionizeBody(body, "ja");
    expect(sections.map((s) => s.heading)).toEqual(["概要", "背景", "詳細", "今後の展望"]);
  });

  it("背景キューも展望キューも無ければ 概要/詳細 のみ", () => {
    const body = ["リード。", "説明その1。", "説明その2。"].join("\n\n");
    const sections = sectionizeBody(body, "ja");
    expect(sections.map((s) => s.heading)).toEqual(["概要", "詳細"]);
    expect(sections[1].paragraphs).toEqual(["説明その1。", "説明その2。"]);
  });

  it("最終段落が文の途中で切れている場合は展望セクションにしない", () => {
    const body = ["リード。", "説明。", "今後の展開として様々な可能性が"].join("\n\n");
    const sections = sectionizeBody(body, "ja");
    expect(sections.map((s) => s.heading)).toEqual(["概要", "詳細"]);
    expect(sections[1].paragraphs).toEqual(["説明。", "今後の展開として様々な可能性が"]);
  });

  it("英語ボディは Overview/In detail/Outlook を導出する", () => {
    const body = [
      "Product X launched today.",
      "It works by doing Y.",
      "More detail about Z.",
      "Going forward, adoption is likely to grow.",
    ].join("\n\n");
    const sections = sectionizeBody(body, "en");
    expect(sections.map((s) => s.heading)).toEqual(["Overview", "In detail", "Outlook"]);
  });

  it("段落の内容と順序をどのモードでも欠落なく保持する", () => {
    const bodies = [
      ["a。", "b。", "c。", "背景の説明。", "今後が注目される。"].join("\n\n"),
      "## H1\n\nx。\n\n## H2\n\ny。",
      "single paragraph only.",
    ];
    for (const body of bodies) {
      for (const lang of ["ja", "en"] as const) {
        expect(flatParagraphs(sectionizeBody(body, lang))).toEqual(
          splitBodyParagraphs(body).map((block) =>
            block.replace(/^##\s+.+\n?/, "").trim(),
          ).filter(Boolean),
        );
      }
    }
  });

  it("空ボディは空配列", () => {
    expect(sectionizeBody("", "ja")).toEqual([]);
    expect(sectionizeBody("\n\n", "en")).toEqual([]);
  });
});
