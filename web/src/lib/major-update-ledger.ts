import type { RawIndexEntry, NormalizedEntry } from "./entry-types.ts";
import { CATEGORY_META, type Category } from "./category-meta.ts";
import { canonicalArchiveSearchKey } from "./cold-archive-search-core.ts";
import { selectMajorUpdates } from "./major-updates.ts";
import { decisionTopicKey } from "./ranking.ts";
import { detailPath } from "./route-inventory.ts";
import { SITE_URL } from "./site.ts";
import type { PublicationGate } from "./publication-gate.ts";

export const MAJOR_UPDATE_SCHEMA_VERSION = 1 as const;
export const MAJOR_UPDATE_INDEX_PATH = "data/updates/_index.json" as const;
export const MAJOR_UPDATE_MAX_MONTH_BYTES = 2_000_000;
export const MAJOR_UPDATE_MAX_INDEX_BYTES = 500_000;

type EventSnapshot = Pick<
  NormalizedEntry,
  | "id" | "publicationHold" | "source" | "sourceType" | "url" | "title"
  | "titleJa" | "titleEn" | "summaryJa" | "summaryEn" | "lang"
  | "publishedAt" | "collectedAt" | "tags" | "category" | "importance"
>;

export interface MajorUpdateEvent extends EventSnapshot {
  sequence: number;
  /** First eligible Publisher snapshot, not the source's publication date. */
  observedAt: string;
  sourceKey: string;
  topicKey: string | null;
  siteUrl: string;
}

export interface MajorUpdateMonth {
  schemaVersion: typeof MAJOR_UPDATE_SCHEMA_VERSION;
  month: string;
  events: MajorUpdateEvent[];
}

export interface MajorUpdateMonthRange {
  month: string;
  firstSequence: number;
  lastSequence: number;
  count: number;
}

export interface MajorUpdateIndex {
  schemaVersion: typeof MAJOR_UPDATE_SCHEMA_VERSION;
  initializedAt: string | null;
  lastObservedAt: string | null;
  lastSequence: number;
  baseline: { sourceKeys: string[]; topicKeys: string[] };
  months: MajorUpdateMonthRange[];
}

export interface MajorUpdateState {
  index: MajorUpdateIndex;
  months: MajorUpdateMonth[];
}

