import {
  ADSENSE_SCRIPT_ID,
  PRIVACY_CONSENT_STORAGE_KEY,
  adsenseScriptUrl,
  createPrivacyConsent,
  isProductionAdvertisingHost,
  parsePrivacyConsent,
  privacyConsentState,
  serializePrivacyConsent,
  shouldLoadAdvertising,
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
    const shouldShow =
      isProductionAdvertisingHost(window.location.hostname) &&
      state === "undecided" &&
      !/^\/privacy\/?$/.test(window.location.pathname);
    setHidden(root, !shouldShow);
  }
}

export function syncPrivacyConsent(state = readState()): void {
  document.documentElement.dataset.advertisingConsent = state;
  document.querySelectorAll<HTMLElement>(CONSENT_ROOT_SELECTOR).forEach((root) => {
    syncRoot(root, state);
  });
  loadAdvertising(state);
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
      if (state !== "allowed" && hadAdvertisingScript) {
        window.location.reload();
      }
    }
  });
  syncPrivacyConsent();
  restoreConsentFocus();
}
