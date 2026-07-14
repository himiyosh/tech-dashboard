interface ReactionSnapshot {
  id: string;
  count: number;
  liked: boolean;
}

interface ReactionListPayload {
  reactions: ReactionSnapshot[];
}

type SupportedLanguage = "ja" | "en";

interface LocalizedReactionMessage {
  ja: string;
  en: string;
}

type TurnstileWidgetId = string | number;

interface TurnstileApi {
  ready(callback: () => void): void;
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      execution: "execute";
      appearance: "interaction-only";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
    },
  ): TurnstileWidgetId;
  execute(widgetId: TurnstileWidgetId): void;
  remove?(widgetId: TurnstileWidgetId): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __TECHDB_REACTION_SITE_KEY__?: string;
  }
}

const CONTROL_SELECTOR = "[data-reaction-control]";
const OVERVIEW_SELECTOR = "[data-reaction-overview]";
const ENTRY_ID_RE = /^[a-f0-9]{16}$/;
const BATCH_SIZE = 50;
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TOAST_ID = "reaction-error-toast";
const TOAST_DURATION_MS = 7_000;

let initialized = false;
let turnstileLoadPromise: Promise<TurnstileApi> | undefined;
let languageObserver: MutationObserver | undefined;
let activeToastMessage: LocalizedReactionMessage | null = null;
let toastTimer: number | undefined;
const reactionOperationVersions = new Map<string, number>();

function beginReactionOperation(id: string): number {
  const version = (reactionOperationVersions.get(id) ?? 0) + 1;
  reactionOperationVersions.set(id, version);
  return version;
}

function isCurrentReactionOperation(id: string, version: number): boolean {
  return reactionOperationVersions.get(id) === version;
}

function currentLanguage(): SupportedLanguage {
  return document.documentElement.dataset.lang === "en" ? "en" : "ja";
}

function getButton(control: HTMLElement): HTMLButtonElement | null {
  return control.querySelector<HTMLButtonElement>("[data-reaction-button]");
}

function boundedCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function formatReactionCount(value: number): string {
  const count = boundedCount(value);
  if (count < 1_000) return String(count);
  return new Intl.NumberFormat("en", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(count);
}

export function formatExactReactionCount(
  value: number,
  language: SupportedLanguage,
): string {
  const count = boundedCount(value);
  const formatted = new Intl.NumberFormat(language === "en" ? "en-US" : "ja-JP")
    .format(count);
  return language === "en" ? `${formatted} likes` : `${formatted}件`;
}

function setControlState(
  control: HTMLElement,
  state: "loading" | "ready" | "busy" | "unavailable",
): void {
  const hidden = state === "loading" || state === "unavailable";
  control.dataset.state = state;
  control.setAttribute("aria-hidden", hidden ? "true" : "false");
  control.inert = hidden;

  const surface = control.closest<HTMLElement>("[data-reaction-surface]");
  if (surface) {
    surface.hidden = hidden;
    surface.dataset.reactionState = state;
  }
}

function syncReactionOverviewVisibility(): void {
  const hasAvailableControl = Array.from(
    document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
  ).some((control) => control.dataset.state === "ready" || control.dataset.state === "busy");

  for (const overview of document.querySelectorAll<HTMLElement>(OVERVIEW_SELECTOR)) {
    overview.hidden = !hasAvailableControl;
    overview.dataset.reactionState = hasAvailableControl ? "ready" : "unavailable";
  }
}

function syncControlCountLanguage(control: HTMLElement): void {
  const count = boundedCount(control.dataset.reactionCount);
  const language = currentLanguage();
  const visibleCount = control.querySelector<HTMLElement>("[data-reaction-count]");
  const exactCount = control.querySelector<HTMLElement>("[data-reaction-count-exact]");
  const exactCopy = formatExactReactionCount(count, language);

  if (visibleCount) {
    visibleCount.textContent = formatReactionCount(count);
    visibleCount.title = exactCopy;
  }
  if (exactCount) exactCount.textContent = exactCopy;
}

function syncReactionLanguage(): void {
  document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach((control) => {
    if (control.dataset.state === "ready" || control.dataset.state === "busy") {
      syncControlCountLanguage(control);
    }
  });

  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  const copy = toast.querySelector<HTMLElement>("[data-reaction-toast-copy]");
  const close = toast.querySelector<HTMLButtonElement>(".reaction-toast-close");
  if (copy && activeToastMessage) {
    copy.textContent = currentLanguage() === "en"
      ? activeToastMessage.en
      : activeToastMessage.ja;
  }
  if (close) {
    const closeLabel = currentLanguage() === "en" ? "Dismiss notification" : "通知を閉じる";
    close.setAttribute("aria-label", closeLabel);
    close.title = closeLabel;
  }
}

function observeLanguageChanges(): void {
  if (languageObserver) return;
  languageObserver = new MutationObserver(syncReactionLanguage);
  languageObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-lang"],
  });
}

