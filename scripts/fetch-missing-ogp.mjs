#!/usr/bin/env node
/**
 * Backfill missing `image` (OGP thumbnail) for data/index.json entries.
 *
 * Strategy:
 *  1. YouTube videos  → deterministic thumbnail URL (no fetch needed)
 *  2. Other entries   → fetch article HTML and extract <meta property="og:image">
 *
 * Usage:
 *   node scripts/fetch-missing-ogp.mjs [--dry-run] [--limit=100]
 *
 * Options:
 *   --dry-run    Print what would be changed without writing
 *   --limit=N    Process at most N entries (default: 500)
 *   --concurrency=N  Parallel fetch concurrency (default: 5)
 *   --timeout=N  Per-request timeout in ms (default: 8000)
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "data", "index.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "500",
);
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "5",
);
const TIMEOUT_MS = parseInt(
  args.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? "8000",
);

// Sources that structurally cannot have OGP images — skip fetching.
const SKIP_SOURCES = new Set([
  "arxiv-cs-ai",
  "arxiv-cs-cl",
  "arxiv-cs-lg",
  "arxiv-cs-se",
  "cursor-changelog",
  "dora-insights",
  "hn-ai",
]);

/** Extract YouTube video ID from a watch URL or youtu.be short URL. */
function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be"))
      return u.pathname.slice(1).split("?")[0];
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

/** Return YouTube thumbnail URL for a video ID. */
function youtubeThumbnail(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

/** Fetch og:image from an article URL with a timeout. */
async function fetchOgImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "TechDashboard-OGP-Bot/1.0 (github.com/himiyosh/tech-dashboard)",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    // og:image
    const m =
      html.match(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      ) ??
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      );
    if (m?.[1]) {
      const imgUrl = m[1].startsWith("//") ? "https:" + m[1] : m[1];
      return imgUrl.startsWith("http") ? imgUrl : null;
    }
    // twitter:image fallback
    const t =
      html.match(
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      ) ??
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
      );
    if (t?.[1]) {
      const imgUrl = t[1].startsWith("//") ? "https:" + t[1] : t[1];
      return imgUrl.startsWith("http") ? imgUrl : null;
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Run fn for each item in arr, at most concurrency at a time. */
async function pMap(arr, fn, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < arr.length) {
      const idx = i++;
      results[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(
    `📷 fetch-missing-ogp — limit=${LIMIT}, concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms${DRY_RUN ? " [DRY RUN]" : ""}`,
  );

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  const entries = data.entries ?? [];

  // Candidates: live entries without an image
  const candidates = entries
    .filter((e) => e.live !== false && !e.image)
    .slice(0, LIMIT);

  console.log(
    `  Candidates: ${candidates.length} (from ${entries.filter((e) => e.live !== false && !e.image).length} total missing)`,
  );

  // Stats
  let youtube = 0;
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let updated = 0;

  // Phase 1: YouTube — deterministic, no fetch
  const ytEntries = candidates.filter((e) => {
    const vid = youtubeVideoId(e.url ?? "");
    if (!vid) return false;
    e._resolvedImage = youtubeThumbnail(vid);
    youtube++;
    return true;
  });

  // Phase 2: skipped sources
  const skipEntries = candidates.filter(
    (e) => !e._resolvedImage && SKIP_SOURCES.has(e.source),
  );
  skipEntries.forEach((e) => {
    e._skip = true;
    skipped++;
  });

  // Phase 3: fetch OGP for remaining
  const fetchEntries = candidates.filter((e) => !e._resolvedImage && !e._skip);
  console.log(
    `  YouTube: ${ytEntries.length}, skip: ${skipEntries.length}, fetch: ${fetchEntries.length}`,
  );

  if (fetchEntries.length > 0 && !DRY_RUN) {
    process.stdout.write(`  Fetching OGP [0/${fetchEntries.length}]`);
    let done = 0;
    await pMap(
      fetchEntries,
      async (entry) => {
        entry._resolvedImage = await fetchOgImage(entry.url ?? "");
        done++;
        if (done % 20 === 0 || done === fetchEntries.length) {
          process.stdout.write(
            `\r  Fetching OGP [${done}/${fetchEntries.length}]`,
          );
        }
        if (entry._resolvedImage) fetched++;
        else failed++;
      },
      CONCURRENCY,
    );
    console.log();
  }

  // Apply results back to entries map
  const entryByUrl = new Map(entries.map((e) => [e.url, e]));
  for (const candidate of candidates) {
    if (candidate._resolvedImage) {
      const original = entryByUrl.get(candidate.url);
      if (original) {
        if (!DRY_RUN) original.image = candidate._resolvedImage;
        updated++;
      }
    }
    delete candidate._resolvedImage;
    delete candidate._skip;
  }

  console.log(
    `\n✅ Results: youtube=${youtube}, fetched=${fetched}, failed=${failed}, skipped=${skipped}, updated=${updated}`,
  );

  if (!DRY_RUN && updated > 0) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2));
    console.log(`  💾 Saved ${INDEX_PATH}`);
  } else if (DRY_RUN) {
    console.log("  [dry-run] No files written.");
  }
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
