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
});
