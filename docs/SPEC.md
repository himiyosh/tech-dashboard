# Tech Dashboard サイト仕様書 (Production v1.0)

> 本書は **https://techdb.studio344.net/** の **現状実装** を記述した仕様書です。
> 計画段階の草案は [`04-site-spec.md`](./04-site-spec.md) を参照。アーキテクチャ詳細は [`01-architecture.md`](./01-architecture.md) を参照。
>
> **最終更新**: 2026-04-27 / **本番コミット**: `main` ブランチ最新

---

## 1. 概要

**プロダクト名**: TECH Dashboard — Pulse of the AI Ecosystem
**目的**: AI 開発ツール / 基盤モデル / 研究の最新動向を **毎時自動収集・要約・公開** するワンストップ ポータル。
**想定ユーザ**: Copilot / Claude / Codex / Cursor / Local LLM などを業務で使う開発者・リサーチャ。
**スケール**: 51 データソース (Worker 実行時は `user-opml` 除外で 50、各 run で 50/4=約 13 ソースをローテーション) / 14 カテゴリ / index 最大 500 件 / **毎時実行**。
**URL**:
- 本番: https://techdb.studio344.net/ (Cloudflare Pages の pages.dev サブドメイン: https://tech-dashboard-6a7.pages.dev/)
- リポジトリ: https://github.com/himiyosh/tech-dashboard
- データ収集バッチ: https://tech-dashboard-harness.himiyosh.workers.dev (Cloudflare Worker)

---

## 2. システム構成

```
[RSS / Anthropic / HN Algolia / VS Code / YouTube / OPML]
            ↓ 6h cron  (Cloudflare Worker)
       ┌────────────────────────┐
       │ tech-dashboard-harness │  = Collect → Normalize → Dedupe
       │   (Worker + KV cache)  │  → Summarize (Copilot Enterprise API)
       └─────────┬──────────────┘  → Commit data/index.json
                 ↓ GitHub Contents API
       ┌────────────────────────┐
       │  github.com/himiyosh/  │  main ブランチ
       │    tech-dashboard      │
       └─────────┬──────────────┘
                 ↓ push trigger (Cloudflare Pages Git Integration)
       ┌────────────────────────┐
       │  Cloudflare Pages      │  Astro 静的ビルド + Pagefind
       │  tech-dashboard        │  → 本番配信
       └────────────────────────┘
```

### 2.1 コンポーネント一覧

| コンポーネント | ランタイム | 役割 |
|---|---|---|
| **Worker `tech-dashboard-harness`** | Cloudflare Workers (Paid) | 毎時 cron (4 batch ローテーション) で RSS 収集 → Copilot 要約 → og:image 取得 → GitHub へ data コミット |
| **KV `SUMMARY_CACHE`** | Cloudflare KV | `cache.v1` (要約) と `og.v1` (画像キャッシュ) の二つの単一ブロブを管理 |
| **harness (ローカル実行版)** | Node.js 22 / TSX | `npm run collect` で同ロジックをローカル実行 (デバッグ用) |
| **web (Astro)** | Astro 5 + Pagefind | SSG 静的サイト。`data/index.json` をビルド時に読んで全画面生成 |
| **pre-push hook** | `scripts/git-hooks/pre-push` | ローカル品質ゲートを実行し、`RUN_WORKER_DEPLOY=1` の `main` push に worker/ 差分がある場合だけ `wrangler deploy` を実行 |
| **MCP config** | VS Code Copilot Chat | `.vscode/mcp.json` で CF 公式 MCP 5 種を接続 |

### 2.2 定期実行

| 項目 | 値 |
|---|---|
| Cron 式 | `0 * * * *` (UTC) |
| 実行頻度 | **毎時 / 24 run×日** |
| ソースローテーション | 50 ソース ÷ 4 batch (`hour % 4`)、個別ソースは 4 時間ごと |
| 1 実行あたり新規要約上限 | `SUMMARIZE_MAX_NEW = 5` |
| 1 実行あたり og:image fetch 上限 | `OG_BUDGET_PER_RUN = 4` |
| ソースあたり取得上限 | `PER_SOURCE_CAP = 15` (arxiv の 400+/日 を抑制) |
| index エントリ総数上限 | `INDEX_LIMIT = 500` |
| Cloudflare Workers subrequest 上限 | 50/run (Free)、現状 ~24/run 使用 |

