import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  acquireWriteTransactionLock,
  buildMigrationArchiveMonthPayload,
  buildOriginalLiveAliases,
  buildMigrationStatsPayload,
  dedupeByCanonical,
  migrateArchiveEntries,
  normalizeEntryMediaUrls,
  reconcileBodiesPayload,
  recoverWriteTransaction,
  summarizeChanges,
  synchronizeBodyHealth,
  synchronizeArchiveTagsFromLive,
  validateArchiveMonthInputPayload,
  validateArchiveMonthPayload,
  validateBodiesPayload,
  validateIndexPayload,
  writeJsonTransaction,
} from "../scripts/clean-source-noise.mjs";

function entry(overrides: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return {
    id: "entry-1",
    source: "hn-ai",
    sourceType: "community",
    url: "https://example.com/story",
    title: "Show HN: Agents SDK for coding tools",
    titleJa: "",
    titleEn: "Show HN: Agents SDK for coding tools",
    summaryJa: "",
    summaryEn: "",
    lang: "en",
    publishedAt: "2026-06-29T00:00:00.000Z",
    collectedAt: "2026-06-29T01:00:00.000Z",
    tags: ["community"],
    category: "research",
    importance: 3,
    archiveTier: "hot",
    ...overrides,
  } as NormalizedEntry;
}

function emptyReport() {
  return {
    removed: 0,
    reclassified: 0,
    removedBySource: new Map(),
    removedByCategory: new Map(),
    reclassifiedBySource: new Map(),
    reclassifiedPairs: new Map(),
    keepSamples: new Map(),
    dropSamples: new Map(),
    reclassSamples: new Map(),
  };
}

