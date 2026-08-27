import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADVERTISING_REQUIRES_CONSENT,
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

  // 2026-08-09 利用者判断: 広告は本番の標準機能とし、同意を要件から外した
  // (ADVERTISING_REQUIRES_CONSENT = false)。オフにする機能は将来の有料化候補で、
  // 状態モデルと撤回経路は温存してある。ここでは現行契約と、定数を true へ
  // 戻したときに opt-in 契約が復活することの両方を固定する。
  it("本番ドメインでは同意状態によらず広告を読み込む", () => {
    expect(ADVERTISING_REQUIRES_CONSENT).toBe(false);
    for (const state of ["allowed", "denied", "undecided"] as const) {
      expect(shouldLoadAdvertising("techdb.studio344.net", state)).toBe(true);
    }
  });

  it("本番ドメイン以外では広告を読み込まない", () => {
    for (const state of ["allowed", "denied", "undecided"] as const) {
      expect(shouldLoadAdvertising("tech-dashboard-6a7.pages.dev", state)).toBe(false);
      expect(shouldLoadAdvertising("localhost", state)).toBe(false);
      expect(shouldLoadAdvertising("127.0.0.1", state)).toBe(false);
    }
  });

  it("同意 UI を出さない (バナー・無効化ボタンとも非表示)", () => {
    // 定数が false の間は、どの hostname / path / state でも prompt を出さない。
    for (const hostname of ["techdb.studio344.net", "tech-dashboard-6a7.pages.dev", "localhost"]) {
      for (const path of ["/", "/privacy", "/about"]) {
        for (const state of ["undecided", "allowed", "denied"] as const) {
          expect(shouldShowPrivacyConsentPrompt(hostname, path, state)).toBe(false);
        }
      }
    }
  });

  it("publishes the confirmed operator, jurisdiction, and privacy route", () => {
    expect(PUBLIC_OPERATOR_NAME).toBe("Studio344");
    expect(PRIVACY_JURISDICTION).toBe("Japan");
    expect(PRIVACY_LAST_UPDATED).toBe("2026-08-27");
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
    // 広告は常時表示になったため「同意とは独立して」ではなく「広告とは独立して」。
    // RUM が広告の有無に依存しないことの開示自体は維持する。
    expect(page).toContain("広告とは独立して");
    expect(page).toContain("independently of advertising");
    expect(page).toContain("<code>static.cloudflareinsights.com</code>");
    expect(page).toContain("<code>/cdn-cgi/rum</code>");
    expect(page).not.toContain("独立したアクセス解析サービスを使用していません");
    expect(page).not.toContain("does not use a separate analytics service");
    expect(page).toContain(
      "D1 に保存する有効な識別子・投票・レート制限の各行には、現在のところ自動削除の期限を設定していません",
    );
    expect(page).toContain("ExternalLinkHint");
    expect(page).toContain('aria-controls="reaction-delete-confirmation"');
    expect(page).toContain('descriptionEn="TECH Dashboard privacy, advertising consent');
    expect(controls).toContain("requestReactionJson");
    expect(controls).toContain("fetchReactionConfigStatus");
    expect(controls).toContain("10_000");
  });
});
