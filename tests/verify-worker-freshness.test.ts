import { describe, expect, it } from "vitest";
import {
  WORKERS,
  evaluateFreshness,
  newestDeployment,
  runVerifyWorkerFreshnessCli,
} from "../scripts/verify-worker-freshness.mjs";

// Regression guard for the 2026-08-13 → 09-04 drift: both Queue consumers
// stayed on an old build while their sources changed on main, so article
// chats and the longer body plan never reached production.

const body = WORKERS.find((w) => w.name === "tech-dashboard-body")!;

describe("newestDeployment", () => {
  it("picks the newest parsable created_on regardless of list order", () => {
    const newest = newestDeployment([
      { id: "old", created_on: "2026-08-13T10:56:22.294Z" },
      { id: "new", created_on: "2026-09-04T22:37:19.015Z" },
      { id: "bad", created_on: "not-a-date" },
    ]);
    expect(newest?.id).toBe("new");
    expect(newestDeployment([])).toBeNull();
    expect(newestDeployment(undefined)).toBeNull();
  });
});

describe("evaluateFreshness", () => {
  const deployments = [{ id: "d1", created_on: "2026-08-13T10:56:22.294Z" }];

  it("flags a deployment older than the newest source commit as STALE", () => {
    const result = evaluateFreshness({
      worker: body,
      deployments,
      latestCommit: { sha: "268d3b4c0000", committedAt: "2026-08-29T00:51:05+09:00" },
    });
    expect(result.status).toBe("STALE");
    expect(result.reason).toContain("268d3b4c");
  });

  it("accepts a deployment at or after the newest source commit", () => {
    const fresh = evaluateFreshness({
      worker: body,
      deployments: [{ id: "d2", created_on: "2026-09-04T22:37:19.015Z" }],
      latestCommit: { sha: "abcdef120000", committedAt: "2026-09-04T21:06:00Z" },
    });
    expect(fresh.status).toBe("FRESH");
    const noHistory = evaluateFreshness({ worker: body, deployments, latestCommit: null });
    expect(noHistory.status).toBe("FRESH");
  });

  it("reports UNKNOWN instead of guessing when dates cannot be read", () => {
    expect(evaluateFreshness({ worker: body, deployments: [], latestCommit: { sha: "x", committedAt: "2026-09-01T00:00:00Z" } }).status).toBe("UNKNOWN");
    expect(evaluateFreshness({ worker: body, deployments, latestCommit: { sha: "x", committedAt: "garbage" } }).status).toBe("UNKNOWN");
  });
});

describe("runVerifyWorkerFreshnessCli", () => {
  it("exits 1 and names the stale worker; exits 0 when every worker is fresh", async () => {
    const lines: string[] = [];
    const deps = {
      cwd: "/repo",
      log: (line: string) => lines.push(line),
      listDeployments: (dir: string) => [
        { id: dir, created_on: dir === "worker-body" ? "2026-08-13T10:56:22Z" : "2026-09-04T22:37:19Z" },
      ],
      latestCommitTouching: () => ({ sha: "0123456789ab", committedAt: "2026-09-03T00:00:00Z" }),
    };
    const code = await runVerifyWorkerFreshnessCli(["--ref", "origin/main"], deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("STALE") && l.includes("tech-dashboard-body"))).toBe(true);
    expect(lines.some((l) => l.startsWith("FRESH") && l.includes("tech-dashboard-harness"))).toBe(true);

    lines.length = 0;
    const ok = await runVerifyWorkerFreshnessCli(["--worker", "tech-dashboard-harness"], deps);
    expect(ok).toBe(0);
    expect(lines.at(-1)).toMatch(/^OK: 1 worker/);

    lines.length = 0;
    const listingFails = await runVerifyWorkerFreshnessCli(["--worker", "tech-dashboard-summarizer"], {
      ...deps,
      listDeployments: () => {
        throw new Error("not authenticated");
      },
    });
    expect(listingFails).toBe(1);
    expect(lines.some((l) => l.startsWith("UNKNOWN") && l.includes("not authenticated"))).toBe(true);
  });
});
