#!/usr/bin/env node

// Recurring, immediate, fail-closed production health check (R-027). This
// script intentionally does NOT retry or wait out Cloudflare's edge
// propagation delay: `validateBridge()` below must report a mismatch as soon
// as it sees one, because it runs on a schedule long after any deploy has
// had time to settle (worker-health.yml). For the short window right after
// an explicit `wrangler deploy`, where the propagation delay is expected and
// should not be mistaken for a bad bundle, use the separate bounded-polling
// tool instead: `scripts/verify-worker-deploy.mjs` (LL-407).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PUBLISHER_MAX_AGE_MINUTES = 180;
const DEFAULT_DATA_WARN_AGE_MINUTES = 360;
const DEFAULT_DATA_MAX_AGE_MINUTES = 24 * 60;
const PUBLISHER_APPLY_RUN_TITLE = "Publisher / publish";
const JSON_FEED_MEDIA_TYPE = "application/feed+json";
const JSON_FEED_VERSION = "https://jsonfeed.org/version/1.1";
const JSON_FEED_URL = "https://techdb.studio344.net/feed.json";
const EXPECTED_PUBLISHER_FINGERPRINT = JSON.parse(
  readFileSync(
    new URL("../worker/publisher-contract.json", import.meta.url),
    "utf8",
  ),
).fingerprint;

const endpoints = {
  bridge:
    process.env.HARNESS_HEALTH_URL ??
    "https://tech-dashboard-harness.himiyosh.workers.dev/health",
  summarizer:
    process.env.SUMMARIZER_HEALTH_URL ??
    "https://tech-dashboard-summarizer.himiyosh.workers.dev/health",
  publisherRuns:
    process.env.PUBLISHER_RUNS_URL ??
    "https://api.github.com/repos/himiyosh/tech-dashboard/actions/workflows/publisher.yml/runs?branch=main&per_page=10",
  index:
    process.env.PUBLISHER_INDEX_URL ??
    "https://raw.githubusercontent.com/himiyosh/tech-dashboard/main/data/index.json",
  jsonFeed: process.env.PUBLIC_JSON_FEED_URL ?? JSON_FEED_URL,
};

const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
const publisherMaxAgeMinutes = Number(
  process.env.PUBLISHER_MAX_AGE_MINUTES ??
    DEFAULT_PUBLISHER_MAX_AGE_MINUTES,
);
const dataWarnAgeMinutes = Number(
  process.env.PUBLISHER_DATA_WARN_AGE_MINUTES ??
    DEFAULT_DATA_WARN_AGE_MINUTES,
);
const dataMaxAgeMinutes = Number(
  process.env.PUBLISHER_DATA_MAX_AGE_MINUTES ??
    DEFAULT_DATA_MAX_AGE_MINUTES,
);

