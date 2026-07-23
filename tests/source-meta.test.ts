import { describe, expect, it } from "vitest";

import {
  canonicalSourceUrl,
  sourceAuthority,
  sourceLabel,
} from "../web/src/lib/source-meta.ts";

const DEEPMIND_GENESIS_URL =
  "https://deepmind.google/blog/accelerating-the-frontiers-of-scientific-discovery-googles-40m-commitment-to-the-genesis-mission/";
const GOOGLE_CLOUD_GENESIS_URL =
  "https://cloud.google.com/blog/topics/public-sector/accelerating-frontiers-of-scientific-discovery-40-million-dollar-commitment-genesis-mission";

describe("sourceAuthority", () => {
  it("distinguishes provenance from source format", () => {
    expect(sourceAuthority("github-blog-ai", "blog")).toEqual({
      kind: "official",
      ja: "公式",
      en: "Official",
    });
    expect(sourceAuthority("arxiv-cs-ai", "paper").kind).toBe("paper");
    expect(sourceAuthority("zenn-ai", "community").kind).toBe("community");
    expect(sourceAuthority("techcrunch", "blog").kind).toBe("news");
    expect(sourceAuthority("hn-ai", "community").kind).toBe("aggregator");
    expect(sourceAuthority("user-opml", "blog").kind).toBe("aggregator");
  });

  it("does not claim unknown sources are official", () => {
    expect(sourceAuthority("unregistered-feed", "blog")).toEqual({
      kind: "source",
      ja: "出典",
      en: "Source",
    });
  });

  describe("source presentation", () => {
    it("uses a verified canonical publisher without losing the feed label", () => {
      expect(sourceLabel("google-deepmind")).toBe("Google DeepMind Blog");
      expect(sourceLabel("google-deepmind", DEEPMIND_GENESIS_URL)).toBe(
        "Google Cloud Blog",
      );
      expect(canonicalSourceUrl(DEEPMIND_GENESIS_URL)).toBe(
        GOOGLE_CLOUD_GENESIS_URL,
      );
    });

    it("preserves ordinary source URLs and labels", () => {
      const url = "https://deepmind.google/blog/alphagenome-ai-for-better-understanding-the-genome/";
      expect(sourceLabel("google-deepmind", url)).toBe("Google DeepMind Blog");
      expect(canonicalSourceUrl(url)).toBe(url);
    });
  });
});
