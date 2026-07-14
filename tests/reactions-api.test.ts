import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  handleEnsureReactionIdentity,
  handleGetReactions,
  handlePutReaction,
  verifyTurnstileChallenge,
  type ReactionEnv,
  type ReactionSnapshot,
  type ReactionStore,
} from "../web/functions/_shared/reactions.ts";

const origin = "https://techdb.example";
const articleId = "0123456789abcdef";
const hmacSecret = "test-hmac-secret-with-at-least-32-characters";
const env: ReactionEnv = {
  REACTION_HMAC_SECRET: hmacSecret,
  TURNSTILE_SECRET_KEY: "turnstile-test-secret",
};

class MemoryReactionStore implements ReactionStore {
  readonly votes = new Map<string, Set<string>>();
  readonly seenVoterHashes = new Set<string>();
  readonly rateLimits = new Map<string, { startedAt: number; count: number }>();

  async list(ids: string[], voterHash: string): Promise<ReactionSnapshot[]> {
    return ids.map((id) => ({
      id,
      count: this.votes.get(id)?.size ?? 0,
      liked: voterHash.length > 0 && (this.votes.get(id)?.has(voterHash) ?? false),
    }));
  }

  async consumeRateLimit(
    voterHash: string,
    nowMs: number,
    windowMs: number,
    maxRequests: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const current = this.rateLimits.get(voterHash);
    const record =
      !current || current.startedAt <= nowMs - windowMs
        ? { startedAt: nowMs, count: 1 }
        : { startedAt: current.startedAt, count: current.count + 1 };
    this.rateLimits.set(voterHash, record);
    return {
      allowed: record.count <= maxRequests,
      retryAfterSeconds: Math.max(1, Math.ceil((record.startedAt + windowMs - nowMs) / 1_000)),
    };
  }

  async setLiked(
    id: string,
    voterHash: string,
    liked: boolean,
    _nowMs: number,
  ): Promise<number> {
    this.seenVoterHashes.add(voterHash);
    const voters = this.votes.get(id) ?? new Set<string>();
    if (liked) voters.add(voterHash);
    else voters.delete(voterHash);
    this.votes.set(id, voters);
    return voters.size;
  }
}

