import { afterEach, describe, expect, it, vi } from "vitest";
import { collectYoutube, youtubeChannel } from "../harness/collectors/youtube.ts";

describe("collectYoutube", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("treats YouTube RSS 404 as an empty optional feed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = youtubeChannel("youtube-anthropic", "YouTube - Anthropic", "missing-channel");
    await expect(collectYoutube(source)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("youtube-anthropic"));
  });

  it("still surfaces non-YouTube feed errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" })),
    );

    await expect(
      collectYoutube({
        id: "non-youtube",
        displayName: "Non YouTube",
        category: "research",
        sourceType: "blog",
        defaultLang: "en",
        autoTags: [],
        feedUrl: "https://example.com/feed.xml",
        tier: 3,
        collect: collectYoutube,
      }),
    ).rejects.toThrow("HTTP 404");
  });
});
