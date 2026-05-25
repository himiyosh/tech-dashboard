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
import { canonicalUrlKey } from "../harness/pipeline/url.ts";

interface RawEntry {
  id?: unknown;
  source?: unknown;
  sourceType?: unknown;
  url?: unknown;
  title?: unknown;
  titleJa?: unknown;
  summaryJa?: unknown;
  summaryEn?: unknown;
  publishedAt?: unknown;
  collectedAt?: unknown;
  tags?: unknown;
  category?: unknown;
  importance?: unknown;
  bodyJa?: unknown;
  bodyEn?: unknown;
}

interface IndexShape {
  generatedAt: string;
  count: number;
  entries: RawEntry[];
}

interface StatsBucket {
  date?: string;
  month?: string;
  count: number;
  byCategory?: Record<string, number>;
}

interface StatsShape {
  generatedAt: string;
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
const summaryCachePath = join(process.cwd(), "data", "_summary-cache.json");
const summaryCache = existsSync(summaryCachePath)
  ? (JSON.parse(readFileSync(summaryCachePath, "utf8")) as Record<string, { bodyJa?: string; bodyEn?: string }>)
  : {};
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

  it("記事詳細用の body が両言語で存在する", () => {
    const bad = data.entries
      .filter((e) => !String(e.bodyJa ?? "").trim() || !String(e.bodyEn ?? "").trim())
      .map((e) => `${String(e.source)}:${String(e.title)}`);
    expect(bad).toEqual([]);
  });

  it("cache に本文があるエントリは data/index.json にも本文が反映されている", () => {
    const bad = data.entries
      .filter((entry) => {
        const cacheHit = summaryCache[String(entry.url)];
        const cacheHasBody = Boolean(String(cacheHit?.bodyJa ?? "").trim() || String(cacheHit?.bodyEn ?? "").trim());
        const entryHasBody = Boolean(String(entry.bodyJa ?? "").trim() || String(entry.bodyEn ?? "").trim());
        return cacheHasBody && !entryHasBody;
      })
      .map((entry) => `${String(entry.source)}:${String(entry.title)}`);
    expect(bad).toEqual([]);
  });
});

describe("data/index.json カバレッジ統計 (情報のみ)", () => {
  it("bodyJa / bodyEn のカバレッジを記録する", () => {
    const total = data.entries.length;
    const withJa = data.entries.filter(
      (e) => typeof e.bodyJa === "string" && (e.bodyJa as string).trim().length > 0,
    ).length;
    const withEn = data.entries.filter(
      (e) => typeof e.bodyEn === "string" && (e.bodyEn as string).trim().length > 0,
    ).length;
    // ログ目的。閾値のアサートはせず、極端なリグレッション検知だけしておく。
    // worker が新着記事を追加すると body 未生成のエントリが大量に増える
    // (INDEX_LIMIT 2000 、全件を順次 LLM 要約して追い付いていく) ため、閾値は低くとる。
    // 「1件以上は body がある」だけアサートしてそれ以外はログとして記録する。
    expect(withJa).toBeGreaterThan(0);
    expect(withEn).toBeGreaterThan(0);
  });
});

describe("カテゴリ品質ガード", () => {
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

  it("Research は broad feed 由来の汎用 AI 記事で膨らまない", () => {
    const researchLive = data.entries.filter((entry) => String(entry.category) === "research");
    expect(researchLive.length, `research live count: ${researchLive.length}`).toBeLessThanOrEqual(140);

    const offTopic = researchLive
      .filter((entry) =>
        /(autonomous driving|flooded road|medical|biological|protein|molecule|genome|text-to-image|vision-language|segmentation|robotics?)/i
          .test(`${String(entry.title)} ${String(entry.summaryJa)} ${String(entry.summaryEn)}`),
      )
      .map((entry) => `${String(entry.source)}:${String(entry.title)}`);
    expect(offTopic).toEqual([]);
  });

  it("Tech News は consumer deal / space などのノイズを含めない", () => {
    const noisy = allDataEntries
      .filter((entry) => String(entry.category) === "tech-news")
      .filter((entry) =>
        /(memorial day|deal|sale|airfly|govee|water bottle|spacex|starship|rocket|blue origin|dead pilots|summer travel)/i
          .test(`${String(entry.title)} ${String(entry.summaryJa)} ${String(entry.summaryEn)} ${String(entry.url)}`),
      )
      .map((entry) => `${String(entry.source)}:${String(entry.title)}`);
    expect(noisy).toEqual([]);
  });
});

describe("data/stats.json", () => {
  it("トップレベルの数値と生成時刻が有効である", () => {
    expect(typeof stats.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(stats.generatedAt))).toBe(true);
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
