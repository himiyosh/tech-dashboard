import type {
  MajorUpdateEvent,
  MajorUpdateState,
} from "./major-update-ledger.ts";
import { effectiveTitleLanguage } from "./summary-display.ts";

export interface PublicMajorUpdate {
  id: string;
  cursor: string;
  observedAt: string;
  sourcePublishedAt: string;
  entryId: string;
  source: string;
  sourceType: MajorUpdateEvent["sourceType"];
  category: MajorUpdateEvent["category"];
  importance: 3;
  tags: string[];
  title: { ja: string | null; en: string | null; original: string; originalLang: "ja" | "en" };
  summary: { ja: string; en: string };
  siteUrl: string;
  sourceUrl: string;
  topicKey: string | null;
}

export function publicMajorUpdate(event: MajorUpdateEvent): PublicMajorUpdate {
  return {
    id: `urn:techdb:major:${event.sequence}`,
    cursor: String(event.sequence),
    observedAt: event.observedAt,
    sourcePublishedAt: event.publishedAt,
    entryId: event.id,
    source: event.source,
    sourceType: event.sourceType,
    category: event.category,
    importance: 3,
    tags: [...event.tags],
    title: {
      ja: event.titleJa || null,
      en: event.titleEn || null,
      original: event.title,
      originalLang: effectiveTitleLanguage(event),
    },
    summary: { ja: event.summaryJa, en: event.summaryEn },
    siteUrl: event.siteUrl,
    sourceUrl: event.url,
    topicKey: event.topicKey,
  };
}

export function publicMajorUpdateIndex(state: MajorUpdateState) {
  return {
    schemaVersion: 1 as const,
    baselineSnapshotAt: state.index.initializedAt,
    latestCursor: String(state.index.lastSequence),
    months: state.index.months.map((range) => ({
      month: range.month,
      href: `/updates/${range.month}.json`,
      firstCursor: String(range.firstSequence),
      lastCursor: String(range.lastSequence),
      count: range.count,
    })),
  };
}

export function publicMajorUpdateMonth(state: MajorUpdateState, month: string) {
  const file = state.months.find((candidate) => candidate.month === month);
  const range = state.index.months.find((candidate) => candidate.month === month);
  if (!file || !range) {
    throw new Error(`major-update public month is not indexed: ${month}`);
  }
  return {
    schemaVersion: 1 as const,
    month,
    firstCursor: String(range.firstSequence),
    lastCursor: String(range.lastSequence),
    count: file.events.length,
    events: file.events.map(publicMajorUpdate),
  };
}

export function recentMajorUpdateEvents(
  state: MajorUpdateState,
  limit: number,
): MajorUpdateEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`invalid major-update feed limit: ${limit}`);
  }
  if (limit === 0) return [];
  return state.months.flatMap((month) => month.events).slice(-limit).reverse();
}
