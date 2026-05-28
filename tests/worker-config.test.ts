import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readConfig(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Cloudflare Worker CPU limits", () => {
  it("harness Worker has an explicit CPU budget for publish + queue automation", () => {
    const config = readConfig("worker/wrangler.toml");
    expect(config).toMatch(/\[limits\][\s\S]*cpu_ms\s*=\s*300_000/);
  });

  it("summarizer Worker has an explicit CPU budget for queue consumption", () => {
    const config = readConfig("worker-summarizer/wrangler.toml");
    expect(config).toMatch(/\[limits\][\s\S]*cpu_ms\s*=\s*300_000/);
  });
});
