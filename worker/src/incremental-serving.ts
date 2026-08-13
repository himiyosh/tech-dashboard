import {
  type ActivationRequest,
  type ContentObjectKind,
  INCREMENTAL_SERVE_IMPLEMENTED,
  IncrementalServingContractError,
  MAX_ROUTE_OBJECT_BYTES,
  MAX_SHARD_BYTES,
  MAX_SHELL_BYTES,
  type RollbackRequest,
  type ServingGenerationState,
  TRAFFIC_VERIFICATION_MAX_AGE_MS,
  contentKeyForDigest,
  isContentRoutePath,
  isServeReady,
  maxBytesForContentKind,
  parseActivationRequest,
  parseContentKey,
  parseIncrementalServingMode,
  parseRollbackRequest,
  parseRouteShard,
  parseServingGenerationState,
  readBoundedJsonRequest,
  readBoundedStream,
  boundedContentLength,
  boundedPassthroughStream,
  shardIndexForPath,
} from "./incremental-serving-contract.ts";
import {
  verifyGithubActionsOidcToken,
  type PublisherOidcPolicy,
} from "./free-plan-bridge.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "./publisher-contract.ts";

const DEFAULT_PAGES_FALLBACK_ORIGIN = "https://tech-dashboard-6a7.pages.dev";
const API_PREFIX = "/__incremental-api/v1";
const SHADOW_PREFIX = "/__incremental-shadow";
const DEFAULT_ROUTE_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=60";

const ACTIVE_STATE_SQL = `
SELECT
  state.active_revision,
  state.previous_revision,
  generation.source_commit,
  generation.publisher_fingerprint,
  generation.shell_key,
  generation.shard_keys_json,
  generation.coverage_complete,
  generation.coverage_json,
  generation.measured_daily_requests,
  generation.traffic_verified_at,
  generation.activated_at,
  generation.budget_json
FROM incremental_serving_state AS state
LEFT JOIN incremental_serving_generations AS generation
  ON generation.revision = state.active_revision
WHERE state.singleton = 1
`;

const GENERATION_SQL = `
SELECT
  revision,
  source_commit,
  publisher_fingerprint,
  shell_key,
  shard_keys_json,
  coverage_complete,
  coverage_json,
  measured_daily_requests,
  traffic_verified_at,
  activated_at,
  budget_json
FROM incremental_serving_generations
WHERE revision = ?
`;

const INSERT_GENERATION_SQL = `
INSERT INTO incremental_serving_generations (
  revision,
  source_commit,
  publisher_fingerprint,
  shell_key,
  shard_keys_json,
  coverage_complete,
  coverage_json,
  measured_daily_requests,
  traffic_verified_at,
  budget_json,
  created_at,
  activated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(revision) DO NOTHING
`;

const ACTIVATE_SQL = `
UPDATE incremental_serving_state
SET
  previous_revision = active_revision,
  active_revision = ?,
  updated_at = ?
WHERE singleton = 1 AND active_revision IS ?
`;

const ROLLBACK_SQL = `
UPDATE incremental_serving_state
SET
  active_revision = ?,
  previous_revision = ?,
  updated_at = ?
WHERE singleton = 1
  AND active_revision = ?
  AND previous_revision = ?
`;

export interface IncrementalD1RunResult {
  success: boolean;
  meta?: {
    changes?: number;
  };
  error?: string;
}

export interface IncrementalD1PreparedStatement {
  bind(...values: unknown[]): IncrementalD1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<IncrementalD1RunResult>;
}

export interface IncrementalD1Database {
  prepare(query: string): IncrementalD1PreparedStatement;
}

