import type { Importance, NormalizedEntry } from "../types.ts";
import { normalizeTags } from "./tag.ts";

function filled(value: string | undefined): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function fillText(primary: string | undefined, fallback: string | undefined): string {
  return filled(primary) || filled(fallback);
}

function maxImportance(primary: Importance, fallback: Importance): Importance {
  return Math.max(primary, fallback) as Importance;
}

function dedupeTags(tags: string[]): string[] {
  return normalizeTags(tags, 10);
}

export function mergeEntryEnrichment(
  primary: NormalizedEntry,
  fallback: NormalizedEntry | undefined,
): NormalizedEntry {
  if (!fallback) return primary;

  return {
    ...primary,
    titleJa: fillText(primary.titleJa, fallback.titleJa),
    titleEn: fillText(primary.titleEn, fallback.titleEn),
    summaryJa: fillText(primary.summaryJa, fallback.summaryJa),
    summaryEn: fillText(primary.summaryEn, fallback.summaryEn),
    bodyJa: fillText(primary.bodyJa, fallback.bodyJa),
    bodyEn: fillText(primary.bodyEn, fallback.bodyEn),
    publishedAt: primary.publishedAt ?? fallback.publishedAt,
    tags: dedupeTags([...primary.tags, ...fallback.tags]),
    importance: maxImportance(primary.importance, fallback.importance),
    image: primary.image ?? fallback.image,
    clusterId: primary.clusterId ?? fallback.clusterId,
    evergreen: primary.evergreen ?? fallback.evergreen,
    raw: primary.raw ?? fallback.raw,
  };
}
