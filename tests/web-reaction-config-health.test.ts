import { describe, expect, it } from "vitest";
import {
  REACTION_CONFIG_FLAG_ORDER,
  deriveReactionConfigDisplay,
  isReactionFullyConfigured,
  reactionConfigMissingKeys,
  type ReactionConfigFlags,
} from "../web/src/lib/reaction-config-health.ts";

const fullyConfigured: ReactionConfigFlags = {
  databaseBinding: true,
  hmacSecret: true,
  turnstileSecret: true,
  publicSiteKey: true,
};

describe("reaction config health display", () => {
  it("shows a neutral checking state before the fetch settles", () => {
    const display = deriveReactionConfigDisplay({ state: "checking" });
    expect(display.state).toBe("checking");
    expect(display.tone).toBe("neutral");
    expect(display.labelEn).toBe("Checking");
    expect(display.missingKeys).toEqual([]);
  });

  it("distinguishes endpoint unavailable from a known not-configured snapshot", () => {
    const unavailable = deriveReactionConfigDisplay({ state: "unavailable" });
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.tone).toBe("neutral");
    expect(unavailable.labelEn).not.toBe("Not configured");

    const notConfigured = deriveReactionConfigDisplay({
      state: "resolved",
      flags: { ...fullyConfigured, databaseBinding: false },
    });
    expect(notConfigured.state).toBe("not-configured");
    expect(notConfigured.tone).toBe("neutral");
    expect(notConfigured.labelEn).toBe("Not configured");
    expect(unavailable.labelEn).not.toBe(notConfigured.labelEn);
  });

  it("shows an ok tone only for a fully resolved, fully-true snapshot", () => {
    const display = deriveReactionConfigDisplay({
      state: "resolved",
      flags: fullyConfigured,
    });
    expect(display.state).toBe("configured");
    expect(display.tone).toBe("ok");
    expect(display.missingKeys).toEqual([]);
  });

  it("never shows warn/err tones — absence is neutral, not an incident", () => {
    const states = [
      { state: "checking" as const },
      { state: "unavailable" as const },
      { state: "resolved" as const, flags: { ...fullyConfigured, hmacSecret: false } },
      { state: "resolved" as const, flags: fullyConfigured },
    ];
    for (const result of states) {
      const display = deriveReactionConfigDisplay(result);
      expect(["ok", "neutral"]).toContain(display.tone);
    }
  });

  it("lists each missing flag independently, in a stable order", () => {
    const display = deriveReactionConfigDisplay({
      state: "resolved",
      flags: {
        databaseBinding: true,
        hmacSecret: false,
        turnstileSecret: false,
        publicSiteKey: true,
      },
    });
    expect(display.missingKeys).toEqual(["hmacSecret", "turnstileSecret"]);
    // The public detail copy no longer names secrets (site audit): the
    // machine-readable missingKeys keep the per-flag state for operators.
    expect(display.detailJa).toBe("匿名いいねは現在利用できません。");
    expect(display.detailJa).not.toContain("識別子署名用シークレット");
    expect(display.detailEn).not.toContain("Identity signing secret");
  });

  it("REACTION_CONFIG_FLAG_ORDER covers every ReactionConfigFlags key exactly once", () => {
    expect(REACTION_CONFIG_FLAG_ORDER).toEqual([
      "databaseBinding",
      "hmacSecret",
      "turnstileSecret",
      "publicSiteKey",
    ]);
    expect(new Set(REACTION_CONFIG_FLAG_ORDER).size).toBe(REACTION_CONFIG_FLAG_ORDER.length);
  });

  it("isReactionFullyConfigured / reactionConfigMissingKeys agree on the same flags", () => {
    expect(isReactionFullyConfigured(fullyConfigured)).toBe(true);
    expect(reactionConfigMissingKeys(fullyConfigured)).toEqual([]);

    const partial = { ...fullyConfigured, turnstileSecret: false };
    expect(isReactionFullyConfigured(partial)).toBe(false);
    expect(reactionConfigMissingKeys(partial)).toEqual(["turnstileSecret"]);
  });
});