export interface IncrementalR2Object {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface IncrementalR2Head {
  size: number;
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface IncrementalR2Bucket {
  get(key: string): Promise<IncrementalR2Object | null>;
  head(key: string): Promise<IncrementalR2Head | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<IncrementalR2Head | null>;
}

export interface IncrementalServingEnv {
  INCREMENTAL_OBJECTS?: IncrementalR2Bucket;
  INCREMENTAL_STATE?: IncrementalD1Database;
  INCREMENTAL_SERVING_MODE?: string;
  CUTOVER_APPROVED?: string;
  PAGES_FALLBACK_ORIGIN?: string;
  PUBLISHER_OIDC_AUDIENCE?: string;
  PUBLISHER_REPOSITORY?: string;
  PUBLISHER_WORKFLOW_REF?: string;
}

interface IncrementalServingHandlerOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  verifyToken?: (
    token: string,
    policy: PublisherOidcPolicy,
  ) => Promise<void>;
  createFixedLengthStream?: (length: number) => {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
}

interface GenerationRecord {
  revision: string;
  sourceCommit: string;
  publisherFingerprint: string;
  shellKey: string;
  shardKeys: string[];
  coverageComplete: boolean;
  coverageRouteFamilies: string[];
  measuredDailyRequests: number;
  trafficVerifiedAt: string | null;
  activatedAt: string;
  budgetJson: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  requestMethod = "GET",
): Response {
  const body = JSON.stringify({
    ok: false,
    error: { code, message },
  });
  return new Response(requestMethod === "HEAD" ? null : body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function contractErrorResponse(
  error: unknown,
  requestMethod = "GET",
): Response {
  if (error instanceof IncrementalServingContractError) {
    return errorResponse(error.code, error.message, error.status, requestMethod);
  }
  console.error("[incremental-serving] unexpected error", error);
  return errorResponse(
    "internal_error",
    "Incremental serving request failed",
    500,
    requestMethod,
  );
}

function hasValidBucket(
  bucket: IncrementalR2Bucket | undefined,
): bucket is IncrementalR2Bucket {
  return Boolean(
    bucket &&
      typeof bucket.get === "function" &&
      typeof bucket.head === "function" &&
      typeof bucket.put === "function",
  );
}

function hasValidDatabase(
  database: IncrementalD1Database | undefined,
): database is IncrementalD1Database {
  return Boolean(database && typeof database.prepare === "function");
}

function safeFallbackOrigin(value: string | undefined): URL {
  const candidate = value?.trim() || DEFAULT_PAGES_FALLBACK_ORIGIN;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("fallback origin must be an HTTPS origin");
    }
    return url;
  } catch {
    return new URL(DEFAULT_PAGES_FALLBACK_ORIGIN);
  }
}

function hasValidServingConfig(env: IncrementalServingEnv): boolean {
  if (!env.PAGES_FALLBACK_ORIGIN?.trim()) return true;
  try {
    const url = new URL(env.PAGES_FALLBACK_ORIGIN);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function requestWithPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

async function proxyPagesFallback(
  request: Request,
  env: IncrementalServingEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const fallback = safeFallbackOrigin(env.PAGES_FALLBACK_ORIGIN);
  const source = new URL(request.url);
  source.protocol = fallback.protocol;
  source.hostname = fallback.hostname;
  source.port = fallback.port;
  try {
    return await fetchImpl(new Request(source, request));
  } catch {
    return errorResponse(
      "pages_fallback_unavailable",
      "Pages fallback is unavailable",
      502,
      request.method,
    );
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new IncrementalServingContractError(
      "missing_authorization",
      "Bearer authorization is required",
      401,
    );
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new IncrementalServingContractError(
      "missing_authorization",
      "Bearer authorization is required",
      401,
    );
  }
  return token;
}

function publisherPolicy(env: IncrementalServingEnv): PublisherOidcPolicy {
  const audience = env.PUBLISHER_OIDC_AUDIENCE?.trim();
  const repository = env.PUBLISHER_REPOSITORY?.trim();
  const workflowRef = env.PUBLISHER_WORKFLOW_REF?.trim();
  if (!audience || !repository || !workflowRef) {
    throw new IncrementalServingContractError(
      "oidc_config_missing",
      "Publisher OIDC policy is not configured",
      503,
    );
  }
  return { audience, repository, workflowRef };
}

async function authenticateApiRequest(
  request: Request,
  env: IncrementalServingEnv,
  options: IncrementalServingHandlerOptions,
): Promise<void> {
  const verify =
    options.verifyToken ??
    ((token: string, policy: PublisherOidcPolicy) =>
      verifyGithubActionsOidcToken(token, policy));
  await verify(bearerToken(request), publisherPolicy(env));
}

async function readServingState(
  database: IncrementalD1Database,
): Promise<ServingGenerationState> {
  const row = await database
    .prepare(ACTIVE_STATE_SQL)
    .first<Record<string, unknown>>();
  if (!row) {
    throw new IncrementalServingContractError(
      "state_missing",
      "Incremental serving state row is missing",
      503,
    );
  }
  return parseServingGenerationState(row);
}

function parseGenerationRecord(value: unknown): GenerationRecord {
  if (!isRecord(value)) {
    throw new IncrementalServingContractError(
      "generation_missing",
      "Generation record is missing",
      409,
    );
  }
  const state = parseServingGenerationState({
    active_revision: value.revision,
    previous_revision: null,
    source_commit: value.source_commit,
    publisher_fingerprint: value.publisher_fingerprint,
    shell_key: value.shell_key,
    shard_keys_json: value.shard_keys_json,
    coverage_complete: value.coverage_complete,
    coverage_json: value.coverage_json,
    measured_daily_requests: value.measured_daily_requests,
    traffic_verified_at: value.traffic_verified_at,
    activated_at: value.activated_at,
    budget_json: value.budget_json,
  });
  if (
    !state.activeRevision ||
    !state.sourceCommit ||
    !state.publisherFingerprint ||
    !state.shellKey ||
    state.measuredDailyRequests === null ||
    !state.activatedAt ||
    !state.budget
  ) {
    throw new IncrementalServingContractError(
      "generation_invalid",
      "Generation record is incomplete",
      409,
    );
  }
  return {
    revision: state.activeRevision,
    sourceCommit: state.sourceCommit,
    publisherFingerprint: state.publisherFingerprint,
    shellKey: state.shellKey,
    shardKeys: state.shardKeys,
    coverageComplete: state.coverageComplete,
    coverageRouteFamilies: state.coverageRouteFamilies,
    measuredDailyRequests: state.measuredDailyRequests,
    trafficVerifiedAt: state.trafficVerifiedAt,
    activatedAt: state.activatedAt,
    budgetJson: JSON.stringify(state.budget),
  };
}

async function readGeneration(
  database: IncrementalD1Database,
  revision: string,
): Promise<GenerationRecord> {
  const row = await database
    .prepare(GENERATION_SQL)
    .bind(revision)
    .first<Record<string, unknown>>();
  return parseGenerationRecord(row);
}

function changes(result: IncrementalD1RunResult): number {
  return result.success && Number.isInteger(result.meta?.changes)
    ? Number(result.meta?.changes)
    : 0;
}

async function assertStoredPart(
  bucket: IncrementalR2Bucket,
  key: string,
  kind: "shells" | "shards",
): Promise<number> {
  const content = parseContentKey(key, kind);
  const object = await bucket.head(key);
  if (!object) {
    throw new IncrementalServingContractError(
      "generation_part_missing",
      `Required generation part is missing: ${key}`,
      409,
    );
  }
  const maxBytes = kind === "shells" ? MAX_SHELL_BYTES : MAX_SHARD_BYTES;
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > maxBytes ||
    object.customMetadata?.sha256 !== content.digest
  ) {
    throw new IncrementalServingContractError(
      "generation_part_invalid",
      `Generation part ${key} exceeds its size contract`,
      409,
    );
  }
  return object.size;
}

async function assertStoredGenerationParts(
  bucket: IncrementalR2Bucket,
  shellKey: string,
  shardKeys: readonly string[],
): Promise<{ shellBytes: number; largestShardBytes: number }> {
  const shellBytes = await assertStoredPart(bucket, shellKey, "shells");
  let largestShardBytes = 0;
  for (const key of shardKeys) {
    largestShardBytes = Math.max(
      largestShardBytes,
      await assertStoredPart(bucket, key, "shards"),
    );
  }
  return { shellBytes, largestShardBytes };
}

function generationMatchesActivation(
  generation: GenerationRecord,
  request: ActivationRequest,
): boolean {
  return (
    generation.revision === request.revision &&
    generation.sourceCommit === request.sourceCommit &&
    generation.publisherFingerprint === request.publisherFingerprint &&
    generation.shellKey === request.shellKey &&
    JSON.stringify(generation.shardKeys) === JSON.stringify(request.shardKeys) &&
    generation.coverageComplete === request.coverage.complete &&
    JSON.stringify(generation.coverageRouteFamilies) ===
      JSON.stringify(request.coverage.routeFamilies) &&
    generation.measuredDailyRequests === request.measuredDailyRequests &&
    generation.trafficVerifiedAt === request.trafficVerifiedAt &&
    generation.budgetJson === JSON.stringify(request.budget)
  );
}

async function activateGeneration(
  request: Request,
  env: IncrementalServingEnv,
  nowMs: number,
): Promise<Response> {
  if (!hasValidBucket(env.INCREMENTAL_OBJECTS) || !hasValidDatabase(env.INCREMENTAL_STATE)) {
    throw new IncrementalServingContractError(
      "bindings_missing",
      "Incremental R2 and D1 bindings are required",
      503,
    );
  }
  const activation = parseActivationRequest(
    await readBoundedJsonRequest(request, MAX_SHELL_BYTES),
  );
  if (activation.publisherFingerprint !== DEPLOYED_PUBLISHER_FINGERPRINT) {
    throw new IncrementalServingContractError(
      "publisher_fingerprint_mismatch",
      "Activation publisher fingerprint does not match the deployed runtime",
      409,
    );
  }
  if (activation.revision === activation.expectedActiveRevision) {
    throw new IncrementalServingContractError(
      "activation_noop",
      "Activation revision must differ from the expected active revision",
      409,
    );
  }

  const measured = await assertStoredGenerationParts(
    env.INCREMENTAL_OBJECTS,
    activation.shellKey,
    activation.shardKeys,
  );
  if (
    measured.shellBytes !== activation.budget.shellBytes ||
    measured.largestShardBytes !== activation.budget.largestShardBytes
  ) {
    throw new IncrementalServingContractError(
      "generation_size_mismatch",
      "Measured shell or shard size differs from the activation budget",
      409,
    );
  }

  const activatedAt = new Date(nowMs).toISOString();
  const insert = await env.INCREMENTAL_STATE
    .prepare(INSERT_GENERATION_SQL)
    .bind(
      activation.revision,
      activation.sourceCommit,
      activation.publisherFingerprint,
      activation.shellKey,
      JSON.stringify(activation.shardKeys),
      activation.coverage.complete ? 1 : 0,
      JSON.stringify(activation.coverage.routeFamilies),
      activation.measuredDailyRequests,
      activation.trafficVerifiedAt,
      JSON.stringify(activation.budget),
      activatedAt,
      activatedAt,
    )
    .run();
  if (!insert.success) {
    throw new IncrementalServingContractError(
      "generation_insert_failed",
      "Generation record could not be stored",
      500,
    );
  }
  const stored = await readGeneration(
    env.INCREMENTAL_STATE,
    activation.revision,
  );
  if (!generationMatchesActivation(stored, activation)) {
    throw new IncrementalServingContractError(
      "generation_conflict",
      "Stored immutable generation differs from the activation request",
      409,
    );
  }

  const update = await env.INCREMENTAL_STATE
    .prepare(ACTIVATE_SQL)
    .bind(
      activation.revision,
      activatedAt,
      activation.expectedActiveRevision,
    )
    .run();
  if (changes(update) !== 1) {
    throw new IncrementalServingContractError(
      "active_revision_mismatch",
      "Active revision changed before activation; pointer was not updated",
      409,
    );
  }
  return jsonResponse({
    ok: true,
    state: {
      activeRevision: activation.revision,
      previousRevision: activation.expectedActiveRevision,
      activatedAt,
    },
  });
}

async function rollbackGeneration(
  request: Request,
  env: IncrementalServingEnv,
  nowMs: number,
): Promise<Response> {
  if (!hasValidBucket(env.INCREMENTAL_OBJECTS) || !hasValidDatabase(env.INCREMENTAL_STATE)) {
    throw new IncrementalServingContractError(
      "bindings_missing",
      "Incremental R2 and D1 bindings are required",
      503,
    );
  }
  const rollback: RollbackRequest = parseRollbackRequest(
    await readBoundedJsonRequest(request, MAX_SHELL_BYTES),
  );
  const current = await readServingState(env.INCREMENTAL_STATE);
  if (
    current.activeRevision !== rollback.expectedActiveRevision ||
    !current.previousRevision
  ) {
    throw new IncrementalServingContractError(
      "rollback_revision_mismatch",
      "Stored active/previous revisions do not permit rollback",
      409,
    );
  }
  const previous = await readGeneration(
    env.INCREMENTAL_STATE,
    current.previousRevision,
  );
  await assertStoredGenerationParts(
    env.INCREMENTAL_OBJECTS,
    previous.shellKey,
    previous.shardKeys,
  );
  const rolledBackAt = new Date(nowMs).toISOString();
  const result = await env.INCREMENTAL_STATE
    .prepare(ROLLBACK_SQL)
    .bind(
      current.previousRevision,
      current.activeRevision,
      rolledBackAt,
      current.activeRevision,
      current.previousRevision,
    )
    .run();
  if (changes(result) !== 1) {
    throw new IncrementalServingContractError(
      "rollback_cas_failed",
      "Active revision changed before rollback; pointer was not updated",
      409,
    );
  }
  return jsonResponse({
    ok: true,
    state: {
      activeRevision: current.previousRevision,
      previousRevision: current.activeRevision,
      rolledBackAt,
    },
  });
}

function uploadContentType(
  request: Request,
  kind: ContentObjectKind,
): string {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!contentType || contentType.length > 128 || /[\r\n]/.test(contentType)) {
    throw new IncrementalServingContractError(
      "invalid_content_type",
      "A bounded content-type is required",
    );
  }
  if (
    (kind === "shells" || kind === "shards") &&
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new IncrementalServingContractError(
      "invalid_content_type",
      `${kind} must use application/json`,
    );
  }
  return contentType;
}

async function uploadContent(
  request: Request,
  bucket: IncrementalR2Bucket,
  kind: ContentObjectKind,
  key: string,
  expectedDigest: string,
  createFixedLengthStream: NonNullable<
    IncrementalServingHandlerOptions["createFixedLengthStream"]
  >,
): Promise<Response> {
  const claimedDigest = request.headers.get("x-content-sha256");
  if (claimedDigest !== expectedDigest) {
    throw new IncrementalServingContractError(
      "content_digest_header_mismatch",
      "x-content-sha256 must match the content-addressed key",
    );
  }
  const contentType = uploadContentType(request, kind);
  const byteLength = boundedContentLength(
    request,
    maxBytesForContentKind(kind),
  );
  if (!request.body) {
    throw new IncrementalServingContractError(
      "missing_body",
      "request body is required",
    );
  }
  const existing = await bucket.head(key);
  if (existing) {
    if (
      existing.size !== byteLength
      || existing.customMetadata?.sha256 !== expectedDigest
    ) {
      throw new IncrementalServingContractError(
        "immutable_object_conflict",
        "Existing immutable object has different content metadata",
        409,
      );
    }
    return jsonResponse({
      ok: true,
      key,
      digest: expectedDigest,
      bytes: byteLength,
      reused: true,
    });
  }
  let stored: IncrementalR2Head | null;
  try {
    const fixedLength = createFixedLengthStream(byteLength);
    const [result] = await Promise.all([
      bucket.put(key, fixedLength.readable, {
        httpMetadata: { contentType },
        customMetadata: { sha256: expectedDigest },
        sha256: expectedDigest.slice("sha256:".length),
      }),
      boundedPassthroughStream(
        request.body,
        maxBytesForContentKind(kind),
        byteLength,
      ).pipeTo(fixedLength.writable),
    ]);
    stored = result;
  } catch (error) {
    console.error(
      "[incremental-serving] R2 content write failed",
      error instanceof Error ? error.message : "unknown error",
    );
    throw new IncrementalServingContractError(
      "content_write_failed",
      "R2 rejected or failed the content-addressed write",
      502,
    );
  }
  if (!stored || stored.size !== byteLength) {
    throw new IncrementalServingContractError(
      "content_write_mismatch",
      "R2 did not confirm the streamed content length",
      502,
    );
  }
  return jsonResponse(
    {
      ok: true,
      key,
      digest: expectedDigest,
      bytes: byteLength,
      reused: false,
    },
    201,
  );
}

async function readBackContent(
  request: Request,
  bucket: IncrementalR2Bucket,
  kind: ContentObjectKind,
  key: string,
  expectedDigest: string,
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    throw new IncrementalServingContractError(
      "content_not_found",
      "Content object was not found",
      404,
    );
  }
  const maxBytes = maxBytesForContentKind(kind);
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > maxBytes ||
    object.customMetadata?.sha256 !== expectedDigest
  ) {
    throw new IncrementalServingContractError(
      "stored_content_invalid",
      "Stored content violates its size contract",
      409,
    );
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(object.size),
      "content-type":
        object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: `"${expectedDigest}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleApiRequest(
  request: Request,
  env: IncrementalServingEnv,
  options: IncrementalServingHandlerOptions,
): Promise<Response> {
  try {
    await authenticateApiRequest(request, env, options);
    const url = new URL(request.url);
    const contentMatch = url.pathname.match(
      /^\/__incremental-api\/v1\/content\/(objects|shells|shards)\/sha256\/([a-f0-9]{64})$/,
    );
    if (contentMatch?.[1] && contentMatch[2]) {
      if (!hasValidBucket(env.INCREMENTAL_OBJECTS)) {
        throw new IncrementalServingContractError(
          "bindings_missing",
          "Incremental R2 binding is required",
          503,
        );
      }
      const kind = contentMatch[1] as ContentObjectKind;
      const digest = `sha256:${contentMatch[2]}`;
      const key = contentKeyForDigest(kind, digest);
      if (request.method === "PUT") {
        return await uploadContent(
          request,
          env.INCREMENTAL_OBJECTS,
          kind,
          key,
          digest,
          options.createFixedLengthStream
            ?? ((length) => new FixedLengthStream(length)),
        );
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await readBackContent(
          request,
          env.INCREMENTAL_OBJECTS,
          kind,
          key,
          digest,
        );
      }
      return errorResponse(
        "method_not_allowed",
        "Content API supports PUT, GET, and HEAD",
        405,
        request.method,
      );
    }
    if (url.pathname === `${API_PREFIX}/state` && request.method === "GET") {
      if (!hasValidDatabase(env.INCREMENTAL_STATE)) {
        throw new IncrementalServingContractError(
          "bindings_missing",
          "Incremental D1 binding is required",
          503,
        );
      }
      const state = await readServingState(env.INCREMENTAL_STATE);
      return jsonResponse({
        ok: true,
        mode: parseIncrementalServingMode(env.INCREMENTAL_SERVING_MODE),
        publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        trafficVerificationMaxAgeMs: TRAFFIC_VERIFICATION_MAX_AGE_MS,
        state,
      });
    }
    if (url.pathname === `${API_PREFIX}/activate`) {
      if (request.method !== "POST") {
        return errorResponse(
          "method_not_allowed",
          "Activation requires POST",
          405,
          request.method,
        );
      }
      return await activateGeneration(
        request,
        env,
        options.nowMs ?? Date.now(),
      );
    }
    if (url.pathname === `${API_PREFIX}/rollback`) {
      if (request.method !== "POST") {
        return errorResponse(
          "method_not_allowed",
          "Rollback requires POST",
          405,
          request.method,
        );
      }
      return await rollbackGeneration(
        request,
        env,
        options.nowMs ?? Date.now(),
      );
    }
    return errorResponse(
      "api_not_found",
      "Incremental serving API route was not found",
      404,
      request.method,
    );
  } catch (error) {
    return contractErrorResponse(error, request.method);
  }
}

function tombstoneResponse(
  request: Request,
  revision: string,
  reason: string,
): Response {
  const body = JSON.stringify({
    ok: false,
    error: {
      code: "route_tombstone",
      message: "This content route is no longer addressable",
    },
  });
  return new Response(request.method === "HEAD" ? null : body, {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-techdb-generation": revision,
      "x-techdb-tombstone": reason,
    },
  });
}

async function resolveIncrementalRoute(
  request: Request,
  originalPath: string,
  env: IncrementalServingEnv,
  options: IncrementalServingHandlerOptions,
  requireServeReadiness: boolean,
): Promise<Response | null> {
  if (
    !hasValidBucket(env.INCREMENTAL_OBJECTS) ||
    !hasValidDatabase(env.INCREMENTAL_STATE) ||
    (requireServeReadiness && !hasValidServingConfig(env))
  ) {
    return null;
  }
  let state: ServingGenerationState;
  try {
    state = await readServingState(env.INCREMENTAL_STATE);
  } catch {
    return null;
  }
  if (!state.activeRevision || !state.publisherFingerprint) return null;
  if (
    state.publisherFingerprint !== DEPLOYED_PUBLISHER_FINGERPRINT ||
    (requireServeReadiness &&
      !isServeReady(state, {
        cutoverApproved: env.CUTOVER_APPROVED,
        expectedPublisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        nowMs: options.nowMs,
      }))
  ) {
    return null;
  }

  const shardIndex = await shardIndexForPath(
    originalPath,
    state.shardKeys.length,
  );
  const shardKey = state.shardKeys[shardIndex];
  if (!shardKey) return null;
  let shardObject: IncrementalR2Object | null;
  try {
    shardObject = await env.INCREMENTAL_OBJECTS.get(shardKey);
  } catch {
    return null;
  }
  if (
    !shardObject ||
    !Number.isSafeInteger(shardObject.size) ||
    shardObject.size < 1 ||
    shardObject.size > MAX_SHARD_BYTES
  ) {
    return null;
  }
  let shard;
  try {
    const bytes = await readBoundedStream(
      shardObject.body,
      MAX_SHARD_BYTES,
      shardObject.size,
    );
    shard = parseRouteShard(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
  } catch {
    return null;
  }
  if (
    shard.revision !== state.activeRevision ||
    shard.shardIndex !== shardIndex ||
    shard.shardCount !== state.shardKeys.length
  ) {
    return null;
  }
  const target = shard.routes[originalPath];
  if (!target) return null;
  if (target.status === "tombstone") {
    return tombstoneResponse(
      request,
      state.activeRevision,
      target.reason,
    );
  }

  const language =
    new URL(request.url).searchParams.get("lang") === "en" ? "en" : "ja";
  const objectKey = target.variants[language];
  let object: IncrementalR2Object | null;
  try {
    object = await env.INCREMENTAL_OBJECTS.get(objectKey);
  } catch {
    return null;
  }
  if (
    !object ||
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > MAX_ROUTE_OBJECT_BYTES ||
    object.size !== target.variantBytes[language]
  ) {
    return null;
  }
  const digest = parseContentKey(objectKey, "objects").digest;
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      "cache-control":
        target.cacheControl ?? DEFAULT_ROUTE_CACHE_CONTROL,
      "content-language": language,
      "content-length": String(object.size),
      "content-type": target.contentType,
      etag: `"${digest}"`,
      "x-content-type-options": "nosniff",
      "x-techdb-generation": state.activeRevision,
      "x-techdb-source-commit": state.sourceCommit ?? "",
      "x-techdb-serving-mode": requireServeReadiness ? "serve" : "shadow",
    },
  });
}

export async function handleIncrementalServingRequest(
  request: Request,
  env: IncrementalServingEnv,
  options: IncrementalServingHandlerOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (url.pathname === "/health" && request.method === "GET") {
    const mode = parseIncrementalServingMode(env.INCREMENTAL_SERVING_MODE);
    const bucket = env.INCREMENTAL_OBJECTS;
    const database = env.INCREMENTAL_STATE;
    const bucketReady = hasValidBucket(bucket);
    const databaseReady = hasValidDatabase(database);
    const bindingsReady = bucketReady && databaseReady;
    let state: ServingGenerationState | null = null;
    if (
      (mode === "shadow" || (mode === "serve" && INCREMENTAL_SERVE_IMPLEMENTED))
      && bucketReady
      && databaseReady
    ) {
      try {
        state = await readServingState(database);
      } catch {
        state = null;
      }
    }
    const ready = mode === "off"
      ? true
      : mode === "shadow"
        ? Boolean(state?.activeRevision)
        : INCREMENTAL_SERVE_IMPLEMENTED && Boolean(
          state
          && isServeReady(state, {
            cutoverApproved: env.CUTOVER_APPROVED,
            expectedPublisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
            nowMs: options.nowMs,
          }),
        );
    return jsonResponse({
      ok: ready,
      status: ready
        ? mode === "off"
          ? "incremental-off"
          : `incremental-${mode}`
        : "incremental-not-ready",
      mode,
      bindingsReady,
      publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      activeRevision: state?.activeRevision ?? null,
      sourceCommit: state?.sourceCommit ?? null,
      coverageComplete: state?.coverageComplete ?? false,
      trafficVerificationMaxAgeMs: TRAFFIC_VERIFICATION_MAX_AGE_MS,
    }, ready ? 200 : 503);
  }
  if (url.pathname.startsWith(`${API_PREFIX}/`) || url.pathname === API_PREFIX) {
    return handleApiRequest(request, env, options);
  }

  const mode = parseIncrementalServingMode(env.INCREMENTAL_SERVING_MODE);
  if (mode === "off") {
    return proxyPagesFallback(request, env, fetchImpl);
  }

  if (mode === "shadow") {
    if (
      !url.pathname.startsWith(`${SHADOW_PREFIX}/`) &&
      url.pathname !== SHADOW_PREFIX
    ) {
      return proxyPagesFallback(request, env, fetchImpl);
    }
    const originalPath = url.pathname.slice(SHADOW_PREFIX.length) || "/";
    const originalRequest = requestWithPath(request, originalPath);
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      !isContentRoutePath(originalPath)
    ) {
      return proxyPagesFallback(originalRequest, env, fetchImpl);
    }
    const response = await resolveIncrementalRoute(
      originalRequest,
      originalPath,
      env,
      options,
      false,
    );
    return response ?? proxyPagesFallback(originalRequest, env, fetchImpl);
  }

  if (!INCREMENTAL_SERVE_IMPLEMENTED) {
    return proxyPagesFallback(request, env, fetchImpl);
  }

  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    !isContentRoutePath(url.pathname)
  ) {
    return proxyPagesFallback(request, env, fetchImpl);
  }
  const response = await resolveIncrementalRoute(
    request,
    url.pathname,
    env,
    options,
    true,
  );
  return response ?? proxyPagesFallback(request, env, fetchImpl);
}

export default {
  fetch(
    request: Request,
    env: IncrementalServingEnv,
  ): Promise<Response> {
    return handleIncrementalServingRequest(request, env);
  },
} satisfies ExportedHandler<IncrementalServingEnv>;
