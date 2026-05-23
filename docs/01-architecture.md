# 01. システム設計書

> **前提**: [00. Harness Engineering リサーチ](00-research-harness-engineering.md) の 5 原則に準拠する。

---

## 1. 要件

### 1.1 機能要件

| ID   | 要件                                                                                                                                                                                | 優先度 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | 14 カテゴリ × 51 登録ソース (Worker 実行時は `user-opml` を除く 50 ソース) の更新情報を自動収集 | MUST   |
| F-02 | 収集したエントリを共通スキーマに正規化                                                                                                                                              | MUST   |
| F-03 | 重複排除・クラスタリング (同一ニュースの統合)                                                                                                                                       | MUST   |
| F-04 | 日本語要約 (1-2 文)                                                                                                                                                                 | MUST   |
| F-05 | カテゴリ自動付与 (13 slug のいずれか) + タグ補完 (`benchmark`, `rag`, `open-model`, `mcp-server`, `release`, `tutorial` 等)                                                         | SHOULD |
| F-06 | タイムライン / カード UI での閲覧                                                                                                                                                   | MUST   |
| F-07 | タグ・ソース・期間でフィルタ                                                                                                                                                        | MUST   |
| F-08 | 全文検索                                                                                                                                                                            | SHOULD |
| F-09 | RSS / JSON Feed 出力                                                                                                                                                                | SHOULD |
| F-10 | 毎時自動更新 (Cloudflare Worker + Pages Git Integration)                                                                                                                           | MUST   |

### 1.2 非機能要件

| 項目                   | 目標                            |
| ---------------------- | ------------------------------- |
| 更新頻度               | Worker cron 毎時。個別ソースは 4 時間ごと |
| ページロード (LCP)     | < 2.0s (static site)            |
| Lighthouse Performance | >= 95                           |
| コスト                 | LLM API 月額 < $20 (個人ユース) |
| 運用工数               | < 30 分/月                      |

### 1.3 情報ソース (Production = 51 登録ソース)

Production では **14 カテゴリ × 51 登録ソース** を対象とする。Worker 実行時はローカル FS 依存の `user-opml` を除外し、50 ソースを 4 batch に分割して毎時ローテーションする。完全な現行仕様は [SPEC.md](SPEC.md) と `harness/registry.ts` を正とする。

**14 カテゴリ** (`slug` / 概要):
1. `copilot` – GitHub Copilot (CLI/Chat/Enterprise)
2. `claude` – Anthropic Claude / Claude Code
3. `codex` – OpenAI Codex / Code Interpreter
4. `gemini` – Google Gemini / Gemini CLI
5. `vscode` – VS Code 本体 / 拡張
6. `cursor` – Cursor Editor
7. `cline` – Cline / Roo Code
8. `aider` – Aider
9. `opencode` – sst/opencode 系
10. `local-llm` – Ollama / LM Studio / llama.cpp / HF
11. `agent-fw` – LangChain / LlamaIndex / AutoGen / CrewAI
12. `mcp` – Model Context Protocol エコシステム
13. `research` – arXiv / Papers with Code / 研究ブログ
14. `tech-news` – Apple / Microsoft / Google / AWS / NVIDIA / TechCrunch / The Verge / Ars Technica など横断技術ニュース