async function fetchJson(name, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers({
      accept: options.accept ?? "application/json",
    });
    if (options.githubToken) {
      headers.set("authorization", `Bearer ${options.githubToken}`);
      headers.set("x-github-api-version", "2022-11-28");
    }
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${name} returned non-JSON response: ${text.slice(0, 200)}`);
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function requireCondition(errors, condition, message) {
  if (!condition) errors.push(message);
}

function isPublishingRun(run) {
  if (!run || run.head_branch !== "main") return false;
  if (run.event === "schedule") return true;
  return (
    run.event === "workflow_dispatch" &&
    run.display_title === PUBLISHER_APPLY_RUN_TITLE
  );
}

export function validateBridge(body) {
  const errors = [];
  requireCondition(errors, body.ok === true, "bridge health is not ok");
  requireCondition(errors, body.status === "bridge", "harness endpoint is not the Free-plan bridge");
  requireCondition(
    errors,
    body.mode === "github-actions-publisher",
    `bridge mode is ${body.mode ?? "unknown"}`,
  );
  requireCondition(errors, body.scheduled === false, "bridge still exposes scheduled execution");
  requireCondition(
    errors,
    body.publisherContractFingerprint === EXPECTED_PUBLISHER_FINGERPRINT,
    `bridge publisher fingerprint is ${body.publisherContractFingerprint ?? "missing"}; expected ${EXPECTED_PUBLISHER_FINGERPRINT}`,
  );
  return { errors, warnings: [] };
}

export function validatePublisherRuns(body, nowMs = Date.now()) {
  const errors = [];
  const warnings = [];
  const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  const completed = runs.find(
    (run) =>
      isPublishingRun(run) &&
      run.status === "completed",
  );
  requireCondition(errors, Boolean(completed), "publisher has no completed main run");
  if (!completed) return { errors, warnings, ageMinutes: null };

  requireCondition(
    errors,
    completed.conclusion === "success",
    `latest completed publisher run concluded ${completed.conclusion ?? "unknown"}`,
  );
  const completedAt =
    typeof completed.updated_at === "string"
      ? Date.parse(completed.updated_at)
      : Number.NaN;
  const ageMinutes = Number.isFinite(completedAt)
    ? Math.round((nowMs - completedAt) / 60_000)
    : null;
  requireCondition(errors, ageMinutes !== null, "publisher completion time is invalid");
  requireCondition(
    errors,
    ageMinutes !== null && ageMinutes <= publisherMaxAgeMinutes,
    `publisher run is stale: ${ageMinutes ?? "unknown"} minutes old`,
  );
  const running = runs.find(
    (run) =>
      isPublishingRun(run) &&
      (run.status === "queued" || run.status === "in_progress"),
  );
  if (running) warnings.push(`publisher run ${running.id ?? "unknown"} is ${running.status}`);
  return { errors, warnings, ageMinutes };
}

export function validateIndexFreshness(body, nowMs = Date.now()) {
  const errors = [];
  const warnings = [];
  const generatedAt =
    typeof body.generatedAt === "string"
      ? Date.parse(body.generatedAt)
      : Number.NaN;
  const ageMinutes = Number.isFinite(generatedAt)
    ? Math.round((nowMs - generatedAt) / 60_000)
    : null;
  requireCondition(errors, ageMinutes !== null, "data/index.json generatedAt is invalid");
  requireCondition(
    errors,
    ageMinutes !== null && ageMinutes <= dataMaxAgeMinutes,
    `data/index.json is stale: ${ageMinutes ?? "unknown"} minutes old`,
  );
  if (
    ageMinutes !== null &&
    ageMinutes > dataWarnAgeMinutes &&
    ageMinutes <= dataMaxAgeMinutes
  ) {
    warnings.push(`data/index.json has not changed for ${ageMinutes} minutes`);
  }
  requireCondition(
    errors,
    Number.isInteger(body.count) &&
      Array.isArray(body.entries) &&
      body.count === body.entries.length,
    "data/index.json count does not match entries",
  );
  const health = body?.health;
  const healthValid =
    health &&
    typeof health === "object" &&
    !Array.isArray(health) &&
    typeof health.lastRunAt === "string" &&
    Number.isFinite(Date.parse(health.lastRunAt)) &&
    typeof health.copilotOk === "boolean" &&
    Number.isInteger(health.sourcesAttempted) &&
    health.sourcesAttempted >= 0 &&
    Number.isInteger(health.sourcesOk) &&
    health.sourcesOk >= 0 &&
    health.sourcesOk <= health.sourcesAttempted &&
    Array.isArray(health.sourcesFailed) &&
    health.sourcesFailed.every(
      (source) => typeof source === "string" && source.length > 0,
    );
  requireCondition(
    errors,
    healthValid,
    "data/index.json health telemetry is missing or invalid",
  );
  if (healthValid) {
    requireCondition(
      errors,
      health.sourcesAttempted > 0,
      "data/index.json health reports no attempted sources",
    );
    requireCondition(
      errors,
      health.sourcesAttempted === 0 || health.sourcesOk > 0,
      `data/index.json health reports all ${health.sourcesAttempted} sources failed`,
    );
  }
  return { errors, warnings, ageMinutes };
}

export function validateSummarizer(body) {
  const errors = [];
  const warnings = [];
  requireCondition(
    errors,
    body.ok === true,
    `summarizer health is not ok: ${body.issue?.error ?? "unknown error"}`,
  );
  requireCondition(errors, body.cacheBinding === true, "summarizer cache binding is missing");
  requireCondition(
    errors,
    body.copilotSecretConfigured === true,
    "summarizer Copilot secret is missing",
  );
  if (body.recentIssue) {
    const issue = body.issue ?? {};
    const message = `${issue.status ?? "issue"} at ${issue.at ?? "unknown"}: ${issue.error ?? "unknown"}`;
    if (body.issueSeverity === "error") errors.push(`repeated summarizer retry: ${message}`);
    else warnings.push(`recent summarizer issue: ${message}`);
  }
  return { errors, warnings };
}

export function validateJsonFeed(body, response) {
  const errors = [];
  const contentType = response?.headers?.get?.("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const items = Array.isArray(body?.items) ? body.items : [];

  requireCondition(
    errors,
    mediaType === JSON_FEED_MEDIA_TYPE,
    `content type is ${contentType || "missing"}; expected ${JSON_FEED_MEDIA_TYPE}`,
  );
  requireCondition(
    errors,
    body?.version === JSON_FEED_VERSION,
    `version is ${body?.version ?? "missing"}; expected ${JSON_FEED_VERSION}`,
  );
  requireCondition(
    errors,
    body?.feed_url === JSON_FEED_URL,
    `feed_url is ${body?.feed_url ?? "missing"}; expected ${JSON_FEED_URL}`,
  );
  requireCondition(
    errors,
    items.length > 0 && items.length <= 100,
    `item count is ${items.length}; expected 1-100`,
  );
  requireCondition(
    errors,
    items.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.url === "string" &&
        item.url.length > 0 &&
        typeof item.title === "string" &&
        item.title.trim().length > 0 &&
        typeof item.content_text === "string" &&
        item.content_text.trim().length > 0,
    ),
    "items contain missing id, URL, title, or summary",
  );
  return { errors, warnings: [] };
}

export async function runProductionHealthCheck() {
  const failures = [];
  const warnings = [];
  const checks = [
    ["bridge", endpoints.bridge, (body) => validateBridge(body), {}],
    [
      "publisher",
      endpoints.publisherRuns,
      (body) => validatePublisherRuns(body),
      { githubToken: process.env.GITHUB_TOKEN },
    ],
    ["index", endpoints.index, (body) => validateIndexFreshness(body), {}],
    ["summarizer", endpoints.summarizer, (body) => validateSummarizer(body), {}],
    [
      "json-feed",
      endpoints.jsonFeed,
      validateJsonFeed,
      { accept: JSON_FEED_MEDIA_TYPE },
    ],
  ];

  for (const [name, url, validate, options] of checks) {
    try {
      const { response, body } = await fetchJson(name, url, options);
      if (!response.ok) failures.push(`${name} endpoint returned HTTP ${response.status}`);
      const result = validate(body, response);
      failures.push(...result.errors.map((error) => `${name}: ${error}`));
      warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`));
      console.log(`[${name}] http=${response.status} url=${url}`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`failure: ${failure}`);
    return 1;
  }
  console.log("production health check passed");
  return 0;
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  process.exitCode = await runProductionHealthCheck();
}
