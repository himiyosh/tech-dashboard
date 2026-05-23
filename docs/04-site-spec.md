# 04. サイト仕様書 (統合ドラフト)

> **位置づけ**: `01-architecture.md` (システム設計) と `docs/mockups/mockup-D-portal-dark.html` (確定デザイン) を踏まえ、**実装前に確定すべき残り仕様**を網羅する。本書がレビュー合意後、実装フェーズ (P1) に移行する。
>
> **現状**: 本書は計画段階のドラフトであり、GitHub Actions / 13 カテゴリ / Tier 2 30 ソースなど古い前提を含む。Production の source of truth は [`SPEC.md`](SPEC.md)、`harness/registry.ts`、`.github/copilot-instructions.md` を参照する。

> **凡例**: ✅ = 確定済み / 🟡 = 本書で提案 (要合意) / ❓ = 未決 (選択肢提示)

---

## 0. 本書のスコープ

| 確定済み                             | 本書で確定                   |
| ------------------------------------ | ---------------------------- |
| アーキテクチャ (4 層 / 二重ハーネス) | 画面別詳細仕様               |
| データモデル (NormalizedEntry)       | 重要度スコア計算式           |
| デザイントーン (portal-dark)         | レスポンシブブレークポイント |
| 自動実行方針 (Copilot CLI × Actions) | 13 カテゴリ + 横断タグ確定   |
| デプロイ (Cloudflare Pages)          | Tier 2 データソース 30 確定  |
|                                      | URL 構造 / SEO               |

---

## 1. 情報アーキテクチャ

### 1.1 カテゴリ定義 ✅ (13 カテゴリ)

| #   | Slug        | 表示名      | 色                | カバー範囲                                                    |
| --- | ----------- | ----------- | ----------------- | ------------------------------------------------------------- |
| 1   | `copilot`   | Copilot     | `#5eead4` Teal    | GitHub Copilot / Workspace / Copilot CLI / Copilot Enterprise |
| 2   | `claude`    | Claude      | `#fbbf24` Amber   | Claude Code / Opus・Sonnet・Haiku / Anthropic API             |
| 3   | `codex`     | Codex       | `#93c5fd` Sky     | Codex CLI / ChatGPT Code / OpenAI o-series                    |
| 4   | `gemini`    | Gemini      | `#60a5fa` Blue    | Gemini Code Assist / Jules / Vertex AI / Gemini CLI           |
| 5   | `vscode`    | VSCode      | `#63a2ff` Azure   | エディタ本体 / Marketplace / Insiders                         |
| 6   | `cursor`    | Cursor      | `#94a3b8` Slate   | Cursor IDE / Background Agents                                |
| 7   | `cline`     | Cline / Roo | `#c4b5fd` Violet  | Cline / Roo Code など VSCode 拡張エージェント                 |
| 8   | `aider`     | Aider       | `#a3a16a` Olive   | Aider CLI / SWE-bench 関連                                    |
| 9   | `opencode`  | OpenCode    | `#a5b4fc` Indigo  | OpenCode (SST)                                                |
| 10  | `local-llm` | Local LLM   | `#f87171` Red     | Ollama / llama.cpp / vLLM / HF / Open WebUI                   |
| 11  | `agent-fw`  | Agent FW    | `#34d399` Emerald | Microsoft Agent Framework / LangGraph / AutoGen / CrewAI      |
| 12  | `mcp`       | MCP         | `#f472b6` Pink    | Model Context Protocol 本体・server/client エコシステム       |
| 13  | `research`  | Research    | `#fda4af` Rose    | arXiv / ニュースレター / 論文                                 |

**分類ルール**:
- 各エントリは**必ず 1 つのカテゴリに分類** (主軸)。横断的な属性は §1.1.1 のタグで表現
- 分類の優先順位: (1) プロダクト固有のソース (例: Cursor Blog → `cursor`) (2) ソース側の publisher が明確 (3) タイトル/本文のキーワード (4) 既定値 `research` (どのカテゴリにも該当しない論文・記事)

### 1.1.1 タグ (横断的分類) ✅