### 2.3 手動トリガ

```bash
# Worker 即時実行
curl -X POST https://tech-dashboard-harness.himiyosh.workers.dev/run \
  -H "x-trigger-token: $(gh auth token)"
# → {"ok":true,"status":"accepted"} HTTP 202
# (ctx.waitUntil でバックグラウンド実行)
```

### 2.4 ヘルスメタ (`data/index.json#health`)

Worker は実行のたびに `data/index.json` に以下の `health` フィールドを嵌め込み、 [`/status`](https://techdb.studio344.net/status/) ページ上部の Worker Health セクションで表示される。

```ts
interface WorkerHealth {
  lastRunAt: string;        // ISO 8601
  batchIndex: number;       // 1ー4
  batchTotal: number;       // 4
  sourcesAttempted: number;
  sourcesOk: number;
  sourcesFailed: string[];
  summarized: number;
  summarizeErrors: number;
  copilotOk: boolean;
  copilotError: string | null;
  ogCached: number;
  ogNewHits: number;
}
```

ステータスラベル (表示ロジックは `web/src/pages/status.astro`):
- `healthy` — 直近 6h 以内に成功 / Copilot OK / 失敗 source なし
- `summarize disabled` — Copilot PAT 失効等 (収集は継続)
- `no run in 6h+` — Worker が連続で停止
- `(N) source error` — 個別ソース fetch 失敗

### 2.5 自動化サマリ

| 領域 | 仕組み | 頻度 / トリガー |
|---|---|---|
| データ収集 + 要約 + og:image | Cloudflare Worker (cron) | 毎時 (4 batch ローテーション) |
| GitHub commit | Worker → GitHub Contents API | 差分時のみ |
| サイト build / deploy | Cloudflare Pages Git Integration | `main` push を検知 |
| ローカル品質ゲート + Worker コード deploy | `scripts/git-hooks/pre-push` | push 前に unit / web build / E2E を実行し、`RUN_WORKER_DEPLOY=1` の `main` push に worker/ 差分がある場合だけ deploy |
| ヘルス監視 | `data/index.json#health` + `/status` ページ | 実行ごと記録、サイト訪問時に確認 |

**残る手動運用**: 年 1 回の PAT 更新 (`wrangler secret put COPILOT_PAT` / `GH_TOKEN`)。失効時は `/status` の Worker Health が `summarize disabled` に変わるので即気付ける。

---

## 3. データモデル

### 3.1 `NormalizedEntry` (`harness/types.ts`)

```ts
interface NormalizedEntry {
  id: string;             // sha256(source + url) の短縮 ID
  source: string;         // ソース ID (例: "anthropic-news")
  category: Category;     // 13 分類
  sourceType: "rss" | "release" | "changelog" | "paper" | "youtube" | "hn";
  url: string;
  title: string;          // 正規化済みタイトル (JA/EN 混在)
  titleJa?: string;       // 日本語タイトル (CJK 検出時のみ)
  titleEn?: string;       // 英語タイトル
  publishedAt: string;    // ISO 8601 (UTC)
  author?: string;
  tags: string[];         // 横断タグ (例: "mcp", "agent", "local")
  summaryJa?: string;     // Copilot 生成 (日本語 3 文)
  summaryEn?: string;     // Copilot 生成 (英語 3 文)
  importance: 1 | 2 | 3;  // 3=Major release / 2=Feature / 1=Info
}
```

### 3.2 データストア

| パス | 内容 | 更新タイミング |
|---|---|---|
| `data/index.json` | 公開用 (最大 500 件、`generatedAt` 付き) | Worker cron 実行ごと |
| `data/raw/<source>.json` | 収集素材 (デバッグ用、ローカルのみ) | `npm run collect` 時 |
| `data/_summary-cache.json` | ローカル要約キャッシュ | ローカル実行時 |
| KV `cache.v1` | Worker 要約キャッシュ (JSON ブロブ) | Worker 実行時 |
| `data/_runs/audit-*.md` | 品質監査レポート | `quality-audit` Skill 実行時 |

---

## 4. データソース (51 件)

### 4.1 コレクタ種別

| コレクタ | ファイル | 対応ソース数 | 備考 |
|---|---|---|---|
| `rss` | `harness/collectors/rss.ts` | 45 | 汎用 RSS/Atom (Zenn / Qiita / DORA Insights 含む) |
| `anthropic` | `harness/collectors/anthropic.ts` | 2 | Anthropic News / Engineering (HTML scraping) |
| `vscode-updates` | `harness/collectors/vscode-updates.ts` | 1 | VS Code リリースノート |
| `hn-algolia` | `harness/collectors/hn-algolia.ts` | 1 | HN Algolia API |
| `youtube` | `harness/collectors/youtube.ts` | 1 | YouTube Channel Atom |
| `opml` | `harness/collectors/opml.ts` | 1 | ユーザ OPML (ローカルのみ) |

ソース定義は `harness/registry.ts` の `REGISTRY` オブジェクトに集約。Worker 実行時は `user-opml` を除外 (FS 依存) し 50 ソースをフェッチ。

### 4.2 カテゴリ定義 (14 分類)

| # | Slug | 表示名 | 色 | Group |
|---|---|---|---|---|
| 1 | `copilot` | Copilot | `#5eead4` | coding |
| 2 | `claude` | Claude | `#fbbf24` | coding |
| 3 | `codex` | Codex | `#93c5fd` | coding |
| 4 | `gemini` | Gemini | `#60a5fa` | coding |
| 5 | `cursor` | Cursor | `#cbd5e1` | coding |
| 6 | `cline` | Cline / Roo | `#c4b5fd` | coding |
| 7 | `aider` | Aider | `#d6d3a1` | coding |
| 8 | `opencode` | OpenCode | `#a5b4fc` | coding |
| 9 | `vscode` | VSCode | `#63a2ff` | platform |
| 10 | `local-llm` | Local LLM | `#f87171` | platform |
| 11 | `agent-fw` | Agent FW | `#34d399` | ecosystem |
| 12 | `mcp` | MCP | `#f472b6` | ecosystem |
| 13 | `tech-news` | Tech News | `#fb923c` | ecosystem |
| 14 | `research` | Research | `#fda4af` | research |

カテゴリは `harness/registry.ts` で `SourceDefinition.category` に付与される。メタ情報 (色・表示名・ group) は `web/src/lib/data.ts` の `CATEGORY_META` に定義。

### 4.3 ソース一覧 (カテゴリ別)

#### Coding (22 ソース)

| ID | 表示名 | 種別 | Tier | Feed URL |
|---|---|---|---|---|
| `anthropic-news` | Anthropic News | blog | 1 | anthropic.com/news |
| `anthropic-engineering` | Anthropic Engineering | blog | 1 | anthropic.com/engineering |
| `youtube-anthropic` | YouTube — Anthropic | youtube | 3 | YouTube Channel Atom |
| `openai-news` | OpenAI News | blog | 1 | openai.com/news/rss.xml |
| `openai-blog` | OpenAI Blog | blog | 1 | openai.com/blog/rss.xml |
| `google-deepmind` | Google DeepMind Blog | blog | 1 | deepmind.google/blog/rss.xml |
| `google-developers` | Google Developers Blog | blog | 1 | developers.googleblog.com |
| `github-blog-ai` | GitHub Blog (AI & ML) | blog | 1 | github.blog/category/ai-and-ml |
| `github-changelog` | GitHub Changelog | changelog | 1 | github.blog/changelog |
| `qiita-copilot` | Qiita GitHub Copilot tag | blog | 1 | qiita.com/tags/githubcopilot |
| `zenn-copilot` | Zenn GitHub Copilot topic | blog | 2 | zenn.dev/topics/githubcopilot |
| `zenn-claude` | Zenn Claude Code topic | blog | 2 | zenn.dev/topics/claudecode |
| `qiita-claude` | Qiita Claude Code tag | blog | 2 | qiita.com/tags/claudecode |
| `zenn-cursor` | Zenn Cursor topic | blog | 2 | zenn.dev/topics/cursor |
| `qiita-cursor` | Qiita Cursor tag | blog | 2 | qiita.com/tags/cursor |
| `continue-releases` | Continue.dev Releases | release | 2 | github.com/continuedev/continue |
| `cursor-changelog` | Cursor Changelog | changelog | 2 | cursor.com/changelog |
| `cline-releases` | Cline Releases | release | 2 | github.com/cline/cline |
| `aider-releases` | Aider Releases | release | 2 | github.com/Aider-AI/aider |
| `openhands-releases` | OpenHands Releases | release | 2 | github.com/All-Hands-AI/OpenHands |
| `autogen-releases` | Microsoft AutoGen Releases | release | 2 | github.com/microsoft/autogen |
| `langchain-releases` | LangChain Releases | release | 2 | github.com/langchain-ai/langchain |

#### Platform (7 ソース)

| ID | 表示名 | 種別 | Tier | Feed URL |
|---|---|---|---|---|
| `vscode-updates` | VS Code Updates | release | 1 | code.visualstudio.com/feed.xml |
| `qiita-vscode` | Qiita VSCode tag | blog | 2 | qiita.com/tags/vscode |
| `zed-releases` | Zed Editor Releases | release | 2 | github.com/zed-industries/zed |
| `huggingface-blog` | Hugging Face Blog | blog | 1 | huggingface.co/blog |
| `ollama-releases` | Ollama Releases | release | 1 | github.com/ollama/ollama |
| `zenn-llm` | Zenn LLM topic | blog | 2 | zenn.dev/topics/llm |
| `qiita-llm` | Qiita LLM tag | blog | 2 | qiita.com/tags/llm |

#### Ecosystem (4 ソース: agent-fw / mcp)

| ID | 表示名 | 種別 | Tier | Feed URL |
|---|---|---|---|---|
| `semantic-kernel-releases` | Semantic Kernel Releases | release | 2 | github.com/microsoft/semantic-kernel |
| `mcp-servers-releases` | MCP Servers Releases | release | 2 | github.com/modelcontextprotocol/servers |
| `zenn-mcp` | Zenn MCP topic | blog | 2 | zenn.dev/topics/mcp |
| `qiita-mcp` | Qiita MCP tag | blog | 2 | qiita.com/tags/mcp |

#### Tech News (9 ソース)

| ID | 表示名 | 種別 | Tier | Feed URL |
|---|---|---|---|---|
| `apple-newsroom` | Apple Newsroom | blog | 2 | apple.com/newsroom |
| `microsoft-source` | Microsoft Source | blog | 2 | news.microsoft.com/source |
| `google-keyword` | Google Keyword Blog | blog | 2 | blog.google |
| `meta-newsroom` | Meta Newsroom | blog | 2 | about.fb.com/news |
| `aws-news` | AWS News Blog | blog | 2 | aws.amazon.com/blogs/aws |
| `nvidia-blog` | NVIDIA Blog | blog | 2 | blogs.nvidia.com |
| `techcrunch` | TechCrunch | blog | 2 | techcrunch.com |
| `the-verge` | The Verge | blog | 2 | theverge.com |
| `ars-technica` | Ars Technica | blog | 2 | arstechnica.com |

#### Research (9 ソース)

| ID | 表示名 | 種別 | Tier | Feed URL |
|---|---|---|---|---|
| `arxiv-cs-cl` | arXiv cs.CL | paper | 1 | rss.arxiv.org/rss/cs.CL |
| `arxiv-cs-se` | arXiv cs.SE | paper | 1 | rss.arxiv.org/rss/cs.SE |
| `arxiv-cs-ai` | arXiv cs.AI | paper | 2 | rss.arxiv.org/rss/cs.AI |
| `arxiv-cs-lg` | arXiv cs.LG | paper | 2 | rss.arxiv.org/rss/cs.LG |
| `zenn-ai` | Zenn AI tag | blog | 1 | zenn.dev/topics/ai |
| `simonw-blog` | Simon Willison's Weblog | blog | 2 | simonwillison.net |
| `dora-insights` | DORA Insights | blog | 2 | dora.dev/insights/index.xml |
| `hn-ai` | Hacker News — AI coding | community | 3 | hn.algolia.com (query: AI coding OR LLM OR MCP) |
| `user-opml` | User OPML (custom feeds) | blog | 3 | `file://data/user-opml.xml` (ローカルのみ) |

> **Tier の意味**: 1 = 一次情報源 (ベンダー公式) / 2 = 次次情報源 (サードパーティ) / 3 = コミュニティ・ユーザカスタム

---

## 5. パイプライン

```
1. collect       各 collector 並列実行 → raw entries
2. normalize     URL 正規化 / CJK 検出 / タイトル分離
3. dedupe        tracking query を除いた canonical URL key で重複排除
4. per-source    重要度と鮮度で最大 50 件/ソースにキャップ
5. sort          publishedAt 降順で INDEX_LIMIT まで
6. cache-lookup  KV から既存要約を取得
7. summarize     `SUMMARIZE_MAX_NEW` 件まで Copilot Enterprise (既定: Claude Opus 4.7) で要約
8. cache-write   KV に単一ブロブで永続化
9. categorize    URL / tag でカテゴリ判定
10. build        `data/index.json` 生成
11. commit       GitHub Contents API で push (既存と同一なら skip)
```

### 5.1 要約 API

- エンドポイント: GitHub Copilot Enterprise Chat Completions (`https://api.githubcopilot.com/chat/completions`)
- モデル: `claude-opus-4.7` (`SUMMARIZE_MODEL` で変更可)
- 認証: `COPILOT_PAT` → 一時トークン交換を自動実行 (`x-github-token` ヘッダ経由)
- 出力: JSON `{ summaryJa, summaryEn, importance, extraTags }` を期待

---

## 6. サイト画面仕様

### 6.1 画面一覧

| パス | 画面 | 主要コンポーネント |
|---|---|---|
| `/` | Timeline (トップ) | `DailySummary`, `TimelineList`, `Sidebar` |
| `/c/[slug]` | カテゴリ別 (13 種) | `CategoryHero`, `TimelineList` |
| `/categories` | カテゴリ一覧 | カテゴリグリッド + 7 日スパークライン |
| `/sources` | ソース一覧 | 50 ソースのリンク / タイプ |
| `/status` | ステータス | `generatedAt` / 件数 / ソース健全性 |
| `/about` | About | サイト説明 / ライセンス |
| `/page/[n]` | ページネーション | Timeline 2 ページ目以降 |
| `/t/[tag]` | タグ別 | 横断タグによる絞り込み |
| `/rss.xml` | RSS 2.0 | 最新 50 件 |
| `/feed.json` | JSON Feed 1.1 | 最新 50 件 |

### 6.2 共通レイアウト (`Portal.astro`)

- **ヘッダ**: ロゴ / Nav (Timeline / Categories / Sources / Status / About) / **検索ボックス (Pagefind インライン)** / 言語トグル (JA/EN)
- **フッタ**: Generated at / リポジトリリンク / ライセンス
- **言語切替**: `localStorage["td:lang"]` に保存、プリペイントで FOUC 回避
- **ファビコン**: `/favicon.svg` (レーダー + パルスドット)

### 6.3 トップ画面 (`/`)

| セクション | 内容 |
|---|---|
| **Banner** | H1「AI の脈動を、ひとつのダッシュボードに」+ タグライン |
| **DailySummary** | 今日 / 昨日 / 7 日件数 KPI、Last 7 days スパークライン、Top categories 7d、主要な更新 10 件 |
| **TimelineList** | 最新エントリ (カード UI、重要度バッジ、カテゴリ色、JA/EN 要約トグル) |
| **Sidebar** | カテゴリ別件数 + 各 7 日スパーク |

### 6.4 検索

- **エンジン**: [Pagefind](https://pagefind.app/) (ビルド時に `web/dist` を走査して静的インデックス生成)
- **UI**: ヘッダの検索バーにインラインポップオーバー。タイプ中 120ms デバウンスで最大 10 件表示
- **操作**:
  - `/` キー: フォーカス
  - `Esc`: クリア + 閉じる
  - 外側クリック / フォーカス外: 閉じる
- **Dev 制約**: `npm run dev` ではインデックスが生成されないため、検証は `npm run preview` または本番環境を使用

### 6.5 多言語表示

- JA/EN 要約はビルド時に両方埋め込み、DOM の `.i18n-ja` / `.i18n-en` を CSS `display` で切替
- `<html data-lang="ja">` / `<html data-lang="en">` に連動
- 検索インデックスは言語混在で生成 (日本語は stem なし、pagefind ログ警告は仕様通り)

---

## 7. デザイン

### 7.1 デザイントークン (`web/src/styles/portal.css`)

```css
--bg:        #0b1f1d    /* 背景 */
--surface:   #112925    /* カード */
--bg-2:      #1a3a35    /* パネル */
--border:    #1f4e47
--text:      #e6fffb
--muted:     #94b8b2
--accent:    #5eead4    /* Teal */
--accent-2:  #2dd4bf
--accent-bg: #1a5f5a
--success:   #34d399
--danger:    #f87171
--warning:   #fbbf24
```

### 7.2 レイアウト原則

- ダークモード固定 (将来ライト切替予定)
- Grid 2 列 (max-width 1280px) / sidebar 280px / content fluid
- 角丸 10〜14px / パネル間隔 12〜22px
- 等幅数字は `font-variant-numeric: tabular-nums`
- レスポンシブ: 720px 以下でサイドバー非表示、digest-body 1 列化

---

## 8. 配信・デプロイ

### 8.1 Cloudflare Pages

| 項目 | 値 |
|---|---|
| プロジェクト名 | Git Integration 付き新規 Pages project |
| 本番 URL | `techdb.studio344.net` |
| ビルドコマンド | `npm run build` (= `astro build && pagefind --site dist`) |
| 出力ディレクトリ | `dist` |
| Root directory | `web/` |
| Node バージョン | 22 (`web/.node-version`) |

### 8.2 デプロイ手段

| モード | コマンド / 手順 | 自動化度 |
|---|---|---|
| **A. Cloudflare Pages Git Integration** | Cloudflare dashboard で `himiyosh/tech-dashboard` を接続 | 完全自動 (`main` push → Cloudflare build → Pages deploy) |
| **B. CLI 直接 (legacy)** | `cd web && npm run deploy:legacy` | 旧 Direct Upload project への手動実行 |

> 現在の方針は A。既存 Direct Upload project `tech-dashboard` は Git Provider 未接続 (`No`) のため、Git Integration 付き新規 Pages project を作成して custom domain を移行する。

---

## 9. 運用・監視

### 9.1 ログ・観測

| 項目 | 手段 |
|---|---|
| Worker 実行ログ | `npx wrangler tail tech-dashboard-harness` or CF ダッシュボード Observability |
| 収集品質 | `quality-audit` Skill → `data/_runs/audit-*.md` |
| サイト稼働 | CF Pages ダッシュボード |
| RSS / JSON Feed | `/rss.xml`, `/feed.json` で公開 |

### 9.2 シークレット

| キー | 用途 | 管理場所 |
|---|---|---|
| `COPILOT_PAT` | Copilot Enterprise 一時トークン交換 | Wrangler Secrets (Worker) / `.env` (ローカル) |
| `GH_TOKEN` | GitHub Contents API + `x-trigger-token` 認証 | Wrangler Secrets |

---

## 10. ローカル開発

```bash
# ===== データ収集 (ローカル) =====
npm install                  # root 依存
npm run collect:dry          # ドライラン (data/ に書き込まない)
npm run collect              # 本番同等 (data/index.json 更新)

# ===== Web (Astro) =====
cd web && npm install
npm run dev                  # http://localhost:4321 (HMR)
npm run build                # dist/ + Pagefind インデックス
npm run preview              # build 後のプレビュー (検索検証用)
npm run deploy:legacy        # 旧 Direct Upload project への緊急手動反映

# ===== Worker =====
cd worker && npm install
npx wrangler dev             # http://localhost:8787/run
npx wrangler deploy          # 本番 Worker 更新
npx wrangler tail            # 実ログ tail
```

---

## 11. 既知の制約 / 将来課題

| 項目 | 現状 | 計画 |
|---|---|---|
| Pages Git 連携 | 新規 Git Integration project へ移行 | 初回 deploy 成功後に `techdb.studio344.net` を移行 |
| 検索の日本語 stem | Pagefind 未対応 | 必要なら kuromoji プラガブル化 |
| Copilot 要約のレート | 1 実行 5 件まで | フル同期は時間分散で段階的補充 |
| ライト/ダーク切替 | 固定ダーク | 設定保持付きトグル予定 |
| 記事詳細ページ | なし (外部リンク直結) | OG 画像 / クリッピング保存機能 |
| 通知 (Slack / メール) | なし | 重要度 3 エントリを webhook 配信予定 |

---

## 付録 A. エンドポイント一覧

| エンドポイント | メソッド | 認証 | 説明 |
|---|---|---|---|
| `/run` | POST | `x-trigger-token: $GH_TOKEN` | Worker 即時実行 (202 Accepted) |
| (cron) | — | — | `0 * * * *` で scheduled handler |

## 付録 B. コミット規約

- Worker 生成: `chore(data): worker run <ISO> (+<N> summaries)`
- 機能追加: `feat(<scope>): ...` / 修正: `fix(<scope>): ...`
- `[skip ci]` は使用しない (Cloudflare Pages Git Integration の build skip と混同しないため)
