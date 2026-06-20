# tech-dashboard — Copilot 運用ルール / 自己学習ハーネス

このリポジトリで Copilot / agent が作業する際の絶対ルールと、過去事象から得た Lessons Learned を集約する。
新しい知見を得たら **同一セッション内で本ファイルに追記** すること（ユーザーから指摘される前に行う）。

> **共通ルールの参照**: 探索・計画・検証・ブランチ運用・UI 品質・セキュリティ・依存管理など**プロジェクト横断の作業ルール**は `.github/instructions/agentic-engineering-rules.instructions.md`、応答スタイル・言語・自己改善・エンコーディングなど**振る舞いルール**は `.github/instructions/agent-persona-rules.instructions.md` に集約している。本ファイルは、それらと重複しない **本プロジェクト固有の絶対制約 (R-xxx)** と **障害履歴 (LL-xxx)** だけを保持する。共通ルールと矛盾する場合は、より安全な側（確認必須・破壊回避）を採用し、判断が割れる箇所はユーザーに確認する。

---

## 🚨 絶対ルール (ABSOLUTE)

### R-001: デプロイは Cloudflare 完結。GitHub Actions を deploy 経路に使わない
- 本番反映フロー: **`main` push → Cloudflare Pages Git Integration が build & deploy**。
- `.github/workflows/*.yml` に `wrangler pages deploy` 等の deploy job を **追加してはならない**。
- ユーザーが明示的に依頼しない限り、`.github/workflows/` を新設しない。
- 緊急時のみ `npm --prefix web run deploy:legacy` (Direct Upload) を手動実行可。

### R-001b: main への直接 push / PR merge は必ず事前承認 (ABSOLUTE)
- `main` への **直接 commit / push** は禁止 (たとえデータファイルや scripts でも)。必ず作業ブランチ + PR 経由とする。
- `gh pr merge` / GitHub API merge / `git push origin main` を実行する前に **必ずユーザーに「main へ merge / push してよいですか」と確認** すること。
- 「即時反映したい」「データだけ」という理由で省略しない。Cloudflare Pages の本番 build がトリガーされ、サイトに即影響するため。
- 例外: ユーザーが当該セッションで明示的に「main に直接 push して」と指示した場合のみ。

### R-002: Cloudflare Pages project 設定の固定値
| 項目 | 値 |
|---|---|
| project name | `tech-dashboard` |
| Git Provider | `github` (himiyosh/tech-dashboard) |
| production branch | `main` |
| root directory | `web` |
| build command | `npm run build` |
| build output | `dist` |
| Node version | `22` (`web/.node-version`) |
| custom domain | `techdb.studio344.net` |
| pages.dev | `tech-dashboard-6a7.pages.dev` |
| account id | `0438e47e5e23f7acd006da2e594f3559` |

### R-003: Cloudflare API は Wrangler OAuth token を再利用する
- `~/Library/Preferences/.wrangler/config/default.toml` の `oauth_token` を Bearer で利用可。
- token 値・refresh_token を **絶対に画面/ファイル/コミットへ出さない**。
- 新規 `CLOUDFLARE_API_TOKEN` の発行をユーザーに依頼する前に、上記 OAuth token で API を叩いて済まないか試す。

### R-004: canonical URL の単一情報源
- サイト URL は `web/src/lib/site.ts` の `SITE_URL = "https://techdb.studio344.net"` を唯一の source of truth とする。
- `astro.config.mjs` / `rss.xml.ts` / `feed.json.ts` 等で URL をハードコードしない。

### R-005: web build は `web/` 配下で自己完結させる
- `web/src/**` から repo root 側 (`harness/`, root `package.json` の dependency) の **runtime コードを import しない**。
  - 型のみ (`import type`) は許可。
- 必要な metadata は `web/src/lib/*.ts` に静的データとして複製する（例: `web/src/lib/source-meta.ts`）。

### R-006: CI / pre-push は Cloudflare Pages build を必ず検知する
- `.github/workflows/ci.yml` はデプロイを行わないが、`npm --prefix web run build` 相当を必須 step に含める。
- `scripts/git-hooks/pre-push` は `SKIP_WEB_BUILD=1` が明示された場合を除き、push 前に `npm run build:web` を実行する。
- `npm run test:all` は `typecheck → unit → web build → e2e` の一括ゲートとする。

### R-007: 記事要約 / 補完 backfill のモデルは Claude 系 (Sonnet 4.6 / Opus 4.7) または GPT-5.5 に限定する
- 通常要約も補完/backfill も `SUMMARIZE_MODEL` は `claude-sonnet-4.6` / `claude-opus-4.7` / `gpt-5.5` のみ使用する。既定は **`claude-sonnet-4.6`** (Cloudflare Worker の 30 秒 wall-time に opus の長文生成が収まらず常時 timeout する事象を 2026-05 に確認、LL-031)。
- `gpt-4o` 等の旧モデルは記事要約 / 補完 backfill の代替モデルとして使用しない。
- `gpt-5.5` は Copilot の `/responses` 専用なので、現行 Worker (`/chat/completions`) からは利用できない (LL-010)。Worker を `/responses` 仕様に拡張するまで `claude-*` 系のみ実利用可能。
- 長文生成が詰まる場合は、max_tokens / timeout / concurrency を調整し、それでも必要なら `claude-opus-4.7` (品質優先) と `claude-sonnet-4.6` (速度優先) を切り替える。本番モデル変更は小 batch (`SUMMARIZE_MAX_NEW=1`) で smoke test してから適用する (LL-010)。

### R-008: Worker deploy は pre-push でも明示 opt-in にする
- `scripts/git-hooks/pre-push` は unit / web build / e2e の品質ゲートを必ず実行する。
- Worker deploy は `RUN_WORKER_DEPLOY=1` が明示された `main` push で、かつ `worker/` 差分がある場合のみ実行する。
- 通常の push で `wrangler deploy` を自動実行しない。ローカル認証・環境差分による意図しない Worker 反映を避けるため。

### R-009: secret 混入は commit / push 前に二重ゲートで防ぐ
- `.env*` / `.dev.vars*` / private key / credential 系ファイルは `.gitignore` と `scripts/scan-secrets.mjs` の両方で防ぐ。
- `scripts/git-hooks/pre-commit` は staged file の secret scan を必ず実行する。`SKIP_TYPECHECK=1` でも secret scan はスキップしない。
- `scripts/git-hooks/pre-push` は push 対象 commit range の secret scan を必ず実行する。
- 手動監査では `npm run secrets:scan:worktree` を使い、tracked + untracked non-ignored file を確認する。ignored local secret store は値を読まず path だけ警告する。
- secret scanner の出力に秘密値そのものを表示しない。検出種別、ファイル位置、hash、長さだけを出す。

### R-010: AI Scrum は Dev-time Harness として運用する
- AI Scrum は要件整理、分担、検証、振り返りの品質を上げるための開発時運用であり、Cloudflare Worker の収集 Runtime や Pages deploy 経路へ組み込まない。
- 複数領域の変更や仕様変更では `.claude/skills/ai-scrum/SKILL.md` を参照し、親エージェントが Orchestrator として PO / SM / Developer / QA / Security 観点を分離する。
- サブエージェントの結果は助言として扱い、最終判断、差分統合、DoD 判定は親エージェントが行う。
- AI Scrum を使っても main merge / push、Cloudflare deploy、Worker deploy の事前承認ルールは緩和しない。

### R-011: fresh entry merge で既存の要約/本文 enrichment を落とさない
- Worker が fresh entry と既存 `data/index.json` を canonical URL で merge する時、fresh entry が選ばれても既存 entry の `summaryJa` / `summaryEn` / `bodyJa` / `bodyEn` を保持する。
- `data/_summary-cache.json` に body がある場合は `npm run summaries:apply-cache` で `data/index.json` に明示反映し、cache 済み body が index 側で空の状態を残さない。
- 完了前に `tests/data-schema.test.ts` の cache/index body 反映チェックを通す。

### R-012: live index の本文欠落は 0 件にする
- `data/index.json` の live entries は `bodyJa` / `bodyEn` の両方を空にしない。完了前に `tests/data-schema.test.ts` の body 欠落ゲートを通す。
- LLM backfill が一部 URL で timeout / hang する場合は、小 batch で cache を回収した上で `npm run summaries:apply-cache -- --fill-missing-body` を使い、既存 summary と metadata から deterministic body fallback を cache / index の両方へ反映する。
- fallback は通常の LLM body を上書きしない。空欄補完と cache/index 乖離解消だけに使う。

### R-013: Worker publish 前に summary/body fallback を必ず適用する
- production Worker は `data/index.json` を commit する前に deterministic summary/body fallback を全 live entry に適用し、`summaryJa` / `summaryEn` / `bodyJa` / `bodyEn` のいずれかが空の payload を publish しない (両言語必須)。
- `scripts/apply-summary-cache -- --fill-missing-body` は cache が無い entry も補完できること。ローカル `_summary-cache.json` の有無を publish 可否の前提にしない。
- 英語タイトルのみの entry でも `summaryJa` は決定的な日本語テンプレートで埋める。逆も同様。JA / EN UI で cross-language fallback バッジを出さないこと (LL-028)。
- Worker runtime は Cloudflare Pages Git Integration では自動更新されない。`worker/src/**` の品質修正後は、明示承認を得て Worker deploy を実施し、古い Worker が invalid data を再投入しないことを確認する。

### R-014: Web UI 変更は Chrome Modern Web Guidance を先に検索する
- `developer.chrome.com/docs/modern-web-guidance` の方針に合わせ、`web/src/**/*.astro`、`web/src/**/*.ts`、`web/src/styles/**/*.css` で HTML / CSS / client-side JS、アクセシビリティ、パフォーマンス、セキュリティ、フォーム、モダン Web API に関わる変更を行う前に `.claude/skills/modern-web-guidance/SKILL.md` を参照する。
- 実装目的を 1 文にして `npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_05_16-c5e7870` を実行し、該当 guide がある場合は `npx -y modern-web-guidance@latest retrieve "<id>"` で詳細を読む。
- 広めの UI / CSS / パフォーマンス / セキュリティ変更では、個別 guide に加えて `accessibility`、`css`、`performance`、`security` の基礎 guide も確認する。
- Baseline Widely available ではない機能は guide の fallback 方針に従い、既存 Astro / CSS 構成に最小差分で適用する。
- mobile / fixed / sticky / overflow / z-index / safe-area の表示崩れでは `.claude/skills/ui-display-guard/SKILL.md` も併用し、Playwright viewport 検証まで行う。

### R-015: Primary navigation は explore shortcuts + hamburger menu の 2 層にする
- desktop / tablet の header は `Categories` / `arXiv` / `Knowledge` の 3 explore shortcut (`.header-switcher .nav-shortcut`) と `Menu` button (`#site-menu`) を primary navigation の source of truth とする。雑多なリンクを横並びに増やさない。
- explore shortcut は **direct shortcut** であり、`#site-menu` (`navItems`) には **含めない** (LL-054: direct shortcut を menu に重複表示しない)。`navItems` に置く secondary destination は `Timeline` / `Glossary` / `Archive` / `Status` / `About` + `Search` action のみ。`Glossary` (`/glossary`, AI/LLM 用語集) は鮮度減衰しないキュレーション知見なので explore shortcut / mobile tabbar には出さず、menu-owned の secondary destination にする (Glossary ページでは `Menu` trigger が active になる)。
- 3 explore shortcut は per-destination のアクセント色で識別する: Categories=`--accent` (teal), arXiv=`--paper` (blue, `.paper`), Knowledge=`--know` (emerald `#34d399`, `.knowledge`)。idle 時も nav-icon に薄い destination 色を付け、一覧性を保つ。Knowledge ページの accent (`#34d399`) と nav ボタン色を一致させる。
- mobile bottom tabbar は `Home / Categories / arXiv / Knowledge / Menu` の 5 action とする。explore shortcut (Categories / arXiv / Knowledge) は desktop header と mobile tabbar の両方に出し、どちらの viewport でも到達できるようにする。Search / Archive / Status / About は `#site-menu` に集約する。
- explore shortcut のページ (`/categories/`, `/arxiv/`, `/knowledge/`) では、その shortcut だけを active にし、`Menu` trigger を active にしない (`menuOwnsCurrentPage` は `navItems` 由来なので explore shortcut を含めない)。
- mobile (`max-width: 720px`) では header の `.header-switcher` を `display:none` にし、explore は bottom tabbar に集約する。header nav link row を page top に露出させない。
- homepage banner の `.banner-quick-links` も Categories / arXiv / Knowledge の 3 link を同じアクセント色で並べる。
- nav 変更時は E2E で desktop 3 explore shortcut 表示、desktop hamburger 表示、menu 内 secondary links (Archive / Status / About / Search)、menu 内 Categories / arXiv / Knowledge 非表示 (重複なし)、mobile tabbar 5 item と各 item 幅・横スクロールなし、Categories / Knowledge ページで該当 shortcut が active かつ Menu 非 active、menu open/close、Archive / About / Status / Search の menu 動線を必ず検証する。

### R-016: トップレベルページに breadcrumb を出さない
- Header nav / mobile tabbar の primary destination (`/`, `/categories/`, `/archive/`, `/status/`, `/about/`) には `.crumb-bar` を表示しない。ページの入口情報は `banner` / `PageHero` に集約する。
- Breadcrumb は article detail、category detail、tag detail、archive month、pagination など「親階層へ戻る文脈が必要な深いページ」に限定する。
- top-level page に `breadcrumb={...}` を渡す変更をした場合は、同時に理由を明記し、E2E の top-level crumb 非表示ゲートを更新する。原則は禁止。

### R-017: broad feed はカテゴリ品質フィルタと上限を必ず持つ
- `arxiv-*`、`techcrunch`、`the-verge`、`ars-technica`、vendor newsroom など broad feed は `includeKeywords` / `excludeKeywords` / `maxEntriesPerRun` を `harness/registry.ts` に設定し、汎用ニュースや無関係論文を大量流入させない。
- **ノイズキーワードは registry の `*_EXCLUDE_KEYWORDS` を単一ソースにする (LL-081)**。テスト (`tests/data-schema.test.ts` の「registry の excludeKeywords が適用漏れしていない」) はこの registry を `import` して参照するので、テスト側の正規表現に独自のノイズ語を足さない (足すと検出と予防が乖離し、収集素通り → 毎時 CI fail になる)。新種ノイズを見つけたら registry に追加し、`npm run noise:clean` で既存 live/archive を migration し、Worker を再デプロイする。
- ノイズ判定は **title スコープ**に限定する。url を含めると `arstechnica.com/gadgets/` のようなサイトセクション名に `gadget` 等が部分一致し、有効な開発記事を巻き込む。
- Zed は VSCode ではなく `cursor` 系カテゴリとして扱う。`zed-releases` を `vscode` に戻さない。
- Research は paper / report / long-lived research に寄せる。Zenn AI や Simon Willison のような実務・LLM essay feed は `local-llm` 等に分類し、Research を汎用 AI 記事の受け皿にしない。
- registry の category を変更したら `web/src/lib/source-meta.ts` と既存 `data/index.json` / `data/archive/*` / `data/stats.json` を同時に修復し、`tests/data-schema.test.ts` のカテゴリ品質ゲートを更新する。

### R-018: 完了前に自己批判スキルを必ず実行する
- すべてのタスクで「完了」と報告する前に `.claude/skills/self-critique/SKILL.md` を読み、C-01〜C-08 を今回の変更範囲に合わせて実行する。
- UI / ナビ / taxonomy / data artifact / 空状態 / テストに触れた場合は、該当 C 項目の検査コマンドを省略しない。
- 🔴 Critical / 🟠 Warning が出た場合は、ユーザーへ完了報告する前に修正し、再検査する。未解消で止める場合は理由と残リスクを明記する。
- 新しい再発パターンや根本原因を見つけた場合は、同一セッション内で本ファイルの LL に追記する。

### R-019: UX / taxonomy / navigation 変更はペルソナ回遊監査を使う
- 競争力評価、UX 改善、トップページ、検索、mobile nav、taxonomy、Status / About の信頼性表示を変更する場合は、`.github/agents/TechDBAgent.agent.md` を使い、複数 persona の Playwright / browser 回遊観点で問題を抽出する。
- persona audit は自己批判スキルを置き換えない。自己批判は規則・回帰・品質ゲート、persona audit は実ユーザー行動・競争力・判断摩擦の検出に使う。
- 2 つ以上の persona が同じ根本原因を報告した場合、severity を 1 段階上げ、完了前に修正または未解消リスクとして明記する。

### R-020: GPT-5.5 の応答は末尾に絵文字付きサマリを必ず付ける
- **対象モデル**: GPT-5.5 (または `gpt-5.5` 系モデルと識別できる場合)。
- **必須フォーマット**: 本文の説明や手順の**後に必ず**、以下の形式でサマリセクションを付ける。
  ```
  ---
  ## 📋 まとめ

  | 📌 項目 | 内容 |
  |---|---|
  | ✅ やったこと | ... |
  | ⚠️ 注意点 | ... |
  | 🔜 次のステップ | ... |
  ```
  テーブルの行は状況に応じて増減してよい。重要度に応じて 🔴/🟠/🟢 などの色付き絵文字も活用する。
- **絵文字の使い方の目安**:
  - 🎯 目的・ゴール   　✅ 成功・完了   　❌ 失敗・非対応
  - ⚠️ 注意・警告     　🔜 次のアクション　📁 ファイル・設定
  - 💡 ポイント       　🔗 参照・リンク   　🧪 テスト・検証
  - 🔴 致命的        　🟠 警告          　🟢 正常
- **本文は変えない**: サマリは末尾の追記のみ。本文の詳しい説明を削ったり、絵文字だらけにしたりしない。
- **省略条件**: 1-2 文で済む短い回答 (単純な Yes/No 確認など) ではサマリ不要。

### R-021: Visual review は DOM 寸法と画像 fallback まで見る
- mobile navigation を変更したら、`390x844` で `header .menu-trigger` が非表示、bottom tabbar が `Home / Categories / Menu` の 3 action、`#site-menu` が tabbar 由来の bottom-sheet として viewport 内に収まることを Playwright で検証する。
- Featured / article card の layout を変更したら、空リンクや fallback 要素が grid/flex の通常 flow に参加していないこと、thumb/body の bounding box が期待位置にあること、panel height が異常に伸びないこと、mobile 通常カードの thumbnail が本文幅を削らず article panel の境界 gap が見えることを検証する。通常カードの OGP thumbnail は mobile では非表示にしてよい。
- mobile home density を変更したら、`390x844` で hero 直下に重複 stats / 長い説明文の余白がないこと、最初の Featured/article が `y <= 340` 目安で見えることを Playwright 寸法で検証する。
- 外部 OGP / media image は失敗前提で扱う。`img.onerror` で deterministic fallback artwork を表示し、broken image icon を残さない。E2E は synthetic `error` event で fallback 表示を検証する。
- Persona audit はスクリーンショット印象だけで合格にしない。DOM metrics、console/network、画像 naturalWidth/error、focus state のいずれかを evidence として要求する。

### R-022: ベストプラクティス/知見ソースは evergreen で蓄積する (アーカイブしない)
- 各社のエンジニアリングブログ・ベストプラクティス・how-to など「鮮度で価値が減衰しない知見」は `harness/registry.ts` の `SourceDefinition.evergreen: true` を設定する。現行対象は `anthropic-engineering` / `github-blog-ai` / `github-copilot` / `microsoft-foundry` / `google-cloud-blog` / `aws-ml-blog` / `meta-engineering` / `netflix-techblog`。
- evergreen エントリは hot window 経過後も `warm` (個別 URL で addressable) に留め、`cold` (/archive 月次集約) / `dropped` (削除) にしない。判定は `harness/half-life.ts` の `decideTier` が `evergreen` を `hot` の次に評価して `warm` を返すことで行う。`normalize.ts` が全 fresh collect に `evergreen` / `halfLife` / `archiveTier` を stamp する。
- evergreen ソースを追加・変更したら: (1) `web/src/lib/source-meta.ts` に同期、(2) 既存 `data/index.json` を `npm run migrate:evergreen` (scripts/migrate-evergreen.mjs) で再 stamp、(3) `tests/half-life.test.ts` と `tests/data-schema.test.ts` の evergreen ゲートを通す、(4) Worker は Git Integration 非対象 (LL-073) なので明示承認のうえ deploy する。未 deploy だと stale Worker が evergreen を stamp せず既存知見が cold/dropped に戻りうる。
- broad feed のノイズ対策 (R-017) と両立させる。evergreen は「減衰させない」だけで、includeKeywords/excludeKeywords の品質フィルタは従来どおり適用する。
- 新しい feed を追加するときは、まず実 feed の per-item 日付有無 (LL-045) と RSS 可否を curl で確認する。RSS が無いサイト (例: Anthropic) は HTML スクレイパになり subrequest 予算と相談しながら collector limit を決める。
- evergreen 知見は news Timeline とは別の `/knowledge` レーンに蓄積表示する。`web/src/lib/data.ts` の `KNOWLEDGE_ENTRIES` (`evergreen === true`) と `knowledgeBySource()` を単一情報源にし、ソース別グルーピングで出す。ページは header の `Knowledge` explore shortcut と mobile tabbar の `Knowledge` タブから遷移する (R-015)。hot 期間の新着は Timeline にも出るが、恒久の置き場は `/knowledge`。evergreen ソースを増減したら `/knowledge` の E2E (header/tabbar の Knowledge shortcut 動線・ソース別グループ・menu 内 Knowledge 非重複) を通す。

