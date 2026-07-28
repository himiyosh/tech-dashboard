#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEAD_RE = /^[0-9a-f]{40}$/;
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PULL_REQUEST_STATE_RE = /^[a-z]+$/;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;
const MARKER_RE =
  /^<!-- independent-review head=([0-9a-f]{40}) verdict=(pass|fail) by=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) at=([^ ]+) -->$/;
// Fold only the protocol sentinel for diagnostics; clearance remains fully strict.
const MARKER_ATTEMPT_RE =
  /<!--\s*[iI][nN][dD][eE][pP][eE][nN][dD][eE][nN][tT]-[rR][eE][vV][iI][eE][wW]/;
const DIAGNOSTIC_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireCanonicalHead(value, label) {
  if (typeof value !== "string" || !HEAD_RE.test(value)) {
    throw new Error(`${label} must be exactly 40 lowercase hexadecimal characters`);
  }
  return value;
}

function requireSessionId(value, label) {
  if (typeof value !== "string" || !SESSION_ID_RE.test(value)) {
    throw new Error(`${label} must be a full lowercase session UUID`);
  }
  return value;
}

function requireRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) {
    throw new Error("--repo must use owner/name form");
  }
  return value;
}

function requirePullRequestNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("--pr must be a positive integer");
  }
  return number;
}

function normalizeIndependentReviewGateContext({
  repository,
  pullRequestNumber,
  expectedHead,
  mergerSessionId,
  expectedReviewerSessionId,
}) {
  return {
    repository: requireRepository(repository),
    pullRequestNumber: requirePullRequestNumber(pullRequestNumber),
    expectedHead: requireCanonicalHead(expectedHead, "--head"),
    mergerSessionId: requireSessionId(mergerSessionId, "--merger-session"),
    expectedReviewerSessionId: requireSessionId(
      expectedReviewerSessionId,
      "--reviewer-session",
    ),
  };
}

export function sanitizeIndependentReviewDiagnostic(value) {
  return String(value).replace(DIAGNOSTIC_CONTROL_RE, (character) => {
    const codePoint = character.codePointAt(0);
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  });
}

export function isStrictRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = value.match(RFC3339_RE);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[10]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth && Number.isFinite(Date.parse(value));
}

export function parseIndependentReviewMarker(body) {
  if (typeof body !== "string") return null;
  const markerText = body.trim();
  const match = markerText.match(MARKER_RE);
  if (!match || !isStrictRfc3339(match[4])) return null;
  return {
    head: match[1],
    verdict: match[2],
    by: match[3],
    at: match[4],
  };
}

export function isIndependentReviewMarkerAttempt(body) {
  return typeof body === "string" && MARKER_ATTEMPT_RE.test(body);
}

function normalizeMessages(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be present as an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    if (item.body !== undefined && item.body !== null && typeof item.body !== "string") {
      throw new Error(`${label}[${index}].body must be a string or null`);
    }
    return { body: typeof item.body === "string" ? item.body : "" };
  });
}

export function normalizeIndependentReviewEvidence(
  raw,
  { repository, pullRequestNumber } = {},
) {
  if (!isRecord(raw)) throw new Error("review evidence must be an object");
  const normalizedRepository = requireRepository(raw.repository);
  const normalizedPullRequestNumber = requirePullRequestNumber(raw.pullRequestNumber);
  if (repository !== undefined && normalizedRepository !== repository) {
    throw new Error(
      `review evidence repository is ${normalizedRepository}; expected ${repository}`,
    );
  }
  if (
    pullRequestNumber !== undefined &&
    normalizedPullRequestNumber !== pullRequestNumber
  ) {
    throw new Error(
      `review evidence PR is ${normalizedPullRequestNumber}; expected ${pullRequestNumber}`,
    );
  }
  if (!isRecord(raw.pullRequest)) {
    throw new Error("review evidence pullRequest must be an object");
  }
  const headSha = requireCanonicalHead(
    raw.pullRequest.headSha,
    "review evidence pullRequest.headSha",
  );
  if (
    typeof raw.pullRequest.state !== "string" ||
    !PULL_REQUEST_STATE_RE.test(raw.pullRequest.state)
  ) {
    throw new Error("review evidence pullRequest.state must be a lowercase token");
  }
  return {
    repository: normalizedRepository,
    pullRequestNumber: normalizedPullRequestNumber,
    pullRequest: {
      headSha,
      state: raw.pullRequest.state,
    },
    reviews: normalizeMessages(raw.reviews, "review evidence reviews"),
    comments: normalizeMessages(raw.comments, "review evidence comments"),
  };
}

