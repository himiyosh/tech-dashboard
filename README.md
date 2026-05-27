# Tech Dashboard - AI Ecosystem Update Portal

AI 関連アップデート (Copilot / Claude / Codex / Gemini / Cursor / Cline / Aider / VSCode / OpenCode / Local LLM / Agent FW / MCP / Tech News / Research の **14 カテゴリ**) を **一括で追跡** できるポータルサイト。Harness Engineering のプラクティスに沿って、AI エージェントが自律的に情報収集・正規化・公開を行う。

**現状**: 51 ソースを登録し、Cloudflare Worker は `user-opml` を除く 50 ソース (Tier 1 / 2 / 3) を **毎時自動収集** (50 ソースを 4 バッチに分割し各ソースは 4 時間ごとに更新)、Astro 静的サイト生成、RSS/JSON Feed 配信、Cloudflare Queue 分離の GitHub Copilot Enterprise (Claude Sonnet 4.6) 要約パイプライン、Pagefind 全文検索、品質監査 Skill、AI Scrum 開発運用 Skill、UI 表示ガード Skill、Modern Web Guidance Skill、og:image 自動取得 (KV キャッシュ) まで動作可能です。

## 🔭 運用ステータス早見表 (Single Source of Truth)

「いま何が自動で動いていて、何が手動か」をここで一目で把握できるようにします。詳細手順は後段の各セクションを参照。

### 自動化されている処理

| 処理 | 実行主体 | トリガ | 失効時の影響 | 監視 |
|---|---|---|---|---|
| ソース収集 (50 sources) | Cloudflare Worker `tech-dashboard-harness` | Cron `0 * * * *` (毎時) を 4 batch ローテーション | データ更新が止まる | `/status` の Worker Health |
| 日本語/英語要約 (`summary*` / `body*`) | Worker → Queue `tech-dashboard-summarizer` → Copilot Enterprise (claude-sonnet-4.6) | cron 後に最大 `ENQUEUE_MAX_NEW=35` 件/run を投入、consumer は 1 message/invocation | 既存表示は維持。LLM 失敗時は deterministic fallback で空欄を防止 | `health.fallbackTotal` / `health.summaryQueueBacklog` / `health.summaryQueueDrainEstimateHours` |
| summary/body deterministic fallback | 同 Worker / `scripts/apply-summary-cache.mjs` | Worker commit 前、または緊急修復時 | LLM timeout / 旧 cache 欠落時でも live index の summary/body 欠落を防止 | `health.summaryFallbacks` / `health.bodyFallbacks` / `tests/data-schema.test.ts` |
| og:image 取得 | 同 Worker | 上記 cron 内で最大 4 件/h、KV にキャッシュ | サムネが no-image fallback になる | `health.ogCached` |
| `data/index.json` / `data/archive/*` / `data/stats.json` 更新 commit | Worker → GitHub Git Data API (`tech-dashboard-worker` 名義) | 差分があるときのみ 1 commit にまとめる | サイトに反映されない、記事数推移が古いまま | `git log --author=tech-dashboard-worker` |
| サイト build / deploy | Cloudflare Pages (Git Integration) | `main` の push 検知 | サイトが古いまま | Cloudflare Pages dashboard |
| Worker コード deploy 補助 | `scripts/git-hooks/pre-push` | `RUN_WORKER_DEPLOY=1 git push` かつ `main` push に `worker/` 差分あり | Worker 側のロジック修正が反映されない | push 時の出力 / `wrangler deployments list` |

### 手動運用 (年 1 回程度)

| 作業 | コマンド | 期日の気付き方 |
|---|---|---|
| `COPILOT_PAT` 更新 | `cd worker && npx wrangler secret put COPILOT_PAT` | `/status` Worker Health が `summarize disabled` |
| `GH_TOKEN` 更新 | `cd worker && npx wrangler secret put GH_TOKEN` | Worker run で push 失敗 → commit 履歴が止まる |
| (緊急) 手動収集 | `npm run collect` | バックログ滞留時 (例: 1h に 5 件以上の新着) |
| (緊急) cache 済み要約/本文の再反映 | `npm run summaries:apply-cache` | `data/_summary-cache.json` には body があるのに `data/index.json` 側が空の時 |
| (緊急) summary/body 欠落の deterministic 補完 | `npm run summaries:apply-cache -- --fill-missing-body` | LLM backfill が詰まり、cache が無い entry も含めて `data/index.json` の空欄を確実に埋めたい時 |
| (緊急) 不足要約/本文のバルク補充 | `SUMMARIZE_MAX_NEW=400 npx tsx --env-file-if-exists=.env.local scripts/resummarize.mjs` | 過去エントリの `summaryJa` / `bodyJa` / `bodyEn` がまとめて欠けている時 |
| (緊急) og:image バックフィル | `node scripts/backfill-og.mjs` | `image.source = "fallback"` が大量に残る時 |
| (緊急) リリースタイトル整形バックフィル | `node --experimental-strip-types scripts/backfill-release-titles.mjs` | バージョン番号のみのタイトルを補正したい時 |