describe("clean-source-noise validation", () => {
  it("recomputes body retention telemetry from the final index and sidecar", () => {
    expect(synchronizeBodyHealth(
      {
        bodyEnqueueCap: 24,
        bodyBacklog: 208,
        bodyQueueDrainEstimateHours: 9,
        bodyRetentionEligible: 1479,
        bodiesTotal: 1257,
      },
      1476,
      1257,
      208,
    )).toEqual({
      bodyEnqueueCap: 24,
      bodyBacklog: 208,
      bodyQueueDrainEstimateHours: 9,
      bodyRetentionEligible: 1476,
      bodiesTotal: 1257,
    });
  });

  it("backfills observed body enqueue count from the same-run shared total", () => {
    expect(synchronizeBodyHealth(
      {
        summaryQueueEnqueued: 1,
        enrichmentEnqueued: 20,
        bodyEnqueueCandidates: 19,
        bodyEnqueueCap: 34,
      },
      100,
      80,
      20,
    )).toMatchObject({
      summaryQueueEnqueued: 1,
      enrichmentEnqueued: 20,
      bodyEnqueued: 19,
    });
    expect(synchronizeBodyHealth(
      {
        summaryQueueEnqueued: 1,
        enrichmentEnqueued: 20,
        bodyEnqueued: 18,
        bodyEnqueueCap: 34,
      },
      100,
      80,
      20,
    )).toMatchObject({
      bodyEnqueued: 18,
    });
  });

  it("normalizes persisted media URL fields without dropping image metadata", () => {
    const normalized = normalizeEntryMediaUrls(
      entry({
        image: {
          src: "https://cdn.example/a.jpg?x=1&amp;amp;y=2",
          origSrc: "https://cdn.example/a.jpg?x=1&#38;y=2",
          alt: "Preview",
          width: 640,
          height: 360,
          source: "media",
        },
      }),
    );

    expect(normalized.image).toEqual({
      src: "https://cdn.example/a.jpg?x=1&y=2",
      origSrc: "https://cdn.example/a.jpg?x=1&y=2",
      alt: "Preview",
      width: 640,
      height: 360,
      source: "media",
    });
  });

  it("rejects malformed index payloads before any write path", () => {
    expect(() => validateIndexPayload({ generatedAt: "not-iso", entries: [] }, "index.json")).toThrow(
      "index.json.generatedAt must be a valid ISO timestamp",
    );
  });

  it("rejects archive months without an entries array", () => {
    expect(() =>
      validateArchiveMonthPayload(
        { generatedAt: "2026-07-01T00:00:00.000Z", month: "2026-07" },
        "archive/2026-07.json",
      )
    ).toThrow("archive/2026-07.json.entries must be an array");
  });

  it("accepts repairable warm/cold summary gaps on archive input but still rejects unrelated malformed fields", () => {
    expect(() =>
      validateArchiveMonthInputPayload(
        {
          generatedAt: "2026-07-01T00:00:00.000Z",
          month: "2026-07",
          entries: [entry({ archiveTier: "warm", summaryJa: "", summaryEn: "English summary" })],
        },
        "archive/2026-07.json",
      )
    ).not.toThrow();

    expect(() =>
      validateArchiveMonthInputPayload(
        {
          generatedAt: "2026-07-01T00:00:00.000Z",
          month: "2026-07",
          entries: [entry({ importance: 99 as 1, archiveTier: "warm", summaryJa: "", summaryEn: "English summary" })],
        },
        "archive/2026-07.json",
      )
    ).toThrow("archive/2026-07.json.entries[0].importance must be 1, 2, or 3");
  });

  it("validates bodies payload shape while allowing count to be recomputed", () => {
    const payload = validateBodiesPayload({
      generatedAt: "2026-07-01T00:00:00.000Z",
      count: 99,
      bodies: {
        keep: {
          bodyJa: "ja",
          bodyEn: "en",
          model: "claude-opus-4.8",
          generatedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    });
    expect(payload.count).toBe(1);
  });

  it.each([
    ["importance", entry({ importance: 99 as 1 }), "must be 1, 2, or 3"],
    ["titleEn object", entry({ titleEn: {} as unknown as string }), "titleEn must be a string"],
    ["summaryJa number", entry({ summaryJa: 123 as unknown as string }), "summaryJa must be a string"],
    ["tag object", entry({ tags: ["ok", {} as unknown as string] }), "tags[1] must be a string"],
    ["sourceType enum", entry({ sourceType: "podcast" as "community" }), "sourceType must be one of"],
    ["category enum", entry({ category: "unknown" as "research" }), "category must be one of"],
    ["archiveTier enum", entry({ archiveTier: "frozen" as "hot" }), "archiveTier must be one of"],
    ["halfLife enum", entry({ halfLife: "eternal" as "news" }), "halfLife must be one of"],
    ["lang enum", entry({ lang: "fr" as "en" }), "lang must be one of"],
    ["publishedAt timestamp", entry({ publishedAt: "yesterday" as string }), "publishedAt must be a valid ISO timestamp"],
    ["image src", entry({ image: { src: "   " } as never }), "image.src must be a non-empty string"],
    ["image source enum", entry({ image: { src: "https://example.com/a.png", source: "blob" } as never }), "image.source must be one of"],
  ])("rejects invalid entry schema: %s", (_label, invalidEntry, expected) => {
    expect(() => validateIndexPayload({ generatedAt: "2026-07-01T00:00:00.000Z", entries: [invalidEntry] }, "index.json")).toThrow(expected);
  });

  it.each([
    [
      "numeric bodyJa",
      { generatedAt: "2026-07-01T00:00:00.000Z", bodies: { keep: { bodyJa: 1, bodyEn: "en", model: "m", generatedAt: "2026-07-01T00:00:00.000Z" } } },
      "bodyJa must be a string",
    ],
    [
      "object bodyEn",
      { generatedAt: "2026-07-01T00:00:00.000Z", bodies: { keep: { bodyJa: "ja", bodyEn: {}, model: "m", generatedAt: "2026-07-01T00:00:00.000Z" } } },
      "bodyEn must be a string",
    ],
    [
      "blank model",
      { generatedAt: "2026-07-01T00:00:00.000Z", bodies: { keep: { bodyJa: "ja", bodyEn: "en", model: " ", generatedAt: "2026-07-01T00:00:00.000Z" } } },
      "model must be a non-empty string",
    ],
    [
      "invalid generatedAt",
      { generatedAt: "2026-07-01T00:00:00.000Z", bodies: { keep: { bodyJa: "ja", bodyEn: "en", model: "m", generatedAt: "not-iso" } } },
      "generatedAt must be a valid ISO timestamp",
    ],
  ])("rejects invalid bodies payload: %s", (_label, payload, expected) => {
    expect(() => validateBodiesPayload(payload)).toThrow(expected);
  });

  it("rejects live entries that are missing bilingual summaries", () => {
    expect(() =>
      validateIndexPayload(
        {
          generatedAt: "2026-07-01T00:00:00.000Z",
          entries: [entry({ summaryJa: "日本語要約", summaryEn: "" })],
        },
        "index.json",
      )
    ).toThrow("index.json.entries[0].summaryEn must be a non-empty string");
  });

  it("allows compact hot archive rows without summaries but rejects warm/cold omissions", () => {
    expect(() =>
      validateArchiveMonthPayload(
        {
          generatedAt: "2026-07-01T00:00:00.000Z",
          month: "2026-07",
          entries: [entry({ archiveTier: "hot", summaryJa: "", summaryEn: "" })],
        },
        "archive/2026-07.json",
      )
    ).not.toThrow();

    expect(() =>
      validateArchiveMonthPayload(
        {
          generatedAt: "2026-07-01T00:00:00.000Z",
          month: "2026-07",
          entries: [entry({ archiveTier: "warm", summaryJa: "", summaryEn: "English summary" })],
        },
        "archive/2026-07.json",
      )
    ).toThrow("archive/2026-07.json.entries[0].summaryJa must be a non-empty string");
  });

  it("repairs legacy warm/cold summary gaps before strict archive output validation", () => {
    const input = validateArchiveMonthInputPayload(
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        month: "2026-07",
        entries: [
          entry({ id: "repair-me", archiveTier: "cold", summaryJa: "", summaryEn: "English summary" }),
        ],
      },
      "archive/2026-07.json",
    );
    const report = emptyReport();
    const repaired = summarizeChanges(
      "2026-07.json",
      input.entries,
      "2027-07-01T00:00:00.000Z",
      report,
      { preserveArchiveTier: true },
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0].archiveTier).toBe("cold");
    expect(repaired[0].summaryJa).toBe(
      "Show HN: Agents SDK for coding tools（hn-ai）のtech-news関連エントリ。",
    );
    expect(repaired[0].summaryEn).toBe("English summary");
    expect(() =>
      validateArchiveMonthPayload(
        {
          generatedAt: "2027-07-01T00:00:00.000Z",
          month: "2026-07",
          entries: repaired,
        },
        "archive/2026-07.json",
      )
    ).not.toThrow();
  });
});

