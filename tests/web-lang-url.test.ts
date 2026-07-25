/**
 * tests/web-lang-url.test.ts
 *
 * web/src/lib/lang-url.ts のピュア関数のユニットテスト。
 * 共有URL言語契約 (?lang=) の解決順序と href/share URL構築を検証する。
 */
import { describe, expect, it } from "vitest";

import {
  hrefWithLang,
  resolveLangFromUrl,
  shareUrlWithLang,
} from "../web/src/lib/lang-url.ts";

describe("resolveLangFromUrl", () => {
  it("prefers an explicit ?lang=en query value over any stored preference", () => {
    expect(resolveLangFromUrl("?lang=en", "ja")).toEqual({ lang: "en", fromUrl: true });
  });

  it("prefers an explicit ?lang=ja query value even when storage says en", () => {
    expect(resolveLangFromUrl("?lang=ja", "en")).toEqual({ lang: "ja", fromUrl: true });
  });

  it("falls back to the stored preference when the URL has no lang param", () => {
    expect(resolveLangFromUrl("?q=copilot", "en")).toEqual({ lang: "en", fromUrl: false });
  });

  it("falls back to ja when there is neither a URL param nor storage", () => {
    expect(resolveLangFromUrl("", null)).toEqual({ lang: "ja", fromUrl: false });
    expect(resolveLangFromUrl("?q=copilot", undefined)).toEqual({ lang: "ja", fromUrl: false });
  });

  it("ignores an unrecognized lang value and falls back safely", () => {
    expect(resolveLangFromUrl("?lang=fr", "en")).toEqual({ lang: "en", fromUrl: false });
    expect(resolveLangFromUrl("?lang=fr", null)).toEqual({ lang: "ja", fromUrl: false });
  });

  it("ignores an unrecognized stored value", () => {
    expect(resolveLangFromUrl("", "xx")).toEqual({ lang: "ja", fromUrl: false });
  });
});

describe("hrefWithLang", () => {
  it("adds lang=en while preserving existing query params and hash", () => {
    expect(hrefWithLang("https://example.com/e/abc/?q=copilot#reactions", "en")).toBe(
      "/e/abc/?q=copilot&lang=en#reactions",
    );
  });

  it("removes lang for ja, keeping other params untouched (default stays clean)", () => {
    expect(hrefWithLang("https://example.com/search?lang=en&q=copilot", "ja")).toBe(
      "/search?q=copilot",
    );
  });

  it("is idempotent: re-applying the same lang does not change the result", () => {
    const once = hrefWithLang("https://example.com/c/copilot/?tag=agent", "en");
    const twice = hrefWithLang(`https://example.com${once}`, "en");
    expect(twice).toBe(once);
  });

  it("does not add a lang param when already ja and none was present", () => {
    expect(hrefWithLang("https://example.com/archive/2026-05/", "ja")).toBe("/archive/2026-05/");
  });
});

describe("shareUrlWithLang", () => {
  it("appends lang=en to a bare canonical URL when en is active", () => {
    expect(shareUrlWithLang("https://techdb.studio344.net/e/abc123/", "en")).toBe(
      "https://techdb.studio344.net/e/abc123/?lang=en",
    );
  });

  it("returns the canonical URL unchanged for ja (default stays clean)", () => {
    expect(shareUrlWithLang("https://techdb.studio344.net/e/abc123/", "ja")).toBe(
      "https://techdb.studio344.net/e/abc123/",
    );
  });
});
