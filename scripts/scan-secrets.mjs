#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const MAX_BYTES = 25 * 1024 * 1024;

const exactPatterns = [
  ["private-key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g],
  ["github-fine-grained-token", /\bgithub_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9_]{40,}\b/g],
  ["openai-key", /\bsk-[A-Za-z0-9]{20,}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["pypi-token", /\bpypi-[A-Za-z0-9_-]{40,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["basic-auth-url", /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/g],
  ["azure-storage-connection-string", /\bDefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[A-Za-z0-9+/=]{20,};EndpointSuffix=[^\s"'`,;<>]+/g],
];

const genericPattern = /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|bearer[_-]?token|oauth[_-]?token|refresh[_-]?token|client[_-]?secret|clientSecret|password|passwd|private[_-]?key|secret)\b\s*[:=]\s*["']?([^\s"'`,;<>]{12,})/gi;
const placeholderRe = /^(?:\$|\$\{|process\.env|env\.|import\.meta|undefined|null|true|false|none|changeme|change_me|placeholder|example|sample|dummy|test|your_|<|\{)/i;
const safeExamplePathRe = /(?:^|\/)[^/]*(?:\.example|\.sample|\.template)$/i;
const highRiskPathPatterns = [
  ["env-file", /(^|\/)\.env(?:$|[._-].*)/i],
  ["wrangler-dev-vars", /(^|\/)\.dev\.vars(?:$|[._-].*)/i],
  ["private-key-file", /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$/i],
  ["service-account-file", /(^|\/)(?:.*service-account.*\.json|credentials\.json|client_secret.*\.json)$/i],
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isProbablyText(buffer) {
  return !buffer.includes(0);
}

function addFinding(findings, { scope, blob, path, line, kind, value }) {
  findings.push({
    scope,
    blob: blob?.slice(0, 12),
    path: path || "<unknown>",
    line,
    kind,
    valueHash: digest(value),
    length: value.length,
  });
}

function scanPath({ scope, blob, path, findings }) {
  if (!path || safeExamplePathRe.test(path)) return;
  for (const [kind, pattern] of highRiskPathPatterns) {
    if (pattern.test(path)) {
      addFinding(findings, { scope, blob, path, line: 1, kind, value: path });
    }
  }
}

function lineLookup(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (starts[mid] <= offset) low = mid + 1;
      else high = mid - 1;
    }
    return high + 1;
  };
}

function scanText({ scope, blob, path, text, findings }) {
  const lineOf = lineLookup(text);

  for (const [kind, pattern] of exactPatterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      addFinding(findings, { scope, blob, path, line: lineOf(match.index), kind, value: match[0] });
    }
  }

  genericPattern.lastIndex = 0;
  let match;
  while ((match = genericPattern.exec(text)) !== null) {
    const value = match[1] ?? "";
    if (!value || placeholderRe.test(value)) continue;
    if (/^[A-Z0-9_]+$/.test(value) && value.length < 24) continue;
    addFinding(findings, { scope, blob, path, line: lineOf(match.index), kind: "generic-secret-assignment", value });
  }
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repo })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function stagedFiles() {
  return execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { cwd: repo })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function worktreeFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function ignoredHighRiskPaths() {
  const raw = execFileSync("git", ["status", "--ignored", "--short", "-z"], { cwd: repo })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const warnings = [];
  for (const item of raw) {
    if (!item.startsWith("!! ")) continue;
    const path = item.slice(3);
    if (!path || safeExamplePathRe.test(path)) continue;
    const kinds = highRiskPathPatterns.filter(([, pattern]) => pattern.test(path)).map(([kind]) => kind);
    for (const kind of kinds) warnings.push({ kind, path });
  }
  return warnings;
}

function historyObjects(revArgs) {
  const raw = execFileSync("git", ["rev-list", "--objects", ...revArgs], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
  });
  const seen = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const hash = line.slice(0, 40);
    const path = line.length > 41 ? line.slice(41) : "";
    if (!seen.has(hash)) seen.set(hash, path);
  }
  return [...seen.entries()].map(([blob, path]) => ({ blob, path }));
}

function readGitBlob(blob) {
  const type = execFileSync("git", ["cat-file", "-t", blob], { cwd: repo, encoding: "utf8" }).trim();
  if (type !== "blob") return { skipped: true, type };
  const size = Number(execFileSync("git", ["cat-file", "-s", blob], { cwd: repo, encoding: "utf8" }).trim());
  if (!Number.isFinite(size) || size > MAX_BYTES) return { skipped: true, size };
  const buffer = execFileSync("git", ["cat-file", "blob", blob], { cwd: repo, maxBuffer: MAX_BYTES + 1024 });
  if (!isProbablyText(buffer)) return { skipped: true, size, binary: true };
  return { text: buffer.toString("utf8"), size };
}

function readStagedFile(path) {
  const entry = execFileSync("git", ["ls-files", "-s", "--", path], { cwd: repo, encoding: "utf8" }).trim();
  const blob = entry.split(/\s+/)[1];
  if (!blob) return { skipped: true };
  return readGitBlob(blob);
}

function readWorktreeFile(path) {
  if (!existsSync(path)) return { skipped: true, missing: true };
  const stat = statSync(path);
  if (!stat.isFile()) return { skipped: true, nonFile: true };
  if (stat.size > MAX_BYTES) return { skipped: true, size: stat.size };
  const buffer = readFileSync(path);
  if (!isProbablyText(buffer)) return { skipped: true, size: stat.size, binary: true };
  return { text: buffer.toString("utf8"), size: stat.size };
}

function uniqueFindings(findings) {
  const unique = new Map();
  for (const finding of findings) {
    const key = `${finding.kind}\t${finding.path}\t${finding.line}\t${finding.valueHash}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

function parseMode() {
  if (args.includes("--staged")) return { mode: "staged" };
  if (args.includes("--current")) return { mode: "current" };
  if (args.includes("--worktree")) return { mode: "worktree" };
  if (args.includes("--history")) return { mode: "history", revArgs: ["--all"] };
  const rangeIndex = args.indexOf("--range");
  if (rangeIndex !== -1) {
    const range = args[rangeIndex + 1];
    if (!range) throw new Error("--range requires a revision range");
    return { mode: "range", revArgs: [range] };
  }
  return { mode: "current" };
}

function scan() {
  const { mode, revArgs } = parseMode();
  const findings = [];
  const warnings = [];
  let scanned = 0;
  let skipped = 0;
  let nonBlobObjects = 0;

  if (mode === "staged") {
    for (const path of stagedFiles()) {
      scanPath({ scope: mode, path, findings });
      const result = readStagedFile(path);
      if (result.skipped) {
        skipped++;
        continue;
      }
      scanned++;
      scanText({ scope: mode, path, text: result.text, findings });
    }
  } else if (mode === "current") {
    for (const path of trackedFiles()) {
      scanPath({ scope: mode, path, findings });
      const result = readWorktreeFile(path);
      if (result.skipped) {
        skipped++;
        continue;
      }
      scanned++;
      scanText({ scope: mode, path, text: result.text, findings });
    }
  } else if (mode === "worktree") {
    warnings.push(...ignoredHighRiskPaths());
    for (const path of worktreeFiles()) {
      scanPath({ scope: mode, path, findings });
      const result = readWorktreeFile(path);
      if (result.skipped) {
        skipped++;
        continue;
      }
      scanned++;
      scanText({ scope: mode, path, text: result.text, findings });
    }
  } else {
    for (const { blob, path } of historyObjects(revArgs)) {
      scanPath({ scope: mode, blob, path, findings });
      const result = readGitBlob(blob);
      if (result.skipped) {
        if (result.type && result.type !== "blob") nonBlobObjects++;
        else skipped++;
        continue;
      }
      scanned++;
      scanText({ scope: mode, blob, path, text: result.text, findings });
    }
  }

  return { mode, scanned, skipped, nonBlobObjects, findings: uniqueFindings(findings), warnings };
}

function report(result) {
  if (args.includes("--json")) {
    const byKind = result.findings.reduce((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({ ...result, findingCount: result.findings.length, warningCount: result.warnings.length, byKind }, null, 2));
    return;
  }

  if (result.findings.length === 0) {
    for (const warning of result.warnings.slice(0, 50)) {
      console.warn(`WARN: local ignored high-risk path present ${warning.kind} ${warning.path} (contents not scanned)`);
    }
    console.log(`OK: secret scan PASS (mode=${result.mode}, scanned=${result.scanned}, skipped=${result.skipped})`);
    return;
  }

  console.error(`ERR: secret scan found ${result.findings.length} high-risk item(s) (mode=${result.mode})`);
  for (const finding of result.findings.slice(0, 50)) {
    console.error(`ERR: ${finding.kind} ${finding.path}:${finding.line} hash=${finding.valueHash} len=${finding.length}`);
  }
  console.error("ERR: remove the secret from the index/history or use an approved secret store before retrying.");
}

try {
  const result = scan();
  report(result);
  process.exit(result.findings.length === 0 ? 0 : 3);
} catch (error) {
  console.error(`ERR: secret scan failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
