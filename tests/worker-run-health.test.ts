import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveWorkerRunStatus, runCadenceCopy } from "../web/src/lib/run-health.ts";

describe("deriveWorkerRunStatus", () => {
  it("marks a late run as err without calling it a source failure", () => {
    const status = deriveWorkerRunStatus({
      workerHealth: {
        lastRunAt: "2026-06-01T00:00:00.000Z",
        copilotOk: true,
        sourcesFailed: [],
      },
      nowMs: Date.parse("2026-06-01T07:30:00.000Z"),
      fallbackPercent: 0,
      pendingSummaryEntries: 0,
    });

    expect(status.state).toBe("late");
    expect(status.tone).toBe("err");
    expect(status.statusText).toBe("ERR");
    expect(status.stateText).toBe("DELAYED");
    expect(status.runLabel).toBe("run delayed");
    expect(status.detail).toContain("no run in 6h+");
    expect(runCadenceCopy(status, "7h ago")).toEqual({
      ja: "通常は毎時 1 バッチ収集 · 現在は収集遅延を検出 · 最新 index は 7h ago",
      en: "Normally one batch hourly · collection is currently delayed · latest index 7h ago",
    });

  });

  it("Statusは未記録の収集telemetryをエラー0件として表示しない", () => {
    const source = readFileSync(
      join(process.cwd(), "web/src/pages/status.astro"),
      "utf8",
    );

    expect(source).toContain(
      "const collectionFailureCount = wh === null ? null : wh.sourcesFailed.length;",
    );
    expect(source).toContain(
      'data-collection-failure-count={collectionFailureCount ?? "unknown"}',
    );
    expect(source).toContain(
      'data-collection-telemetry-state={wh ? "available" : "unavailable"}',
    );
    expect(source).toContain("実行記録がないため、直近 batch の収集結果を確認できません。");
    expect(source).not.toContain("wh?.sourcesFailed.length ?? 0");
    expect(source).toContain(
      'defaultSourceFilter === "limited" ? limitedListingSourceCount : sources.length',
    );
    expect(source.match(/data-visible-source-count>\{initialVisibleSourceCount\}/g)).toHaveLength(2);
  });

  it("marks a fresh run as err when every attempted source failed", () => {
    const status = deriveWorkerRunStatus({
      workerHealth: {
        lastRunAt: "2026-06-01T07:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 0,
        sourcesFailed: Array.from({ length: 14 }, (_, index) => `source-${index + 1}`),
      },
      nowMs: Date.parse("2026-06-01T07:30:00.000Z"),
      fallbackPercent: 0,
      pendingSummaryEntries: 0,
    });

    expect(status.state).toBe("failed");
    expect(status.tone).toBe("err");
    expect(status.statusText).toBe("ERR");
    expect(status.stateText).toBe("FAILED");
    expect(status.runLabel).toBe("run failed");
    expect(status.detail).toBe("all 14 sources failed");
  });

  it("keeps severity separate from the operational state label", () => {
    const status = deriveWorkerRunStatus({
      workerHealth: {
        lastRunAt: "2026-06-01T07:00:00.000Z",
        copilotOk: false,
        sourcesAttempted: 14,
        sourcesOk: 13,
        sourcesFailed: ["source-1"],
      },
      nowMs: Date.parse("2026-06-01T07:30:00.000Z"),
      fallbackPercent: 0,
      pendingSummaryEntries: 0,
    });

    expect(status).toMatchObject({
      state: "degraded",
      tone: "warn",
      statusText: "WARN",
      stateText: "DEGRADED",
      runLabel: "run degraded",
    });
  });
});
