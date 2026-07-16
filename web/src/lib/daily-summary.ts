export type DailyBoardEmptyReason = "summary-pending" | "no-entries" | null;

export function dailyEntryCount<T>(
  entries: readonly T[],
  dayKey: string,
  entryDayKey: (entry: T) => string,
): number {
  return entries.reduce(
    (count, entry) => count + (entryDayKey(entry) === dayKey ? 1 : 0),
    0,
  );
}

export function dailyDisplayCount(
  dayKey: string,
  todayKey: string,
  liveCount: number,
  statsCount: number | undefined,
): number {
  return dayKey === todayKey ? liveCount : statsCount ?? liveCount;
}

export function dailyBoardBaseDayKey(
  todayKey: string,
  yesterdayKey: string,
  todayBoardEntryCount: number,
  yesterdayBoardEntryCount: number,
): string {
  if (todayBoardEntryCount > 0) return todayKey;
  return yesterdayBoardEntryCount > 0 ? yesterdayKey : todayKey;
}

export function dailyBoardEmptyReason(
  dayEntryCount: number,
  readyEntryCount: number,
): DailyBoardEmptyReason {
  if (readyEntryCount > 0) return null;
  return dayEntryCount > 0 ? "summary-pending" : "no-entries";
}
