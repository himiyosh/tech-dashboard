export const INCREMENTAL_SERVING_SCHEMA_VERSION = 1 as const;
export const INCREMENTAL_SERVE_IMPLEMENTED = false as const;

export const WORKERS_DAILY_REQUEST_LIMIT = 100_000;
export const WORKERS_CPU_LIMIT_MS = 10;
export const WORKERS_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
export const SAFE_DYNAMIC_DAILY_REQUESTS = 80_000;
export const SAFE_TOTAL_WORKER_DAILY_REQUESTS = 90_000;

export const R2_STORAGE_LIMIT_BYTES = 10_000_000_000;
export const R2_CLASS_A_MONTHLY_LIMIT = 1_000_000;
export const R2_CLASS_B_MONTHLY_LIMIT = 10_000_000;
export const R2_READS_PER_SERVED_REQUEST = 2;
export const BILLING_MONTH_MAX_DAYS = 31;
export const SAFE_R2_STORAGE_BYTES = 8_000_000_000;
export const SAFE_R2_CLASS_A_MONTHLY = 900_000;
export const SAFE_R2_CLASS_B_MONTHLY = 8_000_000;

export const MAX_ROUTE_OBJECT_BYTES = 5 * 1024 * 1024;
export const MAX_SHELL_BYTES = 64 * 1024;
export const MAX_SHARD_BYTES = 64 * 1024;
export const MAX_SHARDS = 32;
export const MAX_ROUTES_PER_SHARD = 1_024;
export const MAX_ROUTE_PATH_BYTES = 512;
export const TRAFFIC_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const TRAFFIC_VERIFICATION_FUTURE_SKEW_MS = 5 * 60_000;

export const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
export const CONTENT_KEY_RE =
  /^(objects|shells|shards)\/sha256\/([a-f0-9]{64})$/;
export const REQUIRED_CUTOVER_ROUTE_FAMILIES = [
  "archive",
  "arxiv",
  "category-pages",
  "detail-pages",
  "feeds",
  "global-shell",
  "home",
  "knowledge",
  "metrics",
  "search-index",
  "sitemap",
  "status",
  "tag-pages-and-recovery",
  "timeline-pagination",
] as const;
const ROUTE_FAMILY_SET = new Set<string>(REQUIRED_CUTOVER_ROUTE_FAMILIES);

export type IncrementalServingMode = "off" | "shadow" | "serve";
export type ContentObjectKind = "objects" | "shells" | "shards";
export type TombstoneReason = "cold" | "deleted" | "dropped";

export const ROUTE_CONTENT_TYPES = [
  "application/feed+json; charset=utf-8",
  "application/json; charset=utf-8",
  "application/rss+xml; charset=utf-8",
  "application/xml; charset=utf-8",
  "text/html; charset=utf-8",
  "text/plain; charset=utf-8",
  "text/x-opml; charset=utf-8",
] as const;

export type RouteContentType = (typeof ROUTE_CONTENT_TYPES)[number];

export interface IncrementalServingBudgetInput {
  measuredDailyRequests: number;
  projectedDailyPublisherRequests: number;
  currentRouteCount: number;
  currentFileCount: number;
  currentStorageBytes: number;
  largestRouteObjectBytes: number;
  shellBytes: number;
  largestShardBytes: number;
  shardCount: number;
  projectedMonthlyClassAOperations: number;
  projectedMonthlyPublisherClassBOperations: number;
}

export interface IncrementalServingBudgetAssessment {
  ok: boolean;
  failures: string[];
  projectedMonthlyClassBOperations: number;
  limits: {
    workersDailyRequests: number;
    workersCpuMs: number;
    workersMemoryBytes: number;
    safeDynamicDailyRequests: number;
    safeTotalWorkerDailyRequests: number;
    r2StorageBytes: number;
    safeR2StorageBytes: number;
    r2ClassAMonthly: number;
    safeR2ClassAMonthly: number;
    r2ClassBMonthly: number;
    safeR2ClassBMonthly: number;
    r2ReadsPerServedRequest: number;
  };
}

export interface RouteObjectTarget {
  status: "object";
  variants: {
    ja: string;
    en: string;
  };
  variantBytes: {
    ja: number;
    en: number;
  };
  contentType: RouteContentType;
  cacheControl?: string;
}

export interface RouteTombstoneTarget {
  status: "tombstone";
  reason: TombstoneReason;
  tombstonedAt: string;
}

