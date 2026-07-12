import { describe, expect, it } from "vitest";

import { sourceFaviconUrl, sourceHost } from "../web/src/lib/favicon.ts";

describe("source favicon helpers", () => {
  it("normalizes a source host and uses the cookie-free icon endpoint", () => {
    expect(sourceHost("https://www.qiita.com/example")).toBe("qiita.com");
    expect(sourceFaviconUrl("https://www.qiita.com/example")).toBe(
      "https://icons.duckduckgo.com/ip3/qiita.com.ico",
    );
  });

  it("returns an empty value for malformed URLs", () => {
    expect(sourceHost("not a URL")).toBe("");
    expect(sourceFaviconUrl("not a URL")).toBe("");
  });
});