### R-023: lane ページ (arXiv / Knowledge) は Timeline カテゴリサイドバーを出さず、左 rail にナビを揃える
- `Sidebar.astro` (`aside.left`, Timeline カテゴリ一覧) は **news Timeline 系ページ専用**である。`/`, `/page/[n]`, `/c/[slug]`, `/categories`, `/archive`, `/about` 等で使う。
- **lane ページ (`/arxiv`, `/knowledge`) は Timeline とは別レーン**なので、`Sidebar` (Timeline カテゴリ) を import / 配置しない。これらは `.layout.lane-layout` を使う。
- **ナビは左 rail に置く (LL-095)**。Timeline / Categories が左ナビなので、lane も `aside.lane-rail` を **main より前 (左)** に置き、`grid-template-columns: 264px minmax(0,1fr)` で左ナビに統一する。右 `aside.right` は使わない。`max-width: 980px` で rail を畳んで 1 カラムにする。
- lane rail は簡素にしない。`.lane-rail-id` (カテゴリ色アイコン + レーン名 + 説明 + 大きな件数 stat) を先頭に置き、その下に lane 固有の補助 (arXiv の code meaning / paper tags、Knowledge の sources ナビ + Tip) を `side-card` で並べる。`--cat-color` を lane の色 (arXiv=`#93c5fd`, Knowledge=`#34d399`) に設定する。
- Knowledge の知見一覧は Timeline 用の重い `EntryCard` を使わず、`KnowledgeCard.astro` (画像ありは 16:9 サムネ、無ければサムネ無し + 左アクセント) の 2 列グリッドにする (LL-091/093/094)。
- lane ページのレイアウトを変えたら E2E で「`.layout aside.left` が 0 件」「`.layout aside.right` が 0 件」「`aside.lane-rail` が main より左」「`.layout.lane-layout` 表示」「全幅 (1280〜390) で 3 カラムにならない・横スクロールなし」を検証する。

---

## 🧪 完了ゲート (LL Hook)

タスクを「完了」と報告する前に、以下を **必ず実行** すること。

1. ✅ **自己批判スキルを実行する** — `.claude/skills/self-critique/SKILL.md` の C-01〜C-08 を確認し、🔴 Critical / 🟠 Warning をすべて解消してから次へ進む
2. ✅ `npm --prefix web run build` がローカルで PASS する
3. ✅ Cloudflare Pages の最新 production deployment が `latest=deploy status=success`
4. ✅ `https://techdb.studio344.net/` と `https://tech-dashboard-6a7.pages.dev/` が `200`
5. ✅ 変更内容に応じて README / docs / 本ファイル (LL) を同一 commit で更新
6. ✅ 推論禁止ゲート: 出典のない断定を出力に含めない

### 自己批判スキルの使い方

```bash
# E2E 全件 (ナビ・モバイル・サイドバー・検索)
npx playwright test tests/e2e/smoke.spec.ts --reporter=line

# ナビ・モバイル絞り込み
npx playwright test tests/e2e/smoke.spec.ts -g "hamburger|mobile tabbar|navigation|sidebar" --reporter=line

# taxonomy / data quality チェック
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('./data/index.json','utf8'));
const live=d.entries;
const bycat={};
live.forEach(e=>{bycat[e.category]=(bycat[e.category]||0)+1;});
const total=live.length;
console.log('total entries:', total);
Object.entries(bycat).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>
  console.log('  '+k+': '+v+' ('+(v/total*100).toFixed(1)+'%)'));
const noSumJa=live.filter(e=>!e.summaryJa).length;
const noBody=live.filter(e=>!e.bodyJa&&!e.bodyEn).length;
console.log('no summaryJa:', noSumJa, 'no body:', noBody);
" 2>/dev/null
```

---

## 📚 Lessons Learned

### LL-001: Direct Upload の Pages project は Git Integration に変換不可
- **事象**: `tech-dashboard` (Direct Upload) を `main` push で自動 deploy したかったが、後付けで Git Integration を有効化できなかった。
- **根本原因**: Cloudflare Pages の仕様上、Direct Upload と Git Integration は project 作成時に決まり、後から切替できない。
- **対策**: project を **削除して同名で再作成** する。custom domain は削除前に外す必要がある (LL-002)。
- **教訓**: Pages project は最初から Git Integration で作る。Direct Upload 化を選ぶ理由が無ければ採用しない。

### LL-002: Pages project 削除前に custom domain を外す
- **事象**: `DELETE /pages/projects/{name}` が `code=8000028 "must first delete all custom domains"` で 400 失敗。
- **対策**: `DELETE /pages/projects/{name}/domains/{domain}` を先に実行してから project を削除する。
- **教訓**: 破壊的操作のエラーは即座にフォールバックせず、エラーコードを読んで前提条件を満たす。

### LL-003: `root_dir=web` build から repo root の runtime を import しない
- **事象**: `web/src/pages/status.astro` が `../../../harness/registry.ts` を import → Cloudflare build が `Rollup failed to resolve import "fast-xml-parser"` で失敗。
- **根本原因**: Cloudflare Pages は `root_dir=web` で `npm ci` するため `web/node_modules` しか持たない。harness 経由の root 依存は解決不可。
- **対策**: web 側に静的 metadata (`web/src/lib/source-meta.ts`) を複製し、harness runtime import を除去。
- **教訓**: web build は web で自己完結 (R-005)。新たに `web/src/**` から `../../../harness/` 系を import するコードを書かない。

### LL-004: GitHub Actions は本リポジトリの billing で起動できない
- **事象**: deploy workflow を追加したが job が `recent account payments have failed or your spending limit needs to be increased` で起動失敗。
- **対策**: そもそも GitHub Actions に依存しない構成 (R-001) を採用。
- **教訓**: 「workflow file を作った」だけでは検証完了ではない。job が実際に成功した run まで確認するか、依存しない設計に変える。

### LL-005: デプロイ完了報告前に実 URL を叩く
- **事象**: deployment status が `success` でも、custom domain は数十秒〜数分 `pending` のことがある。
- **対策**: API status と並行して `https://techdb.studio344.net/` を HTTP GET し、200 と本文に `TECH Dashboard` が含まれることを確認する。
- **教訓**: 「Cloudflare API が success と言った」=「ユーザーが見る URL が更新された」ではない。両方確認する。

### LL-006: 同名 project の subdomain は再利用される
- **事象**: 旧 `tech-dashboard` を削除し同名で再作成したところ、subdomain は `tech-dashboard-6a7.pages.dev` が再付与された。
- **教訓**: 同名で作り直しても旧 pages.dev URL は維持されるため、外部リンクの差し替えは不要。

### LL-007: テスト PASS と Cloudflare Pages build PASS は別ゲート
- **事象**: Unit / E2E が通っていても CI / pre-push が `npm --prefix web run build` を実行していないと、Cloudflare Pages build 失敗を事前検知できない。
- **根本原因**: E2E は dev server 経由で動くため、Astro static build + Pagefind の失敗を完全には代替しない。
- **対策**: CI、pre-push、`npm run test:all` に `npm run build:web` を追加し、Pages と同じ build command を必須ゲート化する。
- **教訓**: デプロイ先が build を行う構成では、テストとは別に本番 build parity を CI に含める。

### LL-008: 長文生成 backfill は timeout / concurrency / model fallback を用意する
- **事象**: 全記事の `bodyJa` / `bodyEn` を長文生成する際、Copilot hosted model の一部がレスポンスを返さず処理が停止した。
- **根本原因**: 長文 JSON 生成はモデル・負荷・出力長の影響を受けやすく、単発 request に timeout が無いと bulk backfill 全体が詰まる。
- **対策**: `SUMMARIZE_MAX_TOKENS`、`SUMMARIZE_TIMEOUT_MS`、`SUMMARIZE_CONCURRENCY` で出力長 / request timeout / 並列度を制御し、必要に応じて `SUMMARIZE_MODEL` を `claude-opus-4.7` から `gpt-5.5` に切り替える。
- **教訓**: bulk 生成タスクは「生成品質」だけでなく「失敗しても再開できる運用性」を先に組み込む。

### LL-009: 巨大 `data/index.json` の merge conflict は構造マージと単一 backfill で処理する
- **事象**: `main` 側の最新 worker run と本文 backfill branch の `data/index.json` が競合し、`git show :3:data/index.json` を Node の既定 buffer で読むと `ENOBUFS` になった。また、resummarize を重複起動すると同じ JSON への並行書き込みリスクが発生した。
- **根本原因**: `data/index.json` は巨大化しやすく、行ベースの conflict 解消や既定 buffer のままの一括読み込みに弱い。backfill script は完了時にまとめて JSON を書くため、並行実行に向かない。
- **対策**: `execFileSync` で stage blob を読む場合は `maxBuffer` を明示する。解決は URL/ID ベースの構造マージで行い、backfill は `pgrep -af 'resummarize|tsx'` で重複が無いことを確認してから小 batch で単一実行する。
- **教訓**: data merge 中は「最新 main の entries を保持し、本文・要約だけを構造的に移植する」。生成処理は複数本走らせない。

### LL-010: 許可モデルでも Copilot endpoint の利用可否を小 batch で確認する
- **事象**: `SUMMARIZE_MODEL=gpt-5.5` で補完 backfill を再実行したところ、Copilot Chat Completions endpoint が `unsupported_api_for_model` を返した。
- **根本原因**: 許可モデルであっても、現在使っている endpoint / アカウントで利用可能とは限らない。
- **対策**: 大量 backfill 前に `SUMMARIZE_MAX_NEW=1` の小 batch でモデルアクセスを smoke test する。`gpt-5.5` が使えない場合は許可モデル内の `claude-opus-4.7` で継続する。
- **教訓**: モデルポリシーと実 endpoint の対応状況は別ゲート。bulk 実行前に 1 件で確認する。

### LL-011: secret を読む確認は subagent に委譲しない
- **事象**: Cloudflare deployment 確認で「token を出さない」と指示したにもかかわらず、実行 subagent が Wrangler config の `oauth_token` 行を出力した。
- **根本原因**: secret を含む file / command を自律実行 subagent に任せると、意図しない debug output が露出し得る。
- **対策**: secret を読む必要がある command は agent 本体で直接実行し、stdout には status / id 等の非 secret のみ出す。可能なら Wrangler CLI や公開 URL check を優先し、`cat` / `grep` で token 行を表示しない。
- **教訓**: R-003 は tool 選択にも適用する。secret を含む設定 file は「読める」ではなく「表示しない」まで確認してから実行する。

### LL-012: backfill は最新 `origin/main` の data を基準に実行する
- **事象**: Opus 4.7 で 668 件を backfill 済みだったが、その後 `main` の worker run が 769 件の `data/index.json` を deploy し、本文未生成の記事で placeholder が再表示された。
- **根本原因**: backfill 済み branch が `origin/main` から遅れており、最新 worker run の entries に対して本文補完を実行していなかった。
- **対策**: backfill / deploy 前に必ず `git fetch origin main` と `git rev-list --left-right --count HEAD...origin/main` を確認し、behind があれば最新 `origin/main:data/index.json` を取り込んでから再生成する。完了判定は `data/index.json` と cache の両方で `missSummary=0`、`missBody=0`、`noCache=0`、`incompleteCache=0` を確認する。
- **教訓**: data worker が頻繁に `main` を進めるリポジトリでは、「ローカルで backfill 完了」だけでは不十分。公開直前の base commit と本番 data の鮮度を同じゲートに含める。

### LL-013: pre-push の Worker deploy は明示 opt-in にする
- **事象**: `scripts/git-hooks/pre-push` が `main` push の `worker/` 差分を検知すると、既定で `wrangler deploy` を実行する状態だった。
- **根本原因**: ローカル hook はユーザーの認証状態・環境変数・作業端末に依存するため、品質ゲートと本番反映が同じ既定フローに混在していた。
- **対策**: `RUN_WORKER_DEPLOY=1` が明示された場合だけ Worker deploy を実行するように変更し、README / SPEC / 本ルールを同期した。
- **教訓**: push 前の品質ゲートは既定実行でよいが、本番 Worker 反映は明示 opt-in に分離する。

### LL-014: quality-audit の鮮度は collectedAt 基準にする
- **事象**: release / research / optional source が、最新記事の `publishedAt` だけで stale/error 扱いになり、収集自体は成功している source まで問題に見えた。
- **根本原因**: 監査したい「pipeline が最近その source を収集できたか」と、上流が最近記事を公開したかを同じ freshness 指標で扱っていた。
- **対策**: 鮮度監査は `collectedAt` を主指標にし、`publishedAt` は上流活動の参考値として併記する。`source.type` ごとに threshold を分け、registry にあるが data に未出現の source は情報扱い、data 側にだけ存在する source は warning とする。
- **教訓**: 監査の severity は source の更新頻度・任意性・運用上の意味に合わせる。pipeline health と upstream activity を混ぜない。

### LL-015: data merge / Worker merge は canonical URL で dedupe する
- **事象**: 同一 Qiita/Zenn 記事が複数タグ feed から入り、`source` や `category` だけが違う重複 entry として `data/index.json` に残った。
- **根本原因**: entry ID が `source + url` 由来で、構造マージや source 別 feed では同一 URL でも別 entry として扱われ得る。tracking query 付き URL も単純な文字列比較では重複検出できない。
- **対策**: merge / audit では tracking query を除去し、YouTube は `v` を保持する canonical URL key で dedupe する。代表 entry は最新 `collectedAt`、次に `importance`、最後に `publishedAt` で選ぶ。
- **教訓**: data/index.json の構造マージは ID ではなく canonical URL を主キーにする。同一記事の multi-source 出現は category 分布より重複排除を優先する。

### LL-016: 日付なし collector は dashboard 上位を汚染しないようにする
- **事象**: VS Code release notes collector が `publishedAt: null` を返し、normalize が `collectedAt` を代入したため、過去の月次 release notes がすべて「今日の主要な更新」として表示された。
- **根本原因**: HTML index scrape では最近の release notes の実公開日を取れず、日付欠落を pipeline 側の収集時刻で補った。さらに主要更新 board の release grouping が version を含む title を同一系列としてまとめられていなかった。
- **対策**: VS Code は `feed.xml` の Atom `updated` を source of truth にし、future / Insiders entry を除外する。主要更新 board は release title の version/month token を除いた stem と source cap で同一 source の占有を防ぐ。
- **教訓**: `publishedAt` 欠落を `collectedAt` で補う source は、上位表示を汚染しやすい。collector ごとに実日付を取れる別 feed/API がないか確認し、UI 側にも多様性の上限を置く。

### LL-017: secret scan は `.gitignore` だけに依存しない
- **事象**: `.env.local` は ignore 済みだったが、誤操作や `git add -f` で secret が index / history に入るリスクが残っていた。
- **根本原因**: `.gitignore` は未追跡ファイルの既定除外であり、強制 add、既存 tracked file、過去 commit の secret 混入を防ぐ実行ゲートではない。
- **対策**: `scripts/scan-secrets.mjs` を追加し、pre-commit で staged file、pre-push で push 対象 commit range を redacted scan する。手動監査用に current / worktree / history scan npm script も用意する。
- **教訓**: secret 防止は ignore、commit hook、push hook、worktree 監査、履歴監査の多層防御にする。scanner は秘密値を出力せず、位置と hash だけを出す。

### LL-018: secret / branch safety は実行 subagent に委譲しない
- **事象**: 読み取り専用指示を付けた実行 subagent が `.env.local` の内容を表示し、さらにブランチ checkout / merge と見える操作を行った。
- **根本原因**: 自律実行 subagent は補助確認を追加で実行することがあり、secret を含む file や branch 状態を扱う作業では親エージェントの制御外の副作用が出る。
- **対策**: secret、認証 file、branch / merge / push に関わる確認は親エージェントが直接、出力を絞ったコマンドで実行する。subagent は secret を含まない read-only code search に限定する。
- **教訓**: 「読まないで」と指示するだけでは安全境界にならない。secret / branch safety は tool selection で担保する。

### LL-019: モバイル固定導線は専用 E2E で遷移と focus を検証する
- **事象**: モバイル下部タブバーに link と button が混在し、見た目の確認だけでは Categories / Sources / Status 遷移や Search focus の回帰を検知できない状態だった。
- **根本原因**: desktop smoke test と Pagefind search test は存在したが、mobile viewport で fixed bottom navigation を直接操作する E2E がなかった。button 内の icon / label など child element を click した場合の outside-click 判定も未検証だった。
- **対策**: `tests/e2e/smoke.spec.ts` に mobile viewport 専用テストを追加し、下部タブ表示、footer 非表示、各 link 遷移、Search button focus を検証する。button / popover の outside-click 判定では `target === button` ではなく `button.contains(target)` を使う。
- **教訓**: mobile 固定導線、sticky header、floating action など viewport 依存 UI を変更した場合は、desktop E2E とは別に mobile viewport の操作テストを追加する。icon 付き button は child click でも同じ挙動になるように検証する。

### LL-020: production Worker の publish 経路を local harness と別に検証する
- **事象**: local harness は `data/archive/*` と `data/stats.json` を生成していたが、production Cloudflare Worker は `data/index.json` だけを commit していた。記事数推移の説明では archive/stats による保持を前提にしていたが、本番 cron では同じ保持経路が未実装だった。
- **根本原因**: Node harness の publisher と Worker の GitHub Contents API publish が別実装で、機能追加時に production path の同期確認が不足した。
- **対策**: archive / stats の純粋ロジックを shared core に切り出し、Worker でも `data/archive/*`、`data/archive/_index.json`、`data/stats.json` を更新する。Web の DailySummary は live entries ではなく `data/stats.json` を優先する。
- **教訓**: ユーザーに retention / trend / deploy 挙動を説明する前に、local harness と production Worker の両方の publish 対象をコードで確認する。片方だけの実装を「本番で動く」と扱わない。

### LL-021: Worker の複数 data file 更新は 1 commit にまとめる
- **事象**: Worker が `data/index.json`、`data/archive/*`、`data/stats.json` を GitHub Contents API の個別 PUT で順番に更新すると、途中失敗時に index と archive/stats の不整合が残る可能性があった。
- **根本原因**: Contents API の file 単位更新を multi-file publish に流用していた。data artifact が複数に増えた時点で commit の原子性要件が変わっていた。
- **対策**: Worker publish は GitHub Git Data API で tree を作成し、変更ファイルを 1 commit にまとめて refs 更新する。要約 API も timeout / retry を持たせ、data artifact サイズ予算を test gate に入れる。
- **教訓**: Worker が複数の関連 artifact を publish する場合は、file 単位 API ではなく commit 単位 API を使う。途中成功を許す設計にしない。

### LL-022: カテゴリ推移グラフは `data/stats.json` を単一情報源にする
- **事象**: Sidebar の Categories sparkline は live entries の直近 7 日、Categories ページのカードは `data/stats.json` の月次推移を使っており、同じカテゴリでも記事数グラフが一致しなかった。
- **根本原因**: archive-backed な推移表示と live entries ベースの短期 sparkline が別々に実装され、期間とデータソースが分かれていた。
- **対策**: `web/src/lib/stats.ts` にカテゴリ別月次推移 helper を置き、Sidebar と Categories ページの両方から参照する。
- **教訓**: retention / trend を示す UI は `data/stats.json` を source of truth にする。新しいカテゴリ推移 UI を追加する場合は、ページ内で独自集計せず共有 helper を使う。

### LL-023: Sources と Status は運用確認面として分離しない
- **事象**: `/sources` と `/status` がどちらも source freshness / source metadata を扱い、ユーザーからページの意義が重複していると指摘された。
- **根本原因**: source inventory と source health を別ページにしたため、確認導線が分かれ、視認性の高い Status ページと情報が重複した。
- **対策**: source registry、freshness、Worker health は `/status` に統合し、`/sources` は互換リダイレクトにする。Nav も Status に一本化する。
- **教訓**: 運用確認系 UI は最も視認性の高い 1 画面を source of truth にする。新しい source 関連情報を追加する場合は `/status` に載せ、別ページを増やさない。

### LL-024: listing scraper は空 summary と日付欠落を publish しない
- **事象**: Timeline と記事詳細で Anthropic 記事の要約が空になり、4 月公開の記事が最新記事として表示された。
- **根本原因**: Anthropic collector が listing の slug だけを使い `contentSnippet: ""` と `publishedAt: null` を返していた。さらに normalize が空文字を有効な snippet と扱ったため、title fallback も効かなかった。
- **対策**: blank `contentSnippet` は title に fallback する。Anthropic collector は記事ページを取得して title / publishedAt / hero summary を抽出する。`data/index.json` は少なくとも 1 言語の summary を必須にするテストで守る。
- **教訓**: listing-only scraper を追加・変更する場合、記事 preview と publish date を detail page から取れるか確認する。取得できない場合でも collector / normalize のどちらかで deterministic fallback を必ず用意する。

### LL-025: body cache と live index の乖離を完了前に解消する
- **事象**: 最新 `data/index.json` では 669 件中 663 件の `bodyJa` / `bodyEn` が空で、そのうち 415 件はローカル `data/_summary-cache.json` に body が存在していた。
- **根本原因**: cache に body があっても live index へ再反映する gate が弱く、Worker の fresh/prior merge でも fresh raw entry が選ばれると既存 enrichment を落とし得る状態だった。さらにローカル cache と production KV cache は別物であるため、片方の充足をもう片方の publish 済みと見なせなかった。
- **対策**: `npm run summaries:apply-cache` を追加し、cache 済み要約/本文を明示的に `data/index.json` へ再反映する。Worker merge は `mergeEntryEnrichment` で既存 `summaryJa` / `summaryEn` / `bodyJa` / `bodyEn` を保持する。data schema test で cache に body がある entry は index 側にも body があることを検証する。
- **教訓**: summary と body は別の coverage 指標として扱う。deploy / 完了報告前には index と cache の両方を照合し、cache 済み body の未反映件数を 0 にする。

