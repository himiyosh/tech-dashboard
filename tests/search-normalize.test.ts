import { describe, expect, it } from "vitest";
import { normalizeSearchText } from "../web/src/lib/search-normalize.ts";

describe("normalizeSearchText", () => {
  it("folds Latin diacritics for accent-insensitive matching", () => {
    expect(normalizeSearchText("Café")).toBe("cafe");
  });

  it("preserves Japanese dakuten and handakuten", () => {
    expect(normalizeSearchText("ガパ")).toBe("ガパ");
    expect(normalizeSearchText("カ\u3099ハ\u309a")).toBe("ガパ");
    expect(normalizeSearchText("ガ")).not.toBe(normalizeSearchText("カ"));
  });
});