function mutationRequest(
  id: string,
  liked: boolean,
  cookie?: string,
  overrides: RequestInit = {},
): Request {
  return new Request(`${origin}/api/reactions/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(overrides.headers ?? {}),
    },
    body: JSON.stringify({
      liked,
      turnstileToken: "turnstile-token",
    }),
    ...overrides,
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";", 1)[0] ?? "";
}

function identityRequest(cookie?: string): Request {
  return new Request(`${origin}/api/reactions/identity`, {
    method: "POST",
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

function dependencies(store: ReactionStore) {
  return {
    store,
    now: () => Date.parse("2026-07-13T12:00:00.000Z"),
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    verifyChallenge: vi.fn(async () => true),
  };
}

async function establishIdentity(
  store: ReactionStore,
  deps = dependencies(store),
): Promise<string> {
  const response = await handleEnsureReactionIdentity(
    identityRequest(),
    env,
    deps,
  );
  expect(response.status).toBe(200);
  const cookie = cookieFrom(response);
  expect(cookie).toMatch(/^__Host-techdb_reaction_voter=/);
  return cookie;
}

describe("anonymous public reactions API", () => {
  it("returns bounded batch counts and the current browser state", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const cookie = await establishIdentity(store, deps);
    const first = await handlePutReaction(
      mutationRequest(articleId, true, cookie),
      env,
      articleId,
      deps,
    );
    expect(first.status).toBe(200);
    expect(deps.verifyChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ siteverifyCredential: "turnstile-test-secret" }),
    );

    const response = await handleGetReactions(
      new Request(`${origin}/api/reactions?ids=${articleId},fedcba9876543210`, {
        headers: { Cookie: cookie },
      }),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reactions: [
        { id: articleId, count: 1, liked: true },
        { id: "fedcba9876543210", count: 0, liked: false },
      ],
    });

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps Turnstile validation scoped to the submitted token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: "article-like",
          hostname: "techdb.example",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await expect(
        verifyTurnstileChallenge({
          token: "one-time-token",
          request: new Request(`${origin}/api/reactions/${articleId}`, {
            headers: { "CF-Connecting-IP": "192.0.2.1" },
          }),
          siteverifyCredential: "turnstile-test-secret",
        }),
      ).resolves.toBe(true);
      const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
      expect(requestBody).toBeInstanceOf(URLSearchParams);
      expect((requestBody as URLSearchParams).get("idempotency_key")).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps repeated desired-state writes idempotent and hashes the voter cookie", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const cookie = await establishIdentity(store, deps);
    const first = await handlePutReaction(
      mutationRequest(articleId, true, cookie),
      env,
      articleId,
      deps,
    );
    const second = await handlePutReaction(
      mutationRequest(articleId, true, cookie),
      env,
      articleId,
      deps,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      reaction: { id: articleId, liked: true, count: 1 },
    });
    expect(store.seenVoterHashes).toHaveLength(1);
    const [storedHash] = store.seenVoterHashes;
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedHash).not.toContain("22222222");
    expect(first.headers.get("Set-Cookie")).toBeNull();
  });

  it("establishes identity without mutating votes and reuses the persisted cookie", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const first = await handleEnsureReactionIdentity(identityRequest(), env, deps);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ identity: { ready: true } });
    const cookie = cookieFrom(first);
    expect(first.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(first.headers.get("Set-Cookie")).toContain("SameSite=Lax");
    expect(first.headers.get("Set-Cookie")).toContain("Secure");

    const second = await handleEnsureReactionIdentity(
      identityRequest(cookie),
      env,
      {
        ...deps,
        randomUUID: () => "33333333-3333-4333-8333-333333333333",
      },
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(store.votes.size).toBe(0);
    expect(store.rateLimits.size).toBe(0);
  });

  it("rejects mutations before identity establishment without changing state", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const response = await handlePutReaction(
      mutationRequest(articleId, true),
      env,
      articleId,
      deps,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "identity_required" },
    });
    expect(deps.verifyChallenge).not.toHaveBeenCalled();
    expect(store.votes.size).toBe(0);
    expect(store.rateLimits.size).toBe(0);
  });

  it("removes the same browser vote without allowing negative counts", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const cookie = await establishIdentity(store, deps);
    const liked = await handlePutReaction(
      mutationRequest(articleId, true, cookie),
      env,
      articleId,
      deps,
    );
    const unliked = await handlePutReaction(
      mutationRequest(articleId, false, cookie),
      env,
      articleId,
      deps,
    );
    const repeated = await handlePutReaction(
      mutationRequest(articleId, false, cookie),
      env,
      articleId,
      deps,
    );
    await expect(unliked.json()).resolves.toEqual({
      reaction: { id: articleId, liked: false, count: 0 },
    });
    await expect(repeated.json()).resolves.toEqual({
      reaction: { id: articleId, liked: false, count: 0 },
    });
  });

  it("rejects cross-origin, malformed, oversized, and unverified mutations", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const crossOrigin = await handlePutReaction(
      mutationRequest(articleId, true, undefined, {
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      }),
      env,
      articleId,
      deps,
    );
    expect(crossOrigin.status).toBe(403);

    const malformed = await handlePutReaction(
      new Request(`${origin}/api/reactions/${articleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ liked: "yes", turnstileToken: "token" }),
      }),
      env,
      articleId,
      deps,
    );
    expect(malformed.status).toBe(400);

    const oversized = await handlePutReaction(
      new Request(`${origin}/api/reactions/${articleId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "5000",
          Origin: origin,
        },
        body: "{}",
      }),
      env,
      articleId,
      deps,
    );
    expect(oversized.status).toBe(413);

    const challengeFailure = await handlePutReaction(
      mutationRequest(articleId, true, await establishIdentity(store, deps)),
      env,
      articleId,
      {
        ...deps,
        verifyChallenge: vi.fn(async () => false),
      },
    );
    expect(challengeFailure.status).toBe(403);
  });

  it("stops reading an oversized streamed body without Content-Length", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const request = new Request(`${origin}/api/reactions/${articleId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: "x".repeat(4_097),
    });
    expect(request.headers.has("Content-Length")).toBe(false);

    const response = await handlePutReaction(request, env, articleId, deps);

    expect(response.status).toBe(413);
    expect(deps.verifyChallenge).not.toHaveBeenCalled();
    expect(store.votes.size).toBe(0);
  });

  it("rate limits mutation bursts before changing another vote", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const cookie = await establishIdentity(store, deps);
    const limitedEnv = { ...env, REACTION_RATE_LIMIT_MAX: "1" };
    const first = await handlePutReaction(
      mutationRequest(articleId, true, cookie),
      limitedEnv,
      articleId,
      deps,
    );
    const second = await handlePutReaction(
      mutationRequest("fedcba9876543210", true, cookie),
      limitedEnv,
      "fedcba9876543210",
      deps,
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("60");
    expect(store.votes.get("fedcba9876543210")?.size ?? 0).toBe(0);
  });

  it("fails closed when required bindings or secrets are absent", async () => {
    const missingDb = await handleGetReactions(
      new Request(`${origin}/api/reactions?ids=${articleId}`),
      env,
    );
    expect(missingDb.status).toBe(503);
    expect(await missingDb.json()).toEqual({
      error: {
        code: "service_not_configured",
        message: "REACTIONS_DB is not configured.",
      },
    });

    const missingTurnstileHydration = await handleGetReactions(
      new Request(`${origin}/api/reactions?ids=${articleId}`),
      { REACTION_HMAC_SECRET: hmacSecret },
      dependencies(new MemoryReactionStore()),
    );
    expect(missingTurnstileHydration.status).toBe(503);

    const missingTurnstile = await handlePutReaction(
      mutationRequest(articleId, true),
      { REACTION_HMAC_SECRET: hmacSecret },
      articleId,
      dependencies(new MemoryReactionStore()),
    );
    expect(missingTurnstile.status).toBe(503);
  });

  it("rejects invalid and oversized batch id lists", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const invalid = await handleGetReactions(
      new Request(`${origin}/api/reactions?ids=not-an-id`),
      env,
      deps,
    );
    expect(invalid.status).toBe(400);

    const ids = Array.from({ length: 51 }, (_, index) =>
      index.toString(16).padStart(16, "0"),
    );
    const oversized = await handleGetReactions(
      new Request(`${origin}/api/reactions?ids=${ids.join(",")}`),
      env,
      deps,
    );
    expect(oversized.status).toBe(400);
  });

  it("uses a composite vote key and bounded per-browser rate-limit state", () => {
    const sql = readFileSync(
      new URL("../web/migrations/0001_reactions.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/PRIMARY KEY\s*\(article_id,\s*voter_hash\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS reaction_rate_limits/i);
    expect(sql).toMatch(/voter_hash TEXT PRIMARY KEY/i);
    expect(sql).toMatch(/WITHOUT ROWID/);
  });
});
