/**
 * clean-source-noise.mjs
 *
 * registry の excludeKeywords を既存 data に再適用し、収集後に分類ノイズとして
 * 残ったエントリを live index / archive から除去する migration スクリプト。
 *
 * LL-055 / LL-077: source の keyword filter 変更は「収集ルール」であると同時に
 * 「既存 merged data の migration ルール」でもある。registry を更新したら、
 * Worker が再収集する前に既存 data からも同じノイズを掃除しておく。
 *
 * 判定は tests/data-schema.test.ts のカテゴリ品質ガードと同じ haystack
 * (title + summaryJa + summaryEn + url) を使う。
 *
 * 適用対象は MIGRATED_KEYWORDS (今回 registry の excludeKeywords に新規追加した
 * キーワード) に限定する。tv / solar / gadget のような既存の短いキーワードまで
 * 全 data に遡及適用すると、include 対象の開発記事 (GPU / Windows Update 等) を
 * 巻き込む過剰除去になるため。新キーワードを registry へ足したら、この配列も
 * 更新して再実行する運用とする。
 *
 * 実行: npx tsx scripts/clean-source-noise.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "../harness/registry.ts";
import { writeStats } from "../harness/publishers/stats-builder.ts";

const DATA_DIR = "./data";

// 今回 registry の excludeKeywords に新規追加した分だけを既存 data へ migration する。
const MIGRATED_KEYWORDS = ["satellite", "space station", "the view", "shark finning"];

function haystackFor(entry) {
  return [entry.title, entry.summaryJa, entry.summaryEn, entry.url]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
}

function isNoise(entry) {
  const source = REGISTRY[String(entry.source)];
  const exclude = source?.excludeKeywords;
  if (!exclude || exclude.length === 0) return false;
  // 当該 source が実際に持つ excludeKeywords のうち、今回 migration 対象のものだけを使う。
  const active = MIGRATED_KEYWORDS.filter((keyword) => exclude.includes(keyword));
  if (active.length === 0) return false;
  const haystack = haystackFor(entry);
  return active.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

async function main() {
  const removed = [];

  // 1. live index
  const indexPath = join(DATA_DIR, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const indexGeneratedAt = index.generatedAt;
  index.entries = index.entries.filter((entry) => {
    if (isNoise(entry)) {
      removed.push(`live ${entry.source}: ${entry.title}`);
      return false;
    }
    return true;
  });
  index.count = index.entries.length;
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

  // 2. archive months
  const archiveDir = join(DATA_DIR, "archive");
  for (const fileName of readdirSync(archiveDir).filter((name) => /^\d{4}-\d{2}\.json$/.test(name))) {
    const monthPath = join(archiveDir, fileName);
    const month = JSON.parse(readFileSync(monthPath, "utf8"));
    const before = (month.entries ?? []).length;
    month.entries = (month.entries ?? []).filter((entry) => {
      if (isNoise(entry)) {
        removed.push(`${fileName} ${entry.source}: ${entry.title}`);
        return false;
      }
      return true;
    });
    if (month.entries.length !== before) {
      if (typeof month.count === "number") month.count = month.entries.length;
      writeFileSync(monthPath, JSON.stringify(month, null, 2) + "\n", "utf8");
    }
  }

  // 3. stats を再生成し、generatedAt を index に揃えて artifact skew を 0 に保つ
  await writeStats(DATA_DIR);
  const statsPath = join(DATA_DIR, "stats.json");
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  stats.generatedAt = indexGeneratedAt;
  writeFileSync(statsPath, JSON.stringify(stats, null, 2) + "\n", "utf8");

  console.log(`Removed ${removed.length} noisy entries:`);
  for (const line of removed) console.log("  -", line);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
