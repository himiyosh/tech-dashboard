# Tech Dashboard - AI Ecosystem Update Portal

AI 関連アップデート (Copilot / Claude / Codex / Gemini / Cursor / Cline / Aider / VSCode / OpenCode / Local LLM / Agent FW / MCP / Tech News / Research の **14 カテゴリ**) を **一括で追跡** できるポータルサイト。Harness Engineering のプラクティスに沿って、AI エージェントが自律的に情報収集・正規化・公開を行う。

**現状**: GitHub Actions の Node publisher が registry の有効 source を **毎時自動収集** (6 バッチローテーション) し、Cloudflare の OIDC bridge 経由で Queue / KV を利用します。Astro 静的サイト生成、全体 RSS (`/rss.xml`)・カテゴリ別 RSS (`/rss/<category>.xml`)・JSON Feed 配信、Cloudflare Queue 分離の GitHub Copilot Enterprise (Claude Sonnet 4.6) 要約パイプライン、Pagefind 全文検索、品質監査 Skill、AI Scrum 開発運用 Skill、UI 表示ガード Skill、Modern Web Guidance Skill、og:image 自動取得 (KV キャッシュ) まで動作可能です。現在の source 件数・coverage は `/status` を単一情報源として確認してください。

## 🔭 運用ステータス早見表 (Single Source of Truth)

「いま何が自動で動いていて、何が手動か」をここで一目で把握できるようにします。詳細手順は後段の各セクションを参照。

### 自動化されている処理

| 処理 | 実行主体 | トリガ | 失効時の影響 | 監視 |
|---|---|---|---|---|
| ソース収集 (registry sources) | GitHub Actions `Publisher` (Node 22) | Cron `0 * * * *` (毎時) を 6 batch ローテーション | データ更新が止まる。runtime fingerprint または snapshot 不一致時は publish を自動停止 | Publisher workflow / `/status` |
| 日本語/英語要約 (`summary*`) | Publisher → OIDC bridge → Queue `tech-dashboard-summarizer` → Copilot Enterprise (claude-sonnet-4.6) | 検証済み publish 後に最大 `ENQUEUE_MAX_NEW` 件/run を投入、consumer は 1 message/invocation | 既存表示は維持。LLM 失敗時は deterministic fallback で空欄を防止 | `health.fallbackTotal` / `health.summaryQueueBacklog` / `health.summaryQueueDrainEstimateHours` |
| 記事本文 (`data/bodies.json`) | Publisher → OIDC bridge → Queue `tech-dashboard-body` → Copilot (claude-opus-4.8, reasoning=max) | 本文は index と分離 (LL-115)。evergreen、importance 2/3、直近 `BODY_RETENTION_DAYS` 日を retention 対象にし、さらに実運用の byte budget (`DEFAULT_BODY_BUDGET_TARGET_BYTES` = 9MB、`tests/data-schema.test.ts` の 10MB hard ceiling には 1MB の余裕) を必ず超えないよう importance 1 (直近のみ) → 2 → 3 → evergreen の順で最古から deterministic に prune する (evergreen は最優先=最後に prune、絶対的な免除ではない、LL-411)。consumer が JA/EN を 2 call で生成して publisher が sidecar へ merge | 対象外・budget 超過で prune・本文無しの記事は要約主役の表示にフォールバック (原文リンクは維持、偽の生成予告は出さない) | `health.bodyBacklog` / `health.bodyQueueDrainEstimateHours` / `health.bodiesTotal` / `health.bodyBudgetBytes` / `health.bodyBudgetTargetBytes` / `health.bodyBudgetPruned` |
| summary deterministic fallback | Publisher / `scripts/apply-summary-cache.mjs` | data commit 前、または緊急修復時 | LLM timeout / 旧 cache 欠落時でも live index の summary 欠落を防止 | `health.summaryFallbacks` / `tests/data-schema.test.ts` |
| og:image 取得 | Publisher → OIDC bridge → KV | 毎時最大 1 件。data 検証と push 成功後だけ `og.v1` を更新 | サムネが no-image fallback になる | `health.ogCached` |
| `data/index.json` / `data/archive/*` / `data/stats.json` 更新 commit | Publisher workflow → built-in `GITHUB_TOKEN` | 全品質ゲート後、差分があるときのみ data allowlist を 1 commit にまとめる | サイトに反映されない、記事数推移が古いまま | GitHub Actions `Publisher` |
| サイト build / deploy | Cloudflare Pages (Git Integration) | `main` の push 検知 | サイトが古いまま | Cloudflare Pages dashboard |
| Worker コード deploy 補助 | `scripts/git-hooks/pre-push` | `RUN_WORKER_DEPLOY=1 git push` かつ `main` push に `worker/` 差分あり | Worker 側のロジック修正が反映されない | push 時の出力 (deploy 成功後 `node scripts/verify-worker-deploy.mjs` で fingerprint 伝播を bounded polling 確認、非 blocking) |

### 手動運用 (年 1 回程度)

