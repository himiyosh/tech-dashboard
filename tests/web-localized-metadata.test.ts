import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_LOCALIZED_META_KEYS,
  handleLocalizedMetadataRequest,
  localizeGeneratedMetadataHtml,
} from "../web/functions/_shared/localized-metadata.ts";
import { onRequestGet as localizeArticleRoute } from "../web/functions/e/[id].ts";
import { onRequestGet as localizeHomeRoute } from "../web/functions/index.ts";

function localizedTag(key: string, ja: string, en: string): string {
  const attribute = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  if (key === "title") {
    return `<title data-meta-key="${key}" data-meta-content-ja="${attribute(ja)}" data-meta-content-en="${attribute(en)}">${ja}</title>`;
  }
  const identity = key === "description"
    ? 'name="description"'
    : key.startsWith("twitter:")
      ? `name="${key}"`
      : `property="${key}"`;
  return `<meta ${identity} content="${attribute(ja)}" data-meta-key="${key}" data-meta-content-ja="${attribute(ja)}" data-meta-content-en="${attribute(en)}">`;
}

function generatedHtml(): string {
  const values = new Map<string, [string, string]>([
    ["title", ["日本語タイトル", 'English "title" & context']],
    ["description", ["日本語の説明", "English description with langgraph>=1.2.2"]],
    ["og:title", ["日本語OG", "English OG"]],
    ["og:description", ["日本語OG説明", "English OG description"]],
    ["og:url", ["https://techdb.example/", "https://techdb.example/?lang=en"]],
    ["og:image:alt", ["日本語画像", "English image"]],
    ["og:locale", ["ja_JP", "en_US"]],
    ["og:locale:alternate", ["en_US", "ja_JP"]],
    ["twitter:title", ["日本語Twitter", "English Twitter"]],
    ["twitter:description", ["日本語Twitter説明", "English Twitter description"]],
    ["twitter:image:alt", ["日本語Twitter画像", "English Twitter image"]],
  ]);
  const tags = REQUIRED_LOCALIZED_META_KEYS.map((key) => {
    const [ja, en] = values.get(key) ?? [key, key];
    return localizedTag(key, ja, en);
  }).join("");
  return `<!doctype html><html lang="ja"><head>${tags}</head><body>content</body></html>`;
}

function metaContent(html: string, key: string): string | null {
  if (key === "title") {
    return html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(
    new RegExp(`<meta\\b(?=[^>]*data-meta-key="${escapedKey}")[^>]*>`, "i"),
  )?.[0];
  return tag?.match(/\scontent="([^"]*)"/i)?.[1] ?? null;
}

describe("crawler-visible localized metadata", () => {
  it("rewrites every localized head field without adding duplicate tags", () => {
    const result = localizeGeneratedMetadataHtml(generatedHtml(), "en");
    expect(result.localizedKeys).toEqual(REQUIRED_LOCALIZED_META_KEYS);
    expect(result.html).toMatch(/<html\b[^>]*lang="en"[^>]*data-lang="en"/);
    expect(metaContent(result.html, "title")).toBe(
      'English "title" &amp; context',
    );
    expect(metaContent(result.html, "description")).toBe(
      "English description with langgraph&gt;=1.2.2",
    );
    expect(metaContent(result.html, "og:url")).toBe(
      "https://techdb.example/?lang=en",
    );
    for (const key of REQUIRED_LOCALIZED_META_KEYS) {
      expect(
        result.html.match(new RegExp(`data-meta-key="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")),
      ).toHaveLength(1);
    }
  });

  it("serves English metadata for an explicit query and preserves the canonical body", async () => {
    const next = vi.fn(async () => new Response(generatedHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"static-ja"',
      },
    }));
    const response = await handleLocalizedMetadataRequest({
      request: new Request("https://techdb.example/?lang=en"),
      next,
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-language")).toBe("en");
    expect(response.headers.get("etag")).toBeNull();
    expect(metaContent(html, "description")).toBe(
      "English description with langgraph&gt;=1.2.2",
    );
    expect(html).toContain("<body>content</body>");
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves default, non-GET, non-HTML, and non-success responses untouched", async () => {
    const cases = [
      new Request("https://techdb.example/"),
      new Request("https://techdb.example/?lang=ja"),
      new Request("https://techdb.example/?lang=en", { method: "HEAD" }),
    ];
    for (const request of cases) {
      const next = vi.fn(async () => new Response("unchanged", {
        headers: { "Content-Type": "text/html" },
      }));
      const response = await handleLocalizedMetadataRequest({ request, next });
      expect(await response.text()).toBe("unchanged");
    }

    const json = await handleLocalizedMetadataRequest({
      request: new Request("https://techdb.example/?lang=en"),
      next: async () => Response.json({ ok: true }),
    });
    expect(await json.json()).toEqual({ ok: true });

    const missing = await handleLocalizedMetadataRequest({
      request: new Request("https://techdb.example/missing?lang=en"),
      next: async () => new Response("missing", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("missing");
  });

  it("fails closed when a localized crawler response is missing required head fields", async () => {
    const response = await handleLocalizedMetadataRequest({
      request: new Request("https://techdb.example/?lang=en"),
      next: async () => new Response(
        '<!doctype html><html><head><title>Incomplete</title></head></html>',
        { headers: { "Content-Type": "text/html" } },
      ),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Localized metadata unavailable");
  });

  it("fails closed when a required localized field is duplicated", async () => {
    const html = generatedHtml().replace(
      "</head>",
      `${localizedTag("og:title", "重複", "Duplicate")}</head>`,
    );
    const response = await handleLocalizedMetadataRequest({
      request: new Request("https://techdb.example/?lang=en"),
      next: async () => new Response(html, {
        headers: { "Content-Type": "text/html" },
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Localized metadata unavailable");
  });

  it("wires both Home and article Pages Function routes to the shared contract", async () => {
    for (const route of [localizeHomeRoute, localizeArticleRoute]) {
      const response = await route({
        request: new Request("https://techdb.example/e/example?lang=en"),
        next: async () => new Response(generatedHtml(), {
          headers: { "Content-Type": "text/html" },
        }),
      });
      expect(response.status).toBe(200);
      expect(metaContent(await response.text(), "description")).toBe(
        "English description with langgraph&gt;=1.2.2",
      );
    }
  });
});
