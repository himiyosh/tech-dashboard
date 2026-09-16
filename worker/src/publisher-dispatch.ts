/**
 * publisher-dispatch.ts — start the GitHub Actions Publisher from a Cloudflare
 * Cron Trigger instead of relying on GitHub's own `schedule` event.
 *
 * Why: GitHub's scheduler delays and drops runs for this repository. Between
 * 2026-08-30 and 09-13 the hourly `0 * * * *` schedule launched only 5-9 of its
 * 24 daily runs, their start minutes spread evenly over 0-59 (delays, not a
 * congested slot), and moving the schedule to :13/:43 produced a single run in
 * the following nine hours. The site refreshed every ~3 hours and Worker
 * Health failed on "publisher run is stale". Cloudflare Cron Triggers fire on
 * time, so the bridge Worker now asks GitHub to run the workflow.
 *
 * Contract:
 * - Every cron tick reads the newest Publisher run (any event) and dispatches
 *   only when none is queued or running and the newest one was created at
 *   least `DISPATCH_MIN_GAP_MS` ago. GitHub's own (late) schedule runs
 *   therefore reset the timer instead of stacking extra runs on top, which
 *   keeps the enrichment enqueue volume, and with it the daily KV write
 *   budget, close to one run per hour.
 * - The token is optional. Without `GITHUB_DISPATCH_TOKEN` the tick is a
 *   logged no-op, so the code can ship before the secret exists.
 * - Nothing here throws into the Worker runtime: every failure is reported as
 *   a decision with a reason and logged.
 */

/** Two ticks per hour; the gap below turns them into roughly hourly runs. */
export const DISPATCH_CRON = "*/30 * * * *";
/** Minimum age of the newest run before another one is requested. */
export const DISPATCH_MIN_GAP_MS = 50 * 60_000;
export const DISPATCH_WORKFLOW_FILE = "publisher.yml";

const GITHUB_API = "https://api.github.com";
/** Run states that mean a Publisher run is already on its way. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

export interface PublisherRunSnapshot {
  createdAt: string;
  status: string;
}

export type DispatchSkipReason =
  | "no-token"
  | "active-run"
  | "recent-run"
  | "lookup-failed"
  | "dispatch-failed";

export type DispatchDecision =
  | { action: "dispatch"; detail: string }
  | { action: "skip"; reason: DispatchSkipReason; detail: string };

export interface PublisherDispatchEnv {
  PUBLISHER_REPOSITORY: string;
  PUBLISHER_WORKFLOW_REF: string;
  /** Fine-grained PAT: this repository only, Actions read and write. */
  GITHUB_DISPATCH_TOKEN?: string;
}

/**
 * Pure decision for one tick. `latest` is the newest Publisher run of any
 * event, or null when the workflow has never run.
 */
export function decidePublisherDispatch(
  latest: PublisherRunSnapshot | null,
  nowMs: number,
  minGapMs: number = DISPATCH_MIN_GAP_MS,
): DispatchDecision {
  if (!latest) return { action: "dispatch", detail: "no previous Publisher run" };
  if (ACTIVE_RUN_STATUSES.has(latest.status)) {
    return { action: "skip", reason: "active-run", detail: `newest run is ${latest.status}` };
  }
  const createdMs = Date.parse(latest.createdAt);
  if (!Number.isFinite(createdMs)) {
    // An unreadable timestamp must not stall publishing forever.
    return { action: "dispatch", detail: `newest run has an unreadable created_at (${latest.createdAt})` };
  }
  const ageMinutes = Math.floor((nowMs - createdMs) / 60_000);
  if (nowMs - createdMs < minGapMs) {
    return { action: "skip", reason: "recent-run", detail: `newest run started ${ageMinutes} min ago` };
  }
  return { action: "dispatch", detail: `newest run started ${ageMinutes} min ago` };
}

/** Branch the workflow is dispatched on, taken from the OIDC workflow ref. */
export function dispatchRefFromWorkflowRef(workflowRef: string): string {
  const match = workflowRef.match(/@refs\/heads\/(.+)$/);
  return match?.[1] ?? "main";
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "tech-dashboard-harness-dispatch",
  };
}

export interface ScheduledDispatchOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  log?: (line: string) => void;
}

/** One cron tick: look up the newest run, decide, and dispatch when due. */
export async function runScheduledPublisherDispatch(
  env: PublisherDispatchEnv,
  options: ScheduledDispatchOptions = {},
): Promise<DispatchDecision> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const nowMs = options.nowMs ?? Date.now();
  const report = (decision: DispatchDecision): DispatchDecision => {
    log(
      decision.action === "dispatch"
        ? `[dispatch] requested Publisher run: ${decision.detail}`
        : `[dispatch] skipped (${decision.reason}): ${decision.detail}`,
    );
    return decision;
  };

  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) {
    return report({ action: "skip", reason: "no-token", detail: "GITHUB_DISPATCH_TOKEN is not set" });
  }

  const workflowUrl =
    `${GITHUB_API}/repos/${env.PUBLISHER_REPOSITORY}/actions/workflows/${DISPATCH_WORKFLOW_FILE}`;

  let latest: PublisherRunSnapshot | null;
  try {
    const response = await fetchImpl(`${workflowUrl}/runs?per_page=1`, { headers: githubHeaders(token) });
    if (!response.ok) {
      return report({ action: "skip", reason: "lookup-failed", detail: `runs lookup returned HTTP ${response.status}` });
    }
    const body = await response.json() as { workflow_runs?: Array<{ created_at?: unknown; status?: unknown }> };
    const run = body.workflow_runs?.[0];
    latest = run
      ? { createdAt: String(run.created_at ?? ""), status: String(run.status ?? "") }
      : null;
  } catch (error) {
    return report({
      action: "skip",
      reason: "lookup-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const decision = decidePublisherDispatch(latest, nowMs);
  if (decision.action === "skip") return report(decision);

  try {
    const response = await fetchImpl(`${workflowUrl}/dispatches`, {
      method: "POST",
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: dispatchRefFromWorkflowRef(env.PUBLISHER_WORKFLOW_REF) }),
    });
    if (response.status !== 204) {
      return report({
        action: "skip",
        reason: "dispatch-failed",
        detail: `dispatch returned HTTP ${response.status} (${decision.detail})`,
      });
    }
  } catch (error) {
    return report({
      action: "skip",
      reason: "dispatch-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return report(decision);
}