describe("clean-source-noise archive migration", () => {
  it("preserves the archive clock when migration content is unchanged", () => {
    const archivedEntry = entry({
      archiveTier: "warm",
      summaryJa: "日本語要約",
      summaryEn: "English summary",
    });
    const current = {
      generatedAt: "2026-07-01T00:00:00.000Z",
      month: "2026-06",
      count: 1,
      entries: [archivedEntry],
    };

    const payload = buildMigrationArchiveMonthPayload(
      current,
      "2026-06",
      current.entries,
      "2026-07-15T00:00:00.000Z",
    );

    expect(payload.generatedAt).toBe(current.generatedAt);
    expect(payload.entries).toEqual(current.entries);
  });

  it("advances the archive clock when migration content changes", () => {
    const archivedEntry = entry({
      archiveTier: "warm",
      summaryJa: "日本語要約",
      summaryEn: "English summary",
      tags: ["community"],
    });
    const current = {
      generatedAt: "2026-07-01T00:00:00.000Z",
      month: "2026-06",
      count: 1,
      entries: [archivedEntry],
    };
    const changed = [{ ...archivedEntry, tags: ["agent", "community"] }];

    const payload = buildMigrationArchiveMonthPayload(
      current,
      "2026-06",
      changed,
      "2026-07-15T00:00:00.000Z",
    );

    expect(payload.generatedAt).toBe("2026-07-15T00:00:00.000Z");
    expect(payload.entries).toEqual(changed);
  });

  it("synchronizes tags for matching live and archive entries", () => {
    const live = entry({
      id: "shared",
      url: "https://example.com/shared",
      tags: ["agent", "tutorial"],
    });
    const archive = entry({
      id: "archive-alias",
      url: "https://example.com/shared?utm_source=archive",
      tags: ["agent"],
    });
    const unrelated = entry({
      id: "archive-only",
      url: "https://example.com/archive-only",
      tags: ["archive"],
    });

    const result = synchronizeArchiveTagsFromLive(
      [archive, unrelated],
      [live],
    );

    expect(result.changed).toBe(1);
    expect(result.entries[0].tags).toEqual(["agent", "tutorial"]);
    expect(result.entries[1].tags).toEqual(["archive"]);
  });

  it("preserves hot archive tier on compact no-summary entries", () => {
    const report = emptyReport();
    const kept = summarizeChanges(
      "2026-07.json",
      [entry({ summaryJa: "", summaryEn: "", archiveTier: "hot" })],
      "2027-07-01T00:00:00.000Z",
      report,
      { preserveArchiveTier: true },
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].archiveTier).toBe("hot");
  });

  it("fills only a missing archive summary while preserving tier and the existing language", () => {
    const report = emptyReport();
    const kept = summarizeChanges(
      "2026-07.json",
      [
        entry({ id: "warm-missing-ja", summaryJa: "", summaryEn: "English summary", archiveTier: "warm" }),
        entry({ id: "cold-missing-en", summaryJa: "日本語要約", summaryEn: "", archiveTier: "cold" }),
      ],
      "2027-07-01T00:00:00.000Z",
      report,
      { preserveArchiveTier: true },
    );
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({
      archiveTier: "warm",
      summaryJa: "Show HN: Agents SDK for coding tools（hn-ai）のtech-news関連エントリ。",
      summaryEn: "English summary",
    });
    expect(kept[1]).toMatchObject({
      archiveTier: "cold",
      summaryJa: "日本語要約",
      summaryEn: "Show HN: Agents SDK for coding tools is a tech-news entry from hn-ai.",
    });
  });

  it("does not let an existing publishable archive entry become dropped during migration", () => {
    const report = emptyReport();
    const kept = summarizeChanges(
      "2026-01.json",
      [
        entry({
          publishedAt: "2024-01-01T00:00:00.000Z",
          collectedAt: "2024-01-01T01:00:00.000Z",
          summaryJa: "日本語要約",
          summaryEn: "English summary",
          archiveTier: "warm",
        }),
      ],
      "2027-07-01T00:00:00.000Z",
      report,
      { preserveArchiveTier: true },
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].archiveTier).toBe("warm");
  });

  it("preserves bilingual warm/cold archive tiers", () => {
    const report = emptyReport();
    const kept = summarizeChanges(
      "2026-01.json",
      [
        entry({
          id: "warm-bilingual",
          summaryJa: "日本語要約",
          summaryEn: "English summary",
          archiveTier: "warm",
        }),
        entry({
          id: "cold-bilingual",
          summaryJa: "別の日本語要約",
          summaryEn: "Another English summary",
          archiveTier: "cold",
        }),
      ],
      "2027-07-01T00:00:00.000Z",
      report,
      { preserveArchiveTier: true },
    );
    expect(kept).toHaveLength(2);
    expect(kept.map((item) => item.archiveTier)).toEqual(["warm", "cold"]);
  });

  it("drops explicit dropped-tier archive entries from the rebuilt output", () => {
    const report = emptyReport();
    const kept = summarizeChanges(
      "2026-01.json",
      [entry({ archiveTier: "dropped" })],
      "2027-07-01T00:00:00.000Z",
      report,
      { preserveArchiveTier: true },
    );
    expect(kept).toEqual([]);
    expect(report.removed).toBe(1);
  });

  it("filters dropped aliases before canonical merging", () => {
    const retained = entry({
      id: "retained",
      url: "https://example.com/story",
      archiveTier: "warm",
      collectedAt: "2026-06-29T01:00:00.000Z",
    });
    const newerDroppedAlias = entry({
      id: "dropped",
      url: "https://example.com/story?utm_source=feed",
      archiveTier: "dropped",
      collectedAt: "2026-07-01T01:00:00.000Z",
    });

    const result = dedupeByCanonical([retained, newerDroppedAlias]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("retained");
    expect(result.entries[0].archiveTier).toBe("warm");
    expect(result.aliases.size).toBe(0);
  });

  it("merges real archive summaries before filling a missing language", () => {
    const report = emptyReport();
    const migration = migrateArchiveEntries(
      "2026-07.json",
      [
        entry({
          id: "older-real-ja",
          url: "https://example.com/story",
          collectedAt: "2026-06-29T01:00:00.000Z",
          archiveTier: "warm",
          titleEn: "Preserved translated title",
          summaryJa: "旧 canonical alias に保存された実際の日本語要約です。",
          summaryEn: "Older English summary",
          tags: ["alias-tag"],
          image: {
            src: "https://cdn.example/archive.jpg",
            alt: "Archive preview",
            width: 640,
            height: 360,
            source: "media",
          },
        }),
        entry({
          id: "newer-winner",
          url: "https://example.com/story?utm_source=feed",
          collectedAt: "2026-07-01T01:00:00.000Z",
          archiveTier: "warm",
          titleEn: "",
          summaryJa: "",
          summaryEn: "Newer English summary",
          tags: ["winner-tag"],
        }),
      ],
      "2027-07-01T00:00:00.000Z",
      report,
    );

    expect(migration.entries).toHaveLength(1);
    expect(migration.entries[0]).toMatchObject({
      id: "newer-winner",
      archiveTier: "warm",
      titleEn: "Preserved translated title",
      summaryJa: "旧 canonical alias に保存された実際の日本語要約です。",
      summaryEn: "Newer English summary",
      image: {
        src: "https://cdn.example/archive.jpg",
        alt: "Archive preview",
        width: 640,
        height: 360,
        source: "media",
      },
    });
    expect(migration.entries[0].tags).toEqual(expect.arrayContaining(["alias-tag", "winner-tag"]));
    expect(migration.entries[0].summaryJa).not.toContain("関連エントリ");
  });
});

