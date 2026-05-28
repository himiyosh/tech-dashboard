import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readConfig(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Cloudflare Worker deploy config", () => {
  it("does not set unsupported CPU limits on the current Workers plan", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(harnessConfig).not.toMatch(/\[limits\][\s\S]*cpu_ms\s*=/);
    expect(summarizerConfig).not.toMatch(/\[limits\][\s\S]*cpu_ms\s*=/);
  });

  it("keeps the summary queue producer and consumer wired", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(harnessConfig).toContain('binding = "SUMMARY_QUEUE"');
    expect(harnessConfig).toContain('queue = "tech-dashboard-summary"');
    expect(summarizerConfig).toContain('queue = "tech-dashboard-summary"');
    expect(summarizerConfig).toContain('dead_letter_queue = "tech-dashboard-summary-dlq"');
  });
});