| 作業 | コマンド | 期日の気付き方 |
|---|---|---|
| `COPILOT_PAT` 更新 | `cd worker && npx wrangler secret put COPILOT_PAT` | `/status` Worker Health が `summarize disabled` |
| (緊急) 手動収集 | `npm run collect` | バックログ滞留時 (例: 1h に 5 件以上の新着) |
| (緊急) cache 済み要約の再反映 | `npm run summaries:apply-cache` | `data/_summary-cache.json` に有効な bilingual summary があるのに `data/index.json` 側が未反映の時 |
| (緊急) 不足要約のバルク補充 | `SUMMARIZE_MAX_NEW=400 npx tsx --env-file-if-exists=.env.local scripts/resummarize.mjs` | 過去エントリの `summaryJa` / `summaryEn` がまとめて欠けている時 |
| (migration) 旧 index 本文の sidecar 移行 | `npm run body:migrate` | `data/index.json` の旧 `bodyJa` / `bodyEn` を `data/bodies.json` へ移して index を本文フリーにする時 |
| (緊急) og:image バックフィル | `node scripts/backfill-og.mjs` | `image.source = "fallback"` が大量に残る時 |
| (緊急) リリースタイトル整形バックフィル | `node --experimental-strip-types scripts/backfill-release-titles.mjs` | バージョン番号のみのタイトルを補正したい時 |

### 構成情報の SoT (Source of Truth)

| 種別 | 場所 |
|---|---|
| 絶対ルール / Pages 設定値 / LL | [.github/copilot-instructions.md](.github/copilot-instructions.md) |
| 自動化アーキテクチャ決定の経緯 | `/memories/repo/automation-decision.md` |
| Publisher cron / quality gate | [.github/workflows/publisher.yml](.github/workflows/publisher.yml) |
| Free bridge / Queue / KV binding | [worker/wrangler.toml](worker/wrangler.toml) |
| サイト URL (canonical) | [web/src/lib/site.ts](web/src/lib/site.ts) |
| Sitemap の route 列挙 / protocol 上限 | [web/src/lib/sitemap.ts](web/src/lib/sitemap.ts) |
| ソース定義 (registry) | [harness/registry.ts](harness/registry.ts) |
| カテゴリ / 型定義 | [harness/types.ts](harness/types.ts) |

### データフロー (1 図に集約)

```
                ┌───────────────────────────────────────────────┐
               │ GitHub Actions Publisher (hourly, 6 batch)   │
               │  ├ immutable main SHA から baseline read     │
               │  ├ collect + normalize + dedupe + tag        │
               │  ├ build + unit + schema + E2E               │
               │  └ data-only non-force push                  │
                └───────────────┬───────────────────────────────┘
                               │ push 成功後だけ GitHub OIDC
                                ▼
                Cloudflare Free bridge → Queue / KV effects
                               │
                               ▼
                 himiyosh/tech-dashboard:main (1 data commit)
                               │
                               ▼
              Cloudflare Pages Git Integration が build (root=web)
                                │
                                ▼
                   https://techdb.studio344.net/  (本番)
                   https://tech-dashboard-6a7.pages.dev/
```

> **デプロイは GitHub Actions から行いません。** Publisher workflow は data の収集、検証、commit と OIDC bridge 経由の Queue / KV effects だけを担当し、Pages deploy は Cloudflare Pages Git Integration が行います ([.github/copilot-instructions.md](.github/copilot-instructions.md) R-001 参照)。
> `.github/workflows/ci.yml` は **テスト目的のみ** で、Publisher workflow も Pages / Worker の deploy は行いません。

## ドキュメント構成

| #   | ドキュメント                                                            | 概要                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------- |
| PRODUCT | [プロダクト基準](PRODUCT.md)                                        | 5 分以内の読む・共有判断と WCAG 2.2 AA の成功基準 |
| CHANGELOG | [変更履歴](CHANGELOG.md)                                           | 利用者向け・データ・運用基盤の主要な変更履歴 |
| 00  | [Harness Engineering リサーチ](docs/00-research-harness-engineering.md) | Anthropic / OpenAI の原典を元にした原則整理  |
| 01  | [システム設計書](docs/01-architecture.md)                               | アーキテクチャ・データモデル・データフロー   |
| 02  | [Agent / Skill / Hook / Prompt 構成](docs/02-agents-skills-hooks.md)    | ハーネスの内部構成と責務分割                 |
| 03  | [UI/UX デザイン案](docs/03-design-mockup.md)                            | 画面構成・ワイヤーフレーム・デザイントークン |
| SPEC | [本番サイト仕様 (現状)](docs/SPEC.md)                                | カテゴリ/ソース/表示仕様の現行定義 (`/status` と registry を併読) |
| 04  | [サイト仕様書 v1.0 (草案)](docs/04-site-spec.md)                        | 計画段階の草案 (現状は SPEC.md が正)         |
| 05  | [AI Scrum Harness 適用設計](docs/05-ai-scrum-harness.md)                | Orchestrator / サブエージェント運用方針      |
| 06  | [Worker 分割設計](docs/06-worker-split-design.md)                       | Free publisher、OIDC bridge、Queue 分離、publisher contract |
| 02c | [ユーザカスタマイズ](docs/02-customization.md)                          | OPML / YouTube / HN クエリの追加方法         |

モック: [`docs/mockups/`](docs/mockups/) (mockup-D が確定デザイン)

## クイックスタート

