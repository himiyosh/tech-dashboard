import { readFileSync } from "node:fs";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedEntry } from "../web/src/lib/data.ts";
import type { FeedDecisionDigestEntry } from "../web/src/lib/feed-decision-digest.ts";

const {
  arxivFeedEntries,
  categoryMeta,
  feedEntries,
  knowledgeFeedEntries,
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
    {
      slug: "research",
      name: "Papers / Benchmarks",
      shortLabel: "Papers/Benchmarks",
      color: "#fda4af",
      initial: "Pb",
      emoji: "microscope",
      group: "research",
    },
  ];
  const baseEntry = {
    source: "openai-blog",
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
      evergreen: true,
    },
    {
      ...baseEntry,
      id: "research-report",
      source: "dora-insights",
      url: "https://example.com/research-report",
      titleJa: "Research レポート",
      summaryJa: "選定した Research レポートの要約。",
      category: "research",
      evergreen: true,
    },
    {
      ...baseEntry,
      id: "arxiv-paper",
      source: "arxiv-cs-ai",
      sourceType: "paper",
      url: "https://arxiv.org/abs/2607.01234",
      titleJa: "arXiv 論文",
      summaryJa: "専用 arXiv レーンの論文要約。",
      category: "research",
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
    arxivFeedEntries: feedEntries.filter((entry) => entry.id === "arxiv-paper"),
    categoryMeta,
    feedEntries,
    knowledgeFeedEntries: [feedEntries[1]!, feedEntries[2]!],
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
  ARXIV_FEED_ENTRIES: arxivFeedEntries,
  CATEGORY_META: categoryMeta,
  GENERATED_AT: "2026-01-01T00:00:00.000Z",
  KNOWLEDGE_ENTRIES: knowledgeFeedEntries,
  PUBLISHABLE_ENTRIES: feedEntries,
  summaryForLangWithFallback,
  titleForLangWithFallback,
}));

