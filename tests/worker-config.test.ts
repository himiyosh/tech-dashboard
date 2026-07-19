import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { playwrightWebServerCommand } from "../playwright.config.ts";
import { SOURCE_BATCHES, sourceBatchIndexAt } from "../worker/src/index.ts";

function readConfig(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Cloudflare Worker deploy config", () => {
  it("deploys only the OIDC bridge on Workers Free without a cron or paid CPU limit", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(harnessConfig).toContain('main = "src/free-plan-bridge.ts"');
    expect(harnessConfig).not.toContain("[triggers]");
    expect(harnessConfig).not.toContain("[limits]");
    expect(harnessConfig).not.toContain("cpu_ms");
    expect(summarizerConfig).not.toMatch(/\[limits\][\s\S]*cpu_ms\s*=/);
  });

  it("uses the compact summary-only budget for queue summarization", () => {
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");

    expect(summarizerConfig).toContain('SUMMARIZE_TIMEOUT_MS = "60000"');
    expect(summarizerConfig).toContain('SUMMARIZE_MAX_TOKENS = "1600"');
  });

  it("keeps the summary queue producer and consumer wired", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");
    const runner = readConfig("scripts/run-publisher.ts");
    const registry = readConfig("harness/registry.ts");

    expect(runner).toContain('ENABLE_SUMMARY_QUEUE: "1"');
    expect(runner).toContain('ENQUEUE_MAX_NEW: "35"');
    expect(runner).toContain('KV_LOOKUP_CAP: "35"');
    expect(runner).toContain('OG_BUDGET_PER_RUN: "1"');
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

  it("shares one bounded write allowance across summary and body queues", () => {
    const runner = readConfig("scripts/run-publisher.ts");
    const runnerValue = (key: string) => {
      const match = runner.match(new RegExp(`${key}: "(\\d+)"`));
      if (!match) throw new Error(`missing publisher runner value: ${key}`);
      return Number(match[1]);
    };
    const summaryLookupCap = runnerValue("KV_LOOKUP_CAP");
    const summaryEnqueueCap = runnerValue("ENQUEUE_MAX_NEW");
    const bodyLookupCap = runnerValue("BODY_LOOKUP_CAP");
    const bodyEnqueueCap = runnerValue("BODY_ENQUEUE_MAX_NEW");
    const totalEnqueueCap = runnerValue("ENRICHMENT_ENQUEUE_MAX_TOTAL");

    expect(summaryLookupCap).toBeGreaterThanOrEqual(summaryEnqueueCap);
    expect(bodyLookupCap).toBeGreaterThanOrEqual(totalEnqueueCap);
    expect(bodyEnqueueCap).toBeGreaterThanOrEqual(totalEnqueueCap);
    expect(totalEnqueueCap).toBeLessThanOrEqual(35);
    expect(runner).toContain('BODY_RETENTION_DAYS: "30"');
  });

  it("keeps bridge observability and serialized hourly publisher monitoring enabled", () => {
    const harnessConfig = readConfig("worker/wrangler.toml");
    const summarizerConfig = readConfig("worker-summarizer/wrangler.toml");
    const publisherWorkflow = readConfig(".github/workflows/publisher.yml");
    const healthWorkflow = readConfig(".github/workflows/worker-health.yml");
    const packageJson = readConfig("package.json");

    expect(harnessConfig).toContain("[observability]");
    expect(harnessConfig).toContain("enabled = true");
    expect(summarizerConfig).toContain("[observability]");
    expect(summarizerConfig).toContain("enabled = true");
    expect(publisherWorkflow).toContain('cron: "0 * * * *"');
    expect(publisherWorkflow).toContain("run-name: Publisher /");
    expect(publisherWorkflow).toContain("'dry-run' || 'publish'");
    expect(publisherWorkflow).toContain("group: tech-dashboard-publisher");
    expect(publisherWorkflow).toContain("cancel-in-progress: false");
    expect(publisherWorkflow).toContain("contents: write");
    expect(publisherWorkflow).toContain("id-token: write");
    expect(publisherWorkflow).not.toMatch(/wrangler\s+(?:pages\s+)?deploy/);
    expect(healthWorkflow).toContain('cron: "40 * * * *"');
    expect(healthWorkflow).toContain("npm run health:prod");
    expect(packageJson).toContain('"health:prod": "node scripts/check-production-health.mjs"');
  });

  it("gives CI jobs enough time for Pagefind builds and the full Playwright suite", () => {
    const ciWorkflow = readConfig(".github/workflows/ci.yml");
    const webPackage = JSON.parse(readConfig("web/package.json")) as {
      scripts?: Record<string, string>;
    };
    const astroBuildRunner = readConfig("web/scripts/build-astro.mjs");
    const unitStart = ciWorkflow.indexOf("\n  unit:\n");
    const e2eStart = ciWorkflow.indexOf("\n  e2e:\n");
    expect(unitStart).toBeGreaterThan(-1);
    expect(e2eStart).toBeGreaterThan(-1);

    const unitTimeout = ciWorkflow
      .slice(unitStart, e2eStart)
      .match(/timeout-minutes:\s*(\d+)/);
    const e2eTimeout = ciWorkflow
      .slice(e2eStart)
      .match(/timeout-minutes:\s*(\d+)/);
    expect(Number(unitTimeout?.[1])).toBeGreaterThanOrEqual(45);
    expect(Number(e2eTimeout?.[1])).toBeGreaterThanOrEqual(45);
    expect(webPackage.scripts?.build).toContain("node scripts/build-astro.mjs");
    expect(webPackage.scripts?.build).toContain("pagefind --site dist");
    expect(astroBuildRunner).toContain('spawn(command, ["build", "--silent"]');
    expect(astroBuildRunner).toContain("const HEARTBEAT_MS = 30_000");
    expect(astroBuildRunner).toContain("clearInterval(heartbeat)");
  });

  it("reuses the verified Web build during Publisher E2E without changing default E2E", () => {
    const publisherWorkflow = readConfig(".github/workflows/publisher.yml");
    const defaultCommand = playwrightWebServerCommand(false);
    const reuseCommand = playwrightWebServerCommand(true);

    expect(defaultCommand).toContain("npm --prefix web run build");
    expect(defaultCommand).toContain("npm --prefix web run preview");
    expect(reuseCommand).toBe(
      "npm --prefix web run preview -- --host 127.0.0.1 --port 4322",
    );
    expect(publisherWorkflow).toContain('PLAYWRIGHT_REUSE_BUILD: "1"');
    expect(publisherWorkflow).toMatch(
      /npm run build:web[\s\S]*npm run test:e2e/,
    );
  });

  it("passes the verified Web build from the CI unit job to Playwright", () => {
    const ciWorkflow = readConfig(".github/workflows/ci.yml");
    const buildIndex = ciWorkflow.indexOf("npm run build:web");
    const uploadIndex = ciWorkflow.indexOf("name: Upload verified Web build");
    const downloadIndex = ciWorkflow.indexOf("name: Download verified Web build");
    const e2eIndex = ciWorkflow.indexOf("name: E2E tests");

    expect(buildIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(buildIndex);
    expect(downloadIndex).toBeGreaterThan(uploadIndex);
    expect(e2eIndex).toBeGreaterThan(downloadIndex);
    expect(ciWorkflow).toContain("uses: actions/upload-artifact@v4");
    expect(ciWorkflow).toContain("uses: actions/download-artifact@v4");
    expect(ciWorkflow).toContain(
      "name: web-dist-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(
      ciWorkflow.slice(e2eIndex, ciWorkflow.indexOf("name: Upload Playwright report")),
    ).toContain('PLAYWRIGHT_REUSE_BUILD: "1"');
  });

  it("spreads source collection across six hourly batches", () => {
    expect(SOURCE_BATCHES).toBe(6);
    const start = Date.parse("2026-07-12T00:00:00.000Z");
    expect(
      Array.from({ length: SOURCE_BATCHES }, (_, hour) =>
        sourceBatchIndexAt(start + hour * 3600_000),
      ),
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sourceBatchIndexAt(start + SOURCE_BATCHES * 3600_000)).toBe(0);
  });
});
