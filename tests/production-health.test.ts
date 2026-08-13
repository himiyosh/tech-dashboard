import { describe, expect, it } from "vitest";
import {
  validateBridge,
  validateIndexFreshness,
  validateJsonFeed,
  validatePublicDeployment,
  validatePublisherRuns,
} from "../scripts/check-production-health.mjs";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";

describe("production health topology", () => {
  const healthyIndexHealth = {
    lastRunAt: "2026-07-12T11:30:00.000Z",
    copilotOk: true,
    sourcesAttempted: 9,
    sourcesOk: 9,
    sourcesFailed: [],
  };

  it("requires the Free bridge mode with no scheduled handler", () => {
    expect(
      validateBridge({
        ok: true,
        status: "bridge",
        mode: "github-actions-publisher",
        scheduled: false,
        publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      }).errors,
    ).toEqual([]);
    expect(
      validateBridge({
        ok: true,
        status: "ok",
        mode: "worker-cron",
        scheduled: true,
        publisherContractFingerprint: "sha256:wrong",
      }).errors,
    ).not.toEqual([]);
    expect(
      validateBridge({
        ok: true,
        status: "bridge",
        mode: "github-actions-publisher",
        scheduled: false,
        publisherContractFingerprint: "sha256:wrong",
      }).errors,
    ).toContain(
      `bridge publisher fingerprint is sha256:wrong; expected ${DEPLOYED_PUBLISHER_FINGERPRINT}`,
    );
  });

  it("uses the latest completed successful publisher run and tolerates a concurrent run", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const result = validatePublisherRuns(
      {
        workflow_runs: [
          {
            id: 2,
            head_branch: "main",
            event: "schedule",
            status: "in_progress",
          },
          {
            id: 1,
            head_branch: "main",
            event: "schedule",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-12T11:00:00.000Z",
          },
        ],
      },
      now,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("publisher run 2 is in_progress");
  });

  it("recognizes an explicit full reconciliation as a publishing run", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const result = validatePublisherRuns(
      {
        workflow_runs: [
          {
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: "Publisher / reconcile",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-12T11:55:00.000Z",
          },
        ],
      },
      now,
    );
    expect(result.errors).toEqual([]);
  });

  it("does not let a successful diagnostic dry run hide a failed publisher run", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const result = validatePublisherRuns(
      {
        workflow_runs: [
          {
            id: 3,
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: "Publisher / dry-run",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-12T11:55:00.000Z",
          },
          {
            id: 2,
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: "Publisher / publish",
            status: "completed",
            conclusion: "failure",
            updated_at: "2026-07-12T11:50:00.000Z",
          },
          {
            id: 1,
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: "Publisher / dry-run",
            status: "in_progress",
          },
        ],
      },
      now,
    );
    expect(result.errors).toContain(
      "latest completed publisher run concluded failure",
    );
    expect(result.warnings).toEqual([]);
  });

  it("fails stale workflow runs and structurally invalid data", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    expect(
      validatePublisherRuns(
        {
          workflow_runs: [
            {
              head_branch: "main",
              event: "schedule",
              status: "completed",
              conclusion: "success",
              updated_at: "2026-07-12T06:00:00.000Z",
            },
          ],
        },
        now,
      ).errors,
    ).toContain("publisher run is stale: 360 minutes old");
    expect(
      validateIndexFreshness(
        {
          generatedAt: "2026-07-12T11:30:00.000Z",
          count: 2,
          entries: [{}],
          health: healthyIndexHealth,
        },
        now,
      ).errors,
    ).toContain("data/index.json count does not match entries");
  });

  it("fails closed for missing or all-failed collection telemetry", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    const base = {
      generatedAt: "2026-07-12T11:30:00.000Z",
      count: 1,
      entries: [{}],
    };
    expect(validateIndexFreshness(base, now).errors).toContain(
      "data/index.json health telemetry is missing or invalid",
    );
    expect(
      validateIndexFreshness(
        {
          ...base,
          health: {
            ...healthyIndexHealth,
            sourcesAttempted: 9,
            sourcesOk: 0,
            sourcesFailed: Array.from(
              { length: 9 },
              (_, index) => `source-${index + 1}`,
            ),
          },
        },
        now,
      ).errors,
    ).toContain("data/index.json health reports all 9 sources failed");
  });

  it("requires the public deployment to expose the committed index snapshot", () => {
    const index = { generatedAt: "2026-07-12T11:30:00.000Z" };
    expect(
      validatePublicDeployment(index, {
        generatedAt: "2026-07-12T11:31:00.000Z",
        indexGeneratedAt: "2026-07-12T11:30:00.000Z",
      }).errors,
    ).toEqual([]);
    expect(
      validatePublicDeployment(index, {
        generatedAt: "2026-07-12T12:01:00.000Z",
        indexGeneratedAt: "2026-07-12T12:00:00.000Z",
      }).errors,
    ).toEqual([]);
    expect(
      validatePublicDeployment(index, {
        generatedAt: "2026-07-12T11:00:00.000Z",
        indexGeneratedAt: "2026-07-12T10:00:00.000Z",
      }).errors,
    ).toContain(
      "public deployment is behind the checked-out index snapshot: deployed 2026-07-12T10:00:00.000Z, expected at least 2026-07-12T11:30:00.000Z",
    );
    expect(validatePublicDeployment(index, {}).errors).toEqual(expect.arrayContaining([
      "public metrics indexGeneratedAt is missing",
      "public metrics generatedAt is invalid",
    ]));
  });

  it("requires the public JSON Feed media type and reader contract", () => {
    const body = {
      version: "https://jsonfeed.org/version/1.1",
      feed_url: "https://techdb.studio344.net/feed.json",
      items: [
        {
          id: "entry-1",
          url: "https://example.com/entry-1",
          title: "Entry title",
          content_text: "Entry summary",
        },
      ],
    };
    const validResponse = new Response(null, {
      headers: { "content-type": "application/feed+json; charset=utf-8" },
    });
    expect(validateJsonFeed(body, validResponse).errors).toEqual([]);

    const genericJsonResponse = new Response(null, {
      headers: { "content-type": "application/json" },
    });
    expect(validateJsonFeed(body, genericJsonResponse).errors).toContain(
      "content type is application/json; expected application/feed+json",
    );
    expect(
      validateJsonFeed(
        { ...body, items: [{ ...body.items[0], content_text: "" }] },
        validResponse,
      ).errors,
    ).toContain("items contain missing id, URL, title, or summary");
  });
});