export type RouteTarget = RouteObjectTarget | RouteTombstoneTarget;

export interface IncrementalRouteShard {
  schemaVersion: typeof INCREMENTAL_SERVING_SCHEMA_VERSION;
  revision: string;
  shardIndex: number;
  shardCount: number;
  routes: Record<string, RouteTarget>;
}

export interface ServingGenerationState {
  activeRevision: string | null;
  previousRevision: string | null;
  sourceCommit: string | null;
  publisherFingerprint: string | null;
  shellKey: string | null;
  shardKeys: string[];
  coverageComplete: boolean;
  coverageRouteFamilies: string[];
  measuredDailyRequests: number | null;
  trafficVerifiedAt: string | null;
  activatedAt: string | null;
  budget: IncrementalServingBudgetInput | null;
}

export interface ActivationRequest {
  revision: string;
  expectedActiveRevision: string | null;
  sourceCommit: string;
  publisherFingerprint: string;
  shellKey: string;
  shardKeys: string[];
  coverage: {
    complete: boolean;
    routeFamilies: string[];
  };
  measuredDailyRequests: number;
  trafficVerifiedAt: string | null;
  budget: IncrementalServingBudgetInput;
}

export interface RollbackRequest {
  expectedActiveRevision: string;
}

export class IncrementalServingContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "IncrementalServingContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) {
    throw new IncrementalServingContractError(
      "invalid_integer",
      `${label} must be a safe integer`,
    );
  }
  const numeric = value as number;
  if (options.min !== undefined && numeric < options.min) {
    throw new IncrementalServingContractError(
      "invalid_integer",
      `${label} must be at least ${options.min}`,
    );
  }
  if (options.max !== undefined && numeric > options.max) {
    throw new IncrementalServingContractError(
      "invalid_integer",
      `${label} must be at most ${options.max}`,
    );
  }
  return numeric;
}

function nullableInteger(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number | null {
  return value === null || value === undefined
    ? null
    : integer(value, label, options);
}

function nullableIsoTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new IncrementalServingContractError(
      "invalid_timestamp",
      `${label} must be an ISO timestamp or null`,
    );
  }
  return value;
}

export function parseIncrementalServingMode(
  value: string | undefined,
): IncrementalServingMode {
  return value === "shadow" || value === "serve" ? value : "off";
}

export function assertSha256Digest(
  value: unknown,
  label = "digest",
): asserts value is string {
  if (typeof value !== "string" || !SHA256_DIGEST_RE.test(value)) {
    throw new IncrementalServingContractError(
      "invalid_sha256",
      `${label} must match sha256:<64 lowercase hex characters>`,
    );
  }
}

export function assertCommitSha(
  value: unknown,
  label = "source commit",
): asserts value is string {
  if (typeof value !== "string" || !COMMIT_SHA_RE.test(value)) {
    throw new IncrementalServingContractError(
      "invalid_commit_sha",
      `${label} must match 40 lowercase hex characters`,
    );
  }
}

export function contentKeyForDigest(
  kind: ContentObjectKind,
  digest: string,
): string {
  assertSha256Digest(digest);
  return `${kind}/sha256/${digest.slice("sha256:".length)}`;
}

export function parseContentKey(
  value: unknown,
  expectedKind?: ContentObjectKind,
): { kind: ContentObjectKind; digest: string; key: string } {
  if (typeof value !== "string") {
    throw new IncrementalServingContractError(
      "invalid_content_key",
      "content key must be a string",
    );
  }
  const match = CONTENT_KEY_RE.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new IncrementalServingContractError(
      "invalid_content_key",
      "content key must match <objects|shells|shards>/sha256/<64 lowercase hex characters>",
    );
  }
  const kind = match[1] as ContentObjectKind;
  if (expectedKind && kind !== expectedKind) {
    throw new IncrementalServingContractError(
      "invalid_content_key_kind",
      `content key must use ${expectedKind}`,
    );
  }
  return {
    kind,
    digest: `sha256:${match[2]}`,
    key: value,
  };
}

export function maxBytesForContentKind(kind: ContentObjectKind): number {
  if (kind === "objects") return MAX_ROUTE_OBJECT_BYTES;
  if (kind === "shells") return MAX_SHELL_BYTES;
  return MAX_SHARD_BYTES;
}

