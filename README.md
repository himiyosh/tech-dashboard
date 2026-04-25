# Tech Dashboard - AI Ecosystem Update Portal

AI 関連アップデート (Copilot / Claude / Codex / Gemini / Cursor / Cline / Aider / VSCode / OpenCode / Local LLM / Agent FW / MCP / Research の **13 カテゴリ**) を **一括で追跡** できるポータルサイト。Harness Engineering のプラクティスに沿って、AI エージェントが自律的に情報収集・正規化・公開を行う。

**現状**: Phase 1〜4 完了 — 31 ソース (Tier 1 / 2 / 3) を自動収集、Astro 静的サイト生成、RSS/JSON Feed 配信、GitHub Copilot Enterprise (Claude Opus 4.7) による要約パイプライン、Pagefind 全文検索、品質監査 Skill、ユーザ OPML カスタマイズ基盤まで動作可能です。

## ドキュメント構成

| #   | ドキュメント                                                            | 概要                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 00  | [Harness Engineering リサーチ](docs/00-research-harness-engineering.md) | Anthropic / OpenAI の原典を元にした原則整理  |
| 01  | [システム設計書](docs/01-architecture.md)                               | アーキテクチャ・データモデル・データフロー   |
| 02  | [Agent / Skill / Hook / Prompt 構成](docs/02-agents-skills-hooks.md)    | ハーネスの内部構成と責務分割                 |
| 03  | [UI/UX デザイン案](docs/03-design-mockup.md)                            | 画面構成・ワイヤーフレーム・デザイントークン |
| 04  | [サイト仕様書 v1.0](docs/04-site-spec.md)                               | 13 カテゴリ / 30 ソース / 画面別仕様         |
| 02c | [ユーザカスタマイズ](docs/02-customization.md)                          | OPML / YouTube / HN クエリの追加方法         |

モック: [`docs/mockups/`](docs/mockups/) (mockup-D が確定デザイン)

## クイックスタート

```bash
# ============ ハーネス (ルート) ============
npm install                  # 依存インストール
npm run typecheck            # 型チェック
npm run collect              # 31 ソース収集 → data/index.json 生成
npm run collect:dry          # ドライラン (ファイル書き込みなし)

# ============ Web サイト ============
cd web
npm install
npm run dev                  # http://localhost:4321 で開発サーバ
npm run build                # dist/ に静的ビルド + Pagefind インデックス

# ============ 品質監査 ============
npx tsx .claude/skills/quality-audit/run.ts
#   → data/_runs/audit-<ts>.md に Markdown レポート出力
```

### 環境変数 (要約パイプライン)

要約は **GitHub Copilot Enterprise** の Chat Completions API 経由で Claude Opus 4.7 を呼び出します (GitHub Models とは別体系)。

```bash
# ローカル実行用 (いずれか片方)
COPILOT_PAT=ghp_...               # PAT → 一時トークン交換を自動で行う
COPILOT_TOKEN=tid=...              # 既に交換済みの一時トークンを直接注入する場合

# モデル切替
SUMMARIZE_MODEL=claude-opus-4.7    # 既定
SUMMARIZE_MAX_NEW=15               # 1 ラン当たりの新規要約上限
```

> どのトークンも無ければ要約フェーズは自動でスキップされます (ローカル dev を妨げない設計)。

## デプロイ & 自動更新 (Worker + GitHub Actions + Cloudflare Pages)

Cloudflare Pages プロジェクト `tech-dashboard` は Git Provider 未接続のため、`main` への push / merge を GitHub Actions で受け、Wrangler CLI から Pages に直接デプロイします。

```
[Cloudflare Worker Cron] ──6h ごと──→ [GitHub Contents API]
  │ (RSS 収集 + Copilot 要約)              │ push
  │                                       ↓
  │                              [GitHub Actions: deploy-pages]
  │                                       ↓ wrangler pages deploy
  └── Summary Cache (KV)          [Cloudflare Pages 本番サイト]
```

### 1. Cloudflare Pages (サイトビルド + デプロイ)

**本番 URL**: https://tech-dashboard-6a7.pages.dev/

`main` ブランチへ merge されると `.github/workflows/deploy-pages.yml` が起動し、`web` を build して Cloudflare Pages へ deploy します。

GitHub repository secrets / variables:

| 名前 | 種別 | 用途 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | Pages deploy 用 Cloudflare API token (`Cloudflare Pages:Edit` 権限) |
| `CLOUDFLARE_ACCOUNT_ID` | Secret または Variable | Cloudflare account ID |

Cloudflare Pages 側は Git Provider が `No` のままで問題ありません。GitHub Actions が direct upload deployment を担当します。

#### 手動デプロイ

緊急時やローカル確認後に直接反映したい場合は以下を実行します。

プロジェクト作成 + 初回デプロイは CLI で完了済み。再デプロイは以下 1 コマンドです。

```bash
cd web && npm run deploy
# → ビルド + wrangler pages deploy
```

### 2. Cloudflare Worker (定期ハーネス実行)

`worker/` に実装済み。ローカルから以下で一度だけセットアップ:

```bash
cd worker
npm install
npx wrangler login                              # 初回認証

# KV ネームスペース作成 (Summary Cache 用)
npx wrangler kv namespace create SUMMARY_CACHE
# → 出力された id を worker/wrangler.toml の REPLACE_WITH_KV_ID に反映

# シークレット登録 (インタラクティブ入力)
npx wrangler secret put COPILOT_PAT             # Copilot Enterprise 権限付き Classic PAT
npx wrangler secret put GH_TOKEN                # Contents:Write 権限の Fine-grained PAT

# デプロイ (Cron トリガを含む)
npx wrangler deploy
```

