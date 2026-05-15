#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const INDEX = "data/index.json";
const CACHE = "data/_summary-cache.json";
const DRY = process.argv.includes("--dry-run");
const FILL_MISSING_BODY = process.argv.includes("--fill-missing-body");
const REFRESH_FALLBACK_BODY = process.argv.includes("--refresh-fallback-body");
// --force-summary: overwrite existing summary/body/title in data/index.json
// when the cache holds a non-empty real value. Use after running
// `npm run resummarize` against an outdated index (e.g. a parallel worker
// cron commit landed and clobbered our local AI summaries).
const FORCE_SUMMARY = process.argv.includes("--force-summary");

const index = JSON.parse(readFileSync(INDEX, "utf8"));
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const entries = Array.isArray(index) ? index : index.entries;

const stats = {
  total: entries.length,
  cacheHits: 0,
  titleApplied: 0,
  summaryApplied: 0,
  summaryFallbackApplied: 0,
  bodyApplied: 0,
  bodyFallbackApplied: 0,
  cacheFallbackWritten: 0,
  importanceApplied: 0,
  tagsApplied: 0,
};

function text(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function setIfFilled(entry, key, value) {
  const next = text(value);
  if (!next) return false;
  if (text(entry[key])) return false;
  if (entry[key] === next) return false;
  entry[key] = next;
  return true;
}

function setForce(entry, key, value) {
  const next = text(value);
  if (!next) return false;
  if (entry[key] === next) return false;
  entry[key] = next;
  return true;
}

function dedupeTags(tags) {
  return [...new Set(tags.filter((tag) => typeof tag === "string" && tag.trim()))].slice(0, 10);
}

function firstText(...values) {
  return values.map(text).find(Boolean) ?? "";
}

function sentence(value, fallback) {
  const source = firstText(value, fallback);
  return source.replace(/[。.!?]\s*$/, "");
}

function hasCjk(value) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text(value));
}

function englishText(value) {
  const next = text(value);
  return next && !hasCjk(next) ? next : "";
}

function fallbackTags(entry) {
  return dedupeTags(entry.tags ?? []).slice(0, 4);
}

function shortenForSummary(value, max) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function buildFallbackSummary(entry) {
  const titleAny = firstText(entry.titleJa, entry.titleEn, entry.title, entry.url, "TECH Dashboard entry");
  const titleEn = englishText(entry.titleEn) || englishText(entry.title) || englishText(titleAny);
  const titleJa = hasCjk(entry.titleJa ?? "") ? text(entry.titleJa) : hasCjk(entry.title) ? text(entry.title) : "";
  const source = firstText(entry.source, "unknown source");
  const category = firstText(entry.category, "tech-news");
  // Mirror worker/src/content-fallback.ts so deterministic summaries are
  // always populated in BOTH languages (LL-028).
  const summaryJa = titleJa
    ? shortenForSummary(titleJa, 140)
    : shortenForSummary(`「${titleEn || titleAny}」 (${source}) の ${category} 関連アップデート。AI 要約が未生成のため、後続の Worker run で本文が補完されます。`, 180);
  const summaryEn = titleEn
    ? shortenForSummary(titleEn, 200)
    : shortenForSummary(`${category} update from ${source}. AI summary not yet available; a future Worker run will refresh this entry.`, 200);
  return { summaryJa, summaryEn };
}

