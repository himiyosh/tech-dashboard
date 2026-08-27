/**
 * Publication gate — which approved entries may hold an indexable /e/[id]/
 * route, and on which UTC day they get it.
 *
 *   1. Approval. `data/approved-entries.json` is the only place an entry id can
 *      be approved for an in-site detail route. The hourly Publisher cannot
 *      write that file: PUBLISHER_DATA_PATH_RE (scripts/publisher-impact.ts:15)
 *      rejects the path in scripts/run-publisher.ts:374 and :525, and the
 *      staged-path allowlist in .github/workflows/publisher.yml:164 rejects it
 *      again before the commit. Approval is a human act by construction.
 *
 *   2. Release rate. Approvals are released at most `dailyReleaseLimit` per UTC
 *      day, in manifest order, so a bulk approval lands as a steady drip rather
 *      than a single-day burst of new indexable pages.
 *
 * The gate can only subtract. An approved id whose entry has no usable summary,
 * or whose archive tier is cold/dropped, still gets no route — the content
 * policy in detail-addressability.ts is AND-composed, never overridden.
 *
 * This module imports no data artifact, so route consumers, the Publisher
 * impact planner and both test runners share exactly one policy.
 * `publication-gate-data.ts` binds it to the real manifest.
 */

export const PUBLICATION_MANIFEST_PATH = "data/approved-entries.json";

/** Recommended steady-state release rate. The manifest carries the live value. */
export const DEFAULT_DAILY_RELEASE_LIMIT = 12;

/** A manifest may not raise the rate past this without a reviewed code change. */
export const MAX_DAILY_RELEASE_LIMIT = 25;

const ENTRY_ID_RE = /^[0-9a-f]{16}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY_MS = 86_400_000;

export type PublicationGateErrorCategory =
  | "MANIFEST_SHAPE"
  | "MANIFEST_ID"
  | "MANIFEST_INSTANT"
  | "MANIFEST_ORDER"
  | "MANIFEST_DUPLICATE"
  | "MANIFEST_LIMIT"
  | "GATE_CLOCK";

/** Every rejection carries its category and the evidence that produced it. */
export class PublicationGateError extends Error {
  readonly category: PublicationGateErrorCategory;
  readonly evidence: string;

  constructor(category: PublicationGateErrorCategory, evidence: string) {
    super(`${category}: ${evidence}`);
    this.name = "PublicationGateError";
    this.category = category;
    this.evidence = evidence;
  }
}

export interface PublicationApproval {
  id: string;
  approvedAt: string;
  reviewer: string;
  note?: string;
}

/**
 * Ids that already held a live /e/ route when the gate shipped (2,824 of them,
 * measured from web/dist/e/). They are released unconditionally — never
 * rate-limited, never re-evaluated against the clock — because withdrawing
 * thousands of already-indexed URLs is a worse signal than the thin content the
 * gate exists to stop.
 */
export interface PublicationBaseline {
  capturedAt: string;
  ids: string[];
}

export interface PublicationApprovalManifest {
  version: 1;
  dailyReleaseLimit: number;
  baseline: PublicationBaseline;
  approvals: PublicationApproval[];
}

export interface PublicationGate {
  readonly dailyReleaseLimit: number;
  /** The UTC day the gate was evaluated on (data/index.json generatedAt). */
  readonly evaluatedDay: string;
  isReleased(id: string): boolean;
  /** "YYYY-MM-DD", or null when the id is not in the manifest at all. */
  releaseDayOf(id: string): string | null;
  /** Approved ids whose scheduled release day has not arrived yet. */
  queuedIds(): readonly string[];
}

function asRecord(value: unknown, evidence: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationGateError("MANIFEST_SHAPE", evidence);
  }
  return value as Record<string, unknown>;
}

