/**
 * tests/worker-body.test.ts
 *
 * Body-file Phase B (LL-115) unit tests for the body cache helpers and the
 * two-call plain-text body prompts. Cloudflare-runtime-free modules only.
 */
import { describe, it, expect } from "vitest";
import {
  bodyCacheEntryMatchesPublisherContract,
  bodyCacheKeyForUrl,
  isBodyComplete,
  type BodyCacheEntry,
} from "../worker/src/body-cache.ts";
import { UNVERSIONED_JOB_FINGERPRINT } from "../worker/src/kv-cache.ts";
import {
  buildBodyPromptJa,
  buildBodyPromptEn,
  cleanBodyText,
  type BodyPromptEntry,
} from "../worker/src/body-generate.ts";
import { buildBodyCacheEntry } from "../worker-body/src/index.ts";

const entry: BodyPromptEntry = {
  title: "GLM-5.2 on Cloudflare Workers AI",
  titleJa: "Cloudflare Workers AI で GLM-5.2 を試す",
  titleEn: "Trying GLM-5.2 on Cloudflare Workers AI",
  category: "local-llm",
  source: "qiita-llm",
  sourceType: "community",
  url: "https://example.com/glm-5-2",
  summaryJa: "Cloudflare Workers AI で GLM-5.2 を無料で試す手順を解説する。",
  summaryEn: "A walkthrough of running GLM-5.2 for free on Cloudflare Workers AI.",
  tags: ["llm", "cloudflare", "glm"],
  publishedAt: "2026-06-27T10:00:00.000Z",
};

describe("bodyCacheKeyForUrl (LL-115)", () => {
  it("b: プレフィックスの sha256 キーを返す", async () => {
    const key = await bodyCacheKeyForUrl("https://example.com/x");
    expect(key.startsWith("b:")).toBe(true);
    expect(key.length).toBe(66); // "b:" + 64 hex chars
  });

  it("同じ URL は決定的に同じキー、別 URL は別キー", async () => {
    const a1 = await bodyCacheKeyForUrl("https://example.com/a");
    const a2 = await bodyCacheKeyForUrl("https://example.com/a");
    const b = await bodyCacheKeyForUrl("https://example.com/b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("summary の s: キーと衝突しない", async () => {
    const key = await bodyCacheKeyForUrl("https://example.com/x");
    expect(key.startsWith("s:")).toBe(false);
  });
});

describe("isBodyComplete (LL-115)", () => {
  const base: BodyCacheEntry = { bodyJa: "あ".repeat(200), bodyEn: "a".repeat(200), model: "claude-opus-4.8", cachedAt: "" };
  it("両言語に本文があれば true", () => {
    expect(isBodyComplete(base)).toBe(true);
  });

  describe("body consumer cache provenance", () => {
    it("copies the publisher contract fingerprint from the job", () => {
      const fingerprint = `sha256:${"f".repeat(64)}`;
      const cacheEntry = buildBodyCacheEntry(
        {
          url: entry.url,
          publisherContractFingerprint: fingerprint,
          entry: { ...entry, id: "entry-1" },
        },
        "あ".repeat(200),
        "a".repeat(200),
        "claude-opus-4.8",
        "2026-07-13T00:00:00.000Z",
      );

      expect(cacheEntry.publisherContractFingerprint).toBe(fingerprint);
    });

    it("marks jobs from an unversioned producer as explicitly incompatible", () => {
      const cacheEntry = buildBodyCacheEntry(
        {
          url: entry.url,
          entry: { ...entry, id: "entry-1" },
        },
        "あ".repeat(200),
        "a".repeat(200),
        "claude-opus-4.8",
        "2026-07-13T00:00:00.000Z",
      );

      expect(cacheEntry.publisherContractFingerprint).toBe(
        UNVERSIONED_JOB_FINGERPRINT,
      );
    });
  });

  describe("body publisher contract compatibility", () => {
    const current = `sha256:${"d".repeat(64)}`;
    const previous = `sha256:${"e".repeat(64)}`;
    const base: BodyCacheEntry = {
      bodyJa: "あ".repeat(200),
      bodyEn: "a".repeat(200),
      model: "claude-opus-4.8",
      cachedAt: "",
    };

    it("accepts legacy and current entries but rejects explicit mismatches", () => {
      expect(bodyCacheEntryMatchesPublisherContract(base, current)).toBe(true);
      expect(
        bodyCacheEntryMatchesPublisherContract(
          { ...base, publisherContractFingerprint: current },
          current,
        ),
      ).toBe(true);
      expect(
        bodyCacheEntryMatchesPublisherContract(
          { ...base, publisherContractFingerprint: previous },
          current,
        ),
      ).toBe(false);
    });
  });
  it("片方が空なら false", () => {
    expect(isBodyComplete({ ...base, bodyEn: "" })).toBe(false);
    expect(isBodyComplete({ ...base, bodyJa: "  " })).toBe(false);
  });
  it("null / undefined は false", () => {
    expect(isBodyComplete(null)).toBe(false);
    expect(isBodyComplete(undefined)).toBe(false);
  });
});

describe("buildBodyPromptJa / buildBodyPromptEn (LL-115)", () => {
  it("JA プロンプトは日本語本文・文字数・プレーンテキスト要件を含む", () => {
    const p = buildBodyPromptJa(entry);
    expect(p).toContain("日本語の本文記事");
    expect(p).toContain("700〜1100 文字");
    expect(p).toContain("Markdown 見出し");
    // context が入っている
    expect(p).toContain("local-llm");
    expect(p).toContain("GLM-5.2");
  });

  it("EN プロンプトは英語本文・語数・plain text 要件を含む", () => {
    const p = buildBodyPromptEn(entry);
    expect(p).toContain("English article body");
    expect(p).toContain("500-800 words");
    expect(p).toContain("Plain text only");
    expect(p).toContain("local-llm");
  });

  it("fallback boilerplate の summary は context に含めない", () => {
    const fb: BodyPromptEntry = {
      ...entry,
      summaryJa: "このエントリは qiita-llm から収集した local-llm 領域の最新アップデートです。",
      summaryEn: "local-llm update from qiita-llm. AI summary not yet available; a future Worker run will refresh.",
    };
    const p = buildBodyPromptJa(fb);
    expect(p).not.toContain("このエントリは qiita-llm");
    expect(p).not.toContain("AI summary not yet available");
  });
});

describe("cleanBodyText (LL-115)", () => {
  it("コードフェンスを除去する", () => {
    expect(cleanBodyText("```\n本文です。\n```")).toBe("本文です。");
    expect(cleanBodyText("```markdown\nHello body.\n```")).toBe("Hello body.");
  });
  it("先頭の メタラベル を除去する", () => {
    expect(cleanBodyText("本文: これが本文。")).toBe("これが本文。");
    expect(cleanBodyText("Body: the article body.")).toBe("the article body.");
  });
  it("通常テキストはそのまま (trim のみ)", () => {
    expect(cleanBodyText("  普通の本文。  ")).toBe("普通の本文。");
  });
});
