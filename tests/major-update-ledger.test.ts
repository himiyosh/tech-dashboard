import { describe, expect, it } from "vitest";
import type { RawIndexEntry } from "../web/src/lib/data.ts";
import {
  advanceMajorUpdateLedger,
  parseMajorUpdateState,
  type MajorUpdateIndex,
  type MajorUpdateSnapshot,
} from "../web/src/lib/major-update-ledger.ts";
import {
  publicMajorUpdateIndex,
  publicMajorUpdateMonth,
  recentMajorUpdateEvents,
} from "../web/src/lib/major-update-public.ts";
import type { PublicationGate } from "../web/src/lib/publication-gate.ts";

const start = "2026-09-30T23:00:00.000Z";
const first = "2026-10-01T00:00:00.000Z";
const second = "2026-11-02T01:00:00.000Z";

function entry(id: string, overrides: Partial<RawIndexEntry> = {}): RawIndexEntry {
  return {
    id,
    source: "openai-blog",
    sourceType: "blog",
    url: `https://example.com/${id}`,
    title: `Official model news ${id}`,
    titleJa: `モデル更新 ${id}`,
    titleEn: `Official model news ${id}`,
    summaryJa: "新しいモデルと提供範囲の詳細を公開しました。",
    summaryEn: "This article describes the model and its availability.",
    lang: "en",
    publishedAt: "2026-09-30T20:00:00.000Z",
    collectedAt: "2026-09-30T21:00:00.000Z",
    tags: ["model"],
    category: "codex",
    importance: 3,
    archiveTier: "hot",
    ...overrides,
  };
}

function snapshot(generatedAt: string, entries: RawIndexEntry[]): MajorUpdateSnapshot {
  return { generatedAt, entries };
}

function gate(held: readonly string[] = []): PublicationGate {
  return {
    dailyReleaseLimit: 50,
    evaluatedDay: "2026-10-01",
    isReleased: (id) => !held.includes(id),
    releaseDayOf: () => null,
    queuedIds: () => held,
  };
}

function emptyIndex(): MajorUpdateIndex {
  return {
    schemaVersion: 1,
    initializedAt: null,
    lastObservedAt: null,
    lastSequence: 0,
    baseline: { sourceKeys: [], topicKeys: [] },
    months: [],
  };
}

const a = entry("000000000000000a");
const b = entry("000000000000000b");
const c = entry("000000000000000c");

