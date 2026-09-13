#!/usr/bin/env node
// Verifies that every model this repo can ask Copilot for still exists on the
// endpoint.
//
// Why: model ids are retired without notice. `claude-sonnet-4.6` disappeared
// while it was still the last fallback of the summarizer chain, so whenever the
// gpt-5.6 models failed the job ran out of options, the summarizer recorded a
// runtime issue, and /health flipped to 503 — Worker Health failed ~2x a day
// from 2026-09-04 while summaries themselves kept flowing through the earlier
// models. Nothing in CI could see it: the id is a plain string.
//
// Usage:
//   node scripts/verify-copilot-models.mjs                 # needs COPILOT_PAT
//   node scripts/verify-copilot-models.mjs --json
// COPILOT_PAT comes from the environment or .env.local. Without it the check
// reports SKIPPED and exits 0, so local runs and CI without the secret are not
// blocked; exit 1 means a configured model is gone.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COPILOT_HEADERS = {
  "editor-version": "vscode/1.96.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "copilot-integration-id": "vscode-chat",
  "user-agent": "GitHubCopilotChat/0.22.0",
};

/** Where a model id can be configured, and how to read it out of that file. */
export const MODEL_SOURCES = [
  { file: "worker-summarizer/wrangler.toml", keys: ["SUMMARIZE_MODEL", "SUMMARIZE_MODEL_FALLBACKS"] },
  { file: "worker-body/wrangler.toml", keys: ["BODY_MODEL", "BODY_MODEL_FALLBACKS"] },
];

/** Model ids assigned to `keys` in a wrangler.toml, comma lists expanded. */
export function modelsFromToml(toml, keys) {
  const found = [];
  for (const key of keys) {
    const match = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
    if (!match) continue;
    for (const value of match[1].split(",")) {
      const model = value.trim();
      if (model && !found.includes(model)) found.push(model);
    }
  }
  return found;
}

/** Configured ids that the endpoint no longer lists. */
export function missingModels(configured, available) {
  const offered = new Set(available);
  return configured.filter((model) => !offered.has(model));
}

function readPat() {
  const fromEnv = process.env.COPILOT_PAT?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(ROOT, ".env.local"), "utf8").match(/^COPILOT_PAT=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function fetchAvailableModels(pat, fetchImpl = fetch) {
  const tokenResponse = await fetchImpl("https://api.github.com/copilot_internal/v2/token", {
    headers: { ...COPILOT_HEADERS, authorization: `token ${pat}` },
  });
  if (!tokenResponse.ok) throw new Error(`copilot token exchange failed with HTTP ${tokenResponse.status}`);
  const { token } = await tokenResponse.json();
  const modelsResponse = await fetchImpl("https://api.githubcopilot.com/models", {
    headers: { ...COPILOT_HEADERS, authorization: `Bearer ${token}` },
  });
  if (!modelsResponse.ok) throw new Error(`copilot models endpoint returned HTTP ${modelsResponse.status}`);
  const body = await modelsResponse.json();
  const rows = body.data ?? body.models ?? [];
  return rows.map((row) => row.id ?? row.name).filter(Boolean);
}

export async function runVerifyCopilotModelsCli(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const readFile = deps.readFile ?? ((file) => readFileSync(join(ROOT, file), "utf8"));
  const asJson = argv.includes("--json");
  const configured = [];
  for (const source of MODEL_SOURCES) {
    let toml;
    try {
      toml = readFile(source.file);
    } catch {
      log(`WARN  ${source.file} is unreadable; skipped`);
      continue;
    }
    for (const model of modelsFromToml(toml, source.keys)) {
      configured.push({ model, file: source.file });
    }
  }
  // `deps.pat: null` must mean "no token", so an injected null is honoured
  // instead of falling through to the real .env.local.
  const pat = deps.pat !== undefined ? deps.pat : readPat();
  if (!pat) {
    log("SKIPPED: COPILOT_PAT is not set, so the live model list cannot be read.");
    return 0;
  }
  let available;
  try {
    available = await (deps.fetchAvailableModels ?? fetchAvailableModels)(pat, deps.fetchImpl);
  } catch (error) {
    log(`ERR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const missing = missingModels([...new Set(configured.map((row) => row.model))], available);
  if (asJson) {
    log(JSON.stringify({ configured, available, missing }, null, 2));
  } else {
    for (const { model, file } of configured) {
      log(`${missing.includes(model) ? "MISSING" : "ok     "} ${model}  (${file})`);
    }
  }
  if (missing.length > 0) {
    log(`ERR: ${missing.length} configured model(s) no longer exist on the endpoint: ${missing.join(", ")}. `
      + "Replace them in the wrangler.toml chains and redeploy the worker, or every fallback past them is wasted.");
    return 1;
  }
  log(`OK: all ${new Set(configured.map((row) => row.model)).size} configured model(s) are offered by the endpoint`);
  return 0;
}

const isDirectInvocation =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  process.exitCode = await runVerifyCopilotModelsCli(process.argv.slice(2));
}
