#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createInfrastructureFailureReport,
  serializeDecisionJourneyReport,
  validateDecisionJourneyReport,
  type DecisionJourneyReport,
} from "./decision-journey.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_TIMEOUT_MS = 20 * 60_000;
const PLAYWRIGHT_TIMEOUT_MS = 6 * 60_000;
const FORCE_KILL_GRACE_MS = 3_000;

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function exactHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

export async function runBoundedCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_GRACE_MS);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveResult({ exitCode, signal, timedOut });
    });
  });
}

function readReport(reportPath: string): DecisionJourneyReport {
  const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
  validateDecisionJourneyReport(parsed);
  return parsed;
}

function writeReport(report: DecisionJourneyReport): void {
  process.stdout.write(serializeDecisionJourneyReport(report));
}

function failureReason(label: string, result: CommandResult): string {
  if (result.timedOut) return `${label} exceeded its bounded timeout`;
  if (result.signal) return `${label} terminated by ${result.signal}`;
  return `${label} exited with code ${result.exitCode ?? "unknown"}`;
}

export function parseDecisionJourneyArgs(args: string[]):
  | { mode: "run"; reuseBuild: boolean }
  | { mode: "help" }
  | { mode: "invalid"; message: string } {
  if (args.length === 0) return { mode: "run", reuseBuild: false };
  if (args.length === 1 && args[0] === "--reuse-build") {
    return { mode: "run", reuseBuild: true };
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { mode: "help" };
  }
  return {
    mode: "invalid",
    message: "use no arguments or --reuse-build",
  };
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/measure-decision-journey.ts",
    "  node --import tsx scripts/measure-decision-journey.ts --reuse-build",
    "",
    "The default command creates one production Web build, reuses it for",
    "Playwright, and writes one bounded JSON report to stdout. Child build and",
    "test logs go to stderr. Timings are informational local synthetic data,",
    "not pass/fail criteria, field data, or Core Web Vitals.",
  ].join("\n");
}

export async function runDecisionJourneyCli(
  args: string[],
): Promise<number> {
  const parsedArgs = parseDecisionJourneyArgs(args);
  if (parsedArgs.mode === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (parsedArgs.mode === "invalid") {
    console.error(`ERR: ${parsedArgs.message}`);
    console.error(usage());
    return 2;
  }

  const commit = exactHead();
  const reportPath = join(
    tmpdir(),
    `tech-dashboard-decision-journey-${process.pid}-${randomUUID()}.json`,
  );

  try {
    if (parsedArgs.reuseBuild) {
      const builtHome = resolve(ROOT, "web", "dist", "index.html");
      if (!existsSync(builtHome)) {
        writeReport(
          createInfrastructureFailureReport(
            commit,
            "harness_build",
            "--reuse-build requires an existing web/dist/index.html",
            { reuseBuild: true, builtHomeExists: false },
          ),
        );
        return 1;
      }
    } else {
      const build = await runBoundedCommand(
        npmCommand(),
        ["run", "build:web"],
        { cwd: ROOT, timeoutMs: BUILD_TIMEOUT_MS },
      );
      if (build.exitCode !== 0) {
        writeReport(
          createInfrastructureFailureReport(
            commit,
            "harness_build",
            failureReason("production Web build", build),
            {
              exitCode: build.exitCode,
              signal: build.signal,
              timedOut: build.timedOut,
            },
          ),
        );
        return 1;
      }
    }

    const playwright = await runBoundedCommand(
      npmCommand(),
      [
        "exec",
        "--",
        "playwright",
        "test",
        "tests/e2e/decision-journey.spec.ts",
        "--reporter=line",
      ],
      {
        cwd: ROOT,
        timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
        env: {
          ...process.env,
          PLAYWRIGHT_REUSE_BUILD: "1",
          DECISION_JOURNEY_OUTPUT: reportPath,
          DECISION_JOURNEY_COMMIT: commit,
        },
      },
    );

    if (!existsSync(reportPath)) {
      writeReport(
        createInfrastructureFailureReport(
          commit,
          "harness_playwright_execution",
          failureReason("Playwright decision journey", playwright),
          {
            exitCode: playwright.exitCode,
            signal: playwright.signal,
            timedOut: playwright.timedOut,
            reportWritten: false,
          },
        ),
      );
      return 1;
    }

    let report: DecisionJourneyReport;
    try {
      report = readReport(reportPath);
    } catch (error) {
      writeReport(
        createInfrastructureFailureReport(
          commit,
          "harness_playwright_execution",
          `Playwright wrote an invalid report: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            exitCode: playwright.exitCode,
            signal: playwright.signal,
            timedOut: playwright.timedOut,
            reportWritten: true,
          },
        ),
      );
      return 1;
    }

    writeReport(report);
    return playwright.exitCode === 0 && report.status === "completed" ? 0 : 1;
  } catch (error) {
    writeReport(
      createInfrastructureFailureReport(
        commit,
        "harness_playwright_execution",
        error instanceof Error ? error.message : String(error),
        { reportWritten: existsSync(reportPath) },
      ),
    );
    return 1;
  } finally {
    if (existsSync(reportPath)) unlinkSync(reportPath);
  }
}

const isDirectInvocation =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
  runDecisionJourneyCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(`ERR: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
