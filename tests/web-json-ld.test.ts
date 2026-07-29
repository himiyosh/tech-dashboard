import { describe, expect, it } from "vitest";

import { serializeJsonLd } from "../web/src/lib/json-ld.ts";

describe("JSON-LD HTML serialization", () => {
  it("keeps parser-sensitive text inside one script element and round-trips the data", () => {
    const value = {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: 'Release </script><script>alert("xss")</script> & follow-up',
      description: "Line separator:\u2028Paragraph separator:\u2029End",
    };

    const serialized = serializeJsonLd(value);
    const scriptBlock = `<script type="application/ld+json">${serialized}</script>`;

    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/u);
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u003cscript\\u003e");
    expect(serialized).toContain("\\u0026");
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
    expect(scriptBlock.match(/<script\b/giu)).toHaveLength(1);
    expect(scriptBlock.match(/<\/script\s*>/giu)).toHaveLength(1);
    expect(JSON.parse(serialized)).toEqual(value);
  });

  it("fails closed when JSON.stringify cannot produce script text", () => {
    expect(() => serializeJsonLd(undefined as never)).toThrow(
      "JSON-LD value could not be serialized",
    );
  });
});
