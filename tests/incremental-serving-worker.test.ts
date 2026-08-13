import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type IncrementalD1Database,
  type IncrementalD1PreparedStatement,
  type IncrementalD1RunResult,
  type IncrementalR2Bucket,
  type IncrementalR2Head,
  type IncrementalR2Object,
  type IncrementalServingEnv,
  handleIncrementalServingRequest,
} from "../worker/src/incremental-serving.ts";
import {
  MAX_ROUTE_OBJECT_BYTES,
  REQUIRED_CUTOVER_ROUTE_FAMILIES,
  SAFE_DYNAMIC_DAILY_REQUESTS,
  contentKeyForDigest,
  sha256Digest,
  type IncrementalServingBudgetInput,
} from "../worker/src/incremental-serving-contract.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";

const NOW_MS = Date.parse("2026-08-13T12:00:00.000Z");
const encoder = new TextEncoder();
const fixedLengthStreams = new WeakMap<ReadableStream<Uint8Array>, number>();

function createTestFixedLengthStream(length: number): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  fixedLengthStreams.set(stream.readable, length);
  return stream;
}

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  customMetadata?: Record<string, string>;
  streamFactory?: () => ReadableStream<Uint8Array>;
}

class MemoryR2 implements IncrementalR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  getCount = 0;
  headCount = 0;
  putCount = 0;
  putReceivedStream = false;
  putFixedLength: number | null = null;

  seed(
    key: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
    streamFactory?: () => ReadableStream<Uint8Array>,
    customMetadata?: Record<string, string>,
  ): void {
    this.objects.set(key, {
      bytes,
      contentType,
      ...(streamFactory ? { streamFactory } : {}),
      ...(customMetadata ? { customMetadata } : {}),
    });
  }

  async get(key: string): Promise<IncrementalR2Object | null> {
    this.getCount++;
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body:
        stored.streamFactory?.() ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(stored.bytes);
            controller.close();
          },
        }),
      size: stored.bytes.byteLength,
      httpMetadata: { contentType: stored.contentType },
      customMetadata: stored.customMetadata,
    };
  }

  async head(key: string): Promise<IncrementalR2Head | null> {
    this.headCount++;
    const stored = this.objects.get(key);
    return stored
      ? {
          size: stored.bytes.byteLength,
          httpMetadata: { contentType: stored.contentType },
          customMetadata: stored.customMetadata,
        }
      : null;
  }

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<IncrementalR2Head> {
    this.putCount++;
    this.putReceivedStream = value instanceof ReadableStream;
    this.putFixedLength = value instanceof ReadableStream
      ? fixedLengthStreams.get(value) ?? null
      : null;
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(await new Response(value).arrayBuffer());
    const actualDigest = await sha256Digest(bytes);
    if (
      options?.sha256
      && options.sha256 !== actualDigest.slice("sha256:".length)
    ) {
      throw new Error("checksum mismatch");
    }
    this.seed(
      key,
      new Uint8Array(bytes),
      options?.httpMetadata?.contentType ?? "application/octet-stream",
      undefined,
      options?.customMetadata,
    );
    return {
      size: bytes.byteLength,
      httpMetadata: {
      contentType: options?.httpMetadata?.contentType,
      },
      customMetadata: options?.customMetadata,
    };
  }

  resetCounts(): void {
    this.getCount = 0;
    this.headCount = 0;
    this.putCount = 0;
    this.putReceivedStream = false;
  }
}

interface GenerationRow {
  revision: string;
  source_commit: string;
  publisher_fingerprint: string;
  shell_key: string;
  shard_keys_json: string;
  coverage_complete: number;
  coverage_json: string;
  measured_daily_requests: number;
  traffic_verified_at: string | null;
  budget_json: string;
  created_at: string;
  activated_at: string;
}

