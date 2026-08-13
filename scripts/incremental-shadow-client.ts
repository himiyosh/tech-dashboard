#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ActivationRequest,
  BILLING_MONTH_MAX_DAYS,
  type IncrementalRouteShard,
  type IncrementalServingBudgetInput,
  type RouteTarget,
  assertCommitSha,
  assertIncrementalServingBudget,
  contentKeyForDigest,
  parseContentKey,
  parseRouteShard,
  readBoundedStream,
  sha256Digest,
  shardIndexForPath,
} from "../worker/src/incremental-serving-contract.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";
import {
  GithubActionsOidcProvider,
  PublisherBridgeClient,
} from "./run-publisher.ts";

const API_PREFIX = "/__incremental-api/v1";
const DEFAULT_SHARD_COUNT = 16;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PAGES_FALLBACK_ORIGIN =
  "https://tech-dashboard-6a7.pages.dev";
const MAX_SHELL_ASSET_BYTES = 5 * 1024 * 1024;

interface BundleObject {
  digest: string;
  bytes: number;
  file: string;
}

interface BundleRoute {
  id: string;
  path: string;
  status: 200;
  variants: {
    default: BundleObject;
    en: BundleObject;
  };
}

interface ShadowBundle {
  version: 1;
  mode: "shadow";
  publisherFingerprint: string;
  baseRef: string;
  dataGeneratedAt: string;
  shellDigest: string;
  shell: BundleObject;
  fullDetailSnapshot: boolean;
  coverage: {
    routeFamilies: string[];
    complete: false;
    cutoverAllowed: false;
  };
  routes: BundleRoute[];
  tombstones: Array<{
    id: string;
    path: string;
    status: 404;
  }>;
  searchDelta: BundleObject | null;
  unsupportedRouteFamilies: string[];
}

interface StateResponse {
  ok: true;
  state: {
    activeRevision: string | null;
    previousRevision: string | null;
    sourceCommit: string | null;
    publisherFingerprint: string | null;
    shellKey: string | null;
    shardKeys: string[];
    coverageComplete: boolean;
    coverageRouteFamilies: string[];
  };
}

