import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArchiveMonthFile,
  promoteEvictedEvergreenEntries,
} from "../harness/publishers/archive-core.ts";
import { writeArchive } from "../harness/publishers/archive-builder.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import { isPublishableEntry } from "../web/src/lib/entry-publication.ts";
import { isAddressableDetailEntry } from "../web/src/lib/detail-addressability.ts";

const SUMMARY_JA = "エージェント設計のベストプラクティスを、実運用で得られた知見とともに整理した記事です。";
const SUMMARY_EN = "A practical write-up of agent design best practices, grounded in lessons from production deployments.";

function fixtureEntry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "entry-1",
    source: "fixture-source",
    sourceType: "blog",
    url: "https://example.com/article",
    title: "Fixture article",
    titleJa: "Fixture article",
    titleEn: "Fixture article",
    summaryJa: SUMMARY_JA,
    summaryEn: SUMMARY_EN,
    lang: "en",
    publishedAt: "2026-04-15T00:00:00.000Z",
    collectedAt: "2026-04-15T01:00:00.000Z",
    tags: ["fixture"],
    category: "tech-news",
    importance: 1,
    ...overrides,
  };
}

describe("evergreen archive retention (R-022)", () => {
  // live index の cap (PER_SOURCE_CAP / CATEGORY_CAPS / INDEX_LIMIT) は永久 eviction
  // であり evergreen を考慮しない。evergreen は evict されても warm (個別URL) として
  // 残り続ける必要があるため、summary 保持と tier 昇格の両方を検証する。

  it("evergreen の hot 行は summary を保持する (LL-044 の例外)", () => {
    const entry = fixtureEntry({
      id: "evergreen-hot",
      archiveTier: "hot",
      evergreen: true,
      bodyJa: "本文",
      bodyEn: "body",
    });

    const [stored] = buildArchiveMonthFile("2026-04", [entry], "2026-04-20T00:00:00.000Z").entries;

    expect(stored?.summaryJa).toBe(SUMMARY_JA);
    expect(stored?.summaryEn).toBe(SUMMARY_EN);
    // body は tier を問わず archive に載せない。
    expect(stored?.bodyJa).toBeUndefined();
    expect(stored?.bodyEn).toBeUndefined();
  });

  it("evergreen でない hot 行は従来どおり summary を落とす (LL-044)", () => {
    const entry = fixtureEntry({ id: "plain-hot", archiveTier: "hot" });

    const [stored] = buildArchiveMonthFile("2026-04", [entry], "2026-04-20T00:00:00.000Z").entries;

    expect(stored?.summaryJa).toBeUndefined();
    expect(stored?.summaryEn).toBeUndefined();
  });

  it("live index から落ちた evergreen を warm に昇格する", () => {
    const evicted = fixtureEntry({ id: "evicted", archiveTier: "hot", evergreen: true });

    const { entries, changed } = promoteEvictedEvergreenEntries([evicted], []);

    expect(changed).toBe(1);
    expect(entries[0]?.archiveTier).toBe("warm");
  });

  it("live に残っている evergreen の tier は触らない", () => {
    const live = fixtureEntry({ id: "still-live", archiveTier: "hot", evergreen: true });

    const { entries, changed } = promoteEvictedEvergreenEntries([live], [live]);

    expect(changed).toBe(0);
    expect(entries[0]?.archiveTier).toBe("hot");
  });

  it("id が変わっても canonical URL が live なら昇格しない", () => {
    const archived = fixtureEntry({ id: "old-id", archiveTier: "hot", evergreen: true });
    const live = fixtureEntry({
      id: "new-id",
      url: "https://example.com/article?utm_source=rss",
      archiveTier: "hot",
      evergreen: true,
    });

    const { changed } = promoteEvictedEvergreenEntries([archived], [live]);

    expect(changed).toBe(0);
  });

  it("evergreen でない hot 行は evict されても hot のまま (統計用 snapshot)", () => {
    const evicted = fixtureEntry({ id: "plain-evicted", archiveTier: "hot" });

    const { entries, changed } = promoteEvictedEvergreenEntries([evicted], []);

    expect(changed).toBe(0);
    expect(entries[0]?.archiveTier).toBe("hot");
  });

  it("既に warm の evergreen は変更しない (再実行しても安定)", () => {
    const warm = fixtureEntry({ id: "warm", archiveTier: "warm", evergreen: true });

    const first = promoteEvictedEvergreenEntries([warm], []);
    const second = promoteEvictedEvergreenEntries(first.entries, []);

    expect(first.changed).toBe(0);
    expect(second.changed).toBe(0);
    expect(second.entries[0]?.archiveTier).toBe("warm");
  });

  it("eviction 後も月次 archive と個別ページの両方に残る", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "archive-evergreen-"));
    try {
      const entry = fixtureEntry({
        id: "evergreen-evicted",
        archiveTier: "hot",
        evergreen: true,
      });

      // 1 回目: live index に載っている状態で archive に書き出す。
      await writeArchive([entry], dataDir);
      // 2 回目: cap に evict され live entries から消えた状態。
      await writeArchive([], dataDir);

      const payload = JSON.parse(
        readFileSync(join(dataDir, "archive", "2026-04.json"), "utf8"),
      ) as { entries: NormalizedEntry[] };
      const stored = payload.entries.find((candidate) => candidate.id === "evergreen-evicted");

      expect(stored).toBeDefined();
      expect(stored?.archiveTier).toBe("warm");
      // 月次 archive ページ (/archive/{month}) の掲載条件。
      expect(stored && isPublishableEntry(stored)).toBe(true);
      // 個別記事ページ (/e/{id}) の生成条件。
      expect(stored && isAddressableDetailEntry(stored)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
