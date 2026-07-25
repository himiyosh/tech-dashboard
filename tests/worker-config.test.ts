import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  playwrightPreviewPort,
  playwrightWebServerCommand,
} from "../playwright.config.ts";
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
    expect(publisherWorkflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(publisherWorkflow).toMatch(
      /test -n "\$\(git diff --cached --name-only\)"[\s\S]*npm run publisher:run -- --preflight[\s\S]*git commit -m/,
    );
    expect(publisherWorkflow).not.toMatch(/wrangler\s+(?:pages\s+)?deploy/);
    expect(healthWorkflow).toContain('cron: "40 * * * *"');
    expect(healthWorkflow).toContain("workflow_run:");
    expect(healthWorkflow).toContain('workflows: ["Publisher"]');
    expect(healthWorkflow).toContain("types: [completed]");
    expect(healthWorkflow).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(healthWorkflow).toContain("npm run health:prod");
    expect(packageJson).toContain('"health:prod": "node scripts/check-production-health.mjs"');
  });

  it("gives CI jobs enough time for Pagefind builds and the full Playwright suite", () => {
    const ciWorkflow = readConfig(".github/workflows/ci.yml");
    const webPackage = JSON.parse(readConfig("web/package.json")) as {
      scripts?: Record<string, string>;
    };
    const astroBuildRunner = readConfig("web/scripts/build-astro.mjs");
    const astroResourcePolicy = readConfig("web/scripts/build-resource-policy.mjs");
    const astroMemoryProbe = readConfig("web/scripts/build-memory-probe.mjs");
    const astroConfig = readConfig("web/astro.config.mjs");
    const unitStart = ciWorkflow.indexOf("\n  unit:\n");
    const webBuildStart = ciWorkflow.indexOf("\n  web-build:\n");
    const e2eStart = ciWorkflow.indexOf("\n  e2e:\n");
    expect(unitStart).toBeGreaterThan(-1);
    expect(webBuildStart).toBeGreaterThan(unitStart);
    expect(e2eStart).toBeGreaterThan(-1);

    const unitTimeout = ciWorkflow
      .slice(unitStart, webBuildStart)
      .match(/timeout-minutes:\s*(\d+)/);
    const webBuildTimeout = ciWorkflow
      .slice(webBuildStart, e2eStart)
      .match(/timeout-minutes:\s*(\d+)/);
    const e2eTimeout = ciWorkflow
      .slice(e2eStart)
      .match(/timeout-minutes:\s*(\d+)/);
    expect(Number(unitTimeout?.[1])).toBeGreaterThanOrEqual(45);
    expect(Number(webBuildTimeout?.[1])).toBeGreaterThanOrEqual(45);
    expect(Number(e2eTimeout?.[1])).toBeGreaterThanOrEqual(45);
    expect(ciWorkflow.slice(webBuildStart, e2eStart)).toContain(
      "runs-on: ubuntu-24.04-arm",
    );
    expect(ciWorkflow.slice(e2eStart)).toContain(
      "runs-on: ubuntu-24.04-arm",
    );
    expect(ciWorkflow.slice(unitStart, webBuildStart)).not.toContain(
      "npm run build:web",
    );
    expect(ciWorkflow.slice(webBuildStart, e2eStart)).toContain(
      "npm run build:web",
    );
    expect(webPackage.scripts?.build).toBe("node scripts/build-astro.mjs");
    expect(astroBuildRunner).toContain("spawn(command, args");
    expect(astroBuildRunner).toContain('await runPhase("astro"');
    expect(astroBuildRunner).toContain('await runPhase("pagefind"');
    expect(astroBuildRunner).toContain("const HEARTBEAT_MS = 30_000");
    expect(astroBuildRunner).toContain("const MAX_ASTRO_RENDERED_HTML_FILES = 3_200");
    expect(astroResourcePolicy).toContain(
      'const heapLimitMiB = Number(env.ASTRO_HEAP_LIMIT_MIB ?? "512")',
    );
    expect(astroResourcePolicy).toContain(
      'env.GITHUB_ACTIONS === "true" && platform !== "win32" ? 12_000 : 0',
    );
    expect(astroBuildRunner).toContain("resolveBuildMemoryConfig()");
    expect(astroBuildRunner).toContain("`--max-old-space-size=${ASTRO_HEAP_LIMIT_MIB}`");
    expect(astroBuildRunner).toContain("build-memory-probe.mjs");
    expect(astroResourcePolicy).toContain("exceeded RSS budget");
    expect(astroBuildRunner).toContain("Astro-rendered HTML route budget exceeded");
    expect(astroBuildRunner).toContain("writeLegacyTagRedirects");
    expect(astroBuildRunner).toContain("peakRss=");
    expect(astroBuildRunner).toContain("processes=");
    expect(astroBuildRunner).toContain("routeFamilies");
    expect(astroBuildRunner).toContain("clearInterval(sampler)");
    expect(astroBuildRunner).toContain("clearInterval(heartbeat)");
    expect(astroMemoryProbe).toContain("process.memoryUsage()");
    expect(astroMemoryProbe).toContain("getHeapSpaceStatistics()");
    expect(astroMemoryProbe).toContain("external=");
    expect(astroMemoryProbe).toContain("arrayBuffers=");
    expect(astroMemoryProbe).toContain("nonHeapRssApprox=");
    expect(astroMemoryProbe).toContain("oldSpace=");
    expect(astroMemoryProbe).toContain("largeObjectSpace=");
    expect(astroMemoryProbe).toContain("html-progress");
    expect(astroConfig).toContain(
      'const BUILD_CONCURRENCY = process.env.GITHUB_ACTIONS === "true" ? 1 : 2',
    );
    expect(astroConfig).toContain("concurrency: BUILD_CONCURRENCY");
    expect(astroConfig).toContain("concurrency=${BUILD_CONCURRENCY}");
    expect(astroConfig).toContain("tech-dashboard-build-telemetry");
    expect(astroConfig).toContain('"astro:build:generated"');
    expect(astroConfig).toContain('"astro:build:done"');
  });

  it("guards emergency Direct Upload with an exact origin/main snapshot", () => {
    const webPackage = JSON.parse(readConfig("web/package.json")) as {
      scripts?: Record<string, string>;
    };
    const legacyDeploy = readConfig("web/scripts/deploy-pages-legacy.mjs");

    expect(webPackage.scripts?.["deploy:legacy"]).toBe(
      "node scripts/deploy-pages-legacy.mjs",
    );
    expect(legacyDeploy).toContain(
      'runGit(["fetch", "--quiet", "origin", "main"])',
    );
    expect(legacyDeploy).toContain(
      'assertDeploySnapshot(afterBuild, "after build", expectedHead)',
    );
    expect(legacyDeploy).toContain(
      'assertDeploySnapshot(afterDeploy, "after deploy", expectedHead)',
    );
    expect(legacyDeploy).toContain("`--commit-hash=${expectedHead}`");
    expect(legacyDeploy).not.toContain("--commit-dirty=true");
  });

  it("reuses the verified Web build during Publisher and pre-push E2E without changing default E2E", () => {
    const publisherWorkflow = readConfig(".github/workflows/publisher.yml");
    const ciWorkflow = readConfig(".github/workflows/ci.yml");
    const packageJson = JSON.parse(readConfig("package.json")) as {
      scripts?: Record<string, string>;
    };
    const playwrightConfig = readConfig("playwright.config.ts");
    const prePush = readConfig("scripts/git-hooks/pre-push");
    const defaultCommand = playwrightWebServerCommand(false, 24_322);
    const reuseCommand = playwrightWebServerCommand(true, 24_322);

    expect(defaultCommand).toContain("npm --prefix web run build");
    expect(defaultCommand).toContain("npm --prefix web run preview");
    expect(reuseCommand).toBe(
      "npm --prefix web run preview -- --host 127.0.0.1 --port 24322",
    );
    expect(playwrightConfig).toContain(
      "export function playwrightPreviewPort",
    );
    expect(playwrightConfig).toContain("Invalid PLAYWRIGHT_PORT");
    expect(playwrightConfig).toContain("baseURL: previewUrl");
    expect(playwrightConfig).toContain("url: previewUrl");
    expect(playwrightConfig).toContain("reuseExistingServer: false");
    expect(playwrightPreviewPort("/tmp/worktree-a")).toBe(
      playwrightPreviewPort("/tmp/worktree-a"),
    );
    expect(playwrightPreviewPort("/tmp/worktree-a")).not.toBe(
      playwrightPreviewPort("/tmp/worktree-b"),
    );
    expect(playwrightPreviewPort("/tmp/worktree", "24567")).toBe(24_567);
    expect(() => playwrightPreviewPort("/tmp/worktree", "80")).toThrow(
      "Invalid PLAYWRIGHT_PORT",
    );
    expect(() => playwrightPreviewPort("/tmp/worktree", "invalid")).toThrow(
      "Invalid PLAYWRIGHT_PORT",
    );
    expect(playwrightConfig).toContain("workers: 1");
    expect(publisherWorkflow).toContain('PLAYWRIGHT_REUSE_BUILD: "1"');
    expect(publisherWorkflow).toMatch(
      /npm run build:web[\s\S]*npm run test:e2e:publisher/,
    );
    expect(publisherWorkflow).not.toMatch(/\bnpm run test:e2e\s*$/m);
    expect(packageJson.scripts?.["test:e2e:publisher"]).toBe(
      "playwright test tests/e2e/publisher.spec.ts",
    );
    expect(packageJson.scripts?.["test:e2e:prepush"]).toBeUndefined();
    expect(ciWorkflow).toMatch(/\brun: npm run test:e2e\s*$/m);
    expect(ciWorkflow).not.toContain("test:e2e:publisher");
    expect(prePush).toContain("web_build_ready=0");
    expect(prePush).toContain('range="$base_ref..$local_sha"');
    expect(prePush).not.toContain('range="$local_sha"\n  else');
    expect(prePush).toContain('pushed_files="${pushed_files}"');
    expect(prePush).toContain('CHANGED="$pushed_files"');
    expect(prePush).toContain('git log --format= --name-only "$local_sha"');
    expect(prePush).toContain(
      `grep -qE '^(web/|data/index\\.json|tests/e2e/|playwright\\.config\\.)' <<<"$CHANGED"`,
    );
    expect(prePush).not.toContain('echo "$CHANGED" | grep -qE');
    expect(prePush).not.toContain("git diff --name-only HEAD @{u}");
    expect(prePush).toContain('grep -E "^(BUILD:|ASTRO:)|Pagefind|Indexed"');
    expect(prePush).toMatch(/npm --prefix "\$ROOT" run build:web[\s\S]*web_build_ready=1/);
    expect(prePush).toContain("env PLAYWRIGHT_REUSE_BUILD=1");
    expect(prePush).toContain('"$playwright_bin" test tests/e2e/publisher.spec.ts');
    expect(prePush).not.toContain("tests/e2e/smoke.spec.ts");
    expect(prePush).toMatch(
      /if \[ "\$web_build_ready" = "1" \][\s\S]*PLAYWRIGHT_REUSE_BUILD=1[\s\S]*else[\s\S]*"\$playwright_bin" test/,
    );
    expect(readConfig("vitest.config.ts")).toContain("maxWorkers: 1");
  });

  it("loads search metadata from the shared client bundle instead of repeating JSON in every page", () => {
    const portal = readConfig("web/src/layouts/Portal.astro");

    expect(portal).toContain('import { CATEGORY_META } from "../lib/category-meta.ts"');
    expect(portal).toContain('import { SOURCE_META, sourceLabel } from "../lib/source-meta.ts"');
    expect(portal).not.toContain("data-category-search-meta");
    expect(portal).not.toContain("data-source-search-meta");
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
    expect(ciWorkflow).toContain("needs: [unit, web-build]");
    expect(ciWorkflow).toContain(
      "name: web-dist-${{ github.run_id }}",
    );
    expect(ciWorkflow).not.toContain(
      "name: web-dist-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(ciWorkflow).toContain("overwrite: true");
    expect(ciWorkflow).toContain("retention-days: 7");
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