export function boundedContentLength(
  request: Request,
  maxBytes: number,
): number {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    throw new IncrementalServingContractError(
      "content_length_required",
      "content-length is required",
      411,
    );
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new IncrementalServingContractError(
      "invalid_content_length",
      "content-length must be a positive integer",
    );
  }
  if (length > maxBytes) {
    throw new IncrementalServingContractError(
      "content_too_large",
      `content-length ${length} exceeds ${maxBytes} bytes`,
      413,
    );
  }
  return length;
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new IncrementalServingContractError(
          "content_too_large",
          `stream exceeds ${maxBytes} bytes`,
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedBytes !== undefined && total !== expectedBytes) {
    throw new IncrementalServingContractError(
      "content_length_mismatch",
      `stream length ${total} does not match content-length ${expectedBytes}`,
    );
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function boundedPassthroughStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes || total > expectedBytes) {
        controller.error(
          new IncrementalServingContractError(
            "content_too_large",
            `stream exceeds its ${expectedBytes}-byte declaration or ${maxBytes}-byte limit`,
            413,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (total !== expectedBytes) {
        controller.error(
          new IncrementalServingContractError(
            "content_length_mismatch",
            `stream length ${total} does not match content-length ${expectedBytes}`,
          ),
        );
      }
    },
  }));
}

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = boundedContentLength(request, maxBytes);
  if (!request.body) {
    throw new IncrementalServingContractError(
      "missing_body",
      "request body is required",
    );
  }
  return readBoundedStream(request.body, maxBytes, length);
}

export async function readBoundedJsonRequest(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedRequestBody(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new IncrementalServingContractError(
      "invalid_json",
      "request body must be valid JSON",
    );
  }
}

export async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function assertCanonicalRoutePath(
  value: unknown,
  label = "route path",
): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw new IncrementalServingContractError(
      "invalid_route_path",
      `${label} must be a root-relative path`,
    );
  }
  if (
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    new TextEncoder().encode(value).byteLength > MAX_ROUTE_PATH_BYTES
  ) {
    throw new IncrementalServingContractError(
      "invalid_route_path",
      `${label} must be query-free, hash-free, slash-normalized, and at most ${MAX_ROUTE_PATH_BYTES} bytes`,
    );
  }
  try {
    const parsed = new URL(value, "https://incremental.invalid");
    if (parsed.origin !== "https://incremental.invalid" || parsed.pathname !== value) {
      throw new Error("non-canonical");
    }
  } catch {
    throw new IncrementalServingContractError(
      "invalid_route_path",
      `${label} is not canonical`,
    );
  }
}

export function isContentRoutePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    /^\/(?:arxiv|archive|categories|knowledge|search|status)\/?$/.test(pathname) ||
    /^\/(?:e\/[a-f0-9]{16}|page\/[1-9]\d*|c\/[^/]+(?:\/page\/[1-9]\d*)?|t\/[^/]+(?:\/page\/[1-9]\d*)?|archive\/\d{4}-\d{2})\/?$/.test(
      pathname,
    ) ||
    /^\/rss(?:\/[^/]+)?\.xml$/.test(pathname) ||
    [
      "/cold-archive-search.json",
      "/feed.json",
      "/feeds.opml",
      "/metrics.json",
      "/robots.txt",
      "/sitemap.xml",
      "/tag-recovery.json",
    ].includes(pathname)
  );
}

function validCacheControl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\r\n]/.test(value)
  );
}

