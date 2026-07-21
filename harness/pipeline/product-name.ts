import type { NormalizedEntry } from "../types.ts";

const AMAZON_QUICK_SIGHT_RE = /\bAmazon Quick\s*Sight\b/i;
const AMAZON_QUICK_SIGHT_GLOBAL_RE = /\bAmazon Quick\s*Sight\b/gi;
const AMAZON_QUICK_RE = /\bAmazon Quick\b/i;
const AMAZON_QUICK_DISTINCT_RE = /\bAmazon Quick\b(?!\s*Sight)/i;
const PRODUCT_NAME_FIELDS = [
  "titleJa",
  "titleEn",
  "summaryJa",
  "summaryEn",
] as const;

export type ProductNameEntry = Pick<NormalizedEntry, "source" | "title"> &
  Partial<
    Pick<
      NormalizedEntry,
      "titleJa" | "titleEn" | "summaryJa" | "summaryEn"
    >
  >;

export function normalizeKnownProductNames(
  entry: NormalizedEntry,
): NormalizedEntry;
export function normalizeKnownProductNames(
  entry: ProductNameEntry,
): ProductNameEntry;
export function normalizeKnownProductNames(
  entry: ProductNameEntry,
): ProductNameEntry {
  if (
    entry.source !== "aws-ml-blog" ||
    !AMAZON_QUICK_RE.test(entry.title) ||
    AMAZON_QUICK_SIGHT_RE.test(entry.title)
  ) {
    return entry;
  }

  const patch: Partial<
    Pick<
      NormalizedEntry,
      "titleJa" | "titleEn" | "summaryJa" | "summaryEn"
    >
  > = {};
  for (const field of PRODUCT_NAME_FIELDS) {
    const value = entry[field];
    if (typeof value !== "string") continue;
    const normalized = value.replace(
      AMAZON_QUICK_SIGHT_GLOBAL_RE,
      "Amazon Quick",
    );
    if (normalized !== value) patch[field] = normalized;
  }
  return Object.keys(patch).length > 0 ? { ...entry, ...patch } : entry;
}

export function hasKnownProductBodyConflict(
  entry: ProductNameEntry,
  bodyText: string | null | undefined,
): boolean {
  if (
    entry.source !== "aws-ml-blog" ||
    !AMAZON_QUICK_RE.test(entry.title) ||
    AMAZON_QUICK_SIGHT_RE.test(entry.title) ||
    typeof bodyText !== "string"
  ) {
    return false;
  }
  const firstParagraph = bodyText.split(/\n\s*\n/, 1)[0] ?? "";
  return (
    AMAZON_QUICK_SIGHT_RE.test(firstParagraph) &&
    !AMAZON_QUICK_DISTINCT_RE.test(firstParagraph)
  );
}

export function hasKnownProductBodyRecordConflict(
  entry: ProductNameEntry,
  body: {
    bodyJa?: string | null;
    bodyEn?: string | null;
  } | null | undefined,
): boolean {
  return Boolean(
    body &&
    (
      hasKnownProductBodyConflict(entry, body.bodyJa) ||
      hasKnownProductBodyConflict(entry, body.bodyEn)
    )
  );
}
