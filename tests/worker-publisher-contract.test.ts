import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublisherContractContent,
  DEPLOYED_PUBLISHER_FINGERPRINT,
  parsePublisherContractContent,
} from "../worker/src/publisher-contract.ts";
import {
  assertSafePublisherEntryCount,
  ghCommitFiles,
  ghGetFileRaw,
  jsonContentDiffers,
  shouldIgnoreGeneratedAtForPath,
} from "../worker/src/index.ts";
import {
  calculatePublisherFingerprint,
  parseCliArgs,
  runCli as runPublisherContractCli,
} from "../scripts/update-publisher-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(ROOT, "worker", "publisher-contract.json");
const SCRIPT_PATH = join(ROOT, "scripts", "update-publisher-contract.mjs");
const CLI_TEST_TIMEOUT_MS = 30_000;

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCliProcess(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: CLI_TEST_TIMEOUT_MS,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publisher contract runtime guard", () => {
  it("accepts the repository contract embedded in the deployed bundle", () => {
    const content = readFileSync(CONTRACT_PATH, "utf8");
    expect(assertPublisherContractContent(content)).toBe(DEPLOYED_PUBLISHER_FINGERPRINT);
  });

  it("rejects a repository fingerprint that differs from the deployed bundle", () => {
    const contract = parsePublisherContractContent(readFileSync(CONTRACT_PATH, "utf8"));
    const mismatch = JSON.stringify({
      ...contract,
      fingerprint: `sha256:${"f".repeat(64)}`,
    });
    expect(() => assertPublisherContractContent(mismatch)).toThrow(/publisher contract mismatch/);
  });

  it("rejects a repository contract that changes the covered runtime paths", () => {
    const contract = parsePublisherContractContent(readFileSync(CONTRACT_PATH, "utf8"));
    const mismatch = JSON.stringify({
      ...contract,
      criticalPaths: [...contract.criticalPaths, "worker-summarizer/src"],
    });
    expect(() => assertPublisherContractContent(mismatch)).toThrow(/criticalPaths differ/);
  });

  it("fails closed for malformed repository contract JSON", () => {
    expect(() => assertPublisherContractContent("{")).toThrow(/invalid JSON/);
  });

  it("revalidates the marker at the exact parent commit before creating a data tree", async () => {
    const contractContent = readFileSync(CONTRACT_PATH, "utf8");
    const requests: Array<{ url: string; method: string }> = [];
    const responses = [
      { object: { sha: "head-sha" } },
      {
        content: Buffer.from(contractContent, "utf8").toString("base64"),
        sha: "contract-blob",
        encoding: "base64",
      },
      { tree: { sha: "head-tree" } },
      { sha: "next-tree" },
      { sha: "next-commit" },
      {},
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
      });
      const body = responses.shift();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const commitSha = await ghCommitFiles(
      {
        GH_TOKEN: "test-token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_BRANCH: "main",
      },
      "test commit",
      [{ path: "data/index.json", content: "{}\n" }],
      "head-sha",
    );

    expect(commitSha).toBe("next-commit");
    expect(requests[1]).toMatchObject({
      url: expect.stringContaining(
        "/contents/worker/publisher-contract.json?ref=head-sha",
      ),
      method: "GET",
    });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "POST",
      "PATCH",
    ]);
  });

  it("revalidates the exact parent even when there are no data files to commit", async () => {
    const contractContent = readFileSync(CONTRACT_PATH, "utf8");
    const requests: Array<{ url: string; method: string }> = [];
    const responses = [
      { object: { sha: "head-sha" } },
      {
        content: Buffer.from(contractContent, "utf8").toString("base64"),
        sha: "contract-blob",
        encoding: "base64",
      },
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      ghCommitFiles(
        {
          GH_TOKEN: "test-token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "no data changes",
        [],
        "head-sha",
      ),
    ).resolves.toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
  });

  it("treats a collapse guard violation as an aborted publisher run", () => {
    expect(() => assertSafePublisherEntryCount(100, 49)).toThrow(
      /aborting publish/,
    );
    expect(() => assertSafePublisherEntryCount(100, 50)).not.toThrow();
  });

  it("does not create a data tree when the exact parent contract mismatches", async () => {
    const contract = parsePublisherContractContent(readFileSync(CONTRACT_PATH, "utf8"));
    const mismatch = JSON.stringify({
      ...contract,
      fingerprint: `sha256:${"f".repeat(64)}`,
    });
    let requestCount = 0;
    vi.stubGlobal("fetch", async () => {
      requestCount++;
      const body =
        requestCount === 1
          ? { object: { sha: "new-head-sha" } }
          : {
              content: Buffer.from(mismatch, "utf8").toString("base64"),
              sha: "contract-blob",
              encoding: "base64",
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      ghCommitFiles(
        {
          GH_TOKEN: "test-token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "test commit",
        [{ path: "data/index.json", content: "{}\n" }],
        "new-head-sha",
      ),
    ).rejects.toThrow(/publisher contract mismatch/);
    expect(requestCount).toBe(2);
  });

  it("rejects a stale publisher snapshot before creating a data tree", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ object: { sha: "new-head-sha" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      ghCommitFiles(
        {
          GH_TOKEN: "test-token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "test stale commit",
        [{ path: "data/index.json", content: "{}\n" }],
        "captured-head-sha",
      ),
    ).rejects.toThrow(/publisher snapshot changed/);

    expect(requests).toEqual([
      "https://api.github.com/repos/owner/repo/git/ref/heads/main",
    ]);
  });

  it("reads raw data from the captured immutable snapshot", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response('{"count":1}\n', { status: 200 });
    });

    await expect(
      ghGetFileRaw(
        {
          GH_TOKEN: "test-token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "data/index.json",
        "captured-head-sha",
      ),
    ).resolves.toEqual({ content: '{"count":1}\n' });

    expect(requests).toEqual([
      "https://raw.githubusercontent.com/owner/repo/captured-head-sha/data/index.json",
    ]);
  });
});

