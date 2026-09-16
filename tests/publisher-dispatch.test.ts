import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DISPATCH_CRON,
  DISPATCH_MIN_GAP_MS,
  decidePublisherDispatch,
  dispatchRefFromWorkflowRef,
  runScheduledPublisherDispatch,
  type PublisherDispatchEnv,
} from "../worker/src/publisher-dispatch.ts";
import bridge from "../worker/src/free-plan-bridge.ts";

// GitHub's schedule event launched only 5-9 of 24 hourly Publisher runs a day
// (start minutes spread over 0-59), and moving the cron to :13/:43 produced a
// single run in nine hours. A Cloudflare Cron Trigger now dispatches the
// workflow; these tests pin when it does and does not.

const NOW = Date.parse("2026-09-15T00:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const ENV: PublisherDispatchEnv = {
  PUBLISHER_REPOSITORY: "himiyosh/tech-dashboard",
  PUBLISHER_WORKFLOW_REF: "himiyosh/tech-dashboard/.github/workflows/publisher.yml@refs/heads/main",
  GITHUB_DISPATCH_TOKEN: "github_pat_test",
};

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function githubStub(options: {
  runs?: Array<{ created_at: string; status: string }>;
  runsStatus?: number;
  dispatchStatus?: number;
  throwOn?: "runs" | "dispatch";
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.endsWith("/dispatches")) {
      if (options.throwOn === "dispatch") throw new Error("network down");
      return new Response(null, { status: options.dispatchStatus ?? 204 });
    }
    if (options.throwOn === "runs") throw new Error("network down");
    return new Response(JSON.stringify({ workflow_runs: options.runs ?? [] }), {
      status: options.runsStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("decidePublisherDispatch", () => {
  it("dispatches when the newest run is at least the minimum gap old, or when none exists", () => {
    expect(decidePublisherDispatch({ createdAt: minutesAgo(50), status: "completed" }, NOW).action).toBe("dispatch");
    expect(decidePublisherDispatch({ createdAt: minutesAgo(240), status: "completed" }, NOW).action).toBe("dispatch");
    expect(decidePublisherDispatch(null, NOW).action).toBe("dispatch");
  });

  it("skips while a run is recent or still on its way", () => {
    expect(decidePublisherDispatch({ createdAt: minutesAgo(49), status: "completed" }, NOW)).toMatchObject({
      action: "skip",
      reason: "recent-run",
    });
    for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) {
      expect(decidePublisherDispatch({ createdAt: minutesAgo(300), status }, NOW)).toMatchObject({
        action: "skip",
        reason: "active-run",
      });
    }
  });

  it("does not stall on an unreadable timestamp", () => {
    expect(decidePublisherDispatch({ createdAt: "garbage", status: "completed" }, NOW).action).toBe("dispatch");
  });

  it("keeps two ticks an hour down to about one run an hour", () => {
    expect(DISPATCH_CRON).toBe("*/30 * * * *");
    expect(DISPATCH_MIN_GAP_MS).toBe(50 * 60_000);
    // A run dispatched at :00 blocks the :30 tick and allows the next :00 one.
    expect(decidePublisherDispatch({ createdAt: minutesAgo(30), status: "completed" }, NOW).action).toBe("skip");
    expect(decidePublisherDispatch({ createdAt: minutesAgo(60), status: "completed" }, NOW).action).toBe("dispatch");
  });
});

describe("dispatchRefFromWorkflowRef", () => {
  it("reads the branch from the OIDC workflow ref and falls back to main", () => {
    expect(dispatchRefFromWorkflowRef(ENV.PUBLISHER_WORKFLOW_REF)).toBe("main");
    expect(dispatchRefFromWorkflowRef("o/r/.github/workflows/p.yml@refs/heads/release/x")).toBe("release/x");
    expect(dispatchRefFromWorkflowRef("unexpected")).toBe("main");
  });
});

describe("runScheduledPublisherDispatch", () => {
  const log = () => {};

  it("is a no-op without a token and makes no request", async () => {
    const { calls, fetchImpl } = githubStub({});
    const decision = await runScheduledPublisherDispatch(
      { ...ENV, GITHUB_DISPATCH_TOKEN: undefined },
      { fetchImpl, nowMs: NOW, log },
    );
    expect(decision).toMatchObject({ action: "skip", reason: "no-token" });
    expect(calls).toHaveLength(0);
  });

  it("dispatches the workflow on main when the newest run is stale", async () => {
    const { calls, fetchImpl } = githubStub({ runs: [{ created_at: minutesAgo(190), status: "completed" }] });
    const decision = await runScheduledPublisherDispatch(ENV, { fetchImpl, nowMs: NOW, log });
    expect(decision.action).toBe("dispatch");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/himiyosh/tech-dashboard/actions/workflows/publisher.yml/runs?per_page=1",
      "POST https://api.github.com/repos/himiyosh/tech-dashboard/actions/workflows/publisher.yml/dispatches",
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ ref: "main" });
    expect(calls[1]!.headers.authorization).toBe("Bearer github_pat_test");
  });

  it("does not dispatch when the newest run is recent or active", async () => {
    for (const run of [
      { created_at: minutesAgo(10), status: "completed" },
      { created_at: minutesAgo(300), status: "in_progress" },
    ]) {
      const { calls, fetchImpl } = githubStub({ runs: [run] });
      const decision = await runScheduledPublisherDispatch(ENV, { fetchImpl, nowMs: NOW, log });
      expect(decision.action).toBe("skip");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    }
  });

  it("reports lookup and dispatch failures instead of throwing", async () => {
    const badStatus = githubStub({ runsStatus: 401 });
    expect(await runScheduledPublisherDispatch(ENV, { fetchImpl: badStatus.fetchImpl, nowMs: NOW, log }))
      .toMatchObject({ action: "skip", reason: "lookup-failed" });
    expect(badStatus.calls.filter((call) => call.method === "POST")).toHaveLength(0);

    const network = githubStub({ throwOn: "runs" });
    expect(await runScheduledPublisherDispatch(ENV, { fetchImpl: network.fetchImpl, nowMs: NOW, log }))
      .toMatchObject({ action: "skip", reason: "lookup-failed" });

    const rejected = githubStub({ runs: [], dispatchStatus: 403 });
    expect(await runScheduledPublisherDispatch(ENV, { fetchImpl: rejected.fetchImpl, nowMs: NOW, log }))
      .toMatchObject({ action: "skip", reason: "dispatch-failed" });

    const dropped = githubStub({ runs: [], throwOn: "dispatch" });
    expect(await runScheduledPublisherDispatch(ENV, { fetchImpl: dropped.fetchImpl, nowMs: NOW, log }))
      .toMatchObject({ action: "skip", reason: "dispatch-failed" });
  });

  it("logs every decision with its reason", async () => {
    const lines: string[] = [];
    const { fetchImpl } = githubStub({ runs: [{ created_at: minutesAgo(5), status: "completed" }] });
    await runScheduledPublisherDispatch(ENV, { fetchImpl, nowMs: NOW, log: (line) => lines.push(line) });
    expect(lines).toEqual([expect.stringMatching(/^\[dispatch\] skipped \(recent-run\): newest run started 5 min ago$/)]);
  });
});

describe("bridge wiring", () => {
  it("exports a scheduled handler and declares the cron trigger", () => {
    expect(typeof bridge.scheduled).toBe("function");
    const toml = readFileSync("worker/wrangler.toml", "utf8");
    expect(toml).toMatch(/\[triggers\]\s*\ncrons = \["\*\/30 \* \* \* \*"\]/);
    expect(toml).toContain(DISPATCH_CRON);
  });

  it("hands the tick to waitUntil without throwing when the token is missing", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    expect(() =>
      bridge.scheduled!(
        {} as ScheduledController,
        { ...ENV, GITHUB_DISPATCH_TOKEN: undefined } as never,
        ctx,
      ),
    ).not.toThrow();
    expect(pending).toHaveLength(1);
    await expect(pending[0]).resolves.toBeUndefined();
  });
});
