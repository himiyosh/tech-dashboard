import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTACT_EMAIL_DOMAIN,
  PUBLIC_CONTACT_EMAIL,
  SITE_URL,
} from "../web/src/lib/site.ts";
import { SITEMAP_STATIC_PATHS } from "../web/src/lib/route-inventory.ts";
import { ADVERTISING_REQUIRES_CONSENT } from "../web/src/lib/privacy-consent.ts";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const PLACEHOLDER_LOCAL_PARTS = [
  "example",
  "test",
  "todo",
  "tbd",
  "changeme",
  "noreply",
  "no-reply",
  "your-email",
  "youremail",
];

/**
 * Every reason `value` must not be published as this site's contact address.
 * An empty string is the deliberate "no mailbox yet" state, which /contact
 * renders as a visible notice — that is allowed. Anything else must be a
 * single plain address on the site's own domain, which structurally excludes
 * a free-provider personal mailbox, and must not be a look-alike placeholder
 * whose mail would vanish silently.
 */
function contactEmailProblems(value: string): string[] {
  if (value === "") return [];
  const problems: string[] = [];
  if (value !== value.trim()) problems.push("has surrounding whitespace");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(value)) {
    problems.push("is not a single plain address");
  }
  const parts = value.split("@");
  const localPart = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (domain.toLowerCase() !== CONTACT_EMAIL_DOMAIN.toLowerCase()) {
    problems.push(`is not on ${CONTACT_EMAIL_DOMAIN}`);
  }
  if (PLACEHOLDER_LOCAL_PARTS.includes(localPart.toLowerCase())) {
    problems.push("uses a placeholder local part");
  }
  return problems;
}

/**
 * Visible Japanese text of every `.i18n-ja` span in an Astro source file, with
 * <code> literals and all markup removed so query parameters, hostnames, and
 * href attributes cannot masquerade as prose.
 */
function japaneseProse(source: string): string[] {
  return [...source.matchAll(/<span class="i18n-ja">([\s\S]*?)<\/span>/g)].map((match) =>
    (match[1] ?? "")
      .replace(/<code>[\s\S]*?<\/code>/g, "")
      .replace(/<[^>]*>/g, ""),
  );
}

// A lowercase latin run welded directly onto kana or kanji — the signature of
// the mixed-language regression ("解析provider", "配信request", "browser識別子").
// Space-separated proper nouns ("Cloudflare のポリシー", "localStorage に保存")
// are untouched. The kana class deliberately stops before U+30FB ("・") so a
// Japanese middle dot after an English protocol name is not a false positive.
const MIXED_LANGUAGE_RE = /[ぁ-んァ-ヴ一-龥][a-z]{3,}|[a-z]{3,}[ぁ-んァ-ヴ一-龥]/;

describe("contact address contract", () => {
  it("rejects personal, off-domain, placeholder, and malformed addresses", () => {
    expect(contactEmailProblems("")).toEqual([]);
    expect(contactEmailProblems(`contact@${CONTACT_EMAIL_DOMAIN}`)).toEqual([]);
    expect(contactEmailProblems("himiyosh.344@gmail.com")).toContain(
      `is not on ${CONTACT_EMAIL_DOMAIN}`,
    );
    expect(contactEmailProblems(`example@${CONTACT_EMAIL_DOMAIN}`)).toContain(
      "uses a placeholder local part",
    );
    expect(contactEmailProblems(`noreply@${CONTACT_EMAIL_DOMAIN}`)).toContain(
      "uses a placeholder local part",
    );
    expect(contactEmailProblems(` contact@${CONTACT_EMAIL_DOMAIN} `)).toContain(
      "has surrounding whitespace",
    );
    expect(contactEmailProblems("Contact us at contact@example.com")).toContain(
      "is not a single plain address",
    );
  });

  it("publishes either no address or a role address on the site's own domain", () => {
    expect(CONTACT_EMAIL_DOMAIN).toBe(new URL(SITE_URL).hostname);
    expect(contactEmailProblems(PUBLIC_CONTACT_EMAIL)).toEqual([]);
  });

  it("never hard-codes a mailto: or a personal mailbox in a published page", () => {
    const templated = "href={`mailto:${contactEmail}`}";
    for (const path of [
      "web/src/pages/contact.astro",
      "web/src/pages/about.astro",
      "web/src/pages/privacy.astro",
      "web/src/pages/editorial-policy.astro",
      "web/src/layouts/Portal.astro",
    ]) {
      const source = read(path);
      const mailtoCount = source.split("mailto:").length - 1;
      const templatedCount = source.split(templated).length - 1;
      // The only permitted mailto: is the template literal fed by the constant.
      expect(mailtoCount, `${path} hard-codes a mailto:`).toBe(templatedCount);
      expect(source, `${path} names a personal mailbox`).not.toContain("gmail.com");
    }
  });
});

