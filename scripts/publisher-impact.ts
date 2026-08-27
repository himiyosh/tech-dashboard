import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import {
  isListableEntry,
  isPublishableEntry,
  type PublicationEntry,
} from "../web/src/lib/entry-publication.ts";
import { isAddressableDetailEntry } from "../web/src/lib/detail-addressability.ts";
import {
  PUBLICATION_MANIFEST_PATH,
  PublicationGateError,
  buildPublicationGate,
  parsePublicationApprovalManifest,
  type PublicationApprovalManifest,
  type PublicationGate,
} from "../web/src/lib/publication-gate.ts";
import { normalizeTagKey } from "../web/src/lib/tag-normalize.ts";
import { TAG_PAGE_MIN_ENTRIES } from "../web/src/lib/route-inventory.ts";

export const PUBLISHER_DATA_PATH_RE =
  /^data\/(?:index\.json|bodies\.json|stats\.json|archive\/(?:_index|\d{4}-\d{2})\.json)$/;

export const MAX_DETAIL_ROUTE_GROWTH_PER_RUN = 250;
export const MAX_TAG_BASE_ROUTE_GROWTH_PER_RUN = 100;
export const MAX_ARCHIVE_MONTH_GROWTH_PER_RUN = 2;

export interface PublisherImpactEntry extends PublicationEntry {
  id: string;
  source: string;
  category: string;
  tags: string[];
  archiveTier?: "hot" | "warm" | "cold" | "dropped";
  /** Mirrors web/src/lib/data.ts: attached here, never read from stored JSON. */
  publicationHold?: boolean;
}

export interface PublisherRouteSignals {
  detailRoutes: number;
  tagBaseRoutes: number;
  archiveMonths: number;
}

export interface PublisherImpactPlan {
  version: 2;
  baseRef: string;
  changedDataPaths: string[];
  changedEntryIds: string[];
  changedBodyIds: string[];
  changedArchiveMonths: string[];
  affectedCategories: string[];
  affectedTags: string[];
  routeFamilies: string[];
  requiresFullStaticReconciliation: boolean;
  fullReconciliationReasons: string[];
  before: PublisherRouteSignals;
  after: PublisherRouteSignals;
  growth: PublisherRouteSignals;
  incremental: PublisherIncrementalPlan;
}

export interface PublisherIncrementalPlan {
  detailMode: "none" | "exact" | "global";
  detailUpsertIds: string[];
  detailTombstoneIds: string[];
  detailPaths: string[];
  searchMode: "none" | "delta" | "global";
  searchDeltaIds: string[];
  shadowSafe: boolean;
  blockers: string[];
}

interface ImpactFile {
  path: string;
  content: string;
}

interface BuildImpactOptions {
  baseRef: string;
  beforeFiles: ReadonlyMap<string, string | null>;
  afterFiles: ReadonlyMap<string, string | null>;
  changedPaths: readonly string[];
  /**
   * The human-committed approval manifest. Required, not defaulted: an
   * "approve everything" fallback would make the planner disagree with the real
   * route set and hand unrenderable ids to the incremental shadow renderer.
   */
  approvalManifest: PublicationApprovalManifest;
}

interface RepositoryImpactOptions {
  root: string;
  baseRef: string;
  changedFiles: readonly ImpactFile[];
}

function assertDataPath(path: string): void {
  if (!PUBLISHER_DATA_PATH_RE.test(path)) {
    throw new Error(`publisher impact refused unexpected data path: ${path}`);
  }
}

