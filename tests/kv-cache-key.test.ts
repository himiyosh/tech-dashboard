/**
 * Verify cacheKeyForUrl produces the same SHA-256-based key as the
 * migration script's Node createHash path. This is critical: if the two
 * derivations diverge, the harness Worker would never find entries written
 * by scripts/kv-migrate.mjs.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cacheKeyForUrl } from "../worker/src/kv-cache.ts";

function nodeKey(url: string): string {
  return "s:" + createHash("sha256").update(url).digest("hex");
}

describe("cacheKeyForUrl", () => {
  it("returns deterministic 's:' + 64-hex-char key", async () => {
    const k = await cacheKeyForUrl("https://example.com/article");
    expect(k).toMatch(/^s:[0-9a-f]{64}$/);
  });

  it("matches Node.js createHash('sha256') output (migration parity)", async () => {
    const urls = [
      "https://example.com/a",
      "https://qiita.com/user/items/abc123",
      "https://arxiv.org/abs/2605.12345",
      "https://www.theverge.com/2026/05/15/foo-bar",
      "https://日本語ドメイン.example/記事",
    ];
    for (const u of urls) {
      expect(await cacheKeyForUrl(u)).toBe(nodeKey(u));
    }
  });

  it("different URLs produce different keys", async () => {
    const k1 = await cacheKeyForUrl("https://a.example/");
    const k2 = await cacheKeyForUrl("https://b.example/");
    expect(k1).not.toBe(k2);
  });
});
