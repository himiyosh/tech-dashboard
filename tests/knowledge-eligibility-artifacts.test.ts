/**
 * Issue #237 — evergreen announcement posts are excluded from the Knowledge
 * lane (R-022) but must keep every other surface: Timeline, category listing,
 * detail addressability / canonical URL, and the monthly archive record.
 *
 * The invariant is asserted against the corpus, never against a fixed live
 * position. `data/index.json` is capped per source (`PER_SOURCE_CAP`, then
 * `INDEX_LIMIT` in worker/src/index.ts) and ranked by
 * `importance * 1000 - ageDays`, so an article always loses its live slot to a
 * newer one eventually and survives only as a `data/archive/{YYYY-MM}.json`
 * record. A test that requires a frozen id to stay in `RAW_ENTRIES` therefore
 * fails permanently once that happens — and because the Publisher verify gate
 * is fail-closed, that failure also blocks the publish that would refresh the
 * data (the deadlock observed 2026-08-07: `5abc0b85ffaee46f` and
 * `07df858350edbc9d` sat at rank 49-50 of the 50-slot `google-cloud-blog`
 * window, so every new post from that source evicted them).
 *
 * Layout:
 *  1. policy — every stored exclusion in live + archive is still ineligible,
 *     both as stored and from raw title/snippet alone. This is the detector
 *     for a silently lifted exclusion: loosening the announcement /
 *     availability contract, or dropping the `knowledgeEligible === false`
 *     branch, empties or flips this population.
 *  2. live retention — property-based over the current live exclusions, so the
 *     live surfaces stay covered no matter which article holds a slot today.
 *  3. issue #237 anchors — the original verification ids, checked wherever they
 *     now live (live index and/or monthly archive).
 *
 * Long-form bodies are deliberately out of scope: `data/bodies.json` is
 * byte-budget managed (LL-411), so presence there is not a #237 invariant.
 * `tests/data-schema.test.ts` owns that artifact.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARCHIVE_WARM_ENTRIES } from "../web/src/lib/archive.ts";
import {
  ALL_ENTRIES,
  ARXIV_ENTRIES,
  KNOWLEDGE_ENTRIES,
  MAIN_TIMELINE_ENTRIES,
  PUBLISHABLE_ENTRIES,
  RAW_ENTRIES,
  entriesFor,
  entriesForTagPage,
  isArxivEntry,
  type NormalizedEntry,
} from "../web/src/lib/data.ts";
import { collectAddressableDetailEntries } from "../web/src/lib/detail-addressability.ts";
import { entryDestination } from "../web/src/lib/entry-destination.ts";
import { knowledgeEligibility } from "../web/src/lib/knowledge-eligibility.ts";
import { detailPath } from "../web/src/lib/route-inventory.ts";
import { SOURCE_META } from "../web/src/lib/source-meta.ts";
import { normalizeTagKey } from "../web/src/lib/tag-normalize.ts";

const ISSUE_237_ENTRIES = [
  {
    id: "bed450615ddfd03d",
    url: "https://aws.amazon.com/blogs/machine-learning/introducing-claude-opus-5-on-aws-anthropics-most-capable-opus-model/",
  },
  {
    id: "7ce8f0655e5249f3",
    url: "https://aws.amazon.com/blogs/machine-learning/openai-gpt-5-6-sol-terra-and-luna-are-now-generally-available-on-amazon-bedrock/",
  },
  {
    id: "7b3cb462c9d102ab",
    url: "https://cloud.google.com/blog/products/sap-google-cloud/sap-and-google-cloud-launch-bdc-connect-for-bigquery/",
  },
  {
    id: "52a59dad31dc17b8",
    url: "https://cloud.google.com/blog/products/ai-machine-learning/google-is-a-leader-in-the-gartner-magic-quadrant-for-conversational-ai/",
  },
  {
    id: "5abc0b85ffaee46f",
    url: "https://cloud.google.com/blog/products/management-tools/alert-with-sql-in-cloud-monitoring-observability-analytics/",
  },
  {
    id: "07df858350edbc9d",
    url: "https://cloud.google.com/blog/products/identity-security/securing-agentic-ai-whats-new-in-vpc-service-controls/",
  },
  {
    id: "37803898e498b24d",
    url: "https://devblogs.microsoft.com/foundry/document-translation-build-2026/",
  },
  {
    id: "1fe4d821705368ab",
    url: "https://aws.amazon.com/blogs/machine-learning/introducing-claude-apps-gateway-for-aws/",
  },
  {
    id: "4804d6346be88fc2",
    url: "https://aws.amazon.com/blogs/machine-learning/introducing-grok-on-amazon-bedrock/",
  },
  {
    id: "b774ed271b22e41b",
    url: "https://cloud.google.com/blog/products/data-analytics/conversational-analytics-in-google-data-cloud-in-q326/",
  },
  {
    id: "592d34bdee2e8b6a",
    url: "https://cloud.google.com/blog/products/identity-security/future-proofing-data-integrity-quantum-safe-digital-signatures-in-cloud-kms/",
  },
] as const;

/**
 * A stored archive row. Hot rows mirror a live entry and are written without
 * summaries to keep the current-month bundle small (LL-044), so the summary
 * fields are optional here even though they are required on a live entry.
 */
