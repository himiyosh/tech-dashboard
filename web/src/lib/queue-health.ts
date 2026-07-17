import type { WorkerRunState, WorkerRunTone } from "./run-health.ts";

export type QueueMode =
  | "enabled"
  | "disabled"
  | "missing-binding"
  | "error"
  | "unknown";

export type QueueDisplayState =
  | "active"
  | "clear"
  | "waiting-for-run"
  | "paused"
  | "unavailable"
  | "error"
  | "unknown";

export type QueueDisplayTone = WorkerRunTone | "neutral";

export interface QueueDisplay {
  mode: QueueMode;
  state: QueueDisplayState;
  tone: QueueDisplayTone;
  backlog: number | null;
  showBacklog: boolean;
  labelJa: string;
  labelEn: string;
  modeLabelJa: string;
  modeLabelEn: string;
}

export interface QueueDisplayOptions {
  mode: string | null | undefined;
  backlog: number | null | undefined;
  drainEstimateHours: number | null | undefined;
  runTone: WorkerRunTone;
  runState?: WorkerRunState;
}

function normalizeMode(value: QueueDisplayOptions["mode"]): QueueMode {
  if (
    value === "enabled"
    || value === "disabled"
    || value === "missing-binding"
    || value === "error"
  ) {
    return value;
  }
  return "unknown";
}

function normalizedCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function etaLabel(hours: number | null, lang: "ja" | "en"): string {
  if (hours === null || hours <= 0) {
    return lang === "ja" ? "目安を計算中" : "estimate pending";
  }
  const roundedHours = Math.max(1, Math.ceil(hours));
  if (roundedHours <= 24) {
    return lang === "ja"
      ? `現在値で約 ${roundedHours}h`
      : `about ${roundedHours}h at current throughput`;
  }
  const days = Math.ceil(roundedHours / 24);
  return lang === "ja"
    ? `現在値で約 ${days}d`
    : `about ${days}d at current throughput`;
}

export function deriveQueueDisplay({
  mode: rawMode,
  backlog: rawBacklog,
  drainEstimateHours,
  runTone,
  runState,
}: QueueDisplayOptions): QueueDisplay {
  const mode = normalizeMode(rawMode);
  const backlog = normalizedCount(rawBacklog);
  const common = {
    mode,
    backlog,
    showBacklog: mode === "enabled" && backlog !== null,
  };

  if (mode === "disabled") {
    return {
      ...common,
      state: "paused",
      tone: "warn",
      labelJa: "停止中",
      labelEn: "queue paused",
      modeLabelJa: "停止中",
      modeLabelEn: "paused",
    };
  }
  if (mode === "missing-binding") {
    return {
      ...common,
      state: "unavailable",
      tone: "err",
      labelJa: "設定不足",
      labelEn: "binding unavailable",
      modeLabelJa: "利用不可",
      modeLabelEn: "unavailable",
    };
  }
  if (mode === "error") {
    return {
      ...common,
      state: "error",
      tone: "err",
      labelJa: "処理エラー",
      labelEn: "queue error",
      modeLabelJa: "処理エラー",
      modeLabelEn: "error",
    };
  }
  if (mode === "unknown") {
    return {
      ...common,
      state: "unknown",
      tone: "warn",
      labelJa: "記録なし",
      labelEn: "snapshot unavailable",
      modeLabelJa: "状態不明",
      modeLabelEn: "status unknown",
    };
  }
  if (
    runState === "missing"
    || runState === "late"
    || runState === "failed"
    || (!runState && runTone === "err")
  ) {
    return {
      ...common,
      state: "waiting-for-run",
      tone: "neutral",
      labelJa: "収集再開待ち",
      labelEn: "waiting for a successful run",
      modeLabelJa: "収集再開待ち",
      modeLabelEn: "waiting for collection",
    };
  }
  if (backlog === null) {
    return {
      ...common,
      state: "unknown",
      tone: "warn",
      labelJa: "記録なし",
      labelEn: "snapshot unavailable",
      modeLabelJa: "状態不明",
      modeLabelEn: "status unknown",
    };
  }
  if (backlog === 0) {
    return {
      ...common,
      state: "clear",
      tone: "ok",
      labelJa: "処理待ちなし",
      labelEn: "queue clear",
      modeLabelJa: "自動処理中",
      modeLabelEn: "active",
    };
  }

  return {
    ...common,
    state: "active",
    tone: "warn",
    labelJa: etaLabel(normalizedCount(drainEstimateHours), "ja"),
    labelEn: etaLabel(normalizedCount(drainEstimateHours), "en"),
    modeLabelJa: "自動処理中",
    modeLabelEn: "active",
  };
}
