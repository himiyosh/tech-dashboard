// One-shot backfill: fetch og:image for entries lacking entry.image.
// Usage: node scripts/backfill-og.mjs
import fs from "node:fs";

const PATH = "data/index.json";
const CONCURRENCY = 12;
const TIMEOUT_MS = 7000;
const READ_LIMIT = 96 * 1024;

function matchMetaContent(html, prop) {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*property\\s*=\\s*["']${escaped}["']`, "i"),
    new RegExp(`<meta[^>]+name\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function absolutize(src, base) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

async function fetchOg(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; tech-dashboard-bot/0.1; +https://techdb.studio344.net)",
        "accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < READ_LIMIT) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch {}
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const og = matchMetaContent(html, "og:image") ?? matchMetaContent(html, "twitter:image");
    if (!og) return null;
    return absolutize(og, url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const data = JSON.parse(fs.readFileSync(PATH, "utf8"));
const targets = data.entries.filter((e) => !(e.image && e.image.src));
console.error(`backfill start: total=${data.entries.length} targets=${targets.length}`);

let done = 0, hits = 0;
const t0 = Date.now();
await runWithConcurrency(targets, async (e) => {
  const src = await fetchOg(e.url);
  done++;
  if (src) {
    hits++;
    e.image = { src, origSrc: src, alt: e.title || "", width: 0, height: 0, source: "og" };
  }
  if (done % 30 === 0) {
    process.stderr.write(`  progress ${done}/${targets.length} hits=${hits} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s\n`);
  }
}, CONCURRENCY);

const json = JSON.stringify(data, null, 2) + "\n";
fs.writeFileSync(PATH, json);
console.error(`done: targets=${targets.length} hits=${hits} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s`);
