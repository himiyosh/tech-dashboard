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
import {
  hasUsableBilingualSummary,
  needsSummaryGeneration,
  type SummaryQualityInput,
} from "../../../harness/pipeline/summary-quality.ts";
import { canonicalUrlKey } from "../../../harness/pipeline/url.ts";
import { ALL_CATEGORIES, type SourceDefinition } from "../../../harness/types.ts";
import { sourceFreshnessStatus } from "../../../web/src/lib/freshness.ts";
import { deriveWorkerRunStatus, type WorkerHealthSnapshot } from "../../../web/src/lib/run-health.ts";

export { canonicalUrlKey } from "../../../harness/pipeline/url.ts";

interface Entry {
  id: string;
  source: string;
  url: string;
  title: string;
  titleJa?: string;
  titleEn?: string;
  summaryJa: string;
  summaryEn?: string;
  bodyJa?: string;
  bodyEn?: string;
  publishedAt: string;
  collectedAt?: string;
  tags: string[];
  category: string;
  importance: number;
  evergreen?: boolean;
}

interface Index {
  generatedAt: string;
  count: number;
  health?: {
    lastRunAt?: string;
    copilotOk?: boolean;
    sourcesAttempted?: number;
    sourcesOk?: number;
    sourcesFailed?: string[];
    queueMode?: string;
    queueCap?: number;
    enqueueCandidates?: number;
    summaryQueueSnapshotStage?: string;
    summaryQueueBacklog?: number;
    summaryQueueEnqueued?: number;
    summaryQueueDrainEstimateHours?: number;
    bodyQueueMode?: string;
    bodyRetentionEligible?: number;
    bodyBacklog?: number;
    bodyEnqueueCandidates?: number;
    bodyEnqueueCap?: number;
    bodyEnqueued?: number;
    bodyLookupCount?: number;
    bodyPendingLookupCount?: number;
    bodyMerged?: number;
    bodyQueueDrainEstimateHours?: number;
    enrichmentEnqueueCap?: number;
    enrichmentEnqueued?: number;
    enrichmentRemaining?: number;
  };
  entries: Entry[];
}

const CATS = [...ALL_CATEGORIES];

export function isDeterministicFallbackEntry(entry: SummaryQualityInput): boolean {
  return needsSummaryGeneration(entry);
}

type AuditMetric = number | null;

export interface AuditQueueTelemetry {
  summary: {
    mode: string | null;
    snapshotStage: string | null;
    backlog: AuditMetric;
    candidates: AuditMetric;
    enqueueCap: AuditMetric;
    enqueued: AuditMetric;
    etaHours: AuditMetric;
  };
  body: {
    mode: string | null;
    retentionEligible: AuditMetric;
    backlog: AuditMetric;
    candidates: AuditMetric;
    enqueueCap: AuditMetric;
    enqueued: AuditMetric;
    lookupCount: AuditMetric;
    pendingLookupCount: AuditMetric;
    merged: AuditMetric;
    etaHours: AuditMetric;
  };
  shared: {
    enqueueCap: AuditMetric;
    enqueued: AuditMetric;
    remaining: AuditMetric;
  };
}

export interface KnowledgeAuditEntry extends SummaryQualityInput {
  source: string;
  evergreen?: boolean;
}

export interface KnowledgeAuditCoverage {
  source: string;
  collected: number;
  evergreenFlagged: number;
  bilingualReady: number;
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
    return { latestPublished: "-", latestCollected: "-", ageHrs: -1, status: "ℹ️ no listed entry" };
  }

  const latestPublished = latestTimestamp(entries, (entry) => entry.publishedAt);
  const latestCollected = latestTimestamp(entries, (entry) => entry.collectedAt ?? entry.publishedAt);
  const freshness = sourceFreshnessStatus(source, latestCollected, nowMs);
  const status = freshness.status === "error" ? "🟠 inactive" : freshness.status === "stale" ? "🟠 stale" : "✅ ok";
  const ageHrs = freshness.ageHrs;
  return { latestPublished, latestCollected, ageHrs, status };
}

interface AuditSeverityInput {
  indexCount: number;
  health?: Index["health"];
  freshnessRows: Array<Pick<FreshnessRow, "status">>;
  emptyCategoryCount: number;
  extraSourceCount: number;
  summaryCoveragePct: number;
  fallbackPct: number;
  fallbackCount: number;
  tagVariationCount: number;
  dupCandidateCount: number;
  nowMs?: number;
}

