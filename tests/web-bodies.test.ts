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
    count: 5,
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
      // The already-published fabrication case: a real-looking body whose
      // entry carries no source excerpt at all (53 such pages are live).
      "ungrounded-empty": {
        bodyJa: "Gemini 3.7 Flash は推論速度を大幅に改善したと説明されている。",
        bodyEn: "Gemini 3.7 Flash is described as a substantial latency improvement.",
        model: "claude-opus-4.8",
      },
      // Same, from an excerpt too short to support long-form prose.
      "ungrounded-short": {
        bodyJa: "短い断片から生成された本文です。",
        bodyEn: "A body generated from a fragment.",
        model: "claude-opus-4.8",
      },
    },
  },
}));

const { articleBodyState, bodyForEntry, hasRealBody, BODIES_COUNT } = await import("../web/src/lib/bodies.ts");

const GROUNDED_SNIPPET =
  "The source walks through the release, the behavior it changes, and the platforms it supports.";

function src(id: string, over: { title?: string; contentSnippet?: string } = {}) {
  return {
    id,
    title: over.title ?? `Title ${id}`,
    contentSnippet: over.contentSnippet ?? GROUNDED_SNIPPET,
  };
}

describe("bodyForEntry (LL-115)", () => {
  it("実 body + 実 snippet の entry は BodyRecord を返す", () => {
    const b = bodyForEntry(src("real-1"));
    expect(b).not.toBeNull();
    expect(b?.bodyJa).toContain("日本語本文");
    expect(b?.bodyEn).toContain("real English body");
    expect(b?.model).toBe("claude-opus-4.8");
  });

  it("存在しない id は null", () => {
    expect(bodyForEntry(src("missing"))).toBeNull();
  });

  it("空 body の id は null", () => {
    expect(bodyForEntry(src("empty-1"))).toBeNull();
  });

  it("legacy filler body の id は null (本物ではない)", () => {
    expect(bodyForEntry(src("filler-1"))).toBeNull();
  });

  it("contentSnippet が空の entry は body があっても描画しない", () => {
    expect(
      bodyForEntry(src("ungrounded-empty", {
        title: "Introducing Gemini 3.7 Flash",
        contentSnippet: "",
      })),
    ).toBeNull();
  });

  it("断片しかない contentSnippet の entry は body があっても描画しない", () => {
    expect(
      bodyForEntry(src("ungrounded-short", { contentSnippet: "Read more" })),
    ).toBeNull();
  });

  it("contentSnippet がタイトルの echo なら描画しない", () => {
    expect(
      bodyForEntry(src("real-1", {
        title: "Ollama Releases v0.33.0-rc2 for testing",
        contentSnippet: "Ollama Releases v0.33.0-rc2 for testing",
      })),
    ).toBeNull();
  });
});

describe("hasRealBody (LL-115)", () => {
  it("実 body + 実 snippet なら true", () => {
    expect(hasRealBody(src("real-1"))).toBe(true);
  });
  it("無い / 空 / filler / 出典未裏付け は false", () => {
    expect(hasRealBody(src("missing"))).toBe(false);
    expect(hasRealBody(src("empty-1"))).toBe(false);
    expect(hasRealBody(src("filler-1"))).toBe(false);
    expect(hasRealBody(src("ungrounded-empty", { contentSnippet: "" }))).toBe(false);
  });
});

describe("articleBodyState", () => {
  it("本文があれば pending ID より ready を優先する", () => {
    const entry = src("real-1");
    expect(articleBodyState(entry, bodyForEntry(entry), ["real-1"])).toBe("ready");
  });

  it("本文なしで enqueue 成功 ID に含まれる場合だけ queued にする", () => {
    expect(articleBodyState(src("missing"), null, ["other", "missing"])).toBe("queued");
  });

  it("enqueue の証拠がない本文なし記事は summary-only にする", () => {
    expect(articleBodyState(src("missing"), null, ["other"])).toBe("summary-only");
    expect(articleBodyState(src("missing"), null, undefined)).toBe("summary-only");
  });

  it("出典が裏付けない entry は pending ID に残っていても queued と言わない", () => {
    expect(
      articleBodyState(src("missing", { contentSnippet: "" }), null, ["missing"]),
    ).toBe("summary-only");
  });
});

describe("BODIES_COUNT", () => {
  it("payload の count を反映する", () => {
    expect(BODIES_COUNT).toBe(5);
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
    expect(isRealBodyRecord({ bodyJa: "実本文。", bodyEn: "" })).toBe(true);
    expect(isFillerBodyRecord({ bodyJa: "実本文。", bodyEn: "real." })).toBe(false);
  });

  it("rejects a record whose present language is truncated mid-sentence", () => {
    // 2026-08-29 audit: 16.9% of indexable-lane bodies ended mid-word from
    // max_tokens exhaustion. A truncated language disqualifies the record.
    expect(isRealBodyRecord({ bodyJa: "完成した本文である。", bodyEn: "cut mid-sent" })).toBe(false);
    expect(isRealBodyRecord({ bodyJa: "途中で切れた本文", bodyEn: "A finished body." })).toBe(false);
  });
});