function assertEntryId(value: unknown, where: string): string {
  if (typeof value !== "string" || !ENTRY_ID_RE.test(value)) {
    throw new PublicationGateError(
      "MANIFEST_ID",
      `${where} is not a 16-hex entry id: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertInstant(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || !INSTANT_RE.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    throw new PublicationGateError(
      "MANIFEST_INSTANT",
      `${where} is not a UTC ISO-8601 instant: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function parsePublicationApprovalManifest(
  value: unknown,
): PublicationApprovalManifest {
  const root = asRecord(value, `${PUBLICATION_MANIFEST_PATH} must be a JSON object`);

  if (root.version !== 1) {
    throw new PublicationGateError(
      "MANIFEST_SHAPE",
      `unsupported version ${JSON.stringify(root.version)}`,
    );
  }

  const limit = root.dailyReleaseLimit;
  if (
    typeof limit !== "number"
    || !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_DAILY_RELEASE_LIMIT
  ) {
    throw new PublicationGateError(
      "MANIFEST_LIMIT",
      `dailyReleaseLimit must be an integer in 1..${MAX_DAILY_RELEASE_LIMIT}, got ${JSON.stringify(limit)}`,
    );
  }

  const baselineRecord = asRecord(root.baseline, "baseline must be an object");
  const capturedAt = assertInstant(baselineRecord.capturedAt, "baseline.capturedAt");
  if (!Array.isArray(baselineRecord.ids)) {
    throw new PublicationGateError("MANIFEST_SHAPE", "baseline.ids must be an array");
  }

  const seen = new Set<string>();
  const baselineIds: string[] = [];
  baselineRecord.ids.forEach((raw, index) => {
    const id = assertEntryId(raw, `baseline.ids[${index}]`);
    if (seen.has(id)) {
      throw new PublicationGateError(
        "MANIFEST_DUPLICATE",
        `baseline.ids[${index}] repeats ${id}`,
      );
    }
    seen.add(id);
    baselineIds.push(id);
  });

  if (!Array.isArray(root.approvals)) {
    throw new PublicationGateError("MANIFEST_SHAPE", "approvals must be an array");
  }

  const approvals: PublicationApproval[] = [];
  let previousApprovedAt = capturedAt;
  root.approvals.forEach((raw, index) => {
    const record = asRecord(raw, `approvals[${index}] must be an object`);
    const id = assertEntryId(record.id, `approvals[${index}].id`);
    const approvedAt = assertInstant(record.approvedAt, `approvals[${index}].approvedAt`);
    const reviewer = record.reviewer;
    if (typeof reviewer !== "string" || reviewer.trim().length === 0) {
      throw new PublicationGateError(
        "MANIFEST_SHAPE",
        `approvals[${index}].reviewer must be a non-empty string`,
      );
    }
    if (record.note !== undefined && typeof record.note !== "string") {
      throw new PublicationGateError(
        "MANIFEST_SHAPE",
        `approvals[${index}].note must be a string when present`,
      );
    }
    if (seen.has(id)) {
      throw new PublicationGateError(
        "MANIFEST_DUPLICATE",
        `approvals[${index}] repeats already-approved id ${id}`,
      );
    }
    seen.add(id);
    // Append-only. A backdated insert would renumber the release schedule of
    // every later record and could pull an already-released page back off the
    // site, so it is rejected instead of silently reordered.
    if (Date.parse(approvedAt) < Date.parse(previousApprovedAt)) {
      throw new PublicationGateError(
        "MANIFEST_ORDER",
        `approvals[${index}].approvedAt ${approvedAt} precedes ${previousApprovedAt}; ${PUBLICATION_MANIFEST_PATH} is append-only`,
      );
    }
    previousApprovedAt = approvedAt;
    approvals.push(
      record.note === undefined
        ? { id, approvedAt, reviewer }
        : { id, approvedAt, reviewer, note: record.note },
    );
  });

  return {
    version: 1,
    dailyReleaseLimit: limit,
    baseline: { capturedAt, ids: baselineIds },
    approvals,
  };
}

function utcDay(instant: string): string {
  return instant.slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

export interface BuildPublicationGateOptions {
  manifest: PublicationApprovalManifest;
  /** data/index.json `generatedAt`. Data-driven so builds stay deterministic. */
  now: string;
}

/**
 * Greedy, in-order bucket fill. Because `approvedAt` is non-decreasing and each
 * record takes the earliest day at or after both its own approval day and the
 * previous record's landing day, appending records never changes the day an
 * earlier record landed on. That monotonicity is what keeps a released page
 * from ever being pulled back off the site.
 */
export function buildPublicationGate(
  options: BuildPublicationGateOptions,
): PublicationGate {
  const { manifest } = options;
  if (typeof options.now !== "string" || !INSTANT_RE.test(options.now)) {
    throw new PublicationGateError(
      "GATE_CLOCK",
      `the publication gate needs data/index.json generatedAt as a UTC ISO-8601 instant, got ${JSON.stringify(options.now)}`,
    );
  }

  const evaluatedDay = utcDay(options.now);
  const baselineIds = new Set(manifest.baseline.ids);
  const releaseDayById = new Map<string, string>();
  const usedPerDay = new Map<string, number>();
  let cursor = "";

  for (const approval of manifest.approvals) {
    let day = utcDay(approval.approvedAt);
    if (day < cursor) day = cursor;
    while ((usedPerDay.get(day) ?? 0) >= manifest.dailyReleaseLimit) {
      day = nextDay(day);
    }
    usedPerDay.set(day, (usedPerDay.get(day) ?? 0) + 1);
    cursor = day;
    releaseDayById.set(approval.id, day);
  }

  const queued = manifest.approvals
    .filter((approval) => (releaseDayById.get(approval.id) ?? "") > evaluatedDay)
    .map((approval) => approval.id);

  return {
    dailyReleaseLimit: manifest.dailyReleaseLimit,
    evaluatedDay,
    isReleased(id: string): boolean {
      if (baselineIds.has(id)) return true;
      const day = releaseDayById.get(id);
      return day !== undefined && day <= evaluatedDay;
    },
    releaseDayOf(id: string): string | null {
      if (baselineIds.has(id)) return utcDay(manifest.baseline.capturedAt);
      return releaseDayById.get(id) ?? null;
    },
    queuedIds(): readonly string[] {
      return queued;
    },
  };
}
