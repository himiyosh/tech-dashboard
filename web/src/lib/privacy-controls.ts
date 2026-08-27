import {
  PRIVACY_CONSENT_STORAGE_KEY,
  ADSENSE_SCRIPT_ID,
  ADVERTISING_REQUIRES_CONSENT,
} from "./privacy-consent.ts";
import {
  clearPrivacyConsent,
} from "./privacy-consent-client.ts";
import { fetchReactionConfigStatus } from "./reaction-config-client.ts";
import { requestReactionJson } from "./reactions-client.ts";

const LOCAL_PREFERENCE_KEYS = [
  PRIVACY_CONSENT_STORAGE_KEY,
  "td:lang",
  "tech-dashboard-arxiv-view",
] as const;

let initialized = false;

function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
  if (hidden) element.setAttribute("inert", "");
  else element.removeAttribute("inert");
}

function scrollIntoSafeView(element: HTMLElement): void {
  window.requestAnimationFrame(() => {
    element.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  });
}

function clearStatus(root: HTMLElement): void {
  delete root.dataset.privacyControlState;
  root.querySelectorAll<HTMLElement>("[data-privacy-control-status]").forEach((item) => {
    item.hidden = true;
  });
}

function showStatus(root: HTMLElement, state: "success" | "error"): void {
  root.dataset.privacyControlState = state;
  let visibleStatus: HTMLElement | null = null;
  root.querySelectorAll<HTMLElement>("[data-privacy-control-status]").forEach((item) => {
    item.hidden = item.dataset.privacyControlStatus !== state;
    if (!item.hidden) visibleStatus = item;
  });
  if (visibleStatus) scrollIntoSafeView(visibleStatus);
}

function setConfirmationOpen(root: HTMLElement, open: boolean): void {
  const panel = root.querySelector<HTMLElement>("[data-reaction-delete-confirmation]");
  const trigger = root.querySelector<HTMLButtonElement>("[data-reaction-delete-open]");
  if (!panel || !trigger) return;
  panel.hidden = !open;
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    panel.removeAttribute("inert");
    panel.querySelector<HTMLButtonElement>("[data-reaction-delete-cancel]")?.focus();
    scrollIntoSafeView(panel);
  } else {
    panel.setAttribute("inert", "");
    trigger.focus();
  }
}

async function initializeReactionDeletion(root: HTMLElement): Promise<void> {
  const card = root.querySelector<HTMLElement>("[data-reaction-delete-card]");
  const trigger = root.querySelector<HTMLButtonElement>("[data-reaction-delete-open]");
  if (!card || !trigger) return;
  const result = await fetchReactionConfigStatus();
  const ready =
    result.state === "resolved" &&
    result.flags.databaseBinding &&
    result.flags.hmacSecret;
  const state = ready
    ? "ready"
    : result.state === "resolved"
      ? "not-configured"
      : "unavailable";
  card.dataset.reactionDeleteState = state;
  card.querySelectorAll<HTMLElement>("[data-reaction-delete-availability]").forEach(
    (status) => {
      setHidden(status, status.dataset.reactionDeleteAvailability !== state);
    },
  );
  setHidden(trigger, !ready);
}

async function deleteReactionIdentity(root: HTMLElement): Promise<void> {
  const confirm = root.querySelector<HTMLButtonElement>("[data-reaction-delete-confirm]");
  if (!confirm || confirm.getAttribute("aria-disabled") === "true") return;
  clearStatus(root);
  confirm.setAttribute("aria-disabled", "true");
  confirm.setAttribute("aria-busy", "true");
  try {
    const { response, payload } = await requestReactionJson(
      "/api/reactions/identity",
      {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
      10_000,
    );
    if (!response.ok) throw new Error(`Reaction deletion failed with HTTP ${response.status}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Reaction deletion returned an invalid response");
    }
    const identity = (payload as { identity?: unknown }).identity;
    if (
      !identity ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      (identity as { ready?: unknown }).ready !== false ||
      typeof (identity as { deleted?: unknown }).deleted !== "boolean"
    ) {
      throw new Error("Reaction deletion returned an invalid identity state");
    }
    showStatus(root, "success");
    setConfirmationOpen(root, false);
  } catch {
    showStatus(root, "error");
  } finally {
    confirm.setAttribute("aria-disabled", "false");
    confirm.setAttribute("aria-busy", "false");
  }
}

function clearLocalPreferences(root: HTMLElement): void {
  const hadAdvertisingScript = Boolean(document.getElementById(ADSENSE_SCRIPT_ID));
  clearStatus(root);
  let cleared = true;
  for (const key of LOCAL_PREFERENCE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      cleared = false;
    }
  }
  cleared = clearPrivacyConsent() && cleared;
  showStatus(root, cleared ? "success" : "error");
  // 同意が要件でない間は広告を落とす reload に意味がない (再読込後も表示される)。
  if (ADVERTISING_REQUIRES_CONSENT && cleared && hadAdvertisingScript) {
    window.location.reload();
  }
}

export function initializePrivacyControls(): void {
  if (initialized) return;
  initialized = true;
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const root = target?.closest<HTMLElement>("[data-privacy-controls]");
    if (!root) return;
    if (target?.closest("[data-clear-local-preferences]")) {
      clearLocalPreferences(root);
      return;
    }
    if (target?.closest("[data-reaction-delete-open]")) {
      setConfirmationOpen(root, true);
      return;
    }
    if (target?.closest("[data-reaction-delete-cancel]")) {
      setConfirmationOpen(root, false);
      return;
    }
    if (target?.closest("[data-reaction-delete-confirm]")) {
      void deleteReactionIdentity(root);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const root = document.querySelector<HTMLElement>(
      "[data-privacy-controls] [data-reaction-delete-confirmation]:not([hidden])",
    )?.closest<HTMLElement>("[data-privacy-controls]");
    if (root) setConfirmationOpen(root, false);
  });
  document.querySelectorAll<HTMLElement>("[data-privacy-controls]").forEach((root) => {
    void initializeReactionDeletion(root);
  });
}
