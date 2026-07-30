import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_JOURNEY_OUTPUT_LIMIT_BYTES,
  DECISION_JOURNEY_STEPS,
  DECISION_JOURNEY_VIEWPORTS,
  DecisionJourneyTimeoutError,
  createDecisionJourneyReport,
  pendingSummaryOutcome,
  serializeDecisionJourneyReport,
  validateDecisionJourneyReport,
  withBoundedTimeout,
  withResourceCleanup,
  type DecisionJourneyStepResult,
  type DecisionJourneyViewportResult,
} from "../scripts/decision-journey.ts";

function completedSteps(
  viewport: "desktop" | "mobile",
): DecisionJourneyStepResult[] {
  return DECISION_JOURNEY_STEPS.map((step, index) => ({
    ...step,
    status:
      step.name === "pending_summary_or_fully_summarized"
        ? "not_applicable"
        : "completed",
    elapsedMs: 100 + index,
    viewport,
    route: step.name === "not_found_recovery"
      ? "/e/0000000000000000/"
      : "/",
    evidence: step.name === "pending_summary_or_fully_summarized"
      ? {
          corpusState: "fully-summarized-corpus",
          pendingCardCount: 0,
        }
      : { state: "ready" },
  }));
}

function completedRuns(): DecisionJourneyViewportResult[] {
  return DECISION_JOURNEY_VIEWPORTS.map((viewport) => ({
    viewport: {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
    },
    status: "completed",
    elapsedMs: 1_000,
    steps: completedSteps(viewport.name),
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("decision journey report contract", () => {
  it("serializes a bounded, non-field report with every named step and viewport", () => {
    const report = createDecisionJourneyReport(
      "0123456789abcdef0123456789abcdef01234567",
      "2026-07-30T12:00:00.000Z",
      2_000,
      completedRuns(),
    );

    expect(() => validateDecisionJourneyReport(report)).not.toThrow();
    const serialized = serializeDecisionJourneyReport(report);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      DECISION_JOURNEY_OUTPUT_LIMIT_BYTES,
    );
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 1,
      measurementKind: "local-synthetic-decision-journey",
      fieldData: false,
      status: "completed",
    });
    expect(report.runs.map((run) => run.viewport.name)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(report.runs[0]!.steps.map((step) => step.name)).toEqual(
      DECISION_JOURNEY_STEPS.map((step) => step.name),
    );
  });

  it("fails closed when field data or a required viewport is falsely claimed", () => {
    const report = createDecisionJourneyReport(
      "0123456789abcdef0123456789abcdef01234567",
      "2026-07-30T12:00:00.000Z",
      1_000,
      completedRuns(),
    );
    expect(() =>
      validateDecisionJourneyReport({
        ...report,
        fieldData: true,
      }),
    ).toThrow("fieldData must be false");
    expect(() =>
      validateDecisionJourneyReport({
        ...report,
        runs: report.runs.filter((run) => run.viewport.name === "desktop"),
      }),
    ).toThrow("completed report requires completed desktop and mobile runs");
  });
});

describe("optional pending-summary state", () => {
  it("measures a present pending article and accepts a fully summarized corpus", () => {
    expect(pendingSummaryOutcome(3)).toEqual({
      status: "completed",
      corpusState: "pending-summary-present",
    });
    expect(pendingSummaryOutcome(0)).toEqual({
      status: "not_applicable",
      corpusState: "fully-summarized-corpus",
    });
    expect(() => pendingSummaryOutcome(-1)).toThrow(
      "pendingCount must be a non-negative integer",
    );
  });
});

describe("timeout and cleanup behavior", () => {
  it("closes its resource after a bounded timeout without waiting on real time", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const operation = withResourceCleanup(
      async () => ({ close }),
      async () =>
        withBoundedTimeout(
          new Promise<never>(() => {}),
          250,
        ),
    );

    const rejection = expect(operation).rejects.toBeInstanceOf(
      DecisionJourneyTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cleans up after a normal operation failure too", async () => {
    const close = vi.fn(async () => undefined);
    await expect(
      withResourceCleanup(
        async () => ({ close }),
        async () => {
          throw new Error("synthetic failure");
        },
      ),
    ).rejects.toThrow("synthetic failure");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