function buildFallbackBody(entry) {
  const titleJa = firstText(entry.titleJa, entry.titleEn, entry.title, "TECH Dashboard entry");
  const titleEn = firstText(entry.titleEn, entry.title, entry.titleJa, "TECH Dashboard entry");
  const titleEnDisplay = englishText(titleEn) || `The source item "${titleEn}"`;
  const summaryJa = sentence(firstText(entry.summaryJa, entry.summaryEn, entry.title), titleJa);
  const summaryEn = sentence(englishText(entry.summaryEn), "");
  const source = firstText(entry.source, "unknown source");
  const sourceType = firstText(entry.sourceType, "source");
  const category = firstText(entry.category, "tech-news");
  const tags = fallbackTags(entry);
  const tagJa = tags.length ? `関連キーワードは ${tags.join(", ")} です。` : "関連キーワードは今後の分類更新で補われます。";
  const tagEn = tags.length ? `Related tags include ${tags.join(", ")}.` : "Related tags can be refined as the entry is enriched.";
  const englishLead = summaryEn
    ? `${summaryEn}.`
    : "The original summary for this entry is not available in English, so this note stays close to the collected metadata and avoids adding claims beyond the source.";

  return {
    bodyJa: [
      `${titleJa} は、${source} が伝えた ${category} 領域の更新です。${summaryJa}。`,
      `このエントリでは、元記事の要約と収集時のメタデータから、読者が押さえるべき文脈を補っています。${sourceType} 系の情報は、リリース、導入事例、研究動向、実装ノウハウのいずれであっても、周辺ツールや運用判断に影響しやすいため、単なるニュースとしてではなく、利用者が次に確認すべき変化として読む価値があります。`,
      `${tagJa} 詳細を確認する際は、元記事で示されている前提条件、対象バージョン、提供範囲、制限事項を合わせて見ると、実務への影響を判断しやすくなります。未確認の部分については断定せず、公開情報に基づく補完として扱うのが安全です。`,
    ].join("\n\n"),
    bodyEn: [
      `${titleEnDisplay} is a ${category} update collected from ${source}. ${englishLead}`,
      `This long-form note is completed from the existing summary and collection metadata so the entry remains useful even when a full model-generated article body is unavailable. For ${sourceType} sources, the practical value is usually in the context: what changed, who is likely to be affected, and which adjacent tools, releases, or research threads may become relevant next.`,
      `${tagEn} When evaluating the original item, readers should still check the source for version details, availability, limitations, and implementation assumptions. Any broader implication should be treated as a cautious reading of the public information rather than a claim beyond the source material.`,
    ].join("\n\n"),
  };
}

function ensureFallbackCacheEntry(entry, fallback, refresh = false) {
  const existing = cache[entry.url] ?? {};
  const next = {
    titleJa: firstText(existing.titleJa, entry.titleJa, entry.title),
    summaryJa: firstText(existing.summaryJa, entry.summaryJa, fallback.summaryJa, entry.title),
    summaryEn: firstText(existing.summaryEn, entry.summaryEn, fallback.summaryEn, entry.titleEn, entry.title),
    bodyJa: refresh ? fallback.bodyJa : firstText(existing.bodyJa, fallback.bodyJa),
    bodyEn: refresh ? fallback.bodyEn : firstText(existing.bodyEn, fallback.bodyEn),
    importance: existing.importance ?? entry.importance ?? 1,
    extraTags: dedupeTags([...(existing.extraTags ?? []), ...(entry.tags ?? [])]).slice(0, 6),
    model: refresh ? "deterministic-fallback" : existing.model ?? "deterministic-fallback",
    cachedAt: existing.cachedAt ?? new Date().toISOString(),
  };
  const before = JSON.stringify(existing);
  const after = JSON.stringify(next);
  if (before !== after) {
    cache[entry.url] = next;
    stats.cacheFallbackWritten++;
  }
}

function isDeterministicFallback(entry) {
  const hit = cache[entry.url];
  return hit?.model === "deterministic-fallback" || String(entry.bodyEn ?? "").includes("completed from the existing summary and collection metadata");
}

