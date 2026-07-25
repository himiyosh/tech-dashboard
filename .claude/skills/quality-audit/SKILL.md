---
description: tech-dashboard の index.json を監査し、品質・鮮度・カテゴリ分布の問題を検出する
---

# Quality Audit — tech-dashboard

## 目的

`data/index.json` を読み取り、以下 9 観点で品質スコアを算出・問題リストを返す。

> 重要: `data/index.json` の `collectedAt` は **その source の last checked telemetry ではない**。broad / filtered feed は recent item が include/exclude で全落ちすると、live index に残る最新 qualifying entry が古く見える。これだけで collector failure と断定しない。pipeline 健全性は `index.health` の aggregate telemetry (`lastRunAt` / `copilotOk` / `sourcesAttempted` / `sourcesOk` / `sourcesFailed`) で判断する。

1. **掲載エントリ活動 (retained/listed-entry activity)**: ソース別の最新掲載 entry の収集時刻 (`collectedAt`) を監査し、最新公開時刻 (`publishedAt`) は上流活動の参考値として併記する。blog は 42h/168h、release/changelog は 30d/120d、paper/research は 14d/60d、community は 7d/30d を stale/inactive の目安にする。しきい値は Web UI と同じ `web/src/lib/freshness.ts` を使う。
2. **ソース整合性 (source coverage)**: `harness/registry.ts` と `data/index.json` の source ID 差分を特定。未出現 source は情報として列挙し、registry に無い data source を warning とする。
3. **カテゴリ偏り (distribution)**: `harness/types.ts` の全カテゴリで 0 件のものを特定。
4. **要約品質 (summary)**: `summaryJa` が空/短すぎる (< 20 chars) / 機械翻訳臭いもの。
5. **fallback debt**: deterministic fallback (`このエントリは ... AI 要約未生成` / `AI summary not yet available`) が残っている件数と比率。10% 以上または 50 件以上で warning、70% 以上で critical。
6. **タグ品質 (tags)**: 同一タグのバリエーション (例: "llm" vs "LLM" vs "大規模言語モデル")。
7. **重複 (dup)**: tracking query を除去した URL 正規化漏れ。同一 YouTube watch URL は `v` を動画 ID として保持。
8. **Queue telemetry**: summary/body/shared budget の backlog、candidate、実 enqueue、lookup、merge、ETA を分離し、未観測を 0 件として扱わない。
9. **Knowledge coverage**: registry の全 evergreen source を母集団にし、source ごとの収集件数、evergreen stamp 件数、shared summary quality contract を通る bilingual-ready 件数を比較する。0 entry や stamp 欠落 source も省略せず、本文 coverage とは別指標にする。

## 実行手順

1. `data/index.json` を読み込む
2. `harness/registry.ts` から期待ソース一覧を取得
3. 各観点についてメトリクスを計算
4. `_runs/audit-<timestamp>.md` に Markdown レポートを出力
5. 深刻度別に以下を返す:
   - 🔴 **高 (Critical)**: index.json が空、aggregate run が 6h 超 stale (`lastRunAt`)、index.health で attempted 全件 failed、index.json 破損
   - 🟠 **中 (Warning)**: summarize disabled (`copilotOk=false`)、aggregate source failure が一部残る、2 以上のソースが stale/inactive、registry に無い data source あり、カテゴリ 3 つ以上が 0 件、要約カバレッジ < 50%、deterministic fallback が多い
   - 🟢 **低 (Minor)**: タグ揺れ 10 以上、URL 重複候補 5 以上

## 出力フォーマット

```markdown
# 品質監査レポート — <timestamp>

**サマリ**: <件数> 件の問題 (🔴 X · 🟠 Y · 🟢 Z)

## 🚦 パイプライン実行状態

- aggregate run: ERR (no run in 6h+) / WARN (summarize disabled, 2 source error) / OK
- stale run (`lastRunAt` > 6h) は **Critical**
- summarize disabled (`copilotOk=false`) は **Warning**
- sourcesAttempted: 14
- sourcesOk: 12
- sourcesFailed: foo, bar

## 🏥 掲載エントリ活動

- ここで見る age は live index に残る latest qualifying entry の age
- include/exclude filter で recent item が全落ちした source は古く見えても collector failure とは限らない
- stale/inactive row は **掲載 activity の Warning** であり、collection failure の直接証拠ではない
- pipeline failure は aggregate health (`lastRunAt` / `copilotOk` / attempted/ok/failed) で判定する

| ソース | 最新収集 | 最新公開 | 収集経過 (h) | 状態 |
|---|---|---|---|---|
| foo | 2026-05-26T09:55:00Z | 2026-05-26T09:40:00Z | 0.1 | ✅ ok |
| bar | 2026-05-24T01:12:00Z | 2026-05-24T00:44:00Z | 56.8 | 🟠 stale |
| baz | 2026-05-20T03:10:00Z | 2026-05-20T02:58:00Z | 152.8 | 🟠 inactive |

## 🧭 ソース整合性

- registry ソース: N
- data ソース: M
- registry にあるが data に未出現: ...
- data にあるが registry に無い: ...

## 📊 カテゴリ分布

| カテゴリ | 件数 | 状態 |
|---|---|---|
| ... | ... | ✅/⚠️ |

## 📝 要約カバレッジ

- 要約あり: N 件 (X%)
- 空要約: M 件
- 短すぎ (<20 chars): K 件
- deterministic fallback: F 件 (Y%)

## ⚙️ Enrichment Queue snapshot

- `未観測` は 0 件ではない
- backlog / candidates / enqueued / lookup / merged / ETA を別々に表示する

## 🌲 Knowledge evergreen coverage

- registry evergreen source ごとの collected / evergreen flagged / bilingual ready / pending を表示する

## 🏷️ タグ揺れ候補

- `llm` vs `LLM` vs `大規模言語モデル` (12 件 vs 3 件 vs 1 件) → 推奨正規化: `llm`

## 🔗 URL 重複候補

- https://example.com/a?utm=x と https://example.com/a (2 件)
```

## 使い方

```bash
# Claude Code から
/skill quality-audit
```

## 参照

- `harness/registry.ts` — 期待ソース定義
- `data/index.json` — 監査対象
- `data/_runs/` — 過去のランレポート (鮮度差分用)