describe("contact route registration", () => {
  it("renders the missing mailbox as a visible, explicit state", () => {
    const page = read("web/src/pages/contact.astro");
    expect(page).toContain("data-contact-email-state={contactEmailState}");
    expect(page).toContain(
      'const contactEmailState = hasContactEmail ? "available" : "unavailable";',
    );
    expect(page).toContain("メールでの窓口は未開設です。");
    expect(page).toContain("There is no email address yet.");
    expect(page).toContain("contact-unavailable");
    // Breadcrumb on every route except home (site-wide convention).
    expect(page).toContain(
      'breadcrumb={[{ label: "Home", href: "/" }, { label: "Contact" }]}',
    );
    expect(page).toContain('pageKey="contact"');
  });

  it("registers /contact in the route inventory, the menu, and the footer", () => {
    // Not cosmetic: web/scripts/validate-sitemap-dist.mjs fails the build when a
    // canonical HTML route is absent from sitemap.xml, and vice versa.
    expect(SITEMAP_STATIC_PATHS).toContain("/contact/");
    const portal = read("web/src/layouts/Portal.astro");
    expect(portal).toMatch(/\{ href: "\/contact", key: "contact"/);
    expect(portal).toContain('<a class="item footer-privacy-link" href="/contact">');
    expect(portal).toContain('| "contact"');
  });

  it("links every other trust page to the contact route", () => {
    for (const path of [
      "web/src/pages/about.astro",
      "web/src/pages/privacy.astro",
      "web/src/pages/editorial-policy.astro",
    ]) {
      expect(read(path), path).toContain('href="/contact"');
    }
  });
});

describe("trust pages match the implementation", () => {
  it("does not promise that facts absent from the source are never invented", () => {
    const policy = read("web/src/pages/editorial-policy.astro");
    // Prose in .astro markup wraps across lines, so English phrases are
    // matched against a whitespace-normalised copy. Matching the raw source
    // would make the guard fail on reflow rather than on a changed claim.
    const flat = policy.replace(/\s+/g, " ");
    // The audited claims (editorial-policy.astro:95 and :102 before the rewrite).
    expect(policy).not.toContain("出典に無い機能・価格・対象地域を推測で補いません");
    expect(flat).not.toContain("absent from the source are never invented");
    // ...and states what the pipeline actually does instead.
    expect(policy).toContain("280");
    expect(policy).toContain("学習データとして持っている背景知識");
    expect(flat).toContain("training data");
    expect(policy).toContain("事実検証は、人手でも自動でも行っていません");
    expect(flat).toContain("not fact-checked against the original");
  });

  it("does not claim advertising waits for consent while consent is not required", () => {
    expect(ADVERTISING_REQUIRES_CONSENT).toBe(false);
    const privacy = read("web/src/pages/privacy.astro");
    const about = read("web/src/pages/about.astro");
    expect(privacy).not.toContain(
      "do not load optional advertising until you explicitly allow it",
    );
    expect(privacy).not.toContain("Off by default");
    expect(privacy).not.toContain("初期OFF");
    expect(privacy).not.toContain("Change choices");
    expect(about).not.toContain("利用者が明示的に許可した場合だけ");
    expect(about).not.toContain("only after explicit consent");
  });

  it("discloses personalised advertising, EEA/UK consent, and US state rights", () => {
    const privacy = read("web/src/pages/privacy.astro");
    expect(privacy).toContain('id="personalised-ads"');
    expect(privacy).toContain('id="eea-uk"');
    expect(privacy).toContain('id="us-states"');
    expect(privacy).toContain("https://www.google.com/settings/ads");
    expect(privacy).toContain("https://www.aboutads.info/choices/");
    expect(privacy).toContain("https://policies.google.com/technologies/ads");
    expect(privacy).toContain("CCPA");
    expect(privacy).toContain("UK GDPR");
  });

  it("keeps Japanese prose free of latin words welded onto kana or kanji", () => {
    // Proves the guard actually fires before it is used as a not-match.
    expect(MIXED_LANGUAGE_RE.test("アクセス解析providerを追加")).toBe(true);
    expect(MIXED_LANGUAGE_RE.test("通常の配信requestとして")).toBe(true);
    expect(MIXED_LANGUAGE_RE.test("Cloudflare のポリシーに従います")).toBe(false);
    expect(MIXED_LANGUAGE_RE.test("localStorage に保存します")).toBe(false);
    expect(MIXED_LANGUAGE_RE.test("HttpOnly、Secure、SameSite=Lax の Cookie")).toBe(false);

    for (const path of [
      "web/src/pages/privacy.astro",
      "web/src/pages/contact.astro",
    ]) {
      const spans = japaneseProse(read(path));
      expect(spans.length, `${path} has no Japanese spans to check`).toBeGreaterThan(0);
      for (const span of spans) {
        const match = MIXED_LANGUAGE_RE.exec(span);
        expect(match?.[0], `${path} mixes languages in: ${span.trim()}`).toBeUndefined();
      }
    }
  });
});
