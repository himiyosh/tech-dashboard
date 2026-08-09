import {
  ADSENSE_SCRIPT_ID,
  ADVERTISING_REQUIRES_CONSENT,
  PRIVACY_CONSENT_STORAGE_KEY,
  adsenseScriptUrl,
  createPrivacyConsent,
  parsePrivacyConsent,
  privacyConsentState,
  serializePrivacyConsent,
  shouldLoadAdvertising,
  shouldShowPrivacyConsentPrompt,
  type AdvertisingConsent,
  type PrivacyConsentState,
} from "./privacy-consent.ts";

const CONSENT_ROOT_SELECTOR = "[data-privacy-consent]";
const CONSENT_FOCUS_STORAGE_KEY = "td:privacy-consent-focus:v1";
let initialized = false;

function readState(): PrivacyConsentState {
  try {
    return privacyConsentState(
      parsePrivacyConsent(window.localStorage.getItem(PRIVACY_CONSENT_STORAGE_KEY)),
    );
  } catch {
    return "undecided";
  }
}

function writeState(choice: AdvertisingConsent): boolean {
  try {
    window.localStorage.setItem(
      PRIVACY_CONSENT_STORAGE_KEY,
      serializePrivacyConsent(createPrivacyConsent(choice)),
    );
    return true;
  } catch {
    return false;
  }
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
  if (hidden) element.setAttribute("inert", "");
  else element.removeAttribute("inert");
}

