import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REACTION_CONFIG_ENDPOINT,
  fetchReactionConfigStatus,
} from "../web/src/lib/reaction-config-client.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("fetchReactionConfigStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the boolean flags on a well-formed 200 response", async () => {
    const flags = {
      databaseBinding: true,
      hmacSecret: true,
      turnstileSecret: true,
      publicSiteKey: true,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(REACTION_CONFIG_ENDPOINT);
      expect(init?.method).toBe("GET");
      return jsonResponse({ config: { ...flags, configured: true } });
    });
    const result = await fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: "resolved", flags });
  });

  it("resolves partial (some flags false) as resolved, not unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        config: {
          databaseBinding: true,
          hmacSecret: false,
          turnstileSecret: false,
          publicSiteKey: false,
          configured: false,
        },
      }),
    );
    const result = await fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch);
    expect(result.state).toBe("resolved");
    if (result.state === "resolved") {
      expect(result.flags.databaseBinding).toBe(true);
      expect(result.flags.hmacSecret).toBe(false);
    }
  });

  it("treats a non-2xx response as unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const result = await fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: "unavailable" });
  });

  it("treats malformed JSON as unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json{", { status: 200 }));
    const result = await fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: "unavailable" });
  });

  it("treats a payload missing the config object as unavailable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notConfig: true }));
    const result = await fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: "unavailable" });
  });

  it("treats a payload with non-boolean flag values as unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        config: {
          databaseBinding: "true",
          hmacSecret: true,
          turnstileSecret: true,
          publicSiteKey: true,
        },
      }),
    );
    const result = await fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: "unavailable" });
  });

  it("treats a network failure as unavailable without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("aborts and resolves unavailable when the endpoint never responds within the timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const pending = fetchReactionConfigStatus(fetchImpl as unknown as typeof fetch, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ state: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