export interface IncrementalShadowRequester {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface PreparedGeneration {
  alreadyActive: boolean;
  activation: ActivationRequest;
  shell: {
    key: string;
    object: BundleObject;
  };
  objects: Array<{
    key: string;
    object: BundleObject;
    contentType: string;
  }>;
  shards: Array<{
    key: string;
    digest: string;
    bytes: Uint8Array;
  }>;
}

function usage(): string {
  return [
    "use exactly one mode:",
    "  --publish <bundle.json>",
    "  --pull-shell <output.json>",
    "  --rollback <sha256:revision>",
    "  --state",
    "  --check",
  ].join("\n");
}

export function parseIncrementalShadowArgs(args: string[]):
  | { ok: true; mode: "check" | "state" }
  | { ok: true; mode: "publish"; bundlePath: string }
  | { ok: true; mode: "pull-shell"; outputPath: string }
  | { ok: true; mode: "rollback"; revision: string }
  | { ok: false; message: string } {
  if (args.length === 1 && args[0] === "--check") {
    return { ok: true, mode: "check" };
  }
  if (args.length === 1 && args[0] === "--state") {
    return { ok: true, mode: "state" };
  }
  if (args.length === 2 && args[0] === "--publish" && args[1]) {
    return { ok: true, mode: "publish", bundlePath: args[1] };
  }
  if (args.length === 2 && args[0] === "--pull-shell" && args[1]) {
    return { ok: true, mode: "pull-shell", outputPath: args[1] };
  }
  if (args.length === 2 && args[0] === "--rollback" && args[1]) {
    return { ok: true, mode: "rollback", revision: args[1] };
  }
  return { ok: false, message: usage() };
}

function assertActionsContext(env: NodeJS.ProcessEnv): void {
  if (
    env.GITHUB_ACTIONS !== "true"
    || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_REPOSITORY !== "himiyosh/tech-dashboard"
  ) {
    throw new Error("incremental shadow writes require the main Publisher workflow");
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${key}`);
  return value;
}

function atomicWrite(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, target);
}

function assertInsideRunnerTemp(path: string, env: NodeJS.ProcessEnv): string {
  const runnerTemp = resolve(requiredEnv(env, "RUNNER_TEMP"));
  const target = resolve(path);
  if (target !== runnerTemp && !target.startsWith(`${runnerTemp}${sep}`)) {
    throw new Error("incremental shadow artifact must be inside RUNNER_TEMP");
  }
  return target;
}

function readBundle(path: string, env: NodeJS.ProcessEnv): {
  bundle: ShadowBundle;
  directory: string;
} {
  const bundlePath = assertInsideRunnerTemp(path, env);
  if (!existsSync(bundlePath) || !lstatSync(bundlePath).isFile()) {
    throw new Error("incremental shadow bundle is missing");
  }
  const value = JSON.parse(readFileSync(bundlePath, "utf8")) as Partial<ShadowBundle>;
  if (
    value.version !== 1
    || value.mode !== "shadow"
    || value.publisherFingerprint !== DEPLOYED_PUBLISHER_FINGERPRINT
    || !/^[a-f0-9]{40}$/.test(value.baseRef ?? "")
    || !value.shell
    || !Array.isArray(value.routes)
    || !Array.isArray(value.tombstones)
    || !value.coverage
    || value.coverage.complete !== false
    || value.coverage.cutoverAllowed !== false
  ) {
    throw new Error("incremental shadow bundle contract mismatch");
  }
  return {
    bundle: value as ShadowBundle,
    directory: dirname(bundlePath),
  };
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBundleObject(
  directory: string,
  object: BundleObject,
): Uint8Array {
  if (
    !/^[a-f0-9]{64}$/.test(object.digest)
    || !Number.isSafeInteger(object.bytes)
    || object.bytes < 1
    || typeof object.file !== "string"
  ) {
    throw new Error("incremental bundle object metadata is invalid");
  }
  const target = resolve(directory, object.file);
  const pathFromBundle = relative(directory, target);
  if (pathFromBundle.startsWith("..") || pathFromBundle === "" || target === directory) {
    throw new Error("incremental bundle object escapes its directory");
  }
  if (!existsSync(target)) {
    throw new Error("incremental bundle object must be a regular file");
  }
  const file = lstatSync(target);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error("incremental bundle object must be a regular file");
  }
  const bytes = readFileSync(target);
  if (bytes.byteLength !== object.bytes || rawSha256(bytes) !== object.digest) {
    throw new Error(`incremental bundle object digest mismatch: ${object.file}`);
  }
  return bytes;
}

export async function verifyIncrementalShellAssets(
  shellBytes: Uint8Array,
  pagesOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let shell: unknown;
  try {
    shell = JSON.parse(new TextDecoder().decode(shellBytes));
  } catch {
    throw new Error("incremental shell object must be valid JSON");
  }
  const assets = (
    shell && typeof shell === "object" && !Array.isArray(shell)
      ? (shell as { assets?: unknown }).assets
      : null
  );
  if (!Array.isArray(assets) || assets.length < 1) {
    throw new Error("incremental shell must declare production assets");
  }
  const origin = new URL(pagesOrigin);
  if (
    origin.protocol !== "https:"
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("PAGES_FALLBACK_ORIGIN must be an HTTPS origin");
  }
  const seen = new Set<string>();
  for (const asset of assets) {
    const record = asset as Record<string, unknown>;
    if (
      !asset
      || typeof asset !== "object"
      || Array.isArray(asset)
      || typeof record.path !== "string"
      || !record.path.startsWith("/_astro/")
      || seen.has(record.path)
      || !Number.isSafeInteger(record.bytes)
      || Number(record.bytes) < 1
      || Number(record.bytes) > MAX_SHELL_ASSET_BYTES
      || typeof record.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(record.sha256)
    ) {
      throw new Error("incremental shell contains invalid asset evidence");
    }
    const assetPath = record.path;
    const assetBytes = Number(record.bytes);
    const assetDigest = record.sha256;
    seen.add(assetPath);
    const response = await fetchImpl(new URL(assetPath, origin), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Pages asset verification failed for ${assetPath} with HTTP ${response.status}`,
      );
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null
      && Number(contentLength) !== assetBytes
    ) {
      throw new Error(`Pages asset byte length drifted for ${assetPath}`);
    }
    if (!response.body) {
      throw new Error(`Pages asset body is missing for ${assetPath}`);
    }
    const bytes = await readBoundedStream(
      response.body,
      MAX_SHELL_ASSET_BYTES,
      assetBytes,
    );
    if (
      bytes.byteLength !== assetBytes
      || rawSha256(bytes) !== assetDigest
    ) {
      throw new Error(`Pages asset digest drifted for ${assetPath}`);
    }
  }
}

