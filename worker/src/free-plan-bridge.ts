import type { BodyJob } from "./body-generate.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "./publisher-contract.ts";
import type { SummaryJob } from "./summary-queue.ts";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_AGE_SECONDS = 10 * 60;
const MAX_KV_VALUE_BYTES = 25 * 1024 * 1024;
const MAX_QUEUE_BODY_BYTES = 256 * 1024;
const MAX_QUEUE_MESSAGES = 100;

export interface BridgeKeyValueBinding {
  get(key: string, type: "stream"): Promise<ReadableStream | null>;
  put(
    key: string,
    value: ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface BridgeQueueBinding<T> {
  sendBatch(messages: Array<{ body: T }>): Promise<void>;
}

export interface BridgeEnv {
  SUMMARY_CACHE: BridgeKeyValueBinding;
  SUMMARY_QUEUE: BridgeQueueBinding<SummaryJob>;
  BODY_QUEUE: BridgeQueueBinding<BodyJob>;
  PUBLISHER_OIDC_AUDIENCE: string;
  PUBLISHER_REPOSITORY: string;
  PUBLISHER_WORKFLOW_REF: string;
}

export interface PublisherOidcPolicy {
  audience: string;
  repository: string;
  workflowRef: string;
  nowMs?: number;
}

interface GithubOidcClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  sub?: unknown;
  repository?: unknown;
  repository_owner?: unknown;
  ref?: unknown;
  ref_type?: unknown;
  workflow_ref?: unknown;
  event_name?: unknown;
  sha?: unknown;
}

interface GithubOidcJwk extends JsonWebKey {
  kid?: string;
}

interface JwksDocument {
  keys?: GithubOidcJwk[];
}

interface VerifyOptions {
  fetchImpl?: typeof fetch;
}

interface BridgeHandlerOptions {
  verifyToken?: (
    token: string,
    policy: PublisherOidcPolicy,
  ) => Promise<void>;
}

let jwksCache:
  | {
      expiresAtMs: number;
      keys: GithubOidcJwk[];
    }
  | undefined;
const importedKeys = new Map<string, CryptoKey>();

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function parseJsonPart<T>(value: string, label: string): T {
  try {
    return JSON.parse(
      new TextDecoder().decode(decodeBase64Url(value)),
    ) as T;
  } catch {
    throw new Error(`invalid GitHub OIDC ${label}`);
  }
}

function audienceMatches(aud: unknown, expected: string): boolean {
  return aud === expected || (
    Array.isArray(aud) &&
    aud.length === 1 &&
    aud[0] === expected
  );
}

function requiredString(
  claims: GithubOidcClaims,
  key: keyof GithubOidcClaims,
): string {
  const value = claims[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub OIDC claim ${key} is missing`);
  }
  return value;
}

function requiredNumber(
  claims: GithubOidcClaims,
  key: "exp" | "nbf" | "iat",
): number {
  const value = claims[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GitHub OIDC claim ${key} is missing`);
  }
  return value;
}

function validateClaims(
  claims: GithubOidcClaims,
  policy: PublisherOidcPolicy,
): void {
  const nowSeconds = Math.floor((policy.nowMs ?? Date.now()) / 1000);
  const exp = requiredNumber(claims, "exp");
  const nbf = requiredNumber(claims, "nbf");
  const iat = requiredNumber(claims, "iat");
  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    throw new Error("GitHub OIDC issuer mismatch");
  }
  if (!audienceMatches(claims.aud, policy.audience)) {
    throw new Error("GitHub OIDC audience mismatch");
  }
  if (exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("GitHub OIDC token expired");
  }
  if (nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("GitHub OIDC token is not active");
  }
  if (
    iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    iat < nowSeconds - MAX_TOKEN_AGE_SECONDS
  ) {
    throw new Error("GitHub OIDC token age is invalid");
  }
  if (requiredString(claims, "repository") !== policy.repository) {
    throw new Error("GitHub OIDC repository mismatch");
  }
  const owner = policy.repository.split("/")[0];
  if (requiredString(claims, "repository_owner") !== owner) {
    throw new Error("GitHub OIDC repository owner mismatch");
  }
  if (requiredString(claims, "ref") !== "refs/heads/main") {
    throw new Error("GitHub OIDC ref mismatch");
  }
  if (requiredString(claims, "ref_type") !== "branch") {
    throw new Error("GitHub OIDC ref type mismatch");
  }
  if (requiredString(claims, "workflow_ref") !== policy.workflowRef) {
    throw new Error("GitHub OIDC workflow mismatch");
  }
  const eventName = requiredString(claims, "event_name");
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    throw new Error("GitHub OIDC event is not allowed");
  }
  if (
    requiredString(claims, "sub") !==
    `repo:${policy.repository}:ref:refs/heads/main`
  ) {
    throw new Error("GitHub OIDC subject mismatch");
  }
  if (!/^[0-9a-f]{40}$/i.test(requiredString(claims, "sha"))) {
    throw new Error("GitHub OIDC sha is invalid");
  }
}

