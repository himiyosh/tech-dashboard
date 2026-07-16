import { describe, expect, it } from "vitest";

import {
  dailyBoardBaseDayKey,
  dailyBoardEmptyReason,
  dailyDisplayCount,
  dailyEntryCount,
} from "../web/src/lib/daily-summary.ts";

describe("dailyEntryCount", () => {
  it("counts only entries in the requested day bucket", () => {
    const entries = [
      { day: "2026-07-15" },
      { day: "2026-07-15" },
      { day: "2026-07-14" },
    ];
    expect(dailyEntryCount(entries, "2026-07-15", (entry) => entry.day)).toBe(2);
  });
});

describe("dailyDisplayCount", () => {
  it("uses the live JST count for the partial current day", () => {
    expect(dailyDisplayCount("2026-07-15", "2026-07-15", 29, 2)).toBe(29);
  });

  it("keeps archive-backed statistics for completed days", () => {
    expect(dailyDisplayCount("2026-07-14", "2026-07-15", 24, 31)).toBe(31);
  });

  it("falls back to the live count when statistics are unavailable", () => {
    expect(dailyDisplayCount("2026-07-14", "2026-07-15", 24, undefined)).toBe(24);
  });
});

describe("dailyBoardBaseDayKey", () => {
  it("counts all current-day lanes while keeping the decision board Timeline-only", () => {
    const todayKey = "2026-07-15";
    const yesterdayKey = "2026-07-14";
    const entries = [
      { day: todayKey, lane: "timeline" },
      { day: todayKey, lane: "arxiv" },
      { day: yesterdayKey, lane: "timeline" },
    ];
    const boardEntries = entries.filter((entry) => entry.lane === "timeline");
    const activityToday = dailyEntryCount(entries, todayKey, (entry) => entry.day);
    const boardToday = dailyEntryCount(boardEntries, todayKey, (entry) => entry.day);
    const boardYesterday = dailyEntryCount(
      boardEntries,
      yesterdayKey,
      (entry) => entry.day,
    );

    expect(dailyDisplayCount(todayKey, todayKey, activityToday, 1)).toBe(2);
    expect(boardToday).toBe(1);
    expect(
      dailyBoardBaseDayKey(todayKey, yesterdayKey, boardToday, boardYesterday),
    ).toBe(todayKey);
  });

  it("uses the previous Timeline day when current activity exists only in other lanes", () => {
    expect(
      dailyBoardBaseDayKey("2026-07-15", "2026-07-14", 0, 3),
    ).toBe("2026-07-14");
  });

  it("keeps the current day when it has Timeline candidates", () => {
    expect(
      dailyBoardBaseDayKey("2026-07-15", "2026-07-14", 1, 3),
    ).toBe("2026-07-15");
  });
});

describe("dailyBoardEmptyReason", () => {
  it("returns null when a summarized story is ready", () => {
    expect(dailyBoardEmptyReason(4, 1)).toBeNull();
  });

  it("distinguishes pending summaries from an empty day", () => {
    expect(dailyBoardEmptyReason(4, 0)).toBe("summary-pending");
    expect(dailyBoardEmptyReason(0, 0)).toBe("no-entries");
  });
});
