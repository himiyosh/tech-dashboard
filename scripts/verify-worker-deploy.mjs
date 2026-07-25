#!/usr/bin/env node

// Bounded post-deploy verification for `tech-dashboard-harness` (the Free-plan
// bridge Worker). `wrangler deploy` returning success, or `wrangler deployments
// list` showing a new version at 100%, only means Cloudflare's control plane
// has *accepted* the deployment (it does not mean every edge PoP is already
// serving it). A single immediate `/health` check (even with a cache-busting
// query and `cache-control: no-cache`) can therefore still observe the
// *previous* bundle's `publisherContractFingerprint` for up to roughly a
// minute while the new script propagates globally (LL-407).
//
// This script polls `/health` on a bounded interval/timeout and requires
// several *consecutive* matches before declaring the rollout verified, so a
// single lucky hit against an already-updated PoP cannot be mistaken for a
// completed rollout, and a genuinely bad bundle (or a harness that is stuck
// on the old fingerprint for reasons other than propagation) still fails
// closed once the bounded window elapses. It intentionally does not retry
// forever: `npm run health:prod` / `worker-health.yml` remain the immediate,
// fail-closed, *recurring* checks (R-027); this tool exists only for the
// short window right after an explicit, human-approved deploy.
//
// Usage:
//   node scripts/verify-worker-deploy.mjs
//   node scripts/verify-worker-deploy.mjs --expected sha256:...
//   node scripts/verify-worker-deploy.mjs --url http://127.0.0.1:8787/health --timeout-ms 10000

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_HEALTH_URL =
  process.env.HARNESS_HEALTH_URL ??
  "https://tech-dashboard-harness.himiyosh.workers.dev/health";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_REQUIRED_CONSECUTIVE = 3;
const DEFAULT_CONTRACT_URL = new URL(
  "../worker/publisher-contract.json",
  import.meta.url,
);

export function readExpectedFingerprint(contractPath = DEFAULT_CONTRACT_URL) {
  const raw = readFileSync(contractPath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.fingerprint !== "string" || parsed.fingerprint.length === 0) {
    throw new Error(
      `${contractPath} is missing a string "fingerprint" field`,
    );
  }
  return parsed.fingerprint;
}

function cacheBustUrl(url) {
  const withQuery = new URL(url);
  withQuery.searchParams.set(
    "_verify",
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  return withQuery.toString();
}

async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function performHealthCheck(url, fetchImpl, signal) {
  const response = await fetchImpl(cacheBustUrl(url), {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  const body = await response.json();
  if (typeof body?.publisherContractFingerprint === "string") {
    return { fingerprint: body.publisherContractFingerprint };
  }
  return { error: "response is missing publisherContractFingerprint" };
}

// Bounds a single attempt (fetch + body read) to `budgetMs`, regardless of
// whether `operation()` itself ever settles. A bare `await fetchImpl(...)`
// has no timeout of its own, so a hung request (or a body read that never
// completes) would otherwise block the whole poll past `timeoutMs` despite
// every doc comment here claiming it never does (LL-407 follow-up: this was
// exactly the gap an independent review caught before merge). `controller`
// is aborted so a real `fetch()` actually cancels its in-flight request; the
// deadline itself is enforced by racing against `setTimeoutImpl`, which
// fires (and rejects) even if the injected `operation()` ignores the abort
// signal entirely -- required for a deterministic "hanging fetch" test that
// never resolves/rejects on its own.
async function withDeadline(operation, budgetMs, controller, setTimeoutImpl, clearTimeoutImpl) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeoutImpl(() => {
      controller.abort();
      reject(new Error(`poll attempt exceeded its remaining time budget (${budgetMs}ms)`));
    }, budgetMs);
  });
  const operationPromise = operation();
  // If `operation()` later rejects (e.g. a real fetch's abort) after the
  // deadline already won the race, swallow it here so it never surfaces as
  // an unhandled rejection.
  operationPromise.catch(() => {});
  try {
    return await Promise.race([operationPromise, deadline]);
  } finally {
    clearTimeoutImpl(timer);
  }
}

/**
 * Poll `url` until it reports `expectedFingerprint` for `requiredConsecutive`
 * consecutive attempts, or until `timeoutMs` elapses. Each individual attempt
 * (fetch + body read) is itself bounded to whatever time budget remains, via
 * `AbortController` plus a race against `setTimeoutImpl`, so a single hung
 * request cannot block the poll past `timeoutMs` -- the deadline check before
 * each attempt and the per-attempt deadline together guarantee the overall
 * call never blocks longer than `timeoutMs` plus a small, bounded overhead.
 *
 * All time/IO is injectable (`fetchImpl`, `sleepImpl`, `nowImpl`,
 * `setTimeoutImpl`, `clearTimeoutImpl`) so tests can run deterministically
 * with a virtual clock and a manually-driven fake timer instead of real
 * timers, including a fetch that never resolves or rejects on its own.
 */
