import {
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalCommitSink,
  GithubActionsOidcProvider,
  parsePublisherArgs,
  runPublisherCli,
  verifyBridgePublisherContract,
} from "../scripts/run-publisher.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";
import type { PublisherEnv } from "../worker/src/index.ts";

function impactPlan() {
  return {
    version: 2 as const,
    baseRef: "captured-sha",
    changedDataPaths: ["data/index.json"],
    changedEntryIds: ["entry-1"],
    changedBodyIds: [],
    changedArchiveMonths: [],
    affectedCategories: ["copilot"],
    affectedTags: ["agent"],
    routeFamilies: ["detail-pages", "home"],
    requiresFullStaticReconciliation: true,
    fullReconciliationReasons: [
      "index-health-and-snapshot-are-imported-by-the-static-shell",
    ],
    before: { detailRoutes: 10, tagBaseRoutes: 2, archiveMonths: 1 },
    after: { detailRoutes: 11, tagBaseRoutes: 2, archiveMonths: 1 },
    growth: { detailRoutes: 1, tagBaseRoutes: 0, archiveMonths: 0 },
    incremental: {
      detailMode: "global" as const,
      detailUpsertIds: ["entry-1"],
      detailTombstoneIds: [],
      detailPaths: ["/e/entry-1/"],
      searchMode: "global" as const,
      searchDeltaIds: [],
      shadowSafe: false,
      blockers: ["pagefind-requires-global-reconciliation"],
    },
  };
}

