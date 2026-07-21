const RELATIVE_TIME_REFRESH_EVENT = "techdb:refresh-relative-time";
const RELATIVE_TIME_TICK_EVENT = "techdb:clocktick";
const RELATIVE_TIME_REFRESH_MS = 60_000;

export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return "日付不明";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "日付不明";

  const diff = now.getTime() - timestamp;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function relativeTimestamp(element: HTMLElement): string | null {
  const explicit = element.dataset.datetime;
  if (explicit) return explicit;
  if (element instanceof HTMLTimeElement) return element.dateTime || element.getAttribute("datetime");
  return null;
}

export function refreshRelativeTimes(root: ParentNode = document, now = new Date()): void {
  root.querySelectorAll<HTMLElement>("[data-relative-time]").forEach((element) => {
    const timestamp = relativeTimestamp(element);
    if (!timestamp) return;
    const prefix = element.dataset.relativePrefix ?? "";
    const suffix = element.dataset.relativeSuffix ?? "";
    element.textContent = `${prefix}${relativeTime(timestamp, now)}${suffix}`;
  });
}

export function initializeRelativeTimes(): void {
  const globalState = window as Window & { __techDashboardRelativeTimes?: boolean };
  if (globalState.__techDashboardRelativeTimes) return;
  globalState.__techDashboardRelativeTimes = true;

  const refresh = () => {
    const now = new Date();
    refreshRelativeTimes(document, now);
    document.dispatchEvent(new CustomEvent(RELATIVE_TIME_TICK_EVENT, {
      detail: { nowMs: now.getTime() },
    }));
  };
  refresh();
  window.setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, RELATIVE_TIME_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  document.addEventListener(RELATIVE_TIME_REFRESH_EVENT, refresh);
}