export function evaluateIndependentReviewGate({
  evidence: rawEvidence,
  repository,
  pullRequestNumber,
  expectedHead,
  mergerSessionId,
  expectedReviewerSessionId,
}) {
  const {
    repository: normalizedRepository,
    pullRequestNumber: normalizedPullRequestNumber,
    expectedHead: normalizedExpectedHead,
    mergerSessionId: normalizedMergerSessionId,
    expectedReviewerSessionId: normalizedReviewerSessionId,
  } = normalizeIndependentReviewGateContext({
    repository,
    pullRequestNumber,
    expectedHead,
    mergerSessionId,
    expectedReviewerSessionId,
  });
  const evidence = normalizeIndependentReviewEvidence(rawEvidence, {
    repository: normalizedRepository,
    pullRequestNumber: normalizedPullRequestNumber,
  });

  const counts = {
    reviewsScanned: evidence.reviews.length,
    commentsScanned: evidence.comments.length,
    parsedMarkers: 0,
    malformedMarkerBodies: 0,
    staleMarkers: 0,
    wrongReviewerMarkers: 0,
    selfIssuedMarkers: 0,
    authoritativePasses: 0,
    authoritativeFails: 0,
  };
  const messages = [
    ...evidence.reviews.map((message) => ({ ...message, source: "review" })),
    ...evidence.comments.map((message) => ({ ...message, source: "comment" })),
  ];

  for (const message of messages) {
    const marker = parseIndependentReviewMarker(message.body);
    if (!marker) {
      if (isIndependentReviewMarkerAttempt(message.body)) {
        counts.malformedMarkerBodies += 1;
      }
      continue;
    }
    counts.parsedMarkers += 1;
    if (marker.head !== normalizedExpectedHead) {
      counts.staleMarkers += 1;
      continue;
    }
    if (marker.by === normalizedMergerSessionId) {
      counts.selfIssuedMarkers += 1;
    }
    if (marker.by !== normalizedReviewerSessionId) {
      counts.wrongReviewerMarkers += 1;
      continue;
    }
    if (marker.verdict === "fail") {
      counts.authoritativeFails += 1;
    } else {
      counts.authoritativePasses += 1;
    }
  }

  const reasons = [];
  if (normalizedMergerSessionId === normalizedReviewerSessionId) {
    reasons.push("merger/coordinator and external reviewer session IDs must differ");
  }
  if (evidence.pullRequest.state !== "open") {
    reasons.push(`pull request state is ${evidence.pullRequest.state}; expected open`);
  }
  if (evidence.pullRequest.headSha !== normalizedExpectedHead) {
    reasons.push(
      `pull request head is ${evidence.pullRequest.headSha}; expected ${normalizedExpectedHead}`,
    );
  }
  if (counts.authoritativeFails > 0) {
    reasons.push(
      `expected reviewer has ${counts.authoritativeFails} exact-head fail marker(s); fail dominates pass until edited or deleted`,
    );
  }
  if (counts.authoritativePasses === 0) {
    reasons.push("no exact-head lowercase pass marker from the expected external reviewer");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    counts,
    repository: normalizedRepository,
    pullRequestNumber: normalizedPullRequestNumber,
    expectedHead: normalizedExpectedHead,
    reviewerSessionId: normalizedReviewerSessionId,
  };
}

export function formatIndependentReviewCountSummary(counts) {
  return `ERR: markers parsed=${counts.parsedMarkers} stale=${counts.staleMarkers} wrongReviewer=${counts.wrongReviewerMarkers} selfIssued=${counts.selfIssuedMarkers} malformed=${counts.malformedMarkerBodies} reviewsScanned=${counts.reviewsScanned} commentsScanned=${counts.commentsScanned}`;
}

function flattenPaginatedPayload(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} API response must be an array`);
  }
  if (value.every((page) => Array.isArray(page))) return value.flat();
  if (value.every((item) => isRecord(item))) return value;
  throw new Error(`${label} API response has an invalid paginated shape`);
}

function defaultRunGhApi(args) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER_BYTES,
  });
  if (result.error) {
    throw new Error(`GitHub CLI request failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const status = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
    throw new Error(`GitHub CLI request failed (${status})`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub CLI returned malformed JSON");
  }
}

