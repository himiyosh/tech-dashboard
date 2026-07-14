const ARTICLE_ID_RE = /^[a-f0-9]{16}$/;
const VOTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOTER_COOKIE = "__Host-techdb_reaction_voter";
const MAX_BATCH_IDS = 50;
const MAX_BODY_BYTES = 4_096;
const DEFAULT_RATE_LIMIT = 12;
const DEFAULT_RATE_WINDOW_SECONDS = 60;

export interface D1ResultLike<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  error?: string;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>>;
}

export interface ReactionEnv {
  REACTIONS_DB?: D1DatabaseLike;
  REACTION_HMAC_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  REACTION_RATE_LIMIT_MAX?: string;
  REACTION_RATE_LIMIT_WINDOW_SECONDS?: string;
}

export interface ReactionSnapshot {
  id: string;
  count: number;
  liked: boolean;
}

export interface ReactionStore {
  list(ids: string[], voterHash: string): Promise<ReactionSnapshot[]>;
  consumeRateLimit(
    voterHash: string,
    nowMs: number,
    windowMs: number,
    maxRequests: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  setLiked(id: string, voterHash: string, liked: boolean, nowMs: number): Promise<number>;
}

export interface VerifyChallengeInput {
  token: string;
  request: Request;
  siteverifyCredential: string;
}

export interface ReactionDependencies {
  store?: ReactionStore;
  now?: () => number;
  randomUUID?: () => string;
  verifyChallenge?: (input: VerifyChallengeInput) => Promise<boolean>;
}

interface MutationBody {
  liked: boolean;
  turnstileToken: string;
}

interface TurnstileResult {
  success?: boolean;
  action?: string;
  hostname?: string;
}

class ReactionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ReactionApiError) {
    const headers = new Headers();
    if (error.retryAfterSeconds !== undefined) {
      headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      error.status,
      headers,
    );
  }
  console.error(
    "[reactions] unhandled request failure",
    error instanceof Error ? error.message : "unknown error",
  );
  return jsonResponse(
    {
      error: {
        code: "service_unavailable",
        message: "The reaction service is temporarily unavailable.",
      },
    },
    503,
  );
}

function requireSecret(value: string | undefined, name: string, minLength = 1): string {
  const configuredValue = value?.trim() ?? "";
  if (configuredValue.length < minLength) {
    throw new ReactionApiError(
      503,
      "service_not_configured",
      `${name} is not configured.`,
    );
  }
  return configuredValue;
}

function requireStore(env: ReactionEnv, dependencies: ReactionDependencies): ReactionStore {
  if (dependencies.store) return dependencies.store;
  if (!env.REACTIONS_DB) {
    throw new ReactionApiError(
      503,
      "service_not_configured",
      "REACTIONS_DB is not configured.",
    );
  }
  return new D1ReactionStore(env.REACTIONS_DB);
}

