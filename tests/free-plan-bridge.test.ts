import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  handleFreePlanBridgeRequest,
  verifyGithubActionsOidcToken,
} from "../worker/src/free-plan-bridge.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";

const nowMs = Date.parse("2026-07-12T12:00:00.000Z");
const repository = "himiyosh/tech-dashboard";
const workflowRef =
  "himiyosh/tech-dashboard/.github/workflows/publisher.yml@refs/heads/main";
const audience = "tech-dashboard-publisher";
const kid = `test-${Math.random()}`;
let signingKey: CryptoKey;
let jwk: JsonWebKey & { kid: string };

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const header = encoded({ alg: "RS256", kid });
  const payload = encoded({
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    sub: `repo:${repository}:ref:refs/heads/main`,
    repository,
    repository_owner: "himiyosh",
    ref: "refs/heads/main",
    ref_type: "branch",
    workflow_ref: workflowRef,
    event_name: "schedule",
    sha: "a".repeat(40),
    ...overrides,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  signingKey = pair.privateKey;
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
  };
});

describe("Free-plan publisher bridge", () => {
  it("verifies the signature and exact GitHub Actions claims", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ keys: [jwk] }));
    await expect(
      verifyGithubActionsOidcToken(
        await token(),
        { audience, repository, workflowRef, nowMs },
        { fetchImpl },
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyGithubActionsOidcToken(
        await token({ repository: "attacker/repo" }),
        { audience, repository, workflowRef, nowMs },
        { fetchImpl },
      ),
    ).rejects.toThrow(/repository mismatch/);
    await expect(
      verifyGithubActionsOidcToken(
        await token({ event_name: "pull_request" }),
        { audience, repository, workflowRef, nowMs },
        { fetchImpl },
      ),
    ).rejects.toThrow(/event is not allowed/);
  });

  it("exposes public static health without scheduled execution", async () => {
    const response = await handleFreePlanBridgeRequest(
      new Request("https://bridge.example/health"),
      {
        SUMMARY_CACHE: {
          get: async () => null,
          put: async () => undefined,
        },
        SUMMARY_QUEUE: { sendBatch: async () => undefined },
        BODY_QUEUE: { sendBatch: async () => undefined },
        PUBLISHER_OIDC_AUDIENCE: audience,
        PUBLISHER_REPOSITORY: repository,
        PUBLISHER_WORKFLOW_REF: workflowRef,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "bridge",
      mode: "github-actions-publisher",
      scheduled: false,
    });
  });

  it("fails health closed when a required binding is missing", async () => {
    const env = {
      SUMMARY_CACHE: {
        get: async () => null,
        put: async () => undefined,
      },
      SUMMARY_QUEUE: { sendBatch: async () => undefined },
      BODY_QUEUE: { sendBatch: async () => undefined },
      PUBLISHER_OIDC_AUDIENCE: audience,
      PUBLISHER_REPOSITORY: repository,
      PUBLISHER_WORKFLOW_REF: workflowRef,
    };
    expect(Reflect.deleteProperty(env, "BODY_QUEUE")).toBe(true);

    const response = await handleFreePlanBridgeRequest(
      new Request("https://bridge.example/health"),
      env,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "bridge-misconfigured",
      mode: "github-actions-publisher",
    });
  });

  it("allows only fingerprinted queue jobs and allowlisted KV keys", async () => {
    const summarySend = vi.fn(async () => undefined);
    const bodySend = vi.fn(async () => undefined);
    const kvGet = vi.fn(async () => null);
    const kvPut = vi.fn(async () => undefined);
    const env = {
      SUMMARY_CACHE: { get: kvGet, put: kvPut },
      SUMMARY_QUEUE: { sendBatch: summarySend },
      BODY_QUEUE: { sendBatch: bodySend },
      PUBLISHER_OIDC_AUDIENCE: audience,
      PUBLISHER_REPOSITORY: repository,
      PUBLISHER_WORKFLOW_REF: workflowRef,
    };
    const job = {
      url: "https://example.com/article",
      publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      entry: {
        id: "entry-1",
        url: "https://example.com/article",
        title: "Article",
        category: "tech-news",
        source: "example",
        sourceType: "rss",
      },
    };
    const queueBody = JSON.stringify({ messages: [job] });
    const response = await handleFreePlanBridgeRequest(
      new Request("https://bridge.example/v1/queues/summary", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(queueBody)),
        },
        body: queueBody,
      }),
      env,
      { verifyToken: async () => undefined },
    );
    expect(response.status).toBe(200);
    expect(summarySend).toHaveBeenCalledOnce();

    const forbiddenKey = Buffer.from("not-allowed", "utf8").toString("base64url");
    const forbidden = await handleFreePlanBridgeRequest(
      new Request(`https://bridge.example/v1/kv/${forbiddenKey}`, {
        headers: { authorization: "Bearer test-token" },
      }),
      env,
      { verifyToken: async () => undefined },
    );
    expect(forbidden.status).toBe(401);
    expect(kvGet).not.toHaveBeenCalled();

    const heartbeatKey = Buffer.from("heartbeat.v1", "utf8").toString("base64url");
    const forbiddenWrite = await handleFreePlanBridgeRequest(
      new Request(`https://bridge.example/v1/kv/${heartbeatKey}`, {
        method: "PUT",
        headers: {
          authorization: "******",
          "content-length": "2",
          ...{ authorization: "Bearer test-token" },
        },
        body: "{}",
      }),
      env,
      { verifyToken: async () => undefined },
    );
    expect(forbiddenWrite.status).toBe(401);
    expect(kvPut).not.toHaveBeenCalled();
  });
});
