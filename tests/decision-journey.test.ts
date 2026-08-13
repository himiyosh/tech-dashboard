import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_JOURNEY_OUTPUT_LIMIT_BYTES,
  DECISION_JOURNEY_STEPS,
  DECISION_JOURNEY_VIEWPORTS,
  DecisionJourneyTimeoutError,
  createDecisionJourneyReport,
  deterministicStepContractFailure,
  isExactSearchTitleCandidate,
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
  return DECISION_JOURNEY_STEPS.map((step, index) => {
    const route = step.name === "not_found_recovery"
      ? "/e/0000000000000000/"
      : "/";
    return {
      ...step,
      status:
        step.name === "pending_summary_or_fully_summarized"
          ? "not_applicable" as const
          : "completed" as const,
      elapsedMs: 100 + index,
      viewport,
      route,
      actionCount: 0,
      actionLimit: 3,
      actions: [],
      documentNavigationCount: 1,
      expectedDocumentRoutes: [route],
      documentRoutes: [route],
      navigationStable: true,
      completionViewport: {
        width: viewport === "desktop" ? 1440 : 390,
        height: viewport === "desktop" ? 900 : 844,
        scrollX: 0,
        scrollY: 0,
      },
      evidence: step.name === "pending_summary_or_fully_summarized"
        ? {
            corpusState: "fully-summarized-corpus",
            pendingCardCount: 0,
          }
        : { state: "ready" },
    };
  });
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
  it("chooses prose titles instead of package-version identifiers for exact search", () => {
    expect(isExactSearchTitleCandidate("langchain-openai==1.5.0")).toBe(false);
    expect(isExactSearchTitleCandidate("v1.2.3")).toBe(false);
    expect(
      isExactSearchTitleCandidate(
        "AIエージェントの指示ファイルは、なぜ端末ごとにズレていくのか",
      ),
    ).toBe(true);
    expect(isExactSearchTitleCandidate("Copilot reliability update")).toBe(true);
  });

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
      schemaVersion: 3,
      measurementKind: "local-synthetic-decision-journey",
      fieldData: false,
      timingAssessment: "informational-only",
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

  it("keeps elapsed milliseconds informational even beyond the five-minute reference window", () => {
    const report = createDecisionJourneyReport(
      "0123456789abcdef0123456789abcdef01234567",
      "2026-07-30T12:00:00.000Z",
      900_000,
      completedRuns(),
    );

    expect(report.status).toBe("completed");
    expect(report.elapsedMs).toBe(900_000);
    expect(report.timingAssessment).toBe("informational-only");
    expect(report).not.toHaveProperty("referenceWindowMs");
    expect(() => validateDecisionJourneyReport(report)).not.toThrow();
  });

  it("fails deterministic complexity and navigation contracts", () => {
    expect(
      deterministicStepContractFailure({
        actionCount: 4,
        actionLimit: 3,
        documentRoutes: ["/"],
        expectedDocumentRoutes: ["/"],
        runtimeErrors: [],
      }),
    ).toBe("action count 4 exceeds limit 3");
    expect(
      deterministicStepContractFailure({
        actionCount: 1,
        actionLimit: 3,
        documentRoutes: ["/", "/unexpected"],
        expectedDocumentRoutes: ["/"],
        runtimeErrors: [],
      }),
    ).toContain("document routes");
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