function parseRouteTarget(value: unknown, route: string): RouteTarget {
  if (!isRecord(value)) {
    throw new IncrementalServingContractError(
      "invalid_route_target",
      `route ${route} target must be an object`,
    );
  }
  if (value.status === "tombstone") {
    if (
      value.reason !== "cold" &&
      value.reason !== "deleted" &&
      value.reason !== "dropped"
    ) {
      throw new IncrementalServingContractError(
        "invalid_tombstone",
        `route ${route} tombstone reason is invalid`,
      );
    }
    const tombstonedAt = nullableIsoTimestamp(
      value.tombstonedAt,
      `route ${route} tombstonedAt`,
    );
    if (!tombstonedAt) {
      throw new IncrementalServingContractError(
        "invalid_tombstone",
        `route ${route} tombstonedAt is required`,
      );
    }
    return {
      status: "tombstone",
      reason: value.reason,
      tombstonedAt,
    };
  }
  if (value.status !== "object" || !isRecord(value.variants)) {
    throw new IncrementalServingContractError(
      "invalid_route_target",
      `route ${route} target status or variants are invalid`,
    );
  }
  const ja = parseContentKey(value.variants.ja, "objects").key;
  const en = parseContentKey(value.variants.en, "objects").key;
  if (!isRecord(value.variantBytes)) {
    throw new IncrementalServingContractError(
      "invalid_route_target",
      `route ${route} variantBytes are required`,
    );
  }
  const jaBytes = integer(value.variantBytes.ja, `route ${route} JA bytes`, {
    min: 1,
    max: MAX_ROUTE_OBJECT_BYTES,
  });
  const enBytes = integer(value.variantBytes.en, `route ${route} EN bytes`, {
    min: 1,
    max: MAX_ROUTE_OBJECT_BYTES,
  });
  if (
    typeof value.contentType !== "string" ||
    !ROUTE_CONTENT_TYPES.includes(value.contentType as RouteContentType)
  ) {
    throw new IncrementalServingContractError(
      "invalid_content_type",
      `route ${route} contentType is invalid`,
    );
  }
  if (
    value.cacheControl !== undefined &&
    !validCacheControl(value.cacheControl)
  ) {
    throw new IncrementalServingContractError(
      "invalid_cache_control",
      `route ${route} cacheControl is invalid`,
    );
  }
  return {
    status: "object",
    variants: { ja, en },
    variantBytes: { ja: jaBytes, en: enBytes },
    contentType: value.contentType as RouteContentType,
    ...(value.cacheControl === undefined
      ? {}
      : { cacheControl: value.cacheControl }),
  };
}

export function parseRouteShard(value: unknown): IncrementalRouteShard {
  if (!isRecord(value)) {
    throw new IncrementalServingContractError(
      "invalid_shard",
      "route shard must be an object",
    );
  }
  if (value.schemaVersion !== INCREMENTAL_SERVING_SCHEMA_VERSION) {
    throw new IncrementalServingContractError(
      "invalid_shard",
      `route shard schemaVersion must be ${INCREMENTAL_SERVING_SCHEMA_VERSION}`,
    );
  }
  assertSha256Digest(value.revision, "route shard revision");
  const shardCount = integer(value.shardCount, "route shard shardCount", {
    min: 1,
    max: MAX_SHARDS,
  });
  const shardIndex = integer(value.shardIndex, "route shard shardIndex", {
    min: 0,
    max: shardCount - 1,
  });
  if (!isRecord(value.routes)) {
    throw new IncrementalServingContractError(
      "invalid_shard",
      "route shard routes must be an object",
    );
  }
  const entries = Object.entries(value.routes);
  if (entries.length > MAX_ROUTES_PER_SHARD) {
    throw new IncrementalServingContractError(
      "invalid_shard",
      `route shard contains more than ${MAX_ROUTES_PER_SHARD} routes`,
    );
  }
  const routes: Record<string, RouteTarget> = {};
  for (const [path, target] of entries) {
    assertCanonicalRoutePath(path);
    routes[path] = parseRouteTarget(target, path);
  }
  return {
    schemaVersion: INCREMENTAL_SERVING_SCHEMA_VERSION,
    revision: value.revision,
    shardIndex,
    shardCount,
    routes,
  };
}

function parseCoverageRouteFamilies(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((family) => typeof family !== "string" || !ROUTE_FAMILY_SET.has(family))
  ) {
    throw new IncrementalServingContractError(
      "invalid_coverage",
      `${label} must contain only known route families`,
    );
  }
  const routeFamilies = [...new Set(value)].sort();
  if (routeFamilies.length !== value.length) {
    throw new IncrementalServingContractError(
      "invalid_coverage",
      `${label} must not contain duplicates`,
    );
  }
  return routeFamilies;
}