### 構成情報の SoT (Source of Truth)

| 種別 | 場所 |
|---|---|
| 絶対ルール / Pages 設定値 / LL | [.github/copilot-instructions.md](.github/copilot-instructions.md) |
| 自動化アーキテクチャ決定の経緯 | `/memories/repo/automation-decision.md` |
| Worker cron / batch / KV id | [worker/wrangler.toml](worker/wrangler.toml) |
| サイト URL (canonical) | [web/src/lib/site.ts](web/src/lib/site.ts) |
| ソース定義 (50 件) | [harness/registry.ts](harness/registry.ts) |
| カテゴリ / 型定義 | [harness/types.ts](harness/types.ts) |

### データフロー (1 図に集約)

```
                ┌───────────────────────────────────────────────┐
                │ Cloudflare Worker (cron: hourly, 4 batch)    │
                │  ├ collect (RSS/Atom/HTML, ~13 sources/run)  │
                │  ├ normalize + dedupe + tag                  │
                │  ├ enqueue summaries (Queue, ≤35/run)        │
                │  └ og:image fetch (≤4/run, KV cache)         │
                └───────────────┬───────────────────────────────┘
                                │ diff があれば
                                ▼
                  GitHub Git Data API → himiyosh/tech-dashboard:main
                  (1 commit / commit 名義: tech-dashboard-worker)
                                │
                                ▼
              Cloudflare Pages Git Integration が build (root=web)
                                │
                                ▼
                   https://techdb.studio344.net/  (本番)
                   https://tech-dashboard-6a7.pages.dev/
```

> **デプロイは GitHub Actions を使いません。** Pages deploy も harness 実行も Cloudflare 内で完結します ([.github/copilot-instructions.md](.github/copilot-instructions.md) R-001 参照)。
> `.github/workflows/ci.yml` は **テスト目的のみ** の workflow で、デプロイは行いません。

## ドキュメント構成

| #   | ドキュメント                                                            | 概要                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 00  | [Harness Engineering リサーチ](docs/00-research-harness-engineering.md) | Anthropic / OpenAI の原典を元にした原則整理  |
| 01  | [システム設計書](docs/01-architecture.md)                               | アーキテクチャ・データモデル・データフロー   |
| 02  | [Agent / Skill / Hook / Prompt 構成](docs/02-agents-skills-hooks.md)    | ハーネスの内部構成と責務分割                 |
| 03  | [UI/UX デザイン案](docs/03-design-mockup.md)                            | 画面構成・ワイヤーフレーム・デザイントークン |
| SPEC | [本番サイト仕様 (現状)](docs/SPEC.md)                                | 14 カテゴリ / 51 登録ソース / 本番反映済みの仕様 |
| 04  | [サイト仕様書 v1.0 (草案)](docs/04-site-spec.md)                        | 計画段階の草案 (現状は SPEC.md が正)         |
| 05  | [AI Scrum Harness 適用設計](docs/05-ai-scrum-harness.md)                | Orchestrator / サブエージェント運用方針      |
| 02c | [ユーザカスタマイズ](docs/02-customization.md)                          | OPML / YouTube / HN クエリの追加方法         |

モック: [`docs/mockups/`](docs/mockups/) (mockup-D が確定デザイン)

## クイックスタート