describe("clean-source-noise bodies reconciliation", () => {
  it("prunes orphan body ids while preserving retained bodies", () => {
    const merge = reconcileBodiesPayload(
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        count: 2,
        bodies: {
          keep: { bodyJa: "あ".repeat(200), bodyEn: "a".repeat(200), model: "legacy" },
          orphan: { bodyJa: "い".repeat(200), bodyEn: "b".repeat(200), model: "legacy" },
        },
      },
      new Set(["keep"]),
      "2026-07-02T00:00:00.000Z",
    );
    expect(merge.pruned).toBe(1);
    expect(merge.payload.count).toBe(1);
    expect(merge.payload.bodies.keep?.model).toBe("legacy");
    expect(merge.payload.bodies.orphan).toBeUndefined();
  });

  it("transfers a real body from a canonical loser to the winning live id", () => {
    const dedupe = dedupeByCanonical([
      entry({
        id: "loser",
        url: "https://example.com/story",
        collectedAt: "2026-06-29T01:00:00.000Z",
      }),
      entry({
        id: "winner",
        url: "https://example.com/story?utm_source=feed",
        collectedAt: "2026-07-01T01:00:00.000Z",
      }),
    ]);
    expect(dedupe.entries.map((item) => item.id)).toEqual(["winner"]);
    expect(dedupe.aliases).toEqual(new Map([["loser", "winner"]]));

    const merge = reconcileBodiesPayload(
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        count: 1,
        bodies: {
          loser: {
            bodyJa: "負けたIDの日本語本文",
            bodyEn: "English body from the losing id",
            model: "claude-opus-4.8",
            generatedAt: "2026-06-30T00:00:00.000Z",
          },
        },
      },
      new Set(["winner"]),
      "2026-07-02T00:00:00.000Z",
      dedupe.aliases,
    );

    expect(merge.payload.bodies.loser).toBeUndefined();
    expect(merge.payload.bodies.winner).toEqual({
      bodyJa: "負けたIDの日本語本文",
      bodyEn: "English body from the losing id",
      model: "claude-opus-4.8",
      generatedAt: "2026-06-30T00:00:00.000Z",
    });
  });

  it("preserves an existing real winner body during canonical alias reconciliation", () => {
    const winnerBody = {
      bodyJa: "勝者IDの既存日本語本文",
      bodyEn: "Existing English body on the winner",
      model: "winner-model",
      generatedAt: "2026-07-01T00:00:00.000Z",
    };
    const merge = reconcileBodiesPayload(
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        count: 2,
        bodies: {
          winner: winnerBody,
          loser: {
            bodyJa: "負けたIDの日本語本文",
            bodyEn: "English body from the losing id",
            model: "loser-model",
            generatedAt: "2026-06-30T00:00:00.000Z",
          },
        },
      },
      new Set(["winner"]),
      "2026-07-02T00:00:00.000Z",
      new Map([["loser", "winner"]]),
    );

    expect(merge.payload.bodies.winner).toEqual(winnerBody);
    expect(merge.payload.bodies.loser).toBeUndefined();
  });

  it("transfers a body from a filtered canonical loser but not from a different URL", () => {
    const original = [
      entry({
        id: "filtered-alias",
        url: "https://example.com/story?utm_source=filtered",
      }),
      entry({
        id: "survivor",
        url: "https://example.com/story",
      }),
      entry({
        id: "filtered-unrelated",
        url: "https://example.com/other-story",
      }),
    ];
    const finalEntries = [original[1]];
    const aliases = buildOriginalLiveAliases(original, finalEntries);

    expect(aliases).toEqual(new Map([["filtered-alias", "survivor"]]));

    const merge = reconcileBodiesPayload(
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        count: 2,
        bodies: {
          "filtered-alias": {
            bodyJa: "フィルタされた canonical alias の日本語本文",
            bodyEn: "English body from the filtered canonical alias",
            model: "claude-opus-4.8",
            generatedAt: "2026-06-30T00:00:00.000Z",
          },
          "filtered-unrelated": {
            bodyJa: "別 URL の日本語本文",
            bodyEn: "English body from a different URL",
            model: "claude-opus-4.8",
            generatedAt: "2026-06-30T00:00:00.000Z",
          },
        },
      },
      new Set(["survivor"]),
      "2026-07-02T00:00:00.000Z",
      aliases,
    );

    expect(merge.payload.bodies.survivor?.bodyJa).toBe(
      "フィルタされた canonical alias の日本語本文",
    );
    expect(merge.payload.bodies["filtered-alias"]).toBeUndefined();
    expect(merge.payload.bodies["filtered-unrelated"]).toBeUndefined();
  });

  it("moves real legacy index bodies into bodies.json before stripping index fields", () => {
    const merge = reconcileBodiesPayload(
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        count: 0,
        bodies: {},
      },
      new Set(["winner"]),
      "2026-07-02T00:00:00.000Z",
      new Map([["legacy-alias", "winner"]]),
      [
        entry({
          id: "legacy-alias",
          bodyJa: "index にだけ残っていた実際の日本語本文",
          bodyEn: "A real English body that existed only in the index.",
        }),
      ],
    );

    expect(merge.payload.bodies.winner).toEqual({
      bodyJa: "index にだけ残っていた実際の日本語本文",
      bodyEn: "A real English body that existed only in the index.",
      model: "legacy-index-migration",
      generatedAt: "2026-07-02T00:00:00.000Z",
    });
  });
});

