export type WorkerRunTone = "ok" | "warn" | "err";

export interface WorkerHealthSnapshot {
  lastRunAt: string;
  copilotOk: boolean;
  sourcesFailed: string[];
}

export interface WorkerRunStatusOptions {
  workerHealth: WorkerHealthSnapshot | null;
  nowMs?: number;
  fallbackPercent: number;
  pendingSummaryEntries: number;
  staleRunHours?: number;
}

export interface WorkerRunStatus {
  tone: WorkerRunTone;
  statusText: "OK" | "WARN" | "ERR";
  runLabel: `run ${WorkerRunTone}`;
  detail: string;
}

function statusTextFor(tone: WorkerRunTone): WorkerRunStatus["statusText"] {
  if (tone === "ok") return "OK";
  if (tone === "warn") return "WARN";
  return "ERR";
}

function buildStatus(tone: WorkerRunTone, detail: string): WorkerRunStatus {
  return {
    tone,
    statusText: statusTextFor(tone),
    runLabel: `run ${tone}`,
    detail,
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
    return buildStatus("warn", "no data (legacy index)");
  }

  const lastRunMs = Date.parse(workerHealth.lastRunAt);
  const lastRunHours = Number.isFinite(lastRunMs) ? (nowMs - lastRunMs) / 3600_000 : Number.POSITIVE_INFINITY;
  if (lastRunHours > staleRunHours) {
    return buildStatus("err", `no run in ${staleRunHours}h+`);
  }
  if (!workerHealth.copilotOk) {
    return buildStatus("warn", "summarize disabled");
  }
  if (workerHealth.sourcesFailed.length > 0) {
    return buildStatus("warn", `${workerHealth.sourcesFailed.length} source error`);
  }
  if (fallbackPercent >= 10) {
    return buildStatus("warn", `${pendingSummaryEntries} summaries pending`);
  }

  return buildStatus("ok", "run healthy");
}
