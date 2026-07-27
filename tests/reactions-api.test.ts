import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateReactionConfig,
  handleDeleteReactionIdentity,
  handleEnsureReactionIdentity,
  handleGetReactionConfig,
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
  readonly identities = new Set<string>();
  readonly rateLimits = new Map<string, { startedAt: number; count: number }>();

  async list(ids: string[], voterHash: string): Promise<ReactionSnapshot[]> {
    return ids.map((id) => ({
      id,
      count: this.votes.get(id)?.size ?? 0,
      liked: voterHash.length > 0 && (this.votes.get(id)?.has(voterHash) ?? false),
    }));
  }

  async hasIdentity(voterHash: string): Promise<boolean> {
    return this.identities.has(voterHash);
  }

  async createIdentity(voterHash: string, _nowMs: number): Promise<void> {
    this.identities.add(voterHash);
  }

  async mutateReaction(
    id: string,
    voterHash: string,
    liked: boolean,
    nowMs: number,
    windowMs: number,
    maxRequests: number,
  ): Promise<{
    identityActive: boolean;
    allowed: boolean;
    retryAfterSeconds: number;
    count: number;
  }> {
    if (!this.identities.has(voterHash)) {
      return {
        identityActive: false,
        allowed: false,
        retryAfterSeconds: 1,
        count: this.votes.get(id)?.size ?? 0,
      };
    }
    const current = this.rateLimits.get(voterHash);
    const record =
      !current || current.startedAt <= nowMs - windowMs
        ? { startedAt: nowMs, count: 1 }
        : { startedAt: current.startedAt, count: current.count + 1 };
    this.rateLimits.set(voterHash, record);
    const allowed = record.count <= maxRequests;
    if (allowed) {
      this.seenVoterHashes.add(voterHash);
      const voters = this.votes.get(id) ?? new Set<string>();
      if (liked) voters.add(voterHash);
      else voters.delete(voterHash);
      this.votes.set(id, voters);
    }
    return {
      identityActive: true,
      allowed,
      retryAfterSeconds: Math.max(1, Math.ceil((record.startedAt + windowMs - nowMs) / 1_000)),
      count: this.votes.get(id)?.size ?? 0,
    };
  }

  async deleteVoterData(voterHash: string): Promise<void> {
    this.identities.delete(voterHash);
    for (const voters of this.votes.values()) voters.delete(voterHash);
    this.rateLimits.delete(voterHash);
    this.seenVoterHashes.delete(voterHash);
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

function identityRequest(cookie?: string, method = "POST"): Request {
  return new Request(`${origin}/api/reactions/identity`, {
    method,
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

  it.each([
    ["malformed JSON", new Response("{", { status: 200 })],
    ["a non-object payload", Response.json(["invalid"], { status: 200 })],
    ["an upstream HTTP failure", Response.json({}, { status: 502 })],
  ])("classifies Turnstile %s as temporarily unavailable", async (_label, response) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(
        verifyTurnstileChallenge({
          token: "one-time-token",
          request: new Request(`${origin}/api/reactions/${articleId}`),
          siteverifyCredential: "turnstile-test-secret",
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: "challenge_unavailable",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("classifies a Turnstile response body read failure as temporarily unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("body read failed")),
    } as Response);
    try {
      await expect(
        verifyTurnstileChallenge({
          token: "one-time-token",
          request: new Request(`${origin}/api/reactions/${articleId}`),
          siteverifyCredential: "turnstile-test-secret",
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: "challenge_unavailable",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps a structured Turnstile rejection as a normal failed challenge", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          success: false,
          action: "article-like",
          hostname: "techdb.example",
        },
        { status: 200 },
      ),
    );
    try {
      await expect(
        verifyTurnstileChallenge({
          token: "rejected-token",
          request: new Request(`${origin}/api/reactions/${articleId}`),
          siteverifyCredential: "turnstile-test-secret",
        }),
      ).resolves.toBe(false);
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

  it("deletes the current browser reaction identity, votes, and rate-limit state", async () => {
    const store = new MemoryReactionStore();
    const deps = dependencies(store);
    const cookie = await establishIdentity(store, deps);
    const liked = await handlePutReaction(
      mutationRequest(articleId, true, cookie),
      env,
      articleId,
      deps,
    );
    expect(liked.status).toBe(200);
    expect(store.votes.get(articleId)?.size).toBe(1);
    expect(store.rateLimits.size).toBe(1);

    const response = await handleDeleteReactionIdentity(
      identityRequest(cookie, "DELETE"),
      { REACTION_HMAC_SECRET: hmacSecret },
      deps,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      identity: { ready: false, deleted: true },
    });
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(store.votes.get(articleId)?.size).toBe(0);
    expect(store.rateLimits.size).toBe(0);
    expect(store.identities.size).toBe(0);
  });

  it("keeps reaction identity deletion idempotent when no cookie exists", async () => {
    const response = await handleDeleteReactionIdentity(
      identityRequest(undefined, "DELETE"),
      {},
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      identity: { ready: false, deleted: false },
    });
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("issues a fresh identity when a deleted cookie is presented again", async () => {
    const store = new MemoryReactionStore();
    const firstId = "22222222-2222-4222-8222-222222222222";
    const secondId = "33333333-3333-4333-8333-333333333333";
    const first = await handleEnsureReactionIdentity(
      identityRequest(),
      { REACTION_HMAC_SECRET: hmacSecret },
      {
        store,
        now: () => Date.parse("2026-07-13T12:00:00.000Z"),
        randomUUID: () => firstId,
      },
    );
    const staleCookie = cookieFrom(first);
    expect(staleCookie).toContain(firstId);

    const deletion = await handleDeleteReactionIdentity(
      identityRequest(staleCookie, "DELETE"),
      { REACTION_HMAC_SECRET: hmacSecret },
      { store },
    );
    expect(deletion.status).toBe(200);
    expect(store.identities.size).toBe(0);

    const replacement = await handleEnsureReactionIdentity(
      identityRequest(staleCookie),
      { REACTION_HMAC_SECRET: hmacSecret },
      {
        store,
        now: () => Date.parse("2026-07-13T12:01:00.000Z"),
        randomUUID: () => secondId,
      },
    );
    expect(replacement.status).toBe(200);
    expect(cookieFrom(replacement)).toContain(secondId);
    expect(cookieFrom(replacement)).not.toContain(firstId);
    expect(store.identities.size).toBe(1);
  });

  it("expires an invalid voter cookie without requiring reaction service bindings", async () => {
    const response = await handleDeleteReactionIdentity(
      identityRequest("__Host-techdb_reaction_voter=invalid", "DELETE"),
      {},
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      identity: { ready: false, deleted: false },
    });
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("rejects cross-origin reaction identity deletion before touching storage", async () => {
    const store = new MemoryReactionStore();
    const response = await handleDeleteReactionIdentity(
      new Request(`${origin}/api/reactions/identity`, {
        method: "DELETE",
        headers: { Origin: "https://attacker.example" },
      }),
      { REACTION_HMAC_SECRET: hmacSecret },
      dependencies(store),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "origin_rejected" },
    });
    expect(store.votes.size).toBe(0);
    expect(store.rateLimits.size).toBe(0);
  });

  it("does not recreate votes when deletion wins a concurrent mutation race", async () => {
    class PausedMutationStore extends MemoryReactionStore {
      mutationStartedResolve!: () => void;
      continueMutationResolve!: () => void;
      readonly mutationStarted = new Promise<void>((resolve) => {
        this.mutationStartedResolve = resolve;
      });
      readonly continueMutation = new Promise<void>((resolve) => {
        this.continueMutationResolve = resolve;
      });

      override async mutateReaction(
        id: string,
        voterHash: string,
        liked: boolean,
        nowMs: number,
        windowMs: number,
        maxRequests: number,
      ) {
        this.mutationStartedResolve();
        await this.continueMutation;
        return super.mutateReaction(
          id,
          voterHash,
          liked,
          nowMs,
          windowMs,
          maxRequests,
        );
      }
    }

    const store = new PausedMutationStore();
    const deps = dependencies(store);
    const cookie = await establishIdentity(store, deps);
    const pendingMutation = handlePutReaction(
      mutationRequest(articleId, true, cookie),
      env,
      articleId,
      deps,
    );
    await store.mutationStarted;

    const deletion = await handleDeleteReactionIdentity(
      identityRequest(cookie, "DELETE"),
      { REACTION_HMAC_SECRET: hmacSecret },
      deps,
    );
    expect(deletion.status).toBe(200);
    store.continueMutationResolve();

    const mutation = await pendingMutation;
    expect(mutation.status).toBe(409);
    await expect(mutation.json()).resolves.toMatchObject({
      error: { code: "identity_required" },
    });
    expect(store.identities.size).toBe(0);
    expect(store.votes.get(articleId)?.size ?? 0).toBe(0);
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

    const hydrationWithoutTurnstile = await handleGetReactions(
      new Request(`${origin}/api/reactions?ids=${articleId}`),
      { REACTION_HMAC_SECRET: hmacSecret },
      dependencies(new MemoryReactionStore()),
    );
    expect(hydrationWithoutTurnstile.status).toBe(200);
    await expect(hydrationWithoutTurnstile.json()).resolves.toEqual({
      reactions: [{ id: articleId, count: 0, liked: false }],
    });

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
    const baseSql = readFileSync(
      new URL("../web/migrations/0001_reactions.sql", import.meta.url),
      "utf8",
    );
    const identitySql = readFileSync(
      new URL("../web/migrations/0002_reaction_identities.sql", import.meta.url),
      "utf8",
    );
    expect(baseSql).toMatch(/PRIMARY KEY\s*\(article_id,\s*voter_hash\)/i);
    expect(baseSql).toMatch(/CREATE TABLE IF NOT EXISTS reaction_rate_limits/i);
    expect(baseSql).toMatch(/voter_hash TEXT PRIMARY KEY/i);
    expect(baseSql).toMatch(/WITHOUT ROWID/);
    expect(identitySql).toMatch(/CREATE TABLE IF NOT EXISTS reaction_voters/i);
    expect(identitySql).toMatch(/CREATE INDEX IF NOT EXISTS article_likes_by_voter/i);
    expect(identitySql).toMatch(/ON article_likes\s*\(voter_hash\)/i);
  });
});

describe("boolean-only reaction config health", () => {
  const fullyConfiguredEnv: ReactionEnv = {
    REACTIONS_DB: {
      prepare: () => {
        throw new Error("not used by the config health check");
      },
      batch: () => {
        throw new Error("not used by the config health check");
      },
    },
    REACTION_HMAC_SECRET: "a".repeat(32),
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  };

  it("reports configured:true only when every dependency is present and usable", () => {
    expect(evaluateReactionConfig(fullyConfiguredEnv)).toEqual({
      databaseBinding: true,
      hmacSecret: true,
      turnstileSecret: true,
      publicSiteKey: true,
      configured: true,
    });
  });

  it("flags a too-short HMAC secret as not usable, matching the fail-closed gate", () => {
    const status = evaluateReactionConfig({
      ...fullyConfiguredEnv,
      REACTION_HMAC_SECRET: "too-short",
    });
    expect(status.hmacSecret).toBe(false);
    expect(status.configured).toBe(false);
  });

  it("reports each missing dependency independently (partial configuration)", () => {
    expect(evaluateReactionConfig({})).toEqual({
      databaseBinding: false,
      hmacSecret: false,
      turnstileSecret: false,
      publicSiteKey: false,
      configured: false,
    });
    expect(
      evaluateReactionConfig({
        REACTIONS_DB: fullyConfiguredEnv.REACTIONS_DB,
      }),
    ).toEqual({
      databaseBinding: true,
      hmacSecret: false,
      turnstileSecret: false,
      publicSiteKey: false,
      configured: false,
    });
    expect(
      evaluateReactionConfig({
        REACTIONS_DB: fullyConfiguredEnv.REACTIONS_DB,
        REACTION_HMAC_SECRET: fullyConfiguredEnv.REACTION_HMAC_SECRET,
        TURNSTILE_SECRET_KEY: fullyConfiguredEnv.TURNSTILE_SECRET_KEY,
      }),
    ).toEqual({
      databaseBinding: true,
      hmacSecret: true,
      turnstileSecret: true,
      publicSiteKey: false,
      configured: false,
    });
  });

  it("GET /api/reactions/config responds with the same boolean snapshot", async () => {
    const response = await handleGetReactionConfig(
      new Request("https://techdb.example/api/reactions/config"),
      fullyConfiguredEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      config: {
        databaseBinding: true,
        hmacSecret: true,
        turnstileSecret: true,
        publicSiteKey: true,
        configured: true,
      },
    });
  });

  it("rejects non-GET methods on the config health endpoint", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await handleGetReactionConfig(
        new Request("https://techdb.example/api/reactions/config", { method }),
        fullyConfiguredEnv,
      );
      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "method_not_allowed" },
      });
    }
  });

  it("never echoes secret or key values, even when they contain markers or are absent", async () => {
    const markerEnv: ReactionEnv = {
      REACTIONS_DB: fullyConfiguredEnv.REACTIONS_DB,
      REACTION_HMAC_SECRET: `MARKER-HMAC-${"x".repeat(40)}`,
      TURNSTILE_SECRET_KEY: "MARKER-TURNSTILE-SECRET-VALUE",
      PUBLIC_TURNSTILE_SITE_KEY: "MARKER-PUBLIC-SITE-KEY",
    };
    const response = await handleGetReactionConfig(
      new Request("https://techdb.example/api/reactions/config"),
      markerEnv,
    );
    const rawText = await response.text();
    expect(rawText).not.toContain("MARKER-HMAC");
    expect(rawText).not.toContain("MARKER-TURNSTILE-SECRET-VALUE");
    expect(rawText).not.toContain("MARKER-PUBLIC-SITE-KEY");
    const payload = JSON.parse(rawText) as { config: Record<string, unknown> };
    for (const value of Object.values(payload.config)) {
      expect(typeof value).toBe("boolean");
    }

    const missingEnv: ReactionEnv = {};
    const missingResponse = await handleGetReactionConfig(
      new Request("https://techdb.example/api/reactions/config"),
      missingEnv,
    );
    const missingPayload = (await missingResponse.json()) as { config: Record<string, unknown> };
    for (const value of Object.values(missingPayload.config)) {
      expect(typeof value).toBe("boolean");
    }
  });
});