function parseJson(path: string, content: string | null): unknown {
  if (content === null) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`publisher impact could not parse ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function entryRecords(path: string, content: string | null): PublisherImpactEntry[] {
  const parsed = parseJson(path, content);
  if (parsed === null) return [];
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    if (path === "data/index.json" || /^data\/archive\/\d{4}-\d{2}\.json$/.test(path)) {
      throw new Error(`publisher impact expected entries in ${path}`);
    }
    return [];
  }
  return parsed.entries.map((value, index) => {
    if (
      !isRecord(value)
      || typeof value.id !== "string"
      || typeof value.source !== "string"
      || typeof value.category !== "string"
      || !Array.isArray(value.tags)
      || value.tags.some((tag) => typeof tag !== "string")
      || typeof value.sourceType !== "string"
      || typeof value.url !== "string"
    ) {
      throw new Error(`publisher impact found an invalid entry in ${path} at index ${index}`);
    }
    return value as unknown as PublisherImpactEntry;
  });
}

function bodiesById(path: string, content: string | null): Map<string, unknown> {
  const parsed = parseJson(path, content);
  if (parsed === null) return new Map();
  if (!isRecord(parsed) || !isRecord(parsed.bodies)) {
    throw new Error(`publisher impact expected bodies in ${path}`);
  }
  return new Map(Object.entries(parsed.bodies));
}

function changedRecordIds(
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>,
): string[] {
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids]
    .filter((id) => !isDeepStrictEqual(before.get(id), after.get(id)))
    .sort();
}

function entriesById(entries: readonly PublisherImpactEntry[]): Map<string, unknown> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function collectEntryContext(
  ids: ReadonlySet<string>,
  ...groups: ReadonlyArray<readonly PublisherImpactEntry[]>
): { categories: string[]; tags: string[] } {
  const categories = new Set<string>();
  const tags = new Set<string>();
  for (const entries of groups) {
    for (const entry of entries) {
      if (!ids.has(entry.id)) continue;
      categories.add(entry.category);
      for (const tag of entry.tags) {
        const normalized = normalizeTagKey(tag);
        if (normalized) tags.add(normalized);
      }
    }
  }
  return {
    categories: [...categories].sort(),
    tags: [...tags].sort(),
  };
}

function monthDataPaths(files: ReadonlyMap<string, string | null>): string[] {
  return [...files.keys()]
    .filter((path) => /^data\/archive\/\d{4}-\d{2}\.json$/.test(path))
    .sort();
}

function payloadGeneratedAt(path: string, content: string | null): string {
  const parsed = parseJson(path, content);
  if (!isRecord(parsed) || typeof parsed.generatedAt !== "string") {
    throw new PublicationGateError(
      "GATE_CLOCK",
      `publisher impact expected a generatedAt clock in ${path}; the publication`
        + " gate cannot pick a release day without it",
    );
  }
  return parsed.generatedAt;
}

function publicationGateFor(
  manifest: PublicationApprovalManifest,
  files: ReadonlyMap<string, string | null>,
): PublicationGate {
  return buildPublicationGate({
    manifest,
    now: payloadGeneratedAt("data/index.json", files.get("data/index.json") ?? null),
  });
}

function addressableEntries(
  files: ReadonlyMap<string, string | null>,
  gate: PublicationGate,
): Map<string, PublisherImpactEntry> {
  const entries = new Map<string, PublisherImpactEntry>();
  const gated = (entry: PublisherImpactEntry): PublisherImpactEntry => ({
    ...entry,
    publicationHold: !gate.isReleased(entry.id),
  });
  for (const entry of entryRecords(
    "data/index.json",
    files.get("data/index.json") ?? null,
  )) {
    // Must stay a superset-consistent mirror of the real route policy
    // (web/src/lib/detail-addressability.ts): summary-pending entries and
    // publication-gate holds have no /e/[id]/ route, so they must never be
    // planned as detail upserts.
    const candidate = gated(entry);
    if (isListableEntry(candidate) && isAddressableDetailEntry(candidate)) {
      entries.set(candidate.id, candidate);
    }
  }
  for (const path of monthDataPaths(files)) {
    for (const entry of entryRecords(path, files.get(path) ?? null)) {
      const candidate = gated(entry);
      if (
        candidate.archiveTier === "warm"
        && isPublishableEntry(candidate)
        && isAddressableDetailEntry(candidate)
      ) {
        entries.set(candidate.id, candidate);
      }
    }
  }
  return entries;
}

function routeSignals(
  files: ReadonlyMap<string, string | null>,
  gate: PublicationGate,
): PublisherRouteSignals {
  const live = entryRecords("data/index.json", files.get("data/index.json") ?? null)
    .filter((entry) => isListableEntry(entry));
  let archiveMonths = 0;
  for (const path of monthDataPaths(files)) {
    const entries = entryRecords(path, files.get(path) ?? null);
    if (entries.some((entry) => isPublishableEntry(entry))) archiveMonths++;
  }

  const tagCounts = new Map<string, number>();
  for (const entry of live) {
    for (const tag of new Set(entry.tags.map(normalizeTagKey).filter(Boolean))) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return {
    detailRoutes: addressableEntries(files, gate).size,
    tagBaseRoutes: [...tagCounts.values()].filter((count) => count >= TAG_PAGE_MIN_ENTRIES).length,
    archiveMonths,
  };
}

function incrementalPlan(
  changedPaths: readonly string[],
  changedEntryIds: ReadonlySet<string>,
  changedBodyIds: ReadonlySet<string>,
  beforeFiles: ReadonlyMap<string, string | null>,
  afterFiles: ReadonlyMap<string, string | null>,
  beforeGate: PublicationGate,
  afterGate: PublicationGate,
): PublisherIncrementalPlan {
  const bodyOnly =
    changedPaths.length === 1
    && changedPaths[0] === "data/bodies.json";
  const changesEntryCollections = changedPaths.some(
    (path) =>
      path === "data/index.json"
      || path === "data/archive/_index.json"
      || /^data\/archive\/\d{4}-\d{2}\.json$/.test(path),
  );
  const beforeAddressable = addressableEntries(beforeFiles, beforeGate);
  const afterAddressable = addressableEntries(afterFiles, afterGate);
  const candidateIds = new Set([...changedEntryIds, ...changedBodyIds]);
  const detailUpsertIds = [...candidateIds]
    .filter((id) => afterAddressable.has(id))
    .sort();
  const detailTombstoneIds = [...candidateIds]
    .filter((id) => beforeAddressable.has(id) && !afterAddressable.has(id))
    .sort();
  const detailMode = bodyOnly
    ? "exact"
    : changesEntryCollections
      ? "global"
      : "none";
  const searchMode = bodyOnly
    ? "delta"
    : changesEntryCollections
      ? "global"
      : "none";
  const blockers = new Set<string>();
  if (detailMode === "global") {
    blockers.add("detail-pages-embed-global-entry-and-health-state");
  }
  if (searchMode === "global") {
    blockers.add("pagefind-requires-global-reconciliation");
  }
  for (const path of changedPaths) {
    if (path === "data/stats.json") blockers.add("aggregate-pages-depend-on-stats");
    if (path === "data/archive/_index.json") {
      blockers.add("archive-index-affects-archive-sitemap-and-search");
    }
    if (/^data\/archive\/\d{4}-\d{2}\.json$/.test(path)) {
      blockers.add("archive-month-affects-listing-and-addressability");
    }
  }
  const shadowSafe =
    bodyOnly
    && detailMode === "exact"
    && searchMode === "delta";
  return {
    detailMode,
    detailUpsertIds,
    detailTombstoneIds,
    detailPaths: [
      ...detailUpsertIds,
      ...detailTombstoneIds,
    ].sort().map((id) => `/e/${encodeURIComponent(id)}/`),
    searchMode,
    searchDeltaIds: bodyOnly ? [...changedBodyIds].sort() : [],
    shadowSafe,
    blockers: [...blockers].sort(),
  };
}

export function assertPublisherImpactGrowth(plan: PublisherImpactPlan): void {
  const limits: Array<[keyof PublisherRouteSignals, number]> = [
    ["detailRoutes", MAX_DETAIL_ROUTE_GROWTH_PER_RUN],
    ["tagBaseRoutes", MAX_TAG_BASE_ROUTE_GROWTH_PER_RUN],
    ["archiveMonths", MAX_ARCHIVE_MONTH_GROWTH_PER_RUN],
  ];
  for (const [key, limit] of limits) {
    if (plan.growth[key] > limit) {
      throw new Error(
        `publisher route-family growth anomaly: ${key} `
          + `${plan.before[key]} -> ${plan.after[key]} `
          + `(+${plan.growth[key]}) exceeds per-run limit ${limit}`,
      );
    }
  }
}

export function buildPublisherImpactPlan(options: BuildImpactOptions): PublisherImpactPlan {
  const changedPaths = [...new Set(options.changedPaths)].sort();
  for (const path of changedPaths) assertDataPath(path);

  const changedEntryIds = new Set<string>();
  const changedBodyIds = new Set<string>();
  const changedArchiveMonths = new Set<string>();
  const beforeChangedEntries: PublisherImpactEntry[] = [];
  const afterChangedEntries: PublisherImpactEntry[] = [];
  const routeFamilies = new Set<string>();
  const fullReasons = new Set<string>();

  for (const path of changedPaths) {
    const beforeContent = options.beforeFiles.get(path) ?? null;
    const afterContent = options.afterFiles.get(path) ?? null;
    if (path === "data/bodies.json") {
      for (const id of changedRecordIds(
        bodiesById(path, beforeContent),
        bodiesById(path, afterContent),
      )) {
        changedBodyIds.add(id);
      }
      routeFamilies.add("detail-pages");
      routeFamilies.add("search-index");
      // A body appearing or disappearing now moves the entry in or out of
      // sitemap.xml (web/src/lib/detail-indexability.ts), so a body-only run is
      // no longer sitemap-neutral.
      routeFamilies.add("sitemap");
      fullReasons.add("search-index-requires-a-global-rebuild");
      continue;
    }

    if (path === "data/index.json" || /^data\/archive\/\d{4}-\d{2}\.json$/.test(path)) {
      const beforeEntries = entryRecords(path, beforeContent);
      const afterEntries = entryRecords(path, afterContent);
      beforeChangedEntries.push(...beforeEntries);
      afterChangedEntries.push(...afterEntries);
      for (const id of changedRecordIds(
        entriesById(beforeEntries),
        entriesById(afterEntries),
      )) {
        changedEntryIds.add(id);
      }
    }

    if (path === "data/index.json") {
      for (const family of [
        "global-shell",
        "home",
        "timeline-pagination",
        "category-pages",
        "tag-pages-and-recovery",
        "arxiv",
        "knowledge",
        "feeds",
        "sitemap",
        "search-index",
        "status",
        "metrics",
      ]) routeFamilies.add(family);
      fullReasons.add("index-health-and-snapshot-are-imported-by-the-static-shell");
      fullReasons.add("search-index-requires-a-global-rebuild");
    } else if (path === "data/stats.json") {
      for (const family of ["home", "category-pages", "archive", "status", "metrics"]) {
        routeFamilies.add(family);
      }
    } else if (path === "data/archive/_index.json") {
      for (const family of ["archive", "sitemap", "search-index"]) routeFamilies.add(family);
      fullReasons.add("search-index-requires-a-global-rebuild");
    } else {
      const month = path.match(/^data\/archive\/(\d{4}-\d{2})\.json$/)?.[1];
      if (month) {
        changedArchiveMonths.add(month);
        for (const family of [
          "archive",
          "detail-pages",
          "tag-pages-and-recovery",
          "sitemap",
          "search-index",
        ]) routeFamilies.add(family);
        fullReasons.add("search-index-requires-a-global-rebuild");
      }
    }
  }

  if (changedEntryIds.size > 0 || changedBodyIds.size > 0) {
    routeFamilies.add("detail-pages");
  }
  const entryContext = collectEntryContext(
    changedEntryIds,
    beforeChangedEntries,
    afterChangedEntries,
  );
  const beforeGate = publicationGateFor(options.approvalManifest, options.beforeFiles);
  const afterGate = publicationGateFor(options.approvalManifest, options.afterFiles);
  const before = routeSignals(options.beforeFiles, beforeGate);
  const after = routeSignals(options.afterFiles, afterGate);
  const plan: PublisherImpactPlan = {
    version: 2,
    baseRef: options.baseRef,
    changedDataPaths: changedPaths,
    changedEntryIds: [...changedEntryIds].sort(),
    changedBodyIds: [...changedBodyIds].sort(),
    changedArchiveMonths: [...changedArchiveMonths].sort(),
    affectedCategories: entryContext.categories,
    affectedTags: entryContext.tags,
    routeFamilies: [...routeFamilies].sort(),
    requiresFullStaticReconciliation: fullReasons.size > 0,
    fullReconciliationReasons: [...fullReasons].sort(),
    before,
    after,
    growth: {
      detailRoutes: after.detailRoutes - before.detailRoutes,
      tagBaseRoutes: after.tagBaseRoutes - before.tagBaseRoutes,
      archiveMonths: after.archiveMonths - before.archiveMonths,
    },
    incremental: incrementalPlan(
      changedPaths,
      changedEntryIds,
      changedBodyIds,
      options.beforeFiles,
      options.afterFiles,
      beforeGate,
      afterGate,
    ),
  };
  assertPublisherImpactGrowth(plan);
  return plan;
}

function archivePathsFromWorktree(root: string): string[] {
  return readdirSync(resolve(root, "data/archive"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:_index|\d{4}-\d{2})\.json$/.test(entry.name))
    .map((entry) => `data/archive/${entry.name}`);
}

function pathsAtRef(root: string, baseRef: string): string[] {
  const output = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      baseRef,
      "--",
      "data/index.json",
      "data/bodies.json",
      "data/stats.json",
      "data/archive",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter((path) => PUBLISHER_DATA_PATH_RE.test(path));
}

function fileAtRef(root: string, baseRef: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${baseRef}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function planPublisherImpactFromRepository(
  options: RepositoryImpactOptions,
): PublisherImpactPlan {
  if (!/^[0-9a-f]{40}$/.test(options.baseRef)) {
    throw new Error(`publisher impact requires an exact lowercase commit SHA: ${options.baseRef}`);
  }
  const changedOverlay = new Map(options.changedFiles.map((file) => [file.path, file.content]));
  for (const path of changedOverlay.keys()) assertDataPath(path);
  const allPaths = new Set([
    "data/index.json",
    "data/bodies.json",
    "data/stats.json",
    "data/archive/_index.json",
    ...archivePathsFromWorktree(options.root),
    ...pathsAtRef(options.root, options.baseRef),
    ...changedOverlay.keys(),
  ]);
  const beforeFiles = new Map<string, string | null>();
  const afterFiles = new Map<string, string | null>();
  for (const path of allPaths) {
    assertDataPath(path);
    beforeFiles.set(path, fileAtRef(options.root, options.baseRef, path));
    const overlay = changedOverlay.get(path);
    afterFiles.set(
      path,
      overlay ?? readFileSync(resolve(options.root, path), "utf8"),
    );
  }
  const manifestPath = resolve(options.root, PUBLICATION_MANIFEST_PATH);
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw new PublicationGateError(
      "MANIFEST_SHAPE",
      `could not read ${PUBLICATION_MANIFEST_PATH} at ${manifestPath}: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const approvalManifest = parsePublicationApprovalManifest(
    JSON.parse(manifestRaw) as unknown,
  );
  return buildPublisherImpactPlan({
    approvalManifest,
    baseRef: options.baseRef,
    beforeFiles,
    afterFiles,
    changedPaths: options.changedFiles.map((file) => file.path),
  });
}

