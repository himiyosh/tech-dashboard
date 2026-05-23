#!/usr/bin/env -S npx tsx
/**
 * quality-audit runner — called by the `quality-audit` Claude skill or directly:
 *   npx tsx .claude/skills/quality-audit/run.ts
 *
 * Reads data/index.json + harness/registry.ts, writes a Markdown report to
 * data/_runs/audit-<iso>.md and prints a summary to stdout.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REGISTRY } from "../../../harness/registry.ts";
import { canonicalUrlKey } from "../../../harness/pipeline/url.ts";
import { ALL_CATEGORIES, type SourceDefinition } from "../../../harness/types.ts";
import { sourceFreshnessStatus } from "../../../web/src/lib/freshness.ts";

export { canonicalUrlKey } from "../../../harness/pipeline/url.ts";

interface Entry {
  id: string;
  source: string;
  url: string;
  title: string;
  summaryJa: string;
  summaryEn?: string;
  bodyJa?: string;
  bodyEn?: string;
  publishedAt: string;
  collectedAt?: string;
  tags: string[];
  category: string;
  importance: number;
}

interface Index {
  generatedAt: string;
  count: number;
  entries: Entry[];
}

const CATS = [...ALL_CATEGORIES];
const FALLBACK_SUMMARY_JA_PREFIX = "このエントリは ";
const FALLBACK_SUMMARY_EN_NEEDLE = "AI summary not yet available";
const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";

export function isDeterministicFallbackEntry(entry: Pick<Entry, "summaryJa" | "summaryEn" | "bodyJa" | "bodyEn">): boolean {
  const summaryJa = entry.summaryJa ?? "";
  const summaryEn = entry.summaryEn ?? "";
  const bodyEn = entry.bodyEn ?? "";
  return (
    summaryJa.startsWith(FALLBACK_SUMMARY_JA_PREFIX) ||
    summaryEn.includes(FALLBACK_SUMMARY_EN_NEEDLE) ||
    bodyEn.includes(FALLBACK_BODY_EN_NEEDLE)
  );
}

interface FreshnessRow {
  id: string;
  latestPublished: string;
  latestCollected: string;
  ageHrs: number;
  status: string;
}

function latestTimestamp<T>(list: T[], select: (entry: T) => string | undefined): string {
  return list.reduce((latest, entry) => {
    const value = select(entry);
    return value && value > latest ? value : latest;
  }, "1970-01-01T00:00:00Z");
}

export function freshnessForSource(
  source: SourceDefinition,
  entries: Array<Pick<Entry, "publishedAt" | "collectedAt">>,
  nowMs = Date.now(),
): Omit<FreshnessRow, "id"> {
  if (entries.length === 0) {
    return { latestPublished: "-", latestCollected: "-", ageHrs: -1, status: "ℹ️ no data" };
  }

  const latestPublished = latestTimestamp(entries, (entry) => entry.publishedAt);
  const latestCollected = latestTimestamp(entries, (entry) => entry.collectedAt ?? entry.publishedAt);
  const freshness = sourceFreshnessStatus(source, latestCollected, nowMs);
  const status = freshness.status === "error" ? "🔴 error" : freshness.status === "stale" ? "🟠 stale" : "✅ ok";
  const ageHrs = freshness.ageHrs;
  return { latestPublished, latestCollected, ageHrs, status };
}

async function main() {
  const root = resolve(new URL("../../..", import.meta.url).pathname);
  const indexPath = join(root, "data", "index.json");
  const raw = await readFile(indexPath, "utf8");
  const index = JSON.parse(raw) as Index;
  const now = Date.now();

  // 1. Freshness per source. Use collection time for pipeline health;
  // published time is shown only as upstream activity context.
  const bySource = new Map<string, Entry[]>();
  for (const e of index.entries) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }
  const registrySourceIds = Object.keys(REGISTRY).sort();
  const dataSourceIds = [...bySource.keys()].sort();
  const missingSourceIds = registrySourceIds.filter((id) => !bySource.has(id));
  const extraSourceIds = dataSourceIds.filter((id) => !(id in REGISTRY));

  const freshness: FreshnessRow[] = [];
  for (const def of Object.values(REGISTRY)) {
    const list = bySource.get(def.id) ?? [];
    freshness.push({ id: def.id, ...freshnessForSource(def, list, now) });
  }

  // 2. Category distribution
  const catCount = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<string, number>;
  for (const e of index.entries) {
    if (e.category in catCount) catCount[e.category]++;
  }
  const emptyCats = CATS.filter((c) => (catCount[c] ?? 0) === 0);

  // 3. Summary coverage
  const withSummary = index.entries.filter((e) => e.summaryJa && e.summaryJa.length >= 20).length;
  const shortSummary = index.entries.filter((e) => e.summaryJa && e.summaryJa.length < 20).length;
  const emptySummary = index.entries.filter((e) => !e.summaryJa).length;
  const covPct = index.entries.length === 0 ? 0 : Math.round((withSummary / index.entries.length) * 100);
  const fallbackEntries = index.entries.filter(isDeterministicFallbackEntry);
  const fallbackPct = index.entries.length === 0 ? 0 : Math.round((fallbackEntries.length / index.entries.length) * 100);
  const realSummaryCount = index.entries.length - fallbackEntries.length;

  // 4. Tag variations (simple: lowercase → set of originals)
  const tagGroups = new Map<string, Map<string, number>>();
  for (const e of index.entries) {
    for (const t of e.tags) {
      const key = t.toLowerCase();
      const sub = tagGroups.get(key) ?? new Map<string, number>();
      sub.set(t, (sub.get(t) ?? 0) + 1);
      tagGroups.set(key, sub);
    }
  }
  const tagVariations = [...tagGroups.values()]
    .filter((s) => s.size > 1)
    .map((s) => [...s.entries()].sort((a, b) => b[1] - a[1]))
    .slice(0, 10);

  // 5. URL dup candidates (normalized host+path)
  const urlGroups = new Map<string, string[]>();
  for (const e of index.entries) {
    const key = canonicalUrlKey(e.url);
    if (!key) continue;
    const arr = urlGroups.get(key) ?? [];
    arr.push(e.url);
    urlGroups.set(key, arr);
  }
  const dupCandidates = [...urlGroups.values()].filter((arr) => arr.length > 1).slice(0, 10);

  // Severity summary
  let critical = 0, warning = 0, minor = 0;
  if (index.entries.length === 0) critical++;
  for (const f of freshness) {
    if (f.status.includes("error")) critical++;
    else if (f.status.includes("stale")) warning++;
  }
  if (emptyCats.length >= 3) warning++;
  if (extraSourceIds.length > 0) warning++;
  if (covPct < 50) warning++;
  if (fallbackPct >= 70) critical++;
  else if (fallbackPct >= 10 || fallbackEntries.length >= 50) warning++;
  if (tagVariations.length >= 10) minor++;
  if (dupCandidates.length >= 5) minor++;

  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# 品質監査レポート — ${ts}`);
  lines.push("");
  lines.push(`**サマリ**: ${critical + warning + minor} 件の問題 (🔴 ${critical} · 🟠 ${warning} · 🟢 ${minor})`);
  lines.push("");
  lines.push(`- 総エントリ: ${index.entries.length}`);
  lines.push(`- registry ソース: ${registrySourceIds.length}`);
  lines.push(`- data ソース: ${dataSourceIds.length}`);
  lines.push(`- index 生成: ${index.generatedAt}`);
  lines.push(`- deterministic fallback: ${fallbackEntries.length} 件 (${fallbackPct}%)`);
  lines.push("");

  lines.push("## 🧭 ソース整合性");
  lines.push("");
  lines.push(`- registry ソース: ${registrySourceIds.length}`);
  lines.push(`- data ソース: ${dataSourceIds.length}`);
  lines.push(`- registry にあるが data に未出現: ${missingSourceIds.length === 0 ? "なし ✅" : missingSourceIds.join(", ")}`);
  lines.push(`- data にあるが registry に無い: ${extraSourceIds.length === 0 ? "なし ✅" : extraSourceIds.join(", ")}`);
  lines.push("");

  lines.push("## 🏥 鮮度");
  lines.push("");
  lines.push("| ソース | 最新収集 | 最新公開 | 収集経過 (h) | 状態 |");
  lines.push("|---|---|---|---|---|");
  for (const f of freshness) {
    lines.push(`| ${f.id} | ${f.latestCollected} | ${f.latestPublished} | ${f.ageHrs >= 0 ? f.ageHrs : "-"} | ${f.status} |`);
  }
  lines.push("");

  lines.push("## 📊 カテゴリ分布");
  lines.push("");
  lines.push("| カテゴリ | 件数 | 状態 |");
  lines.push("|---|---|---|");
  for (const c of CATS) {
    const n = catCount[c] ?? 0;
    lines.push(`| ${c} | ${n} | ${n === 0 ? "⚠️ 0 件" : "✅"} |`);
  }
  lines.push("");

  lines.push("## 📝 要約カバレッジ");
  lines.push("");
  lines.push(`- 要約あり (≥ 20 chars): **${withSummary}** 件 (${covPct}%)`);
  lines.push(`- 短すぎ (< 20 chars): ${shortSummary} 件`);
  lines.push(`- 空要約: ${emptySummary} 件`);
  lines.push(`- 実 AI 要約相当: ${realSummaryCount} 件`);
  lines.push(`- deterministic fallback: **${fallbackEntries.length}** 件 (${fallbackPct}%)`);
  if (fallbackEntries.length > 0) {
    lines.push("");
    lines.push("### deterministic fallback サンプル");
    for (const e of fallbackEntries.slice(0, 8)) {
      lines.push(`- \`${e.source}\` ${e.title} — <${e.url}>`);
    }
  }
  lines.push("");

  lines.push("## 🏷️ タグ揺れ候補 (top 10)");
  lines.push("");
  if (tagVariations.length === 0) {
    lines.push("- ゆれなし ✅");
  } else {
    for (const variants of tagVariations) {
      const top = variants[0]!;
      lines.push(`- ${variants.map(([t, n]) => `\`${t}\` (${n})`).join(" vs ")} → 推奨: \`${top[0]}\``);
    }
  }
  lines.push("");

  lines.push("## 🔗 URL 重複候補 (top 10)");
  lines.push("");
  if (dupCandidates.length === 0) {
    lines.push("- 重複なし ✅");
  } else {
    for (const group of dupCandidates) {
      lines.push(`- ${group.map((u) => `<${u}>`).join(" / ")}`);
    }
  }
  lines.push("");

  const out = lines.join("\n");

  const reportPath = join(root, "data", "_runs", `audit-${ts.replace(/[:.]/g, "-")}.md`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, out, "utf8");

  console.log(`[audit] wrote ${reportPath}`);
  console.log(`[audit] summary: ${critical + warning + minor} issues (🔴 ${critical} · 🟠 ${warning} · 🟢 ${minor})`);
  console.log(`[audit] summary coverage: ${covPct}% · fallback: ${fallbackEntries.length} (${fallbackPct}%) · empty categories: ${emptyCats.join(", ") || "none"}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("[audit] fatal:", err);
    process.exit(1);
  });
}