function getSiteKey(control: HTMLElement): string {
  return (
    control.dataset.turnstileSiteKey?.trim() ||
    window.__TECHDB_REACTION_SITE_KEY__?.trim() ||
    ""
  );
}

function parseReaction(value: unknown): ReactionSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !ENTRY_ID_RE.test(candidate.id) ||
    typeof candidate.count !== "number" ||
    !Number.isSafeInteger(candidate.count) ||
    candidate.count < 0 ||
    typeof candidate.liked !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    count: candidate.count,
    liked: candidate.liked,
  };
}

function parseReactionPayload(value: unknown): ReactionSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return parseReaction((value as Record<string, unknown>).reaction);
}

function parseErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function setControlSnapshot(
  control: HTMLElement,
  snapshot: ReactionSnapshot,
  options: { busy?: boolean; enabled?: boolean } = {},
): void {
  const button = getButton(control);
  const count = control.querySelector<HTMLElement>("[data-reaction-count]");
  if (!button || !count) return;

  const busy = options.busy ?? false;
  const enabled = options.enabled ?? Boolean(getSiteKey(control));
  control.dataset.reactionCount = String(snapshot.count);
  control.dataset.reactionLiked = String(snapshot.liked);
  setControlState(control, busy ? "busy" : "ready");
  count.textContent = formatReactionCount(snapshot.count);
  button.setAttribute("aria-pressed", String(snapshot.liked));
  button.setAttribute("aria-busy", String(busy));
  button.setAttribute("aria-disabled", String(busy || !enabled));
  button.disabled = !enabled;
  button.removeAttribute("title");
  syncControlCountLanguage(control);
}

function setControlUnavailable(control: HTMLElement): void {
  const button = getButton(control);
  const count = control.querySelector<HTMLElement>("[data-reaction-count]");
  const exactCount = control.querySelector<HTMLElement>("[data-reaction-count-exact]");
  if (!button) return;
  setControlState(control, "unavailable");
  button.setAttribute("aria-busy", "false");
  button.setAttribute("aria-disabled", "true");
  button.disabled = true;
  button.removeAttribute("title");
  if (count) {
    count.textContent = "—";
    count.removeAttribute("title");
  }
  if (exactCount) {
    exactCount.textContent = currentLanguage() === "en"
      ? "Count unavailable"
      : "件数を利用できません";
  }
}

function announce(control: HTMLElement, message: LocalizedReactionMessage): void {
  const status = control.querySelector<HTMLElement>("[data-reaction-status]");
  if (status) {
    status.textContent = currentLanguage() === "en" ? message.en : message.ja;
  }
}

function clearAnnouncements(entryId: string): void {
  document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach((control) => {
    if (control.dataset.entryId !== entryId) return;
    const status = control.querySelector<HTMLElement>("[data-reaction-status]");
    if (status) status.textContent = "";
  });
}

function dismissReactionToast(): void {
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
    toastTimer = undefined;
  }

  const toast = document.getElementById(TOAST_ID) as HTMLElement & {
    hidePopover?: () => void;
  } | null;
  if (!toast) return;

  if (typeof toast.hidePopover === "function" && toast.matches(":popover-open")) {
    toast.hidePopover();
  }
  toast.hidden = true;
  delete toast.dataset.fallbackOpen;
  activeToastMessage = null;
}

function ensureReactionToast(): HTMLElement {
  const existing = document.getElementById(TOAST_ID);
  if (existing) return existing;

  const toast = document.createElement("div") as HTMLElement & {
    showPopover?: () => void;
  };
  toast.id = TOAST_ID;
  toast.className = "reaction-toast";
  toast.setAttribute("popover", "manual");
  toast.hidden = true;

  const icon = document.createElement("span");
  icon.className = "reaction-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "!";

  const copy = document.createElement("span");
  copy.className = "reaction-toast-copy";
  copy.dataset.reactionToastCopy = "";
  copy.setAttribute("role", "status");
  copy.setAttribute("aria-live", "polite");
  copy.setAttribute("aria-atomic", "true");

  const close = document.createElement("button");
  close.className = "reaction-toast-close";
  close.type = "button";
  close.textContent = "×";
  close.addEventListener("click", dismissReactionToast);

  toast.append(icon, copy, close);
  document.body.append(toast);
  return toast;
}

