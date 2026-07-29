import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalUrlKey } from "../harness/pipeline/url.ts";
import {
  ARCHIVE_BY_MONTH,
  getMonth,
} from "../web/src/lib/archive.ts";
import {
  COLD_ARCHIVE_SEARCH_PAYLOAD,
  COLD_ARCHIVE_SEARCH_RECORDS,
  COLD_ARCHIVE_SEARCH_SERIALIZED,
} from "../web/src/lib/cold-archive-search.ts";
import {
  canonicalArchiveSearchKey,
  coldArchiveAnchorId,
  coldArchiveRecordMatchesQuery,
  createColdArchiveSearchRecord,
} from "../web/src/lib/cold-archive-search-core.ts";
import { GET } from "../web/src/pages/cold-archive-search.json.ts";

describe("cold archive search core", () => {
  const base = {
    id: "legacy-source-id",
    url: "https://www.example.com/releases/agent?utm_source=feed",
    month: "2026-04",
    archiveTier: "cold" as const,
    titleJa: "エージェント評価の更新",
    titleEn: "Agent evaluation update",
    tags: ["agent", "benchmark"],
    source: "example-releases",
    category: "agent-fw",
    authority: "official" as const,
    importance: 2 as const,
    publishedAt: "2026-04-20T00:00:00.000Z",
  };

  it("derives a stable anchor from canonical URL identity rather than entry id", () => {
    const replacement = {
      ...base,
      id: "replacement-source-id",
      url: "https://example.com/releases/agent",
    };

    expect(canonicalArchiveSearchKey(base.url)).toBe(canonicalUrlKey(base.url));
    expect(canonicalArchiveSearchKey(replacement.url)).toBe(canonicalUrlKey(replacement.url));
    expect(coldArchiveAnchorId(base.url)).toBe(coldArchiveAnchorId(replacement.url));
    expect(coldArchiveAnchorId(base.url)).toMatch(/^archive-entry-[a-f0-9]{16}$/);
  });

  it.each([
    [
      "mobile YouTube alias",
      "https://m.youtube.com/watch?v=x",
      "youtube.com/watch?v=x",
    ],
    [
      "Medium Netflix publication alias",
      "https://medium.com/netflix-techblog/foo?source=rss----2615bd06b42e---4",
      "netflixtechblog.com/foo",
    ],
    [
      "Netflix custom domain",
      "https://netflixtechblog.com/foo/",
      "netflixtechblog.com/foo",
    ],
    [
      "tracking parameters",
      "https://www.example.com/a/?utm_source=x&ref=feed&b=2&a=1",
      "example.com/a?a=1&b=2",
    ],
  ])(
    "keeps fixed canonical parity for %s",
    (_label, input, expected) => {
      expect(canonicalArchiveSearchKey(input)).toBe(expected);
      expect(canonicalUrlKey(input)).toBe(expected);
    },
  );

  it("keeps alias-equivalent URLs on the same stable anchor", () => {
    expect(coldArchiveAnchorId("https://m.youtube.com/watch?v=x")).toBe(
      coldArchiveAnchorId("https://youtube.com/watch?v=x"),
    );
    expect(
      coldArchiveAnchorId(
        "https://medium.com/netflix-techblog/foo?source=rss----2615bd06b42e---4",
      ),
    ).toBe(coldArchiveAnchorId("https://netflixtechblog.com/foo/"));
  });

  it("projects cold entries to their final month anchor and matches title or exact tag", () => {
    const record = createColdArchiveSearchRecord(base);

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      entryId: base.id,
      archiveMonth: "2026-04",
      href: `/archive/2026-04/#${coldArchiveAnchorId(base.url)}`,
      resultKind: "cold-archive",
    });
    expect(coldArchiveRecordMatchesQuery(record!, "評価")).toBe(true);
    expect(coldArchiveRecordMatchesQuery(record!, "agent evaluation")).toBe(true);
    expect(coldArchiveRecordMatchesQuery(record!, "BENCHMARK")).toBe(true);
    expect(coldArchiveRecordMatchesQuery(record!, "bench")).toBe(false);
    expect(coldArchiveRecordMatchesQuery(record!, "unrelated")).toBe(false);
  });

  it("never creates search records for addressable or dropped entries", () => {
    for (const archiveTier of ["hot", "warm", "dropped"] as const) {
      expect(createColdArchiveSearchRecord({ ...base, archiveTier })).toBeNull();
    }
  });

  it("preserves an empty native-language title for truthful client fallback", () => {
    const record = createColdArchiveSearchRecord({
      ...base,
      titleJa: "",
      titleEn: "English-only archive title",
    });

    expect(record?.titleJa).toBe("");
    expect(record?.titleEn).toBe("English-only archive title");
  });
});

describe("actual cold archive search artifact", () => {
  const actualColdEntries = Object.entries(ARCHIVE_BY_MONTH).flatMap(
    ([month, file]) =>
      file.entries
        .filter((entry) => entry.archiveTier === "cold")
        .map((entry) => ({ month, entry })),
  );

  it("indexes every actual cold winner once without reviving its detail route", () => {
    expect(actualColdEntries.length).toBeGreaterThan(0);
    expect(COLD_ARCHIVE_SEARCH_RECORDS).toHaveLength(actualColdEntries.length);

    const anchors = new Set<string>();
    for (const record of COLD_ARCHIVE_SEARCH_RECORDS) {
      expect(record.href).toBe(
        `/archive/${record.archiveMonth}/#${record.anchorId}`,
      );
      expect(record.href).not.toContain("/e/");
      expect(getMonth(record.archiveMonth)?.entries.some(
        (entry) =>
          entry.archiveTier === "cold"
          && coldArchiveAnchorId(entry.url) === record.anchorId,
      )).toBe(true);
      expect(anchors.has(record.anchorId)).toBe(false);
      anchors.add(record.anchorId);
    }
  });

  it("keeps Web anchor identity aligned with the archive publisher canonical key", () => {
    for (const { entry } of actualColdEntries) {
      expect(canonicalArchiveSearchKey(entry.url)).toBe(
        canonicalUrlKey(entry.url),
      );
    }
  });

  it("keeps the client index projected and bounded", () => {
    expect(COLD_ARCHIVE_SEARCH_PAYLOAD.count).toBe(
      COLD_ARCHIVE_SEARCH_RECORDS.length,
    );
    expect(new TextEncoder().encode(COLD_ARCHIVE_SEARCH_SERIALIZED).byteLength)
      .toBeLessThanOrEqual(1_000_000);
    expect(COLD_ARCHIVE_SEARCH_SERIALIZED).not.toMatch(
      /"summaryJa"|"summaryEn"|"bodyJa"|"bodyEn"|"contentSnippet"/,
    );
  });

  it("publishes the exact no-store projection used by the client", async () => {
    const response = GET();

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(
      COLD_ARCHIVE_SEARCH_PAYLOAD,
    );
    const headers = readFileSync(
      new URL("../web/public/_headers", import.meta.url),
      "utf8",
    );
    expect(headers).toMatch(
      /\/cold-archive-search\.json\s+Cache-Control: no-store/,
    );
  });
});