カテゴリに収まらない**横断的な属性**は `NormalizedEntry.tags[]` で管理。右サイドバーの Trending Tags で活性化され、検索フィルタとして機能する。

| 概念グループ                      | タグ例                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| ベンチマーク                      | `swe-bench`, `aider-leaderboard`, `humaneval`, `gpqa`        |
| オープンモデル                    | `llama`, `qwen`, `deepseek`, `mistral`, `gemma`              |
| RAG / Memory                      | `rag`, `vector-db`, `memory`, `knowledge-graph`              |
| AgentOps                          | `observability`, `langsmith`, `langfuse`, `helicone`         |
| Enterprise                        | `enterprise`, `governance`, `security`, `compliance`         |
| 特定プロダクト (単独カテゴリ未満) | `devin`, `windsurf`, `replit-agent`, `v0`, `bolt`, `lovable` |
| エントリ種別                      | `release`, `blog`, `paper`, `tutorial`, `changelog`          |

**言語属性** (カテゴリ・タグと独立した軸): `NormalizedEntry.lang: "ja" | "en"` で扱う

**カテゴリ昇格ルール**: タグで扱っている概念が過去 30 日で継続して週 5 件以上出現したら、独立カテゴリ化を検討 (§9 P3 タスク)

**変更履歴**:
- v0.9: 7 カテゴリ
- **v1.0: 13 カテゴリ** (Gemini / Cursor / Cline / Aider / Agent FW / MCP を追加、community→廃止)

**拡張性**: カテゴリ追加は `harness/collectors/<source>.ts` を 1 ファイル + `registry.ts` に 1 行追加 + 本書§1.1 の表に行追加で完結する (docs/01 §1.3 の拡張性方針と整合)。

### 1.2 URL 構造 🟡

| パス               | 役割            | 実装          |
| ------------------ | --------------- | ------------- |
| `/`                | トップ (portal) | mockup-D 準拠 |
| `/category/:slug`  | カテゴリ別一覧  | §3.2 参照     |
| `/entry/:id`       | エントリ詳細    | §3.3 参照     |
| `/search`          | 検索 (Pagefind) | §3.4 参照     |
| `/about`           | サイト概要      | 静的 MD       |
| `/status`          | 運用ステータス  | mockup-E 準拠 |
| `/feeds/all.rss`   | 全件 RSS        | 自動生成      |
| `/feeds/:slug.rss` | カテゴリ別 RSS  | 自動生成      |
| `/feeds/all.json`  | JSON Feed       | 自動生成      |

### 1.3 ナビゲーション構造 🟡

- **グローバルヘッダー**: Logo / Search / Theme (dark 固定) / GitHub リンク
- **左サイドバー** (常設): Timeline / Categories (13) / Importance filter (Major / All)
- **右サイドバー** (トップのみ): Trending タグ / 最近の変更 / Cost MTD

### 1.4 データソース ✅ (Tier 2 = 30 ソース)

運用方針: **MVP は Tier 2 の 30 ソースから開始**。Tier 1 (15 ソース) は core coverage、Tier 2 追加 (+15) で各カテゴリ最低 1 ソース以上を確保。Tier 3 (50+) は運用後にノイズ/重複度を見て検討。

#### Tier 1 (core 15 ソース)

