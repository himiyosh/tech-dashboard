#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INTEGRATION_BRANCH = "develop";
export const PRODUCTION_BRANCH = "main";
const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

export function evaluatePullRequestBranchFlow(baseRef, headRef) {
  if (typeof baseRef !== "string" || !baseRef.trim()) {
    return { ok: false, mode: "invalid", message: "pull request base branch is missing" };
  }
  if (typeof headRef !== "string" || !headRef.trim()) {
    return { ok: false, mode: "invalid", message: "pull request head branch is missing" };
  }

  if (baseRef === INTEGRATION_BRANCH) {
    if (headRef === PRODUCTION_BRANCH) {
      return {
        ok: true,
        mode: "backsync",
        message: `${PRODUCTION_BRANCH} -> ${INTEGRATION_BRANCH} synchronization PR`,
      };
    }
    if (PROTECTED_BRANCHES.has(headRef)) {
      return {
        ok: false,
        mode: "invalid",
        message: `${headRef} cannot target ${INTEGRATION_BRANCH}; use a working branch or ${PRODUCTION_BRANCH} backsync`,
      };
    }
    return {
      ok: true,
      mode: "integration",
      message: `${headRef} -> ${INTEGRATION_BRANCH} integration PR`,
    };
  }

  if (baseRef === PRODUCTION_BRANCH) {
    if (headRef !== INTEGRATION_BRANCH) {
      return {
        ok: false,
        mode: "invalid",
        message: `only ${INTEGRATION_BRANCH} may target ${PRODUCTION_BRANCH}; retarget this PR to ${INTEGRATION_BRANCH}`,
      };
    }
    return {
      ok: true,
      mode: "release",
      message: `${INTEGRATION_BRANCH} -> ${PRODUCTION_BRANCH} release PR`,
    };
  }

  return {
    ok: false,
    mode: "invalid",
    message: `unsupported pull request base ${baseRef}; use ${INTEGRATION_BRANCH} for integration or ${PRODUCTION_BRANCH} for release`,
  };
}

function run(env = process.env) {
  const result = evaluatePullRequestBranchFlow(
    env.PR_BASE_REF,
    env.PR_HEAD_REF,
  );
  if (!result.ok) {
    console.error(`ERR: ${result.message}`);
    return 1;
  }
  console.log(`OK: ${result.message}`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = run();
}
