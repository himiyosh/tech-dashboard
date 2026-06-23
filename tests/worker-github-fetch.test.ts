import { describe, it, expect } from "vitest";

import { fetchWithTimeout, ghFetch } from "../worker/src/index.ts";

// Build a fetch stand-in that replays a fixed sequence of actions. A number is
// an HTTP status (a fresh Response is returned each call so the body is never
// reused); "throw" simulates a network rejection (no response received). The
// last action is repeated for any extra calls so "always 5xx"/"always throw"
// cases need only one entry.
function mockFetch(actions: Array<number | "throw">): {
  impl: typeof fetch;
  count: () => number;
} {
  let i = 0;
  let count = 0;
  const impl = (async () => {
    count++;
    const action = actions[Math.min(i++, actions.length - 1)];
    if (action === "throw") throw new TypeError("network fail");
    return new Response(action >= 500 ? "err" : "ok", { status: action });
  }) as unknown as typeof fetch;
  return { impl, count: () => count };
}

const fast = { backoffMs: () => 0 } as const;

describe("ghFetch (timeout + retry)", () => {
  it("returns the response without retrying on success", async () => {
    const { impl, count } = mockFetch([200]);
    const res = await ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, ...fast });
    expect(res.status).toBe(200);
    expect(count()).toBe(1);
  });

  it("does not retry deterministic 4xx (auth/not-found)", async () => {
    const { impl, count } = mockFetch([404]);
    const res = await ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, ...fast });
    expect(res.status).toBe(404);
    expect(count()).toBe(1);
  });

  it("retries a transient 5xx then succeeds", async () => {
    const { impl, count } = mockFetch([503, 503, 200]);
    const res = await ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, retries: 2, ...fast });
    expect(res.status).toBe(200);
    expect(count()).toBe(3);
  });

  it("retries a 429 rate-limit then succeeds", async () => {
    const { impl, count } = mockFetch([429, 200]);
    const res = await ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, retries: 2, ...fast });
    expect(res.status).toBe(200);
    expect(count()).toBe(2);
  });

  it("returns the final 5xx to the caller after exhausting retries", async () => {
    const { impl, count } = mockFetch([503]); // repeats -> always 503
    const res = await ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, retries: 2, ...fast });
    expect(res.status).toBe(503);
    expect(count()).toBe(3); // attempts 0, 1, 2
  });

  it("retries a network rejection then succeeds", async () => {
    const { impl, count } = mockFetch(["throw", 200]);
    const res = await ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, retries: 2, ...fast });
    expect(res.status).toBe(200);
    expect(count()).toBe(2);
  });

  it("throws after exhausting retries on a persistent network failure", async () => {
    const { impl, count } = mockFetch(["throw"]); // repeats -> always throws
    await expect(
      ghFetch("https://api.github.com/x", {}, "gh test", { fetchImpl: impl, retries: 2, ...fast }),
    ).rejects.toThrow(/network fail/);
    expect(count()).toBe(3);
  });
});

describe("fetchWithTimeout", () => {
  it("returns the response on success", async () => {
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout("https://api.github.com/x", {}, 1000, "gh fast", ok);
    expect(res.status).toBe(200);
  });

  it("throws a labeled timeout error when the request hangs until aborted", async () => {
    // Mimic a hung upstream: only settles when the AbortController fires.
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(
      fetchWithTimeout("https://api.github.com/x", {}, 20, "gh slow", hanging),
    ).rejects.toThrow(/gh slow timeout after 20ms/);
  });
});
