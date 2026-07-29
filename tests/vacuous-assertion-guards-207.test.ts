import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function extractCase(source: string, runner: "it" | "test", title: string): string {
  const marker = `${runner}("${title}"`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing ${runner} case: ${title}`);
  }
  const next = source.indexOf(`\n  ${runner}("`, start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe("issue 207 vacuous assertion guards", () => {
  it("requires Featured summary geometry to fail when the measured element is absent", () => {
    const smoke = read("tests/e2e/smoke.spec.ts");
    const geometryCase = extractCase(
      smoke,
      "test",
      "Privacy prompt stays compact, in flow, and clear of priority content",
    );
    const requiredElements =
      geometryCase.match(/if\s*\(([^)]*)\)\s*return null;/)?.[1] ?? "";

    expect(requiredElements).toContain("!featuredSummary");
    expect(geometryCase).toContain(
      "featuredSummaryBottom: featuredSummaryBox.bottom,",
    );
    expect(geometryCase).not.toMatch(
      /featuredSummaryBottom:[^,\n]*(?:\?\?|\|\|)\s*0/,
    );
  });

  it("requires the privacy source test to inspect every exact prompt selector block", () => {
    const privacy = read("tests/web-privacy-consent.test.ts");
    const sourceCase = extractCase(
      privacy,
      "it",
      "keeps consent progressive, non-modal, and stable before client initialization",
    );

    expect(sourceCase).toContain(
      "styles.matchAll(/^\\s*\\.privacy-consent-prompt\\s*\\{([^}]*)\\}/gm)",
    );
    expect(sourceCase).toContain(
      "expect(promptRules.length).toBeGreaterThan(0);",
    );
    expect(sourceCase).toContain("for (const promptRule of promptRules)");
    expect(sourceCase).not.toContain(
      "styles.match(/\\.privacy-consent-prompt",
    );
  });
});
