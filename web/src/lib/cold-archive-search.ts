import {
  ARCHIVE_BY_MONTH,
  ARCHIVE_GENERATED_AT,
} from "./archive.ts";
import {
  COLD_ARCHIVE_SEARCH_MAX_BYTES,
  COLD_ARCHIVE_SEARCH_SCHEMA_VERSION,
  createColdArchiveSearchRecord,
  type ColdArchiveSearchPayload,
  type ColdArchiveSearchRecord,
} from "./cold-archive-search-core.ts";
import { titleForLang } from "./data.ts";
import { sourceAuthority } from "./source-meta.ts";

const records: ColdArchiveSearchRecord[] = [];
const anchorIds = new Set<string>();

for (const [month, file] of Object.entries(ARCHIVE_BY_MONTH)) {
  for (const entry of file.entries) {
    if (entry.archiveTier !== "cold") continue;
    const record = createColdArchiveSearchRecord({
      id: entry.id,
      url: entry.url,
      month,
      archiveTier: entry.archiveTier,
      titleJa: titleForLang(entry, "ja"),
      titleEn: titleForLang(entry, "en"),
      tags: entry.tags,
      source: entry.source,
      category: entry.category,
      authority: sourceAuthority(entry.source, entry.sourceType).kind,
      importance: entry.importance,
      publishedAt: entry.publishedAt,
    });
    if (!record) continue;
    if (anchorIds.has(record.anchorId)) {
      throw new Error(`Duplicate cold archive search anchor: ${record.anchorId}`);
    }
    anchorIds.add(record.anchorId);
    records.push(record);
  }
}

records.sort((left, right) =>
  right.publishedDay.localeCompare(left.publishedDay)
  || left.anchorId.localeCompare(right.anchorId),
);

export const COLD_ARCHIVE_SEARCH_RECORDS: readonly ColdArchiveSearchRecord[] =
  Object.freeze(records);

export const COLD_ARCHIVE_SEARCH_PAYLOAD: ColdArchiveSearchPayload =
  Object.freeze({
    schemaVersion: COLD_ARCHIVE_SEARCH_SCHEMA_VERSION,
    generatedAt: ARCHIVE_GENERATED_AT,
    count: records.length,
    entries: records,
  });

export const COLD_ARCHIVE_SEARCH_SERIALIZED = JSON.stringify(
  COLD_ARCHIVE_SEARCH_PAYLOAD,
);

const serializedBytes = new TextEncoder()
  .encode(COLD_ARCHIVE_SEARCH_SERIALIZED).byteLength;
if (serializedBytes > COLD_ARCHIVE_SEARCH_MAX_BYTES) {
  throw new Error(
    `Cold archive search index exceeds ${COLD_ARCHIVE_SEARCH_MAX_BYTES} bytes: ${serializedBytes}`,
  );
}
