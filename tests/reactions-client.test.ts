import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatExactReactionCount,
  formatReactionCount,
  requestReactionJson,
  requestReactionLock,
} from "../web/src/lib/reactions-client.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reaction count formatting", () => {
  it("keeps small values exact and compacts large visible counts", () => {
    expect(formatReactionCount(0)).toBe("0");
    expect(formatReactionCount(999)).toBe("999");
    expect(formatReactionCount(1_000)).toBe("1K");
    expect(formatReactionCount(1_200)).toBe("1.2K");
    expect(formatReactionCount(999_999)).toBe("1M");
    expect(formatReactionCount(1_000_000)).toBe("1M");
    expect(formatReactionCount(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(8);
  });

  it("keeps the localized exact count available to assistive technology", () => {
    expect(formatExactReactionCount(1_234, "ja")).toBe("1,234件");
    expect(formatExactReactionCount(1_234, "en")).toBe("1,234 likes");
  });

  it("normalizes invalid values without exposing unsafe count text", () => {
    expect(formatReactionCount(-1)).toBe("0");
    expect(formatReactionCount(Number.NaN)).toBe("0");
    expect(formatExactReactionCount(Number.POSITIVE_INFINITY, "en")).toBe("0 likes");
  });
});

describe("reaction request deadlines", () => {
  it("bounds both the fetch and response body read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: () => new Promise<unknown>(() => {}),
      }) as unknown as Response),
    );

    const result = requestReactionJson("/api/reactions?ids=0123456789abcdef", {}, 25);
    const assertion = expect(result).rejects.toMatchObject({
      code: "request_timeout",
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("bounds Web Lock acquisition without running the protected callback", async () => {
    vi.useFakeTimers();
    const callback = vi.fn(async () => {});
    const lockManager = {
      request: vi.fn(
        (
          _name: string,
          options: LockOptions,
          _lockCallback: (lock: Lock | null) => Promise<void>,
        ) =>
          new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
          }),
      ),
    } as unknown as LockManager;

    const result = requestReactionLock(lockManager, callback, 25);
    const assertion = expect(result).rejects.toMatchObject({
      code: "request_timeout",
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("reaction toast fallback styling", () => {
  it("keeps the fallback selector independent from the native popover pseudo-class", () => {
    const source = readFileSync(
      new URL("../web/src/components/ArticleLike.astro", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/:global\(\.reaction-toast:popover-open\)\s*\{/);
    expect(source).toMatch(
      /:global\(\.reaction-toast\[data-fallback-open="true"\]\)\s*\{/,
    );
    expect(source).not.toMatch(
      /:popover-open\)\s*,\s*:global\(\.reaction-toast\[data-fallback-open=/,
    );
  });

  it("keeps loading controls inert before client initialization", () => {
    const source = readFileSync(
      new URL("../web/src/components/ArticleLike.astro", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/data-state="loading"\s+aria-hidden="true"\s+inert/);
  });
});
