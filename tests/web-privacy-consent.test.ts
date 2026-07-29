import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRIVACY_CONSENT_STORAGE_KEY,
  createPrivacyConsent,
  parsePrivacyConsent,
  privacyConsentState,
  serializePrivacyConsent,
  shouldLoadAdvertising,
  shouldShowPrivacyConsentPrompt,
} from "../web/src/lib/privacy-consent.ts";
import { SITEMAP_STATIC_PATHS } from "../web/src/lib/route-inventory.ts";
import {
  PRIVACY_JURISDICTION,
  PRIVACY_LAST_UPDATED,
  PUBLIC_CONTACT_EMAIL,
  PUBLIC_OPERATOR_NAME,
} from "../web/src/lib/site.ts";

describe("privacy consent contract", () => {
  it("fails closed for absent, malformed, expired-version, and incomplete records", () => {
    expect(parsePrivacyConsent(null)).toBeNull();
    expect(parsePrivacyConsent("not-json")).toBeNull();
    expect(parsePrivacyConsent(JSON.stringify({
      version: 0,
      advertising: "allowed",
      decidedAt: "2026-07-27T00:00:00.000Z",
    }))).toBeNull();
    expect(parsePrivacyConsent(JSON.stringify({
      version: 1,
      advertising: "allowed",
      decidedAt: "not-a-date",
    }))).toBeNull();
    expect(parsePrivacyConsent(JSON.stringify({
      version: 1,
      advertising: "unknown",
      decidedAt: "2026-07-27T00:00:00.000Z",
    }))).toBeNull();
    expect(parsePrivacyConsent(JSON.stringify({
      version: 1,
      advertising: "allowed",
      decidedAt: "2026-07-27T09:00:00+09:00",
    }))).toBeNull();
    expect(parsePrivacyConsent(JSON.stringify({
      version: 1,
      advertising: "allowed",
      decidedAt: "2026-07-27T00:00:00.000Z",
      analytics: "allowed",
    }))).toBeNull();
    expect(privacyConsentState(null)).toBe("undecided");
  });

  it("round-trips an explicit advertising choice with a version and timestamp", () => {
    const record = createPrivacyConsent(
      "denied",
      new Date("2026-07-27T00:00:00.000Z"),
    );
    expect(parsePrivacyConsent(serializePrivacyConsent(record))).toEqual(record);
    expect(privacyConsentState(record)).toBe("denied");
    expect(PRIVACY_CONSENT_STORAGE_KEY).toBe("td:privacy-consent:v1");
  });

  it("loads advertising only after opt-in on the production custom domain", () => {
    expect(shouldLoadAdvertising("techdb.studio344.net", "allowed")).toBe(true);
    expect(shouldLoadAdvertising("techdb.studio344.net", "denied")).toBe(false);
    expect(shouldLoadAdvertising("techdb.studio344.net", "undecided")).toBe(false);
    expect(shouldLoadAdvertising("tech-dashboard-6a7.pages.dev", "allowed")).toBe(false);
    expect(shouldLoadAdvertising("localhost", "allowed")).toBe(false);
  });

  it("shows the prompt only for undecided production pages outside Privacy", () => {
    expect(
      shouldShowPrivacyConsentPrompt("techdb.studio344.net", "/", "undecided"),
    ).toBe(true);
    expect(
      shouldShowPrivacyConsentPrompt("techdb.studio344.net", "/", "allowed"),
    ).toBe(false);
    expect(
      shouldShowPrivacyConsentPrompt("techdb.studio344.net", "/", "denied"),
    ).toBe(false);
    expect(
      shouldShowPrivacyConsentPrompt("techdb.studio344.net", "/privacy", "undecided"),
    ).toBe(false);
    expect(
      shouldShowPrivacyConsentPrompt("techdb.studio344.net", "/privacy/", "undecided"),
    ).toBe(false);
    expect(
      shouldShowPrivacyConsentPrompt("tech-dashboard-6a7.pages.dev", "/", "undecided"),
    ).toBe(false);
    expect(
      shouldShowPrivacyConsentPrompt("localhost", "/", "undecided"),
    ).toBe(false);
  });

  it("publishes the confirmed operator, contact, jurisdiction, and privacy route", () => {
    expect(PUBLIC_OPERATOR_NAME).toBe("Studio344");
    expect(PUBLIC_CONTACT_EMAIL).toBe("himiyosh@gmail.com");
    expect(PRIVACY_JURISDICTION).toBe("Japan");
    expect(PRIVACY_LAST_UPDATED).toBe("2026-07-29");
    expect(SITEMAP_STATIC_PATHS).toContain("/privacy/");
  });

  it("keeps consent progressive, non-modal, and stable before client initialization", () => {
    const portal = readFileSync(
      new URL("../web/src/layouts/Portal.astro", import.meta.url),
      "utf8",
    );
    const client = readFileSync(
      new URL("../web/src/lib/privacy-consent-client.ts", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../web/src/styles/portal.css", import.meta.url),
      "utf8",
    );
    const promptRules = [
      ...styles.matchAll(/^\s*\.privacy-consent-prompt\s*\{([^}]*)\}/gm),
    ].map((match) => match[1] ?? "");
    expect(portal).toMatch(/data-consent-surface="prompt"[\s\S]*?hidden[\s\S]*?inert/);
    expect(portal).toContain("data-privacy-consent-prompt");
    expect(portal).toContain('aria-describedby="privacy-consent-prompt-description"');
    expect(portal).toContain("privacy-consent-choice-actions");
    expect(portal).toContain("privacyConsentStorageKey");
    expect(portal).toContain("privacyConsentVersion");
    expect(portal).toContain("productionAdvertisingHostname");
    expect(portal.indexOf('data-consent-surface="prompt"')).toBeLessThan(
      portal.indexOf("Parser-blocking bootstrap"),
    );
    expect(portal).toContain("root.hidden = !showPrompt");
    expect(portal).toContain('root.removeAttribute("inert")');
    expect(portal).toContain("working fail-safe");
    expect(styles).not.toContain(
      'html[data-privacy-consent-prompt="visible"] .privacy-consent-prompt[hidden]',
    );
    expect(promptRules.length).toBeGreaterThan(0);
    expect(promptRules[0]).toContain("position: relative");
    for (const promptRule of promptRules) {
      expect(promptRule).not.toContain("position: fixed");
      expect(promptRule).not.toContain("box-shadow");
    }
    expect(styles).toContain(".privacy-consent-choice-actions");
    expect(styles).toContain(
      'html[data-privacy-consent-prompt="visible"] .footer-bar',
    );
    expect(portal).not.toMatch(/pagead2\.googlesyndication\.com/);
    expect(portal).not.toMatch(/opacity:\s*0|visibility:\s*hidden/);
    expect(portal).not.toMatch(/<dialog[^>]+privacy/i);
    expect(client).toContain("shouldLoadAdvertising");
    expect(client).toContain("shouldShowPrivacyConsentPrompt");
    expect(client).toContain("dataset.privacyConsentPrompt");
    expect(client).toContain('dataset.privacyConsentClient = "ready"');
    expect(client).toContain("dataset.consent = \"advertising\"");
    expect(client).toContain("event.key === null");
    expect(client).toContain("[data-consent-error]");
    expect(client).toContain("CONSENT_FOCUS_STORAGE_KEY");
    expect(client).toContain("state !== \"allowed\" && hadAdvertisingScript");
    expect(portal).toContain(
      'document.addEventListener("techdb:privacyconsentchange", syncSearchOverlayPosition)',
    );
    expect(portal).toMatch(
      /document\.addEventListener\("techdb:languagechange", \(\) => \{\s*syncSearchOverlayPosition\(\)/,
    );
    expect(portal).toMatch(/\{ href: "\/privacy", key: "privacy"/);
  });

  it("ships privacy-preserving response headers for site documents", () => {
    const headers = readFileSync(
      new URL("../web/public/_headers", import.meta.url),
      "utf8",
    );
    expect(headers).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(headers).toContain("Permissions-Policy: geolocation=(), camera=(), microphone=()");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("X-Frame-Options: SAMEORIGIN");
  });

  it("documents URL-visible preferences, Cloudflare RUM, retention, and bounded deletion controls", () => {
    const page = readFileSync(
      new URL("../web/src/pages/privacy.astro", import.meta.url),
      "utf8",
    );
    const controls = readFileSync(
      new URL("../web/src/lib/privacy-controls.ts", import.meta.url),
      "utf8",
    );
    expect(page).toContain("<code>?lang=en</code>");
    expect(page).toContain("<code>?q=</code>");
    expect(page).toContain("<code>?entry=</code>");
    expect(page).toContain("<code>/rss/&lt;category&gt;.xml</code>");
    expect(page).not.toContain("?category=");
    expect(page).toContain("<code>?ids=</code>");
    expect(page).toContain("Cloudflare Web Analytics (RUM)");
    expect(page).toContain("任意の広告への同意とは独立して");
    expect(page).toContain("independently of optional advertising consent");
    expect(page).toContain("<code>static.cloudflareinsights.com</code>");
    expect(page).toContain("<code>/cdn-cgi/rum</code>");
    expect(page).not.toContain("独立したアクセス解析サービスを使用していません");
    expect(page).not.toContain("does not use a separate analytics service");
    expect(page).toContain("D1のactive identity、票、rate-limit行には現在、自動削除期限を設定していません");
    expect(page).toContain("ExternalLinkHint");
    expect(page).toContain('aria-controls="reaction-delete-confirmation"');
    expect(page).toContain('descriptionEn="TECH Dashboard privacy, advertising consent');
    expect(controls).toContain("requestReactionJson");
    expect(controls).toContain("fetchReactionConfigStatus");
    expect(controls).toContain("10_000");
  });
});
