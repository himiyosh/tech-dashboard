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
const IDENTITY_LOCK_NAME = "techdb-reaction-voter-identity";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TOAST_ID = "reaction-error-toast";
const LIVE_REGION_ID = "reaction-status-live";
const TOAST_DURATION_MS = 7_000;
const REACTION_REQUEST_TIMEOUT_MS = 15_000;
const REACTION_RECONCILIATION_DEADLINE_MS = 5_000;
const REACTION_RECONCILIATION_READ_TIMEOUT_MS = 1_250;
const REACTION_RECONCILIATION_DELAYS_MS = [0, 160, 360, 700] as const;

let initialized = false;
let turnstileLoadPromise: Promise<TurnstileApi> | undefined;
let languageObserver: MutationObserver | undefined;
let activeToastMessage: LocalizedReactionMessage | null = null;
let toastTimer: number | undefined;
let toastReturnFocus: HTMLElement | null = null;
let identityBootstrapPromise: Promise<void> | undefined;
let identityReady = false;
const reactionOperationVersions = new Map<string, number>();
let reactionServiceUnavailable = false;
let reactionServiceGeneration = 0;
let liveAnnouncementVersion = 0;
const reactionStatusMessages = new WeakMap<HTMLElement, LocalizedReactionMessage>();

class ReactionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`${code}:${status}`);
    this.name = "ReactionRequestError";
  }
}

export async function requestReactionJson(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = REACTION_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new ReactionRequestError("request_timeout", 0));
      controller.abort();
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => undefined);
    return { response, payload };
  })();

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

