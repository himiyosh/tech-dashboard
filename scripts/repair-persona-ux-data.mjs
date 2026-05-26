#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = "data";
const archiveDir = join(dataDir, "archive");
const generatedAt = new Date().toISOString();

const techNewsNoise = [
  /witcher/i, /on trails/i, /hiking/i, /bee wearable/i, /esports?/i, /beluga/i,
  /space shuttle/i, /astronaut hall/i, /seafood sanctions/i, /ebola/i, /chromecast/i,
  /the view/i, /the boys/i, /mandalorian/i, /solar market/i, /superfans/i,
  /shark finning/i, /russian satellites/i, /international space station/i, /vpn where criminals/i,
];

const localKeep = [
  /locals+llm/i, /locals+model/i, /on-device/i, /open[- ](?:source )?model/i, /open weights/i,
  /ollama/i, /llama/i, /llama.cpp/i, /gguf/i, /quant/i, /vllm/i, /lm studio/i, /mlx/i,
  /huggings*face/i, /transformers/i, /deepseek/i, /qwen/i, /gemma/i, /mistral/i, /llm-jp/i,
  /\u30ed\u30fc\u30ab\u30eb/u, /\u91cf\u5b50\u5316/u,
];

const localNoise = [
  /saas is dead/i, /profit/i, /profitable/i, /startup/i, /sales/i, /billing/i, /invoice/i,
  /claude code/i, /workflow/i, /mcp/i, /agent/i, /agents/i,
  /\u55b6\u696d/u, /\u9ed2\u5b57/u, /\u53ce\u76ca/u, /\u8acb\u6c42/u,
];

const vscodeAllowed = /(vs\s*code|vscode|visual studio code|code\.visualstudio|devcontainer|dev container|extension|\u62e1\u5f35\u6a5f\u80fd|live share|VS\u30b3\u30fc\u30c9|VS Code)/i;
const broadLocalSources = new Set(["zenn-ai", "zenn-llm", "qiita-llm", "simonw-blog"]);
const trustedLocalSources = new Set(["huggingface-blog", "ollama-releases"]);

function textOf(entry) {
  return [entry.source, entry.title, entry.titleJa, entry.titleEn, entry.summaryJa, entry.summaryEn, entry.url, ...(entry.tags || [])].filter(Boolean).join(" ");
}

