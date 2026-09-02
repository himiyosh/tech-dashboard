import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveQueueDisplay,
  summaryQueueCardCopy,
} from "../web/src/lib/queue-health.ts";

describe("deriveQueueDisplay", () => {
  it("enabled queueだけ backlog 0をclearとして扱う", () => {
    expect(
      deriveQueueDisplay({
        mode: "enabled",
        backlog: 0,
        drainEstimateHours: 0,
        runTone: "ok",
      }),
    ).toMatchObject({
      state: "clear",
      tone: "ok",
      showBacklog: true,
      labelEn: "queue clear",
    });
  });

  it.each([
    ["disabled", "paused", "queue paused"],
    ["missing-binding", "unavailable", "binding unavailable"],
    ["error", "error", "queue error"],
    [null, "unknown", "snapshot unavailable"],
  ] as const)(
    "mode=%sでは backlog 0をclearとして表示しない",
    (mode, state, labelEn) => {
      expect(
        deriveQueueDisplay({
          mode,
          backlog: 0,
          drainEstimateHours: 0,
          runTone: "ok",
        }),
      ).toMatchObject({
        state,
        showBacklog: false,
        labelEn,
      });
    },
  );

  it("run停止中は保持済みETAを確定値として表示しない", () => {
    expect(
      deriveQueueDisplay({
        mode: "enabled",
        backlog: 433,
        drainEstimateHours: 13,
        runTone: "err",
        runState: "failed",
      }),
    ).toMatchObject({
      state: "waiting-for-run",
      tone: "neutral",
      backlog: 433,
      showBacklog: true,
      labelJa: "収集再開待ち",
      labelEn: "waiting for a successful run",
    });
  });

  it("late runではneutral toneで待機し、保持済みETAを隠す", () => {
    expect(
      deriveQueueDisplay({
        mode: "enabled",
        backlog: 12,
        drainEstimateHours: 4,
        runTone: "warn",
        runState: "late",
      }),
    ).toMatchObject({
      state: "waiting-for-run",
      tone: "neutral",
      backlog: 12,
      showBacklog: true,
      labelEn: "waiting for a successful run",
    });
  });

  it("active queueのETAを日単位へ丸める", () => {
    expect(
      deriveQueueDisplay({
        mode: "enabled",
        backlog: 433,
        drainEstimateHours: 44,
        runTone: "warn",
      }),
    ).toMatchObject({
      state: "active",
      labelJa: "現在値で約 2d",
      labelEn: "about 2d at current throughput",
    });
  });

  it("EntryCardは個別記事の待機と全体Queueの稼働を区別する", () => {
    const source = readFileSync(
      join(process.cwd(), "web/src/components/EntryCard.astro"),
      "utf8",
    );

    expect(summaryQueueCardCopy("active")).toEqual({
      badgeJa: "要約を準備中",
      badgeEn: "Summary in preparation",
      detailJa: "AI 要約はまもなく追加されます",
      detailEn: "The AI summary will be added shortly",
    });
    expect(summaryQueueCardCopy("waiting-for-run")).toMatchObject({
      badgeJa: "要約を準備中",
      detailJa: "更新の再開後に AI 要約が追加されます",
    });
    expect(source).toContain("summaryQueueCardCopy(summaryQueue.state)");
    // The card renders only the badge; queue detail copy stays available for
    // /status but is no longer shown per entry (site audit).
    expect(source).toContain("data-summary-queue-badge-ja");
    expect(source).not.toContain("data-summary-queue-detail-ja");
    expect(source).not.toContain("AI summary queued");
    expect(source).not.toContain("summaryQueue.showEstimate");
    expect(source).not.toContain("summaryQueue.estimateHours");
  });

  it("Status exposes the persisted summary Queue snapshot stage", () => {
    const metrics = readFileSync(
      join(process.cwd(), "web/src/lib/metrics.ts"),
      "utf8",
    );
    const status = readFileSync(
      join(process.cwd(), "web/src/pages/status.astro"),
      "utf8",
    );

    expect(metrics).toContain("summaryQueueSnapshotStage");
    expect(status).toContain("data-summary-queue-snapshot-stage");
    expect(status).toContain("DASHBOARD_METRICS.summaryQueueSnapshotStage");
  });
});
