# 01. システム設計書

> **前提**: [00. Harness Engineering リサーチ](00-research-harness-engineering.md) の 5 原則に準拠する。

---

## 1. 要件

### 1.1 機能要件

| ID   | 要件                                                                                                                                                                                | 優先度 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | 13 カテゴリ × 30 データソース (Tier 2: Copilot / Claude / Codex / Gemini / Cursor / Cline / Aider / VSCode / OpenCode / Local LLM / Agent FW / MCP / Research) の更新情報を自動収集 | MUST   |
| F-02 | 収集したエントリを共通スキーマに正規化                                                                                                                                              | MUST   |
| F-03 | 重複排除・クラスタリング (同一ニュースの統合)                                                                                                                                       | MUST   |
| F-04 | 日本語要約 (1-2 文)                                                                                                                                                                 | MUST   |
| F-05 | カテゴリ自動付与 (13 slug のいずれか) + タグ補完 (`benchmark`, `rag`, `open-model`, `mcp-server`, `release`, `tutorial` 等)                                                         | SHOULD |
| F-06 | タイムライン / カード UI での閲覧                                                                                                                                                   | MUST   |
| F-07 | タグ・ソース・期間でフィルタ                                                                                                                                                        | MUST   |
| F-08 | 全文検索                                                                                                                                                                            | SHOULD |
| F-09 | RSS / JSON Feed 出力                                                                                                                                                                | SHOULD |
| F-10 | 毎日自動更新 (GitHub Actions)                                                                                                                                                       | MUST   |

### 1.2 非機能要件

| 項目                   | 目標                            |
| ---------------------- | ------------------------------- |
| 更新頻度               | 1 日 2-4 回                     |
| ページロード (LCP)     | < 2.0s (static site)            |
| Lighthouse Performance | >= 95                           |
| コスト                 | LLM API 月額 < $20 (個人ユース) |
| 運用工数               | < 30 分/月                      |

### 1.3 情報ソース (Tier 2 = 30 ソース)

