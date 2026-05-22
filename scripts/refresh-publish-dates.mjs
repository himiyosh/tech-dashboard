#!/usr/bin/env node
/**
 * Scan data/index.json for entries where publishedAt === collectedAt
 * (a strong indicator that the collector did not return a real publish date
 * and the normalize fallback filled it with the collection timestamp).
 *
 * For each such entry, fetch the article HTML and try to extract the real
 * publish date from:
 *   1. <meta property="article:published_time" content="...">
 *   2. JSON-LD "datePublished":"..."
 *   3. <time datetime="...">
 *   4. Anthropic-style bare "Mon DD, YYYY" near the title
 *
 * If found, rewrites entry.publishedAt in place.
 *
 * Usage:
 *   node scripts/refresh-publish-dates.mjs           # dry-run, prints plan
 *   node scripts/refresh-publish-dates.mjs --apply   # write back to data/index.json
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(REPO, "data/index.json");

const apply = process.argv.includes("--apply");

function extractFromHtml(html) {
  const meta = html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i)
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="article:published_time"/i);
  if (meta) {
    const d = new Date(meta[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (ld) {
    let s = ld[1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const tm = html.match(/<time[^>]+datetime="([^"]+)"/i);
  if (tm) {
    const d = new Date(tm[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // Anthropic Next.js layout: bare "Mon DD, YYYY" in the PostDetail hero.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").slice(0, 80_000);
  const bare = text.match(/\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/);
  if (bare) {
    const d = new Date(`${bare[1]} 00:00:00 UTC`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

async function fetchDate(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; tech-dashboard-bot/0.1)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const iso = extractFromHtml(html);
    return iso ? { ok: true, iso } : { ok: false, reason: "no date in html" };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

async function main() {
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  const data = JSON.parse(raw);
  const suspects = data.entries.filter(
    (e) => e.publishedAt && e.collectedAt &&
      Date.parse(e.publishedAt) === Date.parse(e.collectedAt),
  );
  console.log(`scan: ${suspects.length} suspicious entries (publishedAt === collectedAt) out of ${data.entries.length}`);

  let updated = 0;
  let failed = 0;
  for (const e of suspects) {
    const res = await fetchDate(e.url);
    if (res.ok) {
      console.log(`OK  ${e.source.padEnd(20)} ${e.publishedAt} -> ${res.iso}  ${e.url}`);
      if (apply) e.publishedAt = res.iso;
      updated++;
    } else {
      console.log(`SKIP ${e.source.padEnd(20)} ${res.reason}  ${e.url}`);
      failed++;
    }
  }

  console.log(`\nsummary: updated=${updated} failed=${failed} apply=${apply}`);

  if (apply && updated > 0) {
    // Re-sort entries by publishedAt desc (same convention as index-builder)
    data.entries.sort((a, b) => {
      const ma = Date.parse(a.publishedAt) || 0;
      const mb = Date.parse(b.publishedAt) || 0;
      return mb - ma;
    });
    await fs.writeFile(INDEX_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`wrote ${INDEX_PATH}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
