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
  isGroundedBodyCacheEntry,
  type BodyCacheEntry,
} from "../worker/src/body-cache.ts";
import { UNVERSIONED_JOB_FINGERPRINT } from "../worker/src/kv-cache.ts";
import {
  buildBodyPromptJa,
  buildBodyPromptEn,
  cleanBodyText,
  type BodyPromptEntry,
} from "../worker/src/body-generate.ts";
import bodyWorker, {
  buildBodyCacheEntry,
  classifyBodyIssueScope,
  isBodyEntryComplete,
} from "../worker-body/src/index.ts";

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
  contentSnippet:
    "The source gives a step-by-step walkthrough for running GLM-5.2 on Cloudflare Workers AI, including setup and cost constraints.",
  tags: ["llm", "cloudflare", "glm"],
  publishedAt: "2026-06-27T10:00:00.000Z",
};

function mockIssueKv(issue: Record<string, unknown> | null): KVNamespace {
  return {
    get: async (_key: string, type?: string) =>
      type === "json" ? issue : issue === null ? null : JSON.stringify(issue),
  } as unknown as KVNamespace;
}

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

  it("rejects a structurally complete body that contradicts material source facts", () => {
    const source = {
      title: "Cursor Start",
      contentSnippet:
        "Cursor Start is a new ₹649 monthly plan for developers in India with local pricing and UPI.",
    };
    expect(isGroundedBodyCacheEntry(source, {
      bodyJa: "Cursor Startはプロジェクト初期化を支援する新機能である。",
      bodyEn: "Cursor Start is a project initialization and onboarding feature.",
      model: "claude-opus-4.8",
      cachedAt: "2026-07-29T00:00:00.000Z",
    })).toBe(false);
    expect(isBodyEntryComplete(
      {
        bodyJa: "Cursor Startはプロジェクト初期化を支援する新機能である。".repeat(5),
        bodyEn: "Cursor Start is a project initialization and onboarding feature. ".repeat(4),
      },
      source,
    )).toBe(false);
  });
});

describe("body consumer health issue scope", () => {
  it("classifies content failures separately from runtime failures", () => {
    expect(classifyBodyIssueScope(new Error("empty/short body (0 chars)"))).toBe("entry");
    expect(classifyBodyIssueScope(new Error("incomplete or ungrounded body for https://example.com/x"))).toBe("entry");
    expect(classifyBodyIssueScope(new Error("insufficient source grounding for https://example.com/x"))).toBe("entry");
    expect(classifyBodyIssueScope(new Error("Copilot timeout"))).toBe("runtime");
  });

  it("keeps a repeated entry-specific failure visible without failing global health", async () => {
    const response = await bodyWorker.fetch!(
      new Request("https://tech-dashboard-body.example/health"),
      {
        SUMMARY_CACHE: mockIssueKv({
          status: "retry",
          at: new Date().toISOString(),
          url: "https://example.com/pathological-entry",
          repeatCount: 3,
          error: "Error: empty/short body (0 chars)",
        }),
        COPILOT_PAT: "configured",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      recentIssue: true,
      issueSeverity: "warn",
      issueScope: "entry",
    });
  });

  it("returns 503 for a repeated runtime failure", async () => {
    const response = await bodyWorker.fetch!(
      new Request("https://tech-dashboard-body.example/health"),
      {
        SUMMARY_CACHE: mockIssueKv({
          status: "retry",
          scope: "runtime",
          at: new Date().toISOString(),
          url: "https://example.com/runtime-failure",
          repeatCount: 3,
          error: "Error: Copilot timeout",
        }),
        COPILOT_PAT: "configured",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      issueSeverity: "error",
      issueScope: "runtime",
    });
  });

  it("fails closed with structured health when the cache binding is missing", async () => {
    const response = await bodyWorker.fetch!(
      new Request("https://tech-dashboard-body.example/health"),
      {
        SUMMARY_CACHE: undefined as unknown as KVNamespace,
        COPILOT_PAT: "configured",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      cacheBinding: false,
    });
  });
});

describe("buildBodyPromptJa / buildBodyPromptEn (LL-115)", () => {
  it("JA プロンプトは日本語本文・文字数・セクション見出し契約を含む", () => {
    const p = buildBodyPromptJa(entry);
    expect(p).toContain("日本語の本文記事");
    expect(p).toContain("700〜1100 文字");
    // セクション見出しは「## 」行のみ許可し、他の Markdown は禁止のまま。
    expect(p).toContain("「## 」で始まる");
    expect(p).toContain("3〜5 個のセクション");
    expect(p).toContain("リスト記号 (- , *) や他の Markdown 記法");
    // context が入っている
    expect(p).toContain("local-llm");
    expect(p).toContain("GLM-5.2");
    expect(p).toContain("Source excerpt");
  });

  it("EN プロンプトは英語本文・語数・セクション見出し契約を含む", () => {
    const p = buildBodyPromptEn(entry);
    expect(p).toContain("English article body");
    expect(p).toContain("500-800 words");
    expect(p).toContain('beginning with "## "');
    expect(p).toContain("3-5 sections");
    expect(p).toContain("plain text only");
    expect(p).toContain("local-llm");
    expect(p).toContain("Source excerpt");
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
