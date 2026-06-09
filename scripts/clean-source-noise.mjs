/**
 * clean-source-noise.mjs
 *
 * registry の excludeKeywords を既存 data に再適用し、収集後に分類ノイズとして
 * 残ったエントリを live index / archive から除去する migration スクリプト。
 *
 * LL-055 / LL-077 / LL-081: source の keyword filter 変更は「収集ルール」であると
 * 同時に「既存 merged data の migration ルール」でもある。registry を更新したら、
 * Worker が再収集する前に既存 data からも同じノイズを掃除しておく。
 *
 * 単一ソース: registry の excludeKeywords を唯一のノイズ定義として全件適用する。
 * tests/data-schema.test.ts の「registry の excludeKeywords が適用漏れしていない」
 * テストと同じ title スコープ判定を使うため、migration 後はそのテストが 0 件で通る。
 *
 * スコープは title のみ。url を含めると、ars-technica の `arstechnica.com/gadgets/`
 * のようなサイトセクション名に `gadget` が部分一致し、有効な開発記事 (Windows Update
 * 等) を巻き込む過剰除去になる (LL-081)。summary も AI 生成で短いキーワードに偶然
 * 一致しやすいため含めない。記事の主題は title に現れるので title 判定で十分。
 *
 * 新しいノイズ種別を見つけたら registry の *_EXCLUDE_KEYWORDS に追加し、このスクリプトを
 * 再実行する。スクリプト側にキーワードを二重定義しない (それが LL-081 の乖離の原因)。
 *
 * 実行: npx tsx scripts/clean-source-noise.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY } from "../harness/registry.ts";
import { writeStats } from "../harness/publishers/stats-builder.ts";

const DATA_DIR = "./data";

function haystackFor(entry) {
  // title のみ。url / summary を含めない (LL-081: 部分一致 false positive 回避)。
  return String(entry.title ?? "").toLowerCase();
}

function isNoise(entry) {
  const source = REGISTRY[String(entry.source)];
  const exclude = source?.excludeKeywords;
  if (!exclude || exclude.length === 0) return false;
  const haystack = haystackFor(entry);
  return exclude.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
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
