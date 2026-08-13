import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseIncrementalShadowArgs,
  prepareIncrementalGeneration,
  shouldReportUploadProgress,
  uploadAndVerify,
  verifyIncrementalShellAssets,
} from "../scripts/incremental-shadow-client.ts";
import {
  parseRouteShard,
  type ServingGenerationState,
} from "../worker/src/incremental-serving-contract.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";

function rawDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeObject(root: string, name: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const digest = rawDigest(bytes);
  const file = `objects/${name}`;
  mkdirSync(join(root, "objects"), { recursive: true });
  writeFileSync(join(root, file), bytes);
  return { digest, bytes: bytes.byteLength, file };
}

function emptyState(): ServingGenerationState {
  return {
    activeRevision: null,
    previousRevision: null,
    sourceCommit: null,
    publisherFingerprint: null,
    shellKey: null,
    shardKeys: [],
    coverageComplete: false,
    coverageRouteFamilies: [],
    measuredDailyRequests: null,
    trafficVerifiedAt: null,
    activatedAt: null,
    budget: null,
  };
}

function fullBundle(root: string) {
  const shell = writeObject(root, "shell.json", '{"version":1}\n');
  const ja = writeObject(root, "ja.html", "<html lang=\"ja\">JA</html>");
  const en = writeObject(root, "en.html", "<html lang=\"en\">EN</html>");
  return {
    version: 1 as const,
    mode: "shadow" as const,
    publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
    baseRef: "a".repeat(40),
    dataGeneratedAt: "2026-08-13T00:00:00.000Z",
    shellDigest: shell.digest,
    shell,
    fullDetailSnapshot: true,
    coverage: {
      routeFamilies: ["detail-pages"],
      complete: false as const,
      cutoverAllowed: false as const,
    },
    routes: [
      {
        id: "1111111111111111",
        path: "/e/1111111111111111/",
        status: 200 as const,
        variants: { default: ja, en },
      },
    ],
    tombstones: [
      {
        id: "2222222222222222",
        path: "/e/2222222222222222/",
        status: 404 as const,
      },
    ],
    searchDelta: null,
    unsupportedRouteFamilies: [
      "pagefind-requires-global-reconciliation",
    ],
  };
}

function readBackRequester(
  key: string,
  digest: string,
  uploadedBytes: number,
  readBackBytes: Uint8Array,
) {
  return {
    request: vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({
            ok: true,
            key,
            digest,
            bytes: uploadedBytes,
            reused: false,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (init?.method === "GET") {
        return new Response(readBackBytes, { status: 200 });
      }
      throw new Error(`unexpected read-back method: ${init?.method}`);
    }),
  };
}