```bash
# ============ 初回セットアップ ============
npm install                  # ルート依存
bash scripts/install-hooks.sh # pre-commit / pre-push hook (secret scan / typecheck / test / web build / worker deploy 補助) を有効化

# ============ ハーネス (ルート) ============
npm run typecheck            # 型チェック
npm run collect              # registry の有効 source を収集 → data/index.json 生成
npm run collect:dry          # ドライラン (ファイル書き込みなし)
npm run publisher:contract -- --dry-run # harness runtime fingerprint の同期確認

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
| Worker Typecheck | `npm --prefix worker run typecheck && npm --prefix worker-summarizer run typecheck && npm --prefix worker-body run typecheck` | Cloudflare Worker / Queue consumer の型チェック | 速い |
| Unit | `npm test` | Vitest による関数単位の検証 (要約 JSON パース、Web ロジック、`data/index.json` スキーマ) | 速い (~1s) |
| Independent review | `npm run check:independent-review -- --repo <owner/name> --pr <number> --head <sha> --merger-session <uuid> --reviewer-session <uuid>` | 現在openのPR、exact head、外部reviewer、統括session、厳格なmarkerをREST evidenceで検証 | 速い |
| Web build | `npm run build:web` | Cloudflare Pages と同じ Astro + Pagefind build を実行し、30秒 heartbeat、phase別 CPU/RSS、route/file数、3,200 HTML route上限に加えて sitemap と canonical HTML の双方向 parity、redirect 除外、標準 HTML parser で各 HTML route を基準に解決した存在しない内部 detail link 0 件を検証 | 中程度 |
| E2E | `npm run test:e2e` | Playwright (Chromium) でトップ表示・記事詳細・言語切替を検証 | 中程度 (~30s + build) |
| 5分判断ジャーニー | `node --import tsx scripts/measure-decision-journey.ts` | production Web buildを1回だけ生成してPlaywright previewへ再利用し、desktop/mobileのHome判断面、exact検索または正直な0件回復、RSS/OPML発見、実404回復、optionalな要約待ち状態を計測。stdoutは64KiB以下のJSON、build/test logはstderr。`fieldData:false`のローカル合成値であり、field dataやCore Web Vitalsではありません。検証済みの`web/dist`を再利用する場合だけ`--reuse-build`を指定 | 中程度 |
| Secret scan | `npm run secrets:scan` | tracked file の secret / private key / 高リスクファイル名を検証 | 速い |
| Worktree secret scan | `npm run secrets:scan:worktree` | tracked + untracked non-ignored file を検証し、ignored local secret store は値を読まず path だけ警告 | 速い |
| Dependency audit | `npm run audit:all` | root / web の npm advisory を確認。既知 advisory がある間は CI では soft gate として扱う | 速い |
| 全部 | `npm run test:all` | Typecheck → Unit → Web build → E2E をまとめて実行 | |

Git hook は `bash scripts/install-hooks.sh` で 1 回有効化します。

`npm test` は `web/src/lib/*` を import するテストを含むため、`web/node_modules` が無い場合は `scripts/ensure-web-deps.mjs` が自動で `npm --prefix web ci` を実行します。これにより fresh clone 直後でも root 側の unit test が CI と同じ前提で動きます。

| Hook | 実行内容 | スキップ |
|---|---|---|
| `pre-commit` | `main` / `master` / `develop` への直接 commit 拒否 → staged file の secret scan → `.ts/.tsx` がステージされていれば `npm run typecheck` | Typecheck のみ `SKIP_TYPECHECK=1 git commit` |
| `pre-push` | protected branch への直接 push 拒否 → push 対象 commit range の secret scan → `npm test` (unit) → `npm run build:web` → Publisher Playwright E2E (生成Home・記事詳細・metrics・Archive・404) → `RUN_WORKER_DEPLOY=1` の場合のみ `wrangler deploy`。warm/cold・exact tag・navを含む全PlaywrightはPR CIで必須 | `SKIP_TESTS=1` / `SKIP_WEB_BUILD=1` / `SKIP_E2E=1`。Worker deploy は `RUN_WORKER_DEPLOY=1 git push` |

Secret scan は値を表示せず、検出種別・ファイル位置・ハッシュだけを出します。ローカル作業ツリー全体を確認する場合は `npm run secrets:scan:worktree`、全履歴を手動確認する場合は `npm run secrets:scan:history` を使います。

protected branch への直接 commit / push は通常禁止です。当該セッションでユーザーが直接書き込みを明示承認した場合だけ、`ALLOW_PROTECTED_BRANCH_WRITE=1` を指定できます。作業ブランチと PR を使う通常作業では指定しません。

in-place session では branch と index が全 turn で共有されます。Git mutation を行う前に session automation と先行 turn を停止し、current branch、status、push 先 ref を直前に再確認してください。

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) は **検証目的のみ**で、デプロイは行いません。push / PR ごとに dependency audit (soft gate) + `typecheck + npm test + npm run build:web + npm run test:e2e` を実行し、Cloudflare Pages の build 失敗を事前に検知します。PR eventではexact-head独立レビューgateを独立jobで並列実行するため、marker待ちでgateが赤でもunit・typecheck・Web build・E2Eの品質結果を取得できます。

独立レビューCIはPR番号とhead SHAを`github.event.pull_request`から取得し、現在のPR state、head、review、issue commentをGitHub RESTから再取得します。`INDEPENDENT_REVIEW_MERGER_SESSION_ID`と`INDEPENDENT_REVIEW_REVIEWER_SESSION_ID`はGitHub Actions repository variablesへfull lowercase UUIDで設定し、両者を別sessionにしてください。markerはrepository ownerのGitHub accountから投稿され、REST evidenceが`author_association=OWNER`を返す場合だけsession UUIDの検査へ進みます。変数欠落、不正UUID、untrusted author、open PRのhead drift、marker欠落、stale marker、wrong reviewer、self-issued marker、exact-head fail marker、API失敗はすべてfail-closedです。

marker投稿では新しいworkflowを自動起動しません。exact-head markerの投稿後は、同じheadの失敗runを再実行してください。古いrunの再実行時にPRが既にclosedなら、RESTのcurrent stateを確認したうえでgate stepだけをskipします。PRがopenのままheadだけ変わった場合はstale runを通さず、新しいheadへのreview requestとmarkerが必要です。CIの成功はmerge直前のlocal exact-head gateを置き換えません。

現時点の dependency audit 既知事項:

| 範囲 | Advisory | 対応方針 |
|---|---|---|
| root | なし (`npm audit --json` total=0) | 継続監視のみ |
| web | `esbuild >=0.27.3 <0.28.1` low (Astro 6 系の依存として残存) | `astro@7` への semver-major 移行で解消可能。現タスクでは互換性維持のため Astro 6.4.8 まで更新 |

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
SUMMARIZE_TIMEOUT_MS=60000          # summary-only Copilot timeout
SUMMARIZE_MAX_TOKENS=1600           # titleJa + summaryJa + summaryEn の出力予算
```

> どのトークンも無ければ要約フェーズは自動でスキップされます (ローカル dev を妨げない設計)。

## デプロイ & 自動更新 (GitHub Actions Publisher + Cloudflare Pages)

通常運用では GitHub Actions Publisher が `data/index.json`、`data/bodies.json`、`data/archive/*`、`data/stats.json` を検証して main に commit し、Cloudflare Pages の Git Integration が更新を検知してサイトを build / deploy します。Queue / KV effects は data 検証と push の成功後だけ、GitHub Actions OIDC で認証した Free bridge へ送信します。

```
[GitHub Actions Publisher] ──毎時 (6 batch ローテーション)──→ [data-only commit]
  │ (RSS 収集 + full quality gates)                         │ push to main
  │                                                        ↓
  ├── GitHub OIDC → [Cloudflare Free bridge]     [Cloudflare Pages Git Integration]
  │                    ├ Queue                              ↓ npm run build
  │                    └ OG Cache (KV)            [Cloudflare Pages 本番サイト]
  └── main drift / test failure / push failure 時は effects を送らない
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

#### 共有・discovery metadata

Home と記事詳細は、queryを含まないcanonical URLを維持しながら、日本語・英語それぞれのtitle、description、Open Graph、Twitter Card metadataを1組だけ出力します。`?lang=en`のHome・記事詳細requestは、Pages Functionが静的HTML本文を変更せずheadのlocalization markerだけを英語値へ置換するため、JavaScriptを実行しないsocial crawlerにも英語metadataが届きます。既定の日本語requestは生成済みstatic responseをそのまま返します。

元記事画像が無い記事とHomeは、repository内で決定論的に生成する`/social/tech-dashboard-v1.png`を使用します。画像は1200x630のPNGで、absolute custom-domain URL、content type、寸法、JA/EN alt metadataをOpen GraphとTwitter Cardへ出力します。元記事画像がある場合はそのabsolute URLを維持し、未確認のtypeや寸法を推測しません。SVG/AVIFなどsocial cardで扱えないことが分かっている形式は同じbrand PNGへfallbackします。

#### Privacy と任意広告

`/privacy/` は、運営主体、連絡先、日本での運営、localStorage、検索URL、外部media、Cloudflare、匿名いいね、Google AdSense、保持期間、利用者controlを日本語・英語で公開する正本です。記事閲覧、検索、Archive、RSS、JSON Feed は広告同意なしで利用できます。

- 広告選択はversion付きの`td:privacy-consent:v1` recordとしてbrowserのlocalStorageだけへ保存する。未選択、壊れたrecord、未知field/state、旧versionは全て広告OFFとして扱う。
- Google AdSenseは`techdb.studio344.net`で利用者が明示的に許可した場合だけclient scriptを追加する。local previewと`tech-dashboard-6a7.pages.dev`では、localStorageに許可recordがあっても読み込まない。
- rootの`/ads.txt`は`web/src/lib/site.ts`の`ADSENSE_CLIENT_ID`からauthorized seller lineを生成し、publisher IDの重複設定を持たない。
- 表示言語はlocalStorageに加えて共有可能な`?lang=en`へ反映され、検索URLは`?q=`/`?tag=`を含む場合がある。これらのURLは通常の配信requestとしてCloudflareへ届くため、browser内だけに留まる広告選択とは区別して説明する。
- local設定の消去と、現在のbrowser識別子に紐づくactive identity・匿名いいね・rate-limit行の削除は`/privacy/`から実行できる。これらのD1行には自動削除期限を設定していないため、このcontrolまたは運用上の削除まで保持される。

#### 匿名公開いいね (Pages Functions + D1)

Knowledge カードと記事詳細のいいねは、同一 origin の Pages Functions と専用 D1 を使います。お気に入り、アカウント、マイページ、記事保存は含みません。いいねは記事 route の保持期間を延長せず、live index から外れた記事を再公開しません。

本番で有効にする前に、Cloudflare Pages project へ次を設定します。コードを merge しただけでは、binding と key が無いためコントロールは利用不可のままです。設定状態は `/status` の「匿名いいねの設定状態」カードで確認できます (詳細は本セクション末尾)。

| 種別 | 名前 | 用途 |
|---|---|---|
| D1 binding | `REACTIONS_DB` | active匿名identity、記事ごとの匿名票、rate-limit state |
| Encrypted secret | `REACTION_HMAC_SECRET` | browser cookie の UUID を保存前に HMAC-SHA256 化 |
| Encrypted secret | `TURNSTILE_SECRET_KEY` | mutation ごとの Turnstile Siteverify |
| Build variable | `PUBLIC_TURNSTILE_SITE_KEY` | Astro がいいねコントロールへ埋め込む公開 site key |

```bash
# 1. 専用 D1 を作成し、表示された database ID を安全に控える
npx wrangler d1 create tech-dashboard-reactions

# 2. Wrangler が表示した d1_databases block を untracked の設定へ保存し、
#    production D1 へ schema を適用する
npx wrangler d1 execute REACTIONS_DB \
  --config web/.wrangler/reactions-production.jsonc \
  --remote \
  --file=web/migrations/0001_reactions.sql

npx wrangler d1 execute REACTIONS_DB \
  --config web/.wrangler/reactions-production.jsonc \
  --remote \
  --file=web/migrations/0002_reaction_identities.sql
```

`web/wrangler.reactions.local.jsonc` を `web/.wrangler/reactions-production.jsonc` へコピーし、all-zero の `database_id` を `d1 create` が表示した ID へ、`database_name` を作成時の名前へ置き換えます。binding は `REACTIONS_DB` のまま使います。このファイルは `.wrangler/` 配下のため Git には追加しません。Cloudflare dashboard の Pages project settings で `REACTIONS_DB` を作成済み D1 へ bind し、production の secret と build variable を登録します。Turnstile widget の許可 hostname には、実際に機能を有効にする custom domain と pages.dev domain だけを登録します。設定後は新しい Pages deployment が必要です。

ローカルでは公開 site key を `web/.env.local`、2 つの secret を gitignored の `web/.dev.vars` に置きます。最初に migration と Pages preview で同じ `--persist-to` directory を指定し、同じローカル D1 を共有します。`pages dev` だけを起動しても schema は自動適用されません。

```bash
cd web

# 1. local-only config で D1 binding を解決し、schema を適用する
npx --yes wrangler@4.85.0 d1 execute REACTIONS_DB \
  --config wrangler.reactions.local.jsonc \
  --local \
  --persist-to .wrangler/state/reactions \
  --file=migrations/0001_reactions.sql

npx --yes wrangler@4.85.0 d1 execute REACTIONS_DB \
  --config wrangler.reactions.local.jsonc \
  --local \
  --persist-to .wrangler/state/reactions \
  --file=migrations/0002_reaction_identities.sql

# 2. 同じ永続化 directory と D1 を Pages Functions へ bind する
npx --yes wrangler@4.85.0 pages dev dist \
  --compatibility-date 2026-05-01 \
  --d1 REACTIONS_DB=00000000-0000-0000-0000-000000000000 \
  --persist-to .wrangler/state/reactions
```

`wrangler.reactions.local.jsonc` の all-zero ID はローカル専用です。`--remote` では使いません。上記手順は schema 適用後の `GET /api/reactions`、identity bootstrap、D1 の identity/vote/rate-limit 行が意図した状態になることをローカルで確認します。

API contract:

- `GET /api/reactions?ids=<comma-separated ids>` は最大 50 記事の count と current browser の状態を返す。
- `POST /api/reactions/identity` は匿名 cookie とactive identity rowだけを確立する。票、count、rate-limit state は変更しない。既存cookieのhashにactive rowがなければ`409 identity_required`とcookie失効を返し、同じrequestではidentityを再生成しない。cookie失効後の別requestだけが新しいUUIDを発行できる。
- `DELETE /api/reactions/identity` はsame-origin requestだけを受け付け、現在のbrowser識別子に紐づくactive identity、全票、rate-limit行を1つのD1 transactionで削除してHttpOnly cookieを失効させる。削除にはD1とHMAC secretだけを使い、Turnstile設定には依存しない。cookieが無い場合も冪等に成功する。
- `PUT /api/reactions/:id` は確立済み cookie と `{ liked, turnstileToken }` の desired state を受け取る。cookie が無い場合は `409 identity_required` を返し、toggle command ではないため再送しても冪等。
- reaction mutationはactive identity確認、rate-limit更新、票変更、count読込を同一D1 transactionへまとめる。DELETEが先に完了したidentityは票やrate-limit行を再生成できない。
- `GET /api/reactions/config` は D1 binding・HMAC secret・Turnstile secret・public site key が「設定済みかどうか」を boolean だけで返す (`{ config: { databaseBinding, hmacSecret, turnstileSecret, publicSiteKey, configured } }`)。値そのものは一切返さない。Astro の静的 build は Pages Function の runtime binding を知り得ないため、この読み取り専用 same-origin endpoint が唯一の truthful な設定確認手段であり、`/metrics.json` のような build-time artifact へ推測値を書かない。
- browser UUID は `__Host-techdb_reaction_voter` HttpOnly cookie に保持し、生値と IP address は D1 に保存しない。
- cookie 削除や別 browser は別票として扱う best-effort contract。公開 count を identity や人気ランキングへ流用しない。
- `article_likes(voter_hash)` indexはcurrent-browser削除をfull-table scanにせず、existing D1へ`0002_reaction_identities.sql`を適用してから対応codeを本番反映する。

UI contract:

- いいねは progressive enhancement として扱い、batch count を正常取得できた control だけを表示する。設定不足や API 障害時は、無効な button や記事 link を遮る hit area を残さない。
- Knowledge では常時表示の説明、記事詳細では source/share utility と分離した専用 reaction panel を使い、匿名・非保存・非ランキングを操作地点で明示する。
- 大きな visible count は `1.2K` / `1M` のように短縮するが、accessible name と tooltip には locale に沿った正確な件数を保持する。
- mutation 失敗時は optimistic state を戻して server truth を再取得し、rate limit、Turnstile、service、network の原因に応じた JA/EN toast を表示する。keyboard focus は操作した button に維持する。
- `/status` は `GET /api/reactions/config` を progressive enhancement で読み、SSR 直後は neutral な「確認中 / Checking」を表示する。応答が揃うと「設定済み / Configured」(ok tone) か「未設定 / Not configured」(neutral tone、未設定の項目を JA/EN で列挙) のどちらかを表示し、endpoint に到達できない場合だけ別の neutral な「確認できません / Check unavailable」を表示して「未設定」と区別する。欠落・未到達のどちらも ERR/WARN 相当の色にはしない (この機能は安全に degrade する任意機能であり、障害ではないため)。テキスト更新は 1 回だけ解決する読み取りなので `aria-live` は使わず、既存の `aria-labelledby`/`aria-describedby` パターンで見出しと詳細文を関連付ける。

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

### 2. GitHub Actions Publisher と Cloudflare Free bridge

multi-megabyte の data artifact を扱う重い処理は `.github/workflows/publisher.yml` の Node 22 job で実行します。`worker/` の `tech-dashboard-harness` は Workers Free で動く軽量 bridge で、scheduled handler や GitHub publish token を持ちません。bridge は GitHub Actions OIDC の署名と claims を検証し、allowlist 済み Queue / KV 操作だけを中継します。

```bash
cd worker
npm install
npx wrangler login                              # bridge deploy の初回認証

# KV ネームスペース (構築済み: id=6d67debb991742efadfec473a121f5fc)
# 新規環境では: npx wrangler kv namespace create SUMMARY_CACHE
# → 出力された id を worker/wrangler.toml の [[kv_namespaces]] id に反映

# Free bridge の検証と明示デプロイ
npm run deploy -- --dry-run
npx wrangler deploy
```

Publisher workflow は `0 * * * *` (毎時) で起動します。registry の有効 source を 6 バッチでローテーション収集するため、**個別 source の再収集はおおむね 6 時間周期**です。runner は開始時に checkout と remote main の HEAD SHA を一致確認し、その immutable SHA から publisher contract、index、bodies、archive、stats を読みます。生成後に main が進んでいれば stale snapshot の commit と effects flushを中止し、次 run へ持ち越します。

data に差分がある run は typecheck、unit、data schema、web build、E2E、secret scanを通し、生成対象の data file だけを stageして non-force pushします。Queue と `og.v1` KV write は `$RUNNER_TEMP` の bundleへ遅延し、data push成功後だけ bridgeへ flushします。data差分がない runも final snapshot CASとcontract確認後に Queue / KV effectsだけをflushできます。collapse guardやCAS失敗時は effects bundleを保存しません。新しい repository secretは不要です。GitHub commitは built-in `GITHUB_TOKEN`、bridgeは専用 audienceのGitHub Actions OIDCを使います。

Copilot要約は `worker-summarizer/` が 1 message / invocation で生成し、per-URL KV cacheに保存します。Queue consumerは summary-only contract (`titleJa + summaryJa + summaryEn`) に合わせて `SUMMARIZE_TIMEOUT_MS=60000`、`SUMMARIZE_MAX_TOKENS=1600` とします。本文は `data/bodies.json` に分離し、evergreen、importance 2/3、直近30日だけを retention 対象にします。さらにその中でも実バイト予算 (`worker/src/bodies-budget.ts` の `DEFAULT_BODY_BUDGET_TARGET_BYTES`、既定 9,000,000 bytes) を必ず超えないよう、importance 1 (直近のみ) → importance 2 → importance 3 → evergreen の順に最古から決定論的に prune します。evergreen は最優先 (最後に prune される) ですが、他の全 tier を prune してもなお target を超える場合は evergreen も last-resort として prune され、「保護」は「絶対に prune しない」ではなく「最後に prune される」を意味します (LL-411)。`tests/data-schema.test.ts` の hard ceiling (10,000,000 bytes) はこの target より大きい安全網として維持され、target 自体は上げません。同じ policy を Publisher runtime と `npm run noise:clean -- --apply` の両方が共有します。

Copilot 要約は summarizer Worker 側の `SUMMARIZE_TIMEOUT_MS` (既定 60000 ms) で timeout します。Queue retry と次回 Publisher run の cache 再読みにより、一時的な API timeout / 5xx による欠落を次 run へ持ち越しにくくしています。

**手動トリガ** (緊急で回したい時):

```bash
gh workflow run publisher.yml -f dry_run=false
# 書き込みを行わない確認
gh workflow run publisher.yml -f dry_run=true
```

進行状況は GitHub Actions の `Publisher` workflow で確認します。`dry_run=true` は data、Queue、KV、GitHub refを変更しません。

#### Worker コードの明示デプロイ (pre-push hook)

bridge と Queue consumer は Cloudflare Pages Git Integration の対象外のため、該当 `worker*/src/**` を変更したら明示承認付きの `wrangler deploy` が必要です。`scripts/git-hooks/pre-push` は品質ゲートを通したうえで、明示指定された場合だけ deploy します。クローン後 1 度だけ:

```bash
bash scripts/install-hooks.sh
```

Worker を反映する push では、ユーザーが main への直接 push と Worker deploy の両方を明示承認した場合に限り、`ALLOW_PROTECTED_BRANCH_WRITE=1 RUN_WORKER_DEPLOY=1 git push` を使います。`main` への push に `worker/` 差分がある場合だけ `npx wrangler@4.85.0 deploy` が走ります。通常は作業ブランチを PR で mergeし、Workerを別途承認済みdeploy commandで反映します。

`.github/workflows/publisher.yml`、`scripts/run-publisher.ts`、`harness/**`、`worker/src/**`、`worker/wrangler.toml`、Worker/root package files、Worker tsconfig を変更した PR では、commit 前に fingerprint を更新します。

```bash
npm run publisher:contract -- --apply
npm run publisher:contract -- --dry-run  # CURRENT を確認
```

fingerprint を変える通常 release は次の順序を固定します。

1. CI 合格済み PR head の `tech-dashboard-summarizer` と `tech-dashboard-body` を明示承認のうえ先に deployする。
2. 旧 consumer の in-flight 処理が残っていないことを確認して PR を mergeする。
3. 旧 harness が新 markerとの mismatchで data publishを停止したことを確認する。
4. 明示承認のうえ `tech-dashboard-harness` を Free bridgeへdeployする。`wrangler deployments list` が 100% と報告した直後でも、release verifierからの `/health` が最大 60 秒ほど旧fingerprintを返すことがある。immediateな1回の応答だけで判断せず、`node scripts/verify-worker-deploy.mjs` (bounded polling、既定120s timeout / 5s interval / 3回連続一致) で観測経路の安定収束を確認してから次へ進む。これは全edge PoPの収束証明ではない。
5. bridge `/health`、Publisher workflow、data commit、Queue drain、Pages productionを順に確認する。

#### 監視 / ヘルスチェック

Publisher は実行ごとに `data/index.json` の `health` フィールドにメタデータ (`lastRunAt` / `batchIndex` / `sourcesOk` / `sourcesFailed[]` / `copilotOk` / `fallbackTotal` / `queueMode` / `enqueueCandidates` / `summaryQueueBacklog` / `summaryQueueEnqueued` / `summaryQueueDrainEstimateHours` / `bodyQueueMode` / `bodyRetentionEligible` / `bodyBacklog` / `bodyEnqueueCandidates` / `bodyEnqueueCap` / `bodyEnqueued` / `bodyLookupCount` / `bodyMerged` / `bodyQueueDrainEstimateHours` / `bodyMergePendingIds` / `enrichmentEnqueueCap` / `enrichmentEnqueued` / `enrichmentRemaining` / `summaryFallbacks` / `bodyFallbacks` / `ogCached` 等) を埋め込みます。candidate、実 enqueue、lookup、merge は別指標で、field が無い場合は 0 件ではなく未観測です。Web の Queue 表示はこの artifact health を正本とし、`enabled` かつ backlog 0 の場合だけ処理待ちなしと表示します。run 停止中は保存済み ETA を確定値として表示しません。Node Publisher は `heartbeat.v1` を bridge の KV write へ送らず、Free bridge の write allowlist は `og.v1` のみに保ちます。サイトの [https://techdb.studio344.net/status/](https://techdb.studio344.net/status/) 上部の **Worker Health** セクションで一目で確認できます。

- `run ok` — 直近 run が正常（source freshness は別指標）
- `run warn` — summarize disabled / source error / backlog 増加など要確認
- `run err` — `no run in 6h+` など実行停止に近い状態
- `Fresh sources X/Y` — retained entry の鮮度を示す source activity 指標

`https://tech-dashboard-harness.himiyosh.workers.dev/health` は bridgeのbindingとOIDC設定が揃っていれば `status=bridge` を返し、欠落時は `HTTP 503` でfail-closeします。Publisherの鮮度と成否はGitHub Actions APIの定期runと`Publisher / publish`だけを対象にし、診断用`Publisher / dry-run`は成功runとして数えません。data freshnessに加え、`data/index.json`のaggregate source telemetryも外形監視します。

Queue consumer 単体の疎通は `https://tech-dashboard-summarizer.himiyosh.workers.dev/health` で確認できます。ここでは秘密値は返さず、binding / model / timeout 設定が有効かだけを公開します。Queue consumer の直近 retry / KV write cap defer は短期 TTL 付きで KV に記録され、recent retry は `HTTP 503` になります。

本番監視は `.github/workflows/worker-health.yml` が毎時 `:40` に `npm run health:prod` を実行します。Publisherは毎時`:00`に起動するため、workflowの完了、bridge、data freshness、summarizerを同じcheckで検証できます。手元からも同じチェックを実行できます。

```bash
npm run health:prod
```

### 3. 自動化サマリ

| 領域 | 仕組み | 頻度 / トリガ |
|---|---|---|
| データ収集 + Queue 要約 + og:image | GitHub Actions Publisher + OIDC Free bridge + Queue consumer | 毎時 (registry source を 6 batch ローテーション、検証済みrunだけeffectsをflush) |
| GitHub commit | Publisher workflow → built-in `GITHUB_TOKEN` | allowlist済みdata fileを全品質ゲート後に1 commitへまとめる |
| サイト build / deploy | Cloudflare Pages Git Integration | `main` push を検知 |
| Worker コード deploy | `scripts/git-hooks/pre-push` | `RUN_WORKER_DEPLOY=1 git push` かつ `main` push に worker/ 差分あり |
| ヘルス監視 | bridge `/health` + Publisher run + data freshness + summarizer + `/status` | 毎時 `:40` に外形監視、サイト訪問時にも確認 |

**残る手動運用**: Queue consumer の `COPILOT_PAT` 更新と、コード変更時の明示承認付き Worker deploy。Publisher commit と bridge 認証には長命な repository secret を追加しません。

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
├─ PRODUCT.md                # プロダクト目的・成功指標・アクセシビリティ基準
├─ skills-lock.json          # skills CLI が管理する Modern Web Guidance の導入 lock
├─ .github/agents/           # TechDB の監査・実装・QA・ペルソナ custom agents
├─ .github/skills/hallmark/  # pinned Hallmark UI design skill + attribution
├─ docs/                     # 設計ドキュメント
│  └─ mockups/               # HTML モック (mockup-D が確定)
├─ harness/                  # ハーネス本体 (TypeScript)
│  ├─ orchestrator.ts        # 外側ループ (並列 collect → normalize → dedupe → tag → summarize → publish)
│  ├─ registry.ts            # ソース定義テーブル (件数は /status と registry を参照)
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
│  ├─ functions/             # Pages Functions (localized metadata / 匿名公開いいね API)
│  ├─ migrations/            # Pages D1 schema + active identity / voter index migration
│  ├─ src/
│  │  ├─ layouts/Portal.astro
│  │  ├─ components/{Sidebar,EntryCard,ArticleLike,DailySummary,DayDigest,TickerBar,TrendChart,Pager,CompactRow,CategoryHero,LiveMetrics}.astro
│  │  ├─ lib/data.ts         # data/index.json を型付きで読み込む
│  │  ├─ lib/reactions-client.ts # いいね count hydration / optimistic update / rollback
│  │  ├─ lib/reaction-config-health.ts # 匿名いいねconfig健全性のpure display derivation
│  │  ├─ lib/reaction-config-client.ts # /api/reactions/config への bounded runtime fetch
│  │  ├─ lib/privacy-consent.ts # versioned広告同意 + production host gate
│  │  ├─ lib/privacy-consent-client.ts # consent同期 + AdSense遅延load
│  │  ├─ lib/privacy-controls.ts # local設定 / current-browser reaction削除
│  │  ├─ lib/stats.ts        # data/stats.json を型付きで読み込む
│  │  ├─ lib/metrics.ts      # Timeline / About 用の自動更新 metrics SoT
│  │  ├─ lib/freshness.ts    # source type 別 freshness 判定 (UI / quality-audit 共有)
│  │  ├─ lib/source-meta.ts  # web 自己完結用の sources メタ複製 (R-005)
│  │  ├─ lib/site.ts         # canonical URL 単一情報源 (R-004)
│  │  ├─ lib/detail-addressability.ts # JSON-free な live/hot/warm detail route policy
│  │  ├─ lib/sitemap.ts      # addressable route 列挙 + 50,000 URL / 50 MB fail-closed serializer
│  │  ├─ styles/portal.css   # 全 CSS (モバイル最適化済み)
│  │  └─ pages/
│  │     ├─ index.astro      # ポータルトップ (Top-3 メダル / DailySummary 等)
│  │     ├─ c/[slug].astro   # カテゴリ別 (14 ページ)
│  │     ├─ rss/[category].xml.ts # カテゴリ別 RSS (valid category のみ)
│  │     ├─ t/[tag].astro    # タグ別
│  │     ├─ status.astro, categories.astro, about.astro, privacy.astro, sources.astro (redirect)
│  │     └─ {rss.xml,feed.json,metrics.json,sitemap.xml,robots.txt,ads.txt}.ts  # Feed / metrics / discovery / authorized sellers
│  ├─ .node-version          # Cloudflare Pages build 用 Node 22 ピン
│  └─ astro.config.mjs
├─ .claude/skills/
│  ├─ ai-scrum/             # AI Scrum 開発運用スキル (SKILL.md)
│  ├─ quality-audit/         # 品質監査スキル (SKILL.md + run.ts)
│  ├─ ui-display-guard/      # モバイル/レスポンシブ UI 表示ガードスキル (SKILL.md)
│  └─ modern-web-guidance/   # Chrome Modern Web Guidance 検索スキル (SKILL.md + guides)
├─ worker/                   # Cloudflare Workers Free OIDC bridge + shared publisher core
│  ├─ src/free-plan-bridge.ts # GitHub OIDC 検証 → allowlist 済み KV / Queue 転送
│  ├─ src/index.ts           # Node publisher と共有する収集・merge core
│  ├─ wrangler.toml          # Free bridge の KV / Queue / OIDC 設定
│  └─ package.json
├─ scripts/
│  ├─ run-publisher.ts                 # GitHub Actions Node publisher / deferred effects flush
│  ├─ backfill-og.mjs                  # data/index.json の og:image を一括バックフィル
│  ├─ backfill-release-titles.mjs      # version-only タイトル ("v3.8.0" 等) に source 名を前置
│  ├─ apply-summary-cache.mjs          # 品質 gate 済みの要約を data/_summary-cache.json から data/index.json へ再反映
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
