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

interface RawEntry {
  id?: unknown;
  source?: unknown;
  sourceType?: unknown;
  url?: unknown;
  title?: unknown;
  titleJa?: unknown;
  summaryJa?: unknown;
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
const summaryCachePath = join(process.cwd(), "data", "_summary-cache.json");
const summaryCache = existsSync(summaryCachePath)
  ? (JSON.parse(readFileSync(summaryCachePath, "utf8")) as Record<string, { bodyJa?: string; bodyEn?: string }>)
  : {};
const DATA_BUDGET = {
  indexBytes: 8_000_000,
  statsBytes: 500_000,
  archiveMonthBytes: 2_000_000,
};

describe("data/index.json トップレベル", () => {
  it("generatedAt が ISO 8601 文字列である", () => {
    expect(typeof data.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(data.generatedAt))).toBe(true);
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

  it("Timeline と記事詳細用の summary が少なくとも 1 言語で存在する", () => {
    const bad = data.entries
      .filter((e) => !String(e.summaryJa ?? "").trim() && !String(e.summaryEn ?? "").trim())
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
