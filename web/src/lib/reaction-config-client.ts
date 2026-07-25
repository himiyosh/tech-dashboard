import type {
  ReactionConfigCheckResult,
  ReactionConfigFlags,
} from "./reaction-config-health.ts";

/**
 * Same-origin, read-only runtime endpoint that reports the anonymous reaction
 * feature's boolean-only configuration health. See web/functions/api/reactions/config.ts.
 */
export const REACTION_CONFIG_ENDPOINT = "/api/reactions/config";

const REACTION_CONFIG_FETCH_TIMEOUT_MS = 6_000;

function isReactionConfigFlags(value: unknown): value is ReactionConfigFlags {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.databaseBinding === "boolean" &&
    typeof record.hmacSecret === "boolean" &&
    typeof record.turnstileSecret === "boolean" &&
    typeof record.publicSiteKey === "boolean"
  );
}

/**
 * Fetches the reaction config health snapshot with a bounded timeout. Never throws:
 * any network failure, non-2xx response, malformed JSON, or payload shape mismatch
 * resolves to `{ state: "unavailable" }` so callers can distinguish "checked and
 * found nothing configured" from "could not check at all" without try/catch.
 */
export async function fetchReactionConfigStatus(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REACTION_CONFIG_FETCH_TIMEOUT_MS,
): Promise<ReactionConfigCheckResult> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REACTION_CONFIG_ENDPOINT, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { state: "unavailable" };
    const payload: unknown = await response.json().catch(() => undefined);
    if (!payload || typeof payload !== "object") return { state: "unavailable" };
    const config = (payload as Record<string, unknown>).config;
    if (!isReactionConfigFlags(config)) return { state: "unavailable" };
    // Only the four known boolean flags are kept; any extra field on the response
    // (such as the server's own `configured` aggregate) is intentionally discarded
    // so the client always recomputes the aggregate itself from these flags.
    return {
      state: "resolved",
      flags: {
        databaseBinding: config.databaseBinding,
        hmacSecret: config.hmacSecret,
        turnstileSecret: config.turnstileSecret,
        publicSiteKey: config.publicSiteKey,
      },
    };
  } catch {
    return { state: "unavailable" };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