async function requestJson<T>(
  requester: IncrementalShadowRequester,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requester.request(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `incremental shadow API ${path} failed with HTTP ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  return await response.json() as T;
}

async function fetchState(
  requester: IncrementalShadowRequester,
): Promise<StateResponse["state"]> {
  return (await requestJson<StateResponse>(requester, `${API_PREFIX}/state`)).state;
}

async function fetchShard(
  requester: IncrementalShadowRequester,
  key: string,
): Promise<IncrementalRouteShard> {
  parseContentKey(key, "shards");
  const response = await requester.request(`${API_PREFIX}/content/${key}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`incremental shard read failed with HTTP ${response.status}`);
  }
  return parseRouteShard(await response.json());
}

function sourceCommitFromEnvironment(env: NodeJS.ProcessEnv): string {
  const sourceCommit = requiredEnv(env, "INCREMENTAL_SOURCE_COMMIT");
  assertCommitSha(sourceCommit, "incremental source commit");
  return sourceCommit;
}

async function generationRevision(sourceCommit: string): Promise<string> {
  return sha256Digest(
    new TextEncoder().encode(`tech-dashboard-incremental-generation-v1:${sourceCommit}`),
  );
}

function digestKey(kind: "objects" | "shells" | "shards", rawDigest: string): string {
  return contentKeyForDigest(kind, `sha256:${rawDigest}`);
}

function routeTargetsFromShards(
  shards: readonly IncrementalRouteShard[],
): Map<string, RouteTarget> {
  const targets = new Map<string, RouteTarget>();
  for (const shard of shards) {
    for (const [path, target] of Object.entries(shard.routes)) {
      targets.set(path, target);
    }
  }
  return targets;
}

function storageMeasurements(
  routes: ReadonlyMap<string, RouteTarget>,
  shellBytes: number,
  shardBytes: readonly number[],
): {
  currentFileCount: number;
  currentStorageBytes: number;
  largestRouteObjectBytes: number;
} {
  const objects = new Map<string, number>();
  for (const target of routes.values()) {
    if (target.status !== "object") continue;
    for (const language of ["ja", "en"] as const) {
      const key = target.variants[language];
      const bytes = target.variantBytes[language];
      const existing = objects.get(key);
      if (existing !== undefined && existing !== bytes) {
        throw new Error(`incremental route object byte mismatch for ${key}`);
      }
      objects.set(key, bytes);
    }
  }
  return {
    currentFileCount: objects.size + shardBytes.length + 1,
    currentStorageBytes:
      [...objects.values()].reduce((total, bytes) => total + bytes, 0)
      + shellBytes
      + shardBytes.reduce((total, bytes) => total + bytes, 0),
    largestRouteObjectBytes: Math.max(0, ...objects.values()),
  };
}