describe("incremental shadow publisher client", () => {
  it("parses only explicit fail-closed CLI modes", () => {
    expect(parseIncrementalShadowArgs([]).ok).toBe(false);
    expect(parseIncrementalShadowArgs(["--publish"]).ok).toBe(false);
    expect(parseIncrementalShadowArgs(["--state"])).toEqual({
      ok: true,
      mode: "state",
    });
  });

  it("verifies uploaded bytes without depending on HEAD response headers", async () => {
    const bytes = new TextEncoder().encode("verified shadow object");
    const raw = rawDigest(bytes);
    const digest = `sha256:${raw}`;
    const key = `objects/sha256/${raw}`;
    const requester = readBackRequester(
      key,
      digest,
      bytes.byteLength,
      bytes,
    );

    await expect(
      uploadAndVerify(requester, key, bytes, "text/html; charset=utf-8"),
    ).resolves.toBeUndefined();
    expect(
      requester.request.mock.calls.map(([, init]) => init?.method),
    ).toEqual(["PUT", "GET"]);
  });

  it("rejects a same-length R2 read-back with a different digest", async () => {
    const bytes = new TextEncoder().encode("verified shadow object");
    const altered = new Uint8Array(bytes);
    altered[0] = altered[0]! ^ 1;
    const raw = rawDigest(bytes);
    const digest = `sha256:${raw}`;
    const key = `objects/sha256/${raw}`;

    await expect(
      uploadAndVerify(
        readBackRequester(key, digest, bytes.byteLength, altered),
        key,
        bytes,
        "text/html; charset=utf-8",
      ),
    ).rejects.toThrow(/got digest=sha256:/);
  });

  it("rejects an R2 read-back with a different byte length", async () => {
    const bytes = new TextEncoder().encode("verified shadow object");
    const truncated = bytes.slice(0, -1);
    const raw = rawDigest(bytes);
    const digest = `sha256:${raw}`;
    const key = `objects/sha256/${raw}`;

    await expect(
      uploadAndVerify(
        readBackRequester(key, digest, bytes.byteLength, truncated),
        key,
        bytes,
        "text/html; charset=utf-8",
      ),
    ).rejects.toThrow(`got digest=sha256:${rawDigest(truncated)} bytes=${truncated.byteLength}`);
  });

  it("bounds incremental upload progress diagnostics", () => {
    const reported: number[] = [];
    for (let completed = 1; completed <= 250; completed += 1) {
      if (shouldReportUploadProgress(completed, 250)) {
        reported.push(completed);
      }
    }

    expect(reported).toEqual([1, 100, 200, 250]);
    expect(shouldReportUploadProgress(0, 250)).toBe(false);
    expect(shouldReportUploadProgress(251, 250)).toBe(false);
    expect(shouldReportUploadProgress(1.5, 250)).toBe(false);
  });

  it("builds a distinct generation revision with bounded shards and tombstones", async () => {
    const root = mkdtempSync(join(tmpdir(), "incremental-client-"));
    const bundle = fullBundle(root);
    const sourceCommit = "b".repeat(40);
    const prepared = await prepareIncrementalGeneration(
      bundle,
      root,
      emptyState(),
      sourceCommit,
      [],
    );

    expect(prepared.activation.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prepared.alreadyActive).toBe(false);
    expect(prepared.activation.revision).not.toBe(
      `sha256:${bundle.shell.digest}`,
    );
    expect(prepared.activation.sourceCommit).toBe(sourceCommit);
    expect(prepared.activation.coverage).toEqual({
      complete: false,
      routeFamilies: ["detail-pages"],
    });
    expect(prepared.shards).toHaveLength(16);
    const routes = Object.assign(
      {},
      ...prepared.shards.map((shard) =>
        parseRouteShard(JSON.parse(new TextDecoder().decode(shard.bytes))).routes
      ),
    );
    expect(routes["/e/1111111111111111/"]).toMatchObject({
      status: "object",
      variantBytes: {
        ja: bundle.routes[0]?.variants.default.bytes,
        en: bundle.routes[0]?.variants.en.bytes,
      },
    });
    expect(routes["/e/2222222222222222/"]).toMatchObject({
      status: "tombstone",
      reason: "deleted",
    });
    expect(prepared.activation.budget.currentRouteCount).toBe(2);
    expect(prepared.activation.budget.currentStorageBytes).toBeGreaterThan(0);
  });

  it("refuses a delta when the active shadow is not the exact parent commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "incremental-client-"));
    const bundle = {
      ...fullBundle(root),
      fullDetailSnapshot: false,
    };
    await expect(
      prepareIncrementalGeneration(
        bundle,
        root,
        {
          ...emptyState(),
          activeRevision: `sha256:${"c".repeat(64)}`,
          sourceCommit: "d".repeat(40),
          shardKeys: [`shards/sha256/${"e".repeat(64)}`],
        },
        "f".repeat(40),
        [],
      ),
    ).rejects.toThrow(/exact parent commit/);
  });

  it("verifies every captured shell asset against the Pages fallback", async () => {
    const asset = new TextEncoder().encode("production asset");
    const shell = new TextEncoder().encode(JSON.stringify({
      assets: [{
        path: "/_astro/app.js",
        bytes: asset.byteLength,
        sha256: rawDigest(asset),
      }],
    }));
    const fetchImpl = vi.fn(async () =>
      new Response(asset, {
        status: 200,
        headers: { "content-length": String(asset.byteLength) },
      })
    );
    await expect(
      verifyIncrementalShellAssets(
        shell,
        "https://pages.example",
        fetchImpl as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://pages.example/_astro/app.js"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(
      verifyIncrementalShellAssets(
        shell,
        "https://pages.example",
        (async () => new Response("different")) as typeof fetch,
      ),
    ).rejects.toThrow(/stream length|digest drifted/);
  });

  it("keeps removed details as tombstones across full generations", async () => {
    const root = mkdtempSync(join(tmpdir(), "incremental-client-"));
    const initialBundle = fullBundle(root);
    const initial = await prepareIncrementalGeneration(
      initialBundle,
      root,
      emptyState(),
      "1".repeat(40),
      [],
    );
    const previousShards = initial.shards.map((shard) =>
      parseRouteShard(JSON.parse(new TextDecoder().decode(shard.bytes)))
    );
    const next = await prepareIncrementalGeneration(
      {
        ...initialBundle,
        routes: [],
        tombstones: [],
      },
      root,
      {
        ...emptyState(),
        activeRevision: initial.activation.revision,
        sourceCommit: initial.activation.sourceCommit,
        shardKeys: initial.activation.shardKeys,
      },
      "2".repeat(40),
      previousShards,
    );
    const routes = Object.assign(
      {},
      ...next.shards.map((shard) =>
        parseRouteShard(JSON.parse(new TextDecoder().decode(shard.bytes))).routes
      ),
    );
    expect(routes["/e/1111111111111111/"]).toMatchObject({
      status: "tombstone",
      reason: "deleted",
    });
  });

  it("allows an already-active delta to reconcile its objects without reactivation", async () => {
    const root = mkdtempSync(join(tmpdir(), "incremental-client-"));
    const bundle = fullBundle(root);
    const sourceCommit = "3".repeat(40);
    const first = await prepareIncrementalGeneration(
      bundle,
      root,
      emptyState(),
      sourceCommit,
      [],
    );
    const shards = first.shards.map((shard) =>
      parseRouteShard(JSON.parse(new TextDecoder().decode(shard.bytes)))
    );
    const retry = await prepareIncrementalGeneration(
      {
        ...bundle,
        fullDetailSnapshot: false,
      },
      root,
      {
        ...emptyState(),
        activeRevision: first.activation.revision,
        sourceCommit,
        publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        shardKeys: first.activation.shardKeys,
      },
      sourceCommit,
      shards,
    );
    expect(retry.alreadyActive).toBe(true);
  });
});