function effectiveFailedCount(health?: Index["health"]): number | null {
  if (!health) return null;
  const explicit = Array.isArray(health.sourcesFailed) ? health.sourcesFailed.length : 0;
  const inferred =
    isFiniteNonnegative(health.sourcesAttempted) && isFiniteNonnegative(health.sourcesOk)
      ? Math.max(0, health.sourcesAttempted - health.sourcesOk)
      : 0;
  return Math.max(explicit, inferred);
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalMetric(value: unknown): AuditMetric {
  return isFiniteNonnegative(value) ? value : null;
}

export function queueTelemetryForAudit(health?: Index["health"]): AuditQueueTelemetry {
  return {
    summary: {
      mode: typeof health?.queueMode === "string" ? health.queueMode : null,
      snapshotStage:
        typeof health?.summaryQueueSnapshotStage === "string"
          ? health.summaryQueueSnapshotStage
          : null,
      backlog: optionalMetric(health?.summaryQueueBacklog),
      candidates: optionalMetric(health?.enqueueCandidates),
      enqueueCap: optionalMetric(health?.queueCap),
      enqueued: optionalMetric(health?.summaryQueueEnqueued),
      etaHours: optionalMetric(health?.summaryQueueDrainEstimateHours),
    },
    body: {
      mode: typeof health?.bodyQueueMode === "string" ? health.bodyQueueMode : null,
      retentionEligible: optionalMetric(health?.bodyRetentionEligible),
      backlog: optionalMetric(health?.bodyBacklog),
      candidates: optionalMetric(health?.bodyEnqueueCandidates),
      enqueueCap: optionalMetric(health?.bodyEnqueueCap),
      enqueued: optionalMetric(health?.bodyEnqueued),
      lookupCount: optionalMetric(health?.bodyLookupCount),
      pendingLookupCount: optionalMetric(health?.bodyPendingLookupCount),
      merged: optionalMetric(health?.bodyMerged),
      etaHours: optionalMetric(health?.bodyQueueDrainEstimateHours),
    },
    shared: {
      enqueueCap: optionalMetric(health?.enrichmentEnqueueCap),
      enqueued: optionalMetric(health?.enrichmentEnqueued),
      remaining: optionalMetric(health?.enrichmentRemaining),
    },
  };
}

export function knowledgeCoverageForAudit(
  entries: readonly KnowledgeAuditEntry[],
  registry: Readonly<Record<string, SourceDefinition>> = REGISTRY,
): KnowledgeAuditCoverage[] {
  const bySource = new Map<string, KnowledgeAuditCoverage>();
  for (const source of Object.values(registry)) {
    if (source.evergreen !== true) continue;
    bySource.set(source.id, {
      source: source.id,
      collected: 0,
      evergreenFlagged: 0,
      bilingualReady: 0,
    });
  }
  for (const entry of entries) {
    const coverage = bySource.get(entry.source);
    if (!coverage) continue;
    coverage.collected++;
    if (entry.evergreen !== true) continue;
    coverage.evergreenFlagged++;
    if (hasUsableBilingualSummary(entry)) coverage.bilingualReady++;
  }
  return [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source));
}

function metricLabel(value: AuditMetric): string {
  return value === null ? "未観測" : String(value);
}

function runHealthSnapshot(health?: Index["health"]): WorkerHealthSnapshot | null {
  if (!health?.lastRunAt || !Number.isFinite(Date.parse(health.lastRunAt))) return null;
  if (typeof health.copilotOk !== "boolean") return null;
  if (!isFiniteNonnegative(health.sourcesAttempted)) return null;
  if (!isFiniteNonnegative(health.sourcesOk)) return null;
  if (!Array.isArray(health.sourcesFailed)) return null;
  const failed = effectiveFailedCount(health) ?? 0;
  return {
    lastRunAt: health.lastRunAt,
    copilotOk: health.copilotOk,
    sourcesAttempted: health.sourcesAttempted,
    sourcesOk: health.sourcesOk,
    sourcesFailed:
      Array.isArray(health.sourcesFailed) && health.sourcesFailed.length > 0
        ? health.sourcesFailed
        : failed > 0
          ? Array.from({ length: failed }, (_, index) => `failed-${index + 1}`)
          : [],
  };
}