function shouldDrop(entry) {
  const text = textOf(entry);
  const contentText = [entry.title, entry.titleJa, entry.titleEn, entry.summaryJa, entry.summaryEn, entry.url].filter(Boolean).join(" ");
  if (entry.category === "vscode" && !vscodeAllowed.test(contentText)) return true;
  if (entry.category === "tech-news" && techNewsNoise.some((re) => re.test(text))) return true;
  if (entry.category === "local-llm" && broadLocalSources.has(entry.source)) {
    if (localNoise.some((re) => re.test(text))) return true;
    return !localKeep.some((re) => re.test(text));
  }
  if (entry.category === "local-llm" && !trustedLocalSources.has(entry.source) && localNoise.some((re) => re.test(text))) return true;
  return false;
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8"); }

function filterEntries(entries) {
  const droppedBySource = {};
  const droppedSamples = [];
  const kept = [];
  for (const entry of entries) {
    if (shouldDrop(entry)) {
      droppedBySource[entry.source] = (droppedBySource[entry.source] || 0) + 1;
      if (droppedSamples.length < 12) droppedSamples.push(`${entry.source}:${entry.title}`);
    } else {
      kept.push(entry);
    }
  }
  return { kept, dropped: entries.length - kept.length, droppedBySource, droppedSamples };
}

const indexPath = join(dataDir, "index.json");
const index = readJson(indexPath);
const indexResult = filterEntries(index.entries || []);
index.entries = indexResult.kept;
index.count = index.entries.length;
index.generatedAt = generatedAt;
const fallbackNeedles = ["AI \u8981\u7d04\u672a\u751f\u6210", "AI summary pending", "AI summary not yet available", "\u5f8c\u7d9a\u306e Worker run", "\u3053\u306e\u30a8\u30f3\u30c8\u30ea\u306f ", "completed from the existing summary and collection metadata"];
const isFallbackEntry = (entry) => fallbackNeedles.some((needle) => textOf(entry).includes(needle) || String(entry.bodyJa || "").includes(needle) || String(entry.bodyEn || "").includes(needle));
const fallbackTotal = index.entries.filter(isFallbackEntry).length;
const summaryFallbacks = index.entries.filter((entry) => fallbackNeedles.some((needle) => String(entry.summaryJa || "").includes(needle) || String(entry.summaryEn || "").includes(needle))).length;
const bodyFallbacks = index.entries.filter((entry) => fallbackNeedles.some((needle) => String(entry.bodyJa || "").includes(needle) || String(entry.bodyEn || "").includes(needle))).length;
index.health = index.health || {};
index.health.fallbackTotal = fallbackTotal;
index.health.fallbackPercent = index.count === 0 ? 0 : Math.round((fallbackTotal / index.count) * 100);
index.health.summaryFallbacks = summaryFallbacks;
index.health.bodyFallbacks = bodyFallbacks;
writeJson(indexPath, index);

let archiveDropped = 0;
const monthFiles = readdirSync(archiveDir).filter((name) => /^\d{4}-\d{2}\.json$/.test(name)).sort();
const archiveMonths = [];
for (const fileName of monthFiles) {
  const filePath = join(archiveDir, fileName);
  const month = readJson(filePath);
  const result = filterEntries(month.entries || []);
  archiveDropped += result.dropped;
  month.entries = result.kept;
  month.count = month.entries.length;
  month.generatedAt = generatedAt;
  writeJson(filePath, month);
  archiveMonths.push(month);
}

const archiveIndex = {
  generatedAt,
  months: archiveMonths.map((month) => month.month).filter(Boolean).sort().reverse(),
  totalEntries: archiveMonths.reduce((sum, month) => sum + (month.count || 0), 0),
  perMonth: Object.fromEntries(archiveMonths.map((month) => [month.month, month.count || 0]).filter(([month]) => month).sort((a, b) => b[0].localeCompare(a[0]))),
};
writeJson(join(archiveDir, "_index.json"), archiveIndex);

function statsKey(entry) {
  try {
    const url = new URL(entry.url);
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch { return entry.url || entry.id; }
}

const all = new Map();
for (const entry of index.entries) all.set(statsKey(entry), entry);
for (const month of archiveMonths) for (const entry of month.entries || []) if (!all.has(statsKey(entry))) all.set(statsKey(entry), entry);
const allEntries = [...all.values()];
const DAY_MS = 86400000;
const now = Date.parse(generatedAt);
const totals = { allTime: allEntries.length, last30d: 0, last7d: 0, last24h: 0 };
const byDay = new Map();
const byMonth = new Map();
const bySource = new Map();
const byImportance = { "1": 0, "2": 0, "3": 0 };
for (const entry of allEntries) {
  const iso = entry.publishedAt || entry.collectedAt;
  const time = Date.parse(iso);
  const ageDays = Number.isFinite(time) ? (now - time) / DAY_MS : Infinity;
  if (ageDays <= 30) totals.last30d++;
  if (ageDays <= 7) totals.last7d++;
  if (ageDays <= 1) totals.last24h++;
  const day = iso ? iso.slice(0, 10) : null;
  if (day && ageDays <= 90) {
    const bucket = byDay.get(day) || { date: day, count: 0, byCategory: {} };
    bucket.count++; bucket.byCategory[entry.category] = (bucket.byCategory[entry.category] || 0) + 1; byDay.set(day, bucket);
  }
  const mon = iso ? iso.slice(0, 7) : null;
  if (mon) {
    const bucket = byMonth.get(mon) || { month: mon, count: 0, byCategory: {} };
    bucket.count++; bucket.byCategory[entry.category] = (bucket.byCategory[entry.category] || 0) + 1; byMonth.set(mon, bucket);
  }
  const source = bySource.get(entry.source) || { source: entry.source, total: 0, last30d: 0 };
  source.total++; if (ageDays <= 30) source.last30d++; bySource.set(entry.source, source);
  const imp = String(entry.importance || 1); byImportance[imp] = (byImportance[imp] || 0) + 1;
}
writeJson(join(dataDir, "stats.json"), {
  generatedAt, totals,
  byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
  bySource: [...bySource.values()].sort((a, b) => b.total - a.total),
  byImportance,
});

console.log(`index dropped=${indexResult.dropped} archive dropped=${archiveDropped} live=${index.count} archive=${archiveIndex.totalEntries}`);
if (indexResult.dropped > 0) {
  console.log("index dropped by source", JSON.stringify(indexResult.droppedBySource));
  console.log("index dropped samples", JSON.stringify(indexResult.droppedSamples));
}
