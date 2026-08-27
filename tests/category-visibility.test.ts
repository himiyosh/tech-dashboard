import { describe, expect, it } from "vitest";
import {
  DEFAULT_MUTED_CATEGORIES,
  isCategoryHidden,
  isDefaultMutedCategory,
  parseCategoryVisibilityOverrides,
  serializeCategoryVisibilityOverrides,
  toggleCategoryVisibility,
} from "../web/src/lib/category-visibility.ts";
import { CATEGORY_META } from "../web/src/lib/category-meta.ts";

describe("category visibility policy", () => {
  it("既定ミュートは実在カテゴリだけを含む (cline を含む)", () => {
    expect(DEFAULT_MUTED_CATEGORIES).toContain("cline");
    const slugs = new Set(CATEGORY_META.map((category) => category.slug));
    for (const muted of DEFAULT_MUTED_CATEGORIES) {
      expect(slugs.has(muted as (typeof CATEGORY_META)[number]["slug"])).toBe(true);
    }
  });

  it("override なしでは既定ミュートだけが非表示になる", () => {
    expect(isCategoryHidden("cline", {})).toBe(true);
    expect(isCategoryHidden("claude", {})).toBe(false);
    expect(isDefaultMutedCategory("cline")).toBe(true);
    expect(isDefaultMutedCategory("claude")).toBe(false);
  });

  it("shown override は既定ミュートを表示に、hidden override は通常カテゴリを非表示にする", () => {
    expect(isCategoryHidden("cline", { cline: "shown" })).toBe(false);
    expect(isCategoryHidden("claude", { claude: "hidden" })).toBe(true);
  });

  it("toggle は既定と一致する override を残さない (既定変更が将来も効くように)", () => {
    const enabledCline = toggleCategoryVisibility("cline", {});
    expect(enabledCline).toEqual({ cline: "shown" });
    expect(toggleCategoryVisibility("cline", enabledCline)).toEqual({});

    const mutedClaude = toggleCategoryVisibility("claude", {});
    expect(mutedClaude).toEqual({ claude: "hidden" });
    expect(toggleCategoryVisibility("claude", mutedClaude)).toEqual({});
  });

  it("parse は壊れた入力・不正な値・不正な slug を fail-closed で捨てる", () => {
    expect(parseCategoryVisibilityOverrides(null)).toEqual({});
    expect(parseCategoryVisibilityOverrides("")).toEqual({});
    expect(parseCategoryVisibilityOverrides("not-json")).toEqual({});
    expect(parseCategoryVisibilityOverrides("[1,2]")).toEqual({});
    expect(
      parseCategoryVisibilityOverrides(
        JSON.stringify({
          cline: "shown",
          claude: "maybe",
          "BAD SLUG!": "hidden",
          mcp: "hidden",
        }),
      ),
    ).toEqual({ cline: "shown", mcp: "hidden" });
  });

  it("serialize と parse は往復する", () => {
    const overrides = { cline: "shown", claude: "hidden" } as const;
    expect(
      parseCategoryVisibilityOverrides(
        serializeCategoryVisibilityOverrides(overrides),
      ),
    ).toEqual(overrides);
  });
});