describe("GitHub Actions publisher runner", () => {
  it("requires one explicit fail-closed mode", () => {
    expect(parsePublisherArgs([])).toEqual({
      ok: false,
      message:
        "use exactly one of --apply, --dry-run, --check, --preflight, or --flush <effects-file>",
    });
    expect(parsePublisherArgs(["--apply", "--dry-run"]).ok).toBe(false);
    expect(parsePublisherArgs(["--unknown"]).ok).toBe(false);
    expect(parsePublisherArgs(["--flush"]).ok).toBe(false);
    expect(parsePublisherArgs(["--apply"])).toEqual({
      ok: true,
      mode: "apply",
    });
    expect(parsePublisherArgs(["--preflight"])).toEqual({
      ok: true,
      mode: "preflight",
    });
    expect(parsePublisherArgs(["--flush", "/tmp/effects.json"])).toEqual({
      ok: true,
      mode: "flush",
      effectsPath: "/tmp/effects.json",
    });
  });

  it("fails bridge preflight on a stale deployed fingerprint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        status: "bridge",
        publisherContractFingerprint: "sha256:stale",
      }),
    );
    await expect(
      verifyBridgePublisherContract(
        "https://bridge.example/",
        DEPLOYED_PUBLISHER_FINGERPRINT,
        fetchMock,
      ),
    ).rejects.toThrow(/bridge fingerprint mismatch/);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example/health",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
  });

  it("runs standalone bridge preflight without invoking the harness", async () => {
    const verifyBridgeContract = vi.fn(async () => undefined);
    const harness = vi.fn(async () => ({ changed: false, stats: {} }));

    await expect(
      runPublisherCli(
        ["--preflight"],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          PUBLISHER_BRIDGE_URL: "https://bridge.example",
        },
        { runHarness: harness, verifyBridgeContract },
      ),
    ).resolves.toBe(0);
    expect(verifyBridgeContract).toHaveBeenCalledWith(
      "https://bridge.example",
    );
    expect(harness).not.toHaveBeenCalled();
  });

  it("does not run the harness when bridge preflight fails", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    const harness = vi.fn(async () => ({ changed: false, stats: {} }));
    const verifyBridgeContract = vi.fn(async () => {
      throw new Error("publisher bridge fingerprint mismatch");
    });

    await expect(
      runPublisherCli(
        ["--apply"],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          GITHUB_TOKEN: "test-token",
          RUNNER_TEMP: runnerTemp,
        },
        { runHarness: harness, verifyBridgeContract },
      ),
    ).rejects.toThrow(/bridge fingerprint mismatch/);
    expect(harness).not.toHaveBeenCalled();
  });

  it("refuses an effects bundle outside the Actions runner temp directory", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    const outside = join(tmpdir(), `publisher-effects-outside-${Date.now()}.json`);
    writeFileSync(outside, "{}\n", "utf8");
    try {
      await expect(
        runPublisherCli(["--flush", outside], {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          RUNNER_TEMP: runnerTemp,
        }),
      ).rejects.toThrow(/inside RUNNER_TEMP/);
      expect(existsSync(outside)).toBe(true);
    } finally {
      unlinkSync(outside);
    }
  });

  it("does not persist deferred effects when the harness aborts", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    const effectsPath = join(
      runnerTemp,
      "tech-dashboard-publisher-effects.json",
    );
    const abortingHarness = vi.fn(async (publisherEnv: PublisherEnv) => {
      await publisherEnv.SUMMARY_QUEUE?.sendBatch([
        { body: {} as never },
      ]);
      throw new Error("aborting publish: collapse guard");
    });

    await expect(
      runPublisherCli(
        ["--apply"],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          GITHUB_TOKEN: "test-token",
          RUNNER_TEMP: runnerTemp,
        },
        {
          runHarness: abortingHarness,
          verifyBridgeContract: async () => undefined,
        },
      ),
    ).rejects.toThrow(/collapse guard/);
    expect(existsSync(effectsPath)).toBe(false);
  });

  it("passes one shared enrichment allowance to the Publisher runtime", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    let capturedEnv: PublisherEnv | undefined;
    const inspectingHarness = vi.fn(async (publisherEnv: PublisherEnv) => {
      capturedEnv = publisherEnv;
      return { changed: false, stats: {} };
    });

    await expect(
      runPublisherCli(
        ["--dry-run"],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          GITHUB_TOKEN: "test-token",
          RUNNER_TEMP: runnerTemp,
        },
        {
          runHarness: inspectingHarness,
          verifyBridgeContract: async () => undefined,
        },
      ),
    ).resolves.toBe(0);

    expect(capturedEnv).toMatchObject({
      ENQUEUE_MAX_NEW: "35",
      ENRICHMENT_ENQUEUE_MAX_TOTAL: "35",
      BODY_ENQUEUE_MAX_NEW: "35",
      BODY_LOOKUP_CAP: "35",
    });
  });

  it("keeps heartbeat telemetry out of deferred KV effects", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    const effectsPath = join(
      runnerTemp,
      "tech-dashboard-publisher-effects.json",
    );
    const inspectingHarness = vi.fn(async (publisherEnv: PublisherEnv) => {
      await publisherEnv.SUMMARY_CACHE.put("heartbeat.v1", '{"status":"published"}');
      await publisherEnv.SUMMARY_CACHE.put("og.v1", '{"version":1}');
      return { changed: false, stats: {} };
    });

    await expect(
      runPublisherCli(
        ["--apply"],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          GITHUB_TOKEN: "test-token",
          RUNNER_TEMP: runnerTemp,
        },
        {
          runHarness: inspectingHarness,
          verifyBridgeContract: async () => undefined,
        },
      ),
    ).resolves.toBe(0);

    expect(existsSync(effectsPath)).toBe(true);
    expect(JSON.parse(readFileSync(effectsPath, "utf8"))).toMatchObject({
      kvPuts: [{ key: "og.v1", value: '{"version":1}' }],
    });
  });

  it("flushes an allowlisted deferred effect with a bounded request body", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    const effectsPath = join(runnerTemp, "effects.json");
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = [
      Buffer.from('{"alg":"none"}').toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      "signature",
    ].join(".");
    writeFileSync(
      effectsPath,
      JSON.stringify({
        version: 1,
        publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        kvPuts: [{ key: "og.v1", value: "{}" }],
        queueSends: [],
      }),
      "utf8",
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("https://actions.example/")
        ? Response.json({ value: token })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        runPublisherCli(
          ["--flush", effectsPath],
          {
            GITHUB_ACTIONS: "true",
            GITHUB_REF: "refs/heads/main",
            GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
            RUNNER_TEMP: runnerTemp,
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
            PUBLISHER_BRIDGE_URL: "https://bridge.example",
          },
          { verifyBridgeContract: async () => undefined },
        ),
      ).resolves.toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(existsSync(effectsPath)).toBe(false);
    const bridgeCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("https://bridge.example/"),
    );
    expect(bridgeCall).toBeDefined();
    const headers = new Headers(bridgeCall?.[1]?.headers);
    expect(headers.get("content-length")).toBe("2");
  });

  it("preserves deferred effects when flush preflight rejects the bridge", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "publisher-effects-"));
    const effectsPath = join(runnerTemp, "effects.json");
    writeFileSync(
      effectsPath,
      JSON.stringify({
        version: 1,
        publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        kvPuts: [{ key: "og.v1", value: "{}" }],
        queueSends: [],
      }),
      "utf8",
    );

    await expect(
      runPublisherCli(
        ["--flush", effectsPath],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          RUNNER_TEMP: runnerTemp,
        },
        {
          verifyBridgeContract: async () => {
            throw new Error("publisher bridge fingerprint mismatch");
          },
        },
      ),
    ).rejects.toThrow(/bridge fingerprint mismatch/);
    expect(existsSync(effectsPath)).toBe(true);
  });

  it("writes only the exact allowlisted files from the captured snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-runner-"));
    const prepared = vi.fn();
    const sink = createLocalCommitSink({
      root,
      dryRun: false,
      getLocalHead: () => "captured-sha",
      getRemoteHead: async () => "captured-sha",
      planImpact: () => impactPlan(),
      onPrepared: prepared,
    });
    await sink(
      {
        GH_TOKEN: "token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_BRANCH: "main",
      },
      "data update",
      [
        { path: "data/index.json", content: '{"count":1}\n' },
        { path: "data/archive/2026-07.json", content: '{"entries":[]}\n' },
      ],
      "captured-sha",
    );

    expect(readFileSync(join(root, "data/index.json"), "utf8")).toBe('{"count":1}\n');
    expect(prepared).toHaveBeenCalledWith({
      changed: true,
      files: ["data/index.json", "data/archive/2026-07.json"],
      message: "data update",
      expectedParentSha: "captured-sha",
      impact: impactPlan(),
    });
  });

  it("preserves snapshot validation when there are effects but no data changes", async () => {
    const prepared = vi.fn();
    const sink = createLocalCommitSink({
      root: mkdtempSync(join(tmpdir(), "publisher-runner-")),
      dryRun: false,
      getLocalHead: () => "captured-sha",
      getRemoteHead: async () => "captured-sha",
      onPrepared: prepared,
    });
    await expect(
      sink(
        {
          GH_TOKEN: "token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "no data changes",
        [],
        "captured-sha",
      ),
    ).resolves.toBeNull();
    expect(prepared).toHaveBeenCalledWith({
      changed: false,
      files: [],
      message: "no data changes",
      expectedParentSha: "captured-sha",
      impact: null,
    });
  });

  it("does not write in dry-run and rejects stale or unexpected output", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-runner-"));
    const dryRunSink = createLocalCommitSink({
      root,
      dryRun: true,
      getLocalHead: () => "captured-sha",
      getRemoteHead: async () => "captured-sha",
      planImpact: () => impactPlan(),
      onPrepared: () => undefined,
    });
    await dryRunSink(
      {
        GH_TOKEN: "token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_BRANCH: "main",
      },
      "dry run",
      [{ path: "data/stats.json", content: "{}\n" }],
      "captured-sha",
    );
    expect(() => readFileSync(join(root, "data/stats.json"), "utf8")).toThrow();

    await expect(
      dryRunSink(
        {
          GH_TOKEN: "token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "unsafe",
        [{ path: "README.md", content: "unsafe" }],
        "captured-sha",
      ),
    ).rejects.toThrow(/unexpected output path/);

    const staleSink = createLocalCommitSink({
      root,
      dryRun: false,
      getLocalHead: () => "captured-sha",
      getRemoteHead: async () => "advanced-sha",
      onPrepared: () => undefined,
    });
    await expect(
      staleSink(
        {
          GH_TOKEN: "token",
          GITHUB_OWNER: "owner",
          GITHUB_REPO: "repo",
          GITHUB_BRANCH: "main",
        },
        "stale",
        [{ path: "data/index.json", content: "{}\n" }],
        "captured-sha",
      ),
    ).rejects.toThrow(/snapshot changed before prepare/);
  });

  it("requests a short-lived token for the dedicated publisher audience", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = [
      Buffer.from('{"alg":"none"}').toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      "signature",
    ].join(".");
    const fetchMock = vi.fn(async () =>
      Response.json({ value: token }),
    );
    const provider = new GithubActionsOidcProvider(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?job=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      },
      "tech-dashboard-publisher",
      fetchMock,
    );

    await expect(provider.getToken()).resolves.toBe(token);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("audience=tech-dashboard-publisher");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer request-token",
    });
  });
});