```bash
# ============ 初回セットアップ ============
npm install                  # ルート依存
bash scripts/install-hooks.sh # pre-commit / pre-push hook (secret scan / typecheck / test / web build / worker deploy 補助) を有効化

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

# ============ AI Scrum 開発運用 ============
# Claude Code / Copilot Agent から /skill ai-scrum を実行

# ============ UI 表示ガード ============
# Claude Code / Copilot Agent から /skill ui-display-guard を実行

# ============ Modern Web Guidance ============
# 初回導入 / 更新: developer.chrome.com/docs/modern-web-guidance の推奨 CLI
npx -y modern-web-guidance@latest install

# HTML / CSS / client-side JS / アクセシビリティ / パフォーマンス / セキュリティの変更前に Chrome の最新ガイドを検索
npx -y modern-web-guidance@latest search "optimize LCP image priority" --skill-version 2026_05_16-c5e7870
npx -y modern-web-guidance@latest retrieve "optimize-image-priority"
# 広めの UI 変更では基礎 guide も先に確認する
npx -y modern-web-guidance@latest retrieve "accessibility,css,performance,security"
```

### 品質ゲート: テスト & Git Hooks

実装変更で壊しやすい箇所を 3 層で守ります。

| 層 | コマンド | 内容 | 速度 |
|---|---|---|---|
| Typecheck | `npm run typecheck` | TypeScript 型チェック | 速い |
| Worker Typecheck | `npm --prefix worker run typecheck && npm --prefix worker-summarizer run typecheck` | Cloudflare Worker / Queue consumer の型チェック | 速い |
| Unit | `npm test` | Vitest による関数単位の検証 (要約 JSON パース、Web ロジック、`data/index.json` スキーマ) | 速い (~1s) |
| Web build | `npm run build:web` | Cloudflare Pages と同じ `web` build (`astro build && pagefind --site dist`) を検証 | 中程度 |
| E2E | `npm run test:e2e` | Playwright (Chromium) でトップ表示・記事詳細・言語切替を検証 | 中程度 (~30s + build) |
| Secret scan | `npm run secrets:scan` | tracked file の secret / private key / 高リスクファイル名を検証 | 速い |
| Worktree secret scan | `npm run secrets:scan:worktree` | tracked + untracked non-ignored file を検証し、ignored local secret store は値を読まず path だけ警告 | 速い |
| Dependency audit | `npm run audit:all` | root / web の npm advisory を確認。既知 advisory がある間は CI では soft gate として扱う | 速い |
| 全部 | `npm run test:all` | Typecheck → Unit → Web build → E2E をまとめて実行 | |

Git hook は `bash scripts/install-hooks.sh` で 1 回有効化します。

`npm test` は `web/src/lib/*` を import するテストを含むため、`web/node_modules` が無い場合は `scripts/ensure-web-deps.mjs` が自動で `npm --prefix web ci` を実行します。これにより fresh clone 直後でも root 側の unit test が CI と同じ前提で動きます。

| Hook | 実行内容 | スキップ |
|---|---|---|
| `pre-commit` | staged file の secret scan → `.ts/.tsx` がステージされていれば `npm run typecheck` | Typecheck のみ `SKIP_TYPECHECK=1 git commit` |
| `pre-push` | push 対象 commit range の secret scan → `npm test` (unit) → `npm run build:web` → `npm run test:e2e` → `RUN_WORKER_DEPLOY=1` の場合のみ `wrangler deploy` | `SKIP_TESTS=1` / `SKIP_WEB_BUILD=1` / `SKIP_E2E=1`。Worker deploy は `RUN_WORKER_DEPLOY=1 git push` |

Secret scan は値を表示せず、検出種別・ファイル位置・ハッシュだけを出します。ローカル作業ツリー全体を確認する場合は `npm run secrets:scan:worktree`、全履歴を手動確認する場合は `npm run secrets:scan:history` を使います。

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) は **検証目的のみ**で、デプロイは行いません。push / PR ごとに dependency audit (soft gate) + `typecheck + npm test + npm run build:web + npm run test:e2e` を実行し、Cloudflare Pages の build 失敗を事前に検知します。

現時点の dependency audit 既知事項:

| 範囲 | Advisory | 対応方針 |
|---|---|---|
| root | `fast-xml-parser <5.7.0` moderate | v5 は breaking change のため、collector parser 互換性を確認して別 PR で更新 |
| web | `astro <=6.1.9` moderate / `devalue 5.6.3-5.8.0` high | Astro 6 への major upgrade と build/E2E 回帰確認を別 PR で実施 |

### 環境変数 (要約パイプライン)

要約は **GitHub Copilot Enterprise** の Chat Completions API 経由で Claude Sonnet 4.6 を呼び出します (GitHub Models とは別体系)。本番 Worker は収集と publish に専念し、Queue consumer (`worker-summarizer/`) が 1 entry ずつ要約します。

