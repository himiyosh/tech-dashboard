import { normalizeSearchText } from "./search-normalize.ts";

export function normalizeTagKey(value: string): string {
  return normalizeSearchText(value.trim());
}
