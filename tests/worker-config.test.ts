import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readConfig(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function numericVar(config: string, key: string): number {
  const match = config.match(new RegExp("^" + key + " = \"(\\d+)\"$", "m"));
  if (!match) throw new Error("missing numeric Worker variable: " + key);
  return Number(match[1]);
}

// Retry issue, OG blob, legacy summary blob, and two heartbeat operations.
const FIXED_KV_OPERATIONS_PER_RUN = 5;

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
    const registry = readConfig("harness/registry.ts");

    expect(harnessConfig).toContain('ENABLE_SUMMARY_QUEUE = "1"');
    expect(harnessConfig).toContain('ENQUEUE_MAX_NEW = "35"');
    expect(harnessConfig).toContain('KV_LOOKUP_CAP = "35"');
    expect(harnessConfig).toContain('OG_BUDGET_PER_RUN = "1"');
    expect(registry).toContain("maxArticleDateFetches: 4");
    expect(registry).toContain("maxEntriesPerRun: 4");
    expect(harnessConfig).toContain('binding = "SUMMARY_QUEUE"');
    expect(harnessConfig).toContain('queue = "tech-dashboard-summary"');
    expect(summarizerConfig).toContain('queue = "tech-dashboard-summary"');
    expect(summarizerConfig).toContain("max_batch_size = 1");
    expect(summarizerConfig).toContain("max_retries = 2");
    expect(summarizerConfig).toContain("max_concurrency = 2");
    expect(summarizerConfig).toContain('dead_letter_queue = "tech-dashboard-summary-dlq"');
  });

  it("reserves subrequest headroom around the enrichment queues", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summaryLookupCap = numericVar(harnessConfig, "KV_LOOKUP_CAP");
    const summaryEnqueueCap = numericVar(harnessConfig, "ENQUEUE_MAX_NEW");
    const bodyLookupCap = numericVar(harnessConfig, "BODY_LOOKUP_CAP");
    const bodyEnqueueCap = numericVar(harnessConfig, "BODY_ENQUEUE_MAX_NEW");

    expect(summaryLookupCap).toBeGreaterThanOrEqual(summaryEnqueueCap);
    expect(bodyLookupCap).toBeGreaterThanOrEqual(bodyEnqueueCap);
    expect(summaryLookupCap + bodyLookupCap).toBeLessThanOrEqual(45);
    expect(summaryLookupCap + bodyLookupCap + FIXED_KV_OPERATIONS_PER_RUN).toBeLessThanOrEqual(50);
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