export async function pollForFingerprint({
  url,
  expectedFingerprint,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requiredConsecutive = DEFAULT_REQUIRED_CONSECUTIVE,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  nowImpl = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onAttempt,
}) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("url is required");
  }
  if (typeof expectedFingerprint !== "string" || expectedFingerprint.length === 0) {
    throw new Error("expectedFingerprint is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("intervalMs must be a positive number");
  }
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 1) {
    throw new Error("requiredConsecutive must be an integer >= 1");
  }
  // Fail fast on configs that could never succeed: reaching N consecutive
  // matches needs at least (N - 1) full intervals between the first and
  // last of that streak, even in the best case where every poll matches.
  const minimumPossibleMs = intervalMs * (requiredConsecutive - 1);
  if (timeoutMs < minimumPossibleMs) {
    throw new Error(
      `timeoutMs (${timeoutMs}) is too small to observe ${requiredConsecutive} ` +
        `consecutive polls ${intervalMs}ms apart (needs >= ${minimumPossibleMs}ms)`,
    );
  }

  const startedAt = nowImpl();
  let attempts = 0;
  let consecutiveMatches = 0;
  let lastFingerprint;
  let lastError;

  for (;;) {
    // Check the deadline before starting another attempt: if a previous
    // sleep already pushed us to (or past) timeoutMs, stop here instead of
    // starting one more attempt with (or below) a zero time budget.
    const elapsedBeforeAttempt = nowImpl() - startedAt;
    if (elapsedBeforeAttempt >= timeoutMs) {
      return buildFailureResult({
        attempts,
        elapsedMs: elapsedBeforeAttempt,
        consecutiveMatches,
        lastFingerprint,
        lastError,
        expectedFingerprint,
        requiredConsecutive,
        url,
      });
    }

    attempts += 1;
    const remainingBudgetMs = timeoutMs - elapsedBeforeAttempt;
    const controller = new AbortController();
    let fingerprint;
    try {
      const outcome = await withDeadline(
        () => performHealthCheck(url, fetchImpl, controller.signal),
        remainingBudgetMs,
        controller,
        setTimeoutImpl,
        clearTimeoutImpl,
      );
      fingerprint = outcome.fingerprint;
      if (outcome.error) lastError = outcome.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (fingerprint !== undefined) lastFingerprint = fingerprint;
    const matched = fingerprint === expectedFingerprint;
    consecutiveMatches = matched ? consecutiveMatches + 1 : 0;
    const elapsedMs = nowImpl() - startedAt;

    if (onAttempt) {
      onAttempt({ attempt: attempts, fingerprint, matched, consecutiveMatches, elapsedMs });
    }

    if (consecutiveMatches >= requiredConsecutive) {
      return { ok: true, attempts, elapsedMs, consecutiveMatches };
    }

    if (elapsedMs >= timeoutMs) {
      return buildFailureResult({
        attempts,
        elapsedMs,
        consecutiveMatches,
        lastFingerprint,
        lastError,
        expectedFingerprint,
        requiredConsecutive,
        url,
      });
    }

    // Never sleep past the deadline: cap the inter-attempt wait to whatever
    // budget remains so the whole call cannot exceed timeoutMs plus one
    // bounded attempt.
    await sleepImpl(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}

function buildFailureResult({
  attempts,
  elapsedMs,
  consecutiveMatches,
  lastFingerprint,
  lastError,
  expectedFingerprint,
  requiredConsecutive,
  url,
}) {
  const reason =
    lastFingerprint === undefined
      ? `no valid fingerprint observed from ${url}${lastError ? ` (${lastError})` : ""}`
      : lastFingerprint === expectedFingerprint
        ? `fingerprint matched but never reached ${requiredConsecutive} consecutive successes before timeout`
        : `fingerprint is still ${lastFingerprint}; expected ${expectedFingerprint}`;
  return {
    ok: false,
    attempts,
    elapsedMs,
    consecutiveMatches,
    lastFingerprint,
    lastError,
    reason,
  };
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/verify-worker-deploy.mjs [options]",
      "",
      "Polls the Free bridge /health endpoint until it reports the expected",
      "publisherContractFingerprint for several consecutive attempts, bounded",
      "by a timeout. Intended for use right after `wrangler deploy` -- not a",
      "replacement for the recurring, immediate, fail-closed scheduled checks",
      "(npm run health:prod / worker-health.yml).",
      "",
      "Options:",
      "  --url <url>            health endpoint (default: HARNESS_HEALTH_URL or the",
      "                         production tech-dashboard-harness /health URL)",
      "  --expected <fingerprint>  expected sha256:... fingerprint (default: read from",
      "                         worker/publisher-contract.json)",
      "  --timeout-ms <ms>      total bounded budget (default: 120000)",
      "  --interval-ms <ms>     delay between polls (default: 5000)",
      "  --consecutive <n>      required consecutive matches (default: 3)",
      "  --help, -h             show this help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_HEALTH_URL,
    expectedFingerprint: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    requiredConsecutive: DEFAULT_REQUIRED_CONSECUTIVE,
  };

  function nextValue(index, flag) {
    const value = argv[index + 1];
    if (value === undefined) {
      return { ok: false, message: `${flag} requires a value` };
    }
    return { ok: true, value };
  }

  function nextPositiveNumber(index, flag) {
    const next = nextValue(index, flag);
    if (!next.ok) return next;
    const value = Number(next.value);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, message: `${flag} must be a positive number, got ${next.value}` };
    }
    return { ok: true, value };
  }

  function nextPositiveInt(index, flag) {
    const next = nextPositiveNumber(index, flag);
    if (!next.ok) return next;
    if (!Number.isInteger(next.value)) {
      return { ok: false, message: `${flag} must be an integer` };
    }
    return next;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        return { ok: true, help: true, options };
      case "--url": {
        const next = nextValue(i, arg);
        if (!next.ok) return { ok: false, message: next.message };
        options.url = next.value;
        i += 1;
        break;
      }
      case "--expected": {
        const next = nextValue(i, arg);
        if (!next.ok) return { ok: false, message: next.message };
        options.expectedFingerprint = next.value;
        i += 1;
        break;
      }
      case "--timeout-ms": {
        const next = nextPositiveNumber(i, arg);
        if (!next.ok) return { ok: false, message: next.message };
        options.timeoutMs = next.value;
        i += 1;
        break;
      }
      case "--interval-ms": {
        const next = nextPositiveNumber(i, arg);
        if (!next.ok) return { ok: false, message: next.message };
        options.intervalMs = next.value;
        i += 1;
        break;
      }
      case "--consecutive": {
        const next = nextPositiveInt(i, arg);
        if (!next.ok) return { ok: false, message: next.message };
        options.requiredConsecutive = next.value;
        i += 1;
        break;
      }
      default:
        return { ok: false, message: `unknown argument: ${arg}` };
    }
  }

  return { ok: true, help: false, options };
}

