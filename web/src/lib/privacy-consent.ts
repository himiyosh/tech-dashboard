import { ADSENSE_CLIENT_ID, SITE_URL } from "./site.ts";

export const PRIVACY_CONSENT_STORAGE_KEY = "td:privacy-consent:v1";
export const PRIVACY_CONSENT_VERSION = 1;
export const ADSENSE_SCRIPT_ID = "techdb-adsense-loader";

export type AdvertisingConsent = "allowed" | "denied";
export type PrivacyConsentState = AdvertisingConsent | "undecided";

export interface PrivacyConsentRecord {
  version: typeof PRIVACY_CONSENT_VERSION;
  advertising: AdvertisingConsent;
  decidedAt: string;
}

function isAdvertisingConsent(value: unknown): value is AdvertisingConsent {
  return value === "allowed" || value === "denied";
}

export function parsePrivacyConsent(value: string | null): PrivacyConsentRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 3 ||
      keys.some((key) => !["version", "advertising", "decidedAt"].includes(key)) ||
      record.version !== PRIVACY_CONSENT_VERSION ||
      !isAdvertisingConsent(record.advertising) ||
      typeof record.decidedAt !== "string" ||
      !Number.isFinite(Date.parse(record.decidedAt)) ||
      new Date(record.decidedAt).toISOString() !== record.decidedAt
    ) {
      return null;
    }
    return {
      version: PRIVACY_CONSENT_VERSION,
      advertising: record.advertising,
      decidedAt: record.decidedAt,
    };
  } catch {
    return null;
  }
}

export function createPrivacyConsent(
  advertising: AdvertisingConsent,
  now = new Date(),
): PrivacyConsentRecord {
  return {
    version: PRIVACY_CONSENT_VERSION,
    advertising,
    decidedAt: now.toISOString(),
  };
}

export function serializePrivacyConsent(record: PrivacyConsentRecord): string {
  return JSON.stringify(record);
}

export function privacyConsentState(
  record: PrivacyConsentRecord | null,
): PrivacyConsentState {
  return record?.advertising ?? "undecided";
}

export function isProductionAdvertisingHost(hostname: string): boolean {
  return hostname === new URL(SITE_URL).hostname;
}

export function shouldLoadAdvertising(
  hostname: string,
  state: PrivacyConsentState,
): boolean {
  return isProductionAdvertisingHost(hostname) && state === "allowed";
}

export function adsenseScriptUrl(): string {
  return `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT_ID)}`;
}