function loadAdvertising(state: PrivacyConsentState): void {
  if (!shouldLoadAdvertising(window.location.hostname, state)) return;
  if (document.getElementById(ADSENSE_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = ADSENSE_SCRIPT_ID;
  script.async = true;
  script.src = adsenseScriptUrl();
  script.crossOrigin = "anonymous";
  script.dataset.consent = "advertising";
  document.head.append(script);
}

/**
 * 手動広告ユニット (components/AdSlot.astro) の表示と初期化。
 *
 * AdSlot は slot ID 設定時のみ hidden + data-ad-pending で描画される。
 * 同意が「許可」かつ本番ドメインのときだけ表示し、unit ごとに 1 回
 * adsbygoogle.push する (push の queue は script 読込前でも配列として
 * 積めるため、loadAdvertising との順序に依存しない)。同意なし・非本番では
 * hidden のまま触らないので、審査中や preview で空白領域は生じない。
 */
const AD_FILL_TIMEOUT_MS = 4000;

function revealAdSlots(state: PrivacyConsentState): void {
  if (!shouldLoadAdvertising(window.location.hostname, state)) return;
  document
    .querySelectorAll<HTMLElement>(".ad-slot[data-ad-pending]")
    .forEach((slot) => {
      // push を先に試し、成功した slot だけを可視化する。push が throw した
      // 場合 (adsbygoogle が frozen / Proxy 化されている拡張環境など) は
      // pending のまま残し、空のラベル枠を出さない。
      try {
        const queue = ((window as unknown as { adsbygoogle?: { push(value: unknown): unknown } })
          .adsbygoogle ??= [] as unknown as { push(value: unknown): unknown });
        queue.push({});
      } catch {
        return;
      }
      slot.removeAttribute("data-ad-pending");
      setHidden(slot, false);
      // AdSense が fill しなかった場合 (在庫なし・未承認・script ブロック) は
      // 予約した高さごと畳む。data-ad-status は script が応答したときにしか
      // 付かないため、時間で打ち切らないと空白が残り続ける。
      window.setTimeout(() => {
        const ins = slot.querySelector("ins.adsbygoogle");
        if (ins?.getAttribute("data-ad-status") === "filled") return;
        slot.dataset.adCollapsed = "true";
      }, AD_FILL_TIMEOUT_MS);
    });
}

function rememberConsentFocus(choice: AdvertisingConsent): void {
  try {
    window.sessionStorage.setItem(CONSENT_FOCUS_STORAGE_KEY, choice);
  } catch {}
}

function restoreConsentFocus(): void {
  let choice: AdvertisingConsent | null = null;
  try {
    const stored = window.sessionStorage.getItem(CONSENT_FOCUS_STORAGE_KEY);
    window.sessionStorage.removeItem(CONSENT_FOCUS_STORAGE_KEY);
    if (stored === "allowed" || stored === "denied") choice = stored;
  } catch {}
  if (!choice) return;
  window.requestAnimationFrame(() => {
    const target = [...document.querySelectorAll<HTMLButtonElement>(
      `[data-consent-choice="${choice}"]`,
    )].find((button) => button.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  });
}

function syncRoot(root: HTMLElement, state: PrivacyConsentState): void {
  root.dataset.consentState = state;
  root.querySelectorAll<HTMLElement>("[data-consent-error]").forEach((error) => {
    setHidden(error, true);
  });
  root.querySelectorAll<HTMLElement>("[data-consent-status]").forEach((status) => {
    setHidden(status, status.dataset.consentStatus !== state);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-consent-choice]").forEach((button) => {
    const selected = button.dataset.consentChoice === state;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });

  if (root.dataset.consentSurface === "prompt") {
    const shouldShow = shouldShowPrivacyConsentPrompt(
      window.location.hostname,
      window.location.pathname,
      state,
    );
    setHidden(root, !shouldShow);
  }
}

export function syncPrivacyConsent(state = readState()): void {
  document.documentElement.dataset.advertisingConsent = state;
  document.documentElement.dataset.privacyConsentPrompt = shouldShowPrivacyConsentPrompt(
    window.location.hostname,
    window.location.pathname,
    state,
  )
    ? "visible"
    : "hidden";
  document.querySelectorAll<HTMLElement>(CONSENT_ROOT_SELECTOR).forEach((root) => {
    syncRoot(root, state);
  });
  loadAdvertising(state);
  revealAdSlots(state);
  document.dispatchEvent(
    new CustomEvent("techdb:privacyconsentchange", { detail: { state } }),
  );
}

export function clearPrivacyConsent(): boolean {
  try {
    window.localStorage.removeItem(PRIVACY_CONSENT_STORAGE_KEY);
  } catch {
    syncPrivacyConsent(readState());
    return false;
  }
  syncPrivacyConsent("undecided");
  return true;
}

function chooseAdvertising(choice: AdvertisingConsent): void {
  const hadAdvertisingScript = Boolean(document.getElementById(ADSENSE_SCRIPT_ID));
  if (!writeState(choice)) {
    document.querySelectorAll<HTMLElement>(CONSENT_ROOT_SELECTOR).forEach((root) => {
      root.querySelectorAll<HTMLElement>("[data-consent-error]").forEach((error) => {
        setHidden(error, false);
      });
    });
    return;
  }
  syncPrivacyConsent(choice);
  if (choice === "denied" && hadAdvertisingScript) {
    rememberConsentFocus(choice);
    window.location.reload();
  }
}

export function initializePrivacyConsent(): void {
  if (initialized) {
    syncPrivacyConsent();
    return;
  }
  initialized = true;
  document.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "[data-consent-choice]",
    );
    const choice = button?.dataset.consentChoice;
    if (choice === "allowed" || choice === "denied") chooseAdvertising(choice);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === PRIVACY_CONSENT_STORAGE_KEY || event.key === null) {
      const state = readState();
      const hadAdvertisingScript = Boolean(document.getElementById(ADSENSE_SCRIPT_ID));
      syncPrivacyConsent(state);
      // 撤回 (allowed → それ以外) を他 tab から受けたときだけ reload して
      // 読み込み済み script を落とす。同意が要件でない間は「allowed 以外」が
      // 常態なので、この条件のままだと storage event のたびに reload が走る。
      if (ADVERTISING_REQUIRES_CONSENT && state !== "allowed" && hadAdvertisingScript) {
        window.location.reload();
      }
    }
  });
  document.documentElement.dataset.privacyConsentClient = "ready";
  syncPrivacyConsent();
  restoreConsentFocus();
}
