const COMBINING_MARK_RE = /^\p{M}$/u;
const LATIN_CHAR_RE = /^\p{Script=Latin}$/u;

export function normalizeSearchText(value: string): string {
  let normalized = "";
  let followsLatin = false;
  for (const character of value.normalize("NFKD")) {
    if (COMBINING_MARK_RE.test(character)) {
      if (!followsLatin) normalized += character;
      continue;
    }
    normalized += character;
    followsLatin = LATIN_CHAR_RE.test(character);
  }
  return normalized.normalize("NFC").toLowerCase();
}