for (const entry of entries) {
  const hit = cache[entry.url];
  if (!hit) continue;
  stats.cacheHits++;

  if (setIfFilled(entry, "titleJa", hit.titleJa)) stats.titleApplied++;
  if (FORCE_SUMMARY) {
    // Skip force-overwrite for entries whose cache is just the deterministic
    // fallback — we don't want to clobber a real AI summary in the index
    // with a placeholder that happened to be cached earlier.
    const isFallbackHit = hit.model === "deterministic-fallback";
    if (!isFallbackHit) {
      if (setForce(entry, "summaryJa", hit.summaryJa)) stats.summaryApplied++;
      if (setForce(entry, "summaryEn", hit.summaryEn)) stats.summaryApplied++;
      if (setForce(entry, "bodyJa", hit.bodyJa)) stats.bodyApplied++;
      if (setForce(entry, "bodyEn", hit.bodyEn)) stats.bodyApplied++;
    } else {
      if (setIfFilled(entry, "summaryJa", hit.summaryJa)) stats.summaryApplied++;
      if (setIfFilled(entry, "summaryEn", hit.summaryEn)) stats.summaryApplied++;
      if (setIfFilled(entry, "bodyJa", hit.bodyJa)) stats.bodyApplied++;
      if (setIfFilled(entry, "bodyEn", hit.bodyEn)) stats.bodyApplied++;
    }
  } else {
    if (setIfFilled(entry, "summaryJa", hit.summaryJa)) stats.summaryApplied++;
    if (setIfFilled(entry, "summaryEn", hit.summaryEn)) stats.summaryApplied++;
    if (setIfFilled(entry, "bodyJa", hit.bodyJa)) stats.bodyApplied++;
    if (setIfFilled(entry, "bodyEn", hit.bodyEn)) stats.bodyApplied++;
  }

  if (hit.importance && entry.importance !== hit.importance) {
    entry.importance = hit.importance;
    stats.importanceApplied++;
  }

  const mergedTags = dedupeTags([...(entry.tags ?? []), ...(hit.extraTags ?? [])]);
  if (JSON.stringify(entry.tags ?? []) !== JSON.stringify(mergedTags)) {
    entry.tags = mergedTags;
    stats.tagsApplied++;
  }
}

if (FILL_MISSING_BODY || REFRESH_FALLBACK_BODY) {
  for (const entry of entries) {
    const fallbackSummary = buildFallbackSummary(entry);
    if (setIfFilled(entry, "summaryJa", fallbackSummary.summaryJa)) stats.summaryFallbackApplied++;
    if (setIfFilled(entry, "summaryEn", fallbackSummary.summaryEn)) stats.summaryFallbackApplied++;
    const fallback = { ...fallbackSummary, ...buildFallbackBody(entry) };
    const shouldRefresh = REFRESH_FALLBACK_BODY && isDeterministicFallback(entry);
    const appliedJa = shouldRefresh ? entry.bodyJa !== fallback.bodyJa : setIfFilled(entry, "bodyJa", fallback.bodyJa);
    const appliedEn = shouldRefresh ? entry.bodyEn !== fallback.bodyEn : setIfFilled(entry, "bodyEn", fallback.bodyEn);
    if (shouldRefresh && appliedJa) entry.bodyJa = fallback.bodyJa;
    if (shouldRefresh && appliedEn) entry.bodyEn = fallback.bodyEn;
    if (appliedJa) stats.bodyFallbackApplied++;
    if (appliedEn) stats.bodyFallbackApplied++;
    if (appliedJa || appliedEn) ensureFallbackCacheEntry(entry, fallback, shouldRefresh);
  }
}

if (!Array.isArray(index)) {
  index.count = entries.length;
  index.entries = entries;
  if (!DRY && (stats.summaryApplied > 0 || stats.summaryFallbackApplied > 0 || stats.bodyApplied > 0 || stats.bodyFallbackApplied > 0 || stats.titleApplied > 0 || stats.importanceApplied > 0 || stats.tagsApplied > 0)) {
    index.generatedAt = new Date().toISOString();
  }
}

console.log(JSON.stringify({ dryRun: DRY, ...stats }, null, 2));

if (!DRY) {
  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  if (stats.cacheFallbackWritten > 0) {
    writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  }
}