export function parseActivationRequest(value: unknown): ActivationRequest {
  if (!isRecord(value) || !isRecord(value.coverage)) {
    throw new IncrementalServingContractError(
      "invalid_activation",
      "activation request must be an object with coverage",
    );
  }
  assertSha256Digest(value.revision, "activation revision");
  if (value.expectedActiveRevision !== null) {
    assertSha256Digest(
      value.expectedActiveRevision,
      "activation expectedActiveRevision",
    );
  }
  assertCommitSha(value.sourceCommit, "activation sourceCommit");
  assertSha256Digest(
    value.publisherFingerprint,
    "activation publisherFingerprint",
  );
  const shell = parseContentKey(value.shellKey, "shells");
  if (
    !Array.isArray(value.shardKeys) ||
    value.shardKeys.length < 1 ||
    value.shardKeys.length > MAX_SHARDS
  ) {
    throw new IncrementalServingContractError(
      "invalid_activation",
      `activation shardKeys must contain 1-${MAX_SHARDS} keys`,
    );
  }
  const shardKeys = value.shardKeys.map(
    (key) => parseContentKey(key, "shards").key,
  );
  if (new Set(shardKeys).size !== shardKeys.length) {
    throw new IncrementalServingContractError(
      "invalid_activation",
      "activation shardKeys must be unique",
    );
  }
  if (typeof value.coverage.complete !== "boolean") {
    throw new IncrementalServingContractError(
      "invalid_activation",
      "activation coverage.complete must be boolean",
    );
  }
  const coverageRouteFamilies = parseCoverageRouteFamilies(
    value.coverage.routeFamilies,
    "activation coverage.routeFamilies",
  );
  const hasCompleteCoverage = REQUIRED_CUTOVER_ROUTE_FAMILIES.every(
    (family) => coverageRouteFamilies.includes(family),
  );
  if (value.coverage.complete && !hasCompleteCoverage) {
    throw new IncrementalServingContractError(
      "invalid_coverage",
      "complete activation coverage must include every cutover route family",
    );
  }
  const measuredDailyRequests = integer(
    value.measuredDailyRequests,
    "activation measuredDailyRequests",
    { min: 0, max: WORKERS_DAILY_REQUEST_LIMIT },
  );
  const trafficVerifiedAt = nullableIsoTimestamp(
    value.trafficVerifiedAt,
    "activation trafficVerifiedAt",
  );
  const budget = parseIncrementalServingBudgetInput(value.budget);
  assertIncrementalServingBudget(budget);
  if (budget.measuredDailyRequests !== measuredDailyRequests) {
    throw new IncrementalServingContractError(
      "invalid_activation",
      "activation measuredDailyRequests must equal budget measuredDailyRequests",
    );
  }
  if (budget.shardCount !== shardKeys.length) {
    throw new IncrementalServingContractError(
      "invalid_activation",
      "activation shardKeys length must equal budget shardCount",
    );
  }
  return {
    revision: value.revision,
    expectedActiveRevision: value.expectedActiveRevision as string | null,
    sourceCommit: value.sourceCommit,
    publisherFingerprint: value.publisherFingerprint as string,
    shellKey: shell.key,
    shardKeys,
    coverage: {
      complete: value.coverage.complete,
      routeFamilies: coverageRouteFamilies,
    },
    measuredDailyRequests,
    trafficVerifiedAt,
    budget,
  };
}

export function parseRollbackRequest(value: unknown): RollbackRequest {
  if (!isRecord(value)) {
    throw new IncrementalServingContractError(
      "invalid_rollback",
      "rollback request must be an object",
    );
  }
  assertSha256Digest(
    value.expectedActiveRevision,
    "rollback expectedActiveRevision",
  );
  return {
    expectedActiveRevision: value.expectedActiveRevision,
  };
}

