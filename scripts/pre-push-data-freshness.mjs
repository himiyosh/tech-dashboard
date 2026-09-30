import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const REPOSITORY_PINNING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
];
const DOCUMENTATION_PREFIXES = [
  "docs/",
  ".github/agents/",
  ".github/instructions/",
  ".github/knowledge/",
  ".claude/knowledge/",
  ".claude/rules/",
  ".claude/skills/",
];
const POLICY_TOOLING_PATHS = new Set([
  "scripts/git-hooks/pre-push",
  "scripts/pre-push-data-freshness.mjs",
  "tests/data-schema.test.ts",
  "tests/pre-push-data-freshness.test.ts",
]);

function strict(reason) {
  return { eligible: false, reason };
}

function git(root, args, operation) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPOSITORY_PINNING_ENV) delete env[name];
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot verify ${operation}`);
  }
  return result.stdout;
}

function remoteBranchSha(root, ref) {
  const lines = git(root, ["ls-remote", "--heads", "origin", ref], "remote branch")
    .toString("utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return ZERO_SHA;
  if (lines.length !== 1) throw new Error("ambiguous remote branch");
  const [sha, actualRef] = lines[0].split(/\s+/);
  if (!SHA_RE.test(sha) || actualRef !== ref) {
    throw new Error("invalid remote branch");
  }
  return sha;
}

export function isDocumentationOrPolicyPath(path) {
  if (!path || /[\x00-\x1f\x7f\\]/.test(path)
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return false;
  }
  if (POLICY_TOOLING_PATHS.has(path)) return true;
  if (!path.endsWith(".md")) return false;
  return !path.includes("/") || path === ".github/copilot-instructions.md"
    || DOCUMENTATION_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function assessDevelopDocsOnlyPush(root, { remoteName, remoteUrl, input }) {
  if (remoteName !== "origin" || !remoteUrl || typeof input !== "string") {
    return strict("push must target the verified origin remote");
  }
  const lines = input.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) return strict("push must update exactly one working branch");
  const fields = lines[0].trim().split(/\s+/);
  if (fields.length !== 4) return strict("malformed push ref");
  const [localRef, localSha, remoteRef, remoteSha] = fields;
  if (!localRef.startsWith("refs/heads/") || remoteRef !== localRef
    || ["main", "master", "develop"].includes(localRef.slice("refs/heads/".length))
    || !SHA_RE.test(localSha) || !SHA_RE.test(remoteSha) || localSha === ZERO_SHA) {
    return strict("push ref is not a working-branch update");
  }

  try {
    const fetchUrl = git(root, ["remote", "get-url", "origin"], "origin URL").toString("utf8").trim();
    const pushUrl = git(root, ["remote", "get-url", "--push", "origin"], "origin push URL").toString("utf8").trim();
    if (remoteUrl !== fetchUrl || remoteUrl !== pushUrl) {
      return strict("origin fetch and push destinations differ");
    }
    const branch = git(root, ["symbolic-ref", "--quiet", "HEAD"], "working branch").toString("utf8").trim();
    const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "HEAD").toString("utf8").trim();
    if (branch !== localRef || head !== localSha) return strict("pushed commit is not the checked-out branch");
    if (git(root, ["status", "--porcelain=v1", "--untracked-files=no"], "tracked checkout").length) {
      return strict("tracked checkout differs from the pushed commit");
    }
    if (remoteBranchSha(root, remoteRef) !== remoteSha) return strict("working branch changed on origin");
    if (remoteSha !== ZERO_SHA) {
      git(root, ["merge-base", "--is-ancestor", remoteSha, localSha], "working-branch ancestry");
    }
    const developSha = remoteBranchSha(root, "refs/heads/develop");
    const trackingSha = git(root, [
      "rev-parse", "--verify", "refs/remotes/origin/develop^{commit}",
    ], "local develop tracking ref").toString("utf8").trim();
    if (developSha === ZERO_SHA || developSha !== trackingSha || developSha === head) {
      return strict("origin/develop is missing, outdated, or contains the push");
    }
    git(root, ["merge-base", "--is-ancestor", developSha, head], "develop ancestry");

    // The secret scan keeps its push range; freshness uses the full prospective PR diff.
    const changed = git(root, [
      "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", developSha, head, "--",
    ], "develop PR diff");
    if (!changed.length || changed[changed.length - 1] !== 0) {
      return strict("develop PR diff is empty or malformed");
    }
    const paths = changed.toString("utf8").slice(0, -1).split("\0");
    if (paths.some((path) => !isDocumentationOrPolicyPath(path))) {
      return strict("develop PR changes data, application, producer, or unrecognized files");
    }
    const tree = git(root, ["ls-tree", "-r", "-z", head, "--", ...paths], "changed file modes");
    const entries = tree.toString("utf8").split("\0").filter(Boolean);
    if (entries.some((entry) => {
      const [metadata, path] = entry.split("\t");
      return !paths.includes(path) || !/^100(?:644|755) blob [0-9a-f]{40}$/.test(metadata);
    })) {
      return strict("develop PR includes a non-regular documentation or policy file");
    }
    return { eligible: true, baseSha: developSha, paths };
  } catch (error) {
    return strict(error instanceof Error ? error.message : "cannot verify develop PR diff");
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const decision = assessDevelopDocsOnlyPush(ROOT, {
    remoteName: process.argv[2],
    remoteUrl: process.argv[3],
    input: readFileSync(0, "utf8"),
  });
  if (decision.eligible) {
    console.warn("[pre-push] WARN: verified develop docs/rules/policy-only PR; only the local index age check may be relaxed");
  } else {
    console.error(`[pre-push] strict <=36h index freshness: ${decision.reason}`);
    process.exitCode = 1;
  }
}