export function summarizeAuditSeverity(input: AuditSeverityInput): { critical: number; warning: number; minor: number } {
  let critical = 0;
  let warning = 0;
  let minor = 0;

  if (input.indexCount === 0) critical++;

  const attempted = input.health?.sourcesAttempted;
  const ok = input.health?.sourcesOk;
  const failed = effectiveFailedCount(input.health) ?? 0;
  const explicitFailed = Array.isArray(input.health?.sourcesFailed)
    ? input.health.sourcesFailed.length
    : 0;
  const allAttemptedFailed =
    isFiniteNonnegative(attempted) &&
    attempted > 0 &&
    failed >= attempted &&
    (ok === 0 || (!isFiniteNonnegative(ok) && explicitFailed >= attempted));
  const aggregateRun = runHealthSnapshot(input.health);
  if (allAttemptedFailed) {
    critical++;
  } else if (!aggregateRun) {
    critical++;
  } else {
    const runStatus = deriveWorkerRunStatus({
      workerHealth: aggregateRun,
      nowMs: input.nowMs,
      fallbackPercent: 0,
      pendingSummaryEntries: 0,
    });
    if (runStatus.tone === "err") critical++;
    else if (runStatus.tone === "warn") warning++;
  }

  const inactiveOrStale = input.freshnessRows.filter((row) => row.status === "🟠 inactive" || row.status === "🟠 stale").length;
  if (inactiveOrStale >= 2) warning++;
  if (input.emptyCategoryCount >= 3) warning++;
  if (input.extraSourceCount > 0) warning++;
  if (input.summaryCoveragePct < 50) warning++;
  if (input.fallbackPct >= 70) critical++;
  else if (input.fallbackPct >= 10 || input.fallbackCount >= 50) warning++;
  if (input.tagVariationCount >= 10) minor++;
  if (input.dupCandidateCount >= 5) minor++;

  return { critical, warning, minor };
}