describe("append-only major-update tracking", () => {
  it("seeds existing articles before the first run and emits its actual new article", () => {
    const state = parseMajorUpdateState(emptyIndex(), []);
    expect(publicMajorUpdateIndex(state).latestCursor).toBe("0");
    const output = advanceMajorUpdateLedger(
      state,
      snapshot(start, [a]),
      snapshot(first, [a, b]),
      gate(),
      gate(),
    );
    expect(output.changed).toBe(true);
    expect(output.state.index.initializedAt).toBe(start);
    expect(output.state.index.lastSequence).toBe(1);
    expect(output.state.index.baseline.sourceKeys).toEqual(["example.com/000000000000000a"]);
    expect(output.state.index.months).toEqual([{
      month: "2026-10",
      firstSequence: 1,
      lastSequence: 1,
      count: 1,
    }]);
    expect(output.added).toMatchObject([{
      sequence: 1,
      id: b.id,
      observedAt: first,
      publishedAt: b.publishedAt,
      siteUrl: `https://techdb.studio344.net/e/${b.id}/`,
    }]);
    expect(advanceMajorUpdateLedger(
      output.state,
      snapshot(first, [a, b]),
      snapshot(first, [a, b]),
      gate(),
      gate(),
    ).changed).toBe(false);
  });

  it("replays old cursors across months without losing or renumbering events", () => {
    const seeded = advanceMajorUpdateLedger(
      parseMajorUpdateState(emptyIndex(), []),
      snapshot(start, [a]),
      snapshot(first, [a, b]),
      gate(),
      gate(),
    ).state;
    const appended = advanceMajorUpdateLedger(
      seeded,
      snapshot(first, [a, b]),
      snapshot(second, [a, b, c]),
      gate(),
      gate(),
    );
    expect(appended.state.index.lastSequence).toBe(2);
    expect(appended.state.index.months.map((month) => month.month))
      .toEqual(["2026-10", "2026-11"]);
    const replay = appended.state.months
      .filter((month) =>
        appended.state.index.months.find((range) => range.month === month.month)!.lastSequence > 0)
      .flatMap((month) => month.events)
      .filter((event) => event.sequence > 0);
    expect(replay.map((event) => [event.sequence, event.id])).toEqual([
      [1, b.id],
      [2, c.id],
    ]);
    expect(replay.filter((event) => event.sequence > 1).map((event) => event.id))
      .toEqual([c.id]);
    const publicIndex = publicMajorUpdateIndex(appended.state);
    expect(publicIndex.latestCursor).toBe("2");
    expect(publicIndex.months.map(({ href, firstCursor, lastCursor }) => [
      href, firstCursor, lastCursor,
    ])).toEqual([
      ["/updates/2026-10.json", "1", "1"],
      ["/updates/2026-11.json", "2", "2"],
    ]);
    expect(publicMajorUpdateMonth(appended.state, "2026-11").events).toMatchObject([{
      cursor: "2",
      id: "urn:techdb:major:2",
      observedAt: second,
      sourcePublishedAt: c.publishedAt,
      entryId: c.id,
      siteUrl: `https://techdb.studio344.net/e/${c.id}/`,
      sourceUrl: c.url,
    }]);
    expect(publicMajorUpdateMonth(appended.state, "2026-11").events[0]?.title.originalLang)
      .toBe("en");
    expect(recentMajorUpdateEvents(appended.state, 1).map((event) => event.id))
      .toEqual([c.id]);
    expect(recentMajorUpdateEvents(appended.state, 0)).toEqual([]);
    expect(() => publicMajorUpdateMonth(appended.state, "2026-12"))
      .toThrow(/not indexed/);
    expect(parseMajorUpdateState(appended.state.index, appended.state.months))
      .toEqual(appended.state);
    expect(parseMajorUpdateState(
      appended.state.index,
      [...appended.state.months].reverse(),
    ).months).toEqual(appended.state.months);
  });

  it("waits for summaries, but tracks listed articles even when SEO indexing is held", () => {
    const pending = entry(b.id, { summaryJa: "", summaryEn: "" });
    const held = entry(c.id);
    const firstRun = advanceMajorUpdateLedger(
      parseMajorUpdateState(emptyIndex(), []),
      snapshot(start, [a]),
      snapshot(first, [a, pending, held]),
      gate(),
      gate([c.id]),
    );
    expect(firstRun.added.map((event) => [event.id, event.publicationHold]))
      .toEqual([[c.id, true]]);
    const ready = advanceMajorUpdateLedger(
      firstRun.state,
      snapshot(first, [a, pending, held]),
      snapshot(second, [a, b, held]),
      gate([c.id]),
      gate([c.id]),
    );
    expect(ready.added.map((event) => event.id)).toEqual([b.id]);
    const released = advanceMajorUpdateLedger(
      ready.state,
      snapshot(second, [a, b, held]),
      snapshot("2026-11-03T01:00:00.000Z", [a, b, held]),
      gate([c.id]),
      gate(),
    );
    expect(released.added).toEqual([]);
  });

  it("deduplicates re-collection by canonical URL and repeated model launches by topic", () => {
    const firstRun = advanceMajorUpdateLedger(
      parseMajorUpdateState(emptyIndex(), []),
      snapshot(start, [a]),
      snapshot(first, [a, b]),
      gate(),
      gate(),
    );
    const duplicate = entry("000000000000000d", {
      url: `${b.url}?utm_medium=rss`,
      title: "The same official update with a tracked URL",
    });
    const secondRun = advanceMajorUpdateLedger(
      firstRun.state,
      snapshot(first, [a, b]),
      snapshot(second, [a, b, duplicate]),
      gate(),
      gate(),
    );
    expect(secondRun.added).toEqual([]);
    expect(secondRun.state.index.lastSequence).toBe(1);
  });

  it("refuses corrupted ledgers and backwards snapshot clocks", () => {
    expect(() => parseMajorUpdateState(
      { ...emptyIndex(), initializedAt: first },
      [],
    )).toThrow(/initialization state/);
    expect(() => parseMajorUpdateState(
      { ...emptyIndex(), baseline: { sourceKeys: ["z", "a"], topicKeys: [] } },
      [],
    )).toThrow(/sorted and unique/);
    const state = advanceMajorUpdateLedger(
      parseMajorUpdateState(emptyIndex(), []),
      snapshot(start, [a]),
      snapshot(first, [a, b]),
      gate(),
      gate(),
    ).state;
    expect(() => parseMajorUpdateState(state.index, [])).toThrow(/month index/);
    expect(() => parseMajorUpdateState(state.index, [{
      ...state.months[0],
      events: [{ ...state.months[0]!.events[0], sequence: 3 }],
    }])).toThrow(/duplicate or missing event sequence/);
    expect(() => advanceMajorUpdateLedger(
      state,
      snapshot(first, [a, b]),
      snapshot(start, [a, b, c]),
      gate(),
      gate(),
    )).toThrow(/clock moved backwards/);
  });
});