function requireReactionService(
  env: ReactionEnv,
  dependencies: ReactionDependencies,
): {
  hmacCredential: string;
  siteverifyCredential: string;
  store: ReactionStore;
} {
  return {
    hmacCredential: requireSecret(env.REACTION_HMAC_SECRET, "REACTION_HMAC_SECRET", 32),
    siteverifyCredential: requireSecret(
      env.TURNSTILE_SECRET_KEY,
      "TURNSTILE_SECRET_KEY",
    ),
    store: requireStore(env, dependencies),
  };
}

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function serializeVoterCookie(voterId: string): string {
  return `${VOTER_COOKIE}=${voterId}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

async function hmacHex(signingMaterial: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveVoter(
  request: Request,
  signingMaterial: string,
  create: boolean,
  randomUUID: () => string,
): Promise<{ hash: string; newCookie: string | null }> {
  let voterId = parseCookie(request, VOTER_COOKIE);
  let newCookie: string | null = null;
  if (!voterId || !VOTER_ID_RE.test(voterId)) {
    if (!create) return { hash: "", newCookie: null };
    voterId = randomUUID();
    if (!VOTER_ID_RE.test(voterId)) {
      throw new ReactionApiError(
        503,
        "identity_unavailable",
        "An anonymous voter identity could not be created.",
      );
    }
    newCookie = serializeVoterCookie(voterId);
  }
  return { hash: await hmacHex(signingMaterial, voterId), newCookie };
}

function parseBatchIds(request: Request): string[] {
  const raw = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new ReactionApiError(400, "invalid_ids", "At least one article id is required.");
  }
  if (ids.length > MAX_BATCH_IDS) {
    throw new ReactionApiError(
      400,
      "invalid_ids",
      `A maximum of ${MAX_BATCH_IDS} article ids is allowed.`,
    );
  }
  if (ids.some((id) => !ARTICLE_ID_RE.test(id))) {
    throw new ReactionApiError(400, "invalid_ids", "Article ids must be 16 lowercase hex characters.");
  }
  return ids;
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ReactionApiError(403, "origin_rejected", "The request origin is not allowed.");
  }
}

async function parseMutationBody(request: Request): Promise<MutationBody> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ReactionApiError(415, "invalid_content_type", "Content-Type must be application/json.");
  }
  const contentLength = request.headers.get("Content-Length");
  const declaredLength = contentLength ? Number(contentLength) : undefined;
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BODY_BYTES
  ) {
    throw new ReactionApiError(413, "payload_too_large", "The request body is too large.");
  }

  if (!request.body) {
    throw new ReactionApiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_BODY_BYTES) {
        await reader.cancel("request body exceeds the configured limit");
        throw new ReactionApiError(413, "payload_too_large", "The request body is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReactionApiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReactionApiError(400, "invalid_payload", "The request payload is invalid.");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["liked", "turnstileToken"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new ReactionApiError(400, "invalid_payload", "The request payload has unknown fields.");
  }
  if (
    typeof record.liked !== "boolean" ||
    typeof record.turnstileToken !== "string" ||
    record.turnstileToken.length === 0 ||
    record.turnstileToken.length > 2_048
  ) {
    throw new ReactionApiError(400, "invalid_payload", "The request payload is invalid.");
  }
  return {
    liked: record.liked,
    turnstileToken: record.turnstileToken,
  };
}

export async function verifyTurnstileChallenge({
  token,
  request,
  siteverifyCredential,
}: VerifyChallengeInput): Promise<boolean> {
  const body = new URLSearchParams();
  body.set("secret", siteverifyCredential);
  body.set("response", token);
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) body.set("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ReactionApiError(
      503,
      "challenge_unavailable",
      "Human verification is temporarily unavailable.",
    );
  }
  if (!response.ok) {
    throw new ReactionApiError(
      503,
      "challenge_unavailable",
      "Human verification is temporarily unavailable.",
    );
  }
  const result = (await response.json()) as TurnstileResult;
  const expectedHostname = new URL(request.url).hostname;
  return (
    result.success === true &&
    result.action === "article-like" &&
    result.hostname === expectedHostname
  );
}

export class D1ReactionStore implements ReactionStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async list(ids: string[], voterHash: string): Promise<ReactionSnapshot[]> {
    const placeholders = ids.map(() => "?").join(",");
    const result = await this.db
      .prepare(
        `SELECT article_id, COUNT(*) AS reaction_count,
          MAX(CASE WHEN voter_hash = ? THEN 1 ELSE 0 END) AS viewer_liked
         FROM article_likes
         WHERE article_id IN (${placeholders})
         GROUP BY article_id`,
      )
      .bind(voterHash, ...ids)
      .all<{ article_id: string; reaction_count: number | string; viewer_liked: number | string }>();
    if (!result.success) {
      throw new Error(result.error || "D1 reaction lookup failed");
    }
    const rows = new Map(
      (result.results ?? []).map((row) => [
        row.article_id,
        {
          count: normalizeCount(row.reaction_count),
          liked: Number(row.viewer_liked) === 1,
        },
      ]),
    );
    return ids.map((id) => ({ id, count: rows.get(id)?.count ?? 0, liked: rows.get(id)?.liked ?? false }));
  }

  async consumeRateLimit(
    voterHash: string,
    nowMs: number,
    windowMs: number,
    maxRequests: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const cutoff = nowMs - windowMs;
    const row = await this.db
      .prepare(
        `INSERT INTO reaction_rate_limits (voter_hash, window_started_at, request_count)
         VALUES (?, ?, 1)
         ON CONFLICT(voter_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN reaction_rate_limits.window_started_at <= ? THEN excluded.window_started_at
             ELSE reaction_rate_limits.window_started_at
           END,
           request_count = CASE
             WHEN reaction_rate_limits.window_started_at <= ? THEN 1
             ELSE reaction_rate_limits.request_count + 1
           END
         RETURNING window_started_at, request_count`,
      )
      .bind(voterHash, nowMs, cutoff, cutoff)
      .first<{ window_started_at: number | string; request_count: number | string }>();
    if (!row) throw new Error("D1 rate-limit update returned no row");
    const startedAt = Number(row.window_started_at);
    const requestCount = normalizeCount(row.request_count);
    const retryAfterSeconds = Math.max(1, Math.ceil((startedAt + windowMs - nowMs) / 1_000));
    return { allowed: requestCount <= maxRequests, retryAfterSeconds };
  }

  async setLiked(id: string, voterHash: string, liked: boolean, nowMs: number): Promise<number> {
    const mutation = liked
      ? this.db
          .prepare(
            `INSERT OR IGNORE INTO article_likes (article_id, voter_hash, created_at)
             VALUES (?, ?, ?)`,
          )
          .bind(id, voterHash, nowMs)
      : this.db
          .prepare("DELETE FROM article_likes WHERE article_id = ? AND voter_hash = ?")
          .bind(id, voterHash);
    const count = this.db
      .prepare("SELECT COUNT(*) AS reaction_count FROM article_likes WHERE article_id = ?")
      .bind(id);
    const results = await this.db.batch<{ reaction_count?: number | string }>([mutation, count]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error(results.find((result) => result.error)?.error || "D1 reaction mutation failed");
    }
    return normalizeCount(results[1]?.results?.[0]?.reaction_count);
  }
}

export async function handleGetReactions(
  request: Request,
  env: ReactionEnv,
  dependencies: ReactionDependencies = {},
): Promise<Response> {
  try {
    if (request.method !== "GET") {
      throw new ReactionApiError(405, "method_not_allowed", "Only GET is allowed.");
    }
    const ids = parseBatchIds(request);
    const { hmacCredential, store } = requireReactionService(env, dependencies);
    const voter = await resolveVoter(
      request,
      hmacCredential,
      false,
      dependencies.randomUUID ?? crypto.randomUUID.bind(crypto),
    );
    const reactions = await store.list(ids, voter.hash);
    return jsonResponse({ reactions });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleEnsureReactionIdentity(
  request: Request,
  env: ReactionEnv,
  dependencies: ReactionDependencies = {},
): Promise<Response> {
  try {
    if (request.method !== "POST") {
      throw new ReactionApiError(405, "method_not_allowed", "Only POST is allowed.");
    }
    assertSameOrigin(request);
    const { hmacCredential } = requireReactionService(env, dependencies);
    const voter = await resolveVoter(
      request,
      hmacCredential,
      true,
      dependencies.randomUUID ?? crypto.randomUUID.bind(crypto),
    );
    const headers = new Headers();
    if (voter.newCookie) headers.set("Set-Cookie", voter.newCookie);
    return jsonResponse({ identity: { ready: true } }, 200, headers);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutReaction(
  request: Request,
  env: ReactionEnv,
  articleId: string,
  dependencies: ReactionDependencies = {},
): Promise<Response> {
  try {
    if (request.method !== "PUT") {
      throw new ReactionApiError(405, "method_not_allowed", "Only PUT is allowed.");
    }
    if (!ARTICLE_ID_RE.test(articleId)) {
      throw new ReactionApiError(
        400,
        "invalid_article_id",
        "Article ids must be 16 lowercase hex characters.",
      );
    }
    assertSameOrigin(request);
    const body = await parseMutationBody(request);
    const { hmacCredential, siteverifyCredential, store } =
      requireReactionService(env, dependencies);
    const voter = await resolveVoter(
      request,
      hmacCredential,
      false,
      dependencies.randomUUID ?? crypto.randomUUID.bind(crypto),
    );
    if (!voter.hash) {
      throw new ReactionApiError(
        409,
        "identity_required",
        "Establish an anonymous reaction identity before changing a reaction.",
      );
    }
    const challengeVerified = await (dependencies.verifyChallenge ?? verifyTurnstileChallenge)({
      token: body.turnstileToken,
      request,
      siteverifyCredential,
    });
    if (!challengeVerified) {
      throw new ReactionApiError(403, "challenge_failed", "Human verification failed.");
    }

    const nowMs = (dependencies.now ?? Date.now)();
    const maxRequests = positiveInteger(env.REACTION_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT);
    const windowMs =
      positiveInteger(
        env.REACTION_RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_RATE_WINDOW_SECONDS,
      ) * 1_000;
    const rateLimit = await store.consumeRateLimit(voter.hash, nowMs, windowMs, maxRequests);
    if (!rateLimit.allowed) {
      throw new ReactionApiError(
        429,
        "rate_limited",
        "Too many reaction changes. Please try again shortly.",
        rateLimit.retryAfterSeconds,
      );
    }

    const count = await store.setLiked(articleId, voter.hash, body.liked, nowMs);
    return jsonResponse({ reaction: { id: articleId, liked: body.liked, count } });
  } catch (error) {
    return errorResponse(error);
  }
}
