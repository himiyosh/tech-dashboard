export const SITE_URL = "https://techdb.studio344.net";
export const ADSENSE_CLIENT_ID = "ca-pub-3044810068333301";
export const PUBLIC_OPERATOR_NAME = "Studio344";
export const PRIVACY_JURISDICTION = "Japan";
export const PRIVACY_LAST_UPDATED = "2026-08-27";
/** Public health endpoint of the harness worker — no secrets, safe for browser fetch. */
export const WORKER_HEALTH_URL = "https://tech-dashboard-harness.himiyosh.workers.dev/health";
/** Public source repository — used for the "report an issue" path on About/Status. */
export const REPO_URL = "https://github.com/himiyosh/tech-dashboard";
/** Pre-filtered "new issue" link so a reader can report a problem without hunting for the repo. */
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/**
 * The only mail domain a published role address may use: the site's own host.
 * Keeping the allowed domain in code (and pinned by tests/web-contact.test.ts)
 * makes it structurally impossible to publish a free-provider personal mailbox.
 */
export const CONTACT_EMAIL_DOMAIN = new URL(SITE_URL).hostname;

/**
 * Public role mailbox for reader, rights-holder, and privacy contact.
 *
 * INTENTIONALLY EMPTY until the operator creates a role address on
 * CONTACT_EMAIL_DOMAIN (for example a `contact@` mailbox). Two hard rules:
 *
 *   1. The operator's personal address is never published on this site.
 *   2. Never fill this with a stand-in that merely LOOKS like an address
 *      (`example@`, `todo@`, `noreply@`, …). Mail sent to a non-existent
 *      mailbox disappears silently, which is worse for a reader than an
 *      honest "there is no email channel yet".
 *
 * While the value is empty, /contact renders a visible "no email channel yet"
 * notice and routes every request to GitHub Issues. Setting a real address
 * makes the email row appear automatically — no other edit is required.
 * tests/web-contact.test.ts fails the build when the value is non-empty and is
 * not a plain address on CONTACT_EMAIL_DOMAIN, or is a known placeholder local
 * part. The explicit `: string` annotation keeps both branches of the
 * `hasContactEmail` check live for the type checker.
 */
export const PUBLIC_CONTACT_EMAIL: string = "";
