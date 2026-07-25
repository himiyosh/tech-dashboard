export const SITE_URL = "https://techdb.studio344.net";
/** Public health endpoint of the harness worker — no secrets, safe for browser fetch. */
export const WORKER_HEALTH_URL = "https://tech-dashboard-harness.himiyosh.workers.dev/health";
/** Public source repository — used for the "report an issue" path on About/Status. */
export const REPO_URL = "https://github.com/himiyosh/tech-dashboard";
/** Pre-filtered "new issue" link so a reader can report a problem without hunting for the repo. */
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;
