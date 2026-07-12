import { describe, expect, it } from "vitest";

import { sourceAuthority } from "../web/src/lib/source-meta.ts";

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
});