export async function prepareIncrementalGeneration(
  bundle: ShadowBundle,
  directory: string,
  state: StateResponse["state"],
  sourceCommit: string,
  existingShards: readonly IncrementalRouteShard[],
  measuredDailyRequests = 0,
  trafficVerifiedAt: string | null = null,
): Promise<PreparedGeneration> {
  assertCommitSha(sourceCommit);
  const revision = await generationRevision(sourceCommit);
  const alreadyActive =
    state.activeRevision === revision
    && state.sourceCommit === sourceCommit
    && state.publisherFingerprint === DEPLOYED_PUBLISHER_FINGERPRINT;
  if (!bundle.fullDetailSnapshot) {
    if (
      !state.activeRevision
      || (
        state.sourceCommit !== bundle.baseRef
        && !alreadyActive
      )
      || existingShards.length !== state.shardKeys.length
    ) {
      throw new Error(
        "incremental delta requires an active shadow generation for the exact parent commit",
      );
    }
  }
  const shardCount = bundle.fullDetailSnapshot
    ? DEFAULT_SHARD_COUNT
    : state.shardKeys.length;
  if (shardCount < 1) throw new Error("incremental generation has no shards");
  const previousRoutes = routeTargetsFromShards(existingShards);
  const routes = bundle.fullDetailSnapshot
    ? new Map<string, RouteTarget>()
    : new Map(previousRoutes);
  const objects = new Map<string, {
    key: string;
    object: BundleObject;
    contentType: string;
  }>();

  for (const route of bundle.routes) {
    const jaKey = digestKey("objects", route.variants.default.digest);
    const enKey = digestKey("objects", route.variants.en.digest);
    routes.set(route.path, {
      status: "object",
      variants: { ja: jaKey, en: enKey },
      variantBytes: {
        ja: route.variants.default.bytes,
        en: route.variants.en.bytes,
      },
      contentType: "text/html; charset=utf-8",
    });
    objects.set(jaKey, {
      key: jaKey,
      object: route.variants.default,
      contentType: "text/html; charset=utf-8",
    });
    objects.set(enKey, {
      key: enKey,
      object: route.variants.en,
      contentType: "text/html; charset=utf-8",
    });
  }
  for (const tombstone of bundle.tombstones) {
    routes.set(tombstone.path, {
      status: "tombstone",
      reason: "deleted",
      tombstonedAt: bundle.dataGeneratedAt,
    });
  }
  if (bundle.fullDetailSnapshot) {
    for (const routePath of previousRoutes.keys()) {
      if (
        /^\/e\/[a-f0-9]{16}\/$/.test(routePath)
        && !routes.has(routePath)
      ) {
        routes.set(routePath, {
          status: "tombstone",
          reason: "deleted",
          tombstonedAt: bundle.dataGeneratedAt,
        });
      }
    }
  }

  const shardRoutes = Array.from(
    { length: shardCount },
    () => ({} as Record<string, RouteTarget>),
  );
  for (const [routePath, target] of [...routes.entries()].sort()) {
    const index = await shardIndexForPath(routePath, shardCount);
    shardRoutes[index]![routePath] = target;
  }
  const shards = shardRoutes.map((records, shardIndex) => {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({
        schemaVersion: 1,
        revision,
        shardIndex,
        shardCount,
        routes: records,
      })}\n`,
    );
    const rawDigest = rawSha256(bytes);
    return {
      key: digestKey("shards", rawDigest),
      digest: `sha256:${rawDigest}`,
      bytes,
    };
  });
  for (const shard of shards) {
    parseRouteShard(JSON.parse(new TextDecoder().decode(shard.bytes)));
  }

  const shellBytes = readBundleObject(directory, bundle.shell);
  const shellKey = digestKey("shells", bundle.shell.digest);
  const measurements = storageMeasurements(
    routes,
    shellBytes.byteLength,
    shards.map((shard) => shard.bytes.byteLength),
  );
  const budget: IncrementalServingBudgetInput = {
    measuredDailyRequests,
    projectedDailyPublisherRequests:
      2 * (objects.size + shards.length + 1)
      + existingShards.length
      + 3,
    currentRouteCount: routes.size,
    currentFileCount: measurements.currentFileCount,
    currentStorageBytes: measurements.currentStorageBytes,
    largestRouteObjectBytes: measurements.largestRouteObjectBytes,
    shellBytes: shellBytes.byteLength,
    largestShardBytes: Math.max(...shards.map((shard) => shard.bytes.byteLength)),
    shardCount,
    projectedMonthlyClassAOperations:
      (objects.size + shards.length + 1) * BILLING_MONTH_MAX_DAYS,
    projectedMonthlyPublisherClassBOperations:
      (
        2 * (objects.size + shards.length + 1)
        + existingShards.length
      ) * BILLING_MONTH_MAX_DAYS,
  };
  assertIncrementalServingBudget(budget);
  return {
    alreadyActive,
    activation: {
      revision,
      expectedActiveRevision: state.activeRevision,
      sourceCommit,
      publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      shellKey,
      shardKeys: shards.map((shard) => shard.key),
      coverage: {
        complete: false,
        routeFamilies: ["detail-pages"],
      },
      measuredDailyRequests,
      trafficVerifiedAt,
      budget,
    },
    shell: { key: shellKey, object: bundle.shell },
    objects: [...objects.values()],
    shards,
  };
}

async function uploadAndVerify(
  requester: IncrementalShadowRequester,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const digest = parseContentKey(key).digest;
  const response = await requester.request(`${API_PREFIX}/content/${key}`, {
    method: "PUT",
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": contentType,
      "x-content-sha256": digest,
    },
    body: bytes,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `incremental upload ${key} failed with HTTP ${response.status}: ${detail}`,
    );
  }
  const result = await response.json() as {
    key?: unknown;
    digest?: unknown;
    bytes?: unknown;
  };
  if (
    result.key !== key
    || result.digest !== digest
    || result.bytes !== bytes.byteLength
  ) {
    throw new Error(`incremental upload ${key} returned inconsistent metadata`);
  }
  const readBack = await requester.request(`${API_PREFIX}/content/${key}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (
    !readBack.ok
    || readBack.headers.get("etag") !== `"${digest}"`
    || readBack.headers.get("content-length") !== String(bytes.byteLength)
  ) {
    throw new Error(`incremental upload ${key} failed read-back verification`);
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  limit: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        await task(values[index]!);
      }
    }),
  );
}

