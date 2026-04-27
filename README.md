# Tech Dashboard - AI Ecosystem Update Portal

AI 関連アップデート (Copilot / Claude / Codex / Gemini / Cursor / Cline / Aider / VSCode / OpenCode / Local LLM / Agent FW / MCP / Tech News / Research の **14 カテゴリ**) を **一括で追跡** できるポータルサイト。Harness Engineering のプラクティスに沿って、AI エージェントが自律的に情報収集・正規化・公開を行う。

**現状**: 50 ソース (Tier 1 / 2 / 3) を Cloudflare Worker で **毎時自動収集** (50 ソースを 4 バッチに分割し各ソースは 4 時間ごとに更新)、Astro 静的サイト生成、RSS/JSON Feed 配信、GitHub Copilot Enterprise (Claude Opus 4.7) による要約パイプライン、Pagefind 全文検索、品質監査 Skill、og:image 自動取得 (KV キャッシュ) まで動作可能です。

## ドキュメント構成

| #   | ドキュメント                                                            | 概要                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 00  | [Harness Engineering リサーチ](docs/00-research-harness-engineering.md) | Anthropic / OpenAI の原典を元にした原則整理  |
| 01  | [システム設計書](docs/01-architecture.md)                               | アーキテクチャ・データモデル・データフロー   |
| 02  | [Agent / Skill / Hook / Prompt 構成](docs/02-agents-skills-hooks.md)    | ハーネスの内部構成と責務分割                 |
| 03  | [UI/UX デザイン案](docs/03-design-mockup.md)                            | 画面構成・ワイヤーフレーム・デザイントークン |
| SPEC | [本番サイト仕様 (現状)](docs/SPEC.md)                                | 14 カテゴリ / 50 ソース / 本番反映済みの仕様 |
| 04  | [サイト仕様書 v1.0 (草案)](docs/04-site-spec.md)                        | 計画段階の草案 (現状は SPEC.md が正)         |
| 02c | [ユーザカスタマイズ](docs/02-customization.md)                          | OPML / YouTube / HN クエリの追加方法         |

モック: [`docs/mockups/`](docs/mockups/) (mockup-D が確定デザイン)

## クイックスタート

```bash
# ============ 初回セットアップ ============
npm install                  # ルート依存
bash scripts/install-hooks.sh # pre-push hook (worker 自動 deploy) を有効化

# ============ ハーネス (ルート) ============
npm run typecheck            # 型チェック
npm run collect              # 50 ソース収集 → data/index.json 生成
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

```
[Cloudflare Worker Cron] ──毎時 (4 batch ローテーション)──→ [GitHub Contents API]
  │ (RSS 収集 + Copilot 要約 + og:image)                │ push to main
  │                                                     ↓
  │                                          [Cloudflare Pages Git Integration]
  │                                                     ↓ npm run build
  └── Summary / OG Cache (KV)                  [Cloudflare Pages 本番サイト]
```

> **構成決定の経緯**: 旧 `tech-dashboard` プロジェクトは Direct Upload 型で Git Integration へ切替不可だったため、いったん削除して同名で Git Integration 付きの新プロジェクトを再作成済みです (詳細は [.github/copilot-instructions.md](.github/copilot-instructions.md) の R-001 / LL-001)。

### 1. Cloudflare Pages (サイトビルド + デプロイ)

**本番 URL**: https://techdb.studio344.net/

Pages プロジェクトは Cloudflare dashboard で **Create application** → **Pages** → **Import an existing Git repository** から作成します (現行プロジェクトは構築済み)。

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

custom domain `techdb.studio344.net` は新プロジェクトに移行済みです。再構築が必要な場合のみ、API token (`Pages Write`) で同じ設定を再現できます。

```bash
export CLOUDFLARE_ACCOUNT_ID=0438e47e5e23f7acd006da2e594f3559

curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tech-dashboard",
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

curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/tech-dashboard/domains" \
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

# KV ネームスペース (構築済み: id=6d67debb991742efadfec473a121f5fc)
# 新規環境では: npx wrangler kv namespace create SUMMARY_CACHE
# → 出力された id を worker/wrangler.toml の [[kv_namespaces]] id に反映

# シークレット登録 (インタラクティブ入力)
npx wrangler secret put COPILOT_PAT             # Copilot Enterprise 権限付き Classic PAT
npx wrangler secret put GH_TOKEN                # Contents:Write 権限の Fine-grained PAT

# デプロイ (Cron トリガを含む)
npx wrangler deploy
```

Cron は `0 * * * *` (毎時) で起動します。Cloudflare Free Workers の subrequest 上限 50/run に収めるため、50 ソースを 4 バッチに分割しローテーションしており、**個別ソースの再収集は 4 時間ごと**となります。各 run で `SUMMARIZE_MAX_NEW=5` の新規要約と最大 4 件の og:image 取得を行い、差分があれば `data/index.json` を GitHub に commit → Cloudflare Pages Git Integration が Pages を自動的に再デプロイします。

**手動トリガ** (緊急で回したい時):

```bash
curl -X POST "https://tech-dashboard-harness.<your-subdomain>.workers.dev/run" \
  -H "x-trigger-token: <GH_TOKEN と同じ値>"
