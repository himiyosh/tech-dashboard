# Tech Dashboard サイト仕様書 (Production v1.0)

> 本書は **https://techdb.studio344.net/** の **現状実装** を記述した仕様書です。
> 計画段階の草案は [`04-site-spec.md`](./04-site-spec.md) を参照。アーキテクチャ詳細は [`01-architecture.md`](./01-architecture.md) を参照。
>
> **最終更新**: 2026-05-23 / **本番コミット**: `main` ブランチ最新

---

## 1. 概要

**プロダクト名**: TECH Dashboard — Pulse of the AI Ecosystem
**目的**: AI 開発ツール / 基盤モデル / 研究の最新動向を **毎時自動収集・要約・公開** するワンストップ ポータル。
**想定ユーザ**: Copilot / Claude / Codex / Cursor / Local LLM などを業務で使う開発者・リサーチャ。
**スケール**: `harness/registry.ts` の有効データソース (`user-opml` はproduction対象外) / 14カテゴリ / index最大2000件 / **毎時実行**。
**URL**:
- 本番: https://techdb.studio344.net/ (Cloudflare Pages の pages.dev サブドメイン: https://tech-dashboard-6a7.pages.dev/)
- リポジトリ: https://github.com/himiyosh/tech-dashboard
- data publisher: GitHub Actions `Publisher`
- Queue/KV bridge: https://tech-dashboard-harness.himiyosh.workers.dev

---

## 2. システム構成

```
[RSS / Anthropic / HN Algolia / VS Code / YouTube]
            ↓ hourly schedule (GitHub Actions)
       ┌────────────────────────┐
       │ Publisher (Node 22)    │  = Collect → Normalize → Dedupe
       │ immutable main SHA     │  → Full gates → data-only commit
       └─────────┬──────────────┘
                 ↓ push成功後だけGitHub OIDC
       ┌────────────────────────┐
       │ tech-dashboard-harness │  = Free KV/Queue bridge
       └─────────┬──────────────┘
                 ↓ Cloudflare Queue
       ┌───────────────────────────┐
       │ tech-dashboard-summarizer │  → Copilot Enterprise (Claude Sonnet 4.6)
       └───────────────────────────┘
                 ↓ per-URL KV cache
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
| **GitHub Actions `Publisher`** | Node.js 22 | 毎時6 batchローテーションでRSS収集、fallback、archive/stats、全品質ゲート、data-only commit、push後のeffects flush |
| **Worker `tech-dashboard-harness`** | Cloudflare Workers Free | GitHub Actions OIDCを検証し、allowlist済みKV read/writeとQueue送信を中継 |
| **Worker `tech-dashboard-summarizer`** | Cloudflare Workers Queue consumer | 1 message / invocation で Copilot 要約を生成し、KV に per-URL cache として保存 |
| **KV `SUMMARY_CACHE`** | Cloudflare KV | `s:{sha256(url)}` の per-URL summary cache と `og.v1` 画像キャッシュを管理 |
| **harness (ローカル実行版)** | Node.js 22 / TSX | `npm run collect` で同ロジックをローカル実行 (デバッグ用) |
| **web (Astro)** | Astro 5 + Pagefind | SSG 静的サイト。`data/index.json` をビルド時に読んで全画面生成 |
| **pre-push hook** | `scripts/git-hooks/pre-push` | ローカル品質ゲートを実行し、`RUN_WORKER_DEPLOY=1` の `main` push に worker/ 差分がある場合だけ `wrangler deploy` を実行 |
| **MCP config** | VS Code Copilot Chat | `.vscode/mcp.json` で CF 公式 MCP 5 種を接続 |

### 2.2 定期実行

| 項目 | 値 |
|---|---|
| Schedule | `0 * * * *` (UTC) |
| 実行頻度 | **毎時 / 24 run×日** |
| ソースローテーション | Publisher対象ソース ÷ 6 batch (`hour % 6`)、個別ソースはおおむね6時間ごと |
| 1 実行あたり Queue 投入上限 | `ENQUEUE_MAX_NEW = 35` |
| 1 実行あたり og:image fetch 上限 | `OG_BUDGET_PER_RUN = 1` |
| ソースあたり取得上限 | `PER_SOURCE_CAP = 15` (arxiv の 400+/日 を抑制) |
| index エントリ総数上限 | `INDEX_LIMIT = 2000` |
| Cloudflare bridge request | body size、job count、KV/Queue allowlistで制御 |

### 2.3 手動トリガ

```bash
# production publisher
gh workflow run publisher.yml -f dry_run=false