| #   | カテゴリ                | ソース                    | 取得方法    | URL/Feed                                        |
| --- | ----------------------- | ------------------------- | ----------- | ----------------------------------------------- |
| 1   | copilot                 | GitHub Blog (AI tag)      | RSS         | `github.blog/category/ai-and-ml/feed/`          |
| 2   | copilot                 | GitHub Changelog          | RSS         | `github.blog/changelog/feed/`                   |
| 3   | claude                  | Anthropic News            | RSS         | `anthropic.com/news` (RSS)                      |
| 4   | claude                  | Anthropic Engineering     | RSS         | `anthropic.com/engineering` (RSS)               |
| 5   | codex                   | OpenAI News               | RSS         | `openai.com/news/rss.xml`                       |
| 6   | codex                   | OpenAI Blog               | RSS         | `openai.com/blog/rss.xml`                       |
| 7   | gemini                  | Google DeepMind Blog      | RSS         | `deepmind.google/discover/blog/rss.xml`         |
| 8   | gemini                  | Google Developers Blog    | Atom        | `developers.googleblog.com/feeds/posts/default` |
| 9   | vscode                  | VS Code Updates           | Atom feed | `code.visualstudio.com/feed.xml` (月次)          |
| 10  | local-llm               | Hugging Face Blog         | RSS         | `huggingface.co/blog/feed.xml`                  |
| 11  | local-llm               | Ollama Releases           | GitHub Atom | `github.com/ollama/ollama/releases.atom`        |
| 12  | research                | arXiv cs.CL               | RSS         | `rss.arxiv.org/rss/cs.CL`                       |
| 13  | research                | arXiv cs.SE               | RSS         | `rss.arxiv.org/rss/cs.SE`                       |
| 14  | research (lang:ja タグ) | Zenn AI タグ              | RSS         | `zenn.dev/topics/ai/feed`                       |
| 15  | copilot (lang:ja タグ)  | Qiita GitHub Copilot タグ | Atom        | `qiita.com/tags/githubcopilot/feed.atom`        |

#### Tier 2 追加 (+15 ソース、計 30)

| #   | カテゴリ  | ソース                       | 取得方法    | URL/Feed                                       |
| --- | --------- | ---------------------------- | ----------- | ---------------------------------------------- |
| 16  | cursor    | Cursor Changelog             | HTML scrape | `cursor.com/changelog`                         |
| 17  | cursor    | Cursor Blog                  | RSS         | `cursor.com/blog` (要確認)                     |
| 18  | cline     | cline/cline Releases         | GitHub Atom | `github.com/cline/cline/releases.atom`         |
| 19  | cline     | RooCodeInc/Roo-Code Releases | GitHub Atom | `github.com/RooCodeInc/Roo-Code/releases.atom` |
| 20  | aider     | paul-gauthier/aider Releases | GitHub Atom | `github.com/paul-gauthier/aider/releases.atom` |
| 21  | aider     | Aider Blog                   | RSS         | `aider.chat/blog/`                             |
| 22  | opencode  | sst/opencode Releases        | GitHub Atom | `github.com/sst/opencode/releases.atom`        |
| 23  | local-llm | ggerganov/llama.cpp Releases | GitHub Atom | `github.com/ggerganov/llama.cpp/releases.atom` |
| 24  | local-llm | vllm-project/vllm Releases   | GitHub Atom | `github.com/vllm-project/vllm/releases.atom`   |
| 25  | local-llm | Meta AI Blog                 | RSS         | `ai.meta.com/blog/rss/`                        |
| 26  | agent-fw  | LangChain Blog               | RSS         | `blog.langchain.dev/rss/`                      |
| 27  | agent-fw  | Microsoft AI Blog            | RSS         | `blogs.microsoft.com/ai/feed/`                 |
| 28  | mcp       | modelcontextprotocol.io Blog | HTML scrape | `modelcontextprotocol.io/blog`                 |
| 29  | research  | Hugging Face Papers          | HTML scrape | `huggingface.co/papers`                        |
| 30  | research  | Simon Willison's Weblog      | Atom        | `simonwillison.net/atom/everything/`           |

**注意事項**:
- **Feed 未公開ソース (Cursor / MCP / HF Papers / VSCode Updates)** は収集器側で HTML パースを実装。構造変更に脆いため、失敗時のリトライとセレクタ fallback を実装 (§8 運用観点)
- **GitHub Atom Feed** はレート制限なし (unauthenticated で可)、新規追加コストが低い
- **arXiv** は 1 日 1 回の cron に合わせてバッチ取得。タグで `cs.LG` `cs.AI` を追加する余地あり (Tier 3)
- **ソースごとの `tags[]` 自動付与ルール**: 例として `aider` ソース → `aider`, `swe-bench` を auto-tag、`arxiv` → `paper` を auto-tag

**除外基準**: 過去 90 日で 0 記事 / 3 回連続失敗 / SLO 未達 (§8 運用) の場合、ソースを一旦 disable して運用ログで通知

---

## 2. 画面ヒエラルキー ✅

