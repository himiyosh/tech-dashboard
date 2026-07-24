export interface SourceExcerptEntry {
  contentSnippet?: string;
  title?: string;
  titleJa?: string;
  titleEn?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  mdash: "-",
  nbsp: " ",
  ndash: "-",
  quot: '"',
};

function decodeEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  if (normalized.startsWith("#x")) {
    const value = Number.parseInt(normalized.slice(2), 16);
    return Number.isFinite(value) && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : `&${entity};`;
  }
  if (normalized.startsWith("#")) {
    const value = Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(value) && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : `&${entity};`;
  }
  return NAMED_ENTITIES[normalized] ?? `&${entity};`;
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function clampExcerpt(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  const sliced = characters.slice(0, maxLength).join("");
  const atWordBoundary = /\s/u.test(sliced)
    ? sliced.replace(/\s+\S*$/u, "").trimEnd()
    : sliced;
  return `${atWordBoundary || sliced}…`;
}

export function sourceExcerptForEntry(
  entry: SourceExcerptEntry,
  maxLength = 240,
): string {
  const raw = entry.contentSnippet?.trim() ?? "";
  if (!raw) return "";

  const excerpt = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => decodeEntity(entity))
    .replace(/\s+The post .+? appeared first on .+?\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!excerpt) return "";

  const normalizedExcerpt = normalizeComparable(excerpt);
  const titleEchoes = [entry.title, entry.titleJa, entry.titleEn]
    .filter((title): title is string => Boolean(title?.trim()))
    .map(normalizeComparable);
  if (titleEchoes.includes(normalizedExcerpt)) return "";

  return clampExcerpt(excerpt, Math.max(80, maxLength));
}
