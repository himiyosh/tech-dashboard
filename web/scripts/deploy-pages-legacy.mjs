import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(WEB_DIR, "..");
const WINDOWS_SAFE_TOKEN_RE = /^[A-Za-z0-9_@./:=+-]+$/;

function runGit(args) {
  return execFileSync("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
  }).trim();
}

export function readDeploySnapshot() {
  runGit(["fetch", "--quiet", "origin", "main"]);
  return {
    branch: runGit(["branch", "--show-current"]),
    status: runGit(["status", "--porcelain", "--untracked-files=all"]),
    head: runGit(["rev-parse", "HEAD"]),
    remoteHead: runGit(["rev-parse", "origin/main"]),
    commitMessage: runGit(["log", "-1", "--format=%s"]),
  };
}

export function assertDeploySnapshot(snapshot, label, expectedHead = null) {
  if (snapshot.branch !== "main") {
    throw new Error(`${label}: legacy Pages deploy requires branch main`);
  }
  if (snapshot.status) {
    throw new Error(`${label}: legacy Pages deploy requires a clean worktree`);
  }
  if (
    expectedHead &&
    (
      snapshot.head !== expectedHead ||
      snapshot.remoteHead !== expectedHead
    )
  ) {
    throw new Error(
      `${label}: origin/main advanced during legacy deploy (${expectedHead} -> ${snapshot.remoteHead})`,
    );
  }
  if (snapshot.head !== snapshot.remoteHead) {
    throw new Error(
      `${label}: local HEAD does not match origin/main (${snapshot.head} != ${snapshot.remoteHead})`,
    );
  }
  return snapshot.head;
}

export function commandInvocation(
  command,
  args,
  platform = process.platform,
  comSpec = process.env.ComSpec,
) {
  if (platform !== "win32") {
    return { executable: command, args, shell: false };
  }

  const safeArgs = args.filter(
    (arg) => !arg.startsWith("--commit-message="),
  );
  const tokens = [command, ...safeArgs];
  if (tokens.some((token) => !WINDOWS_SAFE_TOKEN_RE.test(token))) {
    throw new Error("Windows legacy deploy command contains an unsafe token");
  }
  return {
    executable: comSpec || "cmd.exe",
    args: ["/d", "/s", "/c", tokens.join(" ")],
    shell: false,
  };
}

function runCheckedCommand(command, args, cwd) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd,
    stdio: "inherit",
    shell: invocation.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

export async function runLegacyPagesDeploy(dependencies = {}) {
  const readSnapshot = dependencies.readSnapshot ?? readDeploySnapshot;
  const runCommand = dependencies.runCommand ?? runCheckedCommand;

  const before = await readSnapshot();
  const expectedHead = assertDeploySnapshot(before, "before build");

  await runCommand("npm", ["run", "build"], WEB_DIR);

  const afterBuild = await readSnapshot();
  assertDeploySnapshot(afterBuild, "after build", expectedHead);

  await runCommand(
    "npx",
    [
      "--yes",
      "wrangler@4.85.0",
      "pages",
      "deploy",
      "dist",
      "--project-name",
      "tech-dashboard",
      "--branch",
      "main",
      `--commit-hash=${expectedHead}`,
      `--commit-message=${before.commitMessage}`,
      "--commit-dirty=false",
    ],
    WEB_DIR,
  );

  const afterDeploy = await readSnapshot();
  assertDeploySnapshot(afterDeploy, "after deploy", expectedHead);
  console.log(`OK: deployed origin/main ${expectedHead}`);
}

const isDirect =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  runLegacyPagesDeploy().catch((error) => {
    console.error(`ERR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
