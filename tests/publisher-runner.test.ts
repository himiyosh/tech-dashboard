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
} from "../scripts/run-publisher.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";
import type { PublisherEnv } from "../worker/src/index.ts";

describe("GitHub Actions publisher runner", () => {
  it("requires one explicit fail-closed mode", () => {
    expect(parsePublisherArgs([])).toEqual({
      ok: false,
      message:
        "use exactly one of --apply, --dry-run, --check, or --flush <effects-file>",
    });
    expect(parsePublisherArgs(["--apply", "--dry-run"]).ok).toBe(false);
    expect(parsePublisherArgs(["--unknown"]).ok).toBe(false);
    expect(parsePublisherArgs(["--flush"]).ok).toBe(false);
    expect(parsePublisherArgs(["--apply"])).toEqual({
      ok: true,
      mode: "apply",
    });
    expect(parsePublisherArgs(["--flush", "/tmp/effects.json"])).toEqual({
      ok: true,
      mode: "flush",
      effectsPath: "/tmp/effects.json",
    });
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
        { runHarness: abortingHarness },
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
        { runHarness: inspectingHarness },
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
        { runHarness: inspectingHarness },
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
        runPublisherCli(["--flush", effectsPath], {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "himiyosh/tech-dashboard",
          RUNNER_TEMP: runnerTemp,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
          PUBLISHER_BRIDGE_URL: "https://bridge.example",
        }),
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

  it("writes only the exact allowlisted files from the captured snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-runner-"));
    const prepared = vi.fn();
    const sink = createLocalCommitSink({
      root,
      dryRun: false,
      getLocalHead: () => "captured-sha",
      getRemoteHead: async () => "captured-sha",
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
    });
  });

  it("does not write in dry-run and rejects stale or unexpected output", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-runner-"));
    const dryRunSink = createLocalCommitSink({
      root,
      dryRun: true,
      getLocalHead: () => "captured-sha",
      getRemoteHead: async () => "captured-sha",
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