type ArchiveRecord =
  & Omit<NormalizedEntry, "summaryJa" | "summaryEn">
  & Partial<Pick<NormalizedEntry, "summaryJa" | "summaryEn">>
  & { archiveMonth: string };

/** The fields the Knowledge eligibility contract reads, shared by both shapes. */
type KnowledgeRecord = Pick<NormalizedEntry, "id" | "url" | "source" | "title" | "category">
  & Partial<Pick<NormalizedEntry, "contentSnippet" | "evergreen" | "knowledgeEligible" | "publishedAt" | "collectedAt">>;

const ARCHIVE_RECORDS: readonly ArchiveRecord[] = readdirSync("data/archive")
  .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
  .flatMap((name) => {
    const payload = JSON.parse(
      readFileSync(join("data/archive", name), "utf8"),
    ) as { entries?: NormalizedEntry[] };
    const archiveMonth = name.slice(0, 7);
    return (payload.entries ?? []).map((entry) => ({ ...entry, archiveMonth }));
  });

const ARCHIVE_BY_ID = new Map(ARCHIVE_RECORDS.map((record) => [record.id, record]));

const ADDRESSABLE_DETAIL_IDS = new Set(
  collectAddressableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES).map((entry) => entry.id),
);

const PUBLISHABLE_IDS = new Set(PUBLISHABLE_ENTRIES.map((entry) => entry.id));

/** Issue #237 population: evergreen articles the pipeline stamped Knowledge-excluded. */
function isStoredKnowledgeExclusion(record: KnowledgeRecord): boolean {
  return record.evergreen === true && record.knowledgeEligible === false;
}

const LIVE_EXCLUSIONS = RAW_ENTRIES.filter(isStoredKnowledgeExclusion);
const ARCHIVED_EXCLUSIONS = ARCHIVE_RECORDS.filter(isStoredKnowledgeExclusion);
const CORPUS_EXCLUSIONS: readonly KnowledgeRecord[] = [
  ...LIVE_EXCLUSIONS,
  ...ARCHIVED_EXCLUSIONS,
];

function describeRecord(record: KnowledgeRecord): string {
  return `${record.source} ${record.id}: ${record.title}`;
}

function archiveMonthOf(record: KnowledgeRecord): string {
  return String(record.publishedAt ?? record.collectedAt ?? "").slice(0, 7);
}

/**
 * Every non-Knowledge surface a live entry must keep. Returns the surfaces it
 * lost, so a failure names both the entry and what went missing.
 */
function missingLiveSurfaces(entry: NormalizedEntry): string[] {
  const holdsId = (candidate: { id: string }): boolean => candidate.id === entry.id;
  const arxiv = isArxivEntry(entry);
  const lane = arxiv ? ARXIV_ENTRIES : MAIN_TIMELINE_ENTRIES;
  const destination = entryDestination(entry);
  const missing: string[] = [];

  if (!ALL_ENTRIES.some(holdsId)) missing.push("listing / search corpus");
  if (!lane.some(holdsId)) missing.push(arxiv ? "Research lane" : "Timeline");
  if (!arxiv && !entriesFor(entry.category).some(holdsId)) {
    missing.push(`category page ${entry.category}`);
  }
  for (const tag of entry.tags) {
    // Tag listings are keyed by the normalized tag; a tag that normalizes away
    // never had a listing to lose.
    if (!normalizeTagKey(tag)) continue;
    if (!entriesForTagPage(tag).some(holdsId)) missing.push(`tag listing ${tag}`);
  }
  if (!ADDRESSABLE_DETAIL_IDS.has(entry.id)) missing.push("detail route");
  if (destination.external || destination.href !== detailPath(entry.id)) {
    missing.push(`in-site canonical URL (got ${destination.href})`);
  }
  // Evergreen never decays past warm (harness/half-life.ts decideTier), and
  // cold/dropped would strip the individual route.
  if (entry.archiveTier !== "hot" && entry.archiveTier !== "warm") {
    missing.push(`evergreen archive tier (got ${String(entry.archiveTier)})`);
  }
  if (!ARCHIVE_BY_ID.has(entry.id)) missing.push("monthly archive record");
  if (!SOURCE_META.some((source) => source.id === entry.source)) missing.push("source metadata");
  if (PUBLISHABLE_IDS.has(entry.id)) {
    if (!entry.summaryJa.trim()) missing.push("Japanese summary");
    if (!entry.summaryEn.trim()) missing.push("English summary");
  }
  if (KNOWLEDGE_ENTRIES.some(holdsId)) missing.push("(leaked INTO the Knowledge lane)");
  return missing;
}

