/**
 * tests/data-schema.test.ts
 *
 * data/index.json の整合性を実データに対して検証する。
 * 新エントリ追加・worker 改修で形が崩れないか早期検知する。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import indexJson from "../data/index.json";
import statsJson from "../data/stats.json";
import { restampEntryFromSource } from "../harness/pipeline/normalize.ts";
import {
  evaluateKeywordFilter,
  keywordFilterEntryFromNormalized,
} from "../harness/pipeline/source-filter.ts";
import { isContaminatedSummaryText } from "../harness/pipeline/summary-quality.ts";
import { normalizeTag } from "../harness/pipeline/tag.ts";
import { hasKnownProductBodyConflict } from "../harness/pipeline/product-name.ts";
import { canonicalUrlKey } from "../harness/pipeline/url.ts";
import {
  buildStatsPayloadFromArtifacts,
  STATS_BUCKET_TIME_ZONE,
} from "../harness/publishers/stats-core.ts";
import { REGISTRY } from "../harness/registry.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  DEFAULT_BODY_RETENTION_DAYS,
  isBodyRetentionEligible,
  needsBody,
} from "../worker/src/body-queue.ts";

interface RawEntry {
  id?: unknown;
  source?: unknown;
  sourceType?: unknown;
  url?: unknown;
  title?: unknown;
  titleJa?: unknown;
  titleEn?: unknown;
  summaryJa?: unknown;
  summaryEn?: unknown;
  contentSnippet?: unknown;
  publishedAt?: unknown;
  collectedAt?: unknown;
  tags?: unknown;
  category?: unknown;
  importance?: unknown;
  bodyJa?: unknown;
  bodyEn?: unknown;
  archiveTier?: unknown;
  halfLife?: unknown;
  evergreen?: unknown;
}

interface IndexShape {
  generatedAt: string;
  count: number;
  entries: RawEntry[];
  health?: {
    bodiesTotal?: number;
    bodyEnqueueCap?: number;
    bodyBacklog?: number;
    bodyQueueDrainEstimateHours?: number;
    bodyRetentionEligible?: number;
  };
}

interface StatsBucket {
  date?: string;
  month?: string;
  count: number;
  byCategory?: Record<string, number>;
}

interface StatsShape {
  generatedAt: string;
  bucketTimeZone: string;
  totals: {
    allTime: number;
    last30d: number;
    last7d: number;
    last24h: number;
  };
  byDay: StatsBucket[];
  byMonth: StatsBucket[];
  bySource: Array<{ source: string; total: number; last30d: number }>;
  byImportance: Record<"1" | "2" | "3", number>;
}

const VALID_SOURCE_TYPES = new Set([
  "blog",
  "release",
  "changelog",
  "paper",
  "community",
]);

const VALID_CATEGORIES = new Set([
  "copilot",
  "claude",
  "codex",
  "gemini",
  "vscode",
  "cursor",
  "cline",
  "aider",
  "opencode",
  "local-llm",
  "agent-fw",
  "mcp",
  "research",
  "tech-news",
]);

const data = indexJson as unknown as IndexShape;
const stats = statsJson as unknown as StatsShape;
const archiveIndexPath = join(process.cwd(), "data", "archive", "_index.json");
const archiveIndex = existsSync(archiveIndexPath)
  ? (JSON.parse(readFileSync(archiveIndexPath, "utf8")) as { generatedAt?: string })
  : null;
const archiveDir = join(process.cwd(), "data", "archive");
const archiveEntries = existsSync(archiveDir)
  ? readdirSync(archiveDir)
    .filter((fileName) => /^\d{4}-\d{2}\.json$/.test(fileName))
    .flatMap((fileName) => {
      const parsed = JSON.parse(readFileSync(join(archiveDir, fileName), "utf8")) as { entries?: RawEntry[] };
      return (parsed.entries ?? []).map((entry) => ({ ...entry, archiveFile: fileName }));
    })
  : [];
const allDataEntries = [...data.entries, ...archiveEntries];

function asNormalizedEntry(entry: RawEntry): NormalizedEntry {
  return {
    id: String(entry.id ?? ""),
    source: String(entry.source ?? ""),
    sourceType: (String(entry.sourceType ?? "blog")) as NormalizedEntry["sourceType"],
    url: String(entry.url ?? ""),
    title: String(entry.title ?? ""),
    titleJa: String(entry.titleJa ?? ""),
    titleEn: String(entry.titleEn ?? ""),
    summaryJa: String(entry.summaryJa ?? ""),
    summaryEn: String(entry.summaryEn ?? ""),
    ...(typeof entry.contentSnippet === "string" && entry.contentSnippet
      ? { contentSnippet: entry.contentSnippet }
      : {}),
    ...(typeof entry.bodyJa === "string" ? { bodyJa: entry.bodyJa } : {}),
    ...(typeof entry.bodyEn === "string" ? { bodyEn: entry.bodyEn } : {}),
    lang: "en",
    publishedAt: typeof entry.publishedAt === "string" ? entry.publishedAt : null,
    collectedAt: typeof entry.collectedAt === "string" ? entry.collectedAt : data.generatedAt,
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    category: String(entry.category ?? "tech-news") as NormalizedEntry["category"],
    importance: Number(entry.importance ?? 1) as NormalizedEntry["importance"],
    ...(typeof entry.archiveTier === "string"
      ? { archiveTier: entry.archiveTier as NormalizedEntry["archiveTier"] }
      : {}),
    ...(typeof entry.halfLife === "string"
      ? { halfLife: entry.halfLife as NormalizedEntry["halfLife"] }
      : {}),
    ...(entry.evergreen === true ? { evergreen: true } : {}),
  };
}
const DATA_BUDGET = {
  indexBytes: 8_000_000,
  statsBytes: 500_000,
  archiveMonthBytes: 6_000_000,
};
const STALE_DATA_MAX_AGE_HOURS = 36;
const ARTIFACT_TIMESTAMP_SKEW_HOURS = 6;

describe("data/index.json トップレベル", () => {
  it("generatedAt が ISO 8601 文字列である", () => {
    expect(typeof data.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(data.generatedAt))).toBe(true);
  });

  it("generatedAt が古すぎない", () => {
    if (process.env.ALLOW_STALE_DATA === "1") return;
    const ageHours = (Date.now() - Date.parse(data.generatedAt)) / 3_600_000;
    expect(ageHours).toBeLessThanOrEqual(STALE_DATA_MAX_AGE_HOURS);
  });

  it("data artifact の generatedAt が大きく乖離していない", () => {
    const timestamps = [
      ["index", data.generatedAt],
      ["stats", stats.generatedAt],
      ["archive-index", archiveIndex?.generatedAt],
    ].filter((item): item is [string, string] => typeof item[1] === "string");
    const parsed = timestamps.map(([name, iso]) => [name, Date.parse(iso)] as const);
    for (const [name, ms] of parsed) {
      expect(Number.isFinite(ms), `${name} generatedAt should parse`).toBe(true);
    }
    const values = parsed.map(([, ms]) => ms);
    const skewHours = (Math.max(...values) - Math.min(...values)) / 3_600_000;
    expect(skewHours).toBeLessThanOrEqual(ARTIFACT_TIMESTAMP_SKEW_HOURS);
  });

  it("count が entries.length と一致する", () => {
    expect(data.count).toBe(data.entries.length);
  });

  it("entries が 1 件以上ある", () => {
    expect(data.entries.length).toBeGreaterThan(0);
  });

  it("entries の id は重複しない", () => {
    const ids = data.entries.map((e) => String(e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("data/index.json 各エントリ", () => {
  it("必須フィールドが全エントリに存在する", () => {
    const errors: string[] = [];
    for (const e of data.entries) {
      if (typeof e.id !== "string" || !e.id) errors.push(`id missing: ${JSON.stringify(e).slice(0, 80)}`);
      if (typeof e.source !== "string" || !e.source) errors.push(`source missing on ${e.id}`);
      if (typeof e.url !== "string" || !e.url) errors.push(`url missing on ${e.id}`);
      if (typeof e.title !== "string") errors.push(`title missing on ${e.id}`);
      if (typeof e.publishedAt !== "string") errors.push(`publishedAt missing on ${e.id}`);
      if (typeof e.collectedAt !== "string") errors.push(`collectedAt missing on ${e.id}`);
    }
    expect(errors).toEqual([]);
  });

  it("sourceType が有効な値である", () => {
    const invalid = data.entries
      .filter((e) => !VALID_SOURCE_TYPES.has(String(e.sourceType)))
      .map((e) => `${e.id}:${String(e.sourceType)}`);
    expect(invalid).toEqual([]);
  });

  it("category が有効な値である", () => {
    const invalid = data.entries
      .filter((e) => !VALID_CATEGORIES.has(String(e.category)))
      .map((e) => `${e.id}:${String(e.category)}`);
    expect(invalid).toEqual([]);
  });

  it("importance が 1〜3 の整数である", () => {
    const invalid = data.entries
      .filter((e) => !(e.importance === 1 || e.importance === 2 || e.importance === 3))
      .map((e) => `${e.id}:${String(e.importance)}`);
    expect(invalid).toEqual([]);
  });

  it("tags が文字列配列である", () => {
    const invalid = data.entries
      .filter((e) => !Array.isArray(e.tags) || (e.tags as unknown[]).some((t) => typeof t !== "string"))
      .map((e) => String(e.id));
    expect(invalid).toEqual([]);
  });

  it("live/archive tags use canonical aliases", () => {
    const invalid = allDataEntries.flatMap((entry) =>
      (Array.isArray(entry.tags) ? entry.tags : [])
        .filter((tag): tag is string => typeof tag === "string" && normalizeTag(tag) !== tag)
        .map((tag) => `${String(entry.id)}:${tag}->${normalizeTag(tag)}`),
    );

    expect(invalid).toEqual([]);
  });

  it("live/archive entries do not contain Unicode replacement characters", () => {
    const invalid = allDataEntries
      .filter((entry) => JSON.stringify(entry).includes("\uFFFD"))
      .map((entry) => `${String(entry.id)}:${String(entry.archiveFile ?? "live")}`);

    expect(invalid).toEqual([]);
  });

  it("matching live/archive entries have the same tags", () => {
    const liveTagsById = new Map(
      data.entries.map((entry) => [
        String(entry.id),
        JSON.stringify(entry.tags ?? []),
      ]),
    );
    const liveTagsByCanonical = new Map(
      data.entries.map((entry) => [
        canonicalUrlKey(String(entry.url)),
        JSON.stringify(entry.tags ?? []),
      ]),
    );
    const mismatches = archiveEntries
      .map((entry) => ({
        entry,
        liveTags:
          liveTagsById.get(String(entry.id)) ??
          liveTagsByCanonical.get(canonicalUrlKey(String(entry.url))),
      }))
      .filter(
        (
          value,
        ): value is { entry: RawEntry & { archiveFile: string }; liveTags: string } =>
          typeof value.liveTags === "string",
      )
      .filter(
        ({ entry, liveTags }) =>
          liveTags !== JSON.stringify(entry.tags ?? []),
      )
      .map(
        ({ entry }) =>
          `${String(entry.id)}:${String(entry.archiveFile)}`,
      );

    expect(mismatches).toEqual([]);
  });

  it("publishedAt と collectedAt が ISO 8601 として解釈可能", () => {
    const bad = data.entries
      .filter(
        (e) =>
          !Number.isFinite(Date.parse(String(e.publishedAt))) ||
          !Number.isFinite(Date.parse(String(e.collectedAt))),
      )
      .map((e) => String(e.id));
    expect(bad).toEqual([]);
  });

  // LL-045: publishedAt === collectedAt は normalize の fallback で「収集時刻 = 公開日」と
  // 偽装された強い兆候。古い記事が日次グループ・TickerBar・DailySummary・stats.byDay の
  // 上位を汚染する原因になる。閾値超過で fail させて collector 側の date 取得バグを検知する。
  it("publishedAt === collectedAt の entry が閾値以下", () => {
    const suspicious = data.entries.filter(
      (e) =>
        typeof e.publishedAt === "string" &&
        typeof e.collectedAt === "string" &&
        Date.parse(String(e.publishedAt)) === Date.parse(String(e.collectedAt)),
    );
    const bySource: Record<string, number> = {};
    for (const e of suspicious) {
      const s = String((e as { source?: unknown }).source ?? "?");
      bySource[s] = (bySource[s] ?? 0) + 1;
    }
    // 5% を超えたら fail。1 source あたり 5 件超も fail。
    const ratio = suspicious.length / Math.max(1, data.entries.length);
    expect(ratio, `suspicious ratio too high: ${suspicious.length}/${data.entries.length} ${JSON.stringify(bySource)}`).toBeLessThan(0.05);
    const overflowing = Object.entries(bySource).filter(([, n]) => n > 5);
    expect(overflowing, `sources with > 5 suspicious entries: ${JSON.stringify(overflowing)}`).toEqual([]);
  });

  it("url が URL コンストラクタで解釈できる", () => {
    const bad: string[] = [];
    for (const e of data.entries) {
      try {
        new URL(String(e.url));
      } catch {
        bad.push(String(e.id));
      }
    }
    expect(bad).toEqual([]);
  });

  it("bodyJa / bodyEn が定義されているなら文字列である", () => {
    const bad = data.entries
      .filter(
        (e) =>
          (e.bodyJa !== undefined && typeof e.bodyJa !== "string") ||
          (e.bodyEn !== undefined && typeof e.bodyEn !== "string"),
      )
      .map((e) => String(e.id));
    expect(bad).toEqual([]);
  });

  it("Timeline と記事詳細用の summary が両言語で存在する", () => {
    // LL-028: deterministic fallback must populate BOTH summaryJa and
    // summaryEn so the JA / EN toggle never shows a cross-language fallback
    // badge on Worker-published entries.
    const bad = data.entries
      .filter((e) => !String(e.summaryJa ?? "").trim() || !String(e.summaryEn ?? "").trim())
      .map((e) => `${String(e.source)}:${String(e.title)}`);
    expect(bad).toEqual([]);
  });

  it("live summary に生成途中の contamination marker が残っていない", () => {
    const bad = data.entries
      .filter((entry) =>
        isContaminatedSummaryText(String(entry.summaryJa ?? "")) ||
        isContaminatedSummaryText(String(entry.summaryEn ?? "")),
      )
      .map((entry) => `${String(entry.id)}:${String(entry.source)}:${String(entry.title)}`);
    expect(bad).toEqual([]);
  });

  it("live index は本文を持たない (body-file architecture / LL-113)", () => {
    // Body-file architecture: the long-form body lives in data/bodies.json, NOT
    // in index.json. The index must stay body-free so it remains well under the
    // CI size budget (LL-112). This also catches a stale Worker re-adding a
    // legacy `s:`-cache body into the index (LL-027 / LL-073 family).
    const bad = data.entries
      .filter((e) => String(e.bodyJa ?? "").trim() || String(e.bodyEn ?? "").trim())
      .map((e) => `${String(e.source)}:${String(e.title)}`);
    expect(bad).toEqual([]);
  });
});

describe("data/bodies.json (body-file architecture / LL-113)", () => {
  const bodiesPath = join(process.cwd(), "data", "bodies.json");
  const bodies = existsSync(bodiesPath)
    ? (JSON.parse(readFileSync(bodiesPath, "utf8")) as {
        generatedAt?: string;
        count?: number;
        bodies?: Record<string, { bodyJa?: unknown; bodyEn?: unknown }>;
      })
    : null;

  it("data/bodies.json が存在し、スキーマが妥当である", () => {
    expect(bodies).not.toBeNull();
    expect(bodies && typeof bodies.bodies === "object").toBe(true);
  });

  it("各 body レコードの bodyJa / bodyEn は文字列である", () => {
    const records = Object.entries(bodies?.bodies ?? {});
    const bad = records
      .filter(
        ([, r]) =>
          (r.bodyJa !== undefined && typeof r.bodyJa !== "string") ||
          (r.bodyEn !== undefined && typeof r.bodyEn !== "string"),
      )
      .map(([id]) => id);
    expect(bad).toEqual([]);
  });

  it("bodies.json に決定論的 filler body が残っていない", () => {
    const JA_FILLER = "元記事の要約と収集時のメタデータから";
    const EN_FILLER = "completed from the existing summary and collection metadata";
    const bad = Object.entries(bodies?.bodies ?? {})
      .filter(
        ([, r]) =>
          String(r.bodyJa ?? "").includes(JA_FILLER) || String(r.bodyEn ?? "").includes(EN_FILLER),
      )
      .map(([id]) => id);
    expect(bad).toEqual([]);
  });

  it("bodies.json は運用上限を超えない (10MB)", () => {
    if (!existsSync(bodiesPath)) return;
    expect(statSync(bodiesPath).size).toBeLessThanOrEqual(10_000_000);
  });

  it("bodies.json は evergreen・重要記事・直近30日の本文だけを保持する", () => {
    const entriesById = new Map(data.entries.map((entry) => [String(entry.id), entry]));
    const referenceMs = Date.parse(data.generatedAt);
    const invalid = Object.keys(bodies?.bodies ?? {}).filter((id) => {
      const entry = entriesById.get(id);
      if (!entry) return true;
      return !isBodyRetentionEligible(
        entry as Pick<
          NormalizedEntry,
          "evergreen" | "importance" | "publishedAt" | "collectedAt"
        >,
        referenceMs,
        DEFAULT_BODY_RETENTION_DAYS,
      );
    });
    expect(invalid).toEqual([]);
  });

  it("body retention telemetry は最終 index / bodies artifact と一致する", () => {
    const referenceMs = Date.parse(data.generatedAt);
    const retentionEligible = data.entries.filter((entry) =>
      isBodyRetentionEligible(
        entry as Pick<
          NormalizedEntry,
          "evergreen" | "importance" | "publishedAt" | "collectedAt"
        >,
        referenceMs,
        DEFAULT_BODY_RETENTION_DAYS,
      )
    ).length;
    const bodiesTotal = Object.keys(bodies?.bodies ?? {}).length;
    const bodyPresentIds = new Set(Object.keys(bodies?.bodies ?? {}));
    const backlog = data.entries
      .filter((entry) =>
        isBodyRetentionEligible(
          entry as Pick<
            NormalizedEntry,
            "evergreen" | "importance" | "publishedAt" | "collectedAt"
          >,
          referenceMs,
          DEFAULT_BODY_RETENTION_DAYS,
        )
      )
      .filter((entry) =>
        needsBody(
          entry as Pick<NormalizedEntry, "id" | "summaryJa" | "summaryEn">,
          bodyPresentIds,
        )
      ).length;
    const enqueueCap = Math.max(0, Number(data.health?.bodyEnqueueCap ?? 0));

    expect(data.health?.bodiesTotal).toBe(bodiesTotal);
    expect(data.health?.bodyRetentionEligible).toBe(retentionEligible);
    expect(data.health?.bodyBacklog).toBe(backlog);
    expect(data.health?.bodyQueueDrainEstimateHours).toBe(
      enqueueCap > 0 ? Math.ceil(backlog / enqueueCap) : 0,
    );
  });

  it("known product name と矛盾する AI 解説本文を保持しない", () => {
    const entriesById = new Map(
      data.entries.map((entry) => [String(entry.id), entry]),
    );
    const conflicting = Object.entries(bodies?.bodies ?? {}).flatMap(
      ([id, body]) => {
        const entry = entriesById.get(id);
        if (!entry) return [];
        const normalizedEntry = asNormalizedEntry(entry);
        return hasKnownProductBodyConflict(
          normalizedEntry,
          String(body.bodyJa ?? ""),
        ) || hasKnownProductBodyConflict(
          normalizedEntry,
          String(body.bodyEn ?? ""),
        )
          ? [id]
          : [];
      },
    );
    expect(conflicting).toEqual([]);
  });
});

describe("カテゴリ品質ガード", () => {
  it("Amazon Quick の原題を Amazon QuickSight へ置き換えない", () => {
    const bad = data.entries
      .filter((entry) => String(entry.source) === "aws-ml-blog")
      .filter((entry) => /\bAmazon Quick\b/i.test(String(entry.title)))
      .filter((entry) => !/\bAmazon Quick\s*Sight\b/i.test(String(entry.title)))
      .filter((entry) => /\bAmazon Quick\s*Sight\b/i.test(String(entry.titleJa)))
      .map((entry) => `${String(entry.id)}:${String(entry.titleJa)}`);
    expect(bad).toEqual([]);
  });

  it("Zed は VSCode ではなく Cursor 系カテゴリとして扱う", () => {
    const bad = allDataEntries
      .filter((entry) => String(entry.source) === "zed-releases" && String(entry.category) !== "cursor")
      .map((entry) => `${String(entry.source)}:${String(entry.category)}:${String(entry.title)}`);
    expect(bad).toEqual([]);

    const zedInVscode = allDataEntries
      .filter((entry) => String(entry.category) === "vscode")
      .filter((entry) => /\bzed\b/i.test(`${String(entry.source)} ${String(entry.title)} ${String(entry.url)}`))
      .map((entry) => `${String(entry.source)}:${String(entry.title)}`);
    expect(zedInVscode).toEqual([]);
  });

  it("VSCode カテゴリはタイトル/要約が VSCode 中心の記事だけを含む", () => {
    const allowed = /(vs\s*code|vscode|visual studio code|code\.visualstudio|devcontainer|dev container|extension|拡張機能|live share|VSコード|VS Code)/i;
    const bad = allDataEntries
      .filter((entry) => String(entry.category) === "vscode")
      .filter((entry) => !allowed.test(`${String(entry.title)} ${String(entry.titleJa ?? "")} ${String(entry.summaryJa ?? "")} ${String(entry.summaryEn ?? "")}`))
      .map((entry) => `${String(entry.source)}:${String(entry.title)}`);
    expect(bad).toEqual([]);
  });

  it("Research は live cap を超えて broad feed 由来の記事で膨らまない", () => {
    const researchLive = data.entries.filter((entry) => String(entry.category) === "research");
    expect(researchLive.length, `research live count: ${researchLive.length}`).toBeLessThanOrEqual(140);
  });

  // LL-081 / LL-129 / LL-144 / LL-260: source filter と category restamp の単一ソースは
  // registry。既存 live/archive も shared helper で current rule に再適用した結果と
  // 一致していなければならない。ただし normalized live/archive artifact は raw
  // snippet を失っていることがあるため、non-title scope source では missing include
  // だけでは destructive drop の証拠にならない。gate も Worker/migration と同じ
  // lossy-prior evaluator を使い、keep=false だけを violation として扱う。
  it("registry の current source filter / category が live/archive データに適用漏れしていない", () => {
    const leaked = allDataEntries.flatMap((entry) => {
      const source = REGISTRY[String(entry.source)];
      if (!source) return [];
      const normalized = asNormalizedEntry(entry);
      const failures: string[] = [];
      const filterDecision = evaluateKeywordFilter(keywordFilterEntryFromNormalized(normalized), source, {
        allowLossyMissingInclude: true,
      });
      if (!filterDecision.keep) {
        failures.push(
          `${String(entry.source)} [filter:${filterDecision.reason}${filterDecision.keyword ? `:${filterDecision.keyword}` : ""}]: ${String(entry.title)}`,
        );
      }
      const restamped = restampEntryFromSource(normalized, source, data.generatedAt);
      if (normalized.category !== restamped.category) {
        failures.push(
          `${String(entry.source)} [category ${String(normalized.category)} -> ${String(restamped.category)}]: ${String(entry.title)}`,
        );
      }
      return failures;
    });
    expect(
      leaked,
      "registry の current source filter / category と不一致の entry が残存。lossy normalized artifact は non-title scope の missing include を単独では証明できないため、gate は Worker/migration と同じ evaluator を使う。filter keep=false か category drift のみを scripts/clean-source-noise.mjs + Worker deploy で是正すること",
    ).toEqual([]);
  });

  it("Local LLM category excludes workflow and business noise", () => {
    const noisy = allDataEntries
      .filter((entry) => String(entry.category) === "local-llm")
      .filter((entry) => ["zenn-ai", "zenn-llm", "qiita-llm", "simonw-blog"].includes(String(entry.source)))
      .filter((entry) =>
        /(saas is dead|claude code|workflow|billing|invoice|startup|profit|profitable|\u55b6\u696d|\u9ed2\u5b57|\u53ce\u76ca|\u8acb\u6c42)/i
          .test(String(entry.title) + " " + String(entry.summaryJa) + " " + String(entry.summaryEn) + " " + String(entry.url)),
      )
      .map((entry) => String(entry.source) + ":" + String(entry.title));
    expect(noisy).toEqual([]);
  });
});

describe("evergreen 蓄積ポリシー (R-022)", () => {
  // best-practice / knowledge entries は「アーカイブせず蓄積」: hot window 後も
  // warm (個別URL) に留まり、cold (/archive 月次集約) / dropped にしない。
  // 不変条件は evergreen フラグに対して検証する (検出)。生成側 (normalize.ts +
  // decideTier) と migration が予防する。stale worker が evergreen を剥がしても
  // この gate は flap しない (剥がれた entry は対象外になるだけ) ため、LL-073 の
  // 通り完了後に Worker を deploy して再付与する。
  it("evergreen エントリは live index で cold / dropped にならない", () => {
    const violations = data.entries
      .filter((entry) => (entry as { evergreen?: unknown }).evergreen === true)
      .filter((entry) => {
        const tier = String((entry as { archiveTier?: unknown }).archiveTier ?? "");
        return tier === "cold" || tier === "dropped";
      })
      .map((entry) => `${String(entry.source)} [${String((entry as { archiveTier?: unknown }).archiveTier)}]: ${String(entry.title)}`);
    expect(violations, "evergreen エントリが cold/dropped。decideTier / migrate-evergreen を確認すること").toEqual([]);
  });

  it("registry の evergreen ソースが少なくとも 1 件 live で蓄積されている", () => {
    const evergreenSources = Object.keys(REGISTRY).filter((id) => REGISTRY[id]?.evergreen);
    expect(evergreenSources.length).toBeGreaterThan(0);
    const accumulated = data.entries.filter(
      (entry) => (entry as { evergreen?: unknown }).evergreen === true,
    );
    expect(accumulated.length).toBeGreaterThan(0);
  });
});

describe("data/stats.json", () => {
  it("トップレベルの数値と生成時刻が有効である", () => {
    expect(typeof stats.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(stats.generatedAt))).toBe(true);
    expect(stats.bucketTimeZone).toBe(STATS_BUCKET_TIME_ZONE);
    expect(stats.totals.allTime).toBeGreaterThanOrEqual(data.entries.length);
    expect(stats.totals.last30d).toBeGreaterThanOrEqual(stats.totals.last7d);
    expect(stats.totals.last7d).toBeGreaterThanOrEqual(stats.totals.last24h);
    expect(Object.keys(stats.byImportance).sort()).toEqual(["1", "2", "3"]);
  });

  it("日次・月次 bucket が昇順で、カテゴリ集計が count を超えない", () => {
    const dayKeys = stats.byDay.map((bucket) => String(bucket.date));
    const monthKeys = stats.byMonth.map((bucket) => String(bucket.month));
    expect(dayKeys).toEqual([...dayKeys].sort());
    expect(monthKeys).toEqual([...monthKeys].sort());

    const buckets = [...stats.byDay, ...stats.byMonth];
    const badBuckets = buckets.filter((bucket) => {
      const categoryTotal = Object.values(bucket.byCategory ?? {}).reduce(
        (total, count) => total + count,
        0,
      );
      return categoryTotal > bucket.count;
    });
    expect(badBuckets).toEqual([]);
  });

  it("全統計は live + archive の JST 再集計と一致する", () => {
    const rebuilt = buildStatsPayloadFromArtifacts(
      data.entries.map(asNormalizedEntry),
      archiveEntries.map(asNormalizedEntry),
      stats.generatedAt,
    );
    const { generatedAt: _storedGeneratedAt, ...storedContent } = stats;
    const { generatedAt: _rebuiltGeneratedAt, ...rebuiltContent } = rebuilt;
    expect(storedContent).toEqual(rebuiltContent);
  });

  it("source 集計は降順で、値が非負である", () => {
    const totals = stats.bySource.map((bucket) => bucket.total);
    expect(totals).toEqual([...totals].sort((left, right) => right - left));
    const negative = stats.bySource.filter(
      (bucket) => bucket.total < 0 || bucket.last30d < 0 || bucket.last30d > bucket.total,
    );
    expect(negative).toEqual([]);
  });
});

describe("data artifact サイズ予算", () => {
    it("live index entries are unique by canonical URL", () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const entry of data.entries) {
        const url = String(entry.url ?? "");
        const key = canonicalUrlKey(url) ?? url;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }

      expect(duplicates).toEqual([]);
    });

    it("archive month 内の entry は canonical URL で重複しない", () => {
      const archiveDir = join(process.cwd(), "data", "archive");
      const duplicates = readdirSync(archiveDir)
        .filter((fileName) => /^\d{4}-\d{2}\.json$/.test(fileName))
        .flatMap((fileName) => {
          const parsed = JSON.parse(readFileSync(join(archiveDir, fileName), "utf8")) as { entries?: RawEntry[] };
          const seen = new Set<string>();
          const bad: string[] = [];
          for (const entry of parsed.entries ?? []) {
            const url = String(entry.url ?? "");
            const key = canonicalUrlKey(url) ?? url;
            if (seen.has(key)) bad.push(`${fileName}:${key}`);
            seen.add(key);
          }
          return bad;
        });

      expect(duplicates).toEqual([]);
    });

  it("archive warm/cold entries are bilingual; compact summary-free rows must remain hot", () => {
    const invalid = archiveEntries
      .filter((entry) => {
        const tier = String(entry.archiveTier ?? "");
        if (tier !== "warm" && tier !== "cold") return false;
        return !String(entry.summaryJa ?? "").trim() || !String(entry.summaryEn ?? "").trim();
      })
      .map((entry) => `${String((entry as { archiveFile?: unknown }).archiveFile ?? "?")}:${String(entry.id ?? entry.url ?? "?")}`);
    expect(
      invalid,
      "archive warm/cold entries missing bilingual summaries detected; run `npm run noise:clean -- --apply` to repair corrupted compact rows back to hot",
    ).toEqual([]);
  });

  it("index / stats / archive month が運用上限を超えない", () => {
    const archiveDir = join(process.cwd(), "data", "archive");
    const archiveFiles = readdirSync(archiveDir)
      .filter((fileName) => /^\d{4}-\d{2}\.json$/.test(fileName))
      .map((fileName) => ({
        fileName,
        size: statSync(join(archiveDir, fileName)).size,
      }));
    const oversizedArchiveFiles = archiveFiles.filter(
      (file) => file.size > DATA_BUDGET.archiveMonthBytes,
    );

    expect(statSync(join(process.cwd(), "data", "index.json")).size).toBeLessThanOrEqual(
      DATA_BUDGET.indexBytes,
    );
    expect(statSync(join(process.cwd(), "data", "stats.json")).size).toBeLessThanOrEqual(
      DATA_BUDGET.statsBytes,
    );
    expect(oversizedArchiveFiles).toEqual([]);
  });
});