カテゴリに収まらない概念 (benchmarks, RAG, open models, enterprise 等) はエントリ側の `tags[]` で補完する ([04-site-spec.md §1.1.1](04-site-spec.md#111-タグ補完と昇格ルール) 参照)。

**拡張性**: ソース追加は `harness/collectors/*.ts` を 1 ファイル追加 + `registry.ts` に 1 行足すだけで済む構造とする (原則 3: Workflow 志向)。RSS/Atom、HTML detail fetch、HN Algolia、YouTube RSS、OPML を既存 collector で扱う。

---

## 2. アーキテクチャ概要

### 2.1 全体図

```
┌─────────────────────────────────────────────────────────────┐
│                   Cloudflare Worker Cron                     │
│                   = Runtime Harness Loop                     │
└──────────────────┬──────────────────────────────────────────┘
                   │ cron: 0 * * * * (4 batch rotation)
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Worker Harness (Node/TS, shared collectors/pipeline)        │
│  ├─ Collectors (1 per source, parallel)                     │
│  ├─ Pipeline (normalize → dedupe → fallback → queue enqueue)│
│  └─ Publisher (commit data/index.json + archive + stats)     │
└──────────────────┬──────────────────────────────────────────┘
                   │ git commit + push
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Static Site Build (Astro) → Deploy (Cloudflare Pages)      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Dev-time Harness (Claude Code / Copilot agent)             │
│  ├─ Skills: add-source, re-summarize, audit-quality         │
│  ├─ Subagents: source-researcher, ui-designer               │
│  └─ Hooks: pre-commit validation, schema check              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 二重ハーネス構造

本プロジェクトは **2 つのハーネス** を持つ (Anthropic Initializer+Worker パターンの応用):

- **Runtime Harness** (Cloudflare Worker cron + shared pipeline): 本番で毎時実行される決定論的 Workflow。再現性・検証性を最優先
- **Dev-time Harness** (Claude Code / Copilot): 開発者が新ソース追加、UI 改善、品質監査を行うためのエージェント環境

Runtime は **Workflow**、Dev-time は **Agent** (原則 3)。

### 2.3 技術スタック

| レイヤ         | 技術                                                                               | 選定理由                                                 |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Site generator | **Astro**                                                                          | Island architecture で JS 最小、静的配信で高速・低コスト |
| UI             | Astro components + vanilla client scripts                                           | JS 最小の静的 UI、Pagefind 検索                          |
| Harness        | Node.js 22 + TypeScript                                                            | Cloudflare Pages / Worker とローカル検証の parity を優先 |
| LLM            | **Claude Sonnet 4.6** (Queue consumer) / ローカル backfill は Sonnet 4.6 または Opus 4.7 | Worker CPU 制約を避けつつ品質を維持                      |
| Data store     | **Git** (JSON + Markdown)                                                          | DB 不要、差分可視、バージョン管理、$0                    |
| 検索           | Pagefind (静的)                                                                    | ビルド時インデックス、クライアント検索、サーバ不要       |
| デプロイ       | **Cloudflare Pages**                                                               | CDN / DDoS / 無料枠、ユーザ指定                          |
| CI             | GitHub Actions                                                                     | リポジトリ内完結                                         |

**意図的に避けたもの**: Next.js (SSR 不要), Postgres / Supabase (規模過剰), Redis (不要), Docker (overkill)。

---

## 3. データモデル

### 3.1 正規化スキーマ (`NormalizedEntry`)

```ts
interface NormalizedEntry {
  id: string;              // sha256(source + url)
  source: SourceId;        // "anthropic-blog" | "github-copilot-changelog" | ...
  sourceType: "blog" | "release" | "changelog" | "paper" | "community";
  url: string;
  title: string;           // 原文タイトル
  titleJa: string;         // 日本語 (原文が日本語ならそのまま)
  titleEn: string;         // 英語 (原文が英語ならそのまま)
  summaryJa: string;       // 日本語要約 (1-2 文, 120 字以内)
  summaryEn: string;       // 英語要約 (1-2 sentences, <= 200 chars)
  publishedAt: string;     // ISO 8601
  collectedAt: string;     // ISO 8601
  tags: string[];          // ["copilot", "release", "vscode"]
  category: Category;      // "copilot" | "claude" | "codex" | "local-llm" | "opencode" | "research" | "community"
  importance: 1 | 2 | 3;   // 3 = major release, 1 = minor
  clusterId?: string;      // 重複排除後の代表 ID
  image?: {                // サムネイル (3 段フォールバック)
    src: string;           // 配信用 URL (Cloudflare Images で 320x180 WebP)
    origSrc: string;       // 原画像 URL (生存確認用)
    alt: string;           // og:title or fallback
    width: number;
    height: number;
    source: "media" | "og" | "fallback";
                           //   media: RSS の <media:thumbnail> / <enclosure>
                           //   og:    <meta property="og:image">
                           //   fallback: カテゴリ SVG (画像取得失敗 or 該当なし)
  };
  raw: { /* 生データの最小コピー */ };
}
```

#### 画像取得パイプライン (3 段フォールバック)

```
1. RSS の <media:thumbnail> / <enclosure>          ← あれば即採用
   ↓ なければ
2. 記事 URL を fetch して <meta property="og:image"> ← 標準的 (95%+ カバー)
   ↓ なければ / 取得失敗 (404, 5xx, timeout 3s)
3. カテゴリ SVG フォールバック                       ← 常に描画可能
```

- **配信**: Cloudflare Images (無料枠 5000 変換/月で十分) で 320×180 WebP に変換、直リンクせず CDN 経由
- **検証**: ハーネス各サイクルで HEAD リクエスト。失効していたら OGP 再取得 or フォールバック降格
- **法務**: サムネイル扱い + 出典明示 + クリックで原文遷移 (Fair use 範囲内)
- **プライバシー**: `referrerpolicy="no-referrer"` + `loading="lazy"`
- **LLM コスト影響**: 画像は LLM を通さない (URL 抽出のみ)。追加コストは 0

### 3.2 ストレージレイアウト

```
data/
├─ raw/                         # コレクター生データ (監査用)
│  └─ 2026-04-19/
│     └─ <source>.json
├─ normalized/                  # 正規化済み
│  └─ 2026-04/
│     └─ <id>.json              # 1 エントリ 1 ファイル (diff 可視)
├─ clusters.json                # 重複クラスタマップ
├─ index.json                   # サイト配信用 (最新 2000 件)
├─ stats.json                   # archive 込みの記事数推移 / source 集計
├─ archive/
│  ├─ _index.json               # 月別 archive index
│  └─ YYYY-MM.json              # warm/cold tier の月別 archive。一覧用のため本文は省略
└─ feeds/
   ├─ all.rss
   └─ <category>.rss
```

**原則 1 の Offload**: コンテキストに全エントリを渡さない。要約時は 1 件ずつ、重複排除時は埋め込みベクトルのみを渡す。

---

## 4. データフロー (1 サイクル)

```
[trigger] Cloudflare Worker cron
   │
   ▼
[1] Collect (parallel, per source)
   - 各 Collector は独立プロセス (原則 1: Isolate)
   - 出力: data/raw/<date>/<source>.json
   - Hook: URL 到達性チェック、スキーマ検証
   │
   ▼
[2] Normalize
   - 各 raw → NormalizedEntry
   - 決定論的変換のみ (LLM 不使用)
   - Hook: 必須フィールド検証、日付妥当性
   │
   ▼
[3] Dedupe / Cluster
   - 既存エントリと URL + タイトル類似度で重複判定
   - 類似判定は軽量 embedding (e.g., bge-small, ローカル)
   - clusterId 付与
   │
   ▼
[4] Fallback + Queue summarize (Claude Sonnet 4.6)
   - Worker は deterministic fallback で空欄を防ぎ、Queue に最大 ENQUEUE_MAX_NEW 件/run を投入
   - worker-summarizer が 1 message/invocation で Copilot 要約を生成
   - Hook: JSON schema, summary/body 欠落検出、per-URL KV cache 再利用
   - Verifier: generated body と summary の欠落、model error、cache 不整合を run metadata に記録
   │
   ▼
[5] Publish
   - data/index.json / data/archive/*.json / data/stats.json を生成
   - ローカル harness は data/_runs/<timestamp>.json も生成
   - GitHub Git Data API で data 差分を 1 commit にまとめて main に反映
   │
   ▼
[6] Site Rebuild
   - Cloudflare Pages Git Integration が main push を検知してビルド
   - Pagefind 検索インデックス生成
   - `npm run build` (root directory `web`, output `dist`)
```

各ステップの出力は **次の入力にしかならない**。横断アクセスを作らない (原則 5: シンプルに)。

---

## 5. 可観測性 (Observability)

Arize 提言: **agent needs telemetry comparable to human developers**。

| 項目                         | 実装                                                   |
| ---------------------------- | ------------------------------------------------------ |
| 各ステップの成否             | Worker health metadata + `data/_runs/<timestamp>.json` |
| LLM 呼出数・トークン・コスト | `data/_runs/*.json` に記録                             |
| Collector 別の収集件数       | 同上、ダッシュボードに `/status` ページで可視化        |
| 失敗率 / リトライ            | Worker run metadata と collector 側 retry で把握       |
| 異常検知                     | 前日比 ±50% 以上の変動で Slack/Discord 通知 (将来)     |

---

## 6. セキュリティ / プライバシー

- API キーと token は Wrangler Secrets / `.env.local` のみ。ログ出力禁止
- 外部ソース取得は `User-Agent: tech-dashboard-bot/1.0` を明示、`robots.txt` を尊重
- Reddit / HN 等はレート制限を遵守 (指数バックオフ)
- サイトにはユーザ追跡 Cookie を設置しない (アクセス解析は Cloudflare Web Analytics のみ)

---

## 7. ロードマップ

| フェーズ  | 内容                                                                      | 完了条件                                                    |
| --------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| P0 (設計) | 本ドキュメント群 + サイト仕様 v1.0 の初期化                               | 完了                                                        |
| P1 (MVP)  | Tier 1 コアソース + 基本 UI (サイドバー / トレンド / タイムライン)        | 完了                                                        |
| P2        | 50 ソース収集、全文検索、タグフィルタ、RSS / JSON Feed                    | 完了                                                        |
| P3        | 品質監査 Skill、`/status` ページ、Worker Health、secret gate              | 完了                                                        |
| P4        | OPML / YouTube / HN などの任意ソースと運用品質の継続改善                  | 継続                                                        |

---

## 8. 次のドキュメントへ

→ [02. Agent / Skill / Hook / Prompt 構成](02-agents-skills-hooks.md) でハーネス内部の具体を定義する。