モック D で確立した**視線誘導順序**:

```
[1] Banner        - サイトアイデンティティ (初回訪問者向け)
[2] Stats strip   - 数値サマリ (フラット、低視覚重み)
[3] Featured      - 今日の目玉 1 件
[4] Timeline ★    - 最新エントリ一覧 (Teal 2px アンダーラインで最強調)
[左] Categories   - フィルタ用ナビ (重複削除済)
[右] Sidebar      - 補助情報
```

---

## 3. 画面別仕様

### 3.1 トップ (`/`) ✅

mockup-D に準拠。以下を補足:

| 要素              | 仕様                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Banner 表示条件   | 常時表示 (クリッカブルな閉じるボタンは追加しない)                                         |
| Featured 選定     | `importance === 3` の最新 1 件。該当なしなら `importance === 2` の最新                    |
| Timeline 表示件数 | 初期 14 件。無限スクロールで +20 件ずつ追加 (最大 100 件、それ以降はカテゴリページへ誘導) |
| NEW バッジ        | `collectedAt` から 6 時間以内                                                             |
| Trending タグ     | 過去 24h の出現頻度 Top 10                                                                |

### 3.2 カテゴリ別 (`/category/:slug`) 🟡

**レイアウト**: トップの Banner / Stats / Featured / 右サイドバーを除去し、中央列のみの 1 カラムレイアウト。

**含める要素**:
- カテゴリヘッダー: ブランドタイル + カテゴリ名 + 総件数 + 直近 7 日件数 + 前週比
- **トレンドグラフ** ⭐: 過去 30 日の日別記事数をスタックバーで表示。直近 7 日は vivid、それ以前は薄色、サブカテゴリ別に色分け (例: Claude なら Anthropic News / Engineering / Releases / Papers)。KPI ヘッダー (This week / Last week / Daily avg / Peak) 付き
- ソート: 新着順 (デフォルト) / 重要度順 / スコア順
- Timeline: 全件を 20 件ずつページネーション
- RSS 購読ボタン: `このカテゴリを RSS 購読 →`
- 左サイドバー: 継続表示 (各カテゴリ横にスパークライン — §3.2.1 参照)

**トレンドグラフ仕様**:
- 横軸: 過去 30 日 (日単位、7d/30d/90d 切替タブ)
- 縦軸: 日別記事数 (自動スケール、サブカテゴリでスタック)
- 直近 7 日: vivid カラー、8 日以上前: opacity 35% + saturate 50%
- 実装: Pure HTML/CSS (JS ライブラリ不使用、`<div class="bar"><div class="seg"></div></div>`)
- ホバー時のツールチップは P2 で追加 (MVP では静的表示)

### 3.2.1 サイドバー・スパークライン ⭐

左サイドバーの各カテゴリ項目の右横に、直近 7 日間の日別記事数を示す**ごく控えめなスパークライン**を表示。サイズ・彩度を抑え、カウンタの補助情報として機能。

**仕様**:
- サイズ: **26x9px** (控えめ、カテゴリ名とカウンタの間)
- バー数: 7 本 (直近 7 日)
- 色: **単一 muted グレー** (`--muted-2`) ベース。アクティブなカテゴリのみ `--accent` を使用
- 透明度: 通常 opacity 0.45、hover 0.75、active 0.9 (主張を抑える)
- 実装: Pure HTML + CSS のみ (SVG も JS ライブラリも不要)
- 目的: カテゴリの活性度シグナルとして背景に溶け込ませる (§3.2 のメイングラフとの視覚的役割分担を明確化)

### 3.3 エントリ詳細 (`/entry/:id`) 🟡

**選択肢**: 詳細ページを作るか作らないか

| オプション            | 内容                                                 | 推奨度      |
| --------------------- | ---------------------------------------------------- | ----------- |
| **A. 詳細ページなし** | カード全体を外部リンクにし、クリックで原文へ直接遷移 | ⭐⭐⭐ (MVP)   |
| B. 簡易詳細ページ     | 原文要約 + メタ情報 + 原文遷移ボタン                 | ⭐           |
| C. フルミラーリング   | 原文本文をキャッシュ配信                             | ❌ (法務 NG) |

