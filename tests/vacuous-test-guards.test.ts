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

describe("vacuous test regression guards", () => {
  it("requires the arXiv HTML/RSS parity test to prove the expected lane is non-empty", () => {
    const publisher = read("tests/e2e/publisher.spec.ts");
    const parityCase = extractCase(
      publisher,
      "test",
      "arXiv RSS matches the publishable HTML lane and keeps Research separate",
    );
    const expectedUrls = parityCase.indexOf("const expectedUrls");
    const nonEmptyGuard = parityCase.indexOf(
      "expect(expectedUrls.length).toBeGreaterThan(0);",
    );
    const parityAssertion = parityCase.indexOf(
      "expect(arxivUrls).toEqual(expectedUrls);",
    );

    expect(expectedUrls).toBeGreaterThanOrEqual(0);
    expect(nonEmptyGuard).toBeGreaterThan(expectedUrls);
    expect(nonEmptyGuard).toBeLessThan(parityAssertion);
  });
});