export function fetchGitHubIndependentReviewEvidence({
  repository,
  pullRequestNumber,
  runGhApi = defaultRunGhApi,
}) {
  const normalizedRepository = requireRepository(repository);
  const normalizedPullRequestNumber = requirePullRequestNumber(pullRequestNumber);
  const root = `repos/${normalizedRepository}`;
  const pull = runGhApi([`${root}/pulls/${normalizedPullRequestNumber}`]);
  if (!isRecord(pull) || !isRecord(pull.head)) {
    throw new Error("pull request API response is missing head data");
  }
  const reviews = flattenPaginatedPayload(
    runGhApi([
      "--paginate",
      "--slurp",
      `${root}/pulls/${normalizedPullRequestNumber}/reviews?per_page=100`,
    ]),
    "reviews",
  );
  const comments = flattenPaginatedPayload(
    runGhApi([
      "--paginate",
      "--slurp",
      `${root}/issues/${normalizedPullRequestNumber}/comments?per_page=100`,
    ]),
    "comments",
  );
  return normalizeIndependentReviewEvidence(
    {
      repository: normalizedRepository,
      pullRequestNumber: normalizedPullRequestNumber,
      pullRequest: {
        headSha: pull.head.sha,
        state: pull.state,
      },
      reviews,
      comments,
    },
    {
      repository: normalizedRepository,
      pullRequestNumber: normalizedPullRequestNumber,
    },
  );
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/check-independent-review.mjs \\",
      "    --repo <owner/name> --pr <number> --head <40-lowercase-hex> \\",
      "    --merger-session <uuid> --reviewer-session <uuid> [--input <json>]",
      "",
      "Checks the current open PR head, review bodies, and issue comment bodies.",
      "Without --input, evidence is fetched with `gh api`. The optional fixture",
      "must contain repository, pullRequestNumber, pullRequest, reviews, and comments.",
      "",
      "Marker (the complete body, apart from surrounding whitespace):",
      "  <!-- independent-review head=<40 lowercase hex> verdict=pass|fail by=<full lowercase session UUID> at=<RFC3339> -->",
      "",
      "Policy:",
      "  - Only exact-head markers from --reviewer-session are authoritative.",
      "  - Any authoritative exact-head fail blocks, even when pass markers exist.",
      "  - Duplicate passes are accepted; stale, malformed, wrong-reviewer, and",
      "    merger-issued markers never satisfy the gate.",
      "",
      "Options:",
      "  --repo <owner/name>       GitHub repository",
      "  --pr <number>             pull request number",
      "  --head <sha>              expected exact PR head",
      "  --merger-session <uuid>   coordinator/merger session",
      "  --reviewer-session <uuid> expected external reviewer session",
      "  --input <path>            read evidence from JSON instead of GitHub",
      "  --help, -h                show this help",
    ].join("\n"),
  );
}

export function parseIndependentReviewCliArgs(argv) {
  if (argv.length === 0) {
    return { ok: false, exitCode: 2, message: "explicit arguments are required" };
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { ok: true, help: true, options: {} };
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      ok: false,
      exitCode: 2,
      message: "--help cannot be combined with other arguments",
    };
  }

  const options = {};
  const known = new Map([
    ["--repo", "repository"],
    ["--pr", "pullRequestNumber"],
    ["--head", "expectedHead"],
    ["--merger-session", "mergerSessionId"],
    ["--reviewer-session", "expectedReviewerSessionId"],
    ["--input", "inputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = known.get(flag);
    if (!key) {
      return {
        ok: false,
        exitCode: 2,
        message: `unknown argument: ${flag}`,
      };
    }
    if (options[key] !== undefined) {
      return {
        ok: false,
        exitCode: 2,
        message: `duplicate argument: ${flag}`,
      };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        exitCode: 2,
        message: `${flag} requires a value`,
      };
    }
    options[key] = value;
    index += 1;
  }

  for (const [flag, key] of known) {
    if (flag === "--input") continue;
    if (options[key] === undefined) {
      return {
        ok: false,
        exitCode: 2,
        message: `missing required argument: ${flag}`,
      };
    }
  }
  return { ok: true, help: false, options };
}

export async function runIndependentReviewCli(argv, deps = {}) {
  const parsed = parseIndependentReviewCliArgs(argv);
  if (!parsed.ok) {
    console.error(`ERR: ${sanitizeIndependentReviewDiagnostic(parsed.message)}`);
    printUsage();
    return parsed.exitCode;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const {
    repository,
    pullRequestNumber: rawPullRequestNumber,
    expectedHead,
    mergerSessionId,
    expectedReviewerSessionId,
    inputPath,
  } = parsed.options;
  try {
    const gateContext = normalizeIndependentReviewGateContext({
      repository,
      pullRequestNumber: rawPullRequestNumber,
      expectedHead,
      mergerSessionId,
      expectedReviewerSessionId,
    });
    const evidence = inputPath
      ? JSON.parse(readFileSync(resolve(inputPath), "utf8"))
      : (deps.fetchEvidence ?? fetchGitHubIndependentReviewEvidence)({
          repository: gateContext.repository,
          pullRequestNumber: gateContext.pullRequestNumber,
        });
    const result = evaluateIndependentReviewGate({
      evidence,
      ...gateContext,
    });
    if (!result.ok) {
      for (const reason of result.reasons) {
        console.error(`ERR: ${sanitizeIndependentReviewDiagnostic(reason)}`);
      }
      console.error(formatIndependentReviewCountSummary(result.counts));
      console.error(
        `ERR: independent review gate rejected ${gateContext.repository}#${gateContext.pullRequestNumber} at ${gateContext.expectedHead}`,
      );
      return 1;
    }
    console.log(
      `OK: independent review gate passed for ${gateContext.repository}#${gateContext.pullRequestNumber} at ${gateContext.expectedHead}`,
    );
    console.log(
      `OK: reviewer=${gateContext.expectedReviewerSessionId} passes=${result.counts.authoritativePasses} reviews=${result.counts.reviewsScanned} comments=${result.counts.commentsScanned}`,
    );
    return 0;
  } catch (error) {
    console.error(
      `ERR: ${sanitizeIndependentReviewDiagnostic(
        error instanceof Error ? error.message : error,
      )}`,
    );
    return 1;
  }
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  process.exitCode = await runIndependentReviewCli(process.argv.slice(2));
}
