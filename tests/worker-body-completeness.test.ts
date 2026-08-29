/**
 * tests/worker-body-completeness.test.ts
 *
 * Truncated-body gate (2026-08-29 audit: 172/1,016 indexable-lane bodies —
 * 16.9% — ended mid-word from max_tokens exhaustion under the old opus
 * config). Pins the completeness predicate, its worker/web mirror, the
 * isRealBody integration, and the self-healing direction of the pipeline.
 */
import { describe, expect, it } from "vitest";
import { looksCompleteBodyText, isRealBody } from "../worker/src/bodies-file.ts";
import {
  looksCompleteBodyText as webLooksComplete,
  isRealBodyRecord,
} from "../web/src/lib/body-quality.ts";

const CASES: Array<{ text: string; lang: "ja" | "en"; complete: boolean; why: string }> = [
  { text: "改善が加わった。", lang: "ja", complete: true, why: "ja 句点" },
  { text: "関心を集めそうだ。", lang: "ja", complete: true, why: "ja 推量+句点" },
  { text: "重要になる」と述べた。", lang: "ja", complete: true, why: "ja 引用+句点" },
  { text: "どう受け止めるかが問われ", lang: "ja", complete: false, why: "ja 語中切断" },
  { text: "The release is available now.", lang: "en", complete: true, why: "en period" },
  { text: "Is it ready?", lang: "en", complete: true, why: "en question" },
  { text: 'called it "a milestone."', lang: "en", complete: true, why: "en quote-final" },
  // Real truncation tails measured in the corpus:
  { text: "that the long-stand", lang: "en", complete: false, why: "audit sample 1" },
  { text: "replaced by a period in", lang: "en", complete: false, why: "audit sample 2" },
  { text: "Treating LL", lang: "en", complete: false, why: "audit sample 3" },
  { text: "keep sessions", lang: "en", complete: false, why: "audit sample 4" },
  { text: "ends with a colon:", lang: "en", complete: false, why: "colon is not terminal" },
  { text: "", lang: "en", complete: true, why: "absence is judged elsewhere" },
];

describe("looksCompleteBodyText", () => {
  for (const c of CASES) {
    it(`${c.why}: ${JSON.stringify(c.text.slice(-24))} -> ${c.complete}`, () => {
      expect(looksCompleteBodyText(c.text, c.lang)).toBe(c.complete);
    });
  }
});

describe("worker/web mirror", () => {
  it("returns identical verdicts from both copies on every case", () => {
    for (const c of CASES) {
      expect(webLooksComplete(c.text, c.lang), c.why).toBe(
        looksCompleteBodyText(c.text, c.lang),
      );
    }
  });
});

describe("isRealBody / isRealBodyRecord integration", () => {
  const complete = { bodyJa: "完成した本文である。", bodyEn: "A finished body." };
  const truncatedEn = { bodyJa: "完成した本文である。", bodyEn: "cut mid-sent" };

  it("a truncated language disqualifies the whole record in BOTH copies", () => {
    expect(isRealBody(complete)).toBe(true);
    expect(isRealBody(truncatedEn)).toBe(false);
    expect(isRealBodyRecord(complete)).toBe(true);
    expect(isRealBodyRecord(truncatedEn)).toBe(false);
  });
});