```bash
# ローカル実行用 (いずれか片方)
COPILOT_PAT=ghp_...               # PAT → 一時トークン交換を自動で行う
COPILOT_TOKEN=tid=...              # 既に交換済みの一時トークンを直接注入する場合

# モデル切替 (要約 / 補完 backfill で利用可能なのは claude-sonnet-4.6 / claude-opus-4.7 のみ)
SUMMARIZE_MODEL=claude-sonnet-4.6   # 既定 (速度優先、Worker wall-time に収まる)
# SUMMARIZE_MODEL=claude-opus-4.7   # 品質優先。長文生成は wall-time に収まらない場合あり (LL-031)
# SUMMARIZE_MODEL=gpt-5.5            # Copilot では /responses 専用のため現 Worker (/chat/completions) からは利用不可 (LL-010)
ENQUEUE_MAX_NEW=35                 # Worker 1 run 当たりの Queue 投入上限
SUMMARIZE_TIMEOUT_MS=28000          # summarizer Worker の Copilot timeout
SUMMARIZE_MAX_TOKENS=1600           # summarizer Worker 用の短い JSON 完走予算
```

> どのトークンも無ければ要約フェーズは自動でスキップされます (ローカル dev を妨げない設計)。

## デプロイ & 自動更新 (Cloudflare Worker + Cloudflare Pages Git Integration)

通常運用は Cloudflare 内で完結します。Cloudflare Worker が `data/index.json`、`data/archive/*`、`data/stats.json` を GitHub に commit し、Cloudflare Pages の Git Integration が `main` の更新を検知してサイトを build / deploy します。