export async function requestReactionLock(
  lockManager: LockManager,
  callback: () => Promise<void>,
  timeoutMs = REACTION_REQUEST_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  let lockGranted = false;
  const timeoutId = globalThis.setTimeout(() => {
    if (!lockGranted) controller.abort();
  }, timeoutMs);
  try {
    await lockManager.request(
      IDENTITY_LOCK_NAME,
      { signal: controller.signal },
      async () => {
        lockGranted = true;
        globalThis.clearTimeout(timeoutId);
        await callback();
      },
    );
  } catch (error) {
    if (controller.signal.aborted && !lockGranted) {
      throw new ReactionRequestError("request_timeout", 0);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function beginReactionOperation(id: string): number {
  const version = (reactionOperationVersions.get(id) ?? 0) + 1;
  reactionOperationVersions.set(id, version);
  return version;
}

function isCurrentReactionOperation(id: string, version: number): boolean {
  return reactionOperationVersions.get(id) === version;
}

function currentReactionServiceGeneration(): number {
  return reactionServiceGeneration;
}

function isCurrentReactionServiceGeneration(generation: number): boolean {
  return !reactionServiceUnavailable && generation === reactionServiceGeneration;
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

function syncControlStatusLanguage(control: HTMLElement): void {
  const status = control.querySelector<HTMLElement>("[data-reaction-status]");
  const message = reactionStatusMessages.get(control);
  if (!status || !message) return;
  status.textContent = currentLanguage() === "en" ? message.en : message.ja;
}

function syncReactionLanguage(): void {
  document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach((control) => {
    if (control.dataset.state === "ready" || control.dataset.state === "busy") {
      syncControlCountLanguage(control);
      syncControlStatusLanguage(control);
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

function parseIdentityReady(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = (value as Record<string, unknown>).identity;
  return Boolean(
    identity &&
      typeof identity === "object" &&
      !Array.isArray(identity) &&
      (identity as Record<string, unknown>).ready === true,
  );
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
  const status = control.querySelector<HTMLElement>("[data-reaction-status]");
  if (!button) return;
  reactionStatusMessages.delete(control);
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
  if (status) status.textContent = "";
}

function markReactionServiceUnavailable(): void {
  const activeElement = document.activeElement;
  const focusedControl =
    activeElement instanceof HTMLElement
      ? activeElement.closest<HTMLElement>(CONTROL_SELECTOR)
      : null;
  const focusFallback = focusedControl
    ? reactionFocusFallback(focusedControl)
    : null;

  if (!reactionServiceUnavailable) {
    reactionServiceUnavailable = true;
    reactionServiceGeneration += 1;
  }
  identityReady = false;
  document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach(setControlUnavailable);
  syncReactionOverviewVisibility();
  if (
    focusFallback?.isConnected &&
    focusFallback.getClientRects().length > 0
  ) {
    focusFallback.focus({ preventScroll: true });
  }
}

function announce(control: HTMLElement, message: LocalizedReactionMessage): void {
  const status = control.querySelector<HTMLElement>("[data-reaction-status]");
  const copy = currentLanguage() === "en" ? message.en : message.ja;
  if (status) {
    reactionStatusMessages.set(control, message);
    status.textContent = copy;
  }

  const liveRegion = ensureReactionLiveRegion();
  const announcementVersion = ++liveAnnouncementVersion;
  liveRegion.textContent = "";
  window.requestAnimationFrame(() => {
    if (announcementVersion === liveAnnouncementVersion) {
      liveRegion.textContent = copy;
    }
  });
}

function clearAnnouncements(entryId: string): void {
  document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR).forEach((control) => {
    if (control.dataset.entryId !== entryId) return;
    const status = control.querySelector<HTMLElement>("[data-reaction-status]");
    reactionStatusMessages.delete(control);
    if (status) status.textContent = "";
  });
}

function isVisibleFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(
    target?.isConnected &&
    target.getClientRects().length > 0 &&
    !target.closest("[inert]") &&
    !target.matches(":disabled"),
  );
}

function dismissReactionToast(restoreFocus = true): void {
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
    toastTimer = undefined;
  }

  const toast = document.getElementById(TOAST_ID) as HTMLElement & {
    hidePopover?: () => void;
  } | null;
  if (!toast) {
    toastReturnFocus = null;
    return;
  }

  const activeElement = document.activeElement;
  const focusIsInsideToast =
    activeElement instanceof HTMLElement && toast.contains(activeElement);
  const fallback = toastReturnFocus
    ? reactionFocusFallback(toastReturnFocus)
    : null;
  const focusTarget = isVisibleFocusTarget(toastReturnFocus)
    ? toastReturnFocus
    : isVisibleFocusTarget(fallback)
      ? fallback
      : null;
  if (typeof toast.hidePopover === "function" && toast.matches(":popover-open")) {
    toast.hidePopover();
  }
  toast.hidden = true;
  delete toast.dataset.fallbackOpen;
  activeToastMessage = null;
  toastReturnFocus = null;
  if (restoreFocus && focusIsInsideToast && focusTarget) {
    window.requestAnimationFrame(() => {
      const current = document.activeElement;
      const focusCanReturn =
        current === activeElement ||
        current === document.body ||
        !(current instanceof HTMLElement) ||
        !isVisibleFocusTarget(current);
      if (focusCanReturn && isVisibleFocusTarget(focusTarget)) {
        focusTarget.focus({ preventScroll: true });
      }
    });
  }
}

function ensureReactionLiveRegion(): HTMLElement {
  const existing = document.getElementById(LIVE_REGION_ID);
  if (existing) return existing;

  const liveRegion = document.createElement("span");
  liveRegion.id = LIVE_REGION_ID;
  liveRegion.className = "visually-hidden";
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");
  document.body.append(liveRegion);
  return liveRegion;
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

  const close = document.createElement("button");
  close.className = "reaction-toast-close";
  close.type = "button";
  close.textContent = "×";
  close.addEventListener("click", () => dismissReactionToast());

  toast.append(icon, copy, close);
  document.body.append(toast);
  return toast;
}

function showReactionToast(
  message: LocalizedReactionMessage,
  focusReturn: HTMLElement | null,
): void {
  dismissReactionToast(false);
  activeToastMessage = message;
  toastReturnFocus = focusReturn;
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

  toastTimer = window.setTimeout(() => dismissReactionToast(), TOAST_DURATION_MS);
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    chunks.push(ids.slice(index, index + BATCH_SIZE));
  }
  return chunks;
}

async function fetchReactions(
  ids: string[],
  timeoutMs = REACTION_REQUEST_TIMEOUT_MS,
): Promise<ReactionSnapshot[]> {
  if (ids.length === 0) return [];
  const query = new URLSearchParams({ ids: ids.join(",") });
  const { response, payload } = await requestReactionJson(
    `/api/reactions?${query.toString()}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new ReactionRequestError(parseErrorCode(payload) ?? "request_failed", response.status);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("reaction read returned an invalid payload");
  }
  const reactions = (payload as Partial<ReactionListPayload>).reactions;
  if (!Array.isArray(reactions)) {
    throw new Error("reaction read returned an invalid payload");
  }
  const snapshots = reactions.map(parseReaction);
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
      currentLanguage() === "en"
        ? "Human verification"
        : "人間による操作の確認（ボット対策）",
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
  const { response, payload } = await requestReactionJson(
    `/api/reactions/${encodeURIComponent(id)}`,
    {
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
    },
  );
  if (!response.ok) {
    const code = parseErrorCode(payload) ?? "mutation_failed";
    throw new ReactionRequestError(code, response.status);
  }
  const snapshot = parseReactionPayload(payload);
  if (!snapshot || snapshot.id !== id) {
    throw new ReactionRequestError("invalid_response", response.status);
  }
  return snapshot;
}

async function postReactionIdentity(serviceGeneration: number): Promise<void> {
  if (!isCurrentReactionServiceGeneration(serviceGeneration)) {
    throw new ReactionRequestError("service_unavailable", 503);
  }
  const { response, payload } = await requestReactionJson(
    "/api/reactions/identity",
    {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new ReactionRequestError(
      parseErrorCode(payload) ?? "identity_unavailable",
      response.status,
    );
  }
  if (!parseIdentityReady(payload)) {
    throw new ReactionRequestError("invalid_identity_response", response.status);
  }
  if (!isCurrentReactionServiceGeneration(serviceGeneration)) {
    throw new ReactionRequestError("service_unavailable", 503);
  }
}

async function ensureReactionIdentity(): Promise<void> {
  if (reactionServiceUnavailable) {
    throw new ReactionRequestError("service_unavailable", 503);
  }
  if (identityReady) return;
  if (identityBootstrapPromise) return identityBootstrapPromise;

  const serviceGeneration = currentReactionServiceGeneration();
  const lockManager = "locks" in navigator ? navigator.locks : undefined;
  const pending = lockManager
    ? requestReactionLock(lockManager, () => postReactionIdentity(serviceGeneration))
    : postReactionIdentity(serviceGeneration);
  identityBootstrapPromise = pending;
  pending.then(
    () => {
      if (isCurrentReactionServiceGeneration(serviceGeneration)) identityReady = true;
      if (identityBootstrapPromise === pending) identityBootstrapPromise = undefined;
    },
    () => {
      if (identityBootstrapPromise === pending) identityBootstrapPromise = undefined;
    },
  );
  return pending;
}

function isPermanentServiceFailure(error: unknown): boolean {
  return (
    error instanceof ReactionRequestError &&
    (error.code === "service_not_configured" || error.code === "service_unavailable")
  );
}

function reactionFocusFallback(control: HTMLElement): HTMLElement | null {
  return (
    control
      .closest<HTMLElement>(".kg-card")
      ?.querySelector<HTMLElement>(".kg-card-link") ??
    document.querySelector<HTMLElement>(".ed-action-strip a, .ed-action-strip button")
  );
}

function mutationFailureMessage(error: unknown): LocalizedReactionMessage {
  const code = error instanceof ReactionRequestError ? error.code : "";
  if (code === "rate_limited") {
    return {
      ja: "操作が多すぎます。しばらく待ってから再試行してください。",
      en: "Too many requests. Please wait and try again.",
    };
  }
  if (code === "challenge_failed" || code.startsWith("turnstile_")) {
    return {
      ja: "ボット対策の確認を完了できませんでした。もう一度お試しください。",
      en: "Verification could not be completed. Please try again.",
    };
  }
  if (code === "challenge_unavailable") {
    return {
      ja: "ボット対策の確認サービスを一時利用できません。しばらくしてから再度お試しください。",
      en: "The verification service is temporarily unavailable. Please try again later.",
    };
  }
  if (code.startsWith("service_")) {
    return {
      ja: "いいね機能を一時的に利用できません。しばらくしてから再度お試しください。",
      en: "Likes are temporarily unavailable. Please try again shortly.",
    };
  }
  return {
    ja: "いいねを更新できませんでした。通信環境を確認して、もう一度お試しください。",
    en: "The like could not be updated. Check your connection and try again.",
  };
}

async function hydrateControls(
  controlsById: Map<string, HTMLElement[]>,
): Promise<void> {
  const ids = Array.from(controlsById.keys());
  for (const chunk of chunkIds(ids)) {
    if (reactionServiceUnavailable) break;
    const serviceGeneration = currentReactionServiceGeneration();
    try {
      const snapshots = await fetchReactions(chunk);
      if (!isCurrentReactionServiceGeneration(serviceGeneration)) continue;
      const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      for (const id of chunk) {
        const snapshot = byId.get(id);
        if (!snapshot) throw new Error(`reaction ${id} is missing`);
        for (const control of controlsById.get(id) ?? []) {
          if (getSiteKey(control)) setControlSnapshot(control, snapshot);
          else setControlUnavailable(control);
        }
      }
    } catch (error) {
      if (isPermanentServiceFailure(error)) {
        markReactionServiceUnavailable();
        break;
      }
      if (!isCurrentReactionServiceGeneration(serviceGeneration)) continue;
      for (const id of chunk) {
        for (const control of controlsById.get(id) ?? []) {
          setControlUnavailable(control);
        }
      }
    }
    syncReactionOverviewVisibility();
  }
}

interface ReactionReconciliationResult {
  status: "reconciled" | "stale" | "permanent-failure";
  error?: unknown;
  snapshot?: ReactionSnapshot;
}

async function reconcileReaction(
  id: string,
  controls: HTMLElement[],
  fallback: ReactionSnapshot,
  operationVersion: number,
  serviceGeneration: number,
  desiredLiked: boolean,
  pollForCommit: boolean,
): Promise<ReactionReconciliationResult> {
  let nextSnapshot = fallback;
  const delays = pollForCommit ? REACTION_RECONCILIATION_DELAYS_MS : [0];
  const deadlineAt = Date.now() + REACTION_RECONCILIATION_DEADLINE_MS;

  for (const delayMs of delays) {
    if (
      !isCurrentReactionOperation(id, operationVersion) ||
      !isCurrentReactionServiceGeneration(serviceGeneration)
    ) {
      return { status: "stale" };
    }
    const remainingBeforeDelay = deadlineAt - Date.now();
    if (remainingBeforeDelay <= 0 || delayMs >= remainingBeforeDelay) break;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    }
    if (
      !isCurrentReactionOperation(id, operationVersion) ||
      !isCurrentReactionServiceGeneration(serviceGeneration)
    ) {
      return { status: "stale" };
    }
    const remainingBeforeRead = deadlineAt - Date.now();
    if (remainingBeforeRead <= 0) break;
    try {
      const [snapshot] = await fetchReactions(
        [id],
        Math.max(
          1,
          Math.min(REACTION_RECONCILIATION_READ_TIMEOUT_MS, remainingBeforeRead),
        ),
      );
      if (
        !isCurrentReactionOperation(id, operationVersion) ||
        !isCurrentReactionServiceGeneration(serviceGeneration)
      ) {
        return { status: "stale" };
      }
      if (!snapshot) throw new Error("reaction is missing");
      nextSnapshot = snapshot;
      if (snapshot.liked === desiredLiked) break;
    } catch (error) {
      if (
        !isCurrentReactionOperation(id, operationVersion) ||
        !isCurrentReactionServiceGeneration(serviceGeneration)
      ) {
        return { status: "stale" };
      }
      if (isPermanentServiceFailure(error)) {
        markReactionServiceUnavailable();
        return { status: "permanent-failure", error };
      }
    }
  }

  if (
    !isCurrentReactionOperation(id, operationVersion) ||
    !isCurrentReactionServiceGeneration(serviceGeneration)
  ) {
    return { status: "stale" };
  }
  for (const control of controls) setControlSnapshot(control, nextSnapshot);
  return { status: "reconciled", snapshot: nextSnapshot };
}

function couldMutationHaveCommitted(error: unknown): boolean {
  return (
    !(error instanceof ReactionRequestError) ||
    error.code === "request_timeout" ||
    error.code === "invalid_response"
  );
}

async function toggleReaction(
  activeControl: HTMLElement,
  controlsById: Map<string, HTMLElement[]>,
): Promise<void> {
  if (reactionServiceUnavailable) return;
  const id = activeControl.dataset.entryId ?? "";
  const count = Number(activeControl.dataset.reactionCount);
  const liked = activeControl.dataset.reactionLiked === "true";
  const siteKey = getSiteKey(activeControl);
  const activeButton = getButton(activeControl);
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
  const serviceGeneration = currentReactionServiceGeneration();
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
    await ensureReactionIdentity();
    if (
      !isCurrentReactionOperation(id, operationVersion) ||
      !isCurrentReactionServiceGeneration(serviceGeneration)
    ) {
      return;
    }
    let token = "";
    try {
      token = await requestTurnstileToken(siteKey);
    } catch {
      throw new ReactionRequestError("challenge_failed", 0);
    }
    if (!isCurrentReactionServiceGeneration(serviceGeneration)) return;
    const snapshot = await putReaction(id, optimistic.liked, token);
    if (
      !isCurrentReactionOperation(id, operationVersion) ||
      !isCurrentReactionServiceGeneration(serviceGeneration)
    ) {
      return;
    }
    for (const control of controls) setControlSnapshot(control, snapshot);
    announce(activeControl, {
      ja: snapshot.liked ? "いいねしました。" : "いいねを取り消しました。",
      en: snapshot.liked ? "Liked." : "Like removed.",
    });
  } catch (error) {
    if (
      !isCurrentReactionOperation(id, operationVersion) ||
      !isCurrentReactionServiceGeneration(serviceGeneration)
    ) {
      return;
    }
    if (error instanceof ReactionRequestError && error.code === "identity_required") {
      identityReady = false;
    }
    for (const control of controls) setControlSnapshot(control, previous);
    const failure = mutationFailureMessage(error);
    if (isPermanentServiceFailure(error)) {
      markReactionServiceUnavailable();
      announce(activeControl, failure);
      showReactionToast(failure, activeButton);
      return;
    }
    const reconciliation = await reconcileReaction(
      id,
      controls,
      previous,
      operationVersion,
      serviceGeneration,
      optimistic.liked,
      couldMutationHaveCommitted(error),
    );
    if (reconciliation.status === "permanent-failure") {
      const permanentFailure = mutationFailureMessage(reconciliation.error);
      announce(activeControl, permanentFailure);
      showReactionToast(
        permanentFailure,
        activeButton,
      );
      return;
    }
    if (
      reconciliation.status !== "reconciled" ||
      !isCurrentReactionOperation(id, operationVersion) ||
      !isCurrentReactionServiceGeneration(serviceGeneration)
    ) {
      return;
    }
    if (reconciliation.snapshot?.liked === optimistic.liked) {
      announce(activeControl, {
        ja: optimistic.liked ? "いいねしました。" : "いいねを取り消しました。",
        en: optimistic.liked ? "Liked." : "Like removed.",
      });
      return;
    }
    announce(activeControl, failure);
    showReactionToast(failure, activeButton);
  }
}

export function initReactionControls(): void {
  if (initialized) return;
  initialized = true;

  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
  );
  ensureReactionLiveRegion();
  observeLanguageChanges();
  if (reactionServiceUnavailable) {
    for (const control of controls) setControlUnavailable(control);
    syncReactionOverviewVisibility();
    return;
  }
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
