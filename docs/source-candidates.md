# 情報源拡充バックログ(検証待ち候補フィード)

サイトを AI 主体のテクノロジー情報サイトとして拡充するための候補フィード一覧。
**登録前に必ず実フィード検証を行うこと(LL-086)**: HTTP 200 でも SPA の HTML が返る
フィードがある。検証は登録手順(README / SPEC §4.3)に従う。

検証コマンド(登録者のローカル環境で実行):

```bash
curl -sSL --max-time 20 -A "Mozilla/5.0 (compatible; tech-dashboard-bot)" "<feed-url>" | head -c 2000
# <rss / <feed / <rdf と <item> / <entry> が含まれ、per-item の日付があることを確認する
```

状態の凡例: `verified-added` = 検証済みで registry 登録済み / `unverified` = この環境の
egress 制限で未検証(URL は一般に知られた候補。実在保証なし) / `rejected` = 判断済み却下。

## 検証済み・登録済み (2026-08-25)

| ソース | Feed URL | 状態 |
|---|---|---|
| MCP Blog(標準化団体公式) | `https://blog.modelcontextprotocol.io/index.xml` | verified-added |
| Microsoft Research Blog | `https://www.microsoft.com/en-us/research/feed/` | verified-added |

## 優先候補(unverified: 検証してから登録する)

AI ラボ・研究機関の公式ブログ(tier 1 相当):

| ソース | 候補 URL | 想定カテゴリ | 備考 |
|---|---|---|---|
| Google Research Blog | `https://research.google/blog/rss/` | research | |
| Meta AI Blog | `https://ai.meta.com/blog/rss/` | research | |
| Mistral AI News | `https://mistral.ai/feed.xml` | local-llm | open-weights モデル発表 |
| Anthropic Alignment Blog | `https://alignment.anthropic.com/feed.xml` | research | |
| Ai2 Blog | `https://allenai.org/blog/rss.xml` | research | open model (OLMo) |
| EleutherAI Blog | `https://blog.eleuther.ai/index.xml` | research | |
| Sakana AI | `https://sakana.ai/feed` | research | 日本の研究機関 |
| Preferred Networks Tech Blog | `https://tech.preferred.jp/ja/blog/feed/` | research | 日本語一次情報 |

エンジニアリング/エコシステム(tier 1-2 相当):

| ソース | 候補 URL | 想定カテゴリ | 備考 |
|---|---|---|---|
| MCP spec releases | `https://github.com/modelcontextprotocol/modelcontextprotocol/releases.atom` | mcp | 仕様リビジョン。release ノイズ対策済み前提 |
| PyTorch Blog | `https://pytorch.org/blog/feed.xml` | local-llm | |
| vLLM Blog | `https://blog.vllm.ai/feed.xml` | local-llm | |
| LangChain Blog | `https://blog.langchain.dev/rss/` | agent-fw | releases は登録済、blog が未登録 |
| LlamaIndex Blog | `https://www.llamaindex.ai/blog/feed` | agent-fw | |
| JetBrains AI Blog | `https://blog.jetbrains.com/ai/feed/` | cursor (editor) | |
| Cloudflare Blog (AI tag) | `https://blog.cloudflare.com/tag/ai/rss/` | tech-news | 広いので title keyword filter 必須 |
| Cursor Blog | `https://www.cursor.com/blog/rss.xml` | cursor | changelog は登録済 |
| DeepLearning.AI The Batch | `https://www.deeplearning.ai/the-batch/feed/` | research | 週次ニュースレター |

## 要修理(既存ソースの障害)

| ソース | 問題 | 対応案 |
|---|---|---|
| `openai-news` | 登録以来エントリ 0 件(feed URL が無効の可能性) | `https://openai.com/news/rss.xml` を再検証し、無効なら公式の現行 RSS を調査して差し替え |
| `arxiv-cs-cl` / `arxiv-cs-se` / `arxiv-cs-ai` | lastCollected が 2026-07 で停止(collector 側の staleness) | rss.arxiv.org のフィード仕様変更を確認 |
| `hn-ai` | 全期間で 2 エントリのみ | Algolia クエリの見直し |

## 却下済み

| 候補 | 理由 |
|---|---|
| 追加の GitHub `releases.atom` 系(Gemini CLI / Claude Code / Codex CLI / opencode 等) | 「エディタ/CLI のマイナーアップデートが多すぎる」という課題に逆行する。release-signal による降格を運用してから再検討 |
| W3C News | AI 比率が低く、tech-news の keyword filter でも noise が多い見込み |

> 注: unverified の URL はこの環境(egress 制限)から検証できなかった候補であり、
> 実在・形式の保証はない。登録時は必ず上記の検証コマンドで確認し、broad feed には
> `includeKeywords` / `excludeKeywords` / `keywordFilterScope: "title"` / `maxEntriesPerRun`
> を設定する(R-017)。登録後は `web/src/lib/source-meta.ts` と `docs/SPEC.md` §4.3 を同期する。