const { GET: getRss } = await import("../web/src/pages/rss.xml.ts");
const { GET: getArxivRss } = await import("../web/src/pages/rss/arxiv.xml.ts");
const { GET: getKnowledgeRss } = await import("../web/src/pages/rss/knowledge.xml.ts");
const {
  GET: getCategoryRss,
  getStaticPaths: getCategoryRssPaths,
} = await import("../web/src/pages/rss/[category].xml.ts");
const { GET: getJsonFeed } = await import("../web/src/pages/feed.json.ts");
const {
  ARXIV_RSS_HREF,
  KNOWLEDGE_RSS_HREF,
  RSS_ITEM_LIMIT,
  categoryRssHref,
  escapeXml,
  serializeRssFeed,
} = await import("../web/src/lib/rss.ts");
const { buildFeedDecisionDigest } = await import(
  "../web/src/lib/feed-decision-digest.ts"
);
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
const arxivSource = readFileSync(
  new URL("../web/src/pages/arxiv.astro", import.meta.url),
  "utf8",
);
const knowledgeSource = readFileSync(
  new URL("../web/src/pages/knowledge.astro", import.meta.url),
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
  it("builds one reader-facing digest for every source authority kind", () => {
    const summary = '要約 & <確認> "引用" 🚀';
    const base: FeedDecisionDigestEntry = {
      source: "openai-blog",
      sourceType: "blog",
      url: "https://example.com/article",
      title: "Source title",
      titleJa: "出典タイトル",
      titleEn: "Source title",
      summaryJa: summary,
      summaryEn: "Validated English summary.",
      importance: 3,
    };
    const cases = [
      {
        entry: { ...base, source: "openai-blog", sourceType: "blog" },
        source: "OpenAI Blog",
        authority: "公式",
        kind: "official",
      },
      {
        entry: { ...base, source: "arxiv-cs-ai", sourceType: "paper" },
        source: "arXiv cs.AI",
        authority: "論文",
        kind: "paper",
      },
      {
        entry: { ...base, source: "zenn-ai", sourceType: "community" },
        source: "Zenn AI",
        authority: "コミュニティ",
        kind: "community",
      },
      {
        entry: { ...base, source: "techcrunch", sourceType: "blog" },
        source: "TechCrunch",
        authority: "報道",
        kind: "news",
      },
      {
        entry: { ...base, source: "hn-ai", sourceType: "blog" },
        source: "Hacker News - AI coding",
        authority: "集約",
        kind: "aggregator",
      },
      {
        entry: { ...base, source: "custom-unknown", sourceType: "blog" },
        source: "Custom Unknown",
        authority: "出典",
        kind: "source",
      },
    ] as const;

    for (const fixture of cases) {
      const digest = buildFeedDecisionDigest(fixture.entry);
      expect(digest).toMatchObject({
        source: fixture.source,
        authority: {
          kind: fixture.kind,
          ja: fixture.authority,
        },
        importance: 3,
        summary,
        metadata: `出典: ${fixture.source} | 種別: ${fixture.authority} | 重要度: 3/3`,
      });
      expect(digest.text).toBe(
        `出典: ${fixture.source} | 種別: ${fixture.authority} | 重要度: 3/3\n\n${summary}`,
      );
    }

    expect(buildFeedDecisionDigest(cases.at(-1)!.entry).text).not.toContain(
      "custom-unknown",
    );
  });

  it("rejects pending or noisy summaries at the shared feed boundary", () => {
    expect(() =>
      buildFeedDecisionDigest({
        source: "openai-blog",
        sourceType: "blog",
        url: "https://example.com/pending",
        title: "Pending article",
        titleJa: "準備待ちの記事",
        titleEn: "Pending article",
        summaryJa: "AI 要約未生成",
        summaryEn: "AI summary pending",
        importance: 2,
      })
    ).toThrow("requires a validated summary");
  });

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
    expect(portalSource).toContain('rssTitle = "TECH Dashboard site-wide RSS"');
    expect(portalSource).toContain('title="TECH Dashboard site-wide JSON Feed"');
    expect(portalSource).toContain('href={rssHref}');
    expect(portalSource).toContain('title={rssTitle}');
  });

  it("keeps descriptive subscription actions discoverable on mobile", () => {
    expect(pageHeroSource).toContain("mobilePriority?: boolean");
    expect(pageHeroSource).toContain("mediaType?: string");
    expect(pageHeroSource).toContain("type={action.mediaType}");
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
    expect(arxivSource).toContain('label: "arXiv RSSを購読"');
    expect(arxivSource).toContain('labelEn: "Subscribe to arXiv RSS"');
    expect(arxivSource).toContain('mediaType: "application/rss+xml"');
    expect(arxivSource).toContain("mobilePriority: true");
    expect(knowledgeSource).toContain('label: "Knowledge RSSを購読"');
    expect(knowledgeSource).toContain('labelEn: "Subscribe to Knowledge RSS"');
    expect(knowledgeSource).toContain('mediaType: "application/rss+xml"');
    expect(knowledgeSource).toContain("mobilePriority: true");
    expect(portalSource).toContain("サイトの目的・収集方針・RSS購読");
    expect(portalSource).toContain("Purpose, collection policy, and feeds");
    for (const source of categorySources.slice(1)) {
      expect(source).toContain('label: "カテゴリRSS"');
      expect(source).toContain('labelEn: "Category RSS"');
      expect(source).toContain("mobilePriority: true");
    }
  });

  it("builds deterministic category feed URLs without query filtering", () => {
    expect(ARXIV_RSS_HREF).toBe("/rss/arxiv.xml");
    expect(KNOWLEDGE_RSS_HREF).toBe("/rss/knowledge.xml");
    expect(categoryRssHref("agent-fw")).toBe("/rss/agent-fw.xml");
    expect(categoryRssHref("local-llm")).toBe("/rss/local-llm.xml");
    for (const source of categorySources) {
      expect(source).not.toContain("/rss.xml?category=");
      expect(source).toContain("categoryRssHref");
    }
    expect(categorySources[1]).toContain("rssHref={rssHref}");
    expect(categorySources[2]).toContain("rssHref={rssHref}");
    expect(categorySources[1]).toContain('rssTitle={`TECH Dashboard | ${category.name}`}');
    expect(categorySources[2]).toContain('rssTitle={`TECH Dashboard | ${category.name}`}');
    expect(arxivSource).toContain("rssHref={ARXIV_RSS_HREF}");
    expect(arxivSource).toContain('rssTitle="TECH Dashboard | arXiv Papers"');
    expect(knowledgeSource).toContain("rssHref={KNOWLEDGE_RSS_HREF}");
    expect(knowledgeSource).toContain(
      'rssTitle="TECH Dashboard | Knowledge & Best Practices"',
    );
    expect(publicHeaders).toContain(
      "/rss.xml\n  Content-Type: application/rss+xml; charset=utf-8",
    );
    expect(publicHeaders).toContain(
      "/rss/*\n  Content-Type: application/rss+xml; charset=utf-8",
    );
  });

  it("declares the JSON Feed media type at the route and Pages delivery boundaries", async () => {
    const response = (await getJsonFeed({} as never)) as Response;

    expect(response.headers.get("content-type")).toBe(
      "application/feed+json; charset=utf-8",
    );
    expect(publicHeaders).toContain(
      "/feed.json\n  Content-Type: application/feed+json; charset=utf-8",
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
    expect(xml).toContain(
      "<description>出典: OpenAI Blog | 種別: 公式 | 重要度: 2/3\n\n検証済み要約。</description>",
    );
    expect(xml).toContain("<title>TECH Dashboard — AI Daily</title>");
    expect(xml).not.toContain("RAW_TITLE");
    expect(xml).toContain("<category>agent-fw</category>");
    expect(xml).toContain("<category>claude</category>");
    expect(xml.match(/<item>/g)).toHaveLength(feedEntries.length);
    for (const entry of feedEntries) {
      expect(xml).toContain(
        `<description>${escapeXml(buildFeedDecisionDigest(entry).text)}</description>`,
      );
    }
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
    for (const entry of feedEntries.filter((item) => item.category === "agent-fw")) {
      expect(xml).toContain(
        `<description>${escapeXml(buildFeedDecisionDigest(entry).text)}</description>`,
      );
    }
    for (const item of items) {
      expect(item.match(/<category>([^<]+)<\/category>/)?.[1]).toBe(
        "agent-fw",
      );
    }
  });

  it("Research RSS follows the curated listing predicate while global feeds keep arXiv", async () => {
    const response = (await getCategoryRss({
      params: { category: "research" },
    } as never)) as Response;
    const xml = await response.text();

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml.match(/<item>/g)).toHaveLength(1);
    expect(xml).toContain("https://example.com/research-report");
    expect(xml).not.toContain("https://arxiv.org/abs/2607.01234");

    const globalRss = (await getRss({} as never)) as Response;
    expect(await globalRss.text()).toContain("https://arxiv.org/abs/2607.01234");

    const jsonFeed = (await getJsonFeed({} as never)) as Response;
    expect(JSON.stringify(await jsonFeed.json())).toContain(
      "https://arxiv.org/abs/2607.01234",
    );
  });

  it("publishes the dedicated arXiv lane feed from its canonical collection", async () => {
    const response = (await getArxivRss({} as never)) as Response;
    const xml = await response.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(response.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(items).toHaveLength(arxivFeedEntries.length);
    expect(xml).toContain("<title>TECH Dashboard | arXiv Papers</title>");
    expect(xml).toContain("https://arxiv.org/abs/2607.01234");
    expect(xml).not.toContain("https://example.com/research-report");
    expect(xml).toContain(
      `<description>${escapeXml(buildFeedDecisionDigest(arxivFeedEntries[0]!).text)}</description>`,
    );
  });

  it("publishes the dedicated Knowledge lane feed from its canonical collection", async () => {
    const response = (await getKnowledgeRss({} as never)) as Response;
    const xml = await response.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const links = items.map(
      (item) => item.match(/<link>([^<]+)<\/link>/)?.[1] ?? "",
    );

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(response.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(items).toHaveLength(knowledgeFeedEntries.length);
    expect(links).toEqual(knowledgeFeedEntries.map((entry) => entry.url));
    expect(xml).toContain("<title>TECH Dashboard | Knowledge &amp; Best Practices</title>");
    expect(xml).not.toContain("https://example.com/agent-1");
    expect(xml).not.toContain("https://arxiv.org/abs/2607.01234");
    for (const entry of knowledgeFeedEntries) {
      expect(xml).toContain(
        `<description>${escapeXml(buildFeedDecisionDigest(entry).text)}</description>`,
      );
    }
  });

  it("category RSS rejects an unknown category and caps output at 100 items", async () => {
    const invalidResponse = (await getCategoryRss({
      params: { category: "not-a-category" },
    } as never)) as Response;
    expect(invalidResponse.status).toBe(404);
    const arxivResponse = (await getCategoryRss({
      params: { category: "arxiv" },
    } as never)) as Response;
    expect(arxivResponse.status).toBe(404);

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
      summaryJa: "日本語で A > B & B < C を確認。",
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
      description:
        "出典: OpenAI Blog | 種別: 公式 | 重要度: 2/3\n\n日本語で A > B & B < C を確認。",
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
      summary:
        "出典: OpenAI Blog | 種別: 公式 | 重要度: 2/3\n\n検証済み要約。",
      content_text:
        "出典: OpenAI Blog | 種別: 公式 | 重要度: 2/3\n\n検証済み要約。",
      _source: "openai-blog",
      _importance: 2,
    });
    expect(feed.items.map((item: { id: string }) => item.id)).toEqual(
      feedEntries.map((entry) => entry.id),
    );
    expect(JSON.stringify(feed)).not.toContain("RAW_TITLE");
    expect(JSON.stringify(feed)).not.toContain("RAW_SUMMARY");
  });
});
