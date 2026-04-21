---
description: tech-dashboard の index.json を監査し、品質・鮮度・カテゴリ分布の問題を検出する
---

# Quality Audit — tech-dashboard

## 目的

`data/index.json` を読み取り、以下 5 観点で品質スコアを算出・問題リストを返す:

1. **鮮度 (freshness)**: ソース別の最新エントリ年齢。42h 超 = stale、168h 超 = error。
2. **カテゴリ偏り (distribution)**: 13 カテゴリで 0 件のものを特定。
3. **要約品質 (summary)**: `summaryJa` が空/短すぎる (< 20 chars) / 機械翻訳臭いもの。
4. **タグ品質 (tags)**: 同一タグのバリエーション (例: "llm" vs "LLM" vs "大規模言語モデル")。
5. **重複 (dup)**: URL 正規化漏れ (query string 違いの同一記事)。

## 実行手順

1. `data/index.json` を読み込む
2. `harness/registry.ts` から期待ソース一覧を取得
3. 各観点についてメトリクスを計算
4. `_runs/audit-<timestamp>.md` に Markdown レポートを出力
5. 深刻度別に以下を返す:
   - 🔴 **高 (Critical)**: データ生成停止・全ソース失敗・index.json 破損
   - 🟠 **中 (Warning)**: 2 以上のソースが stale、カテゴリ 3 つ以上が 0 件、要約カバレッジ < 50%
   - 🟢 **低 (Minor)**: タグ揺れ 10 以上、URL 重複候補 5 以上

## 出力フォーマット

```markdown
# 品質監査レポート — <timestamp>

**サマリ**: <件数> 件の問題 (🔴 X · 🟠 Y · 🟢 Z)

## 🏥 鮮度

| ソース | 最新 | ステータス |
|---|---|---|
| ... | ... | ... |

## 📊 カテゴリ分布

| カテゴリ | 件数 | 状態 |
|---|---|---|
| ... | ... | ✅/⚠️ |

## 📝 要約カバレッジ

- 要約あり: N 件 (X%)
- 空要約: M 件
- 短すぎ (<20 chars): K 件

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
