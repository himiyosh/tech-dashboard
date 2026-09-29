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

const SUMMARY_QUEUE_CARD_COPY: Record<
  QueueDisplayState,
  { badgeJa: string; badgeEn: string; detailJa: string; detailEn: string }
> = {
  active: {
    badgeJa: "要約を準備中",
    badgeEn: "Summary in preparation",
    detailJa: "AI 要約はまもなく追加されます",
    detailEn: "The AI summary will be added shortly",
  },
  clear: {
    badgeJa: "要約を準備中",
    badgeEn: "Summary in preparation",
    detailJa: "次回の更新で AI 要約が追加されます",
    detailEn: "The AI summary arrives with the next update",
  },
  "waiting-for-run": {
    badgeJa: "要約を準備中",
    badgeEn: "Summary in preparation",
    detailJa: "更新の再開後に AI 要約が追加されます",
    detailEn: "The AI summary is added once updates resume",
  },
  paused: {
    badgeJa: "要約は一時停止中",
    badgeEn: "Summary paused",
    detailJa: "AI 要約の生成を一時停止しています",
    detailEn: "AI summary generation is paused",
  },
  unavailable: {
    badgeJa: "要約は準備できません",
    badgeEn: "Summary unavailable",
    detailJa: "AI 要約を現在生成できません",
    detailEn: "The AI summary cannot be generated right now",
  },
  error: {
    badgeJa: "要約を確認中",
    badgeEn: "Summary being checked",
    detailJa: "AI 要約の生成に問題があり確認中です",
    detailEn: "The AI summary hit a problem and is being checked",
  },
  unknown: {
    badgeJa: "要約を準備中",
    badgeEn: "Summary in preparation",
    detailJa: "AI 要約の状態を確認しています",
    detailEn: "Checking the AI summary status",
  },
};

export function summaryQueueCardCopy(state: QueueDisplayState) {
  return SUMMARY_QUEUE_CARD_COPY[state];
}

export interface QueueDisplayOptions {
  mode: string | null | undefined;
  backlog: number | null | undefined;
  drainEstimateHours: number | null | undefined;
  budgetExcludedCount?: number | null;
  runTone: WorkerRunTone;
  runState?: WorkerRunState;
}

export function countBudgetExcludedIds(ids: unknown): number | null {
  if (ids === undefined) return null;
  if (!Array.isArray(ids)) return null;
  const validIds = ids.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  return validIds.length === ids.length ? new Set(validIds).size : null;
}

export function displayableBodyDrainHours(
  hours: number | null,
  excludedIds: unknown,
): number | null {
  const excludedCount = countBudgetExcludedIds(excludedIds);
  return excludedIds === undefined || excludedCount === 0 ? hours : null;
}

export function bodyBudgetExclusionCopy(count: number): { ja: string; en: string } {
  return {
    ja: `保存容量の上限で ${count} 件は本文生成対象外`,
    en: `storage limit excludes ${count} from explainer generation`,
  };
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
  budgetExcludedCount: rawBudgetExcludedCount,
  runTone,
  runState,
}: QueueDisplayOptions): QueueDisplay {
  const mode = normalizeMode(rawMode);
  const backlog = normalizedCount(rawBacklog);
  const budgetExcludedCount =
    typeof rawBudgetExcludedCount === "number"
    && Number.isSafeInteger(rawBudgetExcludedCount)
    && rawBudgetExcludedCount >= 0
      ? rawBudgetExcludedCount
      : null;
  const budgetLimited = budgetExcludedCount !== null && budgetExcludedCount > 0;
  const common = {
    mode,
    backlog,
    showBacklog: mode === "enabled" && backlog !== null,
  };
  const withBudgetContext = (display: QueueDisplay): QueueDisplay => {
    if (!budgetLimited) return display;
    const budgetCopy = bodyBudgetExclusionCopy(budgetExcludedCount);
    const backlogJa = mode === "enabled" && backlog !== null ? `本文待ち ${backlog} 件 · ` : "";
    const backlogEn = mode === "enabled" && backlog !== null ? `${backlog} awaiting explainers · ` : "";
    return {
      ...display,
      labelJa: `${display.labelJa} · ${backlogJa}${budgetCopy.ja}`,
      labelEn: `${display.labelEn} · ${backlogEn}${budgetCopy.en}`,
    };
  };

  if (mode === "disabled") {
    return withBudgetContext({
      ...common,
      state: "paused",
      tone: "warn",
      labelJa: "停止中",
      labelEn: "queue paused",
      modeLabelJa: "停止中",
      modeLabelEn: "paused",
    });
  }
  if (mode === "missing-binding") {
    return withBudgetContext({
      ...common,
      state: "unavailable",
      tone: "err",
      labelJa: "設定不足",
      labelEn: "binding unavailable",
      modeLabelJa: "利用不可",
      modeLabelEn: "unavailable",
    });
  }
  if (mode === "error") {
    return withBudgetContext({
      ...common,
      state: "error",
      tone: "err",
      labelJa: "処理エラー",
      labelEn: "queue error",
      modeLabelJa: "処理エラー",
      modeLabelEn: "error",
    });
  }
  if (mode === "unknown") {
    return withBudgetContext({
      ...common,
      state: "unknown",
      tone: "warn",
      labelJa: "記録なし",
      labelEn: "snapshot unavailable",
      modeLabelJa: "状態不明",
      modeLabelEn: "status unknown",
    });
  }
  if (
    runState === "missing"
    || runState === "late"
    || runState === "failed"
    || (!runState && runTone === "err")
  ) {
    return withBudgetContext({
      ...common,
      state: "waiting-for-run",
      tone: "neutral",
      labelJa: "収集再開待ち",
      labelEn: "waiting for a successful run",
      modeLabelJa: "収集再開待ち",
      modeLabelEn: "waiting for collection",
    });
  }
  if (backlog === null) {
    return withBudgetContext({
      ...common,
      state: "unknown",
      tone: "warn",
      labelJa: "記録なし",
      labelEn: "snapshot unavailable",
      modeLabelJa: "状態不明",
      modeLabelEn: "status unknown",
    });
  }
  if (backlog === 0 && !budgetLimited) {
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

  return withBudgetContext({
    ...common,
    state: "active",
    tone: "warn",
    labelJa: budgetLimited ? "全件の完了見込みなし" : etaLabel(normalizedCount(drainEstimateHours), "ja"),
    labelEn: budgetLimited ? "no full-backlog ETA" : etaLabel(normalizedCount(drainEstimateHours), "en"),
    modeLabelJa: "自動処理中",
    modeLabelEn: "active",
  });
}