Cron は `0 15,21,3,9 * * *` (6 時間ごと、JST の 00/06/12/18 時) で起動し、
変更があれば `data/index.json` を GitHub に commit → GitHub Actions が Pages を自動的に再デプロイします。

**手動トリガ** (緊急で回したい時):

```bash
curl -X POST "https://tech-dashboard-harness.<your-subdomain>.workers.dev/run" \
  -H "x-trigger-token: <GH_TOKEN と同じ値>"
```

レスポンスは `202 Accepted` が即座に返り、実処理は `ctx.waitUntil` でバックグラウンド実行。進行状況は GitHub のコミット履歴 (`tech-dashboard-worker` 作成者) または Cloudflare ダッシュボードの Worker Logs で確認できます。

### 3. Cloudflare MCP サーバー (任意)

VS Code / Copilot Chat から Cloudflare を直接操作できる公式 MCP 群を `.vscode/mcp.json` に登録済み。認証は Cloudflare アカウントで OAuth。

| MCP サーバー | 用途 |
|---|---|
| `cloudflare-docs` | Cloudflare ドキュメント検索 |
| `cloudflare-bindings` | Workers / Pages の bindings 管理 |
| `cloudflare-observability` | Worker ログ / メトリクス照会 |
| `cloudflare-radar` | Cloudflare Radar (ネット動向) |
| `cloudflare-browser-rendering` | Browser Rendering API |

VS Code で MCP 拡張 or Copilot Chat を開き、初回は OAuth 認可画面が出ます。参考: https://blog.cloudflare.com/ja-jp/thirteen-new-mcp-servers-from-cloudflare/

## プロジェクト構造

```
tech-dashboard/
├─ docs/                     # 設計ドキュメント
│  └─ mockups/               # HTML モック (mockup-D が確定)
├─ harness/                  # ハーネス本体 (TypeScript)
│  ├─ orchestrator.ts        # 外側ループ (並列 collect → normalize → dedupe → tag → summarize → publish)
│  ├─ registry.ts            # ソース定義テーブル (31 ソース)
│  ├─ types.ts               # 共通型 (Category / NormalizedEntry / SourceDefinition)
│  ├─ collectors/
│  │  ├─ rss.ts              # 汎用 RSS/Atom/RDF コレクター
│  │  ├─ vscode-updates.ts   # VS Code リリースページ HTML スクレイパー
│  │  ├─ anthropic.ts        # Anthropic News / Engineering HTML スクレイパー
│  │  ├─ hn-algolia.ts       # Hacker News Algolia API
│  │  ├─ opml.ts             # ユーザ OPML インポート
│  │  └─ youtube.ts          # YouTube チャンネル RSS
│  ├─ pipeline/
│  │  ├─ normalize.ts        # RawEntry → NormalizedEntry
│  │  ├─ dedupe.ts           # URL 正規化ベース重複排除
│  │  ├─ tag.ts              # キーワードベースのタグ補完
│  │  └─ summarize.ts        # Claude Opus 4.7 日本語要約 + 重要度判定 (API キー任意)
│  └─ publishers/
│     └─ index-builder.ts    # data/index.json & raw スナップショット
├─ web/                      # Astro 静的サイト
│  ├─ src/
│  │  ├─ layouts/Portal.astro
│  │  ├─ components/{Sidebar,EntryCard}.astro
│  │  ├─ lib/data.ts         # data/index.json を型付きで読み込む
│  │  └─ pages/
│  │     ├─ index.astro      # ポータルトップ (mockup-D 準拠)
│  │     ├─ c/[slug].astro   # カテゴリ別 (13 ページ)
│  │     ├─ t/[tag].astro    # タグ別
│  │     ├─ sources.astro, about.astro, status.astro
│  │     └─ {rss.xml,feed.json}.ts  # RSS 2.0 / JSON Feed 1.1
│  └─ astro.config.mjs
├─ .claude/skills/
│  └─ quality-audit/         # 品質監査スキル (SKILL.md + run.ts)
├─ worker/                   # Cloudflare Worker (定期ハーネス実行)
│  ├─ src/index.ts           # Cron 起動 → 収集 → Copilot 要約 → GitHub Contents API に commit
│  ├─ wrangler.toml          # Workers 設定 (Cron / KV / Vars)
│  └─ package.json
└─ data/                     # 成果物 (git-as-DB)
   ├─ index.json             # サイト配信用 (最新 500 件)
   ├─ raw/                   # 生データ (.gitignore, 監査用ローカル保持)
   ├─ _runs/                 # 実行レポート + 監査レポート (.gitignore)
   ├─ _summary-cache.json    # Claude 要約キャッシュ (.gitignore、Worker では KV を使用)
   └─ user-opml.xml          # ユーザ個別 OPML (.gitignore)
```

## フェーズ進捗

| フェーズ                 | 内容                                              | 状態   |
| ------------------------ | ------------------------------------------------- | ------ |
| P0 設計                  | ドキュメント群 + サイト仕様 v1.0                  | ✅ 完了 |
| P1 MVP                   | Tier 1 コア 15 ソース + Astro サイト + daily cron | ✅ 完了 |
| P2 Tier 2 + LLM          | Tier 2 残り + Claude Opus 要約 + Pagefind 検索    | ✅ 完了 |
| P3 Feed + 監査           | RSS/JSON Feed + /status + quality-audit skill     | ✅ 完了 |
| P4 Tier 3 + カスタマイズ | HN / YouTube / OPML + ユーザカスタマイズ基盤      | ✅ 完了 |

