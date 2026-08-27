/**
 * tests/web-bodies.test.ts
 *
 * web/src/lib/bodies.ts のユニットテスト (LL-115)。data/bodies.json を
 * モックして bodyForEntry / hasRealBody を検証する。本文は index ではなく
 * bodies.json に格納され、id でルックアップする。
 */
import { describe, it, expect, vi } from "vitest";
import { isFillerBodyRecord, isRealBodyRecord } from "../web/src/lib/body-quality.ts";

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

const { articleBodyState, bodyForEntry, hasRealBody, BODIES_COUNT } = await import("../web/src/lib/bodies.ts");

describe("bodyForEntry (LL-115)", () => {
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

describe("hasRealBody (LL-115)", () => {
  it("実 body があれば true", () => {
    expect(hasRealBody("real-1")).toBe(true);
  });
  it("無い / 空 / filler は false", () => {
    expect(hasRealBody("missing")).toBe(false);
    expect(hasRealBody("empty-1")).toBe(false);
    expect(hasRealBody("filler-1")).toBe(false);
  });
});

describe("articleBodyState", () => {
  it("本文があれば pending ID より ready を優先する", () => {
    expect(articleBodyState("real-1", bodyForEntry("real-1"), ["real-1"])).toBe("ready");
  });

  it("本文なしで enqueue 成功 ID に含まれる場合だけ queued にする", () => {
    expect(articleBodyState("missing", null, ["other", "missing"])).toBe("queued");
  });

  it("enqueue の証拠がない本文なし記事は summary-only にする", () => {
    expect(articleBodyState("missing", null, ["other"])).toBe("summary-only");
    expect(articleBodyState("missing", null, undefined)).toBe("summary-only");
  });
});

describe("BODIES_COUNT", () => {
  it("payload の count を反映する", () => {
    expect(BODIES_COUNT).toBe(3);
  });
});

describe("isRealBodyRecord (body-quality)", () => {
  // body-quality.ts imports no data artifact, so route policy
  // (detail-indexability.ts), these unit tests, and the Playwright publisher
  // spec all apply the identical predicate without loading the 9MB
  // data/bodies.json. That shared definition is the point of the module.
  it("rejects missing, empty, and whitespace-only records", () => {
    expect(isRealBodyRecord(undefined)).toBe(false);
    expect(isRealBodyRecord(null)).toBe(false);
    expect(isRealBodyRecord({ bodyJa: "", bodyEn: "" })).toBe(false);
    expect(isRealBodyRecord({ bodyJa: "  ", bodyEn: "\n" })).toBe(false);
  });

  it("rejects legacy deterministic filler in either language", () => {
    expect(
      isRealBodyRecord({
        bodyJa: "このエントリでは、元記事の要約と収集時のメタデータから補っています。",
        bodyEn: "",
      }),
    ).toBe(false);
    expect(
      isRealBodyRecord({
        bodyJa: "",
        bodyEn: "This note is completed from the existing summary and collection metadata.",
      }),
    ).toBe(false);
  });

  it("accepts a record with real prose in one language", () => {
    expect(isRealBodyRecord({ bodyJa: "実本文", bodyEn: "" })).toBe(true);
    expect(isFillerBodyRecord({ bodyJa: "実本文", bodyEn: "real" })).toBe(false);
  });
});