export function parseServingGenerationState(
  value: unknown,
): ServingGenerationState {
  if (!isRecord(value)) {
    throw new IncrementalServingContractError(
      "invalid_state",
      "incremental serving state must be an object",
    );
  }
  const activeRevision = value.active_revision;
  const previousRevision = value.previous_revision;
  if (activeRevision === null || activeRevision === undefined) {
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
  assertSha256Digest(activeRevision, "state active revision");
  if (previousRevision !== null && previousRevision !== undefined) {
    assertSha256Digest(previousRevision, "state previous revision");
  }
  assertCommitSha(value.source_commit, "state source commit");
  assertSha256Digest(
    value.publisher_fingerprint,
    "state publisher fingerprint",
  );
  const shell = parseContentKey(value.shell_key, "shells");
  let rawShardKeys: unknown;
  try {
    rawShardKeys =
      typeof value.shard_keys_json === "string"
        ? JSON.parse(value.shard_keys_json)
        : null;
  } catch {
    throw new IncrementalServingContractError(
      "invalid_state",
      "state shard_keys_json must be valid JSON",
    );
  }
  if (
    !Array.isArray(rawShardKeys) ||
    rawShardKeys.length < 1 ||
    rawShardKeys.length > MAX_SHARDS
  ) {
    throw new IncrementalServingContractError(
      "invalid_state",
      `state must contain 1-${MAX_SHARDS} shard keys`,
    );
  }
  const shardKeys = rawShardKeys.map(
    (key) => parseContentKey(key, "shards").key,
  );
  if (new Set(shardKeys).size !== shardKeys.length) {
    throw new IncrementalServingContractError(
      "invalid_state",
      "state shard keys must be unique",
    );
  }
  if (value.coverage_complete !== 0 && value.coverage_complete !== 1) {
    throw new IncrementalServingContractError(
      "invalid_state",
      "state coverage_complete must be 0 or 1",
    );
  }
  let rawCoverageRouteFamilies: unknown;
  try {
    rawCoverageRouteFamilies =
      typeof value.coverage_json === "string"
        ? JSON.parse(value.coverage_json)
        : null;
  } catch {
    throw new IncrementalServingContractError(
      "invalid_state",
      "state coverage_json must be valid JSON",
    );
  }
  const coverageRouteFamilies = parseCoverageRouteFamilies(
    rawCoverageRouteFamilies,
    "state coverage_json",
  );
  if (
    value.coverage_complete === 1
    && !REQUIRED_CUTOVER_ROUTE_FAMILIES.every(
      (family) => coverageRouteFamilies.includes(family),
    )
  ) {
    throw new IncrementalServingContractError(
      "invalid_state",
      "complete state coverage is missing a cutover route family",
    );
  }
  let rawBudget: unknown;
  try {
    rawBudget =
      typeof value.budget_json === "string"
        ? JSON.parse(value.budget_json)
        : null;
  } catch {
    throw new IncrementalServingContractError(
      "invalid_state",
      "state budget_json must be valid JSON",
    );
  }
  const budget = parseIncrementalServingBudgetInput(rawBudget);
  assertIncrementalServingBudget(budget);
  return {
    activeRevision,
    previousRevision:
      previousRevision === null || previousRevision === undefined
        ? null
        : previousRevision,
    sourceCommit: value.source_commit as string,
    publisherFingerprint: value.publisher_fingerprint as string,
    shellKey: shell.key,
    shardKeys,
    coverageComplete: value.coverage_complete === 1,
    coverageRouteFamilies,
    measuredDailyRequests: nullableInteger(
      value.measured_daily_requests,
      "state measured_daily_requests",
      { min: 0, max: WORKERS_DAILY_REQUEST_LIMIT },
    ),
    trafficVerifiedAt: nullableIsoTimestamp(
      value.traffic_verified_at,
      "state traffic_verified_at",
    ),
    activatedAt: nullableIsoTimestamp(
      value.activated_at,
      "state activated_at",
    ),
    budget,
  };
}

export function isServeReady(
  state: ServingGenerationState,
  options: {
    cutoverApproved: string | undefined;
    expectedPublisherFingerprint: string;
    nowMs?: number;
  },
): boolean {
  if (
    options.cutoverApproved !== "1" ||
    !state.activeRevision ||
    !state.sourceCommit ||
    !state.coverageComplete ||
    !REQUIRED_CUTOVER_ROUTE_FAMILIES.every(
      (family) => state.coverageRouteFamilies.includes(family),
    ) ||
    state.publisherFingerprint !== options.expectedPublisherFingerprint ||
    state.measuredDailyRequests === null ||
    state.measuredDailyRequests > SAFE_DYNAMIC_DAILY_REQUESTS ||
    !state.trafficVerifiedAt ||
    !state.budget ||
    !evaluateIncrementalServingBudget(state.budget).ok
  ) {
    return false;
  }
  const nowMs = options.nowMs ?? Date.now();
  const verifiedAt = Date.parse(state.trafficVerifiedAt);
  return (
    Number.isFinite(verifiedAt) &&
    verifiedAt <= nowMs + TRAFFIC_VERIFICATION_FUTURE_SKEW_MS &&
    nowMs - verifiedAt <= TRAFFIC_VERIFICATION_MAX_AGE_MS
  );
}

export async function shardIndexForPath(
  path: string,
  shardCount: number,
): Promise<number> {
  assertCanonicalRoutePath(path);
  integer(shardCount, "shardCount", { min: 1, max: MAX_SHARDS });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)),
  );
  const prefix =
    ((digest[0] ?? 0) << 24) |
    ((digest[1] ?? 0) << 16) |
    ((digest[2] ?? 0) << 8) |
    (digest[3] ?? 0);
  return (prefix >>> 0) % shardCount;
}

