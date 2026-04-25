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

## デプロイ & 自動更新 (Cloudflare Worker + Cloudflare Pages Git Integration)

通常運用は Cloudflare 内で完結します。Cloudflare Worker が `data/index.json` を GitHub に commit し、Cloudflare Pages の Git Integration が `main` の更新を検知してサイトを build / deploy します。

既存の Pages プロジェクト `tech-dashboard` は Direct Upload 型で Git Provider が未接続です。Cloudflare の仕様上、Direct Upload 型を後から Git Integration 型へ切り替えることはできないため、Git Integration 付きの新しい Pages プロジェクトを作成して移行します。

```
[Cloudflare Worker Cron] ──6h ごと──→ [GitHub Contents API]
  │ (RSS 収集 + Copilot 要約)              │ push to main
  │                                       ↓
  │                              [Cloudflare Pages Git Integration]
  │                                       ↓ npm run build
  └── Summary Cache (KV)          [Cloudflare Pages 本番サイト]
```

### 1. Cloudflare Pages (サイトビルド + デプロイ)

**本番 URL**: https://techdb.studio344.net/

新しい Pages プロジェクトは Cloudflare dashboard で **Create application** → **Pages** → **Import an existing Git repository** から作成します。

| 設定項目 | 値 |
|---|---|
| Git repository | `himiyosh/tech-dashboard` |
| Production branch | `main` |
| Framework preset | `Astro` |
| Root directory | `web` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js version | `22` (`web/.node-version`) |
| Production deployments | Enabled |
| Preview deployments | 任意 |

初回デプロイ成功後、custom domain `techdb.studio344.net` を新しい Pages プロジェクトへ付け替えます。旧 Direct Upload project `tech-dashboard` は切り戻し用として一時保持し、DNS / custom domain の移行後に削除可否を判断します。

API token (`Pages Write`) がある場合は、以下でも同じ設定を作成できます。Cloudflare GitHub App が `himiyosh/tech-dashboard` へアクセスできる状態で実行します。

```bash
export CLOUDFLARE_ACCOUNT_ID=0438e47e5e23f7acd006da2e594f3559
export NEW_PAGES_PROJECT=tech-dashboard-git

curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tech-dashboard-git",
    "production_branch": "main",
    "build_config": {
      "build_command": "npm run build",
      "destination_dir": "dist",
      "root_dir": "web"
    },
    "source": {
      "type": "github",
      "config": {
        "owner": "himiyosh",
        "owner_id": "61819920",
        "repo_name": "tech-dashboard",
        "repo_id": "1216606051",
        "production_branch": "main",
        "production_deployments_enabled": true,
        "preview_deployment_setting": "all",
        "pr_comments_enabled": true
      }
    }
  }'

curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$NEW_PAGES_PROJECT/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"techdb.studio344.net"}'
```

#### 手動デプロイ

通常運用では使用しません。移行前の旧 Direct Upload project へ緊急反映する場合のみ、以下を実行します。

```bash
cd web && npm run deploy:legacy
# → 旧 project tech-dashboard へ direct upload
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
変更があれば `data/index.json` を GitHub に commit → Cloudflare Pages Git Integration が Pages を自動的に再デプロイします。

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