### LL-026: LLM body backfill が特定 URL で詰まる場合は fallback を使う
- **事象**: 既存記事の `bodyJa` / `bodyEn` backfill 中、Opus 4.7 が一部 URL で長時間応答せず、batch が完了せずに `data/index.json` への反映が遅れた。
- **根本原因**: 長文 body 生成は URL / ソース / 入力内容によって model latency が大きく、retry しても同一 entry で詰まり続けることがある。cache は成功ごとに増えるが、index は batch 完了まで更新されない。
- **対策**: 生成は小 batch で行い、詰まったら process を止めて `npm run summaries:apply-cache` で cache を回収する。LLM が通らない残件は `npm run summaries:apply-cache -- --fill-missing-body` で既存 summary と metadata から deterministic body fallback を作り、cache / index の両方へ書く。`tests/data-schema.test.ts` で `bodyJa` / `bodyEn` の欠落 0 件を gate 化する。
- **教訓**: LLM 品質を優先して粘りすぎると publish gate が詰まる。live UI には空欄を残さず、deterministic fallback を最後の安全網として用意する。

### LL-027: CI success 後も stale Worker が invalid data を再投入する
- **事象**: `f800209` で `data/index.json` の summary/body 欠落を 0 件にして CI が success したが、その後の毎時 Worker run が `bodyJa` / `bodyEn` 欠落 entry を main に再投入し、CI failure が連続した。
- **根本原因**: CI は push 後に `tests/data-schema.test.ts` で検知していたが、production Worker の publish 前 gate には同じ summary/body 欠落防止が無かった。さらに Worker runtime は Git Integration では自動 deploy されないため、repo 上の修正と実行中 Worker が乖離し得る。
- **対策**: Worker publish 前に deterministic summary/body fallback を適用し、`health.summaryFallbacks` / `health.bodyFallbacks` を記録する。ローカル修復 script も cache 不在 entry を補完できるようにする。Worker 修正後は明示承認を得て deploy する。
- **教訓**: data artifact の CI gate は「検知」だけであり、automated publisher の再発防止にはならない。Worker / bot / cron が main に push する repo では、publisher 側にも同じ publish 前品質 gate を持たせる。

### LL-028: 「少なくとも 1 言語」 gate は JA UI で空欄表示を防げない
- **事象**: ユーザーが JA 設定でサイトを開いた際、Timeline 上 240 件中 178 件で日本語要約が空欄になり、UI が EN フォールバックバッジを表示した。R-013 の publish 前 gate は通過していた。
- **根本原因**: `worker/src/content-fallback.ts` の `buildFallbackSummary` が英語タイトルの場合に `summaryJa: ""` を返していた。data-schema test も「少なくとも 1 言語の summary がある」しか検証していなかったため、片言語空欄を許容してしまっていた。UI 側は `summaryForLangWithFallback` で cross-language フォールバックするが、JA UI に EN テキスト + `EN` バッジが出るのは UX 上「日本語要約が表示されない」と認識される。
- **対策**: Worker fallback と `apply-summary-cache.mjs` の双方で deterministic summary を JA / EN 両言語に必ず populate するよう変更。data-schema test を `summaryJa` AND `summaryEn` 両方非空に強化。fallback テンプレートは英語タイトル時に短い日本語テンプレート (「{title} ({source}) の {category} 関連アップデート。AI 要約未生成。」) を、日本語タイトル時に英語テンプレートを生成する。
- **教訓**: 多言語 UI を持つ data artifact では「1 言語以上」ではなく「全 UI 言語で非空」を gate 条件にする。fallback ロジックは bilingual を仕様として明示する。

### LL-029: title も bilingual 表示を保証する (EN UI でタイトル空白)
- **事象**: EN 表示に切り替えると Qiita / Zenn 等の日本語 source の entry でタイトルが空欄 (一部画面では `(no English title)` の灰色プレースホルダー) になり、内容が把握できない状態になった。`data/index.json` 240 件中 44 件で `titleEn` が空。
- **根本原因**: `titleForLang(e, "en")` が EN title / EN summary / 英語 title の何れも無い entry に対して空文字列を返す仕様だった。LL-028 で summary は bilingual 必須化したが、title 側の UI フォールバックは未整備で、`<span class="i18n-en">` に空が直接流し込まれていた。Worker collector 側で `titleEn` を埋めるのは原文を翻訳することになり deterministic fallback の範疇を超える。
- **対策**: `web/src/lib/data.ts` に `titleForLangWithFallback` を追加し、要求言語が空なら他言語タイトルにフォールバックして `{ text, isFallback, fallbackLang }` を返す。EntryCard / TickerBar / DailySummary / index.astro の Featured / Top-3 を helper 経由に変更し、フォールバック時は `JA` / `EN` の小バッジを title 先頭に付与して原文言語を明示する。e2e に Timeline 全カード両言語スロット非空のリグレッションテストを追加。
- **教訓**: 多言語 UI コンポーネントは「primary が空でも other-lang に必ずフォールバック」する helper を経由する。コンポーネント側で `|| "(no XX title)"` のような後付けプレースホルダーで補わないこと (空白回避はできても情報量がゼロになる)。helper の返値で fallback フラグを伝搬し、UI 側で言語バッジを出して読者に原文言語を伝える。

### LL-030: `export { ... } from "./..."` はローカル binding を作らない (Worker summarize 全失敗)
- **事象**: Cloudflare Worker の毎時 run で `summarized: 0, summarizeErrors: 15` が連続発生し、placeholder 要約が実 AI 要約に置き換わらなかった。`wrangler tail` で確認すると `(warn) [worker] summarize err <url>: ReferenceError: buildPrompt is not defined` が全 entry で出ていた。
- **根本原因**: [worker/src/index.ts](worker/src/index.ts) で `export { buildPrompt, parseResponse } from "./prompt.ts";` と **re-export のみ** していた。ECMAScript 仕様上、`export ... from` は他モジュールの export を中継するだけで、**現モジュールのローカルスコープには binding を作らない**。同モジュール内の `callCopilot` が `buildPrompt(e)` を呼び出した瞬間 `ReferenceError` になる。TypeScript の型チェックは re-export を通じて symbol が見える錯覚を起こすため、`tsc --noEmit` でも検出できなかった。長期間動いていたのは esbuild の古い挙動が偶然 binding を生成していたためで、wrangler/esbuild の更新後に問題が顕在化した。
- **対策**: `import { buildPrompt, parseResponse } from "./prompt.ts";` を追加し、`export { buildPrompt, parseResponse };` と分離。Worker を即時 deploy。コメントで「import を必ず分離し、`export ... from` のみは禁止」と明記。
- **教訓**: 同モジュール内で symbol を **呼び出す目的** で必要な場合、re-export 一行で済ませない。`import` + `export` を必ず分離する。TypeScript の `noUnusedLocals` 等は再 export パターンを誤検知から守らないので、runtime テスト (実 fetch を mock で叩く統合テスト or wrangler tail) で初めて気付くことが多い。CI を毎時 run の結果 (`summarized` / `summarizeErrors` ヘルス) で監視する。

### LL-031: Worker wall-time に opus 4.7 の長文生成が収まらない

### LL-032: 日次バーが Purge で縮むのは PER_SOURCE_CAP と hot tier 未 archive の合わせ技
- **事象**: `DailySummary` の Last 7 days バーで、05/07=21・05/12=178 のように過去日ほど件数が小さくなり、upstream の実活動を反映していない状態だった。
- **根本原因**: (a) Worker は merged entries を `PER_SOURCE_CAP=50` で source ごとに切り詰めるが、捨てた entry は archive にも残さない。(b) `groupArchiveEntries` は `archiveTier in {"warm","cold"}` のみ archive 対象で、hot tier は archive されない。Half-life の hot 期間 (news=14 日) 中に PER_SOURCE_CAP で押し出された entry は live にも archive にも残らず、`stats.byDay` から永久に消える。
- **対策**: `groupArchiveEntries` に `includeHot?: boolean` オプションを追加し、Worker publish 経路では `{ includeHot: true }` を渡して当月 hot entry も `data/archive/{YYYY-MM}.json` に常駐させる。`buildStatsPayload` の入力 (`live + archive`) が安定するため、PER_SOURCE_CAP で live から押し出されても byDay からは消えない。UI 側は日次バー下に「過去日は保持ポリシーで縮みうる」注記と直近 6 ヶ月の月次推移ミニパネルを併設し、長期トレンドは archive 確定済みの `stats.byMonth` を参照させる。
- **教訓**: 「live + archive を集合した byDay」と言っても、archive が warm/cold tier しか拾わなければ hot 期間内の eviction が穴になる。dashboard の集計が purge 機構と独立に正確であるためには、「eviction の可能性がある層は事前に archive へ複製する」必要がある。tier 分類は live retention のためのもので、stats の母集団とは別軸で考える。

### LL-033: cron `scheduled()` 内では `ctx.waitUntil` ではなく `await` で実行する
- **事象**: 2026-05-13 のデプロイ以降、毎時 cron が `scriptThrewException` で失敗し続け `data/index.json` が約 1 日更新されなかった。`wrangler tail` で `(warn) waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled. ... batch 1/4 (13 of 50 sources)` を確認。
- **根本原因**: `scheduled()` ハンドラが `ctx.waitUntil(runHarness(env))` でタスクを投げて即 return しており、Cloudflare の「invocation end 後の waitUntil 残り時間（短い）」内にハーネスが終わらず cancel されていた。scheduled handler 自体は cron wall-time をフルに使えるのに、waitUntil で待つと別枠の短い budget に縛られる。
- **対策**: cron 経路の `scheduled()` は `await runHarness(env)` で直接実行する。ctx.waitUntil は fetch handler から「レスポンスを即返したいが裏で短時間処理を続けたい」場合専用。手動 trigger `/run` (fetch) は HTTP 即時返却が必要なので waitUntil のまま残し、デバッグ用途と割り切る。
- **教訓**: Workers の `scheduled()` と `fetch()` で `ctx.waitUntil` の意味する budget は異なる。長時間処理が必須の cron では `await` を使い、handler が自然に終わるまで wall-time を確保する。waitUntil は「invocation 終了後の追加猶予」であり、本処理を載せる場所ではない。

