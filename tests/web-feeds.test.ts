import { readFileSync } from "node:fs";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedEntry } from "../web/src/lib/data.ts";

const {
  categoryMeta,
  feedEntries,
  summaryForLangWithFallback,
  titleForLangWithFallback,
} = vi.hoisted(() => {
  const categoryMeta = [
    {
      slug: "agent-fw",
      name: "Agent Frameworks",
      shortLabel: "Agent Frameworks",
      color: "#34d399",
      initial: "Af",
      emoji: "robot",
      group: "agent-tools",
    },
    {
      slug: "claude",
      name: "Claude / Claude Code",
      shortLabel: "Claude Code",
      color: "#fbbf24",
      initial: "Cl",
      emoji: "orange",
      group: "anthropic",
    },
  ];
  const baseEntry = {
    source: "official-source",
    sourceType: "blog",
    title: "RAW_TITLE",
    titleEn: "Raw title",
    summaryEn: "Raw summary",
    publishedAt: "2026-01-01T00:00:00.000Z",
    collectedAt: "2026-01-01T01:00:00.000Z",
    tags: ["agent"],
    importance: 2,
    lang: "en",
  };
  const feedEntries = [
    {
      ...baseEntry,
      id: "agent-entry-1",
      url: "https://example.com/agent-1",
      titleJa: "検証済みタイトル",
      summaryJa: "検証済み要約。",
      category: "agent-fw",
    },
    {
      ...baseEntry,
      id: "claude-entry",
      url: "https://example.com/claude",
      titleJa: "Claude の検証済みタイトル",
      summaryJa: "Claude の検証済み要約。",
      category: "claude",
    },
    {
      ...baseEntry,
      id: "agent-entry-2",
      url: "https://example.com/agent-2",
      titleJa: "2件目の検証済みタイトル\u0000\u0001\u000b\ud800\ufffe\uffff",
      summaryJa: "2件目の検証済み要約。\u0008\u000c\u001f\udc00",
      category: "agent-fw",
    },
  ];
  return {
    categoryMeta,
    feedEntries,
    titleForLangWithFallback: vi.fn(
      (entry: { titleJa: string }) => ({
        text: entry.titleJa,
        isFallback: false,
      }),
    ),
    summaryForLangWithFallback: vi.fn(
      (entry: { summaryJa: string }) => ({
        text: entry.summaryJa,
        isFallback: false,
      }),
    ),
  };
});

vi.mock("../web/src/lib/data.ts", () => ({
  CATEGORY_META: categoryMeta,
  GENERATED_AT: "2026-01-01T00:00:00.000Z",
  PUBLISHABLE_ENTRIES: feedEntries,
  summaryForLangWithFallback,
  titleForLangWithFallback,
}));

const { GET: getRss } = await import("../web/src/pages/rss.xml.ts");
const {
  GET: getCategoryRss,
  getStaticPaths: getCategoryRssPaths,
} = await import("../web/src/pages/rss/[category].xml.ts");
const { GET: getJsonFeed } = await import("../web/src/pages/feed.json.ts");
const {
  RSS_ITEM_LIMIT,
  categoryRssHref,
  escapeXml,
  serializeRssFeed,
} = await import("../web/src/lib/rss.ts");
const portalSource = readFileSync(
  new URL("../web/src/layouts/Portal.astro", import.meta.url),
  "utf8",
);
const pageHeroSource = readFileSync(
  new URL("../web/src/components/PageHero.astro", import.meta.url),
  "utf8",
);
const portalStyles = readFileSync(
  new URL("../web/src/styles/portal.css", import.meta.url),
  "utf8",
);
const aboutSource = readFileSync(
  new URL("../web/src/pages/about.astro", import.meta.url),
  "utf8",
);
const publicHeaders = readFileSync(
  new URL("../web/public/_headers", import.meta.url),
  "utf8",
);
const categorySources = [
  "../web/src/components/CategoryHero.astro",
  "../web/src/pages/c/[slug].astro",
  "../web/src/pages/c/[slug]/page/[page].astro",
].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));

function alternateLinks(source: string) {
  return [...source.matchAll(/<link\b(?=[^>]*\brel="alternate")[^>]*>/g)].map(
    ([tag]) =>
      Object.fromEntries(
        [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
          name,
          value,
        ]),
      ),
  );
}

