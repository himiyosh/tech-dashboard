import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveQueueDisplay } from "../web/src/lib/queue-health.ts";

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
      }),
    ).toMatchObject({
      state: "waiting-for-run",
      tone: "err",
      backlog: 433,
      showBacklog: true,
      labelJa: "収集再開待ち",
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

  it("EntryCardはQueueDisplayで宣言されたlabelだけを表示契約に使う", () => {
    const source = readFileSync(
      join(process.cwd(), "web/src/components/EntryCard.astro"),
      "utf8",
    );

    expect(source).toMatch(
      /active:\s*\{\s*ja:\s*summaryQueue\.labelJa,\s*en:\s*summaryQueue\.labelEn,/,
    );
    expect(source).not.toContain("summaryQueue.showEstimate");
    expect(source).not.toContain("summaryQueue.estimateHours");
  });
});