async function main() {
  const root = resolve(new URL("../../..", import.meta.url).pathname);
  const indexPath = join(root, "data", "index.json");
  const raw = await readFile(indexPath, "utf8");
  const index = JSON.parse(raw) as Index;
  const now = Date.now();

  // 1. Retained/listed-entry activity per source. Collection time tracks the
  // latest qualifying listed entry; published time is shown only as upstream context.
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
  const aggregateRun = runHealthSnapshot(index.health);
  const aggregateRunStatus = aggregateRun
    ? deriveWorkerRunStatus({
        workerHealth: aggregateRun,
        nowMs: now,
        fallbackPercent: 0,
        pendingSummaryEntries: 0,
      })
    : null;
  const queueTelemetry = queueTelemetryForAudit(index.health);
  const evergreenCoverage = knowledgeCoverageForAudit(index.entries);

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

  const { critical, warning, minor } = summarizeAuditSeverity({
    indexCount: index.entries.length,
    health: index.health,
    freshnessRows: freshness,
    emptyCategoryCount: emptyCats.length,
    extraSourceCount: extraSourceIds.length,
    summaryCoveragePct: covPct,
    fallbackPct,
    fallbackCount: fallbackEntries.length,
    tagVariationCount: tagVariations.length,
    dupCandidateCount: dupCandidates.length,
    nowMs: now,
  });

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

  lines.push("## 🚦 パイプライン実行状態");
  lines.push("");
  if (index.health) {
    const failed = effectiveFailedCount(index.health) ?? 0;
    const explicitFailed = Array.isArray(index.health.sourcesFailed) ? index.health.sourcesFailed : [];
    lines.push(`- aggregate run: ${aggregateRunStatus ? `${aggregateRunStatus.statusText} (${aggregateRunStatus.detail})` : "ERR (aggregate health telemetry missing, invalid, or incomplete)"}`);
    lines.push(`- lastRunAt: ${index.health.lastRunAt ?? "-"}`);
    lines.push(`- copilotOk: ${index.health.copilotOk ?? "-"}`);
    lines.push(`- sourcesAttempted: ${index.health.sourcesAttempted ?? "-"}`);
    lines.push(`- sourcesOk: ${index.health.sourcesOk ?? "-"}`);
    lines.push(
      `- sourcesFailed: ${
        explicitFailed.length > 0
          ? explicitFailed.join(", ")
          : failed > 0
            ? `${failed} (attempted-ok から推定 / source IDs omitted)`
            : "なし ✅"
      }`,
    );
  } else {
    lines.push("- health telemetry: なし");
  }
  lines.push("");

  lines.push("## ⚙️ Enrichment Queue snapshot");
  lines.push("");
  lines.push("- `未観測` は 0 件ではありません。artifact health にその field が記録されていない状態です。");
  lines.push("- `backlog` は生成対象の全件数、`candidates` は今回確認した候補、`enqueued` は今回実際に送信できた件数、`merged` は今回 sidecar へ反映した件数です。");
  lines.push("");
  lines.push("| Pipeline | Mode | Eligible / retention | Backlog | Candidates | Cap | Enqueued | Lookup | Pending lookup | Merged | ETA (h) |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(
    `| Summary | ${queueTelemetry.summary.mode ?? "未観測"} | ${metricLabel(queueTelemetry.summary.backlog)} | ${metricLabel(queueTelemetry.summary.backlog)} | ${metricLabel(queueTelemetry.summary.candidates)} | ${metricLabel(queueTelemetry.summary.enqueueCap)} | ${metricLabel(queueTelemetry.summary.enqueued)} | - | - | 未観測 | ${metricLabel(queueTelemetry.summary.etaHours)} |`,
  );
  lines.push(
    `| Body | ${queueTelemetry.body.mode ?? "未観測"} | ${metricLabel(queueTelemetry.body.retentionEligible)} | ${metricLabel(queueTelemetry.body.backlog)} | ${metricLabel(queueTelemetry.body.candidates)} | ${metricLabel(queueTelemetry.body.enqueueCap)} | ${metricLabel(queueTelemetry.body.enqueued)} | ${metricLabel(queueTelemetry.body.lookupCount)} | ${metricLabel(queueTelemetry.body.pendingLookupCount)} | ${metricLabel(queueTelemetry.body.merged)} | ${metricLabel(queueTelemetry.body.etaHours)} |`,
  );
  lines.push(
    `| Shared enqueue budget | - | - | - | - | ${metricLabel(queueTelemetry.shared.enqueueCap)} | ${metricLabel(queueTelemetry.shared.enqueued)} | - | - | - | - |`,
  );
  lines.push(`- summary snapshot stage: ${queueTelemetry.summary.snapshotStage ?? "未観測"}`);
  lines.push(`- shared remaining: ${metricLabel(queueTelemetry.shared.remaining)}`);
  lines.push("");

  lines.push("## 🌲 Knowledge evergreen coverage");
  lines.push("");
  lines.push(
    `- registry evergreen source の収集済み entry: ${evergreenCoverage.reduce((sum, row) => sum + row.collected, 0)} 件`,
  );
  lines.push("- `bilingual ready` は shared summary quality contract を通る両言語要約です。本文の有無とは別指標です。");
  lines.push("- `evergreen flagged` が collected より少ない場合、source metadata の stamp 漏れです。0 entry のsourceも表から省略しません。");
  lines.push("");
  lines.push("| Source | Collected | Evergreen flagged | Bilingual ready | Pending |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const coverage of evergreenCoverage) {
    lines.push(
      `| ${coverage.source} | ${coverage.collected} | ${coverage.evergreenFlagged} | ${coverage.bilingualReady} | ${coverage.evergreenFlagged - coverage.bilingualReady} |`,
    );
  }
  lines.push("");

  lines.push("## 🧭 ソース整合性");
  lines.push("");
  lines.push(`- registry ソース: ${registrySourceIds.length}`);
  lines.push(`- data ソース: ${dataSourceIds.length}`);
  lines.push(`- registry にあるが data に未出現: ${missingSourceIds.length === 0 ? "なし ✅" : missingSourceIds.join(", ")}`);
  lines.push(`- data にあるが registry に無い: ${extraSourceIds.length === 0 ? "なし ✅" : extraSourceIds.join(", ")}`);
  lines.push("");

  lines.push("## 🏥 掲載エントリ活動");
  lines.push("");
  lines.push("- ここで見る `最新収集` / `状態` は **live index に残っている qualifying entry** の最新時刻です。");
  lines.push("- include/exclude filter で最近の項目が全て落ちた source は古く見えても、**collector failure を直接証明しません**。pipeline failure は上の aggregate health で判断します。");
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