**推奨**: **A**。SSG サイトでは詳細ページを作ると JSON ファイル数が倍増してビルド時間と Pagefind インデックスサイズが膨らむ。カード自体に要約が表示されており、原文への導線がメインユースケース。P2 で必要があれば B を追加。

### 3.4 検索 (`/search`) 🟡

- **実装**: [Pagefind](https://pagefind.app/) (ビルド時静的インデックス、クライアントサイド JS)
- **対象**: title / summaryJa / summaryEn / tags / category
- **UI**:
  - ヘッダー検索ボックスでインクリメンタル候補表示 (最大 5 件)
  - Enter or 「すべての結果を見る」で `/search?q=...` へ
  - 検索結果はカード形式 (Timeline と同構造) で表示
- **フィルタ**: カテゴリ / 期間 (24h / 7d / 30d / all) / タグ
- **言語**: 日英どちらでもヒット (両 summary をインデックス化)

### 3.5 About (`/about`) 🟡

- サイト目的・運営者・更新頻度・ソース一覧・ライセンス (コンテンツは各ソース帰属、本サイトコードは MIT)
- コスト透明性: 「月間コストは $X 程度で運用中」と公開 (LLM 情報発信コストの可視化)

### 3.6 Status (`/status`) ✅

mockup-E に準拠。以下の情報を表示:
- 各ソースの稼働状況 (過去 7 日の成功率バー)
- 最終収集時刻
- LLM 呼び出し数 / コスト (MTD)
- ビルド状況 (最終ビルド成功時刻、Lighthouse スコア)

---

## 4. 重要度スコア算出式 🟡

`importance: 1 | 2 | 3` は決定論的に算出 (LLM 不使用):

```
スコア = base(sourceType) + boost(keyword) + recency(publishedAt)

base(sourceType):
  release     → 50
  paper       → 35
  changelog   → 30
  blog        → 25
  tutorial    → 20
  community   → 10

boost(keyword) (タイトル・要約に含まれる場合、最大 +40):
  "major release" / "GA" / "v[数字].0"  → +30
  "breaking" / "deprecation"            → +25
  "preview" / "beta"                    → +10
  著名モデル名 (Opus/Sonnet/GPT-5/Gemini) → +15
  (複数一致でも加算は上限 40)

recency:
  24h 以内  → +10
  48h 以内  → +5
  それ以外  → 0

importance:
  score >= 75 → 3 (Major)
  score >= 50 → 2 (Normal)
  else        → 1 (Minor)
```

**Featured 選定ロジック**: importance 3 の最新 → なければ 2 の最新。同スコアなら publishedAt 降順。

---

## 5. データ・機能仕様

### 5.1 NormalizedEntry 拡張 🟡

docs/01 の定義に以下を追加:

```ts
interface NormalizedEntry {
  // ... docs/01 の既存フィールド

  score: number;           // 0-100 (§4 の算出式)
  isNew: boolean;          // collectedAt が 6h 以内 (ビルド時計算)
  readingTime?: number;    // 分 (原文の概算、OGP から取得可能なら)
  lang: "ja" | "en";       // 原文言語
}
```

### 5.2 画像取得戦略 ✅

docs/01 の 3 段フォールバック (RSS media → OGP → カテゴリ SVG) に準拠。補足:

- **Cloudflare Images 経由**: 直リンク禁止、必ず CDN 経由
- **サムネイル規格**: 320×180 WebP (LCP 配慮で <30KB 目標)
- **lazy loading**: `loading="lazy"` + `decoding="async"`
- **フォールバック SVG**: カテゴリ色 + ブランドロゴの組み合わせ (mockup-D の featured-hero-img スタイル流用)

### 5.3 検索仕様 ✅ (§3.4 参照)

### 5.4 フィルタ ✅

| 軸       | 選択肢                 | UI                 |
| -------- | ---------------------- | ------------------ |
| カテゴリ | 7 つ (単一選択)        | 左サイドバー       |
| 重要度   | Major only / All       | 左サイドバー下部   |
| 期間     | 24h / 7d / 30d / all   | 右サイドバー Range |
| ソート   | 新着 / 重要度 / スコア | カテゴリページのみ |

### 5.5 RSS / JSON Feed 🟡

- **含める項目**: title / link / pubDate / description (summaryJa) / category / enclosure (image)
- **エントリ数**: 全件版は最新 100 件、カテゴリ版は各 50 件
- **更新頻度**: ビルド毎に再生成
- **検証**: [W3C Feed Validator](https://validator.w3.org/feed/) で合格必須

---

## 6. デザインシステム

### 6.1 カラーパレット ✅ (mockup-D より)

| トークン      | 値        | 用途                         |
| ------------- | --------- | ---------------------------- |
| `--bg`        | `#1c1a17` | ページ背景 (warm dark, mild) |
| `--surface`   | `#2d2a26` | カード面                     |
| `--surface-2` | `#36322e` | ホバー時・強調面             |
| `--border`    | `#403b36` | 標準境界線                   |
| `--text`      | `#f5f5f4` | 本文                         |
| `--muted`     | `#b8b2ac` | 補助テキスト                 |
| `--accent`    | `#5eead4` | Teal (アクセント)            |
| `--important` | `#fbbf24` | Amber (コスト・警告)         |

### 6.2 タイポグラフィ 🟡

- **Sans**: `ui-sans-serif, system-ui, "Hiragino Sans", "Noto Sans JP"`
- **Mono**: `ui-monospace, "SF Mono", Menlo`
- **Base size**: 14.5px / 1.55
- **H1 (banner)**: 32px/1.2, weight 700
- **H2 (section)**: 16px (primary) / 11px (subtle)
- **Body**: 13-14.5px

### 6.3 レスポンシブブレークポイント 🟡

**基本方針**: **PC / タブレット / スマホ** の 3 段階。上限は設けず、4K 等高解像度にも適当に表示されるよう中央寄せレイアウトを採用。

| ブレークポイント | デバイス                       | レイアウト変化                                                                                                                                 |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `>= 1024px`      | **PC** (4K / ウルトワイド含む) | 3 カラム (左サイド 240px / メイン flex / 右サイド 300px)、`max-width: 1440px` でコンテンツを中央寄せ、24" 以上のモニターでも行長が長くならない |
| `768-1023px`     | **タブレット**                 | 2 カラム (左サイド 200px / メイン)、右サイドはフッター内に移動                                                                                 |
| `< 768px`        | **スマホ**                     | 1 カラム、左サイドはハンバーガーメニューでオーバーレイ表示、Banner visual 非表示、Stats 横スクロール                                           |

**4K / 大型モニター対応**:
- `max-width: 1440px` + `margin: 0 auto` でコンテンツ幅を制限 (過度に広がらない)
- フォントサイズは rem 基準 + `font-size: clamp(...)` でビューポート連動を避ける
- 画像は `srcset` / `sizes` で解像度対応 (Cloudflare Images の自動変換を活用)

### 6.4 アイコン ✅

SVG インライン (外部アイコンフォント不使用)。カテゴリアイコンは mockup-D に定義済み。

---

## 7. 非機能仕様

### 7.1 パフォーマンス目標 🟡

| 指標                     | 目標                 | 測定               |
| ------------------------ | -------------------- | ------------------ |
| LCP                      | < 2.0s (p75, Mobile) | Lighthouse CI      |
| FID / INP                | < 100ms              | Lighthouse CI      |
| CLS                      | < 0.1                | Lighthouse CI      |
| Lighthouse Performance   | >= 95                | CI ゲート          |
| Lighthouse Accessibility | >= 95                | CI ゲート          |
| トップページ JS サイズ   | < 50KB (gzipped)     | Astro build report |

### 7.2 アクセシビリティ 🟡

- **WCAG 2.1 Level AA** 準拠
- コントラスト比: 本文 4.5:1、大テキスト 3:1 を確保 (Palette は確認済)
- フォーカスリング: 全インタラクティブ要素に表示
- ランドマーク: `<header>` / `<nav>` / `<main>` / `<aside>` / `<footer>` を適切に使用
- ダークモード専用だが、OS のハイコントラストモードを尊重 (`prefers-contrast: more`)
- 画像には必ず `alt` 属性 (フォールバック SVG も含む)

### 7.3 SEO 🟡

- `<title>` / `<meta description>`: 各ページに固有値
- OGP: og:title / og:description / og:image (Featured のみ動的画像)
- JSON-LD: Article schema (エントリカードには不使用、トップは WebSite schema)
- sitemap.xml: Astro の `@astrojs/sitemap` で自動生成
- robots.txt: 検索エンジン許可 (bot-traps 排除)

### 7.4 ブラウザサポート 🟡

- モダンブラウザのみ (ES2020+)
- 具体対象: Chrome/Edge 最新 2 バージョン、Safari 最新 2 バージョン、Firefox 最新 2 バージョン
- IE11 / レガシー Edge: 非対応

---

## 8. 運用仕様

### 8.1 更新サイクル 🟡

- **頻度**: 毎日 1 回、JST 06:00 (UTC 21:00) (docs/01 の「1 日 2-4 回」からダウングレード、コスト抑制)
- **手動トリガー**: `workflow_dispatch` で随時実行可能
- **失敗時**: Actions が自動で 3 回リトライ (指数バックオフ)、それでも失敗なら Issue 自動起票

### 8.2 コスト管理 🟡

| 項目                  | 予算                            | 現状見込み                        |
| --------------------- | ------------------------------- | --------------------------------- |
| GitHub Actions        | 2,000 分/月 (Free)              | 日 5 分 × 30 日 = 150 分、余裕    |
| Cloudflare Pages      | 500 ビルド/月 (Free)            | 日 1 回、30 ビルド/月             |
| Cloudflare Images     | 5,000 変換/月 (Free)            | 日 20 件 × 30 日 = 600 変換、余裕 |
| **LLM (Copilot CLI)** | Copilot Enterprise サブスク内包 | **別課金なし ✅**                  |

→ **実質ランニングコスト $0** (Copilot Enterprise ライセンス以外)。

### 8.3 エラーハンドリング 🟡

| エラー種別                    | 対応                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Collector タイムアウト (>30s) | そのソースをスキップ、`/status` にエラー記録                                  |
| OGP 取得失敗                  | 即座にフォールバック SVG に降格                                               |
| LLM レート制限                | 60s 待機して 1 回リトライ、失敗時はそのエントリを skip (次回サイクルで再試行) |
| スキーマ検証失敗              | エントリを quarantine (`data/_quarantine/`)、Issue 自動起票                   |
| ビルド失敗                    | Cloudflare Pages の前回ビルドを保持 (サイトは落ちない)                        |

### 8.4 自動実行方式 ✅

**GitHub Actions + Copilot CLI (Programmatic Mode)** を採用、**デプロイ先は Cloudflare Pages のみ** (Workers 不使用)。

**構成**:
```
[GitHub Actions cron 21:00 UTC = JST 06:00]
   ↓
  Copilot CLI (copilot -p "...") で収集 + 要約 + タグ付け
   ↓
  git commit + push → main ブランチ
   ↓
[Cloudflare Pages 自動ビルド] ← push を検知してビルド・デプロイ
```

**この构成の理由**:
- Cloudflare Workers は V8 isolate ランタイムで、`copilot` CLI バイナリや Node.js API を実行できない
- Cloudflare Pages は GitHub リポジトリの push で自動ビルドされるため、スケジューラは GitHub Actions に一本化
- ユーザーの Copilot Enterprise ライセンス枠のみで LLM が動く (別課金なし)
- 参考: `/memories/repo/automation-decision.md`

---

## 9. 実装タスク分解 🟡

仕様合意後の実装フェーズ (P1 MVP) の大枠:

| #   | タスク                                                       | 依存 | 概算工数 |
| --- | ------------------------------------------------------------ | ---- | -------- |
| 1   | Astro プロジェクト雛形 + Tailwind 設定                       | -    | 小       |
| 2   | デザインシステム (tokens, 共通 Component)                    | 1    | 中       |
| 3   | NormalizedEntry スキーマ + Zod バリデータ                    | -    | 小       |
| 4   | Collectors 10 本 (RSS / GitHub API / arXiv)                  | 3    | 中       |
| 5   | 正規化パイプライン + dedupe                                  | 3, 4 | 中       |
| 6   | 画像 3 段フォールバック (OGP パーサ + Cloudflare Images)     | 5    | 中       |
| 7   | トップ画面 (mockup-D → Astro)                                | 2, 5 | 大       |
| 8   | カテゴリ / Status / About 画面                               | 7    | 中       |
| 9   | 検索 (Pagefind 導入)                                         | 7    | 小       |
| 10  | RSS / JSON Feed 生成                                         | 5    | 小       |
| 11  | Copilot CLI ワークフロー (.github/workflows/daily-fetch.yml) | 4-10 | 小       |
| 12  | Cloudflare Pages デプロイ設定                                | 11   | 小       |
| 13  | Lighthouse CI / Pagefind CI ゲート                           | 12   | 小       |

---

## 10. 合意事項チェックリスト (全項目合意済み ✅)

- [x] **§1.1 カテゴリ 13** (Copilot / Claude / Codex / Gemini / VSCode / Cursor / Cline+Roo / Aider / OpenCode / Local LLM / Agent FW / MCP / Research)、§1.1.1 横断タグで補完、拡張可能
- [x] **§1.4 データソース Tier 2 = 30 ソース** (Tier 1 core 15 + Tier 2 追加 15)。Tier 3 は運用後検討
- [x] **§1.2 URL 構造**: **MVP では `/entry/:id` を作らない**。後から SSG の `getStaticPaths()` 追加で生成可能 (SSG = ビルド時静的 HTML 生成、動的サイトではない)
- [x] **§3.2 カテゴリページにトレンドグラフ** (30 日スタックバー、サブカテゴリ色分け、7d/30d/90d 切替、`mockup-F` プレビュー済み)
- [x] **§3.2.1 サイドバー・スパークライン** (26x9 控えめ mini bar chart、Pure HTML+CSS、カテゴリ活性度の補助指標)
- [x] **§3.3 エントリ詳細ページ**: MVP では**作らない** (外部リンク直接遷移)。P2 で必要に応じて追加検討
- [x] **§4 重要度スコア算出式** (base + boost + recency、運用開始後に係数調整)
- [x] **§6.3 レスポンシブ 3 段階** (PC ≥ 1024px / タブレット 768-1023 / スマホ <768、4K 対応)
- [x] **§7.1 パフォーマンス目標** (LCP < 2.0s, Lighthouse >= 95)
- [x] **§8.1 更新頻度 1 日 1 回** (GitHub Actions 無料枠: 2,000 分/月、1 回 5 分想定 → 150 分/月で安全圏内。将来余裕が出れば 2-4 回/日に引き上げ可能)
- [x] **§8.2 ランニングコスト $0** (Copilot Enterprise ライセンス内包)
- [x] **§8.4 デプロイは Cloudflare Pages のみ、スケジューラは GitHub Actions + Copilot CLI**

---

## 11. 未決 / 将来課題 ❓

| #   | 項目                                            | 備考                       |
| --- | ----------------------------------------------- | -------------------------- |
| F-1 | お気に入り / ブックマーク                       | P2 候補、localStorage 実装 |
| F-2 | キーボードショートカット (`/` 検索, `j/k` 移動) | P2 候補                    |
| F-3 | Reddit / Hacker News ソース追加                 | P2 候補                    |
| F-4 | 通知 (Slack / Discord Webhook)                  | P2 候補、異常検知連動      |
| F-5 | PWA 化 (オフライン閲覧)                         | P3 候補                    |
| F-6 | i18n (英語 UI 提供)                             | P3 候補                    |

---

## 12. 次のステップ

1. **ユーザーレビュー**: §10 のチェックリスト項目についてフィードバック
2. **仕様確定**: フィードバック反映後、本書を v1.0 として固定
3. **docs/01, docs/03 の更新**: 本書と整合するよう更新 (カテゴリ追加、更新頻度等)
4. **実装フェーズ P1 開始**: §9 タスク分解に従い着手