```
[Cloudflare Worker Cron] ──毎時 (4 batch ローテーション)──→ [GitHub Git Data API]
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

Cron は `0 * * * *` (毎時) で起動します。Cloudflare Workers の subrequest 上限に収めるため、50 ソースを 4 バッチに分割しローテーションしており、**個別ソースの再収集は 4 時間ごと**となります。Worker は収集・正規化・fallback・publish に専念し、要約不足 entry を最大 `ENQUEUE_MAX_NEW=35` 件/run だけ Cloudflare Queue へ投入します。Copilot 要約は `worker-summarizer/` が 1 message / invocation で生成し、per-URL KV cache に保存します。Queue consumer は Worker の 28 秒 timeout 内で JSON が閉じるよう、短めの bilingual summary/body contract (`SUMMARIZE_MAX_TOKENS=1600`) を使います。Copilot 要約が timeout / error になった entry には commit 前に deterministic summary/body fallback を適用し、差分があれば `data/index.json`、`data/archive/*`、`data/stats.json` を Git Data API で 1 commit にまとめます。Cloudflare Pages Git Integration はその commit を検知して Pages を自動的に再デプロイします。トップページの記事数推移は `data/stats.json` を優先して参照するため、`data/index.json` の上限や dropped tier による削除後も archive 由来の集計を保持できます。

Copilot 要約は summarizer Worker 側の `SUMMARIZE_TIMEOUT_MS` (既定 28000 ms) で timeout します。Queue retry と次回 cron の cache 再読みにより、一時的な API timeout / 5xx による欠落を次 run へ持ち越しにくくしています。

**手動トリガ** (緊急で回したい時):

```bash
curl -X POST "https://tech-dashboard-harness.<your-subdomain>.workers.dev/run" \
  -H "x-trigger-token: <GH_TOKEN と同じ値>"
```

レスポンスは `202 Accepted` が即座に返り、実処理は `ctx.waitUntil` でバックグラウンド実行。進行状況は GitHub のコミット履歴 (`tech-dashboard-worker` 作成者) または Cloudflare ダッシュボードの Worker Logs で確認できます。

#### Worker コードの明示デプロイ (pre-push hook)

Worker は Cloudflare Pages Git Integration の対象外のため、`worker/src/**` を変更したら `wrangler deploy` が必要です。`scripts/git-hooks/pre-push` は品質ゲートを通したうえで、明示指定された場合だけ deploy します。クローン後 1 度だけ:

```bash
bash scripts/install-hooks.sh
```

Worker を反映する push では、`RUN_WORKER_DEPLOY=1 git push` を使います。`main` への push に `worker/` 差分がある場合だけ `npx wrangler@4.85.0 deploy` が走ります。通常の push では worker deploy は実行されません。

#### 監視 / ヘルスチェック

Worker は実行ごとに `data/index.json` の `health` フィールドにメタデータ (`lastRunAt` / `batchIndex` / `sourcesOk` / `sourcesFailed[]` / `copilotOk` / `fallbackTotal` / `queueMode` / `enqueueCandidates` / `summaryQueueBacklog` / `summaryQueueDrainEstimateHours` / `summaryFallbacks` / `bodyFallbacks` / `ogCached` 等) を埋め込みます。サイトの [https://techdb.studio344.net/status/](https://techdb.studio344.net/status/) 上部の **Worker Health** セクションで一目で確認できます。状態は以下のラベルで表示されます。

- `healthy` — 直近 6h 以内に成功 / Copilot OK / 失敗 source なし
- `summarize disabled` — Copilot PAT 失効など (収集自体は継続)
- `no run in 6h+` — Worker が連続で停止
- `(N) source error` — 個別ソース fetch 失敗

外部通知 (Slack / Discord / Email) は使わず、サイト内完結。

### 3. 自動化サマリ

| 領域 | 仕組み | 頻度 / トリガ |
|---|---|---|
| データ収集 + Queue 要約 + og:image | Cloudflare Worker cron + `worker-summarizer` Queue consumer | 毎時 (50 sources を 4 batch ローテーション、要約は最大 35 件/run を Queue 投入) |
| GitHub commit | Worker → GitHub Git Data API | `data/index.json` / `data/archive/*` / `data/stats.json` を 1 commit にまとめる |
| サイト build / deploy | Cloudflare Pages Git Integration | `main` push を検知 |
| Worker コード deploy | `scripts/git-hooks/pre-push` | `RUN_WORKER_DEPLOY=1 git push` かつ `main` push に worker/ 差分あり |
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
├─ skills-lock.json          # skills CLI が管理する Modern Web Guidance の導入 lock
├─ docs/                     # 設計ドキュメント
│  └─ mockups/               # HTML モック (mockup-D が確定)
├─ harness/                  # ハーネス本体 (TypeScript)
│  ├─ orchestrator.ts        # 外側ループ (並列 collect → normalize → dedupe → tag → summarize → publish)
│  ├─ registry.ts            # ソース定義テーブル (51 登録ソース / 50 fetch 対象)
│  ├─ types.ts               # 共通型 (Category / NormalizedEntry / SourceDefinition)
│  ├─ collectors/
│  │  ├─ rss.ts              # 汎用 RSS/Atom/RDF コレクター
│  │  ├─ vscode-updates.ts   # VS Code Atom feed collector
│  │  ├─ anthropic.ts        # Anthropic News / Engineering HTML スクレイパー
│  │  ├─ hn-algolia.ts       # Hacker News Algolia API
│  │  ├─ opml.ts             # ユーザ OPML インポート
│  │  └─ youtube.ts          # YouTube チャンネル RSS
│  ├─ pipeline/
│  │  ├─ normalize.ts        # RawEntry → NormalizedEntry
│  │  ├─ dedupe.ts           # URL 正規化ベース重複排除
│  │  ├─ tag.ts              # キーワードベースのタグ補完
│  │  └─ summarize.ts        # 許可モデルによる要約 + 重要度判定 (API キー任意)
│  └─ publishers/
│     ├─ index-builder.ts    # data/index.json & raw スナップショット
│     ├─ archive-builder.ts  # data/archive/*.json と archive index
│     ├─ archive-core.ts     # Worker / Node 共有の archive 純粋ロジック
│     ├─ stats-builder.ts    # data/stats.json
│     └─ stats-core.ts       # Worker / Node 共有の stats 純粋ロジック
├─ web/                      # Astro 静的サイト
│  ├─ src/
│  │  ├─ layouts/Portal.astro
│  │  ├─ components/{Sidebar,EntryCard,DailySummary,DayDigest,TickerBar,TrendChart,Pager,CompactRow,CategoryHero,LiveMetrics}.astro
│  │  ├─ lib/data.ts         # data/index.json を型付きで読み込む
│  │  ├─ lib/stats.ts        # data/stats.json を型付きで読み込む
│  │  ├─ lib/metrics.ts      # Timeline / About 用の自動更新 metrics SoT
│  │  ├─ lib/freshness.ts    # source type 別 freshness 判定 (UI / quality-audit 共有)
│  │  ├─ lib/source-meta.ts  # web 自己完結用の sources メタ複製 (R-005)
│  │  ├─ lib/site.ts         # canonical URL 単一情報源 (R-004)
│  │  ├─ styles/portal.css   # 全 CSS (モバイル最適化済み)
│  │  └─ pages/
│  │     ├─ index.astro      # ポータルトップ (Top-3 メダル / DailySummary 等)
│  │     ├─ c/[slug].astro   # カテゴリ別 (14 ページ)
│  │     ├─ t/[tag].astro    # タグ別
│  │     ├─ status.astro, categories.astro, about.astro, sources.astro (redirect)
│  │     └─ {rss.xml,feed.json,metrics.json}.ts  # RSS / JSON Feed / 表示 metrics
│  ├─ .node-version          # Cloudflare Pages build 用 Node 22 ピン
│  └─ astro.config.mjs
├─ .claude/skills/
│  ├─ ai-scrum/             # AI Scrum 開発運用スキル (SKILL.md)
│  ├─ quality-audit/         # 品質監査スキル (SKILL.md + run.ts)
│  ├─ ui-display-guard/      # モバイル/レスポンシブ UI 表示ガードスキル (SKILL.md)
│  └─ modern-web-guidance/   # Chrome Modern Web Guidance 検索スキル (SKILL.md + guides)
├─ worker/                   # Cloudflare Worker (定期ハーネス実行)
│  ├─ src/index.ts           # Cron 起動 → 収集 (4 batch ローテーション) → Copilot 要約 → og:image → GitHub atomic commit
│  ├─ wrangler.toml          # Workers 設定 (Cron / KV / Vars)
│  └─ package.json
├─ scripts/
│  ├─ backfill-og.mjs                  # data/index.json の og:image を一括バックフィル
│  ├─ backfill-release-titles.mjs      # version-only タイトル ("v3.8.0" 等) に source 名を前置
│  ├─ apply-summary-cache.mjs          # data/_summary-cache.json の要約/本文を data/index.json に再反映、必要時は deterministic body fallback
│  ├─ resummarize.mjs                  # 既存エントリの不足要約/本文を Copilot で一括補充 (緊急用)
│  ├─ scan-secrets.mjs                 # redacted secret scanner (current / staged / history / range)
│  ├─ install-hooks.sh                 # repo-managed git hooks 有効化
│  ├─ git-hooks/pre-commit             # staged secret scan + TypeScript 型チェック
│  ├─ git-hooks/pre-push               # push range secret scan + quality gate + opt-in worker deploy
│  └─ setup-copilot-auth.sh            # Copilot Enterprise PAT セットアップ
└─ data/                     # 成果物 (git-as-DB)
  ├─ index.json             # サイト配信用 (最新 2000 件 / og:image 付き)
  ├─ stats.json             # archive 込みの記事数推移 / source 集計
  ├─ archive/               # warm/cold tier の月別永続 archive
   ├─ raw/                   # 生データ (.gitignore, 監査用ローカル保持)
   ├─ _runs/                 # 実行レポート + 監査レポート (.gitignore)
   ├─ _summary-cache.json    # ローカル要約キャッシュ (.gitignore、Worker では KV を使用)
   └─ user-opml.xml          # ユーザ個別 OPML (.gitignore)
```

`tests/data-schema.test.ts` は data artifact のサイズ予算も検証します。現在の上限は `data/index.json` 8 MB、`data/stats.json` 500 KB、archive 月別 JSON 2 MB です。本文生成が増えた場合でも、build と GitHub API payload の肥大化を test gate で検知します。

## フェーズ進捗

| フェーズ                 | 内容                                              | 状態   |
| ------------------------ | ------------------------------------------------- | ------ |
| P0 設計                  | ドキュメント群 + サイト仕様 v1.0                  | ✅ 完了 |
| P1 MVP                   | Tier 1 コア 15 ソース + Astro サイト + daily cron | ✅ 完了 |
| P2 Tier 2 + LLM          | Tier 2 残り + Claude Sonnet Queue 要約 + Pagefind 検索 | ✅ 完了 |
| P3 Feed + 監査           | RSS/JSON Feed + /status + quality-audit skill     | ✅ 完了 |
| P4 Tier 3 + カスタマイズ | HN / YouTube / OPML + ユーザカスタマイズ基盤      | ✅ 完了 |