async function fetchJwks(
  fetchImpl: typeof fetch,
  forceRefresh: boolean,
): Promise<GithubOidcJwk[]> {
  if (
    !forceRefresh &&
    jwksCache &&
    jwksCache.expiresAtMs > Date.now()
  ) {
    return jwksCache.keys;
  }
  const response = await fetchImpl(GITHUB_OIDC_JWKS_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC JWKS request failed with HTTP ${response.status}`);
  }
  const document = (await response.json()) as JwksDocument;
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new Error("GitHub OIDC JWKS response has no keys");
  }
  jwksCache = {
    expiresAtMs: Date.now() + 5 * 60_000,
    keys: document.keys,
  };
  return document.keys;
}

async function verificationKey(
  kid: string,
  fetchImpl: typeof fetch,
): Promise<CryptoKey> {
  const cached = importedKeys.get(kid);
  if (cached) return cached;
  for (const forceRefresh of [false, true]) {
    const keys = await fetchJwks(fetchImpl, forceRefresh);
    const jwk = keys.find((candidate) => candidate.kid === kid);
    if (!jwk) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    importedKeys.set(kid, key);
    return key;
  }
  throw new Error("GitHub OIDC signing key is unknown");
}

export async function verifyGithubActionsOidcToken(
  token: string,
  policy: PublisherOidcPolicy,
  options: VerifyOptions = {},
): Promise<void> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("invalid GitHub OIDC token");
  }
  const header = parseJsonPart<{ alg?: unknown; kid?: unknown }>(
    parts[0],
    "header",
  );
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("GitHub OIDC signing algorithm is invalid");
  }
  const key = await verificationKey(
    header.kid,
    options.fetchImpl ?? fetch,
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new Error("GitHub OIDC signature is invalid");
  validateClaims(
    parseJsonPart<GithubOidcClaims>(parts[1], "claims"),
    policy,
  );
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("missing bearer token");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new Error("missing bearer token");
  return token;
}

function decodeKvKey(segment: string): string {
  const key = new TextDecoder().decode(decodeBase64Url(segment));
  if (!key || key.length > 512) throw new Error("invalid KV key");
  return key;
}

function canReadKvKey(key: string): boolean {
  return (
    key === "cache.v1" ||
    key === "og.v1" ||
    key === "heartbeat.v1" ||
    key === "summarizer.issue.v1" ||
    key.startsWith("s:") ||
    key.startsWith("b:")
  );
}

function canWriteKvKey(key: string): boolean {
  return key === "og.v1";
}

function contentLength(request: Request, max: number): number {
  const raw = request.headers.get("content-length");
  const length = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(length) || length < 0 || length > max) {
    throw new Error("request body size is invalid");
  }
  return length;
}

function expirationTtl(url: URL): number | undefined {
  const raw = url.searchParams.get("expirationTtl");
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 31_536_000) {
    throw new Error("invalid expirationTtl");
  }
  return value;
}

function isQueueJob(
  value: unknown,
  expectedFingerprint: string,
): value is SummaryJob | BodyJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (
    typeof job.url !== "string" ||
    !/^https?:\/\//.test(job.url) ||
    job.publisherContractFingerprint !== expectedFingerprint ||
    !job.entry ||
    typeof job.entry !== "object"
  ) {
    return false;
  }
  const entry = job.entry as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.url === "string" &&
    entry.url === job.url
  );
}

async function queueMessages(request: Request): Promise<Array<SummaryJob | BodyJob>> {
  contentLength(request, MAX_QUEUE_BODY_BYTES);
  const body = (await request.json()) as { messages?: unknown };
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > MAX_QUEUE_MESSAGES ||
    !body.messages.every((message) =>
      isQueueJob(message, DEPLOYED_PUBLISHER_FINGERPRINT)
    )
  ) {
    throw new Error("invalid queue payload");
  }
  return body.messages;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function handleFreePlanBridgeRequest(
  request: Request,
  env: BridgeEnv,
  options: BridgeHandlerOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    const configured =
      typeof env.SUMMARY_CACHE?.get === "function" &&
      typeof env.SUMMARY_CACHE?.put === "function" &&
      typeof env.SUMMARY_QUEUE?.sendBatch === "function" &&
      typeof env.BODY_QUEUE?.sendBatch === "function" &&
      Boolean(env.PUBLISHER_OIDC_AUDIENCE) &&
      Boolean(env.PUBLISHER_REPOSITORY) &&
      Boolean(env.PUBLISHER_WORKFLOW_REF);
    return jsonResponse({
      ok: configured,
      status: configured ? "bridge" : "bridge-misconfigured",
      mode: "github-actions-publisher",
      scheduled: false,
      publisherWorkflow: ".github/workflows/publisher.yml",
      publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
    }, configured ? 200 : 503);
  }
  if (!url.pathname.startsWith("/v1/")) {
    return jsonResponse({ ok: false, error: "not found" }, 404);
  }

  try {
    const token = bearerToken(request);
    await (
      options.verifyToken ??
      ((value, policy) => verifyGithubActionsOidcToken(value, policy))
    )(token, {
      audience: env.PUBLISHER_OIDC_AUDIENCE,
      repository: env.PUBLISHER_REPOSITORY,
      workflowRef: env.PUBLISHER_WORKFLOW_REF,
    });

    const kvMatch = url.pathname.match(/^\/v1\/kv\/([A-Za-z0-9_-]+)$/);
    if (kvMatch?.[1]) {
      const key = decodeKvKey(kvMatch[1]);
      if (request.method === "GET") {
        if (!canReadKvKey(key)) throw new Error("KV key is not readable");
        const value = await env.SUMMARY_CACHE.get(key, "stream");
        if (!value) return new Response(null, { status: 404 });
        return new Response(value, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      }
      if (request.method === "PUT") {
        if (!canWriteKvKey(key)) throw new Error("KV key is not writable");
        contentLength(request, MAX_KV_VALUE_BYTES);
        if (!request.body) throw new Error("KV value is missing");
        const ttl = expirationTtl(url);
        await env.SUMMARY_CACHE.put(
          key,
          request.body,
          ttl === undefined ? undefined : { expirationTtl: ttl },
        );
        return jsonResponse({ ok: true });
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/queues/summary") {
      const messages = await queueMessages(request) as SummaryJob[];
      await env.SUMMARY_QUEUE.sendBatch(messages.map((body) => ({ body })));
      return jsonResponse({ ok: true, accepted: messages.length });
    }
    if (request.method === "POST" && url.pathname === "/v1/queues/body") {
      const messages = await queueMessages(request) as BodyJob[];
      await env.BODY_QUEUE.sendBatch(messages.map((body) => ({ body })));
      return jsonResponse({ ok: true, accepted: messages.length });
    }
    return jsonResponse({ ok: false, error: "not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[bridge] rejected request: ${message}`);
    return jsonResponse({ ok: false, error: "unauthorized or invalid request" }, 401);
  }
}

export default {
  fetch(request: Request, env: BridgeEnv): Promise<Response> {
    return handleFreePlanBridgeRequest(request, env);
  },
} satisfies ExportedHandler<BridgeEnv>;