describe("publisher contract updater", () => {
  it("reports the checked-in fingerprint as current", () => {
    const result = runCliProcess(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Publisher contract: CURRENT");
    expect(result.stdout).toContain("DRY RUN ONLY: no files written");
  }, CLI_TEST_TIMEOUT_MS);

  it("requires an explicit single safe mode without mutating the contract", () => {
    const before = fileHash(CONTRACT_PATH);
    const noArgs = runCliProcess([]);
    const unknown = runCliProcess(["--unknown"]);
    const conflict = runCliProcess(["--dry-run", "--apply"]);
    const help = runCliProcess(["--help"]);

    expect(noArgs.status).not.toBe(0);
    expect(unknown.status).not.toBe(0);
    expect(conflict.status).not.toBe(0);
    expect(help.status).toBe(0);
    expect(fileHash(CONTRACT_PATH)).toBe(before);
  }, CLI_TEST_TIMEOUT_MS);

  it("parses CLI modes fail-closed", () => {
    expect(parseCliArgs(["--dry-run"])).toMatchObject({ ok: true, mode: "dry-run" });
    expect(parseCliArgs(["--apply"])).toMatchObject({ ok: true, mode: "apply" });
    expect(parseCliArgs([])).toMatchObject({ ok: false });
    expect(parseCliArgs(["--apply", "--unknown"])).toMatchObject({ ok: false });
  });

  it("fails closed when a covered directory contains an unsupported file type", () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-contract-"));
    try {
      const covered = join(root, "covered");
      mkdirSync(covered);
      writeFileSync(join(covered, "runtime.ts"), "export const value = 1;\n", "utf8");
      writeFileSync(join(covered, "runtime.txt"), "unsupported\n", "utf8");

      expect(() => calculatePublisherFingerprint(root, ["covered"])).toThrow(
        /does not support covered\/runtime\.txt/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a nonzero dry-run status for a stale contract without mutating it", () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-contract-stale-"));
    try {
      const covered = join(root, "covered");
      const contractPath = join(root, "publisher-contract.json");
      mkdirSync(covered);
      writeFileSync(join(covered, "runtime.ts"), "export const value = 1;\n", "utf8");
      writeFileSync(
        contractPath,
        `${JSON.stringify({
          schemaVersion: 1,
          fingerprint: `sha256:${"0".repeat(64)}`,
          criticalPaths: ["covered"],
        }, null, 2)}\n`,
        "utf8",
      );
      const before = fileHash(contractPath);

      expect(
        runPublisherContractCli(["--dry-run"], { root, contractPath }),
      ).toBe(2);
      expect(fileHash(contractPath)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("metadata coherence comparison", () => {
  const oldJson = '{\n  "generatedAt": "2026-07-12T02:00:00.000Z",\n  "count": 1\n}\n';
  const newJson = '{\n  "generatedAt": "2026-07-12T08:00:00.000Z",\n  "count": 1\n}\n';

  it("ignores timestamp-only changes for monthly archive payloads", () => {
    expect(shouldIgnoreGeneratedAtForPath("data/archive/2026-07.json")).toBe(true);
    expect(jsonContentDiffers(oldJson, newJson)).toBe(false);
  });

  it("treats archive index and stats timestamps as coherence metadata", () => {
    expect(shouldIgnoreGeneratedAtForPath("data/archive/_index.json")).toBe(false);
    expect(shouldIgnoreGeneratedAtForPath("data/stats.json")).toBe(false);
    expect(jsonContentDiffers(oldJson, newJson, { ignoreGeneratedAt: false })).toBe(true);
  });
});
