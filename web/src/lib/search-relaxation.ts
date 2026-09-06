/**
 * search-relaxation.ts — recover Japanese article titles Pagefind cannot
 * retrieve verbatim.
 *
 * Pagefind segments CJK text, and it segments the QUERY independently of the
 * indexed CONTENT. A long title that mixes Latin and Japanese ("VS Codeが世界中
 * のビーチリゾートの窓に？ Webviewで海を映す拡張を作った") therefore produces query
 * tokens that never appear in the index, and Pagefind ANDs every token, so the
 * article that literally carries the title comes back with zero results. The
 * same title's inner phrases ("ビーチリゾートの窓に") match immediately.
 *
 * Measured on the live corpus (40 live JA-titled articles, each searched by its
 * own visible title): 32 retrieve themselves verbatim; of the 8 that do not,
 * these relaxed windows recover 7.
 *
 * The queries are only ever ADDITIONAL candidates: the caller keeps the verbatim
 * result set first and appends de-duplicated hits, and the existing exact-match
 * filter decides what is promoted, so a wider candidate set cannot turn an
 * unrelated article into an exact hit.
 */

/** Hiragana, katakana, CJK ideographs and compatibility ideographs. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
/** A CJK run, allowing the katakana prolonged sound mark inside it. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff][\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u30fc]*/gu;

/** Queries shorter than this retrieve fine verbatim; relaxing them adds noise. */
export const RELAXED_MIN_QUERY_POINTS = 16;
/** Window length that matched best in the corpus measurement. */
export const RELAXED_WINDOW_POINTS = 12;
/** Left-trims per run: a window starting mid-word is what usually fails. */
export const RELAXED_RUN_TRIMS = 3;
/** Runs considered, longest first. */
export const RELAXED_RUN_LIMIT = 2;
/** Hard cap on extra index queries per search. */
export const RELAXED_QUERY_LIMIT = 4;
/** Shorter windows match too much to be worth an extra query. */
const RELAXED_MIN_WINDOW_POINTS = 5;

/**
 * Ordered, de-duplicated relaxed queries for a verbatim query, or [] when the
 * query is short or carries no CJK (space-separated Latin ANDs correctly).
 * Pure and deterministic: the same query always yields the same list.
 */
export function relaxedCjkSearchQueries(
  query: string,
  limit: number = RELAXED_QUERY_LIMIT,
): string[] {
  const trimmed = query.trim();
  const points = [...trimmed];
  const maxQueries = Math.max(0, Math.floor(limit));
  if (maxQueries === 0 || !CJK_CHAR.test(trimmed) || points.length < RELAXED_MIN_QUERY_POINTS) {
    return [];
  }

  const queries: string[] = [];
  const add = (candidate: string): boolean => {
    const value = candidate.trim();
    if (
      value.length === 0
      || [...value].length < RELAXED_MIN_WINDOW_POINTS
      || value === trimmed
      || queries.includes(value)
    ) {
      return queries.length >= maxQueries;
    }
    queries.push(value);
    return queries.length >= maxQueries;
  };

  // 1) The leading window: what the previous implementation used on its own.
  if (add(points.slice(0, RELAXED_WINDOW_POINTS).join(""))) return queries;

  // 2) Windows inside the longest CJK runs. A run that starts right after Latin
  //    text is where segmentation diverges, so each run is also tried with a few
  //    leading characters dropped (usually a particle).
  const runs = [...(trimmed.match(CJK_RUN) ?? [])]
    .map((run) => [...run])
    .sort((a, b) => b.length - a.length)
    .slice(0, RELAXED_RUN_LIMIT);
  for (const run of runs) {
    for (let drop = 0; drop <= RELAXED_RUN_TRIMS; drop += 1) {
      if (run.length - drop < RELAXED_MIN_WINDOW_POINTS) break;
      if (add(run.slice(drop, drop + RELAXED_WINDOW_POINTS).join(""))) return queries;
    }
  }
  return queries;
}