class MemoryStatement implements IncrementalD1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: MemoryD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): IncrementalD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.query.includes("FROM incremental_serving_state AS state")) {
      this.database.stateLookupCount++;
      const revision = this.database.activeRevision;
      const generation = revision
        ? this.database.generations.get(revision)
        : undefined;
      return {
        active_revision: revision,
        previous_revision: this.database.previousRevision,
        source_commit: generation?.source_commit ?? null,
        publisher_fingerprint: generation?.publisher_fingerprint ?? null,
        shell_key: generation?.shell_key ?? null,
        shard_keys_json: generation?.shard_keys_json ?? null,
        coverage_complete: generation?.coverage_complete ?? null,
        coverage_json: generation?.coverage_json ?? null,
        measured_daily_requests:
          generation?.measured_daily_requests ?? null,
        traffic_verified_at: generation?.traffic_verified_at ?? null,
        activated_at: generation?.activated_at ?? null,
        budget_json: generation?.budget_json ?? null,
      } as T;
    }
    if (this.query.includes("FROM incremental_serving_generations")) {
      this.database.generationLookupCount++;
      return (this.database.generations.get(String(this.values[0])) ??
        null) as T | null;
    }
    throw new Error(`Unexpected D1 first query: ${this.query}`);
  }

  async run(): Promise<IncrementalD1RunResult> {
    if (this.query.includes("INSERT INTO incremental_serving_generations")) {
      const revision = String(this.values[0]);
      if (this.database.generations.has(revision)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.database.generations.set(revision, {
        revision,
        source_commit: String(this.values[1]),
        publisher_fingerprint: String(this.values[2]),
        shell_key: String(this.values[3]),
        shard_keys_json: String(this.values[4]),
        coverage_complete: Number(this.values[5]),
        coverage_json: String(this.values[6]),
        measured_daily_requests: Number(this.values[7]),
        traffic_verified_at:
          this.values[8] === null ? null : String(this.values[8]),
        budget_json: String(this.values[9]),
        created_at: String(this.values[10]),
        activated_at: String(this.values[11]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (
      this.query.includes("UPDATE incremental_serving_state") &&
      this.query.includes("active_revision IS ?")
    ) {
      const [next, updatedAt, expected] = this.values;
      if (this.database.activeRevision !== expected) {
        return { success: true, meta: { changes: 0 } };
      }
      this.database.previousRevision = this.database.activeRevision;
      this.database.activeRevision = String(next);
      this.database.updatedAt = String(updatedAt);
      return { success: true, meta: { changes: 1 } };
    }
    if (
      this.query.includes("UPDATE incremental_serving_state") &&
      this.query.includes("previous_revision = ?")
    ) {
      const [nextActive, nextPrevious, updatedAt, expectedActive, expectedPrevious] =
        this.values;
      if (
        this.database.activeRevision !== expectedActive ||
        this.database.previousRevision !== expectedPrevious
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      this.database.activeRevision = String(nextActive);
      this.database.previousRevision = String(nextPrevious);
      this.database.updatedAt = String(updatedAt);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`Unexpected D1 run query: ${this.query}`);
  }
}

class MemoryD1 implements IncrementalD1Database {
  readonly generations = new Map<string, GenerationRow>();
  activeRevision: string | null = null;
  previousRevision: string | null = null;
  updatedAt = "1970-01-01T00:00:00.000Z";
  prepareCount = 0;
  stateLookupCount = 0;
  generationLookupCount = 0;

  prepare(query: string): IncrementalD1PreparedStatement {
    this.prepareCount++;
    return new MemoryStatement(this, query);
  }

  resetCounts(): void {
    this.prepareCount = 0;
    this.stateLookupCount = 0;
    this.generationLookupCount = 0;
  }
}

interface GenerationFixture {
  revision: string;
  shellKey: string;
  shardKey: string;
  jaKey: string;
  enKey: string;
  shellBytes: Uint8Array;
  shardBytes: Uint8Array;
  jaBytes: Uint8Array;
  enBytes: Uint8Array;
  budget: IncrementalServingBudgetInput;
  row: GenerationRow;
  activation: Record<string, unknown>;
}

async function keyFor(
  kind: "objects" | "shells" | "shards",
  bytes: Uint8Array,
): Promise<string> {
  return contentKeyForDigest(kind, await sha256Digest(bytes));
}

async function generationFixture(
  bucket: MemoryR2,
  options: {
    label?: string;
    route?: string;
    target?: "object" | "tombstone";
    coverageComplete?: boolean;
    measuredDailyRequests?: number;
    trafficVerifiedAt?: string | null;
  } = {},
): Promise<GenerationFixture> {
  const label = options.label ?? "one";
  const route = options.route ?? "/e/aaaaaaaaaaaaaaaa/";
  const jaBytes = encoder.encode(`<html lang="ja">${label}-ja</html>`);
  const enBytes = encoder.encode(`<html lang="en">${label}-en</html>`);
  const jaKey = await keyFor("objects", jaBytes);
  const enKey = await keyFor("objects", enBytes);
  const shellBytes = encoder.encode(JSON.stringify({ label }));
  const shellDigest = await sha256Digest(shellBytes);
  const revision = await sha256Digest(encoder.encode(`generation:${label}`));
  const sourceCommit = (
    await sha256Digest(encoder.encode(`source:${label}`))
  ).slice("sha256:".length, "sha256:".length + 40);
  const shellKey = contentKeyForDigest("shells", shellDigest);
  const routeTarget =
    options.target === "tombstone"
      ? {
          status: "tombstone",
          reason: "deleted",
          tombstonedAt: "2026-08-13T10:00:00.000Z",
        }
      : {
          status: "object",
          variants: { ja: jaKey, en: enKey },
          variantBytes: {
            ja: jaBytes.byteLength,
            en: enBytes.byteLength,
          },
          contentType: "text/html; charset=utf-8",
        };
  const shardBytes = encoder.encode(
    JSON.stringify({
      schemaVersion: 1,
      revision,
      shardIndex: 0,
      shardCount: 1,
      routes: { [route]: routeTarget },
    }),
  );
  const shardKey = await keyFor("shards", shardBytes);
  const measuredDailyRequests =
    options.measuredDailyRequests ?? SAFE_DYNAMIC_DAILY_REQUESTS;
  const budget: IncrementalServingBudgetInput = {
    measuredDailyRequests,
    projectedDailyPublisherRequests: 100,
    currentRouteCount: 1,
    currentFileCount: 3,
    currentStorageBytes:
      shellBytes.byteLength +
      shardBytes.byteLength +
      jaBytes.byteLength +
      enBytes.byteLength,
    largestRouteObjectBytes: Math.max(
      jaBytes.byteLength,
      enBytes.byteLength,
    ),
    shellBytes: shellBytes.byteLength,
    largestShardBytes: shardBytes.byteLength,
    shardCount: 1,
    projectedMonthlyClassAOperations: 10,
    projectedMonthlyPublisherClassBOperations: 20,
  };
  const activatedAt = "2026-08-13T11:00:00.000Z";
  const trafficVerifiedAt =
    options.trafficVerifiedAt === undefined
      ? "2026-08-13T11:30:00.000Z"
      : options.trafficVerifiedAt;
  const row: GenerationRow = {
    revision,
    source_commit: sourceCommit,
    publisher_fingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
    shell_key: shellKey,
    shard_keys_json: JSON.stringify([shardKey]),
    coverage_complete: options.coverageComplete === false ? 0 : 1,
    coverage_json: JSON.stringify(
      options.coverageComplete === false
        ? ["detail-pages"]
        : REQUIRED_CUTOVER_ROUTE_FAMILIES,
    ),
    measured_daily_requests: measuredDailyRequests,
    traffic_verified_at: trafficVerifiedAt,
    budget_json: JSON.stringify(budget),
    created_at: activatedAt,
    activated_at: activatedAt,
  };
  bucket.seed(
    shellKey,
    shellBytes,
    "application/json",
    undefined,
    { sha256: shellDigest },
  );
  bucket.seed(
    shardKey,
    shardBytes,
    "application/json",
    undefined,
    { sha256: `sha256:${shardKey.slice(shardKey.lastIndexOf("/") + 1)}` },
  );
  bucket.seed(jaKey, jaBytes, "text/html; charset=utf-8");
  bucket.seed(enKey, enBytes, "text/html; charset=utf-8");
  return {
    revision,
    shellKey,
    shardKey,
    jaKey,
    enKey,
    shellBytes,
    shardBytes,
    jaBytes,
    enBytes,
    budget,
    row,
    activation: {
      revision,
      expectedActiveRevision: null,
      sourceCommit,
      publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      shellKey,
      shardKeys: [shardKey],
      coverage: {
        complete: row.coverage_complete === 1,
        routeFamilies: JSON.parse(row.coverage_json),
      },
      measuredDailyRequests,
      trafficVerifiedAt,
      budget,
    },
  };
}

function baseEnv(
  bucket: MemoryR2,
  database: MemoryD1,
  overrides: Partial<IncrementalServingEnv> = {},
): IncrementalServingEnv {
  return {
    INCREMENTAL_OBJECTS: bucket,
    INCREMENTAL_STATE: database,
    INCREMENTAL_SERVING_MODE: "off",
    CUTOVER_APPROVED: "0",
    PAGES_FALLBACK_ORIGIN: "https://pages.example",
    PUBLISHER_OIDC_AUDIENCE: "tech-dashboard-publisher",
    PUBLISHER_REPOSITORY: "himiyosh/tech-dashboard",
    PUBLISHER_WORKFLOW_REF:
      "himiyosh/tech-dashboard/.github/workflows/publisher.yml@refs/heads/main",
    ...overrides,
  };
}

function fallbackMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    return new Response(`pages:${new URL(request.url).pathname}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
}

function jsonApiRequest(
  pathname: string,
  value: unknown,
  method = "POST",
): Request {
  const body = JSON.stringify(value);
  return new Request(`https://worker.example${pathname}`, {
    method,
    headers: {
      authorization: "Bearer test-token",
      "content-length": String(encoder.encode(body).byteLength),
      "content-type": "application/json",
    },
    body,
  });
}

const allowOidc = async () => undefined;

describe("incremental serving public modes", () => {
  it("reports off health without touching missing stores", async () => {
    const response = await handleIncrementalServingRequest(
      new Request("https://worker.example/health"),
      {
        INCREMENTAL_SERVING_MODE: "off",
        PAGES_FALLBACK_ORIGIN: "https://pages.example",
      },
      { fetchImpl: fallbackMock() as typeof fetch, nowMs: NOW_MS },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "incremental-off",
      mode: "off",
      bindingsReady: false,
      activeRevision: null,
    });
  });

  it("keeps off mode on Pages with zero D1 or R2 operations", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fallback = fallbackMock();
    const response = await handleIncrementalServingRequest(
      new Request("https://worker.example/e/aaaaaaaaaaaaaaaa/"),
      baseEnv(bucket, database),
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await response.text()).toBe("pages:/e/aaaaaaaaaaaaaaaa/");
    expect(fallback).toHaveBeenCalledOnce();
    expect(database.prepareCount).toBe(0);
    expect(bucket.getCount).toBe(0);
    expect(bucket.headCount).toBe(0);
  });

  it("isolates shadow serving under its prefix", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    bucket.resetCounts();
    const fallback = fallbackMock();
    const env = baseEnv(bucket, database, {
      INCREMENTAL_SERVING_MODE: "shadow",
    });

    const ordinary = await handleIncrementalServingRequest(
      new Request("https://worker.example/e/aaaaaaaaaaaaaaaa/"),
      env,
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await ordinary.text()).toBe("pages:/e/aaaaaaaaaaaaaaaa/");
    expect(database.stateLookupCount).toBe(0);
    expect(bucket.getCount).toBe(0);

    const shadow = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/",
      ),
      env,
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await shadow.text()).toContain("one-ja");
    expect(shadow.headers.get("x-techdb-serving-mode")).toBe("shadow");
    expect(database.stateLookupCount).toBe(1);
    expect(bucket.getCount).toBe(2);
  });

  it("keeps serve mode hard-disabled in the detail-only slice", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    bucket.resetCounts();
    database.resetCounts();
    const fallback = fallbackMock();
    const request = new Request(
      "https://worker.example/e/aaaaaaaaaaaaaaaa/",
    );
    const response = await handleIncrementalServingRequest(
      request,
      baseEnv(bucket, database, {
        INCREMENTAL_SERVING_MODE: "serve",
        CUTOVER_APPROVED: "1",
      }),
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await response.text()).toContain("pages:");
    expect(database.stateLookupCount).toBe(0);
    expect(bucket.getCount).toBe(0);
  });

  it("falls back without store reads when serving configuration is invalid", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    bucket.resetCounts();
    const fallback = fallbackMock();
    const response = await handleIncrementalServingRequest(
      new Request("https://worker.example/e/aaaaaaaaaaaaaaaa/"),
      baseEnv(bucket, database, {
        INCREMENTAL_SERVING_MODE: "serve",
        CUTOVER_APPROVED: "1",
        PAGES_FALLBACK_ORIGIN: "http://unsafe.example/path",
      }),
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await response.text()).toContain("pages:");
    expect(database.prepareCount).toBe(0);
    expect(bucket.getCount).toBe(0);
  });

  it("returns a real 404 for a known deleted tombstone", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket, {
      target: "tombstone",
    });
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    bucket.resetCounts();
    const fallback = fallbackMock();
    const response = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/",
      ),
      baseEnv(bucket, database, {
        INCREMENTAL_SERVING_MODE: "shadow",
      }),
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("x-techdb-tombstone")).toBe("deleted");
    expect(fallback).not.toHaveBeenCalled();
    expect(bucket.getCount).toBe(1);
  });

  it("falls back for a missing route object or malformed state/shard", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    const fallback = fallbackMock();
    const env = baseEnv(bucket, database, {
      INCREMENTAL_SERVING_MODE: "shadow",
    });

    bucket.objects.delete(fixture.jaKey);
    const missing = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/",
      ),
      env,
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await missing.text()).toContain("pages:");

    bucket.seed(fixture.jaKey, fixture.jaBytes, "text/html; charset=utf-8");
    bucket.seed(fixture.shardKey, encoder.encode("{"), "application/json");
    const malformedShard = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/",
      ),
      env,
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await malformedShard.text()).toContain("pages:");

    bucket.seed(
      fixture.shardKey,
      fixture.shardBytes,
      "application/json",
    );
    database.generations.set(fixture.revision, {
      ...fixture.row,
      shard_keys_json: "{",
    });
    const malformedState = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/",
      ),
      env,
      { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
    );
    expect(await malformedState.text()).toContain("pages:");
  });

  it("selects the pre-rendered English variant", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    const response = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/?lang=en",
      ),
      baseEnv(bucket, database, {
        INCREMENTAL_SERVING_MODE: "shadow",
      }),
      { fetchImpl: fallbackMock() as typeof fetch, nowMs: NOW_MS },
    );
    expect(await response.text()).toContain("one-en");
    expect(response.headers.get("content-language")).toBe("en");
  });

  it("does not buffer the streamed route object in the Worker", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    let getReaderCalls = 0;
    bucket.seed(
      fixture.jaKey,
      fixture.jaBytes,
      "text/html; charset=utf-8",
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fixture.jaBytes);
            controller.close();
          },
        });
        const original = stream.getReader.bind(stream);
        Object.defineProperty(stream, "getReader", {
          value: (...args: Parameters<typeof stream.getReader>) => {
            getReaderCalls++;
            return original(...args);
          },
        });
        return stream;
      },
    );
    const response = await handleIncrementalServingRequest(
      new Request(
        "https://worker.example/__incremental-shadow/e/aaaaaaaaaaaaaaaa/",
      ),
      baseEnv(bucket, database, {
        INCREMENTAL_SERVING_MODE: "shadow",
      }),
      { fetchImpl: fallbackMock() as typeof fetch, nowMs: NOW_MS },
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    expect(getReaderCalls).toBe(0);
  });

  it("proxies non-content and non-GET public requests", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fallback = fallbackMock();
    const env = baseEnv(bucket, database, {
      INCREMENTAL_SERVING_MODE: "serve",
      CUTOVER_APPROVED: "1",
    });
    const [asset, post] = await Promise.all([
      handleIncrementalServingRequest(
        new Request("https://worker.example/_astro/app.js"),
        env,
        { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
      ),
      handleIncrementalServingRequest(
        new Request("https://worker.example/e/aaaaaaaaaaaaaaaa/", {
          method: "POST",
          body: "ignored by incremental serving",
        }),
        env,
        { fetchImpl: fallback as typeof fetch, nowMs: NOW_MS },
      ),
    ]);
    expect(await asset.text()).toBe("pages:/_astro/app.js");
    expect(await post.text()).toBe("pages:/e/aaaaaaaaaaaaaaaa/");
    expect(database.prepareCount).toBe(0);
  });
});

