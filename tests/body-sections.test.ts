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

  it("段落数に関わらず、導出見出しは付けない (見出しは authored '## ' 行のみ)", () => {
    // Site audit: position-derived 概要/詳細/背景/今後の展望 mislabelled most
    // legacy bodies and gave every article the same table of contents.
    const body = [
      "新製品Xが発表された。",
      "仕組みの説明。",
      "技術詳細の説明。",
      "背景には業界の動向がある。",
      "今後の展開が注目される。",
    ].join("\n\n");
    const sections = sectionizeBody(body, "ja");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ heading: null, source: "derived" });
    expect(flatParagraphs(sections)).toEqual(splitBodyParagraphs(body));

    const en = ["Lead.", "Detail one.", "Detail two.", "Going forward, adoption is expected."].join("\n\n");
    const enSections = sectionizeBody(en, "en");
    expect(enSections).toHaveLength(1);
    expect(enSections[0].heading).toBeNull();
  });
});