### LL-036: Worker subrequest 上限超過の真因は archive Contents API ループ
- **事象**: PR #37 で anthropic 詳細 fetch を 5 件に絞り COLLECT_CONCURRENCY=5 にしても batch 0 cron が `Too many subrequests` で失敗し続けた。推測では「他に重い collector がある」と思い込んでいた。
- **根本原因 (実測)**: 2026-05-15 に `/diag/run-batch?batch=0` へ subrequest プロファイラ (`globalThis.fetch` ラッパ) を仕込んで実測した結果、論理 fetch 51 回中 **`api.github.com/repos`** が **28 回** で全体の 55% を占めていた。内訳は `data/archive/*.json` の月別 ContentsAPI GET (25+ months) で、`publishHistoryFiles` の `ghGetFile` ループ (LL-021 で既知) が batch 毎に毎回全月をリフェッチしていた。anthropic は 6 件 / qiita 3 件 / techcrunch 3 件で想定内。Cloudflare は redirect も subrequest にカウントするため、論理 51 が実際 1000 超に膨らんで budget 枯渇。
- **対策**: profiler を `/diag/run-batch` に常設 (PR #38) → archive 取得を raw.githubusercontent.com の並列読み (PR #40) と、stats.json の差分更新化 (PR #41) に置換。`publishHistoryFiles` は触った月だけ読み、既存 `data/stats.json` を baseline に old/new touched-month 差分を加減して新 stats を作る。結果: batch 0 の論理 fetch 51 → 47 (HTTP 200 復帰)、batch 1=37、batch 3=45 で全 batch 成功。
- **教訓**: 「Too many subrequests」を見たら推測で collector を疑う前に、必ず `globalThis.fetch` ラッパで実測する。Cloudflare の subrequest はライブラリ的に「fetch 呼び出し回数」ではなく「redirect 含む実通信回数」で計上され、Standard プラン (1000/inv) でも redirect 増幅で論理 50 回前後で枯渇しうる。アプリ側で削減すべきは「論理 fetch 回数」「redirect が多い URL」「ループ内の API 呼び出し」の 3 つ。長期 stats の累積コストは差分更新パターンで吸収する。

### LL-037: Worker での summarize は CPU 時間 30s 上限に阻まれる
- **事象**: subrequest 問題を PR #38/#40/#41/#45 で解消した後、`SUMMARIZE_MAX_NEW=1` で summarize を復活させたところ `/diag/run-batch?batch=0` が HTTP 503 を返し、`wrangler tail` に `Error: Worker exceeded CPU time limit` が出た。HTTP 200 で返るケースでも `stats.summarized=0 / errors=1` が連続。
- **根本原因**: Cloudflare Workers Standard plan の CPU 時間上限は 1 invocation 30 秒。Copilot の長文 bilingual JSON (max_tokens=2400, claude-sonnet-4.6) を fetch して parse する CPU コストと、`publishHistoryFiles` 内の archive merge / `buildIncrementalStats` / 巨大 JSON パース (例: `2026-05.json` の 5000+ 行) の CPU が合算され 30s を超過する。subrequest と違って redirect / fetch wait は CPU 時間に算入されないが、本体の JSON 操作だけで限界に達する。
- **対策**: Worker は collection + publish に専念させ、`SUMMARIZE_MAX_NEW=0` を維持。要約生成は CPU 制約のないローカル `npm run resummarize` (scripts/resummarize.mjs, Copilot を直叩き) で行う。Worker は cache に既に入っている要約を流す経路のみ担当する。
- **教訓**: Cloudflare Worker の制約は subrequest, wall-time, CPU time, simultaneous connections の 4 軸あり、各々別に上限がある。ある軸を緩めても別軸が次のボトルネックになる。「subrequest 余裕がある = summarize 復活できる」と推測せず、CPU を消費する処理 (重い JSON parse, 統計集計, AI レスポンス処理) を Worker に積む前に CPU 予算を実測する。重い処理はローカルや別 Worker / Queue に逃がす。

### LL-038: Queue consumer の cache.v1 blob R/M/W は 30s CPU 予算を食う
- **事象**: 2026-05-15、Queue 経由の per-message summarize を ENABLE_SUMMARY_QUEUE=1 で復活させたところ、summarizer Worker が全 message で `AbortError: The operation was aborted` を返した。Copilot fetch 自体は 28s timeout 内に応答しているのに直前の処理で wall-time/CPU が枯渇。
- **根本原因**: 旧 cache スキーマは KV の `cache.v1` 1 キーに全 URL → CacheEntry を 1 つの JSON blob (~5MB) で持つ構造。consumer は処理ごとに `KV.get('cache.v1', 'json')` → `JSON.parse` (~5MB) → 1 entry 追加 → `JSON.stringify` → `KV.put`。この read-modify-write だけで CPU 30s を食い、Copilot fetch が完走できなかった。
- **対策**: PR #62 で per-URL KV キー (`s:{sha256(url)}`) に分割。consumer は `KV.put(perUrlKey, entry)` の 1 回だけ書く。harness Worker の cache 読み込みも per-URL (fallback summary を持つ entry のみ) に絞り、subrequest と CPU の両方で予算に収まるようにした。
- **教訓**: Cloudflare KV を「複数 URL × 大量データ」で 1 キー化すると、各 worker invocation が blob 全体を JSON parse/stringify する CPU を支払う。エントリ数 N が増えると O(N) で重くなる。シャーディングが効くアクセス系では per-key 設計を初手で採用する。

### LL-042: per-URL KV を全エントリで読むと 1000 subrequest/inv を簡単に超える
- **事象**: PR #62 で per-URL KV に切り替え、PR #63 で ENABLE_SUMMARY_QUEUE=1 にしたところ、最初の手動 /run が "Too many API requests by single Worker invocation" で失敗した。data publish は通っていたが、後続の `maybeEnqueueSummaryJobs` が同じ ~928 URL の KV.get を 2 周目として発行した結果、合計 ~1856 subrequest で 1000/inv 上限を超過。
- **根本原因**: `runHarness` の cache lookup と `maybeEnqueueSummaryJobs` の cache lookup が独立して全 finalEntries を走査していた。さらに「real AI 要約をすでに持つ entry」も毎回 KV を叩いていたため、無駄な subrequest が多かった。
- **対策**: (1) runHarness で `lookedUpUrls: Set<string>` を作り、`summaryJa` が `「このエントリは 」` 始まりまたは空の entry だけを KV lookup 対象にする (fallback entry のみ ~280 件)。(2) `maybeEnqueueSummaryJobs` は受け取った `hitsByUrl` Map と `lookedUpUrls` を再利用し、KV を再読み込みしない。"URL が lookedUpUrls にない" は "real summary 持ち → enqueue しない"、"lookedUpUrls にあるが hit なし" は "KV miss → enqueue" として区別する (この区別なしだと miss も skip 扱いになり Queue が starve する)。
- **教訓**: 1000 subrequest/inv は意外と早く溶ける (KV.get 1 個 = 1 subrequest、redirect も計上)。「N 件のループで KV.get/fetch を 1 回ずつ」はそれだけで上限の半分を食う。複数の関数が同じデータを必要とするときは 1 ヶ所で読んで Map を回す。さらに「データを使わない entry」は最初から lookup 対象に入れない。

### LL-043: Workers KV 書き込みは 1000/day (free tier) の日次上限がある
- **事象**: per-URL KV migration script (`scripts/kv-migrate.mjs --apply`) で 1671 件を bulk put した数時間後、cron と手動 /run が `Error: KV put() limit exceeded for the day` で OG cache の `KV.put` 時に失敗。harness の fatal で publish + enqueue 全体が中断し、データ更新が 2 時間以上停止した。
- **根本原因**: Cloudflare Workers KV の free tier は 1 namespace あたり **1000 writes/day**。`wrangler kv bulk put` で書いた 1671 件 + その後の summarizer/OG 書き込みで超過。エラーは uncaught で fetch handler の catch に届き、`runHarness` 全体が落ちる構造だった。
- **対策**: (1) `worker/src/index.ts` の OG `KV.put` を try/catch で囲み、上限到達時は warn ログだけ出して publish/enqueue は続行。(2) `worker-summarizer/src/index.ts` の queue handler で、エラーメッセージに `KV put() limit exceeded` を含む場合は `msg.retry()` ではなく `msg.ack()` する (retry すると max_retries=2 で DLQ に流れて回収不能になるため。次の UTC midnight 後の cron が同じ entry を再度 enqueue するので、ここでは ack で十分)。(3) `ENQUEUE_MAX_NEW` を 50 → 30 に下げ、`24 cron × 30 + ~24 OG = ~744 writes/day` で free tier 1000 にマージンを残す。
- **教訓**: Cloudflare の制約は subrequest / wall-time / CPU time / simultaneous connections に加えて **KV daily write quota** もある。bulk migration はその日の予算を一気に食うので、本番デプロイの直前に流すと cron が壊れる。重要な per-message 処理 (Queue consumer 等) は KV cap エラーを「リトライ可能エラー」と「明日に持ち越す daily-rate エラー」で扱い分け、DLQ に無駄に流さない。本番運用が free tier の制限に張り付くなら、`ENQUEUE_MAX_NEW` や `OG fetch cap` で日次予算を明示的に設計する。

### LL-044: archive / stats の主キーは ID ではなく canonical URL にする
- **事象**: `data/archive/2026-05.json` が 10.9 MB まで膨らみ、CI の `data artifact サイズ予算` が失敗した。同一 arXiv / Zenn / OpenAI URL が source 違いの別 ID として月次 archive に複数残り、古い記事が何度も新着に見える原因にもなり得た。
- **根本原因**: `mergeArchiveEntries` と stats 再生成が `entry.id` 主キーだった。ID は source を含むため、同じ canonical URL でも `arxiv-cs-ai` / `arxiv-cs-lg` のように別記事として蓄積された。さらに archive 月別 JSON が本文 `bodyJa` / `bodyEn` を保持し、一覧表示に不要なデータでサイズ上限を圧迫していた。
- **対策**: archive merge、Worker incremental stats、ローカル stats builder を canonical URL 主キーに統一する。archive 月別 payload は一覧表示に使う summary / metadata に絞り、本文を省く。`tests/data-schema.test.ts` に archive 月内の canonical URL 重複 gate を追加する。
- **教訓**: data artifact の dedupe / stats / archive はすべて canonical URL を主キーに揃える。ID は source ごとに揺れるので永続 archive の主キーにしない。archive payload に新フィールドを残す場合は、Web 側で実際に参照しているか確認し、サイズ予算テストを同時に更新する。

### LL-045: feed に per-item 日付が無い source は collector で URL から実日付を取りに行く
- **事象**: 1298 件中 28 件 (google-developers=26, anthropic-news=2) で `publishedAt === collectedAt` がミリ秒一致しており、4 月初旬公開の記事まで「本日の主要更新」「Timeline 今日」グループに混入していた。
- **根本原因**: Google Developers Blog の RSS feed は item レベルで `<pubDate>` / `<published>` / `<updated>` を一切持たず、channel の `<lastBuildDate>` しか提供しない。collector の `asDate()` が null を返した結果、`harness/pipeline/normalize.ts` の `publishedAt: raw.publishedAt ?? collectedAt` フォールバックが毎時 cron で「収集時刻 = 公開日」として永続化していた。Anthropic は 2026-05 から Next.js レイアウトに変わり `<time>` タグも `Published <date>` テキストも無い `<div class="body-3 agate">Apr 16, 2026</div>` のみになっていて、既存 `parsePublishedAt` が日付を取れなくなっていた。これらが UI 全体 (`groupByDay` / `TickerBar` / `DailySummary` / `stats.byDay`) を汚染。
- **対策**: (a) `SourceDefinition.fetchArticleDate?: boolean` を追加し、`google-developers` で有効化。RSS collector は item に日付が無い場合に記事 HTML を取得し、`<meta property="article:published_time">` → JSON-LD `datePublished` → `<time datetime>` の順で抽出 (1 run あたり 15 fetch 上限、8s timeout)。(b) Anthropic `parsePublishedAt` を更新し、新レイアウトの bare `Mon DD, YYYY` パターン (PostDetail hero) を抽出可能にした。(c) 一次データ修復: `scripts/refresh-publish-dates.mjs` を作成し、`publishedAt === collectedAt` の 28 件すべてを実 HTML から再取得して `data/index.json` を patch (28 件全成功)。(d) `tests/data-schema.test.ts` に `publishedAt === collectedAt` 件数の閾値ゲート (全体 5%、source あたり 5 件) を追加。
- **教訓**: feed が「publish 日付を含むことが当然」という前提は危険。新規 source を registry に追加するとき、まず raw feed の item ブロックに日付要素があるか確認し、無ければ `fetchArticleDate: true` を入れる。`<meta article:published_time>`、JSON-LD `datePublished`、`<time datetime>`、Anthropic 風の bare `Mon DD, YYYY` の 4 パターンを試せば大半のサイトはカバーできる。normalize の `collectedAt` フォールバックは「データ pipeline の sentinel」であり「正しい公開日」ではない — 28 件超は数の問題でなく仕組みの兆候として CI で fail させる。

### LL-046: モバイル固定 UI は DOM 子要素数と CSS 列数を二重管理しない
- **事象**: モバイル表示で画面下部の tabbar が崩れ、4 項目の下部メニューに対して右側に空きが出る状態だった。
- **根本原因**: `Portal.astro` の `.mobile-tabbar` は 4 項目だったが、CSS 側が `grid-template-columns: repeat(5, minmax(0, 1fr))` のままで、DOM 子要素数と grid 列数が一致していなかった。既存 E2E は表示と遷移だけを確認しており、bounding box、item 幅、横スクロールを検証していなかった。
- **対策**: `.mobile-tabbar` を `grid-auto-flow: column` と `grid-auto-columns: minmax(0, 1fr)` に変更し、項目数へ追従させた。`tests/e2e/smoke.spec.ts` の mobile tabbar テストに viewport 幅、横スクロールなし、item count、item bounding box の検証を追加した。再発防止として `.claude/skills/ui-display-guard/SKILL.md` を追加した。
- **教訓**: モバイル固定導線、sticky header、floating action など viewport 依存 UI は、表示されるだけでは合格にしない。CSS に item 数を二重管理しない設計にし、Playwright で `scrollWidth <= innerWidth` と固定 UI の bounding box を必ず検証する。

### LL-047: web build と Playwright webServer build を並列実行しない
- **事象**: UX 変更の検証で `npm --prefix web run build` と `npx playwright test ...` を並列に実行したところ、両方が `web/dist` を同時に削除/生成し、`ENOENT ... _noop-middleware.mjs` や `manifest_*.mjs` で失敗した。
- **根本原因**: `playwright.config.ts` の `webServer.command` は `npm --prefix web run build && npm --prefix web run preview ...` であり、単体 build と同じ `web/dist` を mutation する。並列検証すると Astro/Pagefind の生成物が競合する。
- **対策**: UI 検証は `npm --prefix web run build` を単独実行し、その完了後に Playwright を実行する。競合後は `rm -rf web/dist web/.astro && npm --prefix web run build` で生成物を掃除してから再検証する。
- **教訓**: tool 呼び出しは独立している場合だけ並列化する。`web/dist`、`.astro`、Pagefind index など同じ生成物を触る build/test は逐次実行する。

### LL-048: ページ上部バナーは個別カードではなく共通 PageHero にする
- **事象**: Categories / Status のページ上部感が再び弱くなり、モバイル・PC ともページに入った直後に「どの画面か」が分かりにくくなった。
- **根本原因**: Categories は `main` 内の overview card、Status は Worker Health card をページ入口の代替としており、レイアウトや個別ページ改修で簡単にページバナー感が失われる構造だった。トップページ UX 改善時も `index.astro` 専用の `banner` だけを整え、一覧系ページの共通入口パターンを作らなかった。
- **対策**: `web/src/components/PageHero.astro` と `web/src/styles/portal.css` の共通 `.page-hero` / `.page-hero-metrics` / `.page-hero-actions` を使い、通常ページでは `layout` の前に配置する。モバイルでは説明文を 2 行 clamp、actions を非表示、metrics を 2 列・最大 4 件にしてファーストビューを圧迫しない。E2E で desktop/mobile の page-hero 表示、compact height、横スクロールなしを検証する。
- **教訓**: ページの入口情報 (title / purpose / KPI / primary anchors) は個別ページ内カードに紛れ込ませず、共通 page-level component/class と E2E 寸法ゲートで守る。特に mobile は「存在する」だけでなく高さ上限も検証する。

### LL-049: Categories は詳細カードだけでなく compact directory を先に置く
- **事象**: Categories ページに page hero と大きなカテゴリカードはあるが、全カテゴリ名を一望できず、ユーザーがページ全体をスクロールしないとカテゴリ構成を把握できなかった。
- **根本原因**: 詳細カードは trend / type / 最新更新まで載せるため 1 カードあたりの高さが大きく、一覧把握には情報量が多すぎた。Sidebar は desktop では補助になるが mobile では非表示で、ページ本体に compact な category index が無かった。
- **対策**: `categories.astro` の詳細カード群の前に `#category-directory` を追加し、全カテゴリを 2〜5 列のコンパクトリンクグリッドで表示する。表示内容はカテゴリ名、group、live count に絞り、30d / delta は aria-label に含める。E2E でリンク数、desktop/mobile の高さ上限、横スクロールなし、リンク遷移を検証する。
- **教訓**: 「探索用の詳細カード」と「一望用の一覧」は別UIにする。カテゴリや source のような情報アーキテクチャページでは、詳細カードより先に compact directory / index を置き、モバイルでも Sidebar 依存にしない。

### LL-050: mobile で header nav の一部を page top に残さない
- **事象**: Archive / About が mobile bottom navigation に含まれず、代わりに header 内 `.nav` の残りリンクとしてページ上部に表示され続けた。ユーザーから「ナビゲーションバーになく、ページ上部に表示される」と再指摘された。
- **根本原因**: mobile CSS が `.nav [data-mobile-primary] { display: none; }` で Timeline / Categories / Status だけを隠し、Archive / About を header nav の折り返し行として残していた。さらに primary navigation の所有者が header と tabbar に分裂していた。
- **対策**: header の inline nav を廃止し、desktop / mobile とも hamburger `Menu` + `#site-menu` に primary links を集約する。mobile bottom tabbar は `Home / Search / Menu` の 3 action に限定し、Archive / About などは `#site-menu` から遷移する。
- **教訓**: viewport ごとに primary navigation の source of truth を分裂させない。表示リンクが増えたら tabbar や header row を増やすのではなく、hamburger menu に集約する。

### LL-051: top-level Archive にだけ breadcrumb が出る不一致を防ぐ
- **事象**: Categories / Status / About には breadcrumb が無い一方で、top-level の `/archive/` にだけ `Home › Archive` の breadcrumb が表示され、ページ構造が不揃いに見えた。
- **根本原因**: `archive/index.astro` が古い overview 構成のまま `breadcrumb={breadcrumb}` を `Portal` に渡していた。PageHero 導入後も、top-level page の breadcrumb 有無を検証する E2E が無かった。
- **対策**: `/archive/` から breadcrumb prop を削除し、top-level primary destination (`/categories/`, `/status/`, `/about/`, `/archive/`) では `.crumb-bar` が描画されないことを E2E で検証する。Breadcrumb は archive month や detail page など深い階層だけに残す。
- **教訓**: top-level nav destination の page context は `PageHero` に統一する。breadcrumb は「戻る親階層が必要な深いページ」専用とし、top-level には混在させない。

### LL-052: top-level PageHero は width / KPI grid を揃える
- **事象**: Timeline 以外の top-level page で PageHero の幅感が揺れ、サイトデザインの一体感が弱く見えた。
- **根本原因**: `.page-hero` の外側幅は同じでも、Categories / About は 6 KPI・3列、Archive / Status は 4 KPI・2列で、右側 KPI ブロックのカード幅と余白密度がページごとに違っていた。E2E も「表示されること」しか見ておらず、top-level hero の幅・KPI数・KPIカード幅を比較していなかった。
- **対策**: top-level page (`/categories/`, `/archive/`, `/status/`, `/about/`) の PageHero に `page-hero-top-level` を付け、6 KPI / 3列 / 同一 inner width / 同一 metric width を標準にする。Archive / Status は KPI を 6 件に補い、E2E で top-level hero class、inner width、metric count、metric width 差を検証する。
- **教訓**: 共通コンポーネントでもデータ件数・列数がページごとに違うと見た目の幅感は揺れる。top-level の visual system は class と寸法テストで固定し、ページ個別の KPI 数に任せない。

### LL-053: ナビ項目が増えたら hamburger に集約し、tabbar は 3 action に保つ
- **事象**: mobile tabbar が `Home / Categories / Archive / Status / About / Search` の 6 項目になり、ユーザーから「ナビゲーションメニューが多すぎる」と指摘された。
- **根本原因**: 以前の再発防止で「全リンクを mobile tabbar に載せる」方向に寄せたため、項目数が増えるほど固定 UI が圧縮され、primary action の優先順位も分かりにくくなった。
- **対策**: `Portal.astro` に shared hamburger menu (`#site-menu`) を置き、desktop header も mobile bottom tabbar も同じ menu を開く。Categories は Search より優先度が高い探索導線として header / mobile tabbar に直接表示し、Search は desktop input と menu 内補助 action に移す。mobile tabbar は `Home / Categories / Menu` の 3 action に戻し、E2E で item count、menu open/close、menu link 遷移、Search 補助 action、横スクロールなしを検証する。
- **追加対策**: `#site-menu` は banner / search / tabbar より上の layer に置き、mobile header には `z-index` を付与する。E2E では menu link の実クリックを通し、背面 CTA が pointer event を奪わないことを確認する。
- **教訓**: fixed bottom navigation は 3〜4 action 程度に抑える。5 個以上の destination link を直接並べるより、重要 action と menu trigger に分ける。検索より重要な探索入口 (Categories など) は hamburger に隠しすぎない。

### LL-054: direct shortcut は hamburger の active state / menu item から除外する
- **事象**: Categories を直接導線として header / mobile tabbar に出した後も、Categories 選択時に Menu button まで active 表示になり、PC の hamburger 内にも Categories が残っているように見えた。
- **根本原因**: mobile Menu button の active 条件が `pageKey !== "timeline"` で、Categories のような direct shortcut page まで menu-owned page と見なしていた。さらに E2E は Home から menu を開いた時の Categories 非表示だけを確認し、Categories ページ上での menu active state / menu contents を検証していなかった。
- **対策**: `menuOwnsCurrentPage` を `navItems` (hamburger 内の item) 由来にし、Categories を除外する。E2E で Categories ページの mobile tabbar は Categories のみ active、Menu は非 active、PC / mobile の `#site-menu` に Categories が無いことを確認する。
- **教訓**: direct shortcut と hamburger-owned destination を明確に分ける。shortcut に昇格した page は menu item / menu active 判定 / E2E のすべてから除外する。

### LL-055: broad feed は source registry で絞り、既存 data も同時修復する
- **事象**: 以前修正したはずのカテゴリ品質が戻り、VSCode に Zed 記事が混入、Research が arXiv / Zenn AI / Simon Willison で膨張、Tech News が TechCrunch / The Verge の一般ニュース・セール・宇宙ニュースを大量取得していた。
- **根本原因**: `harness/registry.ts` で `zed-releases` が `vscode` のまま、`zenn-ai` / `simonw-blog` が `research` のまま残っていた。さらに broad RSS feed に include / exclude / cap が無く、`PER_SOURCE_CAP=50` まで無関係記事を受け入れた。既存 `data/index.json` / archive / stats を同時修復するゲートも無かった。
- **対策**: `SourceDefinition` に `includeKeywords` / `excludeKeywords` / `maxEntriesPerRun` を追加し、RSS collector で deterministic にフィルタする。Zed は `cursor`、Zenn AI / Simon Willison は `local-llm` に再分類。arXiv と Tech News broad sources に relevance filter と per-run cap を設定し、既存 index / archive / stats を同ルールで修復。`tests/data-schema.test.ts` に Zed in VSCode、Research live count、Tech News noise の品質ゲートを追加。
- **教訓**: カテゴリ品質は UI ではなく collector / registry の責務。broad feed を追加・変更したら、future collection のフィルタと past data の修復、source-meta sync、data-schema gate を同一変更に含める。

### LL-056: Categories 表示は live index を主指標にし、archive stats を前面に出しすぎない
- **事象**: data 修復後も Categories ページの詳細カードが `all time` / `30d` (archive + stats 由来) を前面に出しており、修正前のカテゴリ偏りが残って見えた。
- **根本原因**: category directory は live count を表示していたが、詳細カードと hero は `STATS.byMonth` / `STATS.byDay` を主表示していた。archive を含む履歴統計と現在の live index の目的が混ざっていた。
- **対策**: Categories の詳細カードは `live` / `live 30d` / `sources` を主指標にし、`all time` を前面から外す。Research group label も `Research / Papers` にして `Research Research` の重複表示を避ける。E2E で category card が `live` を含み、`all time` を含まないことを検証する。
- **教訓**: Categories は「今どのカテゴリを読むか」の画面なので live index を主表示にする。長期推移や all-time は Archive / stats 文脈に寄せ、カテゴリカードでは補助以下にする。

### LL-057: カテゴリは parent group + child category + tags の3層で表示する
- **事象**: 製品名カテゴリを横並びにした結果、粒度が混ざり、`VSCode` に開発環境記事が混ざる・`Cursor` に Zed が入る・Tech News の受け皿が曖昧、などがユーザーに分かりづらく見えた。
- **根本原因**: `CATEGORY_META.name` が vendor / product / domain / news type を同じ階層で表していた。タグは存在するが、UI 上はカテゴリ1層だけに見えていたため、将来の Microsoft 365 Copilot や Claude Code のような子分類を表現しづらかった。
- **対策**: URL slug は維持しつつ、`CATEGORY_META.group` を大カテゴリ (`Microsoft / GitHub`, `Anthropic`, `AI Coding Tools`, `Industry & Policy` など) に再設計し、`CATEGORY_META.name` を子カテゴリ表示にする。個別プロダクト差分 (`zed`, `cursor`, `devcontainer`, `benchmark`, `gpu` 等) はタグで細分化する。
- **教訓**: taxonomy は「大カテゴリ = 読者の入口」「子カテゴリ = 収集/表示単位」「tags = 詳細フィルタ」で分ける。カテゴリ名だけで細分化しすぎず、UI では parent group を明示する。

### LL-058: 修正の回帰は「完了前の自己批判」でしか防げない
- **事象**: 複数の変更サイクルを経るうち、一度修正した箇所 (Archive/About のナビ消失、Categories のハンバーガー混入、taxonomy のカテゴリ崩れ) が別の変更で元に戻る回帰が繰り返し発生した。
- **根本原因**: 「テストが通った = 完了」と判断していたが、テストはその時点で書かれた仕様しか守らない。変更の blast radius (他箇所への影響) をその都度全体スキャンしていなかった。
- **対策**: `.claude/skills/self-critique/SKILL.md` を作成し、完了ゲートの **最初のステップ** として C-01〜C-08 の全観点チェックを義務化。チェック項目はナビ・taxonomy・サイドバー・ビルド・data quality・絶対ルール遵守・空状態 UX・ペルソナ回遊を網羅する。
- **教訓**: 自己批判は「気が向いたら」ではなく「完了の前提条件」として手順に組み込む。スキル定義がその実行を強制する仕組みにする。

### LL-059: 競争力はテストだけでなく persona journey で検証する
- **事象**: build / E2E が通っていても、「大手競合と対等か」「忙しい技術者が実際に読む判断をできるか」はテスト結果だけでは判断できなかった。
- **根本原因**: 既存テストは DOM・遷移・データ品質を検証するが、ユーザーの行動目的、迷い、信頼、共有判断、深掘り導線の摩擦を表現しない。
- **対策**: `.github/agents/TechDBAgent.agent.md` と persona agents を作成し、Dev Lead / Mobile Commuter / Tech PM / AI Researcher の複数視点で Playwright 回遊を行う。自己批判スキルの C-08 に組み込み、persona 間で重複した問題は severity を上げる。
- **教訓**: 競争力レビューは「仕様通り動く」ではなく「実ユーザーが目的を達成できる」ことを検証する。UX / taxonomy / navigation / trust 表示の変更では persona journey を完了ゲートに含める。

### LL-060: worktree secret scan は未追跡ディレクトリをファイルとして読まない
- **事象**: `.github/agents/` を新規作成した直後に `npm run secrets:scan:worktree` が `EISDIR: illegal operation on a directory, read` で失敗した。
- **根本原因**: `git ls-files --cached --others --exclude-standard` が未追跡ディレクトリを返す場合があり、scanner が `readFileSync(path)` 前に file / directory 判定をしていなかった。
- **対策**: worktree/current scan では `statSync(path).isFile()` を確認し、非 file は skipped として扱う。binary / size skip と同じく scan 自体は失敗させない。
- **教訓**: secret gate は「検出」だけでなく「新規ディレクトリ追加時にも落ちない」ことが重要。worktree scan は Git の返す path が常に regular file とは限らない前提で実装する。

### LL-061: 空欄 0 件でも deterministic fallback backlog は品質 debt として可視化する
- **事象**: `data/index.json` の `summaryJa` / `summaryEn` / `bodyJa` / `bodyEn` は全件非空だったが、実測で 484 件が `「このエントリは ... AI 要約未生成」` 系の deterministic fallback のままだった。従来の `quality-audit` は「空欄なし」だけを見て 0 issues と報告していた。
- **根本原因**: R-013 / LL-028 で「UI 空欄を防ぐ」fallback gate を強化した一方で、「本物の AI 要約に置き換わっているか」を別指標として扱っていなかった。Queue summarizer の backlog / enqueue candidates / KV lookup cap も `/status` から見えず、運用上の詰まりを検知しづらかった。
- **対策**: `quality-audit` に deterministic fallback 件数・比率を追加し、10% 以上または 50 件以上で warning、70% 以上で critical とする。Worker health / `/status` / `/metrics.json` に `fallbackTotal`、`fallbackPercent`、`kvLookupCap`、`kvLookupCount`、`queueMode`、`queueCap`、`enqueueCandidates` を出す。
- **教訓**: 多言語 summary/body の品質ゲートは「非空」と「real AI enrichment」を分ける。fallback は UX safety net であって完了状態ではない。Queue / KV cap を持つ非同期 enrichment は backlog 指標を最初から UI と監査に出す。

### LL-062: KV_LOOKUP_CAP=60 が fallback の永続化を引き起こす (Queue starve)
- **事象**: 484 件の `summaryJa` fallback が存在し、Queue consumer が動いているにもかかわらず 7 日以上解消しなかった。
- **根本原因**: `worker/src/index.ts` の `allFallback.slice(0, KV_LOOKUP_CAP)` が cap=60 のため、484 件中 424 件は KV チェックされず `lookedUpUrls` にも入らない。`maybeEnqueueSummaryJobs` は `!lookedUpUrls.has(e.url)` を「real summary あり → skip」と解釈していたため、424 件は Queue にも投入されず永久に fallback のまま固定された。round-robin なしの enqueue では常に最新 30 件が選ばれ、古い fallback は cap の外に出た瞬間に詰まる。
- **対策**: KV_LOOKUP_CAP デフォルトを 60 → 500 に引き上げ。`uncheckedFallbackUrls` を導入し cap 超過分も "enqueue すべき fallback" として追跡。`maybeEnqueueSummaryJobs` に round-robin オフセットを追加し、ENQUEUE_MAX_NEW=35 で全 fallback が平均 ~14 時間でキューを一周するよう設計。heartbeat KV + `/health` endpoint で cron の死活を監視可能に。
- **教訓**: `lookedUpUrls` の「absent = real summary」の仮定は、cap で切り捨てた fallback が存在すると崩れる。KV read cap と enqueue 対象の判定は同じ集合で行わなければならない。

### LL-063: モバイル下部タブは主要導線に絞り、overflow UI には min-width:0 と fallback を持たせる
- **事象**: 6 項目の mobile tabbar が詰まって見え、最重要導線の Timeline も他の項目に埋もれていた。Categories / Archive の初期表示は KPI が縦に伸びて、ページ上部のバナー感や「何ができるページか」の説明が弱かった。
- **根本原因**: 下部固定ナビに全ページ導線を詰め込んでいた。横スクロールの quick link を grid 子要素に入れる際、親/子に `min-width: 0` が無いと flex contents の min-content 幅でページ全体が横に広がる。
- **対策**: mobile tabbar は Categories / Status / Timeline / Search / More の主要 5 項目に整理し、Timeline を中央の強調ボタンにする。grid 子に `min-width: 0` を明示。EntryCard / Featured は `onerror` で `.failed` を付与し、fallback を表示する。
- **教訓**: モバイル固定導線は「全部置く」ではなく頻用導線 + More に分け、最重要導線は中央に置いて視覚的ヒエラルキーを作る。

### LL-064: OGP 画像バックフィルは YouTube は deterministic URL、その他は og:image/twitter:image 抽出で対応
- **事象**: data/index.json の live 記事中 54% が `image` 未取得で、EntryCard の fallback artwork のみの表示だった。
- **根本原因**: Cloudflare Worker の OGP fetch は subrequest 上限のため、新規記事のみを対象にしており既存 entry への遡及がなかった。
- **対策**: `scripts/fetch-missing-ogp.mjs` を作成。YouTube は `https://img.youtube.com/vi/{videoId}/hqdefault.jpg` を直接セット。arXiv/cursor-changelog 等は構造的に OGP 画像がないのでスキップ。その他は記事 HTML を fetch して `<meta og:image>` → `twitter:image` の順で抽出。
- **教訓**: OGP バックフィルは「全件 fetch」ではなく「構造的に画像がないソースをスキップ」してから残りを取得する。

### LL-065: archive の hot tier entry は summaryJa/summaryEn も除去してファイルサイズを管理する
- **事象**: hot tier を archive に含めるようにしたところ、2026-05.json が 4.5MB まで膨張した。
- **根本原因**: `compactArchiveEntry` が `bodyJa`/`bodyEn` のみ削除し、`summaryJa`/`summaryEn` を残していた。hot entry は live index に全フィールドが存在するので、archive 側で要約を保持する必要はなかった。
- **対策**: `compactArchiveEntry` を `archiveTier === "hot"` の entry については `summaryJa`/`summaryEn` も削除するよう変更。2026-05.json を 4.5MB → 3.2MB に圧縮。
- **教訓**: archive の size budget を守るには「tier 別に保持フィールドを決める」。hot tier は live index が主、archive はカウント用途のみなので summary は省略可。

### LL-066: 高ボリュームソースはカテゴリを独占しないよう perSourceCap とカテゴリキャップを併用する
- **事象**: research カテゴリが 256 件 (18%) で全カテゴリ 2 位。arXiv 4 ソース×50 件 + simonw-blog 50 件 + zenn-ai 50 件 = 200 件超が論文・ブログで埋まり、UI の多様性が損なわれていた。
- **根本原因**: `PER_SOURCE_CAP=50` がすべてのソースに均一適用されており、日次更新量が多い arXiv feed がキャップ上限まで毎日取得されていた。
- **対策**: `SourceDefinition` に `perSourceCap?: number` を追加し、arXiv 4 ソースを個別に制限 (cs.AI=25, cs.CL=20, cs.LG=20, cs.SE=15)。Worker の capping ロジックを `sourceDef.perSourceCap ?? PER_SOURCE_CAP` に切り替え。`CATEGORY_CAPS = { research: 120 }` を追加し、ソースキャップ後にカテゴリ上限でさらに絞り込む。
- **教訓**: 高ボリュームのフィードを追加するときは、同一カテゴリの他ソースとのバランスを考慮して `perSourceCap` を明示する。

### LL-067: titleEn 欠落は summaryEn の先頭文から抽出して補完できる
- **事象**: JP source (Qiita/Zenn) の live entry で `titleEn` が空のままで、EN UI に JA バッジ付きフォールバック表示が連続していた。
- **根本原因**: 日本語 source は AI 要約で `summaryEn` が生成されるが、`titleEn` は独立フィールドで別途生成が必要だった。
- **対策**: `scripts/fill-title-en.mjs` を作成。`summaryEn` が実 AI 要約の場合は先頭文 (最大 120 文字) を `titleEn` に設定。AI 要約が未生成の場合は元の `title` を代入する。
- **教訓**: `titleEn` と `summaryEn` は独立して管理する。`summaryEn` の AI 生成が完了した段階で `npm run titleen:fill` を再実行して英語タイトル品質を向上させる。

### LL-068: モバイル中央アクションは同列配置のまま強調する
- **事象**: mobile tabbar の Timeline 中央ボタンが大きく浮きすぎ、Status / Search の表示領域へ被って見えた。
- **根本原因**: `.mobile-home` が `translateY(-13px)` で grid track より縦にはみ出していた。縮小後も `translateY()` が残ると「別列に浮いたボタン」に見え、同列ナビとしての一体感を損なった。
- **対策**: 中央ボタンの `translateY()` を撤廃し、全タブと同じ `min-height` / row に揃える。強調は枠線、背景色、font-weight だけで表現する。
- **教訓**: 固定ナビの中央アクションは、同列配置を崩してまで floating button 化しない。目立たせる場合はサイズや位置ではなく、色・枠線・active 状態で表現する。

### LL-069: visual audit は duplicate controls と broken image fallback を直接検証する
- **事象**: mobile で header と bottom tabbar の両方に hamburger が表示され、Featured panel は空の overlay link が grid item としてレイアウトに参加して崩れた。EntryCard / Featured の外部サムネイルも image load failure 時に fallback が表示されず broken image icon が残り得た。
- **根本原因**: Persona / self-critique のレビューが「導線があるか」「E2E が通るか」に偏り、DOM 上の visible duplicate controls、grid child の通常 flow 参加、`img.onerror` 後の fallback 表示まで検証していなかった。
- **対策**: mobile では `header .menu-trigger` を非表示にし、`#site-menu` を bottom tabbar 起点の bottom-sheet に統一。Featured の空 overlay link は削除して通常のタイトルリンクをクリック対象にし、thumb/body の grid flow を安定化する。Featured / card thumbnail は image と deterministic fallback を同じ grid cell に重ね、synthetic error event で fallback を表示する E2E を追加する。
- **教訓**: UI レビューはスクリーンショット印象だけでは不十分。duplicate controls、bounding box、通常 flow に残った invisible element、画像失敗時の表示を Playwright で直接検査する。

### LL-070: mobile first-view は「壊れていない」だけでなく余白量を測る
- **事象**: build / smoke / persona audit が通っていても、mobile first-view で hero 後の stats と長い section note が縦余白を作り、最初の Featured article が 483px 付近まで下がっていた。
- **根本原因**: レビュー基準が overflow / fixed nav / クリック可否に偏り、「最初の判断対象が何 px で出るか」「重複情報が first-view を押し下げていないか」を測っていなかった。
- **対策**: mobile では hero と重複する stats を非表示にし、section note / count を畳んで Featured を 326px 付近まで上げた。E2E に `featuredBox.y <= 340` の寸法ゲートを追加する。
- **教訓**: UX レビューでは vertical density を定量化する。`scrollWidth` だけでなく、first actionable content / first article の `y` 座標、前後セクションの gap、重複 KPI の有無を Playwright で記録する。

### LL-071: mobile 通常カードのサムネイルは補助情報として扱う
- **事象**: Deep-dive timeline の mobile 通常カードで OGP thumbnail がカード幅いっぱい・高さ 168px で表示され、画像の存在感が本文より強く、どこまでが 1 つの記事パネルか分かりづらかった。
- **根本原因**: desktop の media card を mobile で単純に縦積みし、thumbnail をカード上端に全面表示したため、カード境界より画像の白背景や次カード画像が視覚的な区切りになっていた。E2E も thumbnail fallback と panel height は見ていたが、通常カードの thumbnail サイズとカード間 gap を測っていなかった。
- **対策**: mobile 通常カードは本文を full-width のまま維持し、OGP thumbnail は非表示にする。要約バッジは本文と横並びにせず縦積みにして、要約テキストも full-width で読ませる。カードごとに border / shadow / margin gap を強め、E2E で本文幅、summary text 幅、mobile thumbnail 非表示、隣接カード gap、desktop thumbnail fallback を検証する。
- **教訓**: mobile の記事一覧では OGP 画像を主役にしない。読む判断に必要な title / summary / source を優先し、通常カードの thumbnail は mobile では省略してよい。通常カードの表示修正では「画像が出るか」だけでなく「画像・バッジ・横並び UI が記事境界や本文折り返しを邪魔していないか」を寸法で確認する。

### LL-072: UX merge で data artifact を古い状態へ巻き戻さない
- **事象**: `chore(data): update tech dashboard 2026-05-24T23:00:46.610Z` で `data/index.json` は 1419 件まで更新されていたが、その直後の UX / taxonomy merge commit で `data/index.json` が 980 件・`generatedAt=2026-05-23T05:00:49.636Z` に巻き戻り、本番表示が「記事更新停止」に見えた。`data/stats.json` はより新しい時刻のまま残り、artifact 間の generatedAt が乖離していた。
- **根本原因**: 大きな merge conflict 解消時に UI / taxonomy 差分と data artifact 差分を同時に扱い、最新 `origin/main` の worker-generated data を構造的に保持する確認が不足した。既存 `tests/data-schema.test.ts` は schema / body coverage は見ていたが、`generatedAt` の鮮度と `index` / `stats` / `archive` 間の時刻整合性を検査していなかった。
- **対策**: 復旧時は最新正常 worker commit (`48bf5ad`) の `data/index.json` / `data/archive/*` / `data/stats.json` をローカルに戻す。`tests/data-schema.test.ts` に `generatedAt` の古さ (既定 36h、緊急時のみ `ALLOW_STALE_DATA=1`) と artifact generatedAt skew (6h 以内) のゲートを追加する。
- **教訓**: UI / taxonomy merge では data files を「ついでに解決」しない。完了前に `git log -- data/index.json` と generatedAt / count を確認し、最新 worker commit より古い data を main に載せない。data artifact は index / stats / archive の時刻整合性まで CI で守る。

### LL-073: taxonomy 修正後に Worker を deploy しないと古い分類で再汚染される
- **事象**: main の data を復旧後、`/diag/run-batch` で Worker を手動実行すると `zed-releases` が再び `vscode` として publish され、Tech News / Research ノイズや stats bucket 不整合も再発した。
- **根本原因**: Cloudflare Pages は main push で更新されるが、Worker runtime は Git Integration の対象外。repo 上の `harness/registry.ts` / collector / stats 修正を main に入れても、Worker を deploy しない限り本番 cron は古い registry / publish logic のまま動く。
- **対策**: taxonomy / source filter / archive-stats logic に触れたら、data 修復 commit 後に明示承認を得て `worker/` を deploy する。deploy 前後で `/health` と `tests/data-schema.test.ts` を確認し、古い Worker が data を再汚染しないことを確認する。
- **教訓**: data artifact の修復だけでは publisher の再発を止められない。Worker-generated data が schema gate を破った場合は「data を直す」だけでなく「Worker runtime が最新か」を同じ incident の必須確認にする。

### LL-074: Pending AI summaries must not occupy decision-critical slots
- **Incident**: Persona UX audit found Home Featured / Top-3 and article detail using deterministic fallback text such as pending AI summary as the most prominent decision content.
- **Root cause**: Data quality gates guaranteed non-empty summaries, but UI ranking treated deterministic fallback as equivalent to real AI enrichment. Status also showed collection health without an explicit summary backlog count.
- **Mitigation**: Shared fallback detection is used by Featured / Top-3 / article detail / metrics. Decision-critical slots prefer real summaries, article detail shows a pending state instead of boilerplate body, and Status exposes summary backlog metrics.
- **Lesson**: Non-empty content is not the same as trustworthy content. Ranking, share UI, and health dashboards must treat deterministic fallback as pending work, not as completed enrichment.

### LL-075: Queue summarizer prompt must fit Worker time/token budget
- **Incident**: `data/index.json` showed a large deterministic fallback backlog even though the collector Worker had `queueMode=enabled`, `copilotOk=true`, and enqueue candidates available.
- **Root cause**: The Queue consumer used the long-form article prompt while capping output at a Worker-safe token budget. The prompt asked for 700-1100 Japanese characters and 500-800 English words, so Sonnet often could not finish valid JSON inside the 28s Worker timeout / ~1500 token budget.
- **Mitigation**: Keep a separate compact `buildQueuePrompt()` contract for `worker-summarizer`, with `SUMMARIZE_MAX_TOKENS=1600`, mandatory complete JSON validation, and source snippet fields carried in the queue payload. Local/offline backfills can still use the longer prompt.
- **Lesson**: Splitting work into a Queue is not enough; each Queue message must have an output contract sized for the consumer's actual wall-time and token budget. Backlog metrics must compare real enqueue selection logic, including KV-lookup-cap-skipped fallback entries.

### LL-076: Queue round-robin must advance by the enqueue cap, not by one entry
- **Incident**: `fallbackTotal` stayed high even while `queueMode=enabled` and `enqueueCandidates=35`, because the producer selected a moving window that advanced only one entry per hour across the full live index.
- **Root cause**: A 35/job hourly cap needs cap-sized windows over eligible fallback jobs. Advancing by one index position means hundreds of fallback entries may wait weeks to be retried when earlier jobs fail or remain uncached.
- **Mitigation**: Move summary job selection into `worker/src/summary-queue.ts`, compute the eligible backlog first, and rotate by `hour * ENQUEUE_MAX_NEW` over that eligible list. Expose `summaryQueueBacklog` and `summaryQueueDrainEstimateHours` in Worker health.
- **Lesson**: Rate limits need a fairness model. A cap without cap-sized round-robin can look active in health metrics while starving most of the backlog.

### LL-077: Source keyword filters must also clean previously merged entries
- **Incident**: CI kept failing on Worker-generated `data/index.json` because an old `qiita-vscode` entry (`C言語のコンパイル時に文字化けが発生する`) reappeared after a cron run, even though the RSS collector had title-only VSCode filters.
- **Root cause**: The Worker filtered fresh collector output, but then merged it with prior `data/index.json` entries and kept old entries without reapplying the current source rules. A stale raw GitHub read or pre-filter artifact could therefore survive forever and fail data-schema quality gates.
- **Mitigation**: Share `matchesKeywordFilter()` in `harness/pipeline/source-filter.ts` and apply it to merged Worker entries before per-source/category caps.
- **Lesson**: Registry filter changes are migration rules, not only collection rules. Automated publishers must revalidate existing merged artifacts on every run.

### LL-078: Decorative motion must still pass reduced-motion and focus semantics
- **Incident**: A homepage motion refresh added scroll reveal and animated hero layers, but persona review found existing ticker/marquee components still animated under `prefers-reduced-motion: reduce`, and inactive ticker slides remained exposed as focusable links.
- **Root cause**: Global motion safeguards do not cover component-scoped styles, and visually hidden carousel slides are not automatically hidden from keyboard or assistive technology.
- **Mitigation**: Add reduced-motion overrides inside component styles, disable auto-advance for reduced motion, set inactive ticker slides to `aria-hidden="true"` and `tabindex="-1"`, and add Playwright checks for reduced motion plus mobile first-view density.
- **Lesson**: Animation features need accessibility acceptance criteria from the start: compositor-only properties, `prefers-reduced-motion`, no hidden focus targets, and viewport metrics for first actionable content.

### LL-079: Queue-only Workers still need a fetch health endpoint
- **Incident**: While investigating fallback debt, `tech-dashboard-summarizer` returned Cloudflare error 1101 for `/health`, which looked like a Worker outage even though the Queue consumer binding still existed.
- **Root cause**: The Worker exported only `queue()`. Cloudflare treats direct HTTP requests as FetchEvents, and a queue-only script without `fetch()` throws "Handler does not export a fetch() function."
- **Mitigation**: Add a minimal `/health` fetch handler that returns non-secret runtime configuration (`model`, timeout, max tokens, binding/secret presence). Keep it read-only and do not write KV from health checks.
- **Lesson**: Queue consumer liveness and HTTP fetch liveness are separate. Public health checks must be implemented explicitly; otherwise diagnostics create false 500s and obscure the real backlog issue.

### LL-080: Repeated summarizer retries need producer-side cooldown
- **Incident**: Production health repeatedly showed `recentIssue=true` for the same Zenn URLs with `Error: incomplete summary`, while the harness kept enqueueing new summary jobs every cron and `summaryQueueBacklog` stayed high or grew.
- **Root cause**: The summarizer recorded the latest retry in `summarizer.issue.v1`, but the harness producer did not read that issue before selecting the next queue batch. The same URL could therefore be selected again in the next cap-sized window even though the latest attempt had just failed.
- **Mitigation**: Harness queue selection reads the recent summarizer retry issue and temporarily excludes that URL via a short `SUMMARY_RETRY_COOLDOWN_MS` cooldown. The excluded count is exposed as `summaryQueueCooldownCount` in heartbeat health. The summarizer still retries later, but the producer keeps other fallback jobs moving meanwhile.
- **Lesson**: Queue retry state should feed back into producer selection. Otherwise one pathological URL can create noisy health warnings and consume queue capacity while unrelated fallback entries wait.

### LL-081: テストのノイズ検出語と registry の excludeKeywords を単一ソース化する
- **事象**: ars-technica の宇宙ニュース「Tests suggest Russian satellites can jam GPS on a continental scale」が tech-news カテゴリに混入し、`tests/data-schema.test.ts` の「Tech News は consumer deal / space などのノイズを含めない」ゲートで CI (unit job) が毎時 fail。Worker が毎時 `data/index.json` を main へ push するたびに同じノイズが再投入され、2026-06-09 02:00 以降の CI run が連続 failure になっていた。
- **根本原因**: テストのノイズ検出正規表現には `russian satellites` / `international space station` 等の宇宙系キーワードがあったが、`harness/registry.ts` の `TECH_NEWS_EXCLUDE_KEYWORDS` には `satellite` / `space station` が無かった。収集・マージ時の `matchesKeywordFilter` を素通りして tech-news として保存され、テストだけが検出して fail するループになっていた。**品質ゲート (検出 = テストの正規表現) と収集フィルタ (予防 = registry) のキーワードが別管理で乖離していた**のが構造的な真因。
- **対策 (初期)**: `TECH_NEWS_EXCLUDE_KEYWORDS` に `satellite` / `space station` / `the view` / `shark finning` を追加し、`scripts/clean-source-noise.mjs` で既存 live/archive から該当ノイズを除去、Worker を再デプロイ。
- **対策 (構造的・恒久)**: 二重管理を排除するため、**registry の `excludeKeywords` を唯一のノイズ定義 (単一ソース) にした**。`tests/data-schema.test.ts` に「registry の excludeKeywords が live/archive に適用漏れしていない」テストを追加し、`REGISTRY` を import して各 source の `excludeKeywords` を直接参照する。`clean-source-noise.mjs` も同じ registry を参照する `npm run noise:clean` に統一。両者とも **title スコープのみ**で判定する (url を含めると `arstechnica.com/gadgets/` のサイトセクション名に `gadget` が部分一致し、Windows Update 等の有効記事を巻き込む false positive を生む。summary も AI 生成で偶然一致しやすい)。これで「registry に追加 → 既存データの適用漏れをテストが即検出 → `npm run noise:clean` で migration」という一方向フローになり、乖離が構造的に発生しない。
- **教訓**: 「検出 (テスト)」と「予防 (収集フィルタ)」で同じ概念のキーワードを別々に持たない。一方を単一ソースにし、もう一方はそれを参照する。ノイズ語の判定は title スコープに限定する (url のサイトセクション名・summary の AI 生成文は部分一致 false positive の温床)。registry の broad feed フィルタを変更したら `npm run noise:clean` で既存データを migration し、Worker を再デプロイする (LL-073)。新種ノイズはテストの正規表現ではなく registry の `*_EXCLUDE_KEYWORDS` に追加する。

### LL-082: ローカル e2e の TickerBar テストはデータ鮮度依存で誤検知する
- **事象**: data-schema 修正後にローカル e2e を実行すると `home renders primary sections` が 1 件 fail。`.tb-slide:not(.is-active)` が 0 件 (TickerBar のスライドが 1 枚だけ) になっていた。
- **根本原因**: `TickerBar.astro` は `publishedAt` が「今日 (JST)」、今日が 0 件なら「昨日」の `MAIN_TIMELINE_ENTRIES` だけをスライド化する。ローカルの `data/index.json` は前日収集 (generatedAt 06-09 17:01) で、テスト実行日 (06-10) には今日の MAIN_TIMELINE 記事が 1 件に枯渇していた。`git stash` で元データ (origin/main HEAD) に戻してビルドしても 1 スライドで再現し、私の変更とは無関係と確認できた。CI は 2026-06-08 21:00 まで success (e2e 含め 3 分台で完走) しており、Worker push 直後の新鮮データでは today 記事が複数あって PASS する。
- **対策 (初回)**: テスト仕様変更はせず (テストコード保護)。私の data-schema 修正と無関係な既存の鮮度依存挙動として扱う。切り分けには CI の success 実績確認と `git stash` での元データビルド再現が有効だった。
- **対策 (2 回目・恒久 / Two-strike)**: 2026-06-11 の早朝 (JST 05:32) push でも同じ test が deterministic に fail し、pre-push e2e を阻害した (今日公開の publishable entry が 1 件で `.tb-slide` が 1 枚)。Two-strike ルールに従い test を robust 化: `home renders primary sections` の inactive-slide assertion を「inactive slide が 1 枚以上あるときだけ aria-hidden/tabindex を検証する」count ガードに変更。LL-078 の a11y 意図 (inactive slide は AT 非表示・非 focusable) は保持し、「今日の slide が 1 枚」という正当な状態では vacuous に通す。テスト本来の意図を弱めず鮮度依存だけを除去した。
- **教訓**: 自分の変更後に e2e が落ちたら、まず「元データでも再現するか」を `git stash` + クリーンビルドで確認し、blast radius を切り分ける。`now = new Date()` をビルド時に評価する日付依存コンポーネントは、古いローカルデータや早朝 JST (今日の記事が少ない時間帯) で誤検知しやすい。鮮度依存の flaky test は「件数が増える前提」を assert すると低活動時間帯に必ず落ちる。同じ flaky が 2 回以上 work をブロックしたら、件数前提を count ガードに変えて恒久 robust 化する (Two-strike)。`reuseExistingServer: true` の preview が古い dist を配信する場合もあるため、port を kill して `web/dist` / `web/.astro` を消してから再ビルドして検証する。

### LL-083: DailySummary の「LAST 7 DAYS」が stats プロップ未渡しで publishable-live fallback に潰れ、収集停止に見えた
- **事象**: トップの「LAST 7 DAYS」グラフが `9,2,1,0,1,1,1` と激減し、ユーザーに「新しい記事が追加されていない」と認識された。実際は `origin/main` が毎時更新され (HEAD=4fd5520, 06-11 05:01 JST)、Cloudflare Pages も最新 commit を 20 分前に production deploy 済みで、収集パイプラインは正常 (`health.sourcesOk=13/13`, `sourcesFailed=[]`, `stats.totals.last24h=184`, 06-11 の collectedAt は 493 件)。
- **根本原因**: `web/src/pages/index.astro` が `<DailySummary entries={primaryEntries} now={now} />` と **`stats` プロップを渡していなかった**。`DailySummary.astro` は本来 `stats.byDay` (archive 込み全件日次, LL-022 / LL-032 の単一情報源) でバーを描く設計だが、`stats` が `undefined` だと `liveCountByDay` (= `isPublishableEntry` を通った AI 要約済み live entry を `publishedAt` で集計) に silent fallback する。`isPublishableEntry` は deterministic fallback (要約バックログ `fallbackTotal=349`, 25%) を除外するため、直近日ほど publishable が少なく、バーが 1 桁に潰れていた。`stats.byDay` の実値は `78,32,60,86,113,86` で健全。
- **対策**: index.astro で `import { STATS } from "../lib/stats.ts";` し `<DailySummary entries={primaryEntries} stats={STATS} now={now} />` を渡す。ビルド出力の spark バーが `78,32,60,86,113,86`(+当日は stats 未集計のため live fallback) になることを確認。回帰防止に `tests/e2e/smoke.spec.ts` へ「7-day バー 7 本の max > 20」を assert する非鮮度依存テスト (`home Last 7 days chart reflects stats.byDay activity`) を追加。
- **教訓**: `stats.byDay` を使う設計のコンポーネントに stats を渡し忘れると、silent fallback で「収集停止」に見える致命的な誤表示になる。retention / trend を示す UI は LL-022 / LL-032 の通り `data/stats.json` を単一情報源にし、**stats を消費する component には必ず stats prop を渡す**。「非空か」だけでなく「正しい母集団 (全件 vs publishable のみ) を数えているか」を回帰テストで数値ガードする (agentic §4.7)。chart が collection 実態でなく enrichment backlog に引きずられていないかを疑う。

### LL-084: カテゴリ trend/sparkline は live index ではなく stats.byDay を集計源にする (LL-083 の兄弟)
- **事象**: トップ「LAST 7 DAYS」と同じ「記事が更新されない」誤認が、サイドバー / カテゴリページの30日スパークラインでも発生。本番 HTML 実測で直近日 (例 copilot 06-10:0, 06-12:0, 06-14:0) が 0 付近に潰れて見えていた。実際の収集は健全 (origin/main は毎時更新・直近24時間で224件)。
- **根本原因**: `web/src/lib/stats.ts` の `categoryDailyTrend` が、コメントには「derived from data/stats.json」と書いてあるのに実装は live `ALL_ENTRIES` を `publishedAt` で数えていた。live index は per-source cap / retention tier (LL-032/LL-066) で古い entry を evict するため、直近日が過少カウントされる。この関数は `categoryDailySpark`・`categoryWeekOverWeek` 経由でサイドバー・カテゴリカード・カテゴリ詳細 Trend・WoW KPI の4面に波及していた。
- **対策**: `categoryDailyTrend` を `STATS.byDay` (archive 込み全件日次, LL-022/LL-032 の単一情報源) の `byCategory[category]` を集計源にするよう変更。コメントどおりの contract に実装を一致させた。typecheck / build:web / e2e (`category trends match`, `category detail trend chart`) で検証。`stats.byDay.byCategory` は直近日も 7〜11 カテゴリ分の実数を保持済み。
- **教訓**: 「LAST 7 DAYS」(LL-083, DailySummary) と同じ root-cause family。日次/週次の trend 可視化は live index ではなく stats.byDay を集計源にする。コメントに source of truth を書いたら実装が本当にそれを読んでいるか確認する (コメントと実装の乖離は静かに退行する)。新しい trend UI を足すときは `categoryDailyTrend` / `stats.byDay` を経由させ、live entries を直接 `publishedAt` で数えない。

### LL-085: 増分 stats の rolling 30d は drift するので last30d ≤ total を clamp する
- **事象**: `data/index.json` は毎時健全更新されているのに、`tests/data-schema.test.ts` の「source 集計は降順で、値が非負である」が `openai-blog` の `last30d:23 > total:22` で fail。origin/main の毎時 `chore(data)` push 由来 CI が連続 red、ローカルの pre-push hook も全 unit を回すため push がブロックされた。
- **根本原因**: `worker/src/index.ts` の `buildIncrementalStats` が `bySource.last30d` を rolling 30 日窓として増分維持している。`generatedAt` が毎時進むと entry が 30 日境界を跨ぐが、`removed` 集合 (= touched archive month + live) に入る entry しか `last30d` を減算しない。**untouched month 内で 30 日を超えた entry は減算されず** `last30d` が過大方向に drift し、`total` がほかの削除で減ると `last30d > total` という論理破綻に至る。`totals.last30d` は `Math.max(0, …)` で clamp 済みだったが、source 単位の `last30d` には `≤ total` clamp が無かった。
- **対策**: `buildIncrementalStats` の最終組み立てで各 source を `0 <= last30d <= total` に clamp (`last30d = min(max(0,last30d), max(0,total))`)。既存 `data/stats.json` も同じ clamp を 1 回適用して現行データの違反を解消 (openai-blog last30d 23→22、1 行 diff)。typecheck + 全 157 unit PASS。**Worker は Git Integration で自動 deploy されないため (LL-073)、本番で再発を止めるには明示承認のうえ Worker deploy が必要**。未 deploy だと次の毎時 run が再び drift データを main に push し CI が再度 red になりうる。
- **教訓**: 増分集計の rolling time-window カウンタは境界移動で必ず drift する。窓カウンタは「論理上の上限 (ここでは total)」と「下限 0」で最終 clamp して invariant を強制する。data artifact の不変条件 (`0 ≤ last30d ≤ total` 等) は test だけでなく **生成器側 (Worker/harness) にも同じ clamp** を入れて、検知と予防を単一ロジックに寄せる (LL-027 と同型: CI 検知だけでは automated publisher の再発を止められない)。

### LL-086: ベストプラクティス知見ソースは evergreen 蓄積にし、feed の実在を curl で先に確認する
- **事象**: ユーザーから「各社ブログ/アナウンス (Anthropic news/learn, GitHub Copilot blog 等) の取得が弱い。ベストプラクティス知見はアーカイブせず蓄積したい」と要望。実測すると anthropic-news=7件 (collector limit=2/run)、anthropic-engineering=3件、github-blog-ai=14件で、`evergreen` フラグは型に存在するのに **一度も使われていなかった** (live 0 件)。
- **根本原因**: (a) `github-blog-ai` の feed URL `https://github.blog/category/ai-and-ml/feed/` が 301 redirect 化 (canonical は `/ai-and-ml/feed/`) し、毎 run 余分な redirect subrequest を消費。(b) GitHub Copilot 専用 feed `https://github.blog/ai-and-ml/github-copilot/feed/` (200/10件、CLI 記事を含む) が未登録。(c) Anthropic は RSS 無し (rss.xml/feed.xml 全て 404 の Next.js)、HTML スクレイパの limit=2 (inline summarize の subrequest 予算確保のため絞っていたが、現在は `SUMMARIZE_MAX_NEW=0` で予算が空いていた)。(d) `decideTier` は `evergreen` を「cold 閾値超過後の最後の安全網」でしか見ておらず、`normalize.ts` も `source.evergreen` を entry に伝播していなかった。
- **対策**: (1) `github-blog-ai` を canonical feed に修正。(2) `github-copilot` ソースを新規追加。(3) Anthropic collector limit 2→6。(4) `SourceDefinition.evergreen` を `normalize.ts` 経由で entry に stamp し、`decideTier` を「`hot` の次に `evergreen` を評価して `warm` 固定 (cold/dropped にしない)」へ変更。(5) `anthropic-engineering` / `github-blog-ai` / `github-copilot` を evergreen 指定。(6) `scripts/migrate-evergreen.mjs` で既存 17 件を再 stamp (cold/dropped 0 件)。(7) `tests/half-life.test.ts` (evergreen 不変条件) と `tests/data-schema.test.ts` (evergreen が live で cold/dropped にならない) を追加。(8) source-meta.ts / SPEC.md / R-022 を同期。
- **教訓**: 新 feed を足す前に必ず curl で「RSS の有無」「301 redirect の有無」「per-item 日付の有無 (LL-045)」を確認する。型に存在するフラグ (`evergreen`) が配線されているとは限らない — 生成パイプライン (normalize → entry → decideTier) を端から端まで追って実際に伝播するか確認する。「アーカイブせず蓄積」は decideTier の評価順序 (`hot` → `evergreen warm` → 通常減衰) で表現し、検知 (test) と予防 (生成器 + migration) を両方そろえる。Worker は Git Integration 非対象 (LL-073) なので、retention ロジック変更後は明示承認のうえ deploy しないと stale Worker が evergreen を stamp せず知見が cold/dropped に戻る。

### LL-087: 「記事が更新されない」の主因は表示バグで、要約バックログは Worker Queue に任せる (ローカル一括 drain は巻き戻し危険)
- **事象**: ユーザーから「新しい記事が追加されない」(トップ LAST 7 DAYS が `9,2,1,0,1,1,1` と激減) と報告。調査の結果、収集は正常 (origin/main 毎時更新、直近24hで393件収集) で、症状は (1) DailySummary への `stats` prop 渡し忘れによる表示バグ (LL-083) と、(2) 要約バックログ (deterministic fallback が約30%) の2点が原因だった。バグ (1) を修正・本番反映後 (#81 マージ済み、本番は `113,121,59,54,43,32,7` を表示)、残るバックログ解消を「ローカル一括 AI 要約生成 (Option B)」で進めようとしていた。
- **根本原因**: (a) バックログの正確な実数は web の `isPublishableEntry`/`isDeterministicFallbackEntry` (data.ts) を**唯一の権威定義**とする。素朴な heuristic (「このエントリは 」prefix + "AI summary not yet available" だけ) では 240件だが、権威定義は JA/EN の needle 変種 ("AI 要約未生成"/"要約が未生成"/"後続の Worker run"/"AI summary pending"/"summary is pending") と synthetic title も検出するため **456件 (30.6%)** で、これが `/metrics.json` の `fallbackPercent:31`・`summaryQueueBacklog:455` と一致する。heuristic で測ると過少報告になる。(b) バックログは**自然減しない**: 06-11 約349件(25%) → 06-15 456件(30.6%) と微増した。総数が intake で増え、さらに evergreen ソース追加 (#83/#84) が intake を押し上げる一方、drain は Worker Queue の `ENQUEUE_MAX_NEW≈30/h` (KV free-tier 1000 writes/day 制約由来, LL-043) が上限のため、intake ≳ drain で steady-state ~30% に張り付く。(c) ローカル一括 drain (Option B) は時間が経つと**致命的に危険**: data/index.json は automated Worker が毎時 main を更新するため、数日前のローカル checkout で生成した古い index.json を commit すると LL-072 (data 巻き戻し) を起こす。仮に最新 main に enrichment を構造マージしても、生成は opus-4.7 で 1-3分/件 × 456件 = 8-23時間かかり、COPILOT_PAT 交換トークンが約30分で失効するため単一セッションでの完遂は脆い。
- **対策**: (1) 表示バグは `stats={STATS}` を渡して修正済み・本番反映済み (LL-083, PR #81)。(2) バックログは production の **Worker Queue (worker-summarizer)** に drain を任せる方針を既定とする (これが fallback safety net の設計 = 想定動作)。ローカル一括 drain は automated publisher が main を継続更新する artifact に対しては原則採らない。(3) バックログ計測は data.ts の権威定義か `/metrics.json` の `summaryQueueBacklog`/`fallbackPercent` を使い、素朴 heuristic で報告しない。(4) drain を速めたい場合は `ENQUEUE_MAX_NEW` 等 Worker 設定変更 + 明示承認デプロイ (R-008/LL-073) が必要で、その際は KV daily write quota (LL-043) のヘッドルームを先に確認する。ソースを増やし続けると intake>drain でバックログ%が漸増し、収集済み記事が公開タイムラインから隠れ続ける点に注意。
- **教訓**: 「収集が止まった」ように見える症状は、まず**収集実態 (origin/main の毎時 commit, collectedAt 直近24h, stats.byDay) と表示ロジックを分けて切り分ける** — 多くは LL-083 型の表示バグ。バックログのような「automated publisher が継続更新する data artifact」の品質は、ローカルで一括生成して commit する誘惑に乗らず、production の drain 機構 (Queue) に任せる。ローカル一括 drain は (巻き戻し・上書き・トークン失効) の三重リスクで、main が数日進んだ時点で obsolete になる。品質指標は UI が実際に使う権威関数で測り、heuristic の過少値で「改善した」と誤認しない。

### LL-088: drain throttle は ENQUEUE_MAX_NEW ではなく KV_LOOKUP_CAP が subrequest を食う (sendBatch は1 subrequest)
- **事象**: 要約バックログ (455件/31%) の drain が遅い (drain est 46h)。`worker/wrangler.toml` は `ENQUEUE_MAX_NEW=10` / `KV_LOOKUP_CAP=20` と保守的で、これは 2026-05-31 に「21:00Z cron が subrequest 上限超過」したため両方を下げた経緯による。バックログを速く減らしたいが、両値を上げると再び cron を壊す懸念があった。
- **根本原因**: 2 つの cap は subrequest への効き方が**全く違う**のに、2026-05-31 incident で**まとめて**下げられていた。(a) **enqueue は `Queue.sendBatch` (最大100件で1 subrequest)** なので `ENQUEUE_MAX_NEW` を 10→30 にしても collector の subrequest は増えない (1 sendBatch のまま)。`ENQUEUE_MAX_NEW` の唯一のコストは consumer 側の **KV write** (1 job=1 KV.put) で、これは Free-tier 1000 writes/day (LL-043) で律速される。(b) **`KV_LOOKUP_CAP` は 1 entry=1 KV GET subrequest** なので、これが subrequest の真のレバー。2026-05-31 に上限を超えたのは `KV_LOOKUP_CAP=500` (+collection+archive+redirect) のため。(c) consumer は `max_concurrency=2`・~120 jobs/h 容量で、producer cap (10/h) が真のボトルネック。consumer は generate 前に KV を pre-check しない (`processJob` は直接 Copilot を叩く) ので、`KV_LOOKUP_CAP < ENQUEUE_MAX_NEW` だと未検証 (uncheckedFallbackUrls) の speculative enqueue が増え、既に cached な URL を無駄に再生成しうる。
- **対策**: `ENQUEUE_MAX_NEW` 10→30 (LL-043 文書化済み安全値。30×24=720 + OG/heartbeat ≈770/day < 1000 KV cap)、`KV_LOOKUP_CAP` 20→40 (verified-missing で 30 enqueue を満たす。40 GET/cron は cron を壊した 500 の 8% で subrequest 余裕大)。`KV_LOOKUP_CAP ≥ ENQUEUE_MAX_NEW` を維持して speculative 無駄を抑える。typecheck + `wrangler deploy --dry-run` で toml 妥当性を確認し、明示承認のうえ collector worker を deploy (R-008/LL-073)。デプロイ後は `/metrics.json` の `summaryQueueDrainEstimateHours` 低下とエラー無しを確認する。
- **教訓**: Worker の throttle を上げ下げする前に、各 cap が **どの budget (subrequest / KV write / CPU / wall-time)** を消費するかを 1 つずつ特定する。「subrequest 超過したから関連 var を全部下げる」と、subrequest と無関係な var (sendBatch 経由の enqueue 数) まで巻き添えで絞られ、不要に性能を落とす。`sendBatch`/`getMany` のような batch API は「件数 ≠ subrequest 数」なので、件数 cap を subrequest コストと混同しない。変更は典型1 inv の subrequest 実測 (LL-036 の profiler) か、安全側の小幅増 + デプロイ後 tail 監視で検証する。

### LL-089: 編集前に対象ファイルが HEAD と一致するか確認する (stale working tree が LL を巻き戻す)
- **事象**: ナビ改良作業で `.github/copilot-instructions.md` の R-015 を書き換えた後、commit 直前に `git diff` を確認したところ、自分が触っていない `LL-087` / `LL-088` セクション (同一セッションで直前に追加・merge 済み) が **削除差分** として出ていた。作業ツリーは 705 行で、HEAD (8d01335) の 715 行より 10 行少なく、LL-087/088 を欠いていた。
- **根本原因**: 作業ツリーの `copilot-instructions.md` が、LL-087/088 を追加する前の stale な状態だった。`edit` ツールは disk 上の現ファイルに対して old_str→new_str を適用するため、stale なベースに編集を重ねると、そのまま commit した時に HEAD にあった新しい内容 (LL-087/088) を**消す巻き戻し差分**になる。`edit` の各操作自体は成功扱いになり、対象範囲 (R-015) だけ見ていると気づけない。LL-072 (data artifact の巻き戻し) と同型の、instructions ファイル版。
- **対策**: (1) commit 前に必ず `git diff --stat` と、重要ファイルは `git diff <file>` で**意図しない削除差分が無いか**を確認する。特に同一セッションで追記した LL/ルールが消えていないかを見る。(2) stale を検知したら `git checkout HEAD -- <file>` で HEAD 版に戻し、自分の編集 (R-015 / R-022 等) を**正しいベースに再適用**する。(3) 長いセッションで同じファイルを複数ブランチ・複数 PR にまたいで編集する場合、新しいブランチを切る前に対象ファイルが最新 origin/main と一致するか (`git show origin/main:<file> | diff - <file>`) を確認する。
- **教訓**: 「`edit` が成功した」=「正しいベースに適用された」ではない。編集対象が HEAD/origin と一致している前提を、commit 前の `git diff` レビューで必ず検証する。自分が触っていないセクションが diff に現れたら、それは stale working tree か巻き戻しのサイン。完了ゲート (agentic §4: 差分が要件に対応しているか) に「意図しない削除が無いこと」を含める。

### LL-090: Featured/Top を低シグナル release が独占する (importance 過大付与 + 単純な最新 imp3 選択)
- **事象**: ユーザーから「最近 Zed の記事しか上がっていない」と指摘。実データを確認すると収集は健全 (直近24hで36ソース・402件、Zed は10件のみ) で Timeline 本体 (publishedAt 降順) も多様だったが、トップの **Featured (注目ヒーロー) カードが Zed の `nightly:` ビルドを表示**し続けていた。
- **根本原因**: 2 段の不具合の合わせ技。(a) `harness/pipeline/normalize.ts` の `scoreImportance` が release/changelog ソースで `v1.`/`v2.`/`v3.` を含むと importance 3 を付与するため、Zed の `-pre` (プレリリース)・`nightly:`・`collab-staging:`/`collab-production:`・`extension-cli:`・`glsl-vX:` など **CI/プレリリース系タイトルが17件も imp3** になっていた (Ollama の `-rc` も4件)。(b) `web/src/lib/data.ts` の `featured()` が「配列順 (publishedAt 降順) で最初の imp3 非fallback」をそのまま選ぶため、**頻繁に publish する Zed が最新 imp3 を取り続けて注目枠を独占**。Top-3 はソース重複排除があり多少耐性があったが、低シグナル除外はしていなかった。
- **対策**: (1) **web 層を堅牢化 (LL-083 流: 保存データに依存しない)**。`isLowSignalRelease()` を `data.ts` に追加し、`featured()` と Top-3 の `rankedPool` から除外。`featured()` は「実アナウンス/blog (imp3 非release) → 安定版 release → imp2 …」の優先順にして、単純な最新 imp3 選択をやめた。判定はタイトルから行うので、収集側が未修正でも Featured/Top はすぐ正しくなる (Cloudflare Pages 反映だけで効く)。(2) **収集側の是正**。`scoreImportance` で低シグナル release を imp2 に上限化し、将来の付与を正す (ただし完全反映は Worker 再デプロイが必要、R-008/LL-073)。(3) 検出は **whack-a-mole を避ける汎用ルール**: `nightly|canary|snapshot|collab-(staging|production)`、`[-_.](pre|preview|rc|alpha|beta)\d*`、そして **末尾が PR 番号 `(#\d+)` の per-commit CI 項目**。安定版 (`Zed Editor Releases v1.6.3`, `Cline Releases v3.89.2`, `Continue.dev ... -vscode`) は誤除外しないことを 16 ケースのユニットテストと e2e (Featured/Top に低シグナルが出ない) で固定。
- **教訓**: 「特定ソースばかり出る」症状は、まず **収集の偏り** と **表示/ランキングの選択ロジック** を分けて切り分ける (LL-083 と同型: 多くは表示側)。release feed は per-commit/nightly/pre を高頻度に出すので、importance 付与で stable と低シグナルを必ず区別する。ヒーロー/Top のような目立つ単一スロットは「最新の高 importance を1件」だと高頻度ソースが独占するため、ソース多様性か種別 (announcement 優先) を選択条件に入れる。検出ルールはソース固有タグの列挙 (whack-a-mole) でなく、`(#\d+)` 末尾のような構造的シグナルで汎用化する。検出 (web) と予防 (collector の score) を両方そろえ、片方 (collector) が未デプロイでも UI が壊れない多層防御にする。

### LL-091: lane ページに Timeline サイドバー + 重い EntryCard を流用すると破綻する
- **事象**: ユーザーから「arXiv と Knowledge ページに Timeline カテゴリのサイドバーがあるのはおかしい。Knowledge はレイアウトがひどい」と指摘。実際 `/arxiv` と `/knowledge` が `<Sidebar active="..." />` (Timeline カテゴリ一覧, `aside.left`) を表示し、別レーンなのに無関係なカテゴリナビが出ていた。さらに Knowledge は `EntryCard` (Timeline 用の重いカード, 高さ261-304px) を 2 列 grid で並べ、グループパネル高が GitHub Copilot Blog で 1299px、Anthropic Engineering (3件) で 757px まで伸び、**巨大な空白パネル**が連続していた。
- **根本原因**: (a) lane ページ (arXiv/Knowledge) を実装するとき、既存の news Timeline ページのレイアウト (`.layout` 3カラム + `Sidebar`) をそのままコピーしたため、Timeline 専用の `Sidebar` (カテゴリ一覧) を別レーンに持ち込んでいた。`Sidebar` の `active` 型に `"arxiv"` まで足していたのが「arXiv でも出して良い」という誤った前提を強化していた。(b) Knowledge の知見一覧に Timeline 用 `EntryCard` を流用。EntryCard は OGP サムネ・タグ・要約・メタを持つ高さのあるカードで、3-7 件を 2 列 grid に置くと「カード高 × 行数 + グループ padding」でパネルが過剰に縦伸びし、内容に対して空白が支配的になった。
- **対策**: (1) `Sidebar` は **news Timeline 系ページ専用**と R-023 で明文化。lane ページからは `Sidebar` import を削除。(2) `.layout.lane-layout` (2カラム: main + 右 rail、`max-width:980px` で右 rail 非表示・1カラム化) を `portal.css` に追加し、arXiv/Knowledge をこれに切替。(3) Knowledge は `EntryCard` をやめ、`.knowledge-item` の軽量リストカード (タイトル + 2行 clamp 要約 + 相対時刻、`titleForLangWithFallback`/`summaryForLangWithFallback` で多言語) に変更。グループ高は GitHub Copilot 1299→795px、Anthropic 757→411px に圧縮。(4) lane ページ固有の補助 (arXiv code meaning/tags、Knowledge sources) は右 `aside.right` に集約。(5) E2E に「lane ページに `.layout aside.left` が 0 件」「`.layout.lane-layout` 表示」「Knowledge グループ高が item 数に対し過大でない」を追加。
- **追加根本原因 (2026-06-16 中間幅の崩れ)**: 上記 (2) の `.lane-layout` 基本ルールは 2 カラムだったが、ユーザーが「ウィンドウを狭めると壊れる」と指摘。実測すると **981-1180px で 3 カラム (`188px 628px 220px`、左に幅 188px の空カラム)** になっていた。真因はグローバル CSS の **timeline 専用レスポンシブ media query が `.lane-layout` にも適用されていた**こと: `@media (max-width:1180px) and (min-width:901px) { .layout:has(> aside.right:not(:empty)) { grid-template-columns: 188px minmax(0,1fr) 220px } }`。`.lane-layout` も `aside.right` を持つのでこの 3 カラムルールにマッチし、しかも media query は base の `.lane-layout` ルールより**後ろ**にあるため上書きしていた (R-009 系: グローバル CSS の詳細度/順序が後勝ちでレイアウトを壊す)。`@media (max-width:1100px) { .layout { 200px 1fr } }` も同様に lane を 2 カラム左 200px 化していた。
- **追加対策**: timeline 専用の `.layout` media query を `.layout:not(.lane-layout)` にスコープして lane を除外し、`.lane-layout` には `.layout.lane-layout` の高詳細度 + **自前の完結したレスポンシブ集合** (≥1181px: `1fr 300px` / 981-1180px: `1fr 260px` / ≤980px: 1 カラム + 右 rail 非表示) を与えた。E2E に「lane ページは全幅 (1280/1180/1100/1000/981/980/901/768/390) で 3 カラムにならない・`aside.left` 無し・横スクロール無し」の回帰テストを追加。検証は 1 幅だけでなく**ブレークポイント前後を含む複数幅**で grid 列数を実測する。
- **教訓**: ページを新設するとき、既存ページの layout を丸ごとコピーすると、そのページ専用の構造 (Timeline カテゴリ sidebar) まで持ち込んでしまう。**そのページの情報設計に合うレイアウトか**を確認する。一覧表示のカードは「一覧の密度」に合った重さを選ぶ — 詳細閲覧用の重いカード (OGP/タグ/メタ付き) を恒久知見の一覧に流用すると、空白だらけで可読性が落ちる (LL-049 の "詳細カード vs compact 一覧" と同型)。新ページの完了ゲートにスクショ + グループ/パネル高の寸法測定を入れ、「表示されている」だけでなく「縦密度が適切か」を確認する。**さらにレイアウト検証は 1 幅 (例: 1280px) だけで合格にしない**: グローバル CSS の `.layout` 等の共有セレクタには複数の media query があり、新バリアントが中間幅で意図せず上書きされる。`:has()` や属性ベースの共有ルールは新クラスにも match するので、新レイアウトは (a) 共有 media query を `:not(.new-variant)` で除外し、(b) 自前の完結したレスポンシブ集合を高詳細度で与え、(c) E2E でブレークポイント前後の複数幅 (desktop / mid / tablet / mobile) の grid 列数・横スクロールを実測する。
### LL-092: ユーザー提示の「知見をキャッチしたい」は URL そのままでなく適切な公式 feed に翻訳する
- **事象**: ユーザーから Anthropic (`anthropic.com/engineering/...`) / Microsoft (`github.com/microsoft/ai-engineering-coach`) / Google (`cloud.google.com/blog/products/data-analytics/...`) の知見をキャッチできるか質問。調査すると Anthropic engineering は既にカバー済み (提示記事も live にあり)、Microsoft / Google は未カバーだった。
- **根本原因 / 調査**: (a) 提示 URL を**そのまま feed 化できるとは限らない**。`github.com/microsoft/ai-engineering-coach` は GitHub の教材リポで `releases.atom` が空、`commits.atom` はあるが個別コミットを記事化すると低シグナルノイズ (LL-091 と同型)。→ リポ追跡ではなく Microsoft の知見系公式 feed `devblogs.microsoft.com/foundry/feed/` (Agent design/memory/toolboxes/cost ガイド) に翻訳。(b) `cloud.google.com/blog/rss` は **200 を返すが JS-rendered SPA の HTML で `<item>` が 0 件** (LL-086 の「200 ≠ 有効 RSS」)。実 RSS は legacy の `cloudblog.withgoogle.com/rss/` (20件・per-item `pubDate` あり・提示の data-analytics 記事を含む)。ただし firmwide broad feed で security/threat-intel/public-sector/retail も混ざる。
- **対策**: (1) `microsoft-foundry` (category `copilot`) と `google-cloud-blog` (category `gemini`) を `evergreen: true` で追加。(2) Google Cloud は broad なので R-017 のフィルタを付与: `GCLOUD_RELEVANCE_KEYWORDS` (ai/ml/data/agent/developer/antigravity/bigquery 等) を include、`GCLOUD_EXCLUDE_KEYWORDS` (threat/apt/ransomware/public sector/healthcare/retail/weekly roundup 等) を exclude、`keywordFilterScope: "title"` (LL-081)、`maxEntriesPerRun: 8`。実 feed の代表9タイトルでフィルタを検証 (提示の open-knowledge-format / Antigravity は KEEP、threat/roundup は DROP)。(3) `source-meta.ts` を同期し web build を通す。(4) `tests/source-filter.test.ts` に Google Cloud フィルタと evergreen 設定の固定テストを追加 (174 unit PASS)。(5) 完全反映には Worker 再デプロイが必要 (R-008/LL-073)。それまで本番の Knowledge には新ソースは出ない。
- **教訓**: 「この URL をキャッチして」は「その URL を feed 登録する」ではない。(a) その情報源の**正しい配信形式** (公式 RSS / Atom / 教材リポなら別の公式 blog) を探す。GitHub の教材・ドキュメントリポは releases/commits が記事に向かないことが多い。(b) feed URL は `curl` で **HTTP 200 だけでなく実際に `<item>`/`<entry>` がパースできるか**を確認する (SPA は 200 で HTML を返す, LL-086)。(c) firmwide の broad blog は必ず relevance/noise フィルタ (R-017) を title スコープで付ける (LL-081)。(d) 収集対象追加は Worker 再デプロイまで本番に出ない点を完了条件に明記する。

### LL-093: 「空白を消す」に振りすぎて殺風景化 + Astro scoped style はコンポーネント境界を跨がない
- **事象**: LL-091 で Knowledge の巨大空白を直す際、EntryCard をやめて `.knowledge-item` の**テキストだけのリスト**にした。ユーザーから「レイアウトが酷い、サムネイルもない、殺風景で見づらい」と再指摘。実際、同じグレーの箱が延々と続き視覚階層ゼロ・サムネイル無し・1280px で 1 列のみで右に大きく間延びしていた (agentic §9.5「殺風景化も禁止」に違反)。
- **根本原因**: (a) LL-091 で「縦密度を上げる=テキストリスト化」と短絡し、視覚的魅力 (サムネイル・色・階層) を犠牲にした。evergreen entry の OGP 画像保有率は 23% (5/22) しかなく「画像が無いからテキストだけ」にしたが、これは**画像が無いなら deterministic artwork を出す** (LL-064/CategoryThumb と同型) で解決すべきだった。(b) 作り直しで `KnowledgeCard.astro` コンポーネントを新設したが、その `.kg-*` スタイルを**呼び出し側の `knowledge.astro` の `<style>` ブロックに書いた**。Astro の scoped style は `[data-astro-cid-XXXX]` をそのコンポーネントのテンプレート要素にだけ付与するため、`knowledge.astro` スコープの `.kg-thumb` は `KnowledgeCard.astro` が描画する `.kg-thumb` 要素 (別 cid) に**一切適用されなかった**。結果 `aspect-ratio:16/9` が効かず thumb 高が 22px に潰れた (CSS は「存在する」が「適用されない」)。
- **対策**: (1) `KnowledgeCard.astro` を作り、全カードに **16:9 サムネイル** (実 OGP 画像 `entry.image` を `object-fit:cover`、無い/壊れたら `onerror` で `has-image` を外し**カテゴリ色グラデ + 絵文字の deterministic artwork** にフォールバック) + favicon + host + 相対時刻 + タイトル(3行clamp) + 要約(2行clamp) + カラータグを表示。(2) 2 列レスポンシブグリッド (`repeat(2,minmax(0,1fr))`, ≤620px で 1 列) で間延び解消。hover で持ち上げ。(3) **`.kg-*` スタイルは要素を所有する `KnowledgeCard.astro` 自身の `<style>` に置く** (scoped style はコンポーネント境界を跨がない)。`.knowledge-card-grid` のように呼び出し側 (`knowledge.astro`) のテンプレートに直接ある要素だけ呼び出し側に残す。(4) E2E に「各グループ先頭カードの `.kg-thumb` 高が >80px (16:9 が効いている=潰れていない)」を追加。
- **教訓**: (1) 「縦密度を上げる/空白を消す」は「装飾を全部削る」ではない (agentic §9.5: 殺風景化も禁止)。一覧カードは**サムネイル・色・視覚階層**を保ったまま compact にする。画像が無い前提のソースでも、broken thumb ではなく deterministic artwork (カテゴリ色 + 絵文字グラデ) を必ず出す (LL-064)。(2) **Astro の `<style>` は scoped で、別コンポーネントが描画する要素には適用されない**。子コンポーネントの要素のスタイルは子コンポーネントの `<style>` に書く。呼び出し側に書くと「CSS は存在するのに効かない」無言の崩れになる (computed で `aspect-ratio` が見えても要素に cid 属性が無ければ未適用)。要素の `data-astro-cid-*` 属性とスタイルのスコープ cid が一致するか、崩れたら必ず確認する。(3) UI 修正の検証は寸法実測 (thumb 高・カード高) + スクショ目視の両方を完了ゲートにする。

### LL-094: 画像が無いカードに大きな fallback artwork を出すのは逆に無駄 + image フィールドの型を確認する
- **事象**: LL-093 で「画像が無いなら deterministic artwork (16:9 の大きな絵文字グラデ) を出す」と決めたが、ユーザーから「サムネイルに画像がないのに、無駄に絵文字のデザインだけが大きく表示されていて無駄」と指摘。evergreen の 77% が画像無しなので、大きな絵文字ブロックが大量に並んで冗長だった。さらに調査で `KnowledgeCard` が `entry.image` を `<img src={entry.image}>` に直接渡していたが、**`image` は文字列でなく `{ src, origSrc, alt, width, height, source }` オブジェクト**で、画像ありカードは `src="[object Object]"` で実画像が出ていなかった (EntryCard は `entry.image.src` と `typeof img.src === "string"` で正しく扱っていた)。
- **根本原因**: (a) 「画像が無いなら必ず artwork で埋める」を一律適用したのが過剰。一覧では**画像がある記事だけサムネイルを出し、無い記事はサムネイル領域ごと省く**のが密度・情報量ともに最適。artwork は「全カードを 16:9 に揃える」ための装飾だったが、内容ゼロの 16:9 が大量に並ぶと逆に無駄スペースになる。(b) `entry.image` の型を確認せず文字列と仮定した。既存の EntryCard が `image.src` を使っていたのを見れば気付けた (横展開の確認不足)。
- **対策**: (1) `hasImage = typeof entry.image?.src === "string" && len>0` に修正し、`<img src={entry.image.src}>` にする。(2) 画像が**無い/壊れた**カードは `.kg-thumb` を**描画しない** (`{hasImage && <div class="kg-thumb">}`、`onerror` で card に `no-image` を付け thumb を `remove()`)。(3) 画像無しカードは殺風景化を防ぐため、**左端にカテゴリ色の細い 3px アクセント** + favicon 左の小さな絵文字マークだけにする (大きな artwork は廃止)。(4) 画像ありは従来どおり 16:9 サムネイル。(5) E2E を「描画された `.kg-thumb` は全て高さ >80px (=実画像、潰れ無し)。no-image カードは `.kg-thumb` を持たない」に更新。実測で画像あり4件 (naturalWidth 1920)・画像なし9件 (thumb 無し・カード高 153px) を確認。
- **教訓**: (1) fallback は「全要素を埋める」より「無いものは出さない」方が良い場合がある。一覧サムネイルは「画像がある時だけ出す」+「無い時はテキスト中心 + 小さなアクセント」が密度・情報量で優れる。装飾で 16:9 を無理に揃えると content の無い大箱が並ぶ。(2) **データフィールドの型を仮定しない**。`entry.image` のような構造体を `<img src>` に渡す前に型定義 (`data.ts` の `image?: { src: ... }`) と既存の使用箇所 (EntryCard) を確認する。`[object Object]` 系のバグは型を見れば防げる。(3) 同種 UI (EntryCard) が既にある場合、その実装の data の扱い方を横展開で参照する。

### LL-095: ナビ位置 (左/右) はサイト全体で揃える + lane rail は簡素にしない
- **事象**: ユーザーから「Timeline や Categories ページは左にナビがあるのに、arXiv や Knowledge は右にあって分かりづらい。見栄えも簡素でつまらない」と指摘。実際 Timeline/Categories は `Sidebar` (`aside.left`) が左、lane ページ (arXiv/Knowledge) は補助情報を `aside.right` に置いており、ページ間でナビ位置が左右に割れていた。
- **根本原因**: R-023 で「lane に Timeline カテゴリ sidebar を出さない」を正しく決めたが、**ナビの左右位置の一貫性**を考慮せず、lane を作るとき「補助だから右」と安易に右 rail にした。サイト内でナビ位置が割れると、ユーザーは毎ページ目線を左右に振り直すことになり摩擦になる。さらに lane rail は `side-card` にテキストを並べただけで、Timeline sidebar のようなブランド感・情報密度が無く簡素だった。
- **対策**: (1) `.layout.lane-layout` を `grid-template-columns: 264px minmax(0,1fr)` (左 rail + main) に変更し、DOM でも `aside.lane-rail` を main より前に置く。Timeline/Categories と同じ**左ナビ**に統一。`aside.right` は廃止。(2) lane rail をリッチ化: 先頭に `.lane-rail-id` (カテゴリ色グラデ背景 + 色付きアイコン + レーン名 + 説明 + 大きな件数 stat) を置き、その下に lane 固有補助 (arXiv=code meaning/paper tags、Knowledge=sources/Tip) を並べる。`--cat-color` を lane 色 (arXiv `#93c5fd` / Knowledge `#34d399`) に設定。(3) 既存の lane-layout 用 media query (LL-091 の `:not(.lane-layout)` スコープ) はそのまま活かし、≥981px=2カラム / ≤980px=1カラム + rail 非表示。E2E に「`aside.lane-rail` が main より左」「`aside.right` 0 件」「全幅で 3 カラム化なし・横スクロールなし」を追加。実測で rail left 48 < main left 336、全幅 OK。
- **教訓**: (1) **ナビゲーション位置 (左/右、上/下) はサイト全体で統一する** (NN/g の一貫性原則)。1 ページだけ違う側にナビを置くと「補助情報としては正しい」配置でも、回遊時の認知負荷になる。新ページを作るときは既存ページのナビ位置を確認し揃える。(2) サイドバー/レールは `side-card` を並べるだけにせず、ページの identity (アイコン + 名前 + 主要 stat) を先頭に置いて情報の入口にする。簡素 = つまらない。(3) UI の「分かりやすさ」はコンポーネント単体でなく**ページ間の一貫性**で決まる。レイアウト変更時は単ページのスクショだけでなく、姉妹ページ (Timeline ⇔ lane) と並べて構成が揃っているか確認する。

### LL-096: サムネ有無でカードの寸法を変えない (一覧は全カード同一レイアウト)
- **事象**: LL-094 で「画像があるカードだけ 16:9 サムネを出し、無いカードはサムネ無し」にしたところ、ユーザーから「サムネイルの有無でパネルのサイズが変わると見づらい。有無に関わらず同じレイアウトにして」と指摘。実際、画像ありカードは高さ 381px (縦 16:9 サムネ + body)、画像なしは 153px (body のみ) で、グリッド内で高さがバラバラだった。
- **根本原因**: LL-093→094 で「縦型カード + 上に 16:9 サムネ」を採り、サムネの有無でカードの**主要寸法 (高さ) が変わる**構造にした。一覧グリッドでは隣接カードの高さがバラつくと視線が乱れて読みづらい。「画像があるかどうか」はカードの寸法を決める軸にすべきでなかった。LL-094 の「無いものは出さない」を寸法まで適用したのが行き過ぎ。
- **対策**: **横型 (horizontal) カードに変更し、全カードを同一レイアウト・同一高さに統一**。`.kg-card-link` を `grid-template-columns: 116px minmax(0,1fr)` (固定幅サムネ枠 + body)、`min-height: 116px` にし、サムネ枠は**画像有無に関わらず常に存在**する。画像ありは実画像を `object-fit:cover`、画像なしは枠内に**小さな絵文字 (1.7rem) + カテゴリ色の控えめなグラデ**を出す (LL-094 の「大きな 16:9 が無駄」は枠が 116px と小さいので解消)。`.kg-card { display:flex }` + `.kg-card-link { width:100% }` でグリッド行内で高さを揃える。実測で全 13 カードが同一高さ 140px (`uniqueHeights:[140]`)、画像あり4・なし9 すべて同寸。E2E に「全 knowledge カードが単一高さ」「各カードに `.kg-thumb` が 1 つ」を追加。
- **教訓**: 一覧/グリッドのカードは、**コンテンツの有無 (画像・要約・タグ等) でカードの主要寸法を変えない**。可変要素は固定枠の中で吸収する (画像枠は常に同サイズ、中身が画像かプレースホルダーかだけ変える)。「無いものは出さない」(LL-094) は良い原則だが、**それを寸法に適用するとカード高がバラついて一覧が乱れる**。要素の出し分けは「枠内の中身」で行い、「枠の有無」で行わない。サムネ付き一覧は縦型 (サムネ上) より**横型 (サムネ左 + 固定幅)** の方が高さを揃えやすい。検証は「全カードの高さが 1 種類か」を実測する。

### LL-097: Knowledge ソースの多様性を AI 各社以外のエンジニアリング知見に広げる
- **事象**: ユーザーから「Knowledge のソースも情報も減った気がする。良さそうなデータソースを探して」と要望。実測すると evergreen は 5 ソース・40 件 (github-copilot 11 / microsoft-foundry 10 / google-cloud-blog 8 / anthropic-engineering 6 / github-blog-ai 5) で、件数は減っていないが **GitHub/Microsoft/Google/Anthropic の AI ベンダーに偏り**、AWS/Meta/Netflix のような大規模エンジニアリング/ML infra 知見が欠けていた。
- **対策 / 調査**: 候補 feed を curl で実在確認 (LL-086: HTTP 200 でなく `<item>`/`<entry>` がパースできるか)。結果: AWS ML Blog (`aws.amazon.com/blogs/machine-learning/feed/`, AI エージェント/Bedrock 実務), Meta Engineering (`engineering.fb.com/feed/`, 大規模システム/ML infra), Netflix TechBlog (Medium feed `medium.com/feed/netflix-techblog` が実 RSS。`netflixtechblog.com/feed` は HTML, LL-086) を採用。Netflix の素の URL や Uber (`Not Acceptable`)、Lyft (HTML) は不採用。Simon Willison は既に `simonw-blog` で登録済みなので重複回避。3 ソースとも per-item 日付あり (LL-045 の fetchArticleDate 不要)、実収集で AWS 8/Meta 6/Netflix 6 件を確認。AWS は AI/ML 専門 feed でノイズ無しなのでフィルタ不要、`maxEntriesPerRun` で流量制御。カテゴリは AWS=`agent-fw` (エージェント開発寄り)、Meta/Netflix=`tech-news` (engineering/industry)。`source-meta.ts` 同期、`tests/source-filter.test.ts` の evergreen 設定テストに 3 ソースを追加 (174 unit PASS)。
- **教訓**: 「ソースが減った/物足りない」要望には、(1) まず実データで現状の**ソース分布の偏り**を確認する (件数だけでなく provider の多様性)。(2) 候補は curl で実在 + パース可否を確認し (LL-086)、既存登録との重複を `grep` で確認する。(3) AI ベンダー公式 blog だけでなく、AWS/Meta/Netflix 等の**大規模エンジニアリング/ML infra blog** は evergreen 知見として価値が高い。(4) Medium ホストの企業 blog は `medium.com/feed/<publication>` が実 RSS (自社ドメインの `/feed` は HTML のことが多い)。(5) 収集対象追加は **Worker 再デプロイ**まで本番に出ない (R-008/LL-073)。デプロイ後、次の毎時 cron で該当 batch のソースが収集され `/knowledge` に蓄積される。

### LL-098: Knowledge は収集済みでも AI 要約待ちで表示されない (evergreen を要約キュー優先にする)
- **事象**: AWS/Meta/Netflix を追加・Worker デプロイ後、収集は成功 (本番データに 8 ソース・evergreen 64 件) しているのに、`/knowledge` ページは **13 件・3 ソースしか表示されない**とユーザーが指摘 (スクショ)。
- **根本原因**: `/knowledge` の `KNOWLEDGE_ENTRIES = ALL_ENTRIES.filter(evergreen)`、`ALL_ENTRIES = RAW_ENTRIES.filter(isPublishableEntry)`。`isPublishableEntry = hasGeneratedSummary && !isDeterministicFallbackEntry` なので、**実 AI 要約が完了したエントリだけ表示**する。新規収集 evergreen 64 件のうち 51 件は `summaryJa` が決定的 fallback (`このエントリは {source} から…`) のまま (AI 要約待ち)。`summaryEn` は RSS snippet で実テキストだが、`isDeterministicFallbackEntry` は **JA か EN のどちらかが pending なら fallback 扱い**にするため除外される (LL-028 の bilingual 要件の裏返し)。さらに要約キュー (`selectSummaryJobBatch`) は全 backlog (531 件) を均等ラウンドロビンで処理し **evergreen に優先度が無い**ため、cap 30/h・drain 18h で Knowledge ソースの記事が表示されるまで何時間もかかっていた (LL-087 の backlog がそのまま Knowledge 可視性に直結)。
- **対策**: `selectSummaryJobBatch` で **evergreen エントリを最優先**にした。eligible を `evergreenEligible` / `restEligible` に分け、jobs にまず evergreen を全部 (cap 上限まで) 入れ、残り枠を従来の cap-sized ラウンドロビン窓で `restEligible` から埋める。evergreen は少数 (~51 件) なので 2-3 cron で実 bilingual 要約が付き、`isPublishableEntry` を満たして `/knowledge` に出る。news backlog のラウンドロビン公平性は `restEligible` 側で維持。worker-queue test に「evergreen が news より先・重複なし・hour offset 不変で先頭固定」を追加 (175 unit PASS)。Worker 再デプロイで反映 (R-008/LL-073)。
- **教訓**: (1) 「収集済み」と「表示される」は別。表示が品質ゲート (`isPublishableEntry` = 実 AI 要約済み) を持つページでは、**収集 → 要約 → 表示**の各段で件数を確認する (`data/index.json` の raw count ≠ ページ表示 count)。(2) 一部だけ表示する**非同期 enrichment (要約キュー)** がある画面に新ソースを足すときは、その enrichment の **backlog と優先度**を確認する。優先度が無いと新ソースが backlog の最後尾に並び「収集したのに出ない」状態が長く続く。重要レーン (Knowledge) は enrichment を優先する。(3) bilingual 必須の品質ゲート (LL-028) は「片方 fallback でも除外」する。AI 要約待ちが多いと表示が痩せるので、要約 backlog (LL-087) の解消は表示品質に直結する。

### LL-099: RSS feed は最新 N 件しか返さない (ソース追加前の過去記事は構造的に収集不能) → 用語集で到達手段を補う
- **事象**: ユーザーから「[GitHub Copilot CLI が複数モデルファミリで second opinion を出す記事](https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/) がピックアップされていないのはなぜか」と質問。本番データにも現 feed にも該当記事が無い。
- **根本原因**: `github.blog` の RSS feed は **最新 10 件前後しか返さない** (過去記事は遡れない)。`github-copilot` ソースを registry に追加した時点 (2026-06) で、当該記事 (2026-04-06 公開) は既に feed の窓 (5/7〜6/16) から外れており、**収集機会が一度も無かった**。RSS の構造的限界であり、特定の URL を後から個別収集する機構も無い (Worker は毎時 feed から全件を再構築し `data/index.json` を上書きするため、手動 inject は LL-072 で次の cron に巻き戻る)。
- **対策**: (1) ユーザーには「RSS 窓の限界で個別記事の後付け収集は不可」と説明。(2) 鮮度で価値が減衰しない **AI/LLM 用語集ページ `/glossary`** を新設し (`web/src/lib/glossary.ts` = 約 50 語のキュレーション静的データ + `web/src/pages/glossary.astro`)、収集できない重要記事を**用語の一次情報リンクとして到達可能**にした (例: Rubber Duck Debugging 用語の link に second-opinion 記事を組込み)。用語集は feed 非依存の静的キュレーションなので RSS 窓の影響を受けない。プロンプト/コンテキスト/ハーネスエンジニアリング等のトレンド語を `trending` フラグでマークし、カテゴリ別・検索フィルタ付きで表示。ナビは menu-owned secondary destination (R-015)。
- **教訓**: (1) RSS/Atom feed は「最新 N 件」のスナップショットであり**アーカイブではない**。ソースを追加した瞬間に窓外の記事は永久に未収集になる。新ソース追加時は「いつから収集が始まるか (= 追加時点の feed 窓)」を意識し、それ以前の重要記事は別手段 (用語集リンク・手動キュレーション) で補う。(2) 個別記事を「なぜ出ないか」と問われたら、まず **(a) データに有るか (b) 現 feed に有るか** の 2 点を確認してから原因を切り分ける (収集ロジックのバグか、feed 窓の構造的限界かで対処が全く違う)。(3) feed で拾えない知見 (用語・ベストプラクティス・トレンド) は、feed 非依存の**静的キュレーションページ**で蓄積するのが堅い。

### LL-100: class の `display` は UA の `[hidden]{display:none}` を打ち消す → toggle/filter が無効化される
- **事象**: glossary に「カテゴリ別 / A-Z」ビュー切替と検索フィルタを実装したが、Playwright で `offsetParent` ベースに表示カード数を測ると、切替後も**両パネルが同時表示** (50+50=100 枚) され、JS の `panel.hidden = true` / `card.hidden = true` が視覚的に効いていなかった。論理的な属性カウント (`:not([hidden])`) では正常に見えたためテストを最初すり抜けた。
- **根本原因**: `.gl-stack { display:flex }` / `.gl-card { display:flex }` という **author の class セレクタ (詳細度 0,1,0)** が、ブラウザ UA スタイルシートの `[hidden] { display:none }` を上書きしていた。`[hidden]` の UA ルールも詳細度 0,1,0 だが、**author スタイルは UA スタイルより優先**されるため、`display:flex` が常に勝ち、`hidden` 属性を付けても要素が消えなかった。JS の `el.hidden = true` は属性を立てるだけなので、CSS 側で打ち消されると無効になる。前バージョンの検索フィルタも実は同じ理由で視覚的にカードを隠せていなかった (属性ベースの e2e がそれを見逃していた)。
- **対策**: `display` を class で当てる要素には、必ず `[hidden]` 変種を同梱して属性を勝たせる: `.gl-stack[hidden], .gl-group[hidden] { display:none; }` / `.gl-card[hidden] { display:none; }` (属性付きセレクタは詳細度 0,2,0 で class 単独に勝つ)。e2e は属性 (`:not([hidden])`) ではなく **`offsetParent !== null` の視覚的レンダリング数**で検証し、「非アクティブ panel が本当に消えている (表示カード数が 1 panel 分=50 で、100 でない)」を回帰ガードにした。
- **教訓**: `el.hidden`/`hidden` 属性で表示制御する要素に、`display:flex|grid|block` を class で当てると **UA の `[hidden]` が打ち消されて hidden が無言で壊れる**。`display` を持つ class には `&[hidden]{display:none}` を必ずセットにする (または `[hidden]{display:none !important}` を global reset に入れる)。表示/非表示の e2e は属性ではなく `offsetParent`/`toBeVisible`/`toBeHidden` で**実レンダリング**を見る (属性カウントは CSS 打ち消しを検出できない)。複数要素を出し分ける toggle は「合計レンダリング数が 1 ビュー分か」を数えると二重表示を一発で検出できる。

### LL-101: 「新着が追加されない」の主因は publishable-only 表示ゲート (収集済みの38%を非表示) — listable + クロス言語フォールバックで解消
- **事象**: ユーザーから「新しい記事が一向に追加されない」と報告。本番トップの Timeline は TODAY 2件 / YESTERDAY 1件 / Jun17 3件 しか表示せず、収集が止まったように見えた。実際は収集は完全に正常 (origin/main は毎時更新、直近24hで553件収集、`sourcesOk=14/14`、生データの publishedAt は Jun19=46 / Jun18=57 / Jun17=81 件)。
- **根本原因**: サイト全体が `ALL_ENTRIES = RAW_ENTRIES.filter(isPublishableEntry)` (実 AI 要約済みのみ) でフィルタしており、**AI 要約待ちのエントリ (本番 628件 / 38%) を完全非表示**にしていた。要約キューの drain (≈30/h) が intake に追いつかず backlog が増加 (LL-087 時 456件→628件)、しかも新着ほど要約待ちなので recent days が 1-3件に潰れていた。さらに pending には 2 種あった: **Type 1** (英語ソースで `summaryEn` は実在するが `summaryJa` が boilerplate=`このエントリは…`) と **真の pending** (どの言語にも実要約なし)。Type 1 は本来「英語要約を JA ビューに原文フォールバック表示」すべきだが、`summaryForLang("ja")` が boilerplate を valid とみなして返し、`summaryForLangWithFallback` のクロス言語フォールバックが発火しなかった。これが「収集済みなのに見えない」の核心 (LL-074/083/087 と同系統、最悪化)。
- **対策 (表示=Cloudflare Pages のみ・即反映)**: (1) `isListableEntry`(publishable **または** 実タイトルを持つ pending) を導入し `ALL_ENTRIES` をこれに変更 → Timeline/カテゴリ/タグに新着が即表示。(2) `summaryForLang` を `isSummaryNoise`(空/boilerplate/タイトルecho) + synthetic 拒否に修正し、`summaryForLangWithFallback` を両言語とも `summaryForLang` 経由のクロス言語フォールバックに変更 → **Type 1 は JA ビューで実英語要約を「原文EN」バッジ付きで表示**、真の pending だけ「AI要約 生成中」状態。分類 (`isPublishableEntry`) は raw フィールド参照なので不変。(3) Featured/Top-3 は既存の `!isDeterministicFallbackEntry` 自己フィルタで publishable 維持、RSS/JSON feed は `PUBLISHABLE_ENTRIES` に限定、**Knowledge レーンは publishable-only 維持** (curated・カード均一高さ LL-096・要約品質重視)。(4) 詳細ページは `summaryAbsent`(全言語で実要約なし) と `bodyIsFallback`(本文未生成) を分離し、Type 1 で英語要約 TL;DR を出しつつ boilerplate 本文は出さない。(5) `metrics.liveEntries` は publishable 据え置き (`allTimeEntries >= liveEntries` 不変条件維持)、recency 系カウントは listed ベースで実態反映。
- **対策 (スループット=要承認 Worker deploy・R-008/LL-073)**: 要約キュー (`selectSummaryJobBatch`) を evergreen 優先 (LL-098) の次に **recent 優先** (cap の半分を最新 publishedAt に予約) + 残りを round-robin (LL-076 公平性維持) に変更 → 新着が 1-2 cron で実要約化。`KV_LOOKUP_CAP` 40→80 (subrequest-bound)、`ENQUEUE_MAX_NEW` 30→35 (KV write 840+α/day < 1000 LL-043)。
- **教訓**: 「収集された」と「表示される」は別。automated publisher が継続更新する artifact で「新着が出ない」症状は、まず **収集実態 (origin/main の毎時 commit・collectedAt 直近24h・publishedAt 分布) と表示フィルタを分けて切り分ける** (LL-083/087 と同型・多くは表示側)。`filter(isPublishableEntry)` のような品質ゲートを**サイト全体の表示母集団**に掛けると、非同期 enrichment の backlog がそのまま「新着の不可視化」に直結する。pending を隠すのではなく、(a) 実タイトルがあれば listable にして出す、(b) 片言語だけ要約済みなら他言語へクロスフォールバック表示 (原文バッジ付き)、(c) どの言語にも無いときだけ明示的な「生成中」状態、を多層で用意する。boilerplate を valid 要約として返す helper があるとフォールバックが死ぬので、表示 helper は noise を必ず空に潰す。ローカル checkout が automated data で数日遅れると鮮度依存 e2e (TickerBar LL-082) が誤検知するので、検証は `git checkout origin/main -- data/` で fresh data を入れてから行う。

### LL-102: 要約 backlog が drain しない真因は「merge 側 round-robin が 1件/時間」— enqueue 側だけ LL-076 で直し対称側を直し忘れていた
- **事象**: ユーザーから「毎回記事要約処理でスタックしている、なぜ再発防止が効かないのか」と指摘。LL-008/010/026/037/075/080/087 と要約スタック対策を重ねてきたのに backlog が ~38% に張り付いたまま。
- **計測 (推測でなく実データ)**: 直近28hの origin/main commit を追うと **realSummaryJa は +10件 (0.36件/時) しか増えていない**のに enqueue は 35件/時。`fallbackTotal` は entries と 1:1 で増加 (net-zero drain)。一方 **KV には `s:` 要約キーが 2844件**あり index の実要約 1268件より遥かに多い (= 生成済みだが未反映が大量)。KV を直接読むと実要約 (claude-opus-4.7) が入っているのに index 側は boilerplate のままのエントリが存在。
- **根本原因**: 要約パイプラインは 2 つの round-robin 窓を持つ。**(A) enqueue 窓** (`selectSummaryJobBatch`, summarizer に投げる) は LL-076 で「cap/時間」進むよう修正済み → 生成は数時間で一周。**(B) KV-lookup/merge 窓** (`worker/src/index.ts` の `rrHourOffset`, KV の要約を index に反映) は **`Math.floor(Date.now()/3600_000) % allFallback.length` で 1件/時間しか進まない**まま放置されていた → 627件を一周するのに **627時間 (26日)**。結果、summarizer は要約を生成して KV に書くが、collector がそれを読み戻す窓が crawl するため merge が 0.36件/時に律速され、KV に要約が溜まる一方で index の backlog が永久に減らない。LL-076 は対称な 2 つの窓の片方 (enqueue) だけを直し、もう片方 (merge) を見落としていたのが「再発防止が効かない」正体。
- **対策**: 両窓を単一の `roundRobinStart(nowMs, total, cap)` ヘルパー (summary-queue.ts) に統一し、enqueue と KV-lookup の両方で `(hour*cap)%total` で cap/時間進めるようにした (merge 窓は 627h→~8h で一周)。subrequest コストは不変 (読む件数は KV_LOOKUP_CAP のまま、進む位置だけ変更)。`roundRobinStart` の単体テスト (cap/時間で進む・1件/時間でない・ceil(total/cap)時間で全件被覆) を追加。Worker 再デプロイで反映 (R-008/LL-073)。デプロイ後 realSummaryJa が急増することを実測で検証する。
- **教訓**: 同じ「round-robin は cap 単位で進める」不変条件を**複数箇所**で持つときは、必ず**単一ヘルパーに集約**して対称性を担保する。片方だけ直すと、もう片方が同じバグを抱えたまま残り「対策したはずなのに効かない」になる (LL-076→LL-102 はまさにこの再発)。enrichment パイプラインの drain は「生成 (enqueue)」と「反映 (merge/lookup)」の**両方の throughput** を別々に計測する — 生成が速くても反映が律速だと net-zero になる。診断は health の集約値 (`fallbackTotal`) だけ見ず、KV キー数 vs index 反映数のような**生成済みストックと反映済みフローの差**を見る。`fallbackTotal` は summary と body の両欠落を含む混合指標なので、web 可視の「実 summaryJa あり」件数の推移を別途追う。

### LL-103: カテゴリ一覧は vendor グループ定義順でなくアルファベット順 + 絵文字アイコンにする (ナビは予測可能な順序を優先)
- **事象**: ユーザーから「サイドバーのカテゴリがバラバラ。アイコン付き・アルファベット順にしないのはなぜ」と指摘。サイドバーは vendor group (Microsoft→Anthropic→OpenAI→…) で分け、グループ内は `CATEGORY_META` 定義順、アイコンは 2 文字タイル (Co/Cl) だった。9 グループ中 5 つが 1 カテゴリのみでグループ分けの利点が薄く、順序が定義順なので予測不能に見えていた。
- **根本原因**: `CATEGORY_META` は authoring 順で、各表示箇所 (Sidebar / categories directory / about coverage) がそれをそのまま定義順で `.map` していた。絵文字は `CATEGORY_META.emoji` に定義済みだが未使用で、代わりに 2 文字 initial を表示していた。
- **対策**: `data.ts` に `CATEGORIES_BY_NAME` / `CATEGORIES_BY_SHORT_LABEL` (アルファベット順) と `shortLabel` フィールドを追加し単一ソース化。**ナビ系一覧** (Sidebar=フラット A→Z + 絵文字、categories の compact directory=A→Z + 絵文字、about coverage=A→Z + 絵文字) をアルファベット順 + 絵文字タイルに統一。categories の**詳細カード**は探索文脈のため group 構造を維持しつつ、group も group 内もアルファベット順 + 絵文字に。**活動順 (DailySummary の主要カテゴリ=件数 desc) は目的が違うので順序維持**。Knowledge ページの Sources nav は当初「出所別だから件数順」と判断したが、ユーザーが「アルファベット順? 絵文字?」とスクショで再指摘 → ナビ一覧の一貫性を優先し **Knowledge sources も A→Z + favicon アイコン** (`sourceLabel` でソート、source URL から favicon) に統一。e2e に「サイドバー 14 件が A→Z かつアイコンが非 ASCII (絵文字)」「categories directory が A→Z」「Knowledge sources が A→Z + favicon」の回帰テストを追加。
- **教訓**: 一覧の並び順は**その一覧の目的**で決める。ナビ/ディレクトリ (探す) は**予測可能な A→Z**、ダッシュボード (今の活動) は**件数/新しさ順**。レーンの source グルーピングも、ナビとして並べるなら A→Z にする (ユーザーは「一覧は基本 A→Z」を期待する — 件数順は活動ダッシュボードだけに留める)。authoring 定義順をそのまま UI に出すと「バラバラ」に見える。並び順とラベル/アイコンは `CATEGORY_META` 由来の単一ソース helper (`CATEGORIES_BY_*`) に集約し、各ページが独自に `.map(定義順)` しない。アイコンはデータに既にあるなら (emoji) それを使い、2 文字コードのような代用を出さない。LL-057 の parent-group taxonomy は categories 詳細カードで維持し、ナビ系はフラット A→Z にするという**面ごとの使い分け**で両立する。

### LL-104: 要約スタックの真因は summarizer の all-or-nothing 書き込み (body 未完で要約ごと破棄)
- **事象**: LL-102 (merge 窓修正) をデプロイしても realSummaryJa は +2/cron しか増えず drain しなかった。「毎回スタック」の核心が merge ではないと判明。
- **計測 (推測でなく実データ)**: 現行 fallback エントリ 12 件の KV を直接読むと **11 件が MISS (KV に要約なし)**。つまり生成済み要約が反映されていない (merge 問題) のではなく、**そもそも要約が生成・保存されていない (生成問題)**。summarizer /health は `incomplete summary` エラーを継続的に記録 (06:08Z 時点も)。
- **根本原因**: `worker-summarizer/src/index.ts` の `processJob` は `isCompleteCacheEntry` (**titleJa+summaryJa+summaryEn+bodyJa+bodyEn の 5 項目全部**) を満たさないと `throw` し **KV に何も書かない** (3 回の recovery/repair 試行後)。bilingual の長い body (bodyJa 240-420 字 / bodyEn 140-220 語) が最も truncate しやすく、body 生成が失敗すると**完璧な要約ごと破棄**される。dashboard は要約 (title+summaryJa+summaryEn) があれば publish できる (collector の merge 条件も summaryJa+summaryEn+titleJa で body 不要、body は deterministic fallback で埋まる R-012/R-013) のに、body のために要約を捨てていた。これで fallback エントリの大半が永久に KV 要約なし = boilerplate のまま。
- **対策**: `isSummaryComplete` (titleJa+summaryJa+summaryEn) を追加し、**要約が揃えば body 未完でも `putCacheEntry` で KV に書く**よう変更 (最終 throw 条件を `!isCompleteCacheEntry` → `!isSummaryComplete` に)。3 回の試行は引き続き完全な entry (body 込み) を狙うが、最終的に要約だけでも得られたら保存する。要約成功は body より容易なので、デプロイ後は backlog が ~11h で drain する見込み (enqueue 35/h)。単体テスト (body 空でも要約完成なら put される / isSummaryComplete の判定) を追加。Worker 再デプロイで反映 (R-008/LL-073)、デプロイ後 realSummaryJa の急増を実測検証する。
- **教訓**: 非同期 enrichment で**複数フィールドを 1 単位で生成**するとき、「全フィールド揃わないと破棄」にすると、最も失敗しやすいフィールド (ここでは長文 body) が**全体の歩留まりを支配**する。**publish に必須な最小単位 (要約) と、あれば良い付加情報 (body) を分け**、必須単位が揃ったら保存する (部分的成功を捨てない)。診断は「生成されているが反映されない (merge)」と「そもそも生成されていない (generation)」を **KV を直接読んで** 切り分ける — health の集約 backlog 値だけでは区別できない。LL-102 (merge) は正しい修正だが主因ではなかった: 1 つの症状に複数の原因が重なるとき、最初に見つけた原因で止めず**実データで効果を検証**して次の原因を追う。

1. 作業中の「想定外の挙動」「ユーザーからの行動修正フィードバック」「ツール失敗の根本原因」を都度メモする。
2. タスク完了の **前** に、本ファイルの `📚 Lessons Learned` へ LL-XXX として追記する。恒久ルール化すべきものは `🚨 絶対ルール` に R-XXX として昇格する。
3. 古くなった LL/R は更新または削除する（誤情報を残さない）。
4. 追記・更新は **コード修正と同一 commit** に含める（persona §8.1 の 3 点セットと同じ）。
