// Migrate "snippet masquerade" summaries to the deterministic pending state so
// the summary queue will actually regenerate them.
//
// THE BUG (Issue #1, LL-118): the old normalize.placeholderSummary() wrote a raw
// RSS snippet sliced at 120/200 chars into summaryJa/summaryEn (and for JA
// sources, summaryEn = the raw title). Those are non-empty and carry NO fallback
// marker, so the worker gate needsGeneratedContent() treats them as COMPLETE and
// never queues them. Result: ~928 of 1740 live entries (53%) display a
// mid-sentence-truncated snippet that was never summarized by any AI model.
//
// THE FIX HERE: overwrite each masquerade summary with the SAME deterministic
// bilingual pending template the (fixed) worker publishes for a freshly collected
// entry -- buildFallbackSummary() from worker/src/content-fallback.ts. That state
// is:
//   - gate-eligible   : worker needsGeneratedContent() returns true (JA entries
//                       via the EN "AI summary not yet available" needle; EN
//                       entries via the "このエントリは " JA prefix), so the queue
//                       regenerates it.
//   - pending (web)   : isDeterministicFallbackEntry() true -> excluded from
//                       Featured/Top-3/feeds until a real summary lands (LL-074).
//   - schema-valid    : both languages non-empty (LL-028) so data-schema stays
//                       green and no card shows a blank summary in the meantime.
// It is byte-identical to what the deployed (fixed) worker would produce on
// re-collection, so the hourly merge cannot fight it (entry-merge fillText keeps
// the fresh empty->fallback value).
//
// CONSERVATIVE + IDEMPOTENT: only rewrites entries matching a masquerade
// fingerprint AND not already pending-marked. Genuine AI summaries (complete
// 90-180 char sentences ending in punctuation) match none of the fingerprints.
// Safe to re-run: a migrated entry is already pending, so it is skipped.
//
// NOTE: durability requires the FIXED worker to be deployed (R-008/LL-073).
// Until then the OLD worker can re-collect a still-in-feed URL and re-create a
// masquerade with a newer collectedAt, which wins the merge and undoes the
// migration for that URL. Run this AFTER the worker deploy.
//
// Usage:
//   npx tsx scripts/migrate-stuck-summaries-to-pending.mjs --dry   # report only
//   npx tsx scripts/migrate-stuck-summaries-to-pending.mjs         # apply + write

import fs from "node:fs";
import { buildFallbackSummary } from "../worker/src/content-fallback.ts";

const DRY = process.argv.includes("--dry");
const FILE = "data/index.json";

const FB_JA_PREFIX = "このエントリは ";
const FB_JA_NEEDLE = "AI 要約が未生成";
const FB_EN_NEEDLE = "AI summary not yet available";

/** Already in a deterministic pending state -> nothing to migrate. */
function isPending(s) {
  s = s || "";
  return s.startsWith(FB_JA_PREFIX) || s.includes(FB_JA_NEEDLE) || s.includes(FB_EN_NEEDLE);
}

const JA_TERMINAL = /[。．.!?！？」』）)\u2026]$/; // sentence-final punctuation / ellipsis
const EN_TERMINAL = /[.!?"'\u2019\u201d)\]\u2026]$/;

/**
 * A "snippet masquerade" is the fingerprint of the old placeholderSummary():
 *   (s1) summaryEn === title         : the raw (often Japanese) title reused as
 *                                       the English summary. A genuine AI summary
 *                                       is never identical to the title.
 *   (s2) summaryJa sliced at exactly 120 chars with no terminal punctuation:
 *                                       ja: snippet.slice(0,120) mid-cut.
 *   (s3) summaryEn sliced at exactly 200 chars with no terminal punctuation:
 *                                       en: snippet.slice(0,200) mid-cut.
 * The length-based signals additionally require a missing terminal punctuation
 * so a genuine (rare) 120/200-char complete sentence is not swept in.
 */
function isMasquerade(e) {
  const ja = e.summaryJa || "";
  const en = e.summaryEn || "";
  if (isPending(ja) || isPending(en)) return false; // already pending
  const s1 = !!en && en === e.title;
  const s2 = ja.length === 120 && !JA_TERMINAL.test(ja);
  const s3 = en.length === 200 && !EN_TERMINAL.test(en);
  return s1 || s2 || s3;
}

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
let migrated = 0;
const bySource = {};
const samples = [];

for (const e of data.entries) {
  if (!isMasquerade(e)) continue;
  const fb = buildFallbackSummary(e);
  if (samples.length < 6) {
    samples.push({
      id: e.id,
      source: e.source,
      title: (e.title || "").slice(0, 44),
      beforeJa: (e.summaryJa || "").slice(0, 40),
      beforeEn: (e.summaryEn || "").slice(0, 40),
      afterJa: fb.summaryJa.slice(0, 40),
      afterEn: fb.summaryEn.slice(0, 40),
    });
  }
  e.summaryJa = fb.summaryJa;
  e.summaryEn = fb.summaryEn;
  bySource[e.source] = (bySource[e.source] || 0) + 1;
  migrated++;
}

console.log(`total entries: ${data.entries.length}`);
console.log(`masquerade entries migrated to pending: ${migrated}`);
console.log("by source (top 15):");
Object.entries(bySource)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .forEach(([s, n]) => console.log(`  ${s}: ${n}`));
console.log("samples:");
console.log(JSON.stringify(samples, null, 1));

if (DRY) {
  console.log("\n(dry run -- no file written)");
} else if (migrated > 0) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`\nwrote ${FILE}`);
} else {
  console.log("\nnothing to migrate -- file unchanged");
}
