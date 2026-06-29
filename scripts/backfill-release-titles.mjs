// Backfill release/changelog title branding into existing data/index.json.
//
// Single-source (LL-081): imports the SAME decorateReleaseTitle the collection
// pipeline uses (harness/pipeline/normalize.ts), so migrated data matches what
// future collects produce. Conservative + idempotent: only brands titles whose
// product is unidentifiable (e.g. cline "CLI v3.0.31" -> "Cline CLI v3.0.31");
// already-identifiable titles (langchain "langchain-core==1.4.8", github
// changelog headlines) are left untouched. Safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-release-titles.mjs          # apply + write
//   npx tsx scripts/backfill-release-titles.mjs --dry     # report only

import fs from "node:fs";
import { decorateReleaseTitle } from "../harness/pipeline/normalize.ts";
import { REGISTRY } from "../harness/registry.ts";

const DRY = process.argv.includes("--dry");
const FILE = "data/index.json";

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
let changed = 0;
const samples = [];

for (const e of data.entries) {
  if (e.sourceType !== "release" && e.sourceType !== "changelog") continue;
  const src = REGISTRY[e.source];
  if (!src) continue;

  const beforeTitle = e.title;
  const nextTitle = decorateReleaseTitle(e.title ?? "", src);
  let touched = false;

  if (nextTitle !== e.title) {
    e.title = nextTitle;
    touched = true;
  }
  // Decorate populated language fields too (release version tags are
  // language-neutral; idempotent decoration brands them consistently and
  // never blanks an existing value).
  if (e.titleJa) {
    const nextJa = decorateReleaseTitle(e.titleJa, src);
    if (nextJa !== e.titleJa) {
      e.titleJa = nextJa;
      touched = true;
    }
  }
  if (e.titleEn) {
    const nextEn = decorateReleaseTitle(e.titleEn, src);
    if (nextEn !== e.titleEn) {
      e.titleEn = nextEn;
      touched = true;
    }
  }

  if (touched) {
    changed++;
    if (samples.length < 20) samples.push(`  ${JSON.stringify(beforeTitle)} -> ${JSON.stringify(e.title)}`);
  }
}

console.log(`release/changelog title branding: ${changed} entries ${DRY ? "would change" : "changed"}`);
if (samples.length) console.log(samples.join("\n"));

if (!DRY && changed > 0) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${FILE}`);
} else if (!DRY) {
  console.log("no changes; file untouched");
}
