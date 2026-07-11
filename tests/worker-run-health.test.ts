import { describe, expect, it } from "vitest";
import { deriveWorkerRunStatus } from "../web/src/lib/run-health.ts";

describe("deriveWorkerRunStatus", () => {
  it("marks stale last-run as err even when other worker fields look healthy", () => {
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

    expect(status.tone).toBe("err");
    expect(status.statusText).toBe("ERR");
    expect(status.runLabel).toBe("run err");
    expect(status.detail).toContain("no run in 6h+");
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

    expect(status.tone).toBe("err");
    expect(status.statusText).toBe("ERR");
    expect(status.detail).toBe("all 14 sources failed");
  });
});