describe("incremental serving authenticated API", () => {
  it("uploads and reads back a bounded content-addressed object", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const bytes = encoder.encode("<html>stored</html>");
    const digest = await sha256Digest(bytes);
    const key = contentKeyForDigest("objects", digest);
    const put = await handleIncrementalServingRequest(
      new Request(
        `https://worker.example/__incremental-api/v1/content/${key}`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer test-token",
            "content-length": String(bytes.byteLength),
            "content-type": "text/html; charset=utf-8",
            "x-content-sha256": digest,
          },
          body: bytes,
        },
      ),
      baseEnv(bucket, database),
      {
        verifyToken: allowOidc,
        nowMs: NOW_MS,
        createFixedLengthStream: createTestFixedLengthStream,
      },
    );
    expect(put.status).toBe(201);
    expect(bucket.putReceivedStream).toBe(true);
    expect(bucket.putFixedLength).toBe(bytes.byteLength);
    await expect(put.json()).resolves.toMatchObject({
      ok: true,
      key,
      reused: false,
    });

    const read = await handleIncrementalServingRequest(
      new Request(
        `https://worker.example/__incremental-api/v1/content/${key}`,
        { headers: { authorization: "Bearer test-token" } },
      ),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(await read.text()).toBe("<html>stored</html>");
  });

  it("returns structured errors for invalid digest and object size", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const bytes = encoder.encode("different");
    const digest = `sha256:${"a".repeat(64)}`;
    const mismatch = await handleIncrementalServingRequest(
      new Request(
        `https://worker.example/__incremental-api/v1/content/objects/sha256/${"a".repeat(64)}`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer test-token",
            "content-length": String(bytes.byteLength),
            "content-type": "text/html; charset=utf-8",
            "x-content-sha256": digest,
          },
          body: bytes,
        },
      ),
      baseEnv(bucket, database),
      {
        verifyToken: allowOidc,
        nowMs: NOW_MS,
        createFixedLengthStream: createTestFixedLengthStream,
      },
    );
    expect(mismatch.status).toBe(502);
    expect(bucket.putCount).toBe(1);
    expect(bucket.objects.size).toBe(0);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: "content_write_failed" },
    });

    const oversized = await handleIncrementalServingRequest(
      new Request(
        `https://worker.example/__incremental-api/v1/content/objects/sha256/${"b".repeat(64)}`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer test-token",
            "content-length": String(MAX_ROUTE_OBJECT_BYTES + 1),
            "content-type": "text/html; charset=utf-8",
            "x-content-sha256": `sha256:${"b".repeat(64)}`,
          },
          body: "x",
        },
      ),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "content_too_large" },
    });
  });

  describe("incremental serving deployment files", () => {
    it("keeps the separate Worker off and without a custom-domain route", () => {
      const config = readFileSync(
        new URL("../worker/wrangler.incremental.toml", import.meta.url),
        "utf8",
      );
      expect(config).toContain('main = "src/incremental-serving.ts"');
      expect(config).toContain('INCREMENTAL_SERVING_MODE = "off"');
      expect(config).toContain('CUTOVER_APPROVED = "0"');
      expect(config).toContain("workers_dev = true");
      expect(config).not.toMatch(/^\s*routes?\s*=/m);
    });

    it("defines dedicated immutable generations and atomic pointer state", () => {
      const migration = readFileSync(
        new URL(
          "../worker/migrations/incremental-serving/0001.sql",
          import.meta.url,
        ),
        "utf8",
      );
      expect(migration).toContain(
        "CREATE TABLE IF NOT EXISTS incremental_serving_generations",
      );
      expect(migration).toContain(
        "CREATE TABLE IF NOT EXISTS incremental_serving_state",
      );
      expect(migration).toContain("active_revision TEXT");
      expect(migration).toContain("previous_revision TEXT");
      expect(migration).toContain("source_commit TEXT NOT NULL");
      expect(migration).toContain("coverage_json TEXT NOT NULL");
      expect(migration).toContain("CHECK (singleton = 1)");
    });
  });

  it("activates only after shell and shards exist and preserves pointer on failure", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const previous = await generationFixture(bucket, { label: "previous" });
    const next = await generationFixture(bucket, { label: "next" });
    database.generations.set(previous.revision, previous.row);
    database.activeRevision = previous.revision;
    const activation = {
      ...next.activation,
      expectedActiveRevision: previous.revision,
    };
    bucket.objects.delete(next.shellKey);

    const missing = await handleIncrementalServingRequest(
      jsonApiRequest(`${"/__incremental-api/v1"}/activate`, activation),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(missing.status).toBe(409);
    expect(database.activeRevision).toBe(previous.revision);

    bucket.seed(
      next.shellKey,
      next.shellBytes,
      "application/json",
      undefined,
      { sha256: `sha256:${next.shellKey.slice(next.shellKey.lastIndexOf("/") + 1)}` },
    );
    const staleExpected = await handleIncrementalServingRequest(
      jsonApiRequest(`${"/__incremental-api/v1"}/activate`, {
        ...activation,
        expectedActiveRevision: `sha256:${"f".repeat(64)}`,
      }),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(staleExpected.status).toBe(409);
    expect(database.activeRevision).toBe(previous.revision);

    const activated = await handleIncrementalServingRequest(
      jsonApiRequest(`${"/__incremental-api/v1"}/activate`, activation),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(activated.status).toBe(200);
    expect(database.activeRevision).toBe(next.revision);
    expect(database.previousRevision).toBe(previous.revision);
  });

  it("rolls back atomically to the stored previous generation", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const previous = await generationFixture(bucket, { label: "previous" });
    const active = await generationFixture(bucket, { label: "active" });
    database.generations.set(previous.revision, previous.row);
    database.generations.set(active.revision, active.row);
    database.activeRevision = active.revision;
    database.previousRevision = previous.revision;

    const response = await handleIncrementalServingRequest(
      jsonApiRequest("/__incremental-api/v1/rollback", {
        expectedActiveRevision: active.revision,
      }),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(response.status).toBe(200);
    expect(database.activeRevision).toBe(previous.revision);
    expect(database.previousRevision).toBe(active.revision);
  });

  it("returns authenticated active/previous state without exposing auth material", async () => {
    const bucket = new MemoryR2();
    const database = new MemoryD1();
    const fixture = await generationFixture(bucket);
    database.generations.set(fixture.revision, fixture.row);
    database.activeRevision = fixture.revision;
    const response = await handleIncrementalServingRequest(
      new Request("https://worker.example/__incremental-api/v1/state", {
        headers: { authorization: "Bearer test-token" },
      }),
      baseEnv(bucket, database),
      { verifyToken: allowOidc, nowMs: NOW_MS },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(fixture.revision);
    expect(text).not.toContain("test-token");
  });
});
