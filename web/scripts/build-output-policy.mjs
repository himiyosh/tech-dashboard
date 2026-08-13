export const CLOUDFLARE_FREE_STATIC_FILE_LIMIT = 20_000;
export const STATIC_FILE_SAFETY_MARGIN = 2_000;
export const MAX_STATIC_FILES =
  CLOUDFLARE_FREE_STATIC_FILE_LIMIT - STATIC_FILE_SAFETY_MARGIN;

export const CLOUDFLARE_BUILD_LIMIT_SECONDS = 20 * 60;
export const BUILD_TIME_SAFETY_MARGIN_SECONDS = 2 * 60;
export const MAX_BUILD_SECONDS =
  CLOUDFLARE_BUILD_LIMIT_SECONDS - BUILD_TIME_SAFETY_MARGIN_SECONDS;

export function buildOutputBudgetFailures({ files, elapsedSeconds }) {
  const failures = [];
  if (!Number.isInteger(files) || files < 0) {
    failures.push(`static file count is invalid: ${String(files)}`);
  } else if (files > MAX_STATIC_FILES) {
    failures.push(
      `static file budget exceeded: ${files} > ${MAX_STATIC_FILES} `
        + `(Cloudflare Free limit ${CLOUDFLARE_FREE_STATIC_FILE_LIMIT}, `
        + `safety margin ${STATIC_FILE_SAFETY_MARGIN})`,
    );
  }

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    failures.push(`build elapsed time is invalid: ${String(elapsedSeconds)}`);
  } else if (elapsedSeconds > MAX_BUILD_SECONDS) {
    failures.push(
      `build time budget exceeded: ${Math.round(elapsedSeconds)}s > `
        + `${MAX_BUILD_SECONDS}s (Cloudflare build ceiling `
        + `${CLOUDFLARE_BUILD_LIMIT_SECONDS}s, safety margin `
        + `${BUILD_TIME_SAFETY_MARGIN_SECONDS}s)`,
    );
  }
  return failures;
}