function showReactionToast(message: LocalizedReactionMessage): void {
  dismissReactionToast();
  activeToastMessage = message;
  const toast = ensureReactionToast() as HTMLElement & {
    showPopover?: () => void;
  };
  syncReactionLanguage();
  toast.hidden = false;

  if (typeof toast.showPopover === "function") {
    if (!toast.matches(":popover-open")) toast.showPopover();
  } else {
    toast.dataset.fallbackOpen = "true";
  }

  toastTimer = window.setTimeout(dismissReactionToast, TOAST_DURATION_MS);
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    chunks.push(ids.slice(index, index + BATCH_SIZE));
  }
  return chunks;
}

async function fetchReactions(ids: string[]): Promise<ReactionSnapshot[]> {
  if (ids.length === 0) return [];
  const query = new URLSearchParams({ ids: ids.join(",") });
  const response = await fetch(`/api/reactions?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`reaction read failed (${response.status})`);

  const payload = (await response.json()) as ReactionListPayload;
  if (!Array.isArray(payload.reactions)) {
    throw new Error("reaction read returned an invalid payload");
  }
  const snapshots = payload.reactions.map(parseReaction);
  if (snapshots.some((snapshot) => !snapshot)) {
    throw new Error("reaction read returned an invalid item");
  }
  return snapshots as ReactionSnapshot[];
}

async function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return window.turnstile;
  if (turnstileLoadPromise) return turnstileLoadPromise;

  turnstileLoadPromise = new Promise<TurnstileApi>((resolve, reject) => {
    document.querySelectorAll<HTMLScriptElement>(
      'script[data-techdb-turnstile-loader="true"]',
    ).forEach((staleScript) => staleScript.remove());

    const script = document.createElement("script");
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      script.removeEventListener("load", finish);
      script.removeEventListener("error", fail);
    };
    const rejectLoad = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      reject(new Error(message));
    };
    const finish = () => {
      if (settled) return;
      if (!window.turnstile) {
        rejectLoad("Turnstile loaded without an API");
        return;
      }
      window.turnstile.ready(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(window.turnstile as TurnstileApi);
      });
    };
    const fail = () => {
      rejectLoad("Turnstile failed to load");
    };
    const timeout = window.setTimeout(
      () => rejectLoad("Turnstile did not load in time"),
      12_000,
    );

    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    script.dataset.techdbTurnstileLoader = "true";
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    document.head.append(script);
  }).catch((error) => {
    turnstileLoadPromise = undefined;
    throw error;
  });

  return turnstileLoadPromise;
}

async function requestTurnstileToken(siteKey: string): Promise<string> {
  const api = await loadTurnstile();
  return new Promise<string>((resolve, reject) => {
    const container = document.createElement("div");
    container.className = "reaction-turnstile-widget";
    container.setAttribute(
      "aria-label",
      currentLanguage() === "en" ? "Human verification" : "本人確認",
    );
    document.body.append(container);

    let widgetId: TurnstileWidgetId | undefined;
    let settled = false;
    const timeout = window.setTimeout(
      () => finish(undefined, new Error("Human verification timed out")),
      120_000,
    );

    const cleanup = () => {
      window.clearTimeout(timeout);
      if (widgetId !== undefined) api.remove?.(widgetId);
      container.remove();
    };
    const finish = (token?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (token) resolve(token);
      else reject(error ?? new Error("Human verification failed"));
    };

    api.ready(() => {
      try {
        widgetId = api.render(container, {
          sitekey: siteKey,
          action: "article-like",
          execution: "execute",
          appearance: "interaction-only",
          callback: (token) => finish(token),
          "error-callback": () =>
            finish(undefined, new Error("Human verification failed")),
          "expired-callback": () =>
            finish(undefined, new Error("Human verification expired")),
          "timeout-callback": () =>
            finish(undefined, new Error("Human verification timed out")),
        });
        api.execute(widgetId);
      } catch (error) {
        finish(
          undefined,
          error instanceof Error ? error : new Error("Human verification failed"),
        );
      }
    });
  });
}

async function putReaction(
  id: string,
  liked: boolean,
  turnstileToken: string,
): Promise<ReactionSnapshot> {
  const response = await fetch(`/api/reactions/${encodeURIComponent(id)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      liked,
      turnstileToken,
    }),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const code = parseErrorCode(payload) ?? "mutation_failed";
    throw new Error(`${code}:${response.status}`);
  }
  const snapshot = parseReactionPayload(payload);
  if (!snapshot || snapshot.id !== id) {
    throw new Error("mutation_failed:invalid_response");
  }
  return snapshot;
}