export function formatPublisherImpactMarkdown(plan: PublisherImpactPlan): string {
  const list = (values: readonly string[]) => values.length > 0 ? values.join(", ") : "none";
  return [
    "## Publisher impact",
    "",
    `- Base snapshot: \`${plan.baseRef}\``,
    `- Changed data: ${list(plan.changedDataPaths.map((path) => `\`${path}\``))}`,
    `- Changed detail entries: ${plan.changedEntryIds.length}`,
    `- Changed body records: ${plan.changedBodyIds.length}`,
    `- Archive months: ${list(plan.changedArchiveMonths)}`,
    `- Route families: ${list(plan.routeFamilies)}`,
    `- Full static reconciliation required: ${plan.requiresFullStaticReconciliation ? "yes" : "no"}`,
    `- Route growth: detail ${plan.growth.detailRoutes >= 0 ? "+" : ""}${plan.growth.detailRoutes}, tag ${plan.growth.tagBaseRoutes >= 0 ? "+" : ""}${plan.growth.tagBaseRoutes}, archive months ${plan.growth.archiveMonths >= 0 ? "+" : ""}${plan.growth.archiveMonths}`,
    `- Incremental detail mode: ${plan.incremental.detailMode} (${plan.incremental.detailPaths.length} paths)`,
    `- Incremental search mode: ${plan.incremental.searchMode} (${plan.incremental.searchDeltaIds.length} records)`,
    `- Shadow-safe slice: ${plan.incremental.shadowSafe ? "yes" : "no"}`,
    `- Incremental blockers: ${list(plan.incremental.blockers)}`,
    "",
  ].join("\n");
}

const isDirectInvocation =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  if (process.argv.length !== 4 || process.argv[2] !== "--report") {
    console.error("use: node --import tsx scripts/publisher-impact.ts --report <impact.json>");
    process.exitCode = 1;
  } else {
    const parsed = JSON.parse(readFileSync(resolve(process.argv[3]!), "utf8")) as PublisherImpactPlan;
    process.stdout.write(formatPublisherImpactMarkdown(parsed));
  }
}