export async function publishIncrementalBundle(
  requester: IncrementalShadowRequester,
  bundlePath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedGeneration> {
  const { bundle, directory } = readBundle(bundlePath, env);
  const state = await fetchState(requester);
  const sourceCommit = sourceCommitFromEnvironment(env);
  const existingShards = state.activeRevision
    ? await Promise.all(state.shardKeys.map((key) => fetchShard(requester, key)))
    : [];
  const measuredDailyRequests = Number(
    env.INCREMENTAL_MEASURED_DAILY_REQUESTS ?? "0",
  );
  if (!Number.isSafeInteger(measuredDailyRequests) || measuredDailyRequests < 0) {
    throw new Error("INCREMENTAL_MEASURED_DAILY_REQUESTS must be a non-negative integer");
  }
  const trafficVerifiedAt =
    env.INCREMENTAL_TRAFFIC_VERIFIED_AT?.trim() || null;
  const prepared = await prepareIncrementalGeneration(
    bundle,
    directory,
    state,
    sourceCommit,
    existingShards,
    measuredDailyRequests,
    trafficVerifiedAt,
  );

  const shellBytes = readBundleObject(directory, prepared.shell.object);
  await verifyIncrementalShellAssets(
    shellBytes,
    env.PAGES_FALLBACK_ORIGIN?.trim()
      || DEFAULT_PAGES_FALLBACK_ORIGIN,
    fetchImpl,
  );
  const uploads = [
    {
      key: prepared.shell.key,
      load: () => shellBytes,
      contentType: "application/json; charset=utf-8",
    },
    ...prepared.objects.map((object) => ({
      key: object.key,
      load: () => readBundleObject(directory, object.object),
      contentType: object.contentType,
    })),
    ...prepared.shards.map((shard) => ({
      key: shard.key,
      load: () => shard.bytes,
      contentType: "application/json; charset=utf-8",
    })),
  ];
  await mapConcurrent(uploads, 4, async (upload) => {
    const bytes = upload.load();
    await uploadAndVerify(
      requester,
      upload.key,
      bytes,
      upload.contentType,
    );
  });
  if (!prepared.alreadyActive) {
    await requestJson(
      requester,
      `${API_PREFIX}/activate`,
      {
        method: "POST",
        headers: {
          "content-length": String(
            Buffer.byteLength(JSON.stringify(prepared.activation)),
          ),
          "content-type": "application/json",
        },
        body: JSON.stringify(prepared.activation),
      },
    );
  }
  return prepared;
}

function requesterForEnvironment(
  env: NodeJS.ProcessEnv,
): IncrementalShadowRequester {
  const url = requiredEnv(env, "INCREMENTAL_SHADOW_URL");
  const oidc = new GithubActionsOidcProvider(
    env,
    env.PUBLISHER_OIDC_AUDIENCE ?? "tech-dashboard-publisher",
  );
  return new PublisherBridgeClient(url, oidc);
}

export async function runIncrementalShadowCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseIncrementalShadowArgs(args);
  if (!parsed.ok) {
    console.error(`ERR: ${parsed.message}`);
    return 1;
  }
  if (parsed.mode === "check") {
    console.log(
      `OK: incremental shadow contract fingerprint=${DEPLOYED_PUBLISHER_FINGERPRINT} mode=off-by-default`,
    );
    return 0;
  }
  assertActionsContext(env);
  const requester = requesterForEnvironment(env);
  if (parsed.mode === "state") {
    const state = await fetchState(requester);
    console.log(JSON.stringify(state));
    return 0;
  }
  if (parsed.mode === "pull-shell") {
    const state = await fetchState(requester);
    if (!state.shellKey) throw new Error("incremental shadow has no active shell");
    const response = await requester.request(
      `${API_PREFIX}/content/${state.shellKey}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) {
      throw new Error(`incremental shell read failed with HTTP ${response.status}`);
    }
    const output = assertInsideRunnerTemp(parsed.outputPath, env);
    atomicWrite(output, await response.text());
    console.log(`OK: incremental shell restored to ${output}`);
    return 0;
  }
  if (parsed.mode === "rollback") {
    const body = JSON.stringify({
      expectedActiveRevision: parsed.revision,
    });
    await requestJson(requester, `${API_PREFIX}/rollback`, {
      method: "POST",
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      },
      body,
    });
    console.log(`OK: incremental shadow rolled back from ${parsed.revision}`);
    return 0;
  }
  const prepared = await publishIncrementalBundle(
    requester,
    parsed.bundlePath,
    env,
  );
  console.log(
    `OK: incremental shadow ${prepared.alreadyActive ? "reconciled" : "activated"} revision=${prepared.activation.revision} source=${prepared.activation.sourceCommit} routes=${prepared.activation.budget.currentRouteCount}`,
  );
  return 0;
}

const isDirectInvocation =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  runIncrementalShadowCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`ERR: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
