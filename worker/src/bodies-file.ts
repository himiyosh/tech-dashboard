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
import {
  hasKnownProductBodyRecordConflict,
  type ProductNameEntry,
} from "../../harness/pipeline/product-name.ts";
import {
  hasMaterialBodyGroundingConflict,
  hasSufficientBodySourceGrounding,
} from "../../harness/pipeline/source-grounding.ts";
import type { NormalizedEntry } from "../../harness/types.ts";
import { validateArticleChat, type ArticleChatTurn } from "./article-chat.ts";

export interface BodyRecord {
  bodyJa: string;
  bodyEn: string;
  /** Optional article chat (validated: exactly six alternating turns). */
  chat?: ArticleChatTurn[];
  model?: string;
  generatedAt?: string;
}

export interface BodiesPayload {
  generatedAt: string;
  count: number;
  bodies: Record<string, BodyRecord>;
}

type BodyGuardEntry = Pick<NormalizedEntry, "id"> &
  ProductNameEntry &
  Partial<
    Pick<
      NormalizedEntry,
      "contentSnippet" | "sourceType" | "url" | "lang"
    >
  >;

const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";
const FALLBACK_BODY_JA_NEEDLE = "元記事の要約と収集時のメタデータから";

function text(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * True when a body text ends like a finished sentence rather than a mid-token
 * cut. The 2026-08-29 audit measured 172 of 1,016 indexable-lane bodies
 * (16.9%) ending mid-word ("that the long-stand", "Treating LL") — the old
 * opus configuration exhausting max_tokens. Rejecting them here makes the
 * pipeline self-healing: the record stops counting as real, the page drops to
 * noindex/summary-only, needsBody() turns true again, and the hourly queue
 * regenerates it on the current model chain.
 *
 * MIRRORED in web/src/lib/body-quality.ts (which must stay free of worker
 * imports); tests/worker-body-completeness.test.ts pins the two copies to the
 * same verdicts.
 */
export function looksCompleteBodyText(value: string, lang: "ja" | "en"): boolean {
  const trimmed = text(value);
  if (!trimmed) return true; // absence is judged elsewhere; only presence must be complete
  return lang === "ja"
    ? /[。！？…」』）)】.!?"']$/.test(trimmed)
    : /[.!?…"')\]]$/.test(trimmed);
}

/** True when a record holds real, renderable bilingual prose (not filler). */
export function isRealBody(record: BodyRecord | undefined | null): boolean {
  if (!record) return false;
  const ja = text(record.bodyJa);
  const en = text(record.bodyEn);
  if (!ja || !en) return false;
  if (en.includes(FALLBACK_BODY_EN_NEEDLE) || ja.includes(FALLBACK_BODY_JA_NEEDLE)) return false;
  if (!looksCompleteBodyText(ja, "ja") || !looksCompleteBodyText(en, "en")) return false;
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

export interface PruneBodiesResult {
  payload: BodiesPayload;
  pruned: number;
  changed: boolean;
}

export function pruneKnownProductBodyConflicts(
  payload: BodiesPayload,
  entries: readonly BodyGuardEntry[],
  generatedAt: string,
): PruneBodiesResult {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const bodies = { ...payload.bodies };
  let pruned = 0;

  for (const [id, record] of Object.entries(bodies)) {
    const entry = entriesById.get(id);
    if (entry && hasKnownProductBodyRecordConflict(entry, record)) {
      delete bodies[id];
      pruned += 1;
    }
  }

  return {
    payload: pruned > 0
      ? {
          generatedAt,
          count: Object.keys(bodies).length,
          bodies,
        }
      : payload,
    pruned,
    changed: pruned > 0,
  };
}

export function pruneInvalidBodyRecords(
  payload: BodiesPayload,
  entries: readonly BodyGuardEntry[],
  generatedAt: string,
): PruneBodiesResult {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const bodies = { ...payload.bodies };
  let pruned = 0;

  for (const [id, record] of Object.entries(bodies)) {
    const entry = entriesById.get(id);
    // A record that no longer counts as real — filler, or truncated
    // mid-sentence by the old generator config (looksCompleteBodyText) — is
    // REMOVED from the file, not merely ignored: leaving it in place made
    // key-presence and isRealBody disagree, so the runtime's backlog
    // (bodiesPresentSet-based) diverged from every raw-key recomputation.
    // Removal is what re-arms needsBody() and lets the hourly queue
    // regenerate the entry on the current model chain.
    if (!isRealBody(record)) {
      delete bodies[id];
      pruned += 1;
      continue;
    }
    if (
      entry &&
      (
        !hasSufficientBodySourceGrounding(entry) ||
        hasKnownProductBodyRecordConflict(entry, record) ||
        hasMaterialBodyGroundingConflict(entry, record)
      )
    ) {
      delete bodies[id];
      pruned += 1;
    }
  }

  return {
    payload: pruned > 0
      ? {
          generatedAt,
          count: Object.keys(bodies).length,
          bodies,
        }
      : payload,
    pruned,
    changed: pruned > 0,
  };
}

export function mergeBodiesWithProductGuard(
  existing: BodiesPayload,
  newBodies: readonly NewBody[],
  liveIds: ReadonlySet<string>,
  generatedAt: string,
  entries: readonly BodyGuardEntry[],
): MergeBodiesResult {
  return mergeBodiesWithGuards(
    existing,
    newBodies,
    liveIds,
    generatedAt,
    entries,
  );
}

export function mergeBodiesWithGuards(
  existing: BodiesPayload,
  newBodies: readonly NewBody[],
  liveIds: ReadonlySet<string>,
  generatedAt: string,
  entries: readonly BodyGuardEntry[],
): MergeBodiesResult {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const sanitizedExisting = pruneInvalidBodyRecords(
    existing,
    entries,
    generatedAt,
  );
  const compatibleBodies = newBodies.filter((body) => {
    const entry = entriesById.get(body.id);
    return !entry || (
      !hasKnownProductBodyRecordConflict(entry, body) &&
      !hasMaterialBodyGroundingConflict(entry, body)
    );
  });
  const merged = mergeBodies(
    sanitizedExisting.payload,
    compatibleBodies,
    liveIds,
    generatedAt,
  );
  const sanitizedMerged = pruneInvalidBodyRecords(
    merged.payload,
    entries,
    generatedAt,
  );
  return {
    payload: sanitizedMerged.payload,
    added: Math.max(0, merged.added - sanitizedMerged.pruned),
    pruned:
      sanitizedExisting.pruned +
      merged.pruned +
      sanitizedMerged.pruned,
    changed:
      sanitizedExisting.changed ||
      merged.changed ||
      sanitizedMerged.changed,
  };
}

export interface NewBody {
  id: string;
  bodyJa: string;
  bodyEn: string;
  chat?: ArticleChatTurn[];
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
    const chat = validateArticleChat(nb.chat) ?? undefined;
    const existingRecord = bodies[nb.id];
    if (existingRecord && isRealBody(existingRecord)) {
      // Don't overwrite a real body — but DO graft a chat it doesn't have yet.
      // This is how the chat backfill lands for the pre-feature corpus: the
      // backfill writes body+chat KV entries, the chat-missing lookup lane
      // (worker/src/index.ts) reads them back, and only the chat is adopted so
      // the published prose never churns.
      if (chat && !validateArticleChat(existingRecord.chat)) {
        bodies[nb.id] = { ...existingRecord, chat };
        added += 1;
      }
      continue;
    }
    bodies[nb.id] = {
      bodyJa: nb.bodyJa,
      bodyEn: nb.bodyEn,
      ...(chat ? { chat } : {}),
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