function requiredBudgetInteger(
  input: IncrementalServingBudgetInput,
  key: keyof IncrementalServingBudgetInput,
  failures: string[],
  min = 0,
): number | null {
  const value = input[key];
  if (!Number.isSafeInteger(value) || value < min) {
    failures.push(`${key} must be a safe integer >= ${min}`);
    return null;
  }
  return value;
}

export function parseIncrementalServingBudgetInput(
  value: unknown,
): IncrementalServingBudgetInput {
  if (!isRecord(value)) {
    throw new IncrementalServingContractError(
      "invalid_budget",
      "incremental serving budget input must be an object",
    );
  }
  return {
    measuredDailyRequests: integer(
      value.measuredDailyRequests,
      "budget measuredDailyRequests",
      { min: 0 },
    ),
    projectedDailyPublisherRequests: integer(
      value.projectedDailyPublisherRequests,
      "budget projectedDailyPublisherRequests",
      { min: 0 },
    ),
    currentRouteCount: integer(
      value.currentRouteCount,
      "budget currentRouteCount",
      { min: 1 },
    ),
    currentFileCount: integer(
      value.currentFileCount,
      "budget currentFileCount",
      { min: 1 },
    ),
    currentStorageBytes: integer(
      value.currentStorageBytes,
      "budget currentStorageBytes",
      { min: 0 },
    ),
    largestRouteObjectBytes: integer(
      value.largestRouteObjectBytes,
      "budget largestRouteObjectBytes",
      { min: 0 },
    ),
    shellBytes: integer(value.shellBytes, "budget shellBytes", { min: 1 }),
    largestShardBytes: integer(
      value.largestShardBytes,
      "budget largestShardBytes",
      { min: 1 },
    ),
    shardCount: integer(value.shardCount, "budget shardCount", { min: 1 }),
    projectedMonthlyClassAOperations: integer(
      value.projectedMonthlyClassAOperations,
      "budget projectedMonthlyClassAOperations",
      { min: 0 },
    ),
    projectedMonthlyPublisherClassBOperations: integer(
      value.projectedMonthlyPublisherClassBOperations,
      "budget projectedMonthlyPublisherClassBOperations",
      { min: 0 },
    ),
  };
}