export async function runVerifyWorkerDeployCli(argv, deps = {}) {
  const poll = deps.pollForFingerprint ?? pollForFingerprint;
  const readFingerprint = deps.readExpectedFingerprint ?? readExpectedFingerprint;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`ERR: ${parsed.message}`);
    printUsage();
    return 1;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const { options } = parsed;
  let expectedFingerprint = options.expectedFingerprint;
  if (!expectedFingerprint) {
    try {
      expectedFingerprint = readFingerprint();
    } catch (error) {
      console.error(
        `ERR: unable to read expected fingerprint: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  console.log(
    `Verifying ${options.url} converges on ${expectedFingerprint} ` +
      `(timeout=${options.timeoutMs}ms interval=${options.intervalMs}ms consecutive=${options.requiredConsecutive})`,
  );

  let result;
  try {
    result = await poll({
      url: options.url,
      expectedFingerprint,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      requiredConsecutive: options.requiredConsecutive,
      onAttempt: ({ attempt, fingerprint, matched, elapsedMs }) => {
        console.log(
          `  attempt ${attempt} @ ${(elapsedMs / 1000).toFixed(1)}s: ` +
            `${fingerprint ?? "no response"}${matched ? " (match)" : ""}`,
        );
      },
    });
  } catch (error) {
    console.error(
      `ERR: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (result.ok) {
    console.log(
      `OK: fingerprint propagated after ${(result.elapsedMs / 1000).toFixed(1)}s ` +
        `(${result.attempts} attempts, ${result.consecutiveMatches} consecutive matches)`,
    );
    return 0;
  }

  console.error(`ERR: ${result.reason}`);
  console.error(
    `ERR: gave up after ${(result.elapsedMs / 1000).toFixed(1)}s and ${result.attempts} attempts`,
  );
  console.error(
    "Hint: Cloudflare Worker deploys can take up to about a minute to fully " +
      "propagate across the edge network even after `wrangler deployments list` " +
      "reports 100%. Re-run this command (or increase --timeout-ms) before " +
      "assuming the bundle is bad or redeploying.",
  );
  return 1;
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  process.exitCode = await runVerifyWorkerDeployCli(process.argv.slice(2));
}
