import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readConfig(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Cloudflare Worker deploy config", () => {
  it("omits per-Worker CPU limits for the current Cloudflare plan", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(harnessConfig).not.toMatch(/\[limits\][\s\S]*cpu_ms\s*=/);
    expect(summarizerConfig).not.toMatch(/\[limits\][\s\S]*cpu_ms\s*=/);
  });

  it("uses the long-form budget for queue summarization", () => {
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(summarizerConfig).toContain('SUMMARIZE_TIMEOUT_MS = "180000"');
    expect(summarizerConfig).toContain('SUMMARIZE_MAX_TOKENS = "6000"');
  });

  it("keeps the summary queue producer and consumer wired", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(harnessConfig).toContain('ENABLE_SUMMARY_QUEUE = "1"');
    expect(harnessConfig).toContain('binding = "SUMMARY_QUEUE"');
    expect(harnessConfig).toContain('queue = "tech-dashboard-summary"');
    expect(summarizerConfig).toContain('queue = "tech-dashboard-summary"');
    expect(summarizerConfig).toContain("max_batch_size = 1");
    expect(summarizerConfig).toContain("max_retries = 2");
    expect(summarizerConfig).toContain("max_concurrency = 2");
    expect(summarizerConfig).toContain('dead_letter_queue = "tech-dashboard-summary-dlq"');
  });

  it("keeps Worker observability and hourly production monitoring enabled", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");
    const healthWorkflow = readConfig(".github/workflows/worker-health.yml");
    const packageJson = readConfig("package.json");

    expect(harnessConfig).toContain("[observability]");
    expect(harnessConfig).toContain("enabled = true");
    expect(harnessConfig).toContain('crons = ["0 * * * *"]');
    expect(summarizerConfig).toContain("[observability]");
    expect(summarizerConfig).toContain("enabled = true");
    expect(healthWorkflow).toContain('cron: "15 * * * *"');
    expect(healthWorkflow).toContain("npm run health:prod");
    expect(packageJson).toContain('"health:prod": "node scripts/check-production-health.mjs"');
  });
});