export function evaluateIncrementalServingBudget(
  input: IncrementalServingBudgetInput,
): IncrementalServingBudgetAssessment {
  const failures: string[] = [];
  const measuredDailyRequests = requiredBudgetInteger(
    input,
    "measuredDailyRequests",
    failures,
  );
  const projectedDailyPublisherRequests = requiredBudgetInteger(
    input,
    "projectedDailyPublisherRequests",
    failures,
  );
  requiredBudgetInteger(input, "currentRouteCount", failures, 1);
  requiredBudgetInteger(input, "currentFileCount", failures, 1);
  const storageBytes = requiredBudgetInteger(
    input,
    "currentStorageBytes",
    failures,
  );
  const largestObject = requiredBudgetInteger(
    input,
    "largestRouteObjectBytes",
    failures,
    0,
  );
  const shellBytes = requiredBudgetInteger(input, "shellBytes", failures, 1);
  const largestShard = requiredBudgetInteger(
    input,
    "largestShardBytes",
    failures,
    1,
  );
  const shardCount = requiredBudgetInteger(input, "shardCount", failures, 1);
  const classA = requiredBudgetInteger(
    input,
    "projectedMonthlyClassAOperations",
    failures,
  );
  const publisherClassB = requiredBudgetInteger(
    input,
    "projectedMonthlyPublisherClassBOperations",
    failures,
  );
  const publicClassB =
    measuredDailyRequests === null
      ? Number.NaN
      : measuredDailyRequests
        * BILLING_MONTH_MAX_DAYS
        * R2_READS_PER_SERVED_REQUEST;
  const classB =
    publisherClassB === null || !Number.isFinite(publicClassB)
      ? Number.NaN
      : publisherClassB + publicClassB;

  if (
    measuredDailyRequests !== null &&
    measuredDailyRequests > SAFE_DYNAMIC_DAILY_REQUESTS
  ) {
    failures.push(
      `measuredDailyRequests exceeds safe dynamic budget ${SAFE_DYNAMIC_DAILY_REQUESTS}`,
    );
  }
  if (
    measuredDailyRequests !== null
    && projectedDailyPublisherRequests !== null
    && measuredDailyRequests + projectedDailyPublisherRequests
      > SAFE_TOTAL_WORKER_DAILY_REQUESTS
  ) {
    failures.push(
      `combined public and Publisher Worker requests exceed safe daily budget ${SAFE_TOTAL_WORKER_DAILY_REQUESTS}`,
    );
  }
  if (
    measuredDailyRequests !== null &&
    measuredDailyRequests > WORKERS_DAILY_REQUEST_LIMIT
  ) {
    failures.push(
      `measuredDailyRequests exceeds Workers daily limit ${WORKERS_DAILY_REQUEST_LIMIT}`,
    );
  }
  if (Number.isFinite(classB) && classB > SAFE_R2_CLASS_B_MONTHLY) {
    failures.push(
      `projected Class B operations exceed safe budget ${SAFE_R2_CLASS_B_MONTHLY}`,
    );
  }
  if (Number.isFinite(classB) && classB > R2_CLASS_B_MONTHLY_LIMIT) {
    failures.push(
      `projected Class B operations exceed R2 limit ${R2_CLASS_B_MONTHLY_LIMIT}`,
    );
  }
  if (classA !== null && classA > SAFE_R2_CLASS_A_MONTHLY) {
    failures.push(
      `projected Class A operations exceed safe budget ${SAFE_R2_CLASS_A_MONTHLY}`,
    );
  }
  if (classA !== null && classA > R2_CLASS_A_MONTHLY_LIMIT) {
    failures.push(
      `projected Class A operations exceed R2 limit ${R2_CLASS_A_MONTHLY_LIMIT}`,
    );
  }
  if (storageBytes !== null && storageBytes > SAFE_R2_STORAGE_BYTES) {
    failures.push(
      `currentStorageBytes exceeds safe storage budget ${SAFE_R2_STORAGE_BYTES}`,
    );
  }
  if (storageBytes !== null && storageBytes > R2_STORAGE_LIMIT_BYTES) {
    failures.push(
      `currentStorageBytes exceeds R2 storage limit ${R2_STORAGE_LIMIT_BYTES}`,
    );
  }
  if (largestObject !== null && largestObject > MAX_ROUTE_OBJECT_BYTES) {
    failures.push(
      `largestRouteObjectBytes exceeds ${MAX_ROUTE_OBJECT_BYTES}`,
    );
  }
  if (shellBytes !== null && shellBytes > MAX_SHELL_BYTES) {
    failures.push(`shellBytes exceeds ${MAX_SHELL_BYTES}`);
  }
  if (largestShard !== null && largestShard > MAX_SHARD_BYTES) {
    failures.push(`largestShardBytes exceeds ${MAX_SHARD_BYTES}`);
  }
  if (shardCount !== null && shardCount > MAX_SHARDS) {
    failures.push(`shardCount exceeds ${MAX_SHARDS}`);
  }
  if (
    Number.isSafeInteger(input.currentRouteCount) &&
    Number.isSafeInteger(input.currentFileCount) &&
    input.currentFileCount < input.currentRouteCount
  ) {
    failures.push("currentFileCount must be at least currentRouteCount");
  }

  return {
    ok: failures.length === 0,
    failures,
    projectedMonthlyClassBOperations: classB,
    limits: {
      workersDailyRequests: WORKERS_DAILY_REQUEST_LIMIT,
      workersCpuMs: WORKERS_CPU_LIMIT_MS,
      workersMemoryBytes: WORKERS_MEMORY_LIMIT_BYTES,
      safeDynamicDailyRequests: SAFE_DYNAMIC_DAILY_REQUESTS,
      safeTotalWorkerDailyRequests: SAFE_TOTAL_WORKER_DAILY_REQUESTS,
      r2StorageBytes: R2_STORAGE_LIMIT_BYTES,
      safeR2StorageBytes: SAFE_R2_STORAGE_BYTES,
      r2ClassAMonthly: R2_CLASS_A_MONTHLY_LIMIT,
      safeR2ClassAMonthly: SAFE_R2_CLASS_A_MONTHLY,
      r2ClassBMonthly: R2_CLASS_B_MONTHLY_LIMIT,
      safeR2ClassBMonthly: SAFE_R2_CLASS_B_MONTHLY,
      r2ReadsPerServedRequest: R2_READS_PER_SERVED_REQUEST,
    },
  };
}

export function assertIncrementalServingBudget(
  input: IncrementalServingBudgetInput,
): IncrementalServingBudgetAssessment {
  const assessment = evaluateIncrementalServingBudget(input);
  if (!assessment.ok) {
    throw new IncrementalServingContractError(
      "budget_exceeded",
      assessment.failures.join("; "),
    );
  }
  return assessment;
}
