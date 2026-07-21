export type WorkerRunTone = "ok" | "warn" | "err";
export type WorkerRunState = "healthy" | "missing" | "late" | "failed" | "degraded";

export interface WorkerHealthSnapshot {
  lastRunAt: string;
  copilotOk: boolean;
  sourcesFailed: string[];
  sourcesAttempted?: number;
  sourcesOk?: number;
}

export interface WorkerRunStatusOptions {
  workerHealth: WorkerHealthSnapshot | null;
  nowMs?: number;
  fallbackPercent: number;
  pendingSummaryEntries: number;
  staleRunHours?: number;
}

export interface WorkerRunStatus {
  state: WorkerRunState;
  tone: WorkerRunTone;
  statusText: "OK" | "WARN" | "ERR";
  stateText: "OK" | "NO DATA" | "DELAYED" | "FAILED" | "DEGRADED";
  runLabel: string;
  detail: string;
}

export const WORKER_RUN_STATE_COPY: Record<WorkerRunState, { ja: string; en: string }> = {
  healthy: { ja: "正常稼働", en: "Running normally" },
  missing: { ja: "稼働記録なし", en: "Run telemetry unavailable" },
  late: { ja: "定期収集が遅延", en: "Scheduled collection delayed" },
  failed: { ja: "直近バッチが失敗", en: "Latest batch failed" },
  degraded: { ja: "一部確認が必要", en: "Review recommended" },
};

function statusTextFor(tone: WorkerRunTone): WorkerRunStatus["statusText"] {
  if (tone === "ok") return "OK";
  if (tone === "warn") return "WARN";
  return "ERR";
}

function stateTextFor(state: WorkerRunState): WorkerRunStatus["stateText"] {
  if (state === "healthy") return "OK";
  if (state === "missing") return "NO DATA";
  if (state === "late") return "DELAYED";
  if (state === "failed") return "FAILED";
  return "DEGRADED";
}

function buildStatus(
  state: WorkerRunState,
  tone: WorkerRunTone,
  detail: string,
): WorkerRunStatus {
  const stateText = stateTextFor(state);
  return {
    state,
    tone,
    statusText: statusTextFor(tone),
    stateText,
    runLabel: `run ${stateText.toLowerCase()}`,
    detail,
  };
}

export function runCadenceLead(
  status: Pick<WorkerRunStatus, "state">,
): { ja: string; en: string } {
  if (status.state === "healthy") {
    return {
      ja: "毎時 1 バッチ収集 · 各ソースは約 6 時間周期 · 最新 index は ",
      en: "One batch hourly · each source about every 6 hours · latest index ",
    };
  }
  if (status.state === "late") {
    return {
      ja: "通常は毎時 1 バッチ収集 · 現在は収集遅延を検出 · 最新 index は ",
      en: "Normally one batch hourly · collection is currently delayed · latest index ",
    };
  }
  if (status.state === "failed") {
    return {
      ja: "通常は毎時 1 バッチ収集 · 直近バッチは全ソース失敗 · 最新 index は ",
      en: "Normally one batch hourly · every source failed in the latest batch · latest index ",
    };
  }
  if (status.state === "missing") {
    return {
      ja: "通常は毎時 1 バッチ収集 · 稼働記録を確認できません · 最新 index は ",
      en: "Normally one batch hourly · run telemetry is unavailable · latest index ",
    };
  }
  return {
    ja: "通常は毎時 1 バッチ収集 · 一部処理を要確認 · 最新 index は ",
    en: "Normally one batch hourly · some processing needs review · latest index ",
  };
}

export function runCadenceCopy(
  status: Pick<WorkerRunStatus, "state">,
  latestIndexAge: string,
): { ja: string; en: string } {
  const lead = runCadenceLead(status);
  return {
    ja: `${lead.ja}${latestIndexAge}`,
    en: `${lead.en}${latestIndexAge}`,
  };
}

export function deriveWorkerRunStatus({
  workerHealth,
  fallbackPercent,
  pendingSummaryEntries,
  nowMs = Date.now(),
  staleRunHours = 6,
}: WorkerRunStatusOptions): WorkerRunStatus {
  if (!workerHealth) {
    return buildStatus("missing", "warn", "no data (legacy index)");
  }

  const lastRunMs = Date.parse(workerHealth.lastRunAt);
  const lastRunHours = Number.isFinite(lastRunMs) ? (nowMs - lastRunMs) / 3600_000 : Number.POSITIVE_INFINITY;
  if (lastRunHours > staleRunHours) {
    return buildStatus("late", "err", `no run in ${staleRunHours}h+`);
  }
  if (
    typeof workerHealth.sourcesAttempted === "number"
    && workerHealth.sourcesAttempted > 0
    && workerHealth.sourcesOk === 0
  ) {
    return buildStatus("failed", "err", `all ${workerHealth.sourcesAttempted} sources failed`);
  }
  if (!workerHealth.copilotOk) {
    return buildStatus("degraded", "warn", "summarize disabled");
  }
  if (workerHealth.sourcesFailed.length > 0) {
    return buildStatus("degraded", "warn", `${workerHealth.sourcesFailed.length} source error`);
  }
  if (fallbackPercent >= 10) {
    return buildStatus("degraded", "warn", `${pendingSummaryEntries} summaries pending`);
  }

  return buildStatus("healthy", "ok", "run healthy");
}