describe("clean-source-noise stats rebuild", () => {
  it("uses the artifact referenceAt as the deterministic stats clock", () => {
    const payloadNear = buildMigrationStatsPayload(
      [entry({ publishedAt: "2026-07-01T00:00:00.000Z" })],
      [],
      "2026-07-05T00:00:00.000Z",
    );
    const payloadFar = buildMigrationStatsPayload(
      [entry({ publishedAt: "2026-07-01T00:00:00.000Z" })],
      [],
      "2026-07-20T00:00:00.000Z",
    );
    expect(payloadNear.generatedAt).toBe("2026-07-05T00:00:00.000Z");
    expect(payloadNear.totals.last7d).toBe(1);
    expect(payloadFar.generatedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(payloadFar.totals.last7d).toBe(0);
  });
});

describe("clean-source-noise batch writes", () => {
  function scratchDir(name: string) {
    const dir = join(process.cwd(), `.clean-source-noise-test-${process.pid}-${name}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("writes every target on success with no temp, backup, or journal debris", () => {
    const dir = scratchDir("success");
    try {
      const indexPath = join(dir, "index.json");
      const archivePath = join(dir, "2026-07.json");
      const journalPath = join(dir, ".txn.json");
      writeFileSync(indexPath, JSON.stringify({ old: 1 }, null, 2) + "\n", "utf8");
      writeFileSync(archivePath, JSON.stringify({ old: 2 }, null, 2) + "\n", "utf8");

      writeJsonTransaction(
        [
          { path: indexPath, value: { next: 1 } },
          { path: archivePath, value: { next: 2 } },
        ],
        { journalPath, registerSignalHandlers: false },
      );

      expect(JSON.parse(readFileSync(indexPath, "utf8"))).toEqual({ next: 1 });
      expect(JSON.parse(readFileSync(archivePath, "utf8"))).toEqual({ next: 2 });
      expect(readdirSync(dir).sort()).toEqual(["2026-07.json", "index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back all original targets when a target rename fails before commit", () => {
    const dir = scratchDir("rollback");
    try {
      const indexPath = join(dir, "index.json");
      const archivePath = join(dir, "2026-07.json");
      const statsPath = join(dir, "stats.json");
      const journalPath = join(dir, ".txn.json");
      const originals = new Map([
        [indexPath, JSON.stringify({ old: 1 }, null, 2) + "\n"],
        [archivePath, JSON.stringify({ old: 2 }, null, 2) + "\n"],
        [statsPath, JSON.stringify({ old: 3 }, null, 2) + "\n"],
      ]);
      for (const [path, content] of originals) writeFileSync(path, content, "utf8");

      let threw = false;
      let committedStateRenameAttempted = false;
      expect(() =>
        writeJsonTransaction(
          [
            { path: indexPath, value: { next: 1 } },
            { path: archivePath, value: { next: 2 } },
            { path: statsPath, value: { next: 3 } },
          ],
          {
            journalPath,
            registerSignalHandlers: false,
            renameImpl(from, to) {
              if (to === journalPath && from.endsWith(".state.tmp")) {
                committedStateRenameAttempted = true;
              }
              if (!threw && to === statsPath && from.endsWith(".tmp")) {
                threw = true;
                throw new Error("simulated later rename failure");
              }
              renameSync(from, to);
            },
          },
        )
      ).toThrow("simulated later rename failure");

      expect(committedStateRenameAttempted).toBe(false);
      for (const [path, content] of originals) {
        expect(readFileSync(path, "utf8")).toBe(content);
      }
      expect(existsSync(journalPath)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(["2026-07.json", "index.json", "stats.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the journal and backups when rollback itself fails, then allows a later recovery", () => {
    const dir = scratchDir("rollback-failure");
    try {
      const indexPath = join(dir, "index.json");
      const archivePath = join(dir, "2026-07.json");
      const journalPath = join(dir, ".txn.json");
      const indexOriginal = '{"generation":"old-index"}\n';
      const archiveOriginal = '{"generation":"old-archive"}\n';
      writeFileSync(indexPath, indexOriginal, "utf8");
      writeFileSync(archivePath, archiveOriginal, "utf8");

      let targetFailureTriggered = false;
      expect(() =>
        writeJsonTransaction(
          [
            { path: indexPath, value: { generation: "new-index" } },
            { path: archivePath, value: { generation: "new-archive" } },
          ],
          {
            journalPath,
            registerSignalHandlers: false,
            renameImpl(from, to) {
              if (!targetFailureTriggered && to === archivePath && from.endsWith(".tmp")) {
                targetFailureTriggered = true;
                throw new Error("simulated target replacement failure");
              }
              if (targetFailureTriggered && to === indexPath && from.includes(".bak")) {
                throw new Error("simulated rollback restore failure");
              }
              renameSync(from, to);
            },
          },
        )
      ).toThrow(/rollback was incomplete/);

      const artifacts = readdirSync(dir);
      expect(existsSync(journalPath)).toBe(true);
      expect(artifacts.some((name) => name.includes(".bak"))).toBe(true);
      expect(artifacts.some((name) => name.includes(".tmp"))).toBe(true);

      expect(recoverWriteTransaction(journalPath)).toBe(true);
      expect(readFileSync(indexPath, "utf8")).toBe(indexOriginal);
      expect(readFileSync(archivePath, "utf8")).toBe(archiveOriginal);
      expect(readdirSync(dir).sort()).toEqual(["2026-07.json", "index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second transaction while the journal lock is owned", () => {
    const dir = scratchDir("exclusive-lock");
    try {
      const indexPath = join(dir, "index.json");
      const journalPath = join(dir, ".txn.json");
      writeFileSync(indexPath, '{"generation":"old"}\n', "utf8");
      const lock = acquireWriteTransactionLock(journalPath);
      try {
        expect(() =>
          writeJsonTransaction(
            [{ path: indexPath, value: { generation: "new" } }],
            { journalPath, registerSignalHandlers: false },
          )
        ).toThrow(/Another data artifact writer owns/);
        expect(readFileSync(indexPath, "utf8")).toBe('{"generation":"old"}\n');
      } finally {
        lock.release();
      }
      expect(readdirSync(dir).sort()).toEqual(["index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a well-formed lock only when its owner is confirmed dead", () => {
    const dir = scratchDir("stale-lock");
    try {
      const journalPath = join(dir, ".txn.json");
      const lockPath = `${journalPath}.lock`;
      writeFileSync(
        lockPath,
        JSON.stringify({
          version: 1,
          ownerToken: "dead-owner",
          pid: 424242,
          createdAt: "2026-07-01T00:00:00.000Z",
        }, null, 2) + "\n",
        "utf8",
      );

      const lock = acquireWriteTransactionLock(journalPath, {
        processIsAlive: () => false,
      });
      expect(JSON.parse(readFileSync(lockPath, "utf8")).ownerToken).toBe(lock.ownerToken);
      expect(readdirSync(dir).filter((name) => name.endsWith(".stale"))).toEqual([]);
      lock.release();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when an existing lock owner cannot be confirmed dead", () => {
    const dir = scratchDir("unknown-lock-owner");
    try {
      const journalPath = join(dir, ".txn.json");
      const lockPath = `${journalPath}.lock`;
      const original = JSON.stringify({
        version: 1,
        ownerToken: "unknown-owner",
        pid: 525252,
        createdAt: "2026-07-01T00:00:00.000Z",
      }, null, 2) + "\n";
      writeFileSync(lockPath, original, "utf8");

      expect(() =>
        acquireWriteTransactionLock(journalPath, {
          processIsAlive: () => null,
        })
      ).toThrow(/could not be verified as stopped/);
      expect(readFileSync(lockPath, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed and preserves a malformed lock", () => {
    const dir = scratchDir("malformed-lock");
    try {
      const journalPath = join(dir, ".txn.json");
      const lockPath = `${journalPath}.lock`;
      writeFileSync(lockPath, '{"version":1', "utf8");

      expect(() => acquireWriteTransactionLock(journalPath)).toThrow(
        /Transaction lock cannot be verified/,
      );
      expect(readFileSync(lockPath, "utf8")).toBe('{"version":1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back every target when recovering an active transaction", () => {
    const dir = scratchDir("recover");
    try {
      const indexPath = join(dir, "index.json");
      const archivePath = join(dir, "2026-07.json");
      const indexBackupPath = join(dir, ".index.json.txn.bak");
      const archiveBackupPath = join(dir, ".2026-07.json.txn.bak");
      const indexTempPath = join(dir, ".index.json.txn.tmp");
      const archiveTempPath = join(dir, ".2026-07.json.txn.tmp");
      const journalPath = join(dir, ".txn.json");
      writeFileSync(indexPath, '{"generation":"new-index"}\n', "utf8");
      writeFileSync(archivePath, '{"generation":"new-archive"}\n', "utf8");
      writeFileSync(indexBackupPath, '{"generation":"old-index"}\n', "utf8");
      writeFileSync(archiveBackupPath, '{"generation":"old-archive"}\n', "utf8");
      writeFileSync(indexTempPath, '{"generation":"unused-index-temp"}\n', "utf8");
      writeFileSync(archiveTempPath, '{"generation":"unused-archive-temp"}\n', "utf8");
      writeFileSync(
        journalPath,
        JSON.stringify({
          version: 1,
          state: "active",
          journalPath,
          files: [
            {
              path: indexPath,
              tempPath: indexTempPath,
              backupPath: indexBackupPath,
              existed: true,
            },
            {
              path: archivePath,
              tempPath: archiveTempPath,
              backupPath: archiveBackupPath,
              existed: true,
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      expect(recoverWriteTransaction(journalPath)).toBe(true);
      expect(readFileSync(indexPath, "utf8")).toBe('{"generation":"old-index"}\n');
      expect(readFileSync(archivePath, "utf8")).toBe('{"generation":"old-archive"}\n');
      expect(readdirSync(dir).sort()).toEqual(["2026-07.json", "index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the active journal atomically before replacing any target", () => {
    const dir = scratchDir("journal-order");
    try {
      const indexPath = join(dir, "index.json");
      const journalPath = join(dir, ".txn.json");
      writeFileSync(indexPath, '{"generation":"old"}\n', "utf8");
      const renames: Array<[string, string]> = [];

      writeJsonTransaction(
        [{ path: indexPath, value: { generation: "new" } }],
        {
          journalPath,
          registerSignalHandlers: false,
          renameImpl(from, to) {
            renames.push([from, to]);
            renameSync(from, to);
          },
        },
      );

      const journalRename = renames.findIndex(([from, to]) =>
        to === journalPath && from.endsWith(".journal.tmp")
      );
      const targetRename = renames.findIndex(([from, to]) =>
        to === indexPath && from.endsWith(".tmp")
      );
      expect(journalRename).toBeGreaterThanOrEqual(0);
      expect(targetRename).toBeGreaterThan(journalRename);
      expect(readFileSync(indexPath, "utf8")).toBe('{\n  "generation": "new"\n}\n');
      expect(readdirSync(dir).sort()).toEqual(["index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed and preserves recovery artifacts when a journal is truncated", () => {
    const dir = scratchDir("corrupt-journal");
    try {
      const indexPath = join(dir, "index.json");
      const backupPath = join(dir, ".index.json.txn.bak");
      const journalPath = join(dir, ".txn.json");
      writeFileSync(indexPath, '{"generation":"new"}\n', "utf8");
      writeFileSync(backupPath, '{"generation":"old"}\n', "utf8");
      writeFileSync(journalPath, '{"version":1,"state":"active"', "utf8");

      expect(() => recoverWriteTransaction(journalPath)).toThrow(
        /Automatic recovery was not attempted/,
      );
      expect(readFileSync(indexPath, "utf8")).toBe('{"generation":"new"}\n');
      expect(readFileSync(backupPath, "utf8")).toBe('{"generation":"old"}\n');
      expect(readFileSync(journalPath, "utf8")).toBe('{"version":1,"state":"active"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every new target when recovering a committed transaction and only cleans artifacts", () => {
    const dir = scratchDir("recover-committed");
    try {
      const indexPath = join(dir, "index.json");
      const archivePath = join(dir, "2026-07.json");
      const indexBackupPath = join(dir, ".index.json.txn.bak");
      const archiveBackupPath = join(dir, ".2026-07.json.txn.bak");
      const indexTempPath = join(dir, ".index.json.txn.tmp");
      const archiveTempPath = join(dir, ".2026-07.json.txn.tmp");
      const stateTempPath = join(dir, "..txn.json.state.tmp");
      const journalPath = join(dir, ".txn.json");
      writeFileSync(indexPath, '{"generation":"new-index"}\n', "utf8");
      writeFileSync(archivePath, '{"generation":"new-archive"}\n', "utf8");
      writeFileSync(indexBackupPath, '{"generation":"old-index"}\n', "utf8");
      writeFileSync(archiveBackupPath, '{"generation":"old-archive"}\n', "utf8");
      writeFileSync(indexTempPath, '{"generation":"unused-index-temp"}\n', "utf8");
      writeFileSync(archiveTempPath, '{"generation":"unused-archive-temp"}\n', "utf8");
      writeFileSync(stateTempPath, '{"state":"committed"}\n', "utf8");
      writeFileSync(
        journalPath,
        JSON.stringify({
          version: 1,
          state: "committed",
          journalPath,
          stateTempPath,
          files: [
            {
              path: indexPath,
              tempPath: indexTempPath,
              backupPath: indexBackupPath,
              existed: true,
            },
            {
              path: archivePath,
              tempPath: archiveTempPath,
              backupPath: archiveBackupPath,
              existed: true,
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      expect(recoverWriteTransaction(journalPath)).toBe(true);
      expect(readFileSync(indexPath, "utf8")).toBe('{"generation":"new-index"}\n');
      expect(readFileSync(archivePath, "utf8")).toBe('{"generation":"new-archive"}\n');
      expect(readdirSync(dir).sort()).toEqual(["2026-07.json", "index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
