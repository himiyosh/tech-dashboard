/**
 * tests/web-bodies.test.ts
 *
 * web/src/lib/bodies.ts のユニットテスト (LL-113)。data/bodies.json を
 * モックして bodyForEntry / hasRealBody を検証する。本文は index ではなく
 * bodies.json に格納され、id でルックアップする。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../data/bodies.json", () => ({
  default: {
    generatedAt: "2026-01-01T00:00:00.000Z",
    count: 3,
    bodies: {
      "real-1": {
        bodyJa: "これは実際の日本語本文です。複数段落あります。",
        bodyEn: "This is a real English body with multiple paragraphs.",
        model: "claude-opus-4.8",
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      "empty-1": { bodyJa: "", bodyEn: "" },
      "filler-1": {
        bodyJa: "このエントリでは、元記事の要約と収集時のメタデータから補っています。",
        bodyEn: "This note is completed from the existing summary and collection metadata.",
        model: "legacy-import",
      },
    },
  },
}));

const { bodyForEntry, hasRealBody, BODIES_COUNT } = await import("../web/src/lib/bodies.ts");

describe("bodyForEntry (LL-113)", () => {
  it("実 body のある id は BodyRecord を返す", () => {
    const b = bodyForEntry("real-1");
    expect(b).not.toBeNull();
    expect(b?.bodyJa).toContain("日本語本文");
    expect(b?.bodyEn).toContain("real English body");
    expect(b?.model).toBe("claude-opus-4.8");
  });

  it("存在しない id は null", () => {
    expect(bodyForEntry("missing")).toBeNull();
  });

  it("空 body の id は null", () => {
    expect(bodyForEntry("empty-1")).toBeNull();
  });

  it("legacy filler body の id は null (本物ではない)", () => {
    expect(bodyForEntry("filler-1")).toBeNull();
  });
});

describe("hasRealBody (LL-113)", () => {
  it("実 body があれば true", () => {
    expect(hasRealBody("real-1")).toBe(true);
  });
  it("無い / 空 / filler は false", () => {
    expect(hasRealBody("missing")).toBe(false);
    expect(hasRealBody("empty-1")).toBe(false);
    expect(hasRealBody("filler-1")).toBe(false);
  });
});

describe("BODIES_COUNT", () => {
  it("payload の count を反映する", () => {
    expect(BODIES_COUNT).toBe(3);
  });
});