/** What an archive record must retain once the article has no live slot left. */
function missingArchiveGuarantees(record: ArchiveRecord): string[] {
  const missing: string[] = [];
  if (record.archiveMonth !== archiveMonthOf(record)) {
    missing.push(`archive month ${record.archiveMonth} != published ${archiveMonthOf(record)}`);
  }
  if (!record.url) missing.push("canonical URL");
  if (!record.category) missing.push("category");
  if (!SOURCE_META.some((source) => source.id === record.source)) missing.push("source metadata");
  if (record.evergreen !== true) missing.push("evergreen stamp");
  if (record.knowledgeEligible !== false) missing.push("Knowledge exclusion stamp");
  return missing;
}

describe("Knowledge exclusion contract (live + archive corpus)", () => {
  it("keeps a stamped exclusion population in both the live index and the archive", () => {
    // Not just an anti-vacuity guard: restamping runs on every publish
    // (restampEntryFromSource), so an exclusion that stopped being applied
    // drains this population instead of flipping individual assertions.
    // Aging cannot empty it — evicted articles are replaced by newer posts from
    // the same evergreen sources, and archive months are merged, never pruned.
    expect(
      LIVE_EXCLUSIONS.length,
      "live に evergreen の Knowledge 除外が 1 件も無い。registry の evergreen ソースと normalize.ts の stamp を確認すること",
    ).toBeGreaterThan(0);
    expect(
      ARCHIVED_EXCLUSIONS.length,
      "archive の Knowledge 除外レコードが消えた。data/archive の月次バンドルを確認すること",
    ).toBeGreaterThan(0);
  });

  it("keeps every stored exclusion ineligible under the current contract", () => {
    const eligible = CORPUS_EXCLUSIONS
      .filter((record) => knowledgeEligibility(record).eligible)
      .map(describeRecord);
    expect(eligible).toEqual([]);
  });

  it("keeps raw title/snippet alone excluding them, without the stored flag", () => {
    // The stored flag is derived, not hand-maintained (harness/pipeline/
    // normalize.ts). If the announcement / availability contract were loosened,
    // the next restamp would drop the flag and leak these into Knowledge.
    const eligible = CORPUS_EXCLUSIONS
      .filter((record) => knowledgeEligibility({ ...record, knowledgeEligible: undefined }).eligible)
      .map(describeRecord);
    expect(eligible).toEqual([]);
  });

  it("keeps every stored exclusion out of the Knowledge lane", () => {
    const leaked = KNOWLEDGE_ENTRIES.filter(isStoredKnowledgeExclusion).map(describeRecord);
    expect(leaked).toEqual([]);
  });
});

describe("Knowledge exclusions keep every other live surface", () => {
  it("keeps each live exclusion on all non-Knowledge surfaces", () => {
    expect(LIVE_EXCLUSIONS.length, "検証対象の live 母集団が空").toBeGreaterThan(0);
    const violations = LIVE_EXCLUSIONS.flatMap((entry) =>
      missingLiveSurfaces(entry).map((surface) => `${describeRecord(entry)} → ${surface}`),
    );
    expect(violations).toEqual([]);
  });

  it("keeps each archived exclusion addressable in its month bundle", () => {
    expect(ARCHIVED_EXCLUSIONS.length, "検証対象の archive 母集団が空").toBeGreaterThan(0);
    const violations = ARCHIVED_EXCLUSIONS.flatMap((record) =>
      missingArchiveGuarantees(record).map((surface) => `${describeRecord(record)} → ${surface}`),
    );
    expect(violations).toEqual([]);
  });
});

describe("Knowledge eligibility artifacts", () => {
  it.each(ISSUE_237_ENTRIES)(
    "keeps $id everywhere except the Knowledge lane",
    ({ id, url }) => {
      // The archive record is permanent: month bundles are merged, never
      // pruned, so this holds whether or not the article still has a live slot.
      const archived = ARCHIVE_BY_ID.get(id);
      expect(archived).toBeDefined();
      expect(missingArchiveGuarantees(archived!)).toEqual([]);
      expect(archived!.url).toBe(url);

      const live = RAW_ENTRIES.find((candidate) => candidate.id === id);
      const record: KnowledgeRecord = live ?? archived!;
      expect(record).toMatchObject({ id, url, evergreen: true, knowledgeEligible: false });
      expect(knowledgeEligibility(record).eligible).toBe(false);
      expect(
        knowledgeEligibility({ ...record, knowledgeEligible: undefined }).eligible,
      ).toBe(false);
      expect(KNOWLEDGE_ENTRIES.some((candidate) => candidate.id === id)).toBe(false);

      // While the article still holds a live slot, every live surface keeps it.
      // Once the per-source cap evicts it, the archive guarantees above are the
      // whole contract — the article cannot come back into the live index.
      if (live) {
        expect(missingLiveSurfaces(live)).toEqual([]);
        expect(live.category).toBe(archived!.category);
      }
    },
  );
});