export interface MajorUpdateSnapshot {
  generatedAt: string;
  entries: readonly RawIndexEntry[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`major-update ledger: ${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`major-update ledger: ${path} must be nonempty text`);
  }
  return value;
}

function instant(value: unknown, path: string): string {
  const date = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(date) || new Date(date).toISOString() !== value) {
    throw new Error(`major-update ledger: ${path} must be a UTC ISO instant`);
  }
  return value as string;
}

function sequence(value: unknown, path: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new Error(`major-update ledger: ${path} must be a safe positive sequence`);
  }
  return value as number;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`major-update ledger: ${path} must be a string array`);
  }
  const result = value as string[];
  if (result.some((item, index) => index > 0 && item <= result[index - 1]!)) {
    throw new Error(`major-update ledger: ${path} must be sorted and unique`);
  }
  return result;
}

function monthKey(value: unknown, path: string): string {
  const key = text(value, path);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(key)) {
    throw new Error(`major-update ledger: ${path} must be a UTC month`);
  }
  return key;
}

function httpUrl(value: unknown, path: string): string {
  const url = text(value, path);
  try {
    if (["http:", "https:"].includes(new URL(url).protocol)) return url;
  } catch {
    // Invalid URLs are rejected below without treating them as missing data.
  }
  throw new Error(`major-update ledger: ${path} must be an HTTP(S) URL`);
}

function parseEvent(value: unknown, path: string): MajorUpdateEvent {
  const item = record(value, path);
  const id = text(item.id, `${path}.id`);
  if (!/^[0-9a-f]{16}$/.test(id)) {
    throw new Error(`major-update ledger: ${path}.id is invalid`);
  }
  const category = text(item.category, `${path}.category`);
  if (!CATEGORY_META.some((meta) => meta.slug === category)) {
    throw new Error(`major-update ledger: ${path}.category is unknown`);
  }
  const sourceType = text(item.sourceType, `${path}.sourceType`);
  if (!["blog", "release", "changelog", "paper", "community"].includes(sourceType)) {
    throw new Error(`major-update ledger: ${path}.sourceType is invalid`);
  }
  const lang = text(item.lang, `${path}.lang`);
  if (lang !== "ja" && lang !== "en") {
    throw new Error(`major-update ledger: ${path}.lang is invalid`);
  }
  const importance = item.importance;
  if (importance !== 3 || typeof item.publicationHold !== "boolean") {
    throw new Error(`major-update ledger: ${path} must contain a listed High entry`);
  }
  if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`major-update ledger: ${path}.tags is invalid`);
  }
  const url = httpUrl(item.url, `${path}.url`);
  const siteUrl = httpUrl(item.siteUrl, `${path}.siteUrl`);
  if (siteUrl !== new URL(detailPath(id), SITE_URL).toString()) {
    throw new Error(`major-update ledger: ${path}.siteUrl is not the article detail`);
  }
  const topicKey = item.topicKey;
  if (topicKey !== null && (typeof topicKey !== "string" || !topicKey)) {
    throw new Error(`major-update ledger: ${path}.topicKey is invalid`);
  }
  const sourceKey = text(item.sourceKey, `${path}.sourceKey`);
  const titles = ["title", "titleJa", "titleEn"] as const;
  const summaries = ["summaryJa", "summaryEn"] as const;
  for (const key of [...titles, ...summaries]) {
    if (typeof item[key] !== "string") {
      throw new Error(`major-update ledger: ${path}.${key} must be text`);
    }
  }
  if (!item.title || (!(item.summaryJa as string).trim() && !(item.summaryEn as string).trim())) {
    throw new Error(`major-update ledger: ${path} is missing its title or summary`);
  }
  return {
    sequence: sequence(item.sequence, `${path}.sequence`),
    observedAt: instant(item.observedAt, `${path}.observedAt`),
    sourceKey,
    topicKey,
    siteUrl,
    id,
    publicationHold: item.publicationHold,
    source: text(item.source, `${path}.source`),
    sourceType: sourceType as MajorUpdateEvent["sourceType"],
    url,
    title: item.title as string,
    titleJa: item.titleJa as string,
    titleEn: item.titleEn as string,
    summaryJa: item.summaryJa as string,
    summaryEn: item.summaryEn as string,
    lang,
    publishedAt: instant(item.publishedAt, `${path}.publishedAt`),
    collectedAt: instant(item.collectedAt, `${path}.collectedAt`),
    tags: item.tags as string[],
    category: category as Category,
    importance: 3,
  };
}

export function parseMajorUpdateState(
  rawIndex: unknown,
  rawMonths: readonly unknown[],
): MajorUpdateState {
  const index = record(rawIndex, "index");
  if (index.schemaVersion !== MAJOR_UPDATE_SCHEMA_VERSION) {
    throw new Error("major-update ledger: unsupported index schema");
  }
  const initializedAt = index.initializedAt === null
    ? null
    : instant(index.initializedAt, "index.initializedAt");
  const lastObservedAt = index.lastObservedAt === null
    ? null
    : instant(index.lastObservedAt, "index.lastObservedAt");
  const baseline = record(index.baseline, "index.baseline");
  const sourceKeys = strings(baseline.sourceKeys, "index.baseline.sourceKeys");
  const topicKeys = strings(baseline.topicKeys, "index.baseline.topicKeys");
  const lastSequence = sequence(index.lastSequence, "index.lastSequence", true);
  if (!Array.isArray(index.months)) {
    throw new Error("major-update ledger: index.months must be an array");
  }
  const ranges: MajorUpdateMonthRange[] = index.months.map((value, position) => {
    const range = record(value, `index.months[${position}]`);
    const firstSequence = sequence(range.firstSequence, "range.firstSequence");
    const last = sequence(range.lastSequence, "range.lastSequence");
    const count = sequence(range.count, "range.count");
    if (last - firstSequence + 1 !== count) {
      throw new Error("major-update ledger: month range count is inconsistent");
    }
    return {
      month: monthKey(range.month, "range.month"),
      firstSequence,
      lastSequence: last,
      count,
    };
  });
  if (
    (initializedAt === null && (
      lastObservedAt !== null || lastSequence !== 0 ||
      sourceKeys.length > 0 || topicKeys.length > 0 || ranges.length > 0
    )) ||
    (initializedAt !== null && (
      lastObservedAt === null || Date.parse(lastObservedAt) < Date.parse(initializedAt)
    ))
  ) {
    throw new Error("major-update ledger: initialization state is inconsistent");
  }
  const parsedMonths: MajorUpdateMonth[] = rawMonths.map((value, position) => {
    const file = record(value, `months[${position}]`);
    if (file.schemaVersion !== MAJOR_UPDATE_SCHEMA_VERSION || !Array.isArray(file.events)) {
      throw new Error("major-update ledger: month schema is invalid");
    }
    const month = monthKey(file.month, "month.month");
    const events = file.events.map((event, index) =>
      parseEvent(event, `months[${position}].events[${index}]`));
    if (events.some((event) => event.observedAt.slice(0, 7) !== month)) {
      throw new Error(`major-update ledger: event is in the wrong month ${month}`);
    }
    return { schemaVersion: 1, month, events };
  });
  const byMonth = new Map(parsedMonths.map((file) => [file.month, file]));
  if (byMonth.size !== parsedMonths.length || ranges.length !== parsedMonths.length) {
    throw new Error("major-update ledger: month index does not match files");
  }
  let expectedSequence = 1;
  let previousMonth = "";
  let previousObservedAt = initializedAt ?? "";
  const seenSources = new Set(sourceKeys);
  const seenTopics = new Set(topicKeys);
  for (const range of ranges) {
    const file = byMonth.get(range.month);
    if (!file || range.month <= previousMonth) {
      throw new Error("major-update ledger: months must be ordered and present");
    }
    previousMonth = range.month;
    if (file.events.length !== range.count || range.firstSequence !== expectedSequence) {
      throw new Error("major-update ledger: month sequence range is inconsistent");
    }
    for (const event of file.events) {
      if (event.sequence !== expectedSequence++ || seenSources.has(event.sourceKey)
        || (event.topicKey !== null && seenTopics.has(event.topicKey))) {
        throw new Error("major-update ledger: duplicate or missing event sequence");
      }
      if (event.observedAt < previousObservedAt
        || (lastObservedAt !== null && event.observedAt > lastObservedAt)) {
        throw new Error("major-update ledger: event observation clock is inconsistent");
      }
      previousObservedAt = event.observedAt;
      seenSources.add(event.sourceKey);
      if (event.topicKey !== null) seenTopics.add(event.topicKey);
    }
  }
  if (lastSequence !== expectedSequence - 1) {
    throw new Error("major-update ledger: latest cursor is inconsistent");
  }
  return {
    index: {
      schemaVersion: 1,
      initializedAt,
      lastObservedAt,
      lastSequence,
      baseline: { sourceKeys, topicKeys },
      months: ranges,
    },
    months: ranges.map((range) => byMonth.get(range.month)!),
  };
}

function eligible(snapshot: MajorUpdateSnapshot, gate: PublicationGate): NormalizedEntry[] {
  instant(snapshot.generatedAt, "snapshot.generatedAt");
  return selectMajorUpdates(
    snapshot.entries.map((entry) => ({
      ...entry,
      publicationHold: !gate.isReleased(entry.id),
    })),
    snapshot.generatedAt,
  );
}

export function advanceMajorUpdateLedger(
  state: MajorUpdateState,
  before: MajorUpdateSnapshot,
  after: MajorUpdateSnapshot,
  beforeGate: PublicationGate,
  afterGate: PublicationGate,
): { state: MajorUpdateState; added: MajorUpdateEvent[]; changed: boolean } {
  const beforeCandidates = eligible(before, beforeGate);
  const candidates = eligible(after, afterGate);
  if (Date.parse(after.generatedAt) < Date.parse(before.generatedAt)
    || (state.index.lastObservedAt !== null
      && Date.parse(after.generatedAt) < Date.parse(state.index.lastObservedAt))) {
    throw new Error("major-update ledger: snapshot clock moved backwards");
  }
  const isFirstRun = state.index.initializedAt === null;
  const baselineSourceKeys = isFirstRun
    ? beforeCandidates.map((entry) => canonicalArchiveSearchKey(entry.url)!)
    : state.index.baseline.sourceKeys;
  const baselineTopicKeys = isFirstRun
    ? beforeCandidates.map(decisionTopicKey).filter((value): value is string => value !== null)
    : state.index.baseline.topicKeys;
  const seenSources = new Set(baselineSourceKeys);
  const seenTopics = new Set(baselineTopicKeys);
  for (const month of state.months) {
    for (const event of month.events) {
      seenSources.add(event.sourceKey);
      if (event.topicKey !== null) seenTopics.add(event.topicKey);
    }
  }

  const months = state.months.map((file) => ({ ...file, events: [...file.events] }));
  const added: MajorUpdateEvent[] = [];
  for (const entry of [...candidates].reverse()) {
    const sourceKey = canonicalArchiveSearchKey(entry.url);
    if (!sourceKey) throw new Error(`major-update ledger: invalid source URL for ${entry.id}`);
    const topicKey = decisionTopicKey(entry);
    if (seenSources.has(sourceKey) || (topicKey !== null && seenTopics.has(topicKey))) continue;
    const observedAt = after.generatedAt;
    const monthKeyValue = observedAt.slice(0, 7);
    const lastMonth = months.at(-1);
    if (lastMonth && lastMonth.month > monthKeyValue) {
      throw new Error("major-update ledger: month clock moved backwards");
    }
    const event: MajorUpdateEvent = {
      sequence: state.index.lastSequence + added.length + 1,
      observedAt,
      sourceKey,
      topicKey,
      siteUrl: new URL(detailPath(entry.id), SITE_URL).toString(),
      id: entry.id,
      publicationHold: entry.publicationHold,
      source: entry.source,
      sourceType: entry.sourceType,
      url: entry.url,
      title: entry.title,
      titleJa: entry.titleJa,
      titleEn: entry.titleEn,
      summaryJa: entry.summaryJa,
      summaryEn: entry.summaryEn,
      lang: entry.lang,
      publishedAt: entry.publishedAt,
      collectedAt: entry.collectedAt,
      tags: [...entry.tags],
      category: entry.category,
      importance: 3,
    };
    if (!Number.isSafeInteger(event.sequence)) {
      throw new Error("major-update ledger: sequence exhausted");
    }
    if (lastMonth?.month === monthKeyValue) lastMonth.events.push(event);
    else months.push({ schemaVersion: 1, month: monthKeyValue, events: [event] });
    added.push(event);
    seenSources.add(sourceKey);
    if (topicKey !== null) seenTopics.add(topicKey);
  }

  if (!isFirstRun && added.length === 0) return { state, added, changed: false };
  const index: MajorUpdateIndex = {
    schemaVersion: 1,
    initializedAt: state.index.initializedAt ?? before.generatedAt,
    lastObservedAt: after.generatedAt,
    lastSequence: state.index.lastSequence + added.length,
    baseline: {
      sourceKeys: [...new Set(baselineSourceKeys)].sort(),
      topicKeys: [...new Set(baselineTopicKeys)].sort(),
    },
    months: months.map((month) => ({
      month: month.month,
      firstSequence: month.events[0]!.sequence,
      lastSequence: month.events.at(-1)!.sequence,
      count: month.events.length,
    })),
  };
  const result = parseMajorUpdateState(index, months);
  return { state: result, added, changed: true };
}
