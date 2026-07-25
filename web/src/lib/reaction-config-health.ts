/**
 * Pure display derivation for the anonymous reaction feature's runtime configuration
 * health, shown on Status. Mirrors the run-health.ts / queue-health.ts pattern: a
 * single deterministic function that turns a check result into UI-ready copy and a
 * tone, so the Status page and its tests share one source of truth.
 *
 * Tone is deliberately limited to "ok" | "neutral" — this feature degrades safely when
 * unconfigured, so an incomplete or unreachable check is never shown as a warning or
 * an error. Only a fully resolved, fully-true snapshot is "ok".
 */

export interface ReactionConfigFlags {
  databaseBinding: boolean;
  hmacSecret: boolean;
  turnstileSecret: boolean;
  publicSiteKey: boolean;
}

export type ReactionConfigFlagKey = keyof ReactionConfigFlags;

export const REACTION_CONFIG_FLAG_ORDER: readonly ReactionConfigFlagKey[] = [
  "databaseBinding",
  "hmacSecret",
  "turnstileSecret",
  "publicSiteKey",
];

export const REACTION_CONFIG_FLAG_LABELS: Record<
  ReactionConfigFlagKey,
  { ja: string; en: string }
> = {
  databaseBinding: { ja: "D1 データベース", en: "D1 database" },
  hmacSecret: { ja: "識別子署名用シークレット", en: "Identity signing secret" },
  turnstileSecret: { ja: "Turnstile 検証シークレット", en: "Turnstile verification secret" },
  publicSiteKey: { ja: "Turnstile 公開サイトキー", en: "Turnstile public site key" },
};

/**
 * Outcome of attempting to reach the runtime config-health endpoint.
 * - "checking": the fetch has not settled yet (initial SSR / in-flight state).
 * - "unavailable": the endpoint could not be reached or returned an unusable payload —
 *   distinct from a successfully-observed "not configured" snapshot.
 * - "resolved": the endpoint responded with a well-formed boolean snapshot.
 */
export type ReactionConfigCheckResult =
  | { state: "checking" }
  | { state: "unavailable" }
  | { state: "resolved"; flags: ReactionConfigFlags };

export type ReactionConfigDisplayState =
  | "checking"
  | "unavailable"
  | "configured"
  | "not-configured";

export type ReactionConfigTone = "ok" | "neutral";

export interface ReactionConfigDisplay {
  state: ReactionConfigDisplayState;
  tone: ReactionConfigTone;
  labelJa: string;
  labelEn: string;
  detailJa: string;
  detailEn: string;
  missingKeys: ReactionConfigFlagKey[];
}

export function isReactionFullyConfigured(flags: ReactionConfigFlags): boolean {
  return REACTION_CONFIG_FLAG_ORDER.every((key) => flags[key]);
}

export function reactionConfigMissingKeys(
  flags: ReactionConfigFlags,
): ReactionConfigFlagKey[] {
  return REACTION_CONFIG_FLAG_ORDER.filter((key) => !flags[key]);
}

export function deriveReactionConfigDisplay(
  result: ReactionConfigCheckResult,
): ReactionConfigDisplay {
  if (result.state === "checking") {
    return {
      state: "checking",
      tone: "neutral",
      labelJa: "確認中",
      labelEn: "Checking",
      detailJa: "匿名いいねの設定状態を確認しています。",
      detailEn: "Checking the anonymous reaction configuration.",
      missingKeys: [],
    };
  }

  if (result.state === "unavailable") {
    return {
      state: "unavailable",
      tone: "neutral",
      labelJa: "確認できません",
      labelEn: "Check unavailable",
      detailJa:
        "設定状態を確認できませんでした。ネットワークまたは一時的な問題の可能性があり、未設定であることを意味しません。",
      detailEn:
        "The configuration check did not complete. This may be a network or temporary issue, not confirmation that it is unconfigured.",
      missingKeys: [],
    };
  }

  const missingKeys = reactionConfigMissingKeys(result.flags);
  if (missingKeys.length === 0) {
    return {
      state: "configured",
      tone: "ok",
      labelJa: "設定済み",
      labelEn: "Configured",
      detailJa: "匿名いいねに必要な設定がすべて揃っています。",
      detailEn: "All required anonymous reaction configuration is present.",
      missingKeys: [],
    };
  }

  const missingJa = missingKeys
    .map((key) => REACTION_CONFIG_FLAG_LABELS[key].ja)
    .join("・");
  const missingEn = missingKeys
    .map((key) => REACTION_CONFIG_FLAG_LABELS[key].en)
    .join(", ");
  return {
    state: "not-configured",
    tone: "neutral",
    labelJa: "未設定",
    labelEn: "Not configured",
    detailJa: `匿名いいねは現在利用できません。未設定: ${missingJa}。`,
    detailEn: `Anonymous reactions are not available yet. Missing: ${missingEn}.`,
    missingKeys,
  };
}