ポータル v1.0 では **13 カテゴリ × 30 データソース (Tier 2)** を対象とする。Collector は RSS / HTML / GitHub API / arXiv API / Reddit JSON の 5 パターンを横断的にカバーし、以後の追加コストを最小化する。完全なソース一覧とフィード URL は [04-site-spec.md §1.4](04-site-spec.md#14-データソース一覧-tier-2--30) を正とする。

**13 カテゴリ** (`slug` / 概要):
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

カテゴリに収まらない概念 (benchmarks, RAG, open models, enterprise 等) はエントリ側の `tags[]` で補完する ([04-site-spec.md §1.1.1](04-site-spec.md#111-タグ補完と昇格ルール) 参照)。

**ソース取得方式内訳 (Tier 2)**:

| 方式                | 件数   | 例                                                                                                                         |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| RSS                 | 18     | GitHub Changelog, Anthropic News, OpenAI Blog, HF Blog, Cursor Blog, Aider Blog, LangChain Blog, Google Developers Blog 他 |
| GitHub Releases API | 7      | Ollama, llama.cpp, sst/opencode, Cline, Aider, LangChain, AutoGen                                                          |
| arXiv API           | 2      | cs.CL (LLM filter), cs.AI (agent filter)                                                                                   |
| Reddit JSON         | 2      | r/LocalLLaMA, r/ClaudeAI                                                                                                   |
| HTML scrape         | 1      | MCP Servers カタログ                                                                                                       |
| **計**              | **30** |                                                                                                                            |

**拡張性**: ソース追加は `harness/collectors/*.ts` を 1 ファイル追加 + `registry.ts` に 1 行足すだけで済む構造とする (原則 3: Workflow 志向)。Tier 3 (50+ ソース、Hacker News Algolia, 個人ブログ OPML, YouTube RSS 等) は v1.1 以降で段階的に組み込む。

---

## 2. アーキテクチャ概要

### 2.1 全体図

```
┌─────────────────────────────────────────────────────────────┐
│                   GitHub Actions (scheduler)                 │
│                   = Outer Harness Loop                       │
└──────────────────┬──────────────────────────────────────────┘
                   │ cron: */6h
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Orchestrator (Node/TS CLI)                                 │
│  ├─ Collectors (1 per source, parallel)                     │
│  ├─ Pipeline (normalize → dedupe → summarize → tag)         │
│  └─ Publisher (write data/index.json + data/normalized/*)   │
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

- **Runtime Harness** (GitHub Actions + orchestrator): 本番で日次実行される決定論的 Workflow。再現性・検証性を最優先
- **Dev-time Harness** (Claude Code / Copilot): 開発者が新ソース追加、UI 改善、品質監査を行うためのエージェント環境

Runtime は **Workflow**、Dev-time は **Agent** (原則 3)。

### 2.3 技術スタック

| レイヤ         | 技術                                                                               | 選定理由                                                 |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Site generator | **Astro**                                                                          | Island architecture で JS 最小、静的配信で高速・低コスト |
| UI             | React (Island) + Tailwind CSS                                                      | デザインシステム構築容易                                 |
| Harness        | Node.js 20 + TypeScript                                                            | エコシステム豊富、GitHub Actions 親和性                  |
| LLM            | **Claude Opus 4.7** (要約・タグ付け) — 1M コンテキスト活用、fallback として 4.6 1M | 長期推論精度が必要な要約品質を優先。ユーザ指定           |
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
├─ index.json                   # サイト配信用 (最新 500 件)
└─ feeds/
   ├─ all.rss
   └─ <category>.rss
```

**原則 1 の Offload**: コンテキストに全エントリを渡さない。要約時は 1 件ずつ、重複排除時は埋め込みベクトルのみを渡す。

---

## 4. データフロー (1 サイクル)

```
[trigger] GitHub Actions cron
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
[4] Summarize + Tag (LLM - Claude Haiku)
   - 新規エントリのみ対象 (既存はスキップ)
   - バッチ: 1 リクエスト 10 件
   - Hook: 要約長 120 字以内、禁止ワードチェック
   - Verifier: 要約に URL のドメインが登場しないことで hallucination 簡易検出
   │
   ▼
[5] Publish
   - data/index.json 生成 (最新 500 件)
   - data/feeds/*.rss 生成
   - git commit + push
   │
   ▼
[6] Site Rebuild
   - Cloudflare Pages が push を検知してビルド
   - Pagefind 検索インデックス生成
   - Lighthouse CI で性能ゲート
```

各ステップの出力は **次の入力にしかならない**。横断アクセスを作らない (原則 5: シンプルに)。

---

## 5. 可観測性 (Observability)

Arize 提言: **agent needs telemetry comparable to human developers**。

| 項目                         | 実装                                                   |
| ---------------------------- | ------------------------------------------------------ |
| 各ステップの成否             | GitHub Actions summary + `data/_runs/<timestamp>.json` |
| LLM 呼出数・トークン・コスト | `data/_runs/*.json` に記録                             |
| Collector 別の収集件数       | 同上、ダッシュボードに `/_status` ページで可視化       |
| 失敗率 / リトライ            | Actions の再実行ポリシー (指数バックオフ、3 回)        |
| 異常検知                     | 前日比 ±50% 以上の変動で Slack/Discord 通知 (将来)     |

---

## 6. セキュリティ / プライバシー

- API キー (Anthropic, GitHub) は GitHub Actions Secrets のみ。ログ出力禁止
- 外部ソース取得は `User-Agent: tech-dashboard-bot/1.0` を明示、`robots.txt` を尊重
- Reddit / HN 等はレート制限を遵守 (指数バックオフ)
- サイトにはユーザ追跡 Cookie を設置しない (アクセス解析は Cloudflare Web Analytics のみ)

---

## 7. ロードマップ

| フェーズ  | 内容                                                                      | 完了条件                                                    |
| --------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| P0 (設計) | 本ドキュメント群 + サイト仕様 v1.0 (13 cat / 30 sources)                  | レビュー完了                                                |
| P1 (MVP)  | Tier 1 コア 15 ソース + 基本 UI (サイドバー 13 カテゴリ + トレンドパネル) | Cloudflare Pages に自動公開、毎日更新、全 MUST 機能要件完了 |
| P2        | Tier 2 残り 15 ソース追加 + 全文検索 + タグフィルタ精緻化                 | 全 SHOULD 要件完了 (計 30 ソース)                           |
| P3        | RSS / JSON Feed、品質監査 Skill、`/_status` ページ、タグ昇格レビュー      | 運用支援機能完了                                            |
| P4        | Tier 3 (50+ ソース: HN Algolia / OPML / YouTube) + ユーザカスタマイズ     | 任意                                                        |

---

## 8. 次のドキュメントへ

→ [02. Agent / Skill / Hook / Prompt 構成](02-agents-skills-hooks.md) でハーネス内部の具体を定義する。
