import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  DECISION_JOURNEY_STEPS,
  DECISION_JOURNEY_VIEWPORTS,
  createDecisionJourneyReport,
  measureDecisionJourneyViewport,
  serializeDecisionJourneyReport,
} from "../../scripts/decision-journey.ts";

test("local synthetic decision journey completes on desktop and mobile", async ({
  browser,
  baseURL,
}) => {
  expect(baseURL, "Playwright baseURL is required").toBeTruthy();
  const startedAt = performance.now();
  const generatedAt = new Date().toISOString();
  const runs = [];

  for (const viewport of DECISION_JOURNEY_VIEWPORTS) {
    runs.push(
      await measureDecisionJourneyViewport(browser, baseURL!, viewport),
    );
  }

  const report = createDecisionJourneyReport(
    process.env.DECISION_JOURNEY_COMMIT?.trim() || "unknown-local-head",
    generatedAt,
    Math.max(0, Math.round(performance.now() - startedAt)),
    runs,
  );
  const serialized = serializeDecisionJourneyReport(report);
  const outputPath = process.env.DECISION_JOURNEY_OUTPUT?.trim();
  if (outputPath) writeFileSync(outputPath, serialized, "utf8");

  // Assert the journey outcome FIRST so a CI failure names the failed step and
  // its observed state; the structural assertions below would otherwise mask
  // the cause behind "records every machine-readable step".
  expect(
    report.status,
    report.failure
      ? `${report.failure.stepName}: ${report.failure.reason}; observed=${JSON.stringify(
          report.failure.observedState,
        )}`
      : "decision journey did not complete",
  ).toBe("completed");

  expect(
    report.runs.map((run) => run.viewport.name),
    "both declared viewport journeys ran",
  ).toEqual(DECISION_JOURNEY_VIEWPORTS.map((viewport) => viewport.name));
  for (const run of report.runs) {
    expect(
      run.steps.map((step) => step.name),
      `${run.viewport.name} records every machine-readable step`,
    ).toEqual(DECISION_JOURNEY_STEPS.map((step) => step.name));
    for (const step of run.steps) {
      expect(
        step.actionCount,
        `${run.viewport.name}/${step.name} stays within its interaction limit`,
      ).toBeLessThanOrEqual(step.actionLimit);
      expect(
        step.navigationStable,
        `${run.viewport.name}/${step.name} has no unexpected reload or route race`,
      ).toBe(true);
      expect(step.documentRoutes).toEqual(step.expectedDocumentRoutes);
      expect(step.completionViewport).toMatchObject({
        width: run.viewport.width,
        height: run.viewport.height,
      });
    }
  }
});
