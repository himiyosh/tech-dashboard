#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HARNESS_MAX_AGE_MINUTES = 150;

const endpoints = {
  harness:
    process.env.HARNESS_HEALTH_URL ??
    "https://tech-dashboard-harness.himiyosh.workers.dev/health",
  summarizer:
    process.env.SUMMARIZER_HEALTH_URL ??
    "https://tech-dashboard-summarizer.himiyosh.workers.dev/health",
};

const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
const harnessMaxAgeMinutes = Number(
  process.env.HARNESS_MAX_AGE_MINUTES ?? DEFAULT_HARNESS_MAX_AGE_MINUTES,
);

async function fetchJson(name, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
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

function validateHarness(body) {
  const errors = [];
  const warnings = [];
  const lastCronAt = typeof body.lastCronAt === "string" ? Date.parse(body.lastCronAt) : Number.NaN;
  const ageMinutes = Number.isFinite(lastCronAt) ? Math.round((Date.now() - lastCronAt) / 60_000) : null;

  requireCondition(errors, body.ok === true, `harness health is not ok: ${body.error ?? "unknown error"}`);
  requireCondition(errors, body.queueMode === "enabled", `summary queue mode is ${body.queueMode ?? "unknown"}`);
  requireCondition(errors, body.copilotOk === true, "harness cannot resolve Copilot token");
  requireCondition(errors, Number.isFinite(lastCronAt), "harness lastCronAt is missing or invalid");
  requireCondition(
    errors,
    ageMinutes !== null && ageMinutes <= harnessMaxAgeMinutes,
    `harness cron is stale: ${ageMinutes ?? "unknown"} minutes old`,
  );
  requireCondition(
    errors,
    Number(body.sourcesAttempted ?? 0) === 0 || Number(body.sourcesOk ?? 0) > 0,
    "harness collected zero healthy sources in the latest batch",
  );

  if (Array.isArray(body.warnings)) warnings.push(...body.warnings);
  if (Number(body.summaryQueueBacklog ?? 0) > 0) {
    warnings.push(`${body.summaryQueueBacklog} summary jobs are still eligible for queueing`);
  }

  return { errors, warnings, ageMinutes };
}

function validateSummarizer(body) {
  const errors = [];
  const warnings = [];

  requireCondition(errors, body.ok === true, `summarizer health is not ok: ${body.issue?.error ?? "unknown error"}`);
  requireCondition(errors, body.cacheBinding === true, "summarizer cache binding is missing");
  requireCondition(errors, body.copilotSecretConfigured === true, "summarizer Copilot secret is missing");

  if (body.recentIssue) {
    const issue = body.issue ?? {};
    const message = `${issue.status ?? "issue"} at ${issue.at ?? "unknown"}: ${issue.error ?? "unknown"}`;
    if (issue.status === "retry") errors.push(`recent summarizer retry: ${message}`);
    else warnings.push(`recent summarizer issue: ${message}`);
  }

  return { errors, warnings };
}

const failures = [];
const warnings = [];

for (const [name, url] of Object.entries(endpoints)) {
  try {
    const { response, body } = await fetchJson(name, url);
    if (!response.ok) {
      failures.push(`${name} endpoint returned HTTP ${response.status}`);
    }
    const result = name === "harness" ? validateHarness(body) : validateSummarizer(body);
    failures.push(...result.errors.map((error) => `${name}: ${error}`));
    warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`));
    console.log(`[${name}] ok=${body.ok} status=${body.status ?? "n/a"} url=${url}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`failure: ${failure}`);
  }
  process.exit(1);
}

console.log("production health check passed");