function mutationFailureMessage(error: unknown): LocalizedReactionMessage {
  const value = error instanceof Error ? error.message : "";
  if (value.startsWith("rate_limited:")) {
    return {
      ja: "操作が多すぎます。しばらく待ってから再試行してください。",
      en: "Too many requests. Please wait and try again.",
    };
  }
  if (value.startsWith("challenge_failed:")) {
    return {
      ja: "本人確認を完了できませんでした。もう一度お試しください。",
      en: "Verification could not be completed. Please try again.",
    };
  }
  if (
    value.startsWith("service_not_configured:") ||
    value.startsWith("service_unavailable:")
  ) {
    return {
      ja: "いいね機能を一時的に利用できません。しばらくしてから再度お試しください。",
      en: "Likes are temporarily unavailable. Please try again shortly.",
    };
  }
  return {
    ja: "いいねを更新できませんでした。通信を確認して再度お試しください。",
    en: "The like could not be updated. Check your connection and try again.",
  };
}

async function hydrateControls(
  controlsById: Map<string, HTMLElement[]>,
): Promise<void> {
  const ids = Array.from(controlsById.keys());
  for (const chunk of chunkIds(ids)) {
    try {
      const snapshots = await fetchReactions(chunk);
      const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      for (const id of chunk) {
        const snapshot = byId.get(id);
        if (!snapshot) throw new Error(`reaction ${id} is missing`);
        for (const control of controlsById.get(id) ?? []) {
          if (getSiteKey(control)) setControlSnapshot(control, snapshot);
          else setControlUnavailable(control);
        }
      }
    } catch {
      for (const id of chunk) {
        for (const control of controlsById.get(id) ?? []) {
          setControlUnavailable(control);
        }
      }
    }
    syncReactionOverviewVisibility();
  }
}

async function reconcileReaction(
  id: string,
  controls: HTMLElement[],
  fallback: ReactionSnapshot,
  operationVersion: number,
): Promise<boolean> {
  let nextSnapshot = fallback;
  try {
    const [snapshot] = await fetchReactions([id]);
    if (!snapshot) throw new Error("reaction is missing");
    nextSnapshot = snapshot;
  } catch {}

  if (!isCurrentReactionOperation(id, operationVersion)) return false;
  for (const control of controls) setControlSnapshot(control, nextSnapshot);
  return true;
}

async function toggleReaction(
  activeControl: HTMLElement,
  controlsById: Map<string, HTMLElement[]>,
): Promise<void> {
  const id = activeControl.dataset.entryId ?? "";
  const count = Number(activeControl.dataset.reactionCount);
  const liked = activeControl.dataset.reactionLiked === "true";
  const siteKey = getSiteKey(activeControl);
  const controls = controlsById.get(id) ?? [];
  if (
    activeControl.dataset.state === "busy" ||
    !ENTRY_ID_RE.test(id) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !siteKey
  ) {
    return;
  }

  const previous: ReactionSnapshot = { id, count, liked };
  const operationVersion = beginReactionOperation(id);
  const optimistic: ReactionSnapshot = {
    id,
    liked: !liked,
    count: Math.max(0, count + (liked ? -1 : 1)),
  };
  dismissReactionToast();
  clearAnnouncements(id);
  for (const control of controls) {
    setControlSnapshot(control, optimistic, { busy: true });
  }

  try {
    let token = "";
    try {
      token = await requestTurnstileToken(siteKey);
    } catch {
      throw new Error("challenge_failed:client");
    }
    const snapshot = await putReaction(id, optimistic.liked, token);
    if (!isCurrentReactionOperation(id, operationVersion)) return;
    for (const control of controls) setControlSnapshot(control, snapshot);
    announce(activeControl, {
      ja: snapshot.liked ? "いいねしました。" : "いいねを取り消しました。",
      en: snapshot.liked ? "Liked." : "Like removed.",
    });
  } catch (error) {
    if (!isCurrentReactionOperation(id, operationVersion)) return;
    for (const control of controls) setControlSnapshot(control, previous);
    const reconciled = await reconcileReaction(
      id,
      controls,
      previous,
      operationVersion,
    );
    if (!reconciled || !isCurrentReactionOperation(id, operationVersion)) return;
    const failure = mutationFailureMessage(error);
    announce(activeControl, failure);
    showReactionToast(failure);
  }
}

export function initReactionControls(): void {
  if (initialized) return;
  initialized = true;

  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
  );
  observeLanguageChanges();
  const controlsById = new Map<string, HTMLElement[]>();
  for (const control of controls) {
    const id = control.dataset.entryId ?? "";
    if (!ENTRY_ID_RE.test(id)) {
      setControlUnavailable(control);
      continue;
    }
    const list = controlsById.get(id) ?? [];
    list.push(control);
    controlsById.set(id, list);
    getButton(control)?.addEventListener("click", () => {
      void toggleReaction(control, controlsById);
    });
  }

  const configured = controls.some((control) => Boolean(getSiteKey(control)));
  if (!configured) {
    for (const control of controls) setControlUnavailable(control);
    syncReactionOverviewVisibility();
    return;
  }
  void hydrateControls(controlsById);
}