```

レスポンスは `202 Accepted` が即座に返り、実処理は `ctx.waitUntil` でバックグラウンド実行。進行状況は GitHub のコミット履歴 (`tech-dashboard-worker` 作成者) または Cloudflare ダッシュボードの Worker Logs で確認できます。

#### Worker コードの自動デプロイ (pre-push hook)

Worker は Cloudflare Pages Git Integration の対象外のため、`worker/src/**` を変更したら `wrangler deploy` が必要です。`scripts/git-hooks/pre-push` がこれを自動化します。クローン後 1 度だけ:

```bash
bash scripts/install-hooks.sh
```

これ以降、`main` への push に worker/ 差分があれば自動で `npx wrangler@4.85.0 deploy` が走ります。スキップしたい場合は `SKIP_WORKER_DEPLOY=1 git push`。

#### 監視 / ヘルスチェック

Worker は実行ごとに `data/index.json` の `health` フィールドにメタデータ (`lastRunAt` / `batchIndex` / `sourcesOk` / `sourcesFailed[]` / `copilotOk` / `copilotError` / `summarized` / `ogCached` 等) を埋め込みます。サイトの [https://techdb.studio344.net/status/](https://techdb.studio344.net/status/) 上部の **Worker Health** セクションで一目で確認できます。状態は以下のラベルで表示されます。

- `healthy` — 直近 6h 以内に成功 / Copilot OK / 失敗 source なし
- `summarize disabled` — Copilot PAT 失効など (収集自体は継続)
- `no run in 6h+` — Worker が連続で停止
- `(N) source error` — 個別ソース fetch 失敗

外部通知 (Slack / Discord / Email) は使わず、サイト内完結。

### 3. 自動化サマリ

| 領域 | 仕組み | 頻度 / トリガ |
|---|---|---|
| データ収集 + 要約 + og:image | Cloudflare Worker (cron) | 毎時 (50 sources を 4 batch ローテーション) |
| GitHub commit | Worker → GitHub Contents API | 差分時のみ |
| サイト build / deploy | Cloudflare Pages Git Integration | `main` push を検知 |
| Worker コード deploy | `scripts/git-hooks/pre-push` | `main` push に worker/ 差分があれば自動 |
| ヘルス監視 | `data/index.json#health` + `/status` ページ | 実行ごと記録、サイト訪問時に確認 |

**残る手動運用**: 年 1 回の PAT 更新 (`wrangler secret put COPILOT_PAT` / `GH_TOKEN`)。失効時は `/status` の Worker Health が `summarize disabled` に変わるので即気付けます。

### 4. Cloudflare MCP サーバー (任意)

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
│  ├─ registry.ts            # ソース定義テーブル (50 ソース)
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
│  │  ├─ components/{Sidebar,EntryCard,DailySummary,DayDigest,TickerBar,TrendChart,Pager,CompactRow,CategoryHero}.astro
│  │  ├─ lib/data.ts         # data/index.json を型付きで読み込む
│  │  ├─ lib/source-meta.ts  # web 自己完結用の sources メタ複製 (R-005)
│  │  ├─ lib/site.ts         # canonical URL 単一情報源 (R-004)
│  │  ├─ styles/portal.css   # 全 CSS (モバイル最適化済み)
│  │  └─ pages/
│  │     ├─ index.astro      # ポータルトップ (Top-3 メダル / DailySummary 等)
│  │     ├─ c/[slug].astro   # カテゴリ別 (14 ページ)
│  │     ├─ t/[tag].astro    # タグ別
│  │     ├─ sources.astro, about.astro, status.astro, categories.astro
│  │     └─ {rss.xml,feed.json}.ts  # RSS 2.0 / JSON Feed 1.1
│  ├─ .node-version          # Cloudflare Pages build 用 Node 22 ピン
│  └─ astro.config.mjs
├─ .claude/skills/
│  └─ quality-audit/         # 品質監査スキル (SKILL.md + run.ts)
├─ worker/                   # Cloudflare Worker (定期ハーネス実行)
│  ├─ src/index.ts           # Cron 起動 → 収集 (4 batch ローテーション) → Copilot 要約 → og:image → GitHub commit
│  ├─ wrangler.toml          # Workers 設定 (Cron / KV / Vars)
│  └─ package.json
├─ scripts/
│  ├─ backfill-og.mjs        # data/index.json の og:image を一括バックフィル
│  └─ setup-copilot-auth.sh  # Copilot Enterprise PAT セットアップ
└─ data/                     # 成果物 (git-as-DB)
   ├─ index.json             # サイト配信用 (最新 500 件 / og:image 付き)
   ├─ raw/                   # 生データ (.gitignore, 監査用ローカル保持)
   ├─ _runs/                 # 実行レポート + 監査レポート (.gitignore)
   ├─ _summary-cache.json    # ローカル要約キャッシュ (.gitignore、Worker では KV を使用)
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

