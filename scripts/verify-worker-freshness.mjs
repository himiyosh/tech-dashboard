#!/usr/bin/env node
// Verifies that every production Cloudflare Worker (the two Queue consumers
// and the Free bridge) has a deployment at least as new as the newest commit
// touching its sources on a git ref (default origin/main).
//
// Why: Cloudflare Pages redeploys the site on every main push, but the
// Workers only change through an explicit `wrangler deploy`. Between
// 2026-08-13 and 2026-09-04 both Queue consumers were left on an old build
// while their sources (article chat, body length plan, GPT-5.6 chain, body
// grounding gates) kept changing on main — the site showed none of it. This
// check turns that silent drift into a release-gate failure.
//
// Usage:
//   node scripts/verify-worker-freshness.mjs                 # all workers vs origin/main
//   node scripts/verify-worker-freshness.mjs --ref main      # another ref
//   node scripts/verify-worker-freshness.mjs --worker tech-dashboard-body
//   node scripts/verify-worker-freshness.mjs --json
// Exit code 1 when any checked worker is STALE or its deployments cannot be
// listed (wrangler auth is required: `npx wrangler whoami`).
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sources per worker. Consumers import shared code from worker/src, harness
 * and web/src/lib, so a commit there counts as a consumer change too
 * (conservative on purpose: redeploying an unchanged bundle is cheap, a stale
 * consumer is not).
 */
export const WORKERS = [
  {
    name: "tech-dashboard-summarizer",
    dir: "worker-summarizer",
    paths: ["worker-summarizer/", "worker/src/", "harness/", "web/src/lib/"],
  },
  {
    name: "tech-dashboard-body",
    dir: "worker-body",
    paths: ["worker-body/", "worker/src/", "harness/", "web/src/lib/"],
  },
  {
    name: "tech-dashboard-harness",
    dir: "worker",
    paths: ["worker/src/", "worker/wrangler.toml", "worker/publisher-contract.json"],
  },
];

/** Newest deployment by created_on; null when the list is empty or unusable. */
export function newestDeployment(deployments) {
  if (!Array.isArray(deployments)) return null;
  let best = null;
  for (const deployment of deployments) {
    const ms = Date.parse(String(deployment?.created_on ?? ""));
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > best.ms) best = { ms, createdOn: String(deployment.created_on), id: String(deployment.id ?? "") };
  }
  return best;
}

/**
 * Pure comparison. `latestCommit` is { sha, committedAt } for the newest
 * commit touching the worker's sources (null when the paths have no history).
 */
export function evaluateFreshness({ worker, deployments, latestCommit }) {
  const deployed = newestDeployment(deployments);
  if (!deployed) {
    return { worker: worker.name, status: "UNKNOWN", reason: "no deployment with a parsable created_on", deployedAt: null, latestCommit };
  }
  if (!latestCommit) {
    return { worker: worker.name, status: "FRESH", reason: "no commits touch the worker sources", deployedAt: deployed.createdOn, latestCommit: null };
  }
  const commitMs = Date.parse(latestCommit.committedAt);
  if (!Number.isFinite(commitMs)) {
    return { worker: worker.name, status: "UNKNOWN", reason: `unparsable commit date ${latestCommit.committedAt}`, deployedAt: deployed.createdOn, latestCommit };
  }
  const stale = commitMs > deployed.ms;
  return {
    worker: worker.name,
    status: stale ? "STALE" : "FRESH",
    reason: stale
      ? `newest source commit ${latestCommit.sha.slice(0, 8)} (${latestCommit.committedAt}) is newer than the deployment (${deployed.createdOn})`
      : `deployment ${deployed.createdOn} covers ${latestCommit.sha.slice(0, 8)} (${latestCommit.committedAt})`,
    deployedAt: deployed.createdOn,
    latestCommit,
  };
}

function latestCommitTouching(ref, paths, cwd) {
  const out = execFileSync("git", ["log", "-1", "--format=%H %cI", ref, "--", ...paths], { cwd, encoding: "utf8" }).trim();
  if (!out) return null;
  const [sha, committedAt] = out.split(" ");
  return { sha, committedAt };
}

function listDeployments(dir, cwd) {
  const out = execFileSync("npx", ["wrangler", "deployments", "list", "--json"], {
    cwd: resolve(cwd, dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`wrangler returned no JSON array for ${dir}`);
  return JSON.parse(out.slice(start));
}

function parseArgs(argv) {
  const opts = { ref: "origin/main", workers: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref" && argv[i + 1]) opts.ref = argv[++i];
    else if (arg === "--worker" && argv[i + 1]) opts.workers.push(argv[++i]);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export async function runVerifyWorkerFreshnessCli(argv, deps = {}) {
  const cwd = deps.cwd ?? ROOT;
  const log = deps.log ?? ((line) => console.log(line));
  const opts = parseArgs(argv);
  if (opts.help) {
    log("Usage: node scripts/verify-worker-freshness.mjs [--ref origin/main] [--worker name]... [--json]");
    return 0;
  }
  const selected = opts.workers.length > 0 ? WORKERS.filter((w) => opts.workers.includes(w.name)) : WORKERS;
  if (selected.length === 0) throw new Error(`no worker matches ${opts.workers.join(", ")}`);
  const results = [];
  for (const worker of selected) {
    let deployments;
    try {
      deployments = (deps.listDeployments ?? listDeployments)(worker.dir, cwd);
    } catch (error) {
      results.push({ worker: worker.name, status: "UNKNOWN", reason: `cannot list deployments: ${error instanceof Error ? error.message : String(error)}`, deployedAt: null, latestCommit: null });
      continue;
    }
    const latestCommit = (deps.latestCommitTouching ?? latestCommitTouching)(opts.ref, worker.paths, cwd);
    results.push(evaluateFreshness({ worker, deployments, latestCommit }));
  }
  if (opts.json) {
    log(JSON.stringify({ ref: opts.ref, results }, null, 2));
  } else {
    for (const r of results) log(`${r.status.padEnd(7)} ${r.worker}: ${r.reason}`);
  }
  const failed = results.filter((r) => r.status !== "FRESH");
  if (failed.length > 0) {
    log(`ERR: ${failed.length} worker(s) not verified fresh against ${opts.ref} — deploy them (consumers first, bridge last) before relying on ${opts.ref}.`);
    return 1;
  }
  log(`OK: ${results.length} worker(s) deployed at or after their newest source commit on ${opts.ref}`);
  return 0;
}

const isDirectInvocation =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  process.exitCode = await runVerifyWorkerFreshnessCli(process.argv.slice(2));
}