describe("public feeds", () => {
  it("shared Portal head advertises each public feed exactly once", () => {
    expect(alternateLinks(portalSource)).toEqual([
      expect.objectContaining({
        rel: "alternate",
        type: "application/rss+xml",
      }),
      expect.objectContaining({
        rel: "alternate",
        type: "application/feed+json",
        href: "/feed.json",
      }),
    ]);
    expect(portalSource).toContain('rssHref = "/rss.xml"');
    expect(portalSource).toContain('href={rssHref}');
  });

  it("keeps descriptive subscription actions discoverable on mobile", () => {
    expect(pageHeroSource).toContain("mobilePriority?: boolean");
    expect(pageHeroSource).toContain('"page-hero-mobile-priority"');
    expect(pageHeroSource).toContain('"has-mobile-priority-actions"');
    expect(pageHeroSource).toContain('"page-hero-action-mobile"');
    expect(pageHeroSource).toContain('const descriptionId = `${headingId}-description`;');
    expect(pageHeroSource).toContain("aria-describedby={descriptionId}");
    expect(pageHeroSource).toContain('id={descriptionId} class="page-hero-description"');
    expect(pageHeroSource).toContain('<span class="i18n-en" lang="en">{descriptionEn}</span>');
    expect(pageHeroSource).not.toContain("data-mobile-priority");
    expect(portalStyles).toMatch(
      /\.page-hero-mobile-priority \.page-hero-description\s*\{[^}]*position:\s*absolute;[^}]*clip-path:\s*inset\(50%\);/s,
    );
    expect(portalStyles).not.toMatch(
      /\.page-hero-mobile-priority \.page-hero-description\s*\{[^}]*display:\s*none;/s,
    );
    expect(aboutSource).toContain('label: "全体RSS"');
    expect(aboutSource).toContain('labelEn: "Site-wide RSS"');
    expect(aboutSource.match(/mobilePriority:\s*true/g)).toHaveLength(2);
    expect(portalSource).toContain("サイトの目的・収集方針・RSS購読");
    expect(portalSource).toContain("Purpose, collection policy, and feeds");
    for (const source of categorySources.slice(1)) {
      expect(source).toContain('label: "カテゴリRSS"');
      expect(source).toContain('labelEn: "Category RSS"');
      expect(source).toContain("mobilePriority: true");
    }
  });

  it("builds deterministic category feed URLs without query filtering", () => {
    expect(categoryRssHref("agent-fw")).toBe("/rss/agent-fw.xml");
    expect(categoryRssHref("local-llm")).toBe("/rss/local-llm.xml");
    for (const source of categorySources) {
      expect(source).not.toContain("/rss.xml?category=");
      expect(source).toContain("categoryRssHref");
    }
    expect(categorySources[1]).toContain("rssHref={rssHref}");
    expect(categorySources[2]).toContain("rssHref={rssHref}");
    expect(publicHeaders).toContain(
      "/rss.xml\n  Content-Type: application/rss+xml; charset=utf-8",
    );
    expect(publicHeaders).toContain(
      "/rss/*\n  Content-Type: application/rss+xml; charset=utf-8",
    );
  });

  it("RSS publishes validated display title and summary", async () => {
    const response = (await getRss({} as never)) as Response;
    const xml = await response.text();

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(response.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(xml).toContain("<title>検証済みタイトル</title>");
    expect(xml).toContain("<description>検証済み要約。</description>");
    expect(xml).toContain("<title>TECH Dashboard — AI Daily</title>");
    expect(xml).not.toContain("RAW_TITLE");
    expect(xml).toContain("<category>agent-fw</category>");
    expect(xml).toContain("<category>claude</category>");
    expect(xml.match(/<item>/g)).toHaveLength(feedEntries.length);
  });

  it("generates one static RSS endpoint for every valid category", () => {
    expect(getCategoryRssPaths()).toEqual(
      categoryMeta.map((category) => ({
        params: { category: category.slug },
      })),
    );
  });

  it("category RSS contains only publishable entries from that category", async () => {
    const response = (await getCategoryRss({
      params: { category: "agent-fw" },
    } as never)) as Response;
    const xml = await response.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(response.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(items).toHaveLength(2);
    expect(xml).toContain("<title>検証済みタイトル</title>");
    expect(xml).toContain("<title>2件目の検証済みタイトル</title>");
    expect(xml).not.toContain("Claude の検証済みタイトル");
    for (const item of items) {
      expect(item.match(/<category>([^<]+)<\/category>/)?.[1]).toBe(
        "agent-fw",
      );
    }
  });

  it("category RSS rejects an unknown category and caps output at 100 items", async () => {
    const invalidResponse = (await getCategoryRss({
      params: { category: "not-a-category" },
    } as never)) as Response;
    expect(invalidResponse.status).toBe(404);

    const entries: NormalizedEntry[] = Array.from(
      { length: RSS_ITEM_LIMIT + 5 },
      (_, index) => ({
        ...feedEntries[0],
        sourceType: "blog",
        category: "agent-fw",
        importance: 2,
        lang: "en",
        id: `capped-${index}`,
        url: `https://example.com/capped-${index}`,
        titleJa: `Capped ${index}`,
      }),
    );
    const xml = serializeRssFeed(entries, {
      title: "Capped feed",
      link: "https://example.com/capped",
      description: "Capped feed description",
      lastBuildDate: "2026-01-01T00:00:00.000Z",
    });
    expect(xml.match(/<item>/g)).toHaveLength(RSS_ITEM_LIMIT);
    expect(xml).toContain("https://example.com/capped-99");
    expect(xml).not.toContain("https://example.com/capped-100");
  });

  it("keeps only XML 1.0 characters before escaping entities", () => {
    const input = [
      "\t\n\r",
      "\u0000\u0001\u0008\u000b\u000c\u001f",
      "\ud800A\udc00",
      "\ufffe\uffff",
      " \ud7ff\ue000\ufffd",
      "\u{10000}\u{1f680}\u{10ffff}",
      "日本語",
      "&<>\"'",
    ].join("");

    expect(escapeXml(input)).toBe(
      [
        "\t\n\r",
        "A",
        " \ud7ff\ue000\ufffd",
        "\u{10000}\u{1f680}\u{10ffff}",
        "日本語",
        "&amp;&lt;&gt;&quot;&apos;",
      ].join(""),
    );
  });

  it("escapes channel and item values into well-formed XML", () => {
    const entry: NormalizedEntry = {
      ...feedEntries[0],
      sourceType: "blog",
      category: "agent-fw",
      importance: 2,
      lang: "en",
      titleJa: 'Agents & tools <release> "verified"',
      summaryJa: "Use A > B & B < C.",
      url: "https://example.com/article?a=1&b=2",
      tags: ["tools & agents", "model <release>"],
    };
    const xml = serializeRssFeed([entry], {
      title: "TECH & AI <Agent feed>",
      link: "https://example.com/category?a=1&b=2",
      description: 'Agent "updates" & \'trusted\' releases',
      lastBuildDate: "2026-01-01T00:00:00.000Z",
    });
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("&apos;");

    const document = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
    }).parse(xml) as {
      rss: {
        channel: {
          title: string;
          link: string;
          description: string;
          item: {
            title: string;
            link: string;
            description: string;
            category: string[];
          };
        };
      };
    };
    const channel = document.rss.channel;
    expect(channel.title).toBe("TECH & AI <Agent feed>");
    expect(channel.link).toBe("https://example.com/category?a=1&b=2");
    expect(channel.description).toBe('Agent "updates" & \'trusted\' releases');
    expect(channel.item).toMatchObject({
      title: 'Agents & tools <release> "verified"',
      link: "https://example.com/article?a=1&b=2",
      description: "Use A > B & B < C.",
      category: ["agent-fw", "tools & agents", "model <release>"],
    });
  });

  it("JSON Feed publishes validated display title and summary", async () => {
    const response = (await getJsonFeed({} as never)) as Response;
    const feed = await response.json();

    expect(response.headers.get("content-type")).toBe(
      "application/feed+json; charset=utf-8",
    );
    expect(feed.items[0]).toMatchObject({
      title: "検証済みタイトル",
      content_text: "検証済み要約。",
    });
    expect(JSON.stringify(feed)).not.toContain("RAW_TITLE");
    expect(JSON.stringify(feed)).not.toContain("RAW_SUMMARY");
  });
});