# data、Queue、KV、GitHub refを変更しない確認
gh workflow run publisher.yml -f dry_run=true
```

### 2.4 ヘルスメタ (`data/index.json#health`)

Publisherは実行のたびに`data/index.json`へ以下の`health`フィールドを埋め込み、[`/status`](https://techdb.studio344.net/status/)ページ上部のWorker Healthセクションで表示する。

```ts
interface WorkerHealth {
  lastRunAt: string;        // ISO 8601
  batchIndex: number;       // 1-6
  batchTotal: number;       // 6
  sourcesAttempted: number;
  sourcesOk: number;
  sourcesFailed: string[];
  summarized: number;
  summarizeErrors: number;
  summaryFallbacks?: number;
  bodyFallbacks?: number;
  fallbackTotal?: number;
  fallbackPercent?: number;
  kvLookupCap?: number;
  kvLookupCount?: number;
  queueMode?: "enabled" | "disabled" | "missing-binding";
  queueCap?: number;
  enqueueCandidates?: number;
  summaryQueueEnqueued?: number;
  summaryQueueBacklog?: number;
  summaryQueueDrainEstimateHours?: number;
  summaryQueueStartIndex?: number;
  bodyQueueMode?: "enabled" | "disabled" | "missing-binding" | "error";
  bodyRetentionEligible?: number;
  bodyBacklog?: number;
  bodyEnqueueCandidates?: number;
  bodyEnqueueCap?: number;
  bodyEnqueued?: number;
  bodyLookupCount?: number;
  bodyPendingLookupCount?: number;
  bodyMerged?: number;
  bodyQueueDrainEstimateHours?: number;
  bodyMergePendingIds?: string[];
  enrichmentEnqueueCap?: number;
  enrichmentEnqueued?: number;
  enrichmentRemaining?: number;
  copilotOk: boolean;
  copilotError: string | null;
  ogCached: number;
  ogNewHits: number;
}
```

Queue telemetry の `backlog`、`candidate`、実 `enqueued`、`lookup`、`merged` は別の母集団である。optional field の欠落は 0 件ではなく未観測として扱う。

ステータスラベル (表示ロジックは `web/src/pages/status.astro`):
- `healthy` — 直近 6h 以内に成功 / Copilot OK / 失敗 source なし
- `summarize disabled` — Copilot PAT 失効等 (収集は継続)
- `no run in 6h+` — Publisher が連続で停止
- `all sources failed` — attempted source が 1 件以上で `sourcesOk = 0`
- `(N) source error` — 個別ソース fetch 失敗

### 2.5 自動化サマリ

| 領域 | 仕組み | 頻度 / トリガー |
|---|---|---|
| データ収集 + Queue 要約 + og:image | GitHub Actions Publisher + OIDC Free bridge + Queue consumer | 毎時 (6 batchローテーション、検証済みrunだけeffectsをflush) |
| GitHub commit | Publisher → built-in `GITHUB_TOKEN` | allowlist済みdata差分を全品質ゲート後に1 commitへまとめる |
| サイト build / deploy | Cloudflare Pages Git Integration | `main` push を検知 |
| ローカル品質ゲート + Worker コード deploy | `scripts/git-hooks/pre-push` | push 前に unit / web build / E2E を実行し、`RUN_WORKER_DEPLOY=1` の `main` push に worker/ 差分がある場合だけ deploy |
| ヘルス監視 | bridge `/health` + publish run + data freshness / aggregate source outcome + summarizer + `/status` | 毎時外形監視。diagnostic dry-runは成功runから除外 |

**残る手動運用**: Queue consumerの`COPILOT_PAT`更新と、コード変更時の明示承認付きWorker deploy。Publisher commitはbuilt-in `GITHUB_TOKEN`、bridge認証はGitHub Actions OIDCを使うため、新しい長命repository secretは追加しない。Publisherはcommit前にbilingual summary fallbackを適用し、`data/index.json`の本文を必ず空にする。cache済みの有効な要約がindexに未反映の場合だけ`npm run summaries:apply-cache`で再反映する。本文は`data/bodies.json`の専用経路で管理し、evergreen、importance 2/3、直近30日を保持する。

---

## 3. データモデル

### 3.1 `NormalizedEntry` (`harness/types.ts`)

```ts
interface NormalizedEntry {
  id: string;             // sha256(source + url) の短縮 ID
  source: string;         // ソース ID (例: "anthropic-news")
  category: Category;     // 14 分類
  sourceType: "blog" | "release" | "changelog" | "paper" | "community";
  url: string;
  title: string;          // 正規化済みタイトル (JA/EN 混在)
  titleJa?: string;       // 日本語タイトル (CJK 検出時のみ)
  titleEn?: string;       // 英語タイトル
  publishedAt: string;    // ISO 8601 (UTC)
  author?: string;
  tags: string[];         // 横断タグ (例: "mcp", "agent", "local")
  summaryJa?: string;     // Copilot 生成 (日本語 3 文)
  summaryEn?: string;     // Copilot 生成 (英語 3 文)
  bodyJa?: string;        // 日本語本文
  bodyEn?: string;        // 英語本文
  importance: 1 | 2 | 3;  // 3=Major release / 2=Feature / 1=Info
}
```

### 3.2 データストア

| パス | 内容 | 更新タイミング |
|---|---|---|
| `data/index.json` | 公開用 (最大 2000 件、`generatedAt` 付き) | Publisher実行ごと |
| `data/bodies.json` | 記事本文sidecar。indexから本文を分離 | Publisher実行ごと |
| `data/archive/*.json` | warm/cold tierの月別永続archive。一覧表示用に本文`bodyJa` / `bodyEn`は保持しない | Publisher / `npm run collect`実行時 |
| `data/archive/_index.json` | archive月一覧と件数 | Publisher / `npm run collect`実行時 |
| `data/stats.json` | archive込みの記事数推移 / source集計 | Publisher / `npm run collect`実行時 |
| `data/raw/<source>.json` | 収集素材 (デバッグ用、ローカルのみ) | `npm run collect` 時 |
| `data/_summary-cache.json` | ローカル要約キャッシュ | ローカル実行時 |
| KV `s:{sha256(url)}` | Worker / Queue 要約キャッシュ (per-URL key) | summarizer Worker 実行時 |
| KV `cache.v1` | 旧 Worker 要約キャッシュ (read-only fallback) | migration 期間のみ |
| `data/_runs/audit-*.md` | 品質監査レポート | `quality-audit` Skill 実行時 |

`web/src/lib/metrics.ts` は `data/index.json`、`data/stats.json`、archive index、Worker health から Timeline / About の表示 metrics を組み立てる。`/metrics.json` は同じ値を JSON で公開し、`LiveMetrics.astro` が開いているページの `data-metric` 表示を定期 fetch で更新する。`data/stats.json` の `byDay` / `byMonth` は `bucketTimeZone: "Asia/Tokyo"` を持ち、JST の日付・月境界で集計する。`data/archive/*.json` の月別配置は保存構造として UTC 月を維持する。

data artifact のサイズ予算は `tests/data-schema.test.ts` で検証する。現行上限は `data/index.json` 8 MB、`data/stats.json` 500 KB、archive 月別 JSON 6 MB とする。archive 月別 JSON は canonical URL で重複排除し、一覧表示に使わない本文フィールドを省く。

---

## 4. データソース

### 4.1 コレクタ種別

| コレクタ | ファイル | 対応ソース数 | 備考 |
|---|---|---|---|
| `rss` | `harness/collectors/rss.ts` | 45 | 汎用 RSS/Atom (Zenn / Qiita / DORA Insights 含む) |
| `anthropic` | `harness/collectors/anthropic.ts` | 2 | Anthropic News / Engineering (HTML scraping) |
| `vscode-updates` | `harness/collectors/vscode-updates.ts` | 1 | VS Code リリースノート |
| `hn-algolia` | `harness/collectors/hn-algolia.ts` | 1 | HN Algolia API |
| `youtube` | `harness/collectors/youtube.ts` | 1 | YouTube Channel Atom |
| `opml` | `harness/collectors/opml.ts` | 1 | ユーザ OPML (ローカルのみ) |

ソース定義は`harness/registry.ts`の`REGISTRY`オブジェクトに集約する。Publisher実行時はFS依存の`user-opml`を除外する。現行件数とcoverageは`/status`を単一情報源とする。

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
| `github-blog-ai` | GitHub Blog (AI & ML) | blog | 1 | github.blog/ai-and-ml/feed |
| `github-copilot` | GitHub Copilot Blog | blog | 1 | github.blog/ai-and-ml/github-copilot/feed |
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
>
> **evergreen ソース (R-022)**: `anthropic-engineering` / `github-blog-ai` / `github-copilot` はベストプラクティス/知見系のため `evergreen: true`。hot window 経過後も warm (個別URL) に留まり、cold (/archive 月次集約) / dropped にせず蓄積する。判定は `harness/half-life.ts` の `decideTier`、検証は `tests/half-life.test.ts` と `tests/data-schema.test.ts` の evergreen ゲート。

---

## 5. パイプライン

```
1. collect       各 collector 並列実行 → raw entries
2. normalize     URL 正規化 / CJK 検出 / タイトル分離
3. dedupe        tracking query を除いた canonical URL key で重複排除
4. per-source    重要度と鮮度で最大 50 件/ソースにキャップ
5. sort          publishedAt 降順で INDEX_LIMIT まで
6. cache-lookup  OIDC bridge 経由で KV の既存要約/本文を per-URL key で取得
7. fallback      summary 空欄を deterministic fallback で埋める。body filler は作らない
8. stage-effects Queue job と og.v1 KV write を RUNNER_TEMP に保存
9. categorize    URL / tag でカテゴリ判定
10. build        `data/index.json` / `data/bodies.json` / `data/archive/*` / `data/stats.json` 生成
11. verify       typecheck / unit / schema / web build / E2E / secret scan
12. commit       main drift がなければ allowlist 済み data artifact を 1 commit にまとめて non-force push
13. flush        push 成功後だけ OIDC bridge 経由で Queue / KV effects を実行
```

### 5.1 要約 API

- エンドポイント: GitHub Copilot Enterprise Chat Completions (`https://api.githubcopilot.com/chat/completions`)
- モデル: `claude-sonnet-4.6` (`SUMMARIZE_MODEL` で変更可)
- 認証: `COPILOT_PAT` → 一時トークン交換を自動実行 (`x-github-token` ヘッダ経由)
- 出力: JSON `{ titleJa, summaryJa, summaryEn }` を期待。本文は専用 body consumer が別生成する

---

## 6. サイト画面仕様

### 6.1 画面一覧

| パス | 画面 | 主要コンポーネント |
|---|---|---|
| `/` | Timeline (トップ) | `DailySummary`, `TimelineList`, `Sidebar` |
| `/c/[slug]` | カテゴリ別 (14 種) | `CategoryHero`, `TimelineList` |
| `/categories` | カテゴリ一覧 | カテゴリグリッド + 7 日スパークライン |
| `/knowledge` | Knowledge | evergreen source 別の知見カード + 匿名公開いいね |
| `/e/[id]` | 記事詳細 | bilingual summary / optional body / 原文・共有・匿名公開いいね |
| `/status` | ステータス + ソース一覧 | `generatedAt` / 件数 / Worker health / source registry / ソース健全性 |
| `/sources` | 互換リダイレクト | `/status` へ誘導 |
| `/about` | About | サイト説明 / ライセンス |
| `/page/[n]` | ページネーション | Timeline 2 ページ目以降 |
| `/t/[tag]` | タグ別 | 横断タグによる絞り込み |
| `/c/[slug]/page/[n]` | カテゴリページネーション | カテゴリ 2 ページ目以降 |
| `/t/[tag]/page/[n]` | タグページネーション | 10 件以上の生成対象タグ 2 ページ目以降 |
| `/arxiv` | arXiv | live 論文一覧 |
| `/glossary` | Glossary | AI / LLM 用語集 |
| `/archive`, `/archive/[month]` | Archive | 月一覧 / 要約付き warm・cold 記事一覧 |
| `/rss.xml` | RSS 2.0 | 最新 50 件 |
| `/feed.json` | JSON Feed 1.1 | 最新 50 件 |
| `/metrics.json` | Dashboard metrics | Timeline / About の自動更新用 counts |
| `/sitemap.xml` | Sitemap XML | canonical な addressable HTML route |
| `/robots.txt` | Robots directives | crawl 許可 + canonical Sitemap directive |

### 6.2 共通レイアウト (`Portal.astro`)

- **ヘッダ**: ロゴ / direct explore shortcut (`Categories` / `arXiv` / `Knowledge`) / `Menu` / **検索ボックス (Pagefind インライン)** / 言語トグル (JA/EN)
- **Knowledge レーン (`/knowledge`)**: evergreen ソース (R-022) のベストプラクティス / 知見をニュース Timeline から分離し、ソース別に蓄積表示する。desktop header と mobile tabbar の direct `Knowledge` shortcut から遷移し、`#site-menu` には重複表示しない (R-015)。
- **フッタ**: Generated at / リポジトリリンク / ライセンス
- **言語切替**: `localStorage["td:lang"]` に保存、プリペイントで FOUC 回避
- **ファビコン**: `/favicon.svg` (レーダー + パルスドット)

### 6.3 Crawl discovery

- `web/src/lib/site.ts` の `SITE_URL` を canonical origin の唯一の正本とする。
- `/sitemap.xml` は Home、top-level destination、カテゴリ、生成済みページネーション、arXiv / Knowledge / Glossary、Archive 月、10件以上の生成対象タグ、live と warm の記事詳細だけを重複なしで列挙する。
- redirect-only `/sources`、query URL、生成されない低頻度タグ、外部 URL、cold / dropped の記事詳細は含めない。
- 一覧上の cold / dropped は canonical source URL、untiered / hot / warm は内部 detail URL を共通 destination helper で選ぶ。新しいタブで開く source link は共有 `rel="noopener noreferrer nofollow"`、`↗`、表示言語別の visually-hidden 補足を持つ。production build は sitemap と実際の canonical HTML inventory の双方向 parity、redirect-only 非包含、標準 HTML parser が抽出・復号した実要素の `href` を各 HTML の canonical route 基準で解決し、内部 `/e/{id}/` link が実在する detail route を指すことを検証する。
- `lastmod` は route の実更新時刻を保証できないため付与しない。50,000 URL または uncompressed 50 MB を超える場合は build を fail-closed にする。
- `/robots.txt` は crawl を許可し、`Sitemap: {SITE_URL}/sitemap.xml` を広告 publisher ID と無関係に公開する。実 publisher ID が無い `ads.txt` は生成しない。

### 6.4 トップ画面 (`/`)

| セクション | 内容 |
|---|---|
| **Banner** | H1「AI の脈動を、ひとつのダッシュボードに」+ タグライン |
| **DailySummary** | 今日 / 昨日 / 7 日件数 KPI、Last 7 days スパークライン、Top categories 7d、主要な更新 10 件 |
| **TimelineList** | 最新エントリ (カード UI、重要度バッジ、カテゴリ色、JA/EN 要約トグル) |
| **Sidebar** | カテゴリ別件数 + 各 7 日スパーク |

### 6.5 検索

- **エンジン**: [Pagefind](https://pagefind.app/) (ビルド時に `web/dist` を走査して静的インデックス生成)
- **UI**: ヘッダの検索バーにインラインポップオーバー。タイプ中 120ms デバウンスで最大 10 件表示
- **操作**:
  - `/` キー: フォーカス
  - `Esc`: クリア + 閉じる
  - 外側クリック / フォーカス外: 閉じる
- **Dev 制約**: `npm run dev` ではインデックスが生成されないため、検証は `npm run preview` または本番環境を使用

### 6.6 匿名公開いいね

- **表示面**: Knowledge カードと記事詳細。
- **永続化**: Cloudflare Pages Functions から専用 D1 binding `REACTIONS_DB` を使用する。publisher data、Featured、Top 3、importance、taxonomy には影響しない。
- **匿名 voter**: `__Host-techdb_reaction_voter` HttpOnly cookie の UUID を server-side HMAC-SHA256 化し、生 UUID と IP address は D1 に保存しない。
- **mutation**: Turnstile 検証済みの desired-state `PUT` を使う。D1 の `(article_id, voter_hash)` primary key により再送を冪等にする。
- **制限**: いいねは記事を保存せず、archive 後の route 維持、account、my page、cross-device sync を提供しない。cookie 削除や別 browser は別票になる。
- **Progressive enhancement**: batch count の取得に成功した control だけを表示する。site key 未設定、API 障害、invalid entry では control、Knowledge の説明、記事詳細の reaction panel を非表示かつ inert にし、主記事 link を遮らない。
- **UI**: heart ではなく thumbs-up icon と `aria-pressed` を持つ 44px 以上の button を使う。利用可能時の Knowledge 説明は mobile でも表示し、記事詳細では source/share utility と分離した専用 reaction panel を使う。
- **Count**: visible count は compact notation で card geometry を守り、accessible name と tooltip には locale に沿った exact count を保持する。
- **Failure recovery**: busy 中も focus を維持する。失敗時は optimistic state を rollback し、server truth を再取得後、rate limit、Turnstile、service、network の原因別 JA/EN toast を表示する。toast は fixed mobile tabbar と Turnstile challenge より上の semantic layer に置く。

### 6.7 多言語表示

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
| Publisher 実行ログ | GitHub Actions `Publisher` |
| Bridge 実行ログ | `npx wrangler tail tech-dashboard-harness` or CF ダッシュボード Observability |
| 収集品質 | `quality-audit` Skill → `data/_runs/audit-*.md` |
| サイト稼働 | CF Pages ダッシュボード |
| RSS / JSON Feed | `/rss.xml`, `/feed.json` で公開 |

### 9.2 シークレット

| キー | 用途 | 管理場所 |
|---|---|---|
| `COPILOT_PAT` | Copilot Enterprise 一時トークン交換 | Queue consumerのWrangler Secrets / `.env.local` (ローカル) |
| GitHub Actions OIDC | bridge認証 | GitHub発行の短命token。repository secret不要 |
| `GITHUB_TOKEN` | data-only commit | GitHub Actions built-in token |

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
npx wrangler dev             # http://localhost:8787/health
npm run deploy -- --dry-run  # Free bridge bundle確認
npx wrangler deploy          # 本番 Worker 更新
npx wrangler tail            # 実ログ tail

# ===== Production Publisher =====
gh workflow run publisher.yml -f dry_run=true
```

---

## 11. 既知の制約 / 将来課題

| 項目 | 現状 | 計画 |
|---|---|---|
| Pages Git 連携 | 新規 Git Integration project へ移行 | 初回 deploy 成功後に `techdb.studio344.net` を移行 |
| 検索の日本語 stem | Pagefind 未対応 | 必要なら kuromoji プラガブル化 |
| Copilot 要約のレート | Publisher 1 runあたり最大35件をQueue投入 | KV日次上限とbacklogを監視 |
| ライト/ダーク切替 | 固定ダーク | 設定保持付きトグル予定 |
| 記事詳細ページ | なし (外部リンク直結) | OG 画像 / クリッピング保存機能 |
| 通知 (Slack / メール) | なし | 重要度 3 エントリを webhook 配信予定 |

---

## 付録 A. エンドポイント一覧

| エンドポイント | メソッド | 認証 | 説明 |
|---|---|---|---|
| `/health` | GET | public | Free bridgeのmode、binding、OIDC設定を確認 |
| bridge operations | POST | GitHub Actions OIDC | allowlist済みKV read/write、Queue送信 |
| Publisher | GitHub Actions | repository permissions | `0 * * * *` / `workflow_dispatch` |

## 付録 B. コミット規約

- Publisher 生成: `chore(data): update tech dashboard <ISO>`
- 機能追加: `feat(<scope>): ...` / 修正: `fix(<scope>): ...`
- `[skip ci]` は使用しない (Cloudflare Pages Git Integration の build skip と混同しないため)
