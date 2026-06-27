/**
 * worker/src/bodies-file.ts
 *
 * Pure helpers for data/bodies.json (body-file architecture, LL-115). The
 * collector reads the committed bodies.json, merges newly generated bodies
 * (from the `b:` KV cache), prunes bodies whose entry is no longer live, and
 * writes it back in the same Git Data API commit as index.json (LL-021).
 *
 * Cloudflare-type-free so it can be unit-tested directly.
 */
export interface BodyRecord {
  bodyJa: string;
  bodyEn: string;
  model?: string;
  generatedAt?: string;
}

export interface BodiesPayload {
  generatedAt: string;
  count: number;
  bodies: Record<string, BodyRecord>;
}

const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";
const FALLBACK_BODY_JA_NEEDLE = "元記事の要約と収集時のメタデータから";

function text(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True when a record holds real, renderable bilingual prose (not filler). */
export function isRealBody(record: BodyRecord | undefined | null): boolean {
  if (!record) return false;
  const ja = text(record.bodyJa);
  const en = text(record.bodyEn);
  if (!ja || !en) return false;
  if (en.includes(FALLBACK_BODY_EN_NEEDLE) || ja.includes(FALLBACK_BODY_JA_NEEDLE)) return false;
  return true;
}

/** Parse a bodies.json string into a normalized payload (tolerant of junk). */
export function parseBodies(json: string | null | undefined): BodiesPayload {
  if (!json || !json.trim()) return { generatedAt: "", count: 0, bodies: {} };
  try {
    const parsed = JSON.parse(json) as Partial<BodiesPayload>;
    const bodies = parsed.bodies && typeof parsed.bodies === "object" ? parsed.bodies : {};
    return {
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
      count: Object.keys(bodies).length,
      bodies,
    };
  } catch {
    return { generatedAt: "", count: 0, bodies: {} };
  }
}

/** The set of entry ids that already hold a real body. */
export function bodiesPresentSet(payload: BodiesPayload): Set<string> {
  const out = new Set<string>();
  for (const [id, record] of Object.entries(payload.bodies)) {
    if (isRealBody(record)) out.add(id);
  }
  return out;
}

export interface NewBody {
  id: string;
  bodyJa: string;
  bodyEn: string;
  model?: string;
  cachedAt?: string;
}

export interface MergeBodiesResult {
  payload: BodiesPayload;
  added: number;
  pruned: number;
  changed: boolean;
}

/**
 * Merge newly generated bodies into the existing payload and prune bodies whose
 * entry id is no longer live (keeps bodies.json bounded to the live index).
 *
 * - `existing`: parsed current bodies.json.
 * - `newBodies`: real bodies pulled from the `b:` KV cache this run.
 * - `liveIds`: the set of entry ids currently in data/index.json.
 * - `generatedAt`: timestamp for the payload (and for newly added records).
 */
export function mergeBodies(
  existing: BodiesPayload,
  newBodies: readonly NewBody[],
  liveIds: ReadonlySet<string>,
  generatedAt: string,
): MergeBodiesResult {
  const bodies: Record<string, BodyRecord> = { ...existing.bodies };
  let added = 0;

  for (const nb of newBodies) {
    if (!isRealBody(nb)) continue;
    const existingRecord = bodies[nb.id];
    if (existingRecord && isRealBody(existingRecord)) continue; // don't overwrite a real body
    bodies[nb.id] = {
      bodyJa: nb.bodyJa,
      bodyEn: nb.bodyEn,
      model: nb.model ?? "claude-opus-4.8",
      generatedAt: nb.cachedAt ?? generatedAt,
    };
    added += 1;
  }

  // Prune bodies for entries no longer live so the file stays bounded.
  let pruned = 0;
  for (const id of Object.keys(bodies)) {
    if (!liveIds.has(id)) {
      delete bodies[id];
      pruned += 1;
    }
  }

  const changed = added > 0 || pruned > 0;
  return {
    payload: {
      generatedAt: changed ? generatedAt : existing.generatedAt || generatedAt,
      count: Object.keys(bodies).length,
      bodies,
    },
    added,
    pruned,
    changed,
  };
}

/** Serialize a bodies payload the same way the migration script does. */
export function serializeBodies(payload: BodiesPayload): string {
  return JSON.stringify(payload, null, 2) + "\n";
}
