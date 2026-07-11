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

### R-007: 記事要約 / 補完 backfill のモデルは Claude 系 (Sonnet 4.6 / Opus 4.7 / Opus 4.8) または GPT-5.5 に限定する
- 通常要約も補完/backfill も `SUMMARIZE_MODEL` は `claude-sonnet-4.6` / `claude-opus-4.7` / `claude-opus-4.8` / `gpt-5.5` のみ使用する。既定は **`claude-sonnet-4.6`** (Cloudflare Worker の 30 秒 wall-time に opus の長文生成が収まらず常時 timeout する事象を 2026-05 に確認、LL-031)。
- `gpt-4o` 等の旧モデルは記事要約 / 補完 backfill の代替モデルとして使用しない。
- `gpt-5.5` は Copilot の `/responses` 専用なので、現行 Worker (`/chat/completions`) からは利用できない (LL-010)。Worker を `/responses` 仕様に拡張するまで `claude-*` 系のみ実利用可能。
- 長文生成が詰まる場合は、max_tokens / timeout / concurrency を調整し、それでも必要なら `claude-opus-4.8` / `claude-opus-4.7` (品質優先) と `claude-sonnet-4.6` (速度優先) を切り替える。本番モデル変更は小 batch (`SUMMARIZE_MAX_NEW=1` または backfill の `--limit 1`) で smoke test してから適用する (LL-010)。
- **ローカル backfill (要約のみ・短プロンプト) は `claude-opus-4.8` を使ってよい**。Worker の 30 秒 wall-time 制約 (LL-031) は CPU 時間ではなく長文 body 生成のトークン枯渇が主因 (LL-106/115) で、ローカルかつ要約のみ (`buildSummaryPrompt`) なら opus でも budget 内で完了する。Worker 既定を opus に変えるわけではない (本番収集は引き続き sonnet)。

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

### R-011: fresh entry merge で既存の summary enrichment を落とさない
- Worker が fresh entry と既存 `data/index.json` を canonical URL で merge する時、fresh entry が選ばれても既存 entry の `titleJa` / `summaryJa` / `summaryEn` を保持する。
- `npm run summaries:apply-cache` は品質 gate を通過した title / summary / importance / tags だけを `data/index.json` に反映する。本文を index へ書き戻してはならない。
- index に旧 `bodyJa` / `bodyEn` が残る migration では、実本文を `data/bodies.json` へ移してから index を空にする。完了前に `tests/data-schema.test.ts` の summary 必須、index 本文なし、bodies schema の各 gate を通す。

### R-012: live index は要約のみ・本文は別ファイル (body-file architecture / LL-115)
- `data/index.json` の live entries は `summaryJa` / `summaryEn` の**両方を必ず非空**にする (両言語必須)。完了前に `tests/data-schema.test.ts` の summary 欠落ゲートを通す。
- **本文 (`bodyJa` / `bodyEn`) は index に格納しない**。本文は `data/bodies.json` (`{ generatedAt, count, bodies: { [id]: {bodyJa, bodyEn, model, generatedAt} } }`) に entry id をキーに格納する。index は本文フリーで軽量維持し CI サイズ予算 (8MB, LL-112) を超えない。完了前に `tests/data-schema.test.ts` の「live index は本文を持たない」ゲートを通す。
- 本文は専用クラウド worker (Phase B: opus-4.8 reasoning=max) が生成し `data/bodies.json` に蓄積する。生成は I/O 主体で Cloudflare の CPU 予算に当たらない (LL-115)。決定論的 filler body は**生成・格納しない** (LL-112)。
- 記事詳細の本文表示は `web/src/lib/bodies.ts` の `bodyForEntry(id)` を使う。本文が無いエントリは要約を主役にし原文リンクを出す (偽の生成予告を出さない)。`isDeterministicFallbackEntry` (web 分類) は本文を見ない。
- 既存本文の index→bodies.json 移行は `npm run body:migrate` (`scripts/migrate-bodies-to-file.mjs`)。

### R-013: Worker publish 前に summary fallback を適用し、index を本文フリーに保つ
- production Worker は `data/index.json` を commit する前に deterministic **summary** fallback を全 live entry に適用し、`summaryJa` / `summaryEn` のいずれかが空の payload を publish しない (両言語必須)。本文は fallback 対象にしない。
- Worker は publish 時に index entry の `bodyJa` / `bodyEn` を**必ず空にする** (LL-115)。`s:` cache hit が旧 body を持っていても index には載せない (LL-073 family: stale cache 由来の本文混入で index を再肥大化させない)。本文は `data/bodies.json` 経路でのみ更新する。
- 英語タイトルのみの entry でも `summaryJa` は決定的な日本語テンプレートで埋める。逆も同様。JA / EN UI で cross-language fallback バッジを出さないこと (LL-028)。
- `isDeterministicFallbackEntry` (web) / `needsGeneratedContent` (worker) はいずれも**要約のみ**で fallback 判定する。本文の有無で publishable を切り替えない (LL-107/LL-112)。
- Worker runtime は Cloudflare Pages Git Integration では自動更新されない。`worker/src/**` の品質修正後は、明示承認を得て Worker deploy を実施し、古い Worker が index に本文を再投入しないことを確認する。

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

### R-024: PR merge 後は同一セッションで branch / worktree を安全に整理する
- PR を main へ merge したら、同一セッション内で head の remote branch、local branch、関連 worktree を精査して整理する。
- 削除前に対象 worktree の `status` が clean、必要な内容が main に反映済み、open PR が無い、固有 commit・patch・file が無いことを確認する。squash merge では `git branch --merged` だけに依存せず、PR 状態、patch 差分、`git cherry`、worktree の dirty 状態を合わせて判定する。
- dirty、open PR、固有 commit、固有 file のいずれかがある branch / worktree は削除しない。保持理由と固有差分を具体的に報告し、force delete は使わない。
- 整理後は `git fetch --prune`、`git branch -vv --all`、`git worktree list --porcelain`、`gh pr list --state open`、main の clean status を再確認する。

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

### LL-025: summary cache と live index の乖離を完了前に解消する
- **事象**: 最新 `data/index.json` では 669 件中 663 件の `bodyJa` / `bodyEn` が空で、そのうち 415 件はローカル `data/_summary-cache.json` に body が存在していた。
- **根本原因**: cache に body があっても live index へ再反映する gate が弱く、Worker の fresh/prior merge でも fresh raw entry が選ばれると既存 enrichment を落とし得る状態だった。さらにローカル cache と production KV cache は別物であるため、片方の充足をもう片方の publish 済みと見なせなかった。
- **対策**: body-file architecture 導入後は `npm run summaries:apply-cache` を summary-only writer に限定し、品質 gate を通過した要約だけを index へ反映する。本文は `data/bodies.json` で照合し、旧 index 本文は `npm run body:migrate` または migration の transfer 処理で sidecar へ移す。
- **教訓**: summary と body は別の artifact と coverage 指標として扱う。summary cache の反映で本文を index へ戻さず、index 本文 0 件と bodies sidecar の整合を別々に検証する。

### LL-026: LLM body backfill が特定 URL で詰まっても filler を index に戻さない
- **事象**: 既存記事の `bodyJa` / `bodyEn` backfill 中、Opus 4.7 が一部 URL で長時間応答せず、batch が完了せずに `data/index.json` への反映が遅れた。
- **根本原因**: 長文 body 生成は URL / ソース / 入力内容によって model latency が大きく、retry しても同一 entry で詰まり続けることがある。cache は成功ごとに増えるが、index は batch 完了まで更新されない。
- **対策**: 本文生成は `data/bodies.json` を対象に resume 可能な小 batch で行う。未生成本文は空のまま要約と原文リンクを表示し、`--fill-missing-body` のような deterministic filler を index/cache へ書く旧経路は拒否する。
- **教訓**: 本文未生成は許容状態であり、偽本文で埋めない。要約の publish gate と本文 sidecar の coverage を分離し、長文生成の失敗で summary-first UI を止めない。

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
- **対策**: `scripts/fill-title-en.mjs` を作成。`summaryEn` が実 AI 要約の場合だけ先頭文 (最大 120 文字) を `titleEn` に設定する。`summaryEn` が deterministic fallback / pending の場合は `titleEn` を空のままにし、UI の `titleForLangWithFallback` が JA 原題 + 言語バッジで truthful にフォールバックできる状態を維持する。実行は `npm run titleen:fill -- --apply`。
- **教訓**: `titleEn` と `summaryEn` は独立して管理するが、**target-language field を source-language title で埋めない**。`summaryEn` の AI 生成が完了した段階でだけ `npm run titleen:fill -- --apply` を再実行して英語タイトル品質を向上させる。

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
- **対策 (スループット=要承認 Worker deploy・R-008/LL-073)**: 要約キュー (`selectSummaryJobBatch`) を evergreen 優先 (LL-098) の次に **recent 優先** (cap の半分を最新 publishedAt に予約) + 残りを round-robin (LL-076 公平性維持) に変更 → 新着が 1-2 cron で実要約化。`KV_LOOKUP_CAP` 40→80 (subrequest-bound、後に LL-152 で 40 へ戻した)、`ENQUEUE_MAX_NEW` 30→35 (KV write 840+α/day < 1000 LL-043)。
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
- **対策**: `data.ts` に `CATEGORIES_BY_NAME` / `CATEGORIES_BY_SHORT_LABEL` (アルファベット順) と `shortLabel` フィールドを追加し単一ソース化。**ナビ系一覧** (Sidebar、categories の compact directory、about coverage) をアルファベット順 + アイコンに統一。ただし **Sidebar は狭い/高密度なので絵文字より 2 文字タイル (brand color) の方が読みやすい** とユーザー指摘 (スクショ: 絵文字 + sparkline + count で長い名が truncate・絵文字の視覚ノイズ) → サイドバーは 2 文字タイルに戻し、幅のある categories ディレクトリ/カード・about coverage は絵文字を維持 (アイコンの種類は面の密度で使い分ける)。categories の**詳細カード**は探索文脈のため group 構造を維持しつつ、group も group 内もアルファベット順 + 絵文字に。**活動順 (DailySummary の主要カテゴリ=件数 desc) は目的が違うので順序維持**。Knowledge ページの Sources nav は当初「出所別だから件数順」と判断したが、ユーザーが「アルファベット順? 絵文字?」とスクショで再指摘 → ナビ一覧の一貫性を優先し **Knowledge sources も A→Z + favicon アイコン** (`sourceLabel` でソート、source URL から favicon) に統一。e2e に「サイドバー 14 件が A→Z かつアイコンが非 ASCII (絵文字)」「categories directory が A→Z」「Knowledge sources が A→Z + favicon」の回帰テストを追加。
- **教訓**: 一覧の並び順は**その一覧の目的**で決める。ナビ/ディレクトリ (探す) は**予測可能な A→Z**、ダッシュボード (今の活動) は**件数/新しさ順**。レーンの source グルーピングも、ナビとして並べるなら A→Z にする (ユーザーは「一覧は基本 A→Z」を期待する — 件数順は活動ダッシュボードだけに留める)。authoring 定義順をそのまま UI に出すと「バラバラ」に見える。並び順とラベル/アイコンは `CATEGORY_META` 由来の単一ソース helper (`CATEGORIES_BY_*`) に集約し、各ページが独自に `.map(定義順)` しない。アイコンはデータに既にあるなら (emoji) それを使い、2 文字コードのような代用を出さない。LL-057 の parent-group taxonomy は categories 詳細カードで維持し、ナビ系はフラット A→Z にするという**面ごとの使い分け**で両立する。

### LL-104: 要約スタックの真因は summarizer の all-or-nothing 書き込み (body 未完で要約ごと破棄)
- **事象**: LL-102 (merge 窓修正) をデプロイしても realSummaryJa は +2/cron しか増えず drain しなかった。「毎回スタック」の核心が merge ではないと判明。
- **計測 (推測でなく実データ)**: 現行 fallback エントリ 12 件の KV を直接読むと **11 件が MISS (KV に要約なし)**。つまり生成済み要約が反映されていない (merge 問題) のではなく、**そもそも要約が生成・保存されていない (生成問題)**。summarizer /health は `incomplete summary` エラーを継続的に記録 (06:08Z 時点も)。
- **根本原因**: `worker-summarizer/src/index.ts` の `processJob` は `isCompleteCacheEntry` (**titleJa+summaryJa+summaryEn+bodyJa+bodyEn の 5 項目全部**) を満たさないと `throw` し **KV に何も書かない** (3 回の recovery/repair 試行後)。bilingual の長い body (bodyJa 240-420 字 / bodyEn 140-220 語) が最も truncate しやすく、body 生成が失敗すると**完璧な要約ごと破棄**される。dashboard は要約 (title+summaryJa+summaryEn) があれば publish できる (collector の merge 条件も summaryJa+summaryEn+titleJa で body 不要、body は deterministic fallback で埋まる R-012/R-013) のに、body のために要約を捨てていた。これで fallback エントリの大半が永久に KV 要約なし = boilerplate のまま。
- **対策**: `isSummaryComplete` (titleJa+summaryJa+summaryEn) を追加し、**要約が揃えば body 未完でも `putCacheEntry` で KV に書く**よう変更 (最終 throw 条件を `!isCompleteCacheEntry` → `!isSummaryComplete` に)。3 回の試行は引き続き完全な entry (body 込み) を狙うが、最終的に要約だけでも得られたら保存する。要約成功は body より容易なので、デプロイ後は backlog が ~11h で drain する見込み (enqueue 35/h)。単体テスト (body 空でも要約完成なら put される / isSummaryComplete の判定) を追加。Worker 再デプロイで反映 (R-008/LL-073)、デプロイ後 realSummaryJa の急増を実測検証する。
- **教訓**: 非同期 enrichment で**複数フィールドを 1 単位で生成**するとき、「全フィールド揃わないと破棄」にすると、最も失敗しやすいフィールド (ここでは長文 body) が**全体の歩留まりを支配**する。**publish に必須な最小単位 (要約) と、あれば良い付加情報 (body) を分け**、必須単位が揃ったら保存する (部分的成功を捨てない)。診断は「生成されているが反映されない (merge)」と「そもそも生成されていない (generation)」を **KV を直接読んで** 切り分ける — health の集約 backlog 値だけでは区別できない。LL-102 (merge) は正しい修正だが主因ではなかった: 1 つの症状に複数の原因が重なるとき、最初に見つけた原因で止めず**実データで効果を検証**して次の原因を追う。

### LL-105: 要約スタックの最深部は Copilot 認証失効 (IDE token expired) — `s:` KV キー 0 件で確定
- **事象**: LL-102 (merge 窓) / LL-104 (all-or-nothing 書き込み) を修正・デプロイしても realSummaryJa は +2〜3/cron しか増えず、backlog (~370〜628) が drain しなかった。collector の再デプロイで data 凍結 (06:00Z 固着) は解消したが、要約生成は依然スタック。
- **計測 (推測でなく実データ)**: SUMMARY_CACHE KV を `wrangler kv key list --prefix s:` で直接数えると **per-URL `s:` キーが 0 件** (legacy `cache.v1` blob のみ 1 件)。既存 1273 件の実要約は **すべて legacy blob 由来**で、summarizer の新規 per-URL 書き込みが **1 件も成功していない**。`wrangler tail` でライブ捕捉した 09:00Z batch の 13 job は全滅し、決定的なエラーが出ていた: **`Error: copilot 401: IDE token expired: unauthorized: token expired`** + 多数の 200-empty (`primary output was incomplete` → recovery も空 → `field repair ... missing ALL fields` → `incomplete summary`)。
- **根本原因**: `worker-summarizer` の Copilot **認証層**が失効。`resolveCopilotToken` の **token 交換は成功** (`token exchange` エラーは 0) するのに、`callCopilot` の chat 呼び出しで IDE token が `401 expired` 扱い。`s:` キー 0 = 全 job が auth で失敗 = どれだけ merge 窓や書き込み条件を直しても**そもそも生成물が KV に入らない**。LL-102/104 は正しい修正だが、その下にもう 1 層 (認証) のボトルネックが隠れていた。加えて `TOKEN_REFRESH_SKEW_MS=60s < 単一 callCopilot timeout 180s` という構造バグがあり、freshness check を通った token が**長い LLM 呼び出しの最中に失効**して 401 になりうる (1 job が最大 3 回 × 180/90/60s の呼び出しを 1 token で実行していた)。200-empty の多くも borderline-expired token に対する endpoint の挙動と見られる。
- **対策 (コード, 部分)**: (1) `TOKEN_REFRESH_SKEW_MS` を 60s → **240s** に拡大 (最長 timeout 180s を上回らせ、呼び出し中失効を防ぐ)。(2) `resolveCopilotToken(pat, forceRefresh)` を追加。(3) `callCopilot` を **token でなく pat を受け取り内部で resolve** する形に変え、**401 を受けたら cache を捨てて強制再交換し 1 回リトライ**。これで「mid-batch でトークンが失効」ケースは self-heal する。回帰テスト (401 → 強制再交換 → リトライ成功で put 1 回・retry 0) を追加。typecheck + 194 unit PASS。
- **対策 (運用, 本命)**: 上記コードは**トークンが再交換で復活する場合のみ**有効。`s:` キー 0 = 全 batch の先頭 job から失敗 = **systematic 失敗**なので、最有力原因は **`COPILOT_PAT` secret 自体の期限切れ/劣化** (GitHub が劣化 PAT に対し既に失効した IDE token を mint している)。これは秘密情報のローテーションで、エージェントは扱えない → **ユーザーが `cd worker-summarizer && npx wrangler secret put COPILOT_PAT` で有効な Copilot PAT を再設定**する必要がある。コード修正だけで realSummaryJa の増加が確認できなければ、PAT 再設定が必須。デプロイ後は `wrangler kv key list --prefix s:` が増えること・`/health` の recentIssue が消えること・realSummaryJa が cron 毎に増えることを**実測検証**してから「解消」と報告する (LL-104 の教訓: 推測で fixed と言わない)。
- **教訓**: 非同期 enrichment が「スタック」して見えるとき、ボトルネックは**層になって**いる: 表示ゲート (LL-101) → merge 窓 (LL-102) → 書き込み条件 (LL-104) → **認証 (LL-105)**。1 層直すたびに**実データ (ここでは `s:` キー数と `wrangler tail` の生エラー) で次の層を確認**する。「生成済みだが反映されない」と「そもそも生成されない」は KV を直接読めば一発で分かる。`s:` キー 0 件は「生成が 0」の動かぬ証拠で、その上流 (auth) を tail で見れば `401 token expired` に行き着く。認証失効はコードで完全には直せない (secret はユーザー資産) ので、(a) コードは token 失効に self-heal する防御 (401 リトライ + skew>timeout) を持たせ、(b) systematic 失敗時は secret 再設定をユーザーに明示する、の二段構えにする。token cache の freshness skew は**最長の単一呼び出し timeout より必ず大きく**する (skew < timeout は「check を通った token が呼び出し中に失効」する静かなバグ)。

### LL-106: 要約スタックの真因は「推論モデル × 長文本文要求」で API が choices:[] を返すこと（トークン/ヘッダは無実）
- **事象**: LL-101/102/104/105 とトークン再設定まで行っても summarizer は `s:` キーを1件も書けず（0件）、`incomplete summary` が継続。
- **誤った仮説の連鎖（教訓）**: (a)「PAT 劣化」誤り（交換は 200 成功）。(b)「copilot-integration-id ヘッダ不足」誤り（有無どちらも chat 成功）。(c)「古い ghu_ 失効」も無関係（交換成功）。実証なしに3回断定しユーザーに訂正された。
- **決定的切り分け（実 API 再現）**: `.env.local` の COPILOT_PAT（`ghu_`）で worker と同じ流れを node で再現。短いプロンプト（要約3項目, max_tokens=2000）→ 200 + 正常 JSON（finish_reason=stop）。長い本文要求（bodyJa 700-1100字 + bodyEn 500-800語）→ 200 だが `{"choices":[]}`（空）。completion_tokens が max_tokens と完全一致 + `reasoning_opaque` あり。
- **根本原因**: `claude-sonnet-4.6` は推論モデルで、応答前の reasoning トークンが max_tokens を消費する。長いバイリンガル本文を要求すると reasoning + 出力が超過し、message に到達せず `choices:[]` を返す → content 空 → `incomplete summary` → KV 書き込み0。**生成失敗でトークン認証ではない**。既存1273件は旧 inline collector(cache.v1 blob)由来で、分離後 summarizer は一度も成功していなかった。
- **対策**: `buildSummaryPrompt`（title+summaryJa+summaryEn のみ、本文なし）を追加。processJob を「1回 + 不足なら1回 retry、isSummaryComplete で保存」に簡素化（3段チェーン廃止）。本文は collector が deterministic 補完(R-012)。デッドコード削除、テスト書き換え、194 unit PASS。
- **教訓**: (1) 推論モデルは max_tokens を reasoning で消費する。出力契約を短く保ち、長文と要約を別呼び出しに分ける。`completion_tokens==max_tokens` かつ `choices:[]` は reasoning 枯渇の固有シグネチャ。(2) 推論で根本原因を断定しない（Hook 4）。実トークンで実 API を再現して初めて真因に到達。HTTP 200 でも choices 空なら usage/finish_reason/reasoning_* を見る。(3) 多層症状は各層を実データで潰し次の層を実測する。(4) トークン種別: ghu_=user-to-server(~8h失効/refresh token必要), gho_=OAuth App(Copilot交換404のことあり), ghp_=classic PAT。

### LL-108: 「s: キー 0 件」は wrangler の local vs remote の罠 (--remote 必須)。summarizer は最初から正常だった
- **事象**: 引き継ぎでは「summarizer が per-URL KV キー (s:) を 1 件も書けていない (0 件)」が最大ブロッカーとされ、LL-101〜106・トークン再設定まで投じられた。だが実際は remote KV に **2879 件の s: キー**が存在し、summarizer は正常に要約を書き続けていた (確認した AWS Bedrock エントリの cachedAt は調査中の /run 直後=12 分前)。
- **根本原因**: `wrangler kv key list/get/put` は **デフォルトで LOCAL (miniflare) の KV を見る**。`--remote` を付けないと、デプロイ済み Worker が書く本番 remote KV ではなく、空のローカル KV を読む。引き継ぎ・前セッションの `wrangler kv key list --namespace-id=... --prefix s: | grep -c name` は `--remote` 無しで実行され、ローカルの 0 件を「summarizer が書けていない」と誤認していた。`put` 時に wrangler が "Use --remote if you want to access the remote instance." と警告して発覚。
- **対策**: KV 診断は必ず `--remote` を付ける。`wrangler kv key list --remote --namespace-id=6d67debb... --prefix s: | grep -c name` で 2879 件を確認。issue marker も remote では 404 (失敗記録なし=正常)。これで「summarizer が壊れている」前提が崩れ、真の問題 (LL-107: 完了判定のミスマッチ) に到達した。
- **教訓**: (1) **wrangler の KV/D1/R2 コマンドは `--remote` 必須**。付けないと本番ではなくローカル emulation を見る。「0 件/空/存在しない」を本番の事実と扱う前に測定方法を疑う (Hook 5 不在断定ゲート: 「0 件」断定の前に検証手段の正しさを確認)。(2) 引き継ぎの前提 (「X が壊れている」) を鵜呑みにせず、まず実 remote 状態を再測定する。前提が測定アーティファクトのことがある。(3) 「失敗もしないが成功もしない」(outcome ok・logs 空・例外なし・KV 書き込みなし) の矛盾は、見ている KV が書き込み先と違う (local vs remote、別 namespace) を強く示唆する。

### LL-107: 要約バックログが drain しない真因は「本文必須の完了判定 vs 要約のみ生成」のミスマッチ
- **事象**: LL-106 で summarizer を要約のみ生成に変えた後も summaryQueueBacklog が 628 (38%) に張り付き、収集済み記事の多く (348 件で日本語要約が fallback) が決定的 fallback のまま。remote KV には 2879 件の実要約 (s: キー) が存在し、summarizer は正常稼働していた (LL-108)。
- **根本原因**: collector (harness) の完了判定 `needsGeneratedContent` と enqueue 適格判定 `hasRealCacheEntry` (worker/src/summary-queue.ts) が **bodyJa/bodyEn の存在を必須**にしていた。LL-104/LL-106 で summarizer は要約のみ (titleJa+summaryJa+summaryEn、body は空) を書くよう変えたのに、完了判定側は旧来の「本文も必須」のまま。結果、要約が完成済みのエントリ (280 件) も「未完了」と判定され続け、毎時 enqueue/KV-lookup の枠を浪費。真に未要約の 333 件 (cline の per-commit release tag や新規 AWS/GCP evergreen) が枠を奪い合い、永久に drain しなかった。本文は R-012/R-013 で deterministic 補完される設計 (LL-106 で確定) なので、本文を「生成完了」の条件にするのは矛盾。
- **対策**: `needsGeneratedContent` を「実 summary (summaryJa+summaryEn が非空・非 fallback) を欠くか」だけで判定するよう変更 (body チェックを削除)。`hasRealCacheEntry` も summarizer の `isSummaryComplete` と同じ契約 (titleJa+summaryJa+summaryEn、model≠deterministic-fallback) に揃え、body 要求を削除。実データで pool が 628→348 に縮小 (280 件の summary 完了エントリを解放) を確認。unit 196 PASS / typecheck PASS。harness Worker の再デプロイで反映 (R-008/LL-073)。デプロイ後は remote の summaryQueueBacklog が 348 付近へ下がり、以降 drain することを実測確認する。
- **教訓**: 非同期 enrichment の「生成」側を変えたら、「完了判定」側も同じ契約に揃える (生成=要約のみなら、完了=要約のみ)。生成器と判定器で必須フィールドがずれると、生成完了済みのアイテムが永久に未完了扱いになり backlog が drain しない (LL-104 の「生成と判定の非対称」族)。完了判定を変えるときは実データで pool サイズの before/after を測る。

### LL-109: Copilot device-flow の ghu_ は長命でトークン自動更新は不要だった（「8h 失効」は誤前提）
- **事象**: ユーザーが「COPILOT_PAT (ghu_) は ~8h で失効する」前提で、トークンの定期自動更新（当初 launchd、その後「Mac 常時起動でないのでクラウド側で自走」）を要望し、PR #107 で launchd ツールまで作成した。
- **検証（推測でなく実機）**: device flow probe を実行（client_id=`Iv1.b507a08c87ecfe98`、editor Copilot GitHub App）。結果: access_token は `ghu_`(40 char)、**`expires_in` フィールドが無い（= 長命/無期限）**、**refresh_token は発行されない**、Copilot 交換は 200。加えて summarizer は 2026-06-19〜23 の 4 日間連続で s: キー（実要約）を書き続けており、トークンが失効していない実証もあった。
- **根本原因**: GitHub App の user-to-server token は「Expire user authorization tokens」設定が **有効な時だけ** ~8h で失効し refresh_token を伴う。editor Copilot app はこの設定が無効 → ghu_ は**長命（失効しない）**ので refresh_token も発行されない。短命なのは Copilot 交換で得る **IDE token (`/copilot_internal/v2/token`, ~30min)** のみで、これは worker が毎回交換して自動更新済み（resolveCopilotToken）。LL-105 の "IDE token expired" 401 はこの IDE token の話で、ghu_(COPILOT_PAT) の失効ではなかった。両者を混同していた。
- **対策**: トークン自動更新インフラ（launchd / cloud refresh）は **作らない・不要**。COPILOT_PAT は長命 ghu_ のまま運用（手当て不要）。PR #107（launchd ツール）は close する。device-flow token の寿命は **`expires_in` の有無で判定**する（無ければ長命）。クラウド refresh は「refresh_token あり + client_secret 無し更新可」が前提だが、そもそも refresh_token が出ない＝その前提が崩れる＝不要。
- **教訓**: 「トークンが失効する」という前提こそ実機検証する（LL-106 と同型の「推測で作らない」）。`ghu_=~8h失効` は GitHub App の token-expiration 設定依存で普遍ではない。`expires_in` の有無が判定基準。短命な IDE token と長命な ghu_ を分けて考える。要望の背景前提（「失効するから更新が要る」）が誤っていれば、求められた実装より「不要」が正解になりうる。4 日連続稼働の実績が長命トークンの動かぬ証拠だった。実装を作る前に数分の検証 probe を回す価値は大きい（PR #107 の launchd 実装は前提誤りで無駄になった）。

### LL-110: 増分 stats の totals も clamp する（allTime が live 件数を下回り CI red）
- **事象**: `data-schema.test.ts` の `stats.totals.allTime >= entries.length` が失敗。origin/main の最新データで `allTime=1312 < entries=1662`（allTime が約 350 件**過少**）。`last30d=3047` とも整合せず（allTime < last30d は論理矛盾）。毎時の harness データ commit でこのテストが落ち続け **main CI が red** になっていた。LL-109 の doc push もこのテストでブロックされて発覚。
- **根本原因**: worker の `buildIncrementalStats` が totals を増分式 `existing - removed + added` で維持している（LL-036 の差分 stats）。LL-085 で `bySource.last30d` は clamp 済みだったが、**`totals` (allTime/last30d/last7d/last24h) は clamp していなかった**。多数 run の累積誤差で `allTime` が drift し、論理下限（live 件数・last30d）を下回った。`allTime` は「全期間累計（live ⊆ allTime）」なので live 件数を下回るのは不変条件違反。
- **対策**: `buildIncrementalStats` に `liveCount` (finalEntries.length) を渡し、totals を論理不変条件で clamp: `last7d=max(raw,last24h)`, `last30d=max(raw,last7d)`, `allTime=max(raw,last30d,liveCount)`。LL-085 と同じ「生成器側で clamp」方針。`tests/worker-stats.test.ts` で clamp を検証し、worker 再デプロイ + `/run` で main の stats.json を再生成して `allTime>=entries` を実測確認する。
- **教訓**: 増分集計のカウンタは**全て** drift する前提で、生成時に論理不変条件（A>=B>=C, X>=下限）を clamp で強制する。LL-085 は `bySource` だけ直して `totals` を見落としていた（同じ不具合族の取りこぼし — 不変条件の clamp は**全カウンタに**適用する）。data artifact の不変条件は test（検知）だけでなく生成器（予防）にも入れる（LL-027/085 と同型）。

### LL-111: GitHub API fetch に timeout が無く、publish 中の hang が "stuck pre-publish" を生む
- **事象**: Worker Health workflow が断続的に fail。harness `/health` が 503 / `cron appears stuck after pre-publish heartbeat (104m old)` を返す。data commit に数時間の空き（例: 08:00→12:00 UTC で 09/10/11 が欠落）。次の正常 cron で自然回復するため恒久原因が見えにくかった。
- **根本原因**: `worker/src/index.ts` の GitHub API helper (`ghGetFile` / `ghGetFileRaw` / `ghJson` → `ghCommitFiles`) と `resolveCopilotToken` が **bare `fetch`（timeout 無し）**だった。publish フェーズ（archive 読み込み + Git Data API commit）中に GitHub が hang すると `fetch` が無限待機し、Cloudflare が invocation を **catch 不能なまま wall-time で kill** する。`scheduled()` の `catch` が走らないので `writeFailureHeartbeat` が呼ばれず、直前の "pre-publish" heartbeat が更新されないまま 30 分（`HEALTH_PREPUBLISH_STUCK_MS`）を超えて "stuck" と判定される。collector（rss/anthropic）は 8s timeout を持っていて collection 側は保護済みだったが、**後から足した GitHub helper だけ timeout が抜けていた**（横展開漏れ）。pre-publish heartbeat はコレクション後・publish 前に書かれるので、stuck の名指しどおり stall は publish フェーズで起きていた。
- **対策**: `fetchWithTimeout`（AbortController で hang を throw に変換）と `ghFetch`（timeout + 429/5xx・no-response の retry 2 回 + backoff）を追加し、`ghGetFile`/`ghGetFileRaw`/`ghJson` を `ghFetch` 経由、`resolveCopilotToken` を `fetchWithTimeout` 経由にした。これで (a) hang は 15s で throw → `scheduled` catch → error heartbeat → 次 cron が clean に retry（多時間 stuck が消える）、(b) 一過性の GitHub blip は **cron 内 retry で回復** → error heartbeat すら出さず health が flapping しない。Git Data API の retry は冪等（blob/tree は content-addressed、orphan commit は GC、ref PATCH は同 sha で no-op）なので安全。`evaluateHarnessHealth` は変更不要（一過性は retry で吸収、恒久障害のみ error）。`tests/worker-github-fetch.test.ts` に retry/timeout の単体テストを追加。Worker は Git Integration 非対象（LL-073）なので明示承認のうえ再デプロイして実反映する。
- **教訓**: 外部 API の bare `fetch` は「失敗」より「hang」が怖い。hang は Cloudflare の wall-time kill を誘発し、**catch されない = error heartbeat も残らない**ので、監視上は "stuck" や原因不明の stale として現れる。全ての外部 `fetch` に AbortController timeout を必須化し、I/O 待ちを bounded にする。同種の helper が複数（collector は timeout 有り、GitHub helper は無し）あるときは、**低レベル fetch helper を追加・変更したら timeout の有無を横展開チェック**する。timeout で throw に変換すれば、既存の `catch` → failure heartbeat → 自動 retry の仕組みがそのまま効く。flapping を「health 判定を緩める」で隠さず、retry で**根本（一過性失敗）を吸収**してから、恒久障害だけ alert する設計にする。

### LL-112: CI サイズ超過と「AI 要約が出ない」体感は同じ filler body が根源 — summary-first で両方解消
- **事象**: ユーザーから「GitHub Actions がずっと Failed」「記事の AI 要約が一向に出てこない」と 2 つの不満。調査すると (a) CI の `unit` job が `data artifact サイズ予算`(`tests/data-schema.test.ts`)で `data/index.json` = 8.12MB > 8MB により毎時 Worker push のたび red、(b) 要約自体は**実は 100% 本物**(全 1726 件で `summaryJa` pending 0 件、本番 `/metrics.json` も `fallbackPercent:0`/`summaryQueueBacklog:0`)だった。LL-101〜108 の修正は成功していた。
- **根本原因**: 両問題の根源は同一の**決定論的 filler body**。LL-106 で要約のみ生成に切替えた後も、collector の `applyDeterministicContentFallback` が空 body を filler (`...は ... 領域の更新です` / `completed from the existing summary and collection metadata`) で埋め続けていた。この filler が: (1) index.json の **43%(1.67MB)** を占めサイズ予算を超過、(2) 記事詳細で実要約の下に「**※ 本文は近日中に AI が生成して差し替わります**」と表示し続ける(本文 AI 生成は廃止済みなので**永遠に果たされない約束**)、(3) `isDeterministicFallbackEntry` が body needle を見ていたため**実要約を持つ 746 件(43%、最近の記事はほぼ全部)を非 publishable 化**し Featured/Top/feed から除外していた。ユーザーは「カードに要約は出るが、記事を開くと永遠に生成中」「最新が目立つ枠に出ない」を「AI が動いてない」と認識していた。LL-107 で worker 側の判定 (`needsGeneratedContent`/`hasRealCacheEntry`) は要約のみに直したが、**web の `isDeterministicFallbackEntry` と collector の body 生成、記事詳細の本文約束が body 前提のまま残っていた**(横展開漏れ)。
- **対策 (summary-first / ユーザー承認のうえ採用)**: (1) **collector**: `applyDeterministicContentFallback` の body filler 生成を停止 (`buildFallbackBody` 削除、body は空のまま)。(2) **web 分類**: `isDeterministicFallbackEntry` から body needle を除去し**要約のみ**で判定 → 実要約エントリが publishable に。本文表示専用に `hasRealBodyContent` を新設 (実 body のみ true、空/filler は false)。(3) **記事詳細**: 偽の「近日中に生成」を廃止。実 body があれば従来どおり prose 表示、無ければ要約を主役にし「AI 要約ダイジェスト + 元記事で全文を読む」リンクを出す。(4) **data 一次修復**: `scripts/strip-filler-body.mjs` (`npm run body:strip-filler`) で既存 index の filler body 746 件を空化 (8.12→6.44MB)。実 AI body 980 件は保持。(5) **metrics**: 全件 publishable 化で `liveEntries` が archive 由来 `allTimeEntries` を超え `allTimeEntries>=liveEntries` (LL-110) を破ったため `allTimeEntries=max(archive, live)` に clamp。(6) **KnowledgeCard**: 全件 publishable で evergreen カードが増え、`min-height` 由来の高さばらつき(tags 有無・タイトル行数)が露呈 → `height:152px` 固定 + title/sum 2 行 min-height で uniform 化 (LL-096 の意図を fixed-height で担保)。(7) **tests**: data-schema の body 必須ゲートを「filler body が残っていない」ゲートに、worker-content-fallback/web-data/e2e を summary-first に更新。R-012/R-013 を「要約必須・本文任意」に改訂。
- **教訓**: (1) ユーザーの「AI 要約が出ない」は要約の有無ではなく、**記事詳細の偽の生成予告**と**目立つ枠からの除外**が体感の正体だった。「データ上は要約 100%」と「ユーザー体感」を分けて、実際に詳細ページを開いて確認する (LL-074 系)。(2) 設計変更 (LL-106: 要約のみ生成) をしたら、その前提に依存する**全箇所**(生成・分類・UI 文言・テスト・ルール)を端から端まで横展開で揃える。1 箇所 (worker 判定) だけ直すと、別箇所 (web 分類・UI 約束・collector 生成) が古い前提のまま残り「対策したのに体感が変わらない」になる (LL-076→102, LL-104→107 と同型の非対称バグ)。(3) **果たせない約束を UI に出さない** (agentic §4.7): 「近日中に生成」のような未来の約束は、その機能を廃止したら即座に撤去する。fallback は安全網であって完了状態ではない。(4) 自動生成物の不変条件 (`allTime>=live`, カード uniform 高さ) は、母集団 (publishable 件数) が変わると露呈する。分類ロジックを変えたら依存する不変条件を再検証する。(5) e2e job は `needs: unit` なので unit が red の間は e2e が走らず、**latent な e2e 失敗 (Knowledge 高さ) が隠れる**。CI を緑に戻すと隠れていた失敗が出るので、unit 修復と同時に e2e 全体を回す。

### LL-113: スクロールリビールは 1 要素に 1 機構だけ — IntersectionObserver と scroll-driven animation を二重がけしない
- **事象**: ユーザーから「PC でスクロールしたとき記事パネルの表示が遅い。パネルの半分以上の余白が出ないと表示されない」と指摘。Timeline の記事カードが、ビューポートに入ってもすぐにフェードインせず、かなりスクロールが進むまで薄いままだった。
- **根本原因**: 同一の記事カード `<article class="card" data-reveal="card">` に **2 系統のリビール機構が同時適用**されていた。(a) `Portal.astro` の `[data-reveal]` IntersectionObserver (`opacity:0`→`.is-visible`、`rootMargin:"0px 0px -10% 0px", threshold:0.08` で**フォールド上端から10%上がるまで発火しない**)、(b) `portal.css` の `.timeline-section .card` scroll-driven animation (`animation-range: entry 0% entry 42%`、`@keyframes card-scroll-reveal` で opacity 0.72→base)。Chrome/Edge (PC) は scroll-driven をネイティブ対応するため両方走り、CSS animation が base style を override する仕様上、**scroll-driven の opacity がカードを支配し、カードが 42% スクロールインするまで不透明化が完了しない**。これが「半分以上余白が出ないと出ない」体感の主因。Firefox は scroll-driven 非対応で IntersectionObserver だけ効くので、ブラウザ間で挙動も食い違っていた。
- **対策**: scroll-driven 機構を撤去し **IntersectionObserver の one-shot リビールに一本化**。(1) `portal.css`: `@supports (animation-timeline: view())` 内の `.timeline-section .card` ブロックと `@keyframes card-scroll-reveal` を削除、reduced-motion の `animation:none` リストから `.timeline-section .card` を除去。(2) `Portal.astro`: observer を `{ rootMargin:"0px 0px 12% 0px", threshold:0 }` に変更し**カード上端がフォールドに入る手前 (12%リード) で即発火**。(3) `.is-visible` トランジションを `0.56s`→`0.4s`、stagger を `35ms`→`22ms` にしてキビキビ化。modern-web-guidance の `scroll-entry-exit-effects` ガイド (R-014) は「native 対応では scroll-driven、非対応では IntersectionObserver フォールバック、**両方を同一要素で走らせない**」とするが、今回ユーザーが求めるのは「スクロールしたら即出る」one-shot なので、全ブラウザ対応の IntersectionObserver に寄せる判断が正当。Playwright 実測で、カード上端がフォールド下 36px (まだ非表示) の時点で既にリビール開始 (opacity 0.13)、上端が視界に入った直後に opacity 1.00 を確認。`[data-reveal]` の `opacity:0` base は `html.motion-ready` (JS 付与) スコープなので JS 無効/reduced-motion 時は常時表示で安全。
- **教訓**: スクロールリビールは **1 要素 1 機構**を厳守する。IntersectionObserver (JS、全ブラウザ、one-shot 向き) と scroll-driven animation (CSS、Chromium 系のみ Baseline、連続スクロール連動向き) を**同じ要素に二重がけしない** — CSS animation が base/JS スタイルを override し、ブラウザ間で挙動が割れ、発火タイミングが遅く感じる。「スクロールしたら即表示」が要件なら IntersectionObserver、「スクロール量に連動して変化」が要件なら scroll-driven を選び、**どちらか一方**にする。one-shot リビールの「遅い」は (a) observer の `rootMargin` を負値 (フォールドより内側で発火) にしている、(b) 競合する scroll-driven animation が居る、の 2 つを疑う。発火を早めるには `rootMargin` の下端を**正値** (`0px 0px 12% 0px` = フォールド手前で先読み発火) にする。UI モーション修正は印象でなく Playwright で「要素上端のフォールド相対位置 vs opacity/is-visible」を実測して回帰を防ぐ (R-021)。

### LL-114: ページ別の max-width ハードコードはレイアウト drift を生む — 基底から継承して単一情報源にする
- **事象**: ユーザーから「記事ページ (`/e/[id]`) と Dashboard ページ (`/`) でサイドバーと中央パネルの幅が違う。記事ページの方が中央パネルが広くて良いので合わせてほしい」と指摘。実測すると Dashboard はワイド画面でキャンバス全体が中央寄せで両側に大きな余白が出て「狭く」見えていた。
- **根本原因**: 両ページとも同じ `.layout` (sidebar + main grid, `max-width:1440px`) を使うのに、Dashboard だけ `.home-layout` で `max-width:1180px` を**ページ別にハードコード上書き**していた。記事ページは `.layout` の 1440px を使うのでワイド画面いっぱいに広がり sidebar が左寄せ。Dashboard は 1180px で中央寄せのため、同じ sidebar 幅・同じ grid なのに「中央パネルが狭い」体感になっていた。ユーザーの「記事ページの方が中央パネルが広い」は視覚的には正しいが、技術的には Dashboard の main **カラム**自体はむしろ広かった (right rail が無いため)。真因は「キャンバス全体の max-width 上限」がページ別にずれていたこと。
- **対策**: `.home-layout` から `max-width:1180px` を**削除**し、基底 `.layout` の 1440px を継承させた (`grid-template-columns: 232px minmax(0,1fr)` は維持し right rail 無しの 2 カラムは保つ)。1440 を再ハードコードせず「継承」にしたのは、将来 `.layout` の canvas 幅を変えたとき両ページが自動追従し、**単一情報源**になるため。Playwright で 1512/1440/1280/1100/760px を実測し、両ページが同一キャンバス幅・同一 sidebar 左位置・横スクロール無し・モバイル単一カラム化を確認。
- **教訓**: 同じレイアウト基底を共有するページで「幅が違う」と言われたら、ページ別の `max-width` / `width` ハードコード上書きを疑う。差分を修正するときは**別の固定値を再ハードコードせず基底から継承**させ、単一情報源にする (LL-022/032/083 の「単一情報源」原則と同型)。レイアウト幅の体感差は印象でなく Playwright で複数 viewport の canvas/sidebar/main の bounding box を実測して切り分ける (R-021)。「中央パネルが狭い」の正体が main カラム幅ではなくキャンバス全体の中央寄せだった、のように体感と実測がずれることがある。

### LL-115: 記事全文(本文)の AI 生成は index ではなく別ファイル化 + クラウド常時生成 (body-file architecture)
- **事象**: LL-112 で本文を summary-first 化し「本文は近日中に生成」の偽予告を撤去したが、ユーザーは「記事が要約されない (= 全文の AI 本文が出ない) のは不満。クラウドで常時生成してほしい」と要望。LL-106 で本文 AI 生成を廃止したのは「Cloudflare Worker の 30 秒制限に長文が収まらない」と理解していたが、これは**不正確**だった。
- **根本原因 (実 API で再検証)**: (1) LL-106 の真因は CPU/wall-time 制限ではなく、**`claude-sonnet-4.6` が日本語長文を要求されると推論ループに入りトークン予算を全消費して空 (`choices:[]`) を返す**ことだった (実測: 日英まとめて 1 回要求 → 空。英語のみ → 4218字 OK)。`claude-opus-4.8` は日英とも長文を生成できる (JA 984字/23s, EN 4705字/28s, reasoning=max でも 924字/29s で finish=stop)。(2) Cloudflare Worker のコストは **CPU 時間のみ**で、`await fetch(LLM)` の応答待ち (20-29s) は I/O であり **CPU 時間に算入されない = 課金・30s 制限に当たらない** (LL-037/038 の Queue が実証済み)。つまり「処理時間が長い ≠ Cloudflare コスト増」。トークン消費は Copilot サブスク内。(3) よって長文本文のクラウド常時生成は技術的に可能。ただし全 ~1740 件にフル本文 (1記事 2-4KB) を index.json に戻すと再び 8MB 予算超過 (LL-112 の逆戻り) になるため、**本文は index と分離して別ファイル化**が必須。
- **対策 (Phase A: 別ファイル化基盤・本 LL)**: (1) `data/bodies.json` (`{ generatedAt, count, bodies: { [id]: {bodyJa, bodyEn, model, generatedAt} } }`) を本文の単一情報源に新設。`scripts/migrate-bodies-to-file.mjs` (`npm run body:migrate`) で既存 index の実本文 979 件を移行し index から strip (index 6.46MB→3.14MB、bodies.json 3.46MB)。(2) web は `web/src/lib/bodies.ts` の `bodyForEntry(id)` で本文を読む。記事詳細 `e/[id].astro` は本文があれば prose、無ければ summary-first ダイジェスト + 原文リンク。`data.ts` から `hasRealBodyContent` を撤去 (本文は entry でなく bodies.json 由来に)。(3) collector は publish 時に index entry の `bodyJa`/`bodyEn` を必ず空にする (stale `s:` cache の旧 body 混入で index 再肥大化を防ぐ, LL-073 family)。`entriesEqual` 比較も body-free な `indexEntries` 基準に。(4) `tests/data-schema.test.ts` を「index は本文を持たない」+「bodies.json スキーマ/filler 無し/10MB 上限」ゲートに更新、`tests/web-bodies.test.ts` 新設。R-012/R-013 を body-file architecture に改訂。
- **対策 (Phase B: クラウド生成・別 PR)**: 新 KV `BODY_CACHE` + 新 queue `tech-dashboard-body` + 新 consumer worker `worker-body` (opus-4.8 reasoning=max、JA/EN を 2 回に分けて呼ぶ — 日英まとめは推論ループ再発リスク)。collector が本文未生成エントリを enqueue し、`b:` KV を bodies.json に merge。安定稼働中の summarizer (LL-108) は触らない。KV write 1000/日 (LL-043) を独立 namespace で確保、backfill は ~1-2 日で drain。
- **教訓**: (1) 「できない」と諦めた設計判断 (LL-106: 本文 AI 生成廃止) は、その**根拠を実 API で再検証**する。真因は「Worker の時間制限」ではなく「推論モデルが日本語長文で空を返す」+「モデル選択」だった。推論で根拠を断定せず実測する (Hook 4)。(2) **Cloudflare Worker のコスト軸を正しく理解する**: 課金・制限は CPU 時間であり、LLM/外部 API の応答待ち (I/O) は算入されない。「処理に時間がかかる = コスト増/制限超過」は誤り。重い JSON parse/集計のような実 CPU だけが 30s 制限に当たる (LL-037)。(3) 自動生成物 (本文) を足すときは**サイズ予算 (LL-112)** を最初に設計する。index に戻すと CI 再 red なので、index と分離した別ファイル + capped storage にする。(4) 大規模機能は CI 安全な単位で**フェーズ分割** (Phase A=基盤・無害、Phase B=生成) し、PR ごとにレビュー・ロールバック可能にする (agentic §1.2/1.3)。

### LL-116: 非同期 enrichment の「生成」と「反映 (merge)」は同一選択で対称化する (本文が生成されるのに反映されない)
- **事象**: body-file Phase B (LL-115) デプロイ後、worker-body は opus-4.8 で本文を生成し `b:` KV に 40 件書けていた (生成は稼働) のに、`data/bodies.json` は 926 件すべて `legacy-import` のまま = **新 opus 本文が 0 件 merge** されていなかった。`wrangler tail` で 22:00 cron は `body pipeline: enqueue=20, merged=0` を確認。
- **根本原因**: collector の `runBodyPipeline` で **enqueue と merge-lookup が別々の選択窓**を使っていた。enqueue は `selectBodyJobBatch` (recent 優先 + round-robin)、merge-lookup は `roundRobinStart` 由来の純 round-robin 窓。両者は同じ `needing` 集合上の**異なる選択**なので、enqueue→生成された entry を merge 窓が読みに行かず、生成済み本文が `b:` KV に滞留して bodies.json に入らない。LL-102 (要約の enqueue 窓と merge 窓の非対称) と完全に同型の再発。「生成 (enqueue→worker)」と「反映 (merge-lookup)」は別 throughput で、片方だけ速くても net-zero になる。
- **対策**: merge と enqueue で **`selectBodyJobBatch` の単一選択を共有**する。各 cron で recent+RR の選択を 1 回作り、その URL 群の `b:` KV を読んで hit を bodies.json に merge、miss を enqueue する。これで「最新 entry は毎 cron 必ず lookup される」→ worker が生成した次の cron で必ず merge される。`tests/worker-body-pipeline.test.ts` に selectBodyJobBatch の決定性 (同入力・同 nowMs で同一選択) テストを追加。collector 再デプロイで反映 (R-008/LL-073)。
- **教訓**: 非同期 enrichment パイプラインで「生成する側 (enqueue)」と「結果を取り込む側 (merge/lookup)」が**別々の選択ロジック**を持つと、生成物が滞留して反映されない (LL-076→102→116 と 3 度目の再発)。**生成対象の選択と反映対象の選択は同一関数・同一引数で対称化する**のが唯一の恒久対策。診断は集約 health 値 (enqueue 数) でなく、「生成済みストック (`b:` KV キー数)」と「反映済みフロー (bodies.json の新 model 件数)」の**差**を実測して気付く (LL-102 と同じ切り分け)。新しい round-robin/選択窓を足すたびに「これと対になる窓は同じ選択か」を必ず確認する。

### LL-117: クラウド enrichment の backlog が遅いときは「同一 worker contract のローカル一括 backfill」で加速する (body-file は additive merge なので安全)
- **事象**: body 生成パイプライン (LL-115/116) は稼働していたが、クラウド cron レート (~20件/cron、KV write 予算 LL-043 に制約) のため 785件の backlog を埋めるのに ~1-2 日かかり、ユーザーが「現在までの記事で本文が出てこない、バックフィルされないのか」と不満。実測で live 1740件中 本文あり 955件 (54.9%)、最新40件は 31件埋まる一方、41-200位の「数日前の記事帯」がほぼ空白 (recent 優先選択が newest を埋め、中間が starve)。
- **根本原因**: クラウド backfill のレートは設計上の安全弁 (cron 毎の enqueue cap・KV write budget・subrequest) に縛られ、大量 backlog の一括処理に向かない。worker-body は ~120/hr 処理できるのに collector の enqueue cap (20/cron) で starve していた。
- **対策**: `scripts/backfill-bodies.mjs` を作り、**worker と完全に同じ contract** でローカル一括生成: prompts は `worker/src/body-generate.ts` (buildBodyPromptJa/En, cleanBodyText)、merge は `worker/src/bodies-file.ts` (mergeBodies), model は claude-opus-4.8 reasoning=max temperature 0.3 (worker-body と同一) を **import して再利用** (重複実装せず drift を防ぐ。tsx で .ts を直接 import 可)。生成は gitignored cache (`data/_body-backfill-cache.json`) に増分保存して中断時 resume 可。concurrency 8 で ~6件/min (JA+EN 各 opus 呼び出し)、783件を ~2.2hr。クラウドの cron/KV/subrequest 制約を一切受けない (ローカル Copilot 呼び出しは KV write budget に無関係)。
- **LL-087 との関係 (なぜ今回は安全か)**: LL-087 は「automated publisher が継続更新する artifact のローカル一括 drain は巻き戻し危険」と警告した。今回が安全なのは **body-file architecture (LL-115) で bodies.json が index.json と分離され、collector も script も `mergeBodies` (additive・非 live のみ prune) で書く**から。commit 直前に `git checkout origin/main -- data/bodies.json` で**最新 main の bodies.json に cache を再 apply** すれば、生成中に cloud が足した本文も保持される (clobber しない)。summary の LL-087 は index.json 全体が巻き戻る構造だったが、body は additive merge なので局所的・冪等。
- **教訓**: クラウド非同期 enrichment の backlog が「正しく動いているが遅すぎてユーザーが不満」のとき、(a) クラウドの cap を上げる (KV/subrequest 予算内) か、(b) **同一 contract のローカル一括 backfill** で加速する、の 2 択。(b) は worker のロジックを**コピーせず import 再利用**して出力の drift を防ぎ、**additive merge + 最新 artifact への再 apply** で automated publisher との race を無害化する。分離された capped storage (bodies.json) は index と違いローカル backfill と相性が良い。「遅い」と「壊れている」は別問題 — まず実測で coverage 分布 (最新/中間/古い) を見てから加速手段を選ぶ。

### LL-122: Timeline の「記事パネルが間延び」は右 rail 不在 — 既存の孤立 CSS を再利用し全 timeline 面に rail を設置
- **事象**: ユーザーから「timeline 画面は右サイドバーが無いので記事パネルが間延びして見える。右側サイドバーを設置しないか」と指摘。実測すると 1440px で home の main カラムが ~1130px まで広がり、記事カードが全幅に伸びて右境界が無く、視線の終端が定まらない「間延び」状態だった。さらに調査で `/page/[n]`・`/t/[tag]`・`/t/[tag]/page/[n]` は `<aside class="right"></aside>` を**空のまま**描画しており (pre-existing の空カラムバグ)、3 カラム grid の右トラックが常に空白だった。
- **根本原因**: (1) 基底 `.layout` は元々 3 カラム (`232px 1fr 280px`) だが、home は `.home-layout` で 2 カラム上書きして右 rail を持たなかった (LL-114 で max-width 上書きは消したが、2 カラム構成と右 rail 不在はそのまま残っていた)。右トラックが無い分 main が広がり間延びした。(2) commit `e5f25f8` で home 用の rail CSS (`.home-right`/`.home-side-metric`/`.home-source-row` 一式) が**実装されたが未配線のまま孤立** (orphaned CSS) していた。(3) deep-dive ページ群は右 aside を置きながら中身を入れ忘れた空カラムだった。要するに「rail を出す CSS は全部あるのに、どの timeline 面でも配線されていなかった」。
- **対策**: 孤立 CSS を**作り直さず再利用**する単一の `web/src/components/TimelineRightRail.astro` を新設 (3 カード: TODAY'S PULSE = `DASHBOARD_METRICS` の 4 metric tile + /status リンク、MOST ACTIVE SOURCES = `entries.slice(0,200)` の上位 5 ソース + All source status リンク、TRENDING TAGS = `trendingTags(10)` の tag cloud)。home (`index.astro`) は `.home-layout`→`.layout` に戻して rail を配線、deep-dive 3 ページの空 aside を同コンポーネントで置換 (paged は `MAIN_TIMELINE_ENTRIES`、tag 系は `all` + `#${tag} insights` ラベル)。dead な `.home-layout` CSS を削除。レスポンシブは既存の `:has(> aside.right:not(:empty))` ルールがそのまま効き、≥1181px=rail 280px / 901-1180px=compact 220px / ≤900px=rail 非表示 2 カラム / ≤760px=1 カラム。lane ページ (`/arxiv`,`/knowledge`) は `.layout` の media query が `:not(.lane-layout)` scope なので不変 (R-023/LL-091)。結果 1440px の main が 1130→824px に constrain され間延び解消。E2E に「home desktop で rail + 3 カード可視・`.home-layout` 0 件」「rail が main を <850px に constrain・3 grid track・横スクロール無し」「mobile で rail hidden」「lane ページに `aside.right` 0 件・`lane-rail` 可視」を追加 (29 tests PASS)。
- **教訓**: (1) 「UI 要素が無い/空に見える」と言われたら、まず**その要素の CSS が既に存在して未配線 (orphaned) でないか**を grep で確認する — 作り直す前に再利用できることが多い (今回 rail CSS は 100% 揃っていて配線だけが欠けていた)。(2) 共有レイアウト基底 (`.layout`) を**ページ別クラスで上書き**すると、その上書きが意図を外れて残りやすい (LL-114 で max-width は消したが 2 カラム化は残存)。基底に寄せて単一情報源にする。(3) 同じ aside を持つ複数ページ (home/paged/tag/tagpaged) は**1 コンポーネントに集約**して配線漏れ・空カラムを一掃する。(4) レイアウト密度の体感問題 (間延び/狭い) は印象でなく複数 viewport の main/rail の bounding box を Playwright で実測して before/after を出す (R-021/LL-114)。空 aside は「描画されているが中身が無い」静かなバグなので、E2E で `:not(:empty)` か中身の存在を assert する。

### LL-123: 生 source id (slug) の表示漏れは「カードだけ」直すと残る — 全 render spot を sweep する
- **事象**: デザイン監査 (impeccable critique) の過程で、UI の多くの場所が source の **生 id (`qiita-mcp`, `zed-releases`, `cline-releases`, `github-changelog` 等)** をそのまま表示しており、`SOURCE_META.displayName` (`Qiita MCP`, `Zed Editor Releases` 等) を経由していなかった。読者には機械的な slug が見え、ブランド感と可読性を損なっていた。
- **根本原因**: source の表示名解決が**単一 helper に集約されておらず**、各コンポーネント/ページが個別に `{entry.source}` を直接描画していた。最初のトリアージで「カード系 4 コンポーネント (EntryCard / CompactRow / TickerBar / DailySummary)」だけを疑ったが、実際の漏れは**もっと広く**、`index.astro` の Top-3 `.rank-source` と Featured、`archive/[month].astro` の top-sources、`e/[id].astro` の関連記事 src・メイン src・pagefind フィルタ値、`CompactRow` の `aria-label`、`DailySummary` の render 行まで、**計 9 箇所**が displayName を素通りしていた。カードの見た目だけ確認すると、page テンプレート・aria-label・検索ファセット (pagefind) の漏れに気付けない。
- **対策**: `web/src/lib/source-meta.ts` に単一情報源の `sourceLabel(id)` helper を新設 (`SOURCE_META_BY_ID` で displayName 解決 → ` tag`/` feed` suffix 除去 → 未登録 id は title-case に fallback し**生 slug を絶対に出さない**)。全 render spot を `sourceLabel()` 経由に統一。検証は `<span>{...source}<` 等の素朴な grep だけでなく、Playwright で**実 DOM のテキスト**を抜いて `/[a-z0-9]+-[a-z0-9]+/` の slug パターンが残っていないかを sweep した (カードの root class が `.card .src-tag` で `.entry-card`/`.ec-source` 等の推測セレクタでは検出できなかった — 実 DOM 確認が効いた)。**生 id を残すべき箇所** (`data-source`/`data-paper-filter`/DOM `id` 等の JS フィルタキー、dedupe キー、内部 fallback テキスト判定) は意図的に変更しない。
- **教訓**: (1) 「表示名 → 生 id の漏れ」のような横断的表示バグは、**全 render spot を sweep** する — カードコンポーネントだけでなく page テンプレート (`index`/`archive`/`e/[id]`)、`aria-label`、検索ファセット (pagefind の `data-pagefind-filter` 値)、meta content まで。「>{...source}<」「テンプレートリテラル」「aria-label」「filter 値」を網羅的に grep し、最後に**実ブラウザ DOM のテキストを抽出して slug パターンが残っていないか機械検査**する (セレクタ推測は外れるので実 DOM で確認)。(2) 表示名解決のような「全画面で一致すべき変換」は**最初から単一 helper** にして、各所が生値を直接描画する設計にしない (LL-103 の CATEGORIES_BY_* 単一ソースと同型)。(3) 生値が**正しい**箇所 (JS キー・dedupe・データ属性) と**表示用**箇所を区別し、表示用だけ helper を通す。

### LL-118: 要約が「途切れて要約になっていない」真因は AI 未通過の生 snippet 機械切り (snippet-masquerade ゲート回避) — モデル問題ではなかった
- **事象**: ユーザーから「AI 要約が毎回途切れている。要約とはいえないレベルのまとめなのでモデルを変えるなり真剣に取り組んでほしい」と強い指摘。live 1740 件中 **909 件**が文の途中でブツ切れの「要約」だった。当初「モデルの長文生成失敗 (LL-106 系)」を疑ったが誤り。
- **根本原因**: 旧 `placeholderSummary()` (normalize.ts) が RSS の生 snippet を **summaryJa=120字 / summaryEn=200字で機械的に切り詰めて**保存し、JA ソースでは `summaryEn = raw.title` (日本語タイトル) を入れていた。これらは**非空・fallback マーカー無し**なので worker の `needsGeneratedContent()` が「要約完成済み」と誤判定 → AI 要約キューに一度も乗らず → 永久に途切れ snippet のまま固定。つまり 909 件は**一度も AI に渡っていない**生 RSS 抜粋で、モデルの生成失敗ではなく**完了判定のゲート回避 (masquerade)** が真因。LL-107 (要約のみ生成への切替) で生成・判定は揃えたが、`placeholderSummary` の「snippet を完成要約として出す」旧挙動が残っていた。
- **対策**: (1) `placeholderSummary` を `snippetContext()` に置換 — 表示用 `summaryJa`/`summaryEn` は**空**にし、生 snippet は新フィールド `contentSnippet` (AI 入力 context 専用・非表示) に温存。空要約は `needsGeneratedContent` が確実に拾う。(2) `summaryEn=title` バグ除去。(3) backfill: 既存 909 件を opus-4.8 (要約のみ・max_tokens 1600・concurrency 8) で再生成 → 完成バイリンガル要約 (JA 平均 104字・終端句点、空 0 件、masquerade 0 件)。(4) prompt は worker `buildSummaryPrompt` が `contentSnippet` を入力に使うよう拡張。
- **教訓**: 「途切れ要約」を見たらモデルを疑う前に**そもそも AI に渡っているか**を確認する。`length===120/200` ちょうど + 終端句読点なし + summaryEn===title は「機械切り snippet が要約のフリ」のシグネチャ。**非空 ≠ 完成** (agentic §4.7) — fallback/placeholder を非空にすると完了判定をすり抜けて永久に enrichment されない。完了判定 (`needsGeneratedContent`) を変えたら placeholder 生成側も「空 or 明示 pending」に揃える (LL-104/107 の生成/判定対称性と同型)。pipeline 修正は worker deploy まで本番の新規 entry に効かない (LL-073) ので、stale worker が再収集で masquerade を再投入しないようデプロイ必須。

### LL-119: monorepo release feed の component タグは branding 漏れで "CLI" だけのタイトルになる
- **事象**: ユーザーから「"CLI" という記事が多く、何の CLI か分からない」と指摘。cline-releases の "CLI v3.0.31" / "sdk/core/v0.0.53" 等が製品名なしで表示されていた。
- **根本原因**: `decorateReleaseTitle()` が純バージョン (`VERSION_ONLY_RE`) のみ branding。monorepo feed は component-prefixed git tag (`CLI v3.0.31` `nightly-main-…`) を出すため対象外で製品名が付かなかった。
- **対策**: `decorateReleaseTitle` を export 化し regex (VERSION_DATE_RE/HAS_VERSION_RE/WORD_VERSION_RE/NIGHTLY_TS_RE) + `brandName()`/`prettyComponentTag()` で component タグも branding ("Cline CLI v3.0.31")。既存 84 件を `npm run titles:backfill` で migration、7 regression test 追加。
- **教訓**: release feed を追加したら版だけでなく component-prefix/nightly tag の命名も確認する。「製品名 + 種別 + 版」を必ず title に残す。

### LL-120: 縮んではいけないロゴ/ticker 見出しは中間幅 (721-960px) で潰れる — 固定 + 中間 breakpoint で防ぐ
- **事象**: ユーザーから「幅を狭めるとサイトロゴが縮む、ticker (主要な更新) の記事タイトルが潰れて何の記事か分からない」と指摘。
- **根本原因**: `.logo` に `flex-shrink:0`/`white-space:nowrap` がなく中間幅で圧縮/折返し。ticker の 2 行フル幅レイアウトが ≤720px のみで、721-960px の「中間 squeeze zone」で見出しが潰れていた。
- **対策**: `.logo`/`.logo-mark` を `flex-shrink:0`、`.logo` に nowrap。TickerBar に `@media (max-width:960px)` 2 行 grid を追加し squeeze zone を被覆。R-021 検証で logo 全幅 168x25px 固定、見出し 768px=523/900px=655px と可読、横スクロール 0。
- **教訓**: ロゴ等「縮めてはいけない要素」は flex-shrink:0 + nowrap を初手で。レスポンシブは 1 幅でなく **breakpoint 前後 (720/768/900/960)** を実測し中間 squeeze zone を塞ぐ (LL-091 と同型)。

### LL-121: ローカル要約 backfill は device-flow で ghu_ を発行する (gho_ は交換不可)
- **事象**: 909 件の opus-4.8 要約 backfill にローカル Copilot 認証が必要だったが `gh auth token` の `gho_` は交換不可 (LL-109 の穴)。
- **対策**: `scripts/copilot-device-login.mjs` (npm run auth:device) で editor Copilot client_id `Iv1.b507a08c87ecfe98` (public) に device flow → `ghu_` を `.env.local` (mode 600・gitignore) に保存。token は非表示、`/copilot_internal/v2/token` で検証。backfill は `tsx --env-file-if-exists=.env.local` で読込。opus-4.8 は `/chat/completions` で実利用可・要約品質良好 (888+20 ok / 0 fail)。要約のみ短契約なので推論枯渇 (LL-106) なし。
- **教訓**: ローカル一括生成の認証は `ghu_` 必須。device flow が ghu_ 取得手段。secret は .env.local 600 + gitignore、画面非表示。一時的 502 は resume cache で再実行 retry。

### LL-124: 本番デプロイ検証は取得手段のアーティファクトを疑う (per-deploy URL と compound curl の落とし穴)
- **事象**: PR #121 (Timeline 右 rail) を main マージ後の本番検証で、右 rail が本番 HTML に無い (16KB・`<aside>` 0 件・"TODAY" のみ) ように見え、レンダリング不具合を疑って調査に時間を浪費した。実際にはレールは正しく本番稼働 (219KB フル HTML に `aside.right home-right`・カード3枚・`home-source-row` 5行) しており、不具合は存在しなかった。
- **根本原因**: 2 つの検証アーティファクトの合わせ技。(a) Cloudflare Pages の per-deploy サブドメイン `https://<deploy-id>.<project>.pages.dev/` は仕様上 `<title>Deployment Not Found</title>` の ~16KB HTML を返す (実デプロイ内容ではない)。内容検証にこの URL を使ったため空に見えた。(b) 1 つの複合 bash コマンド内で同一 URL を `curl` で何度も連鎖 (for ループでマーカーごとに再 fetch 等) すると、大きなページで body が部分取得・切り詰めされ、存在する要素を「無い」と誤判定した。
- **対策**: (1) デプロイ内容の検証は per-deploy サブドメインを使わず、カスタムドメイン (`techdb.studio344.net`, `cf-cache-status: DYNAMIC` で origin 直取得) かメイン pages.dev エイリアスを使う。(2) HTML マーカー確認は 1 回だけ fetch してファイル (`/tmp/live-home.html`) に保存し、そのファイルを繰り返し grep する。1 コマンド内で同一 URL を複数回 curl しない。(3) ビルド成否は CF API の deployment stages (queued/init/clone/build/deploy が全 success) で確認し、HTML の見た目だけで判断しない。完了ゲートは「URL 200」「CF stages success」「カスタムドメインのフル HTML に marker あり」の 3 点を分けて確認する。
- **教訓**: 「本番に要素が無い」と結論する前に取得手段のアーティファクトを疑う (LL-108 の wrangler local vs remote、Hook 5 不在断定ゲートと同型)。大きなページの要素有無は 1-fetch-to-file + grep で確定し、compound curl のパイプ切り詰めや per-deploy URL の "Deployment Not Found" を実バグと誤認しない。

### LL-125: E2E は「先頭カード」を前提にしない。要件状態を持つカードを選んで検証する
- **事象**: `mobile featured panel and thumbnails keep fallback layout` が、先頭の `article.card.has-thumb` に `.summary .s-text` がある前提で落ちた。実データでは先頭 2 件が pending-summary カードでも正常で、テストだけが deterministic に失敗した。
- **根本原因**: レイアウト検証と内容状態検証を同じ要素（先頭カード）に混在させ、`pending` を正常状態として扱っていなかった。加えて Status では「count>0 の error source」に `no data` や inside-threshold 理由を許すと意味論が崩れるが、テストがその不変条件を持っていなかった。
- **対策**: E2E は (1) レイアウト検証は先頭カード等の位置/寸法に限定、(2) summary 幅検証は `.summary .s-text` を持つカードを明示選択、(3) pending カードは `.summary-state` が見え summary text が無いことを正常として明示検証、に分離する。記事詳細の回遊テストも、最初の `/e/` リンクが常に enrich 済みだと仮定せず、**prose / digest / pending の 3 状態を有効状態として分岐検証**する。pending detail 専用の回遊は arbitrary first-link loop をやめ、**ホーム上で実際に `.summary-state` を持つ card を selector で見つけ、その href だけを検証**する。pending card が 0 件なら fully summarized data を valid とする count guard を置く。mobile card 系の summary 幅・pending 状態検証も、**その状態を持つカード数を先に数え、0 件なら fully summarized / no-pending data を valid と扱う**。Status には「count>0 の error row は `no data` / `inside freshness threshold` を表示しない」回帰テストを追加する。
- **教訓**: feed 駆動 UI の E2E は「最初の N 件」や「必ず pending がある」を仕様化しない。まず必要状態を selector で絞ってから assert し、pending/fallback を valid state として個別に検証する。詳細ページでも「先頭リンクは本文/要約済み」を前提にせず、**そのデータ状態ごとの honest UI (prose, summary-only, pending)** を state-specific assertion で確認し、対象 state が 0 件なら count guard で fully summarized data も valid と扱う。意味論の不変条件（Status の error/no-data など）は DOM テキストで明示的にゲート化して再発を防ぐ。

### LL-126: Status の run 判定は hero/footer で単一 helper を共有し、同一ページ矛盾を E2E で検知する
- **事象**: `/status` で hero は `Run ERR` なのに footer が `run ok` を表示し、同一ページ内で run 状態が矛盾した。
- **根本原因**: `status.astro` は `lastRunHours > 6` を err 判定していたが、`Portal.astro` footer は stale run を見ず `copilotOk/sourcesFailed/fallbackPercent` だけで run ラベルを決めていた。判定ロジックが 2 箇所に分散して drift し、text と dot tone の visual state まで揃っていなかった。
- **対策**: `web/src/lib/run-health.ts` に typed helper `deriveWorkerRunStatus()` を追加し、hero/footer の run 判定を共通化。`lastRunAt`・`copilotOk`・`sourcesFailed`・`fallbackPercent`・pending 件数を同一入力で評価し、footer の dot も同じ derived tone を class/data 属性で受けるようにした。E2E に「Status hero の `Run (OK|WARN|ERR)` と footer の `run ...` が一致する」回帰テストと dot tone 検証を追加した。
- **教訓**: 同じ意味の状態ラベル (run health) を複数 UI 領域で出す場合、判定を各コンポーネントに書かない。単一 helper に集約し、text だけでなく visual tone も DOM 上の同一ページ整合性として E2E で直接ゲート化する。

### LL-127: 検証スキルは実行可能コマンドと現行ナビ不変条件に同期させる
- **事象**: self-critique 実行時に `npm run secrets:scan:staged` が存在せず検証ゲートが停止し、C-02 も mobile tabbar を 3 action 前提で判定していたため現行仕様 (5 action) とズレた。
- **根本原因**: `.claude/skills/self-critique/SKILL.md` の検証手順が package scripts と R-015 の最新ナビ仕様に追従しておらず、運用手順だけが古い状態で残っていた。
- **対策**: C-01 を `npm run secrets:scan` + `npm run secrets:scan:worktree` に更新し、C-02 を desktop shortcuts (`Categories/arXiv/Knowledge`) と mobile tabbar 5 action (`Home/Categories/arXiv/Knowledge/Menu`) の現行不変条件に同期した。
- **教訓**: 自己批判スキルは「実行できること」自体が品質ゲート。scripts 名・ナビ不変条件・E2E 前提が変わったら、コード修正と同一セッションで検証スキルも更新する。

### LL-128: グリッドの列再定義時は子要素の明示配置と境界幅検証を同時に行う
- **事象**: 901-1180px の中間幅で `.top-rank-item` を 3 トラック化した際、`rank-meta` が暗黙 auto-placement で 24px 列に落ち、鮮度バッジが 1 文字縦積みになってカード高さが 700px 近くまで暴走した。
- **根本原因**: ブレークポイントで `grid-template-columns` だけを変更し、`rank-title` / `rank-meta` / `rank-reason` の列・行を全レイアウトで明示しなかった。ページ右 rail の有無で Top-3 パネル幅が大きく変わるのに、viewport 単位の見た目確認だけで component 幅の再配置を検証していなかった。
- **対策**: Top-3 パネルを named inline-size container にし、container query で狭幅時の再配置（title→meta→reason）を制御。`rank-meta` / `rank-title` / `rank-reason` を全 relevant レイアウトで明示配置し、`rank-freshness` / `featured-freshness` は `white-space: nowrap` + 最小幅で atomic に保つ。E2E に境界幅行列 (1181/1180/1100/1050/1000/981/960/901/900/768/390) の bbox・高さ・overflow・badge 寸法チェックを追加。
- **教訓**: グリッド列を再定義するときは「子要素の配置定義」と「境界幅検証」を必ずセットで行う。右 rail 等で利用可能幅が変わる画面は、viewport ブレークポイントだけでなく component 幅を基準に container query で再配置する。

### LL-129: 短い ASCII keyword の substring 一致は `paid/air/trailer` を誤通過させ、token 境界だけでは `LLMs/agents/models` の正当複数形を落とす。filter/category 変更は fresh・prior merge・既存 artifact に対称適用する
- **事象**: `TECH_NEWS_RELEVANCE_KEYWORDS` に短い `ai` を含めたまま `includes()` で判定していたため、The Verge など broad feed で `paid`, `air`, `trailer` のような英数字語中の `ai` に誤一致し、consumer/gaming ノイズが tech-news に混入した。加えて token-aware 境界一致へ修正した直後、`llm` / `agent` / `model` のような singular keyword が `Code LLMs` / `information agents` / `foundation models` を拾えず、TRACER を含む正当な research / tech-news 記事を archive migration で落とした。さらに `hn-ai` の registry category を変更しても、prior merged entry や既存 live/archive artifact には旧 `research` が残り得た。
- **根本原因**: keyword filter が substring 一致からの脱却時に「ASCII keyword と英数字境界」は導入したが、「安全な一般的複数形」は考慮していなかった。つまり token-aware 化が singular 完全一致になり、`llm -> LLMs`, `agent -> agents`, `language model -> language models` のような自然な複数形を false negative にした。さらに registry 変更を fresh collect にしか効かせず、Worker の prior merge path と migration script が current registry filter/category を対称適用していなかった。
- **対策**: `harness/pipeline/source-filter.ts` を shared helper 化し、短い ASCII keyword/phrase は英数字境界一致を維持しつつ、最後の token にだけ安全な一般複数形 variant (`s` / `es` / `consonant+y -> ies`) を許可する。これで `AI` は `paid/air/trailer` に不一致のまま、`LLMs/agents/models/policies` などの正当複数形を保持できる。非 ASCII/JA keyword と URL/title scope は既存契約を維持する。Worker merge は current registry rule で prior merged entry を再 filter + re-stamp し、`scripts/clean-source-noise.mjs` も同じ helper/registry を使って live/archive を再評価・再分類する。
- **教訓**: broad feed の relevance/noise 判定は `includes()` を直書きしない。ASCII token 境界を入れるときは、`ai` のような短語の false positive だけでなく `llm/agent/model` の false negative も同時に防ぐ。検出 (tests) / 予防 (collector+Worker) / migration (既存 artifact 修復) を shared helper と registry の単一ソースに揃え、fresh data だけ直して prior merged data を放置しない。

### LL-130: broad tech-news feed は `keywordFilterScope: "title"` を明示しないと snippet が consumer title を relevance 通過させる
- **事象**: 本番 deploy 後の 00:00 cron で live registry violations は 0 なのに、`The QD-OLED gaming monitor that started it all got a big upgrade` (The Verge) と `SOND, a sleep tech startup from Bose’s former head of sleep, exits stealth with $7M` (TechCrunch) の known-bad 2 件が残存した。どちらもタイトル自体は consumer / gaming で不適切だが、snippet 内の AI / developer 語に引っ張られて include を通過していた。
- **根本原因**: `TECH_NEWS_RELEVANCE_KEYWORDS` / `TECH_NEWS_EXCLUDE_KEYWORDS` を共有する broad source に `keywordFilterScope: "title"` が明示されておらず、default の `title + contentSnippet + url` haystack が使われていた。shared helper 違反 0 でも、scope 自体が誤っていると policy gap は検出されない。
- **対策**: `apple-newsroom`, `microsoft-source`, `google-keyword`, `meta-newsroom`, `aws-news`, `nvidia-blog`, `techcrunch`, `the-verge`, `ars-technica` など shared TECH_NEWS filter 利用 source すべてに `keywordFilterScope: "title"` を明示し、registry test で invariant を固定する。known-bad title は snippet に AI/platform/developer 語を含めても drop する回帰テストを追加する。
- **教訓**: broad feed のノイズ判定は keyword 集合だけでなく **scope も policy の一部**。shared helper の violations=0 だけでは不十分で、deploy 後の known-bad sample scan で scope 漏れを補足する必要がある。shared filter を使う broad source には `keywordFilterScope: "title"` を必須 invariant として registry test で固定する。

### LL-131: title-only 化は snippet false-positive を止める一方、model family / security / cloud service 語彙不足で高信頼 false-negative を作る
- **事象**: `keywordFilterScope: "title"` を broad tech-news source に強制した後、Bose / gaming monitor の known-bad は消えたが、全量監査で高信頼 false-negative 19 件が残った。内訳は (A) 生成 AI / model / modality (`Muse Image`, `DiffusionGemma`, `MAI-Image`, `Gemma 4`)、(B) security / privacy (`backdoor`, `backdoored`, `exploit`, `malware`, `credential stealer`, `password vault`, `privacy`)、(C) cloud / infra / devops (`tech debt`, `S3`, `Interconnect`, `ECS`, `Aurora PostgreSQL`) の 3 系統だった。
- **根本原因**: title-only 化で snippet からの救済がなくなった結果、shared `TECH_NEWS_RELEVANCE_KEYWORDS` 自体の語彙が不足している source では、タイトルだけを見た時に AI / developer 記事だと判定できなかった。特に `DiffusionGemma` のような camel-case product family や、security / cloud サービス名は `ai` / `developer` の汎用語だけでは拾えない。shared helper 違反 0 でも、「必要語が registry に無い」場合は policy gap が残る。
- **対策**: source 固有タイトルの場当たり追加ではなく、shared `TECH_NEWS_RELEVANCE_KEYWORDS` に 3 系統を一般化する最小語彙 (`image generation`, `text generation`, `text-to-image`, `gemma`, `backdoor`, `backdoored`, `malware`, `exploit`, `credential stealer`, `password vault`, `privacy`, `tech debt`, `s3`, `interconnect`, `ecs`, `aurora postgresql`) を追加した。migration の前後で `origin/main` と current artifact を **canonical URL** で diff し、対象 19 URL が 19/19 残ることを機械確認したうえで apply した。回帰防止として 19 タイトルすべてを actual registry definitions ベースの table-driven test に固定した。
- **教訓**: title-only 化は必要だが、それだけで broad feed の品質は完結しない。**false-positive を減らした次の層で false-negative corpus を点検し、shared relevance 語彙を最小拡張する**のが恒久対策。migration は件数だけでなく canonical URL diff で「残すべき記事が残っているか」を確認する。keep corpus は推測でなく actual registry test に固定し、snippet 依存の救済に戻さない。

### LL-132: mutation CLI は no-arg も含めて fail-closed にし、同時 write は atomic rename で partial JSON を見せない
- **事象**: `scripts/clean-source-noise.mjs` を usage 確認のつもりで `--help` 実行したところ、引数未解釈のまま apply 経路に入り `APPLIED - removed=1200` を実行した。後に no-arg 実行でも同じ apply 経路へ落ちる回帰が見つかった。同時に別の `--dry-run` が同じ `data/index.json` を読みに行き、直接 `writeFileSync(path, ...)` 中の途中状態を拾って `SyntaxError: Unterminated string in JSON` になった。
- **根本原因**: CLI 引数が明示 parse されておらず、`process.argv.includes("--dry-run")` 以外の判定が無かったため、help・no-arg・未知引数も apply へ落ちていた。さらに JSON 書き込みが同一パスへの direct overwrite だったので、並行 reader が partial JSON を読める状態だった。
- **対策**: mutation CLI は **`--apply` を明示した時だけ**書き込みを許可し、`--help` / `-h` は no-op で 0 exit、`--dry-run` は no-op preview、no-arg / unknown / conflict (`--dry-run --apply`) は fail-closed で nonzero exit にする。書き込みは同一 directory の temp file へ `writeFileSync(..., "utf8")` した後に `renameSync` で atomic swap し、partial JSON を表に出さない。安全テストは help / unknown だけでなく **no-arg と conflict でも data tree 全体の snapshot を比較**し、非 mutation を固定する。
- **教訓**: destructive / mutation 系 CLI は「引数を読める」ではなく「**明示 apply 以外では絶対に書かない**」ことが重要。help は no-op、no-arg / unknown / conflict は fail-closed、書き込みは atomic rename を標準にする。並列 reader が存在する artifact は direct overwrite しない。

### LL-133: TS を import する CLI は repository の tsx 経由で起動し、Node20 smoke と docs/tests を一致させる
- **事象**: `scripts/clean-source-noise.mjs` は `.ts` モジュールを import しているのに、テストや説明が direct `node scripts/...` を前提にしており、Node22 では見逃せても Node20 では `ERR_UNKNOWN_FILE_EXTENSION` になりうる経路差が残った。
- **根本原因**: executable docs と safety tests が実際の launcher とズレていた。`tsx` が必要な CLI を direct node で起動する前提だと、同じ repo でも runtime によって挙動が変わる。
- **対策**: `.ts` を読む CLI は repository 同梱の `tsx` か `node --import tsx` で起動する前提に統一し、Node20 smoke は `npx -y node@20 --import tsx ...` のように最小サポート runtime で確認する。tests も同じ launcher を使い、global dependency に依存しない。
- **教訓**: CLI の互換性は「実行できる」ではなく「**同じ launcher で実行できる**」までを docs/tests に書く。Node22 の偶然の成功を Node20 互換の証拠にしない。説明・テスト・スモークは実際の起動経路と一致させる。

### LL-134: Truthful labels still mislead when identical words hide different semantics
- **事象**: Home の `sources`、Status hero の `Source coverage`、footer の `last batch ... src` がすべて truthful な値なのに、実際には「live entries を持つ active registry sources」「freshness threshold 内の sources」「直近 batch で成功した sources」という**別の母集団**を指していたため、4-persona audit で「同じ sources なのに意味が違う」「pending の横の鮮度 OK が要約完了に見える」と誤読された。さらに Featured と Top-3 は entry ID だけ重複排除していたため、同一 source stream (例: Zed Releases) が両方の decision slot を占有できた。
- **根本原因**: 数値自体は正しくても、ラベルが generic すぎると UI 上で意味が衝突する。特に decision slot / health metric / pending state のような判断導線では、「何の freshness か」「どの source 集合か」「stream 単位か entry 単位か」を明示しないと、truthful data でも誤解を生む。
- **対策**: Home は `Active registry sources` / `収録中ソース` として live-entry coverage を明示し、Status hero は `Fresh sources` と freshness semantics を名指しする。footer の `last batch ... src` は batch semantics のまま維持する。detail の freshness badge には `data-freshness-scope="collection"` と `収集鮮度 OK` / `Source fresh` を付け、Summary pending の隣でも要約完了と誤読されないようにする。Top-3 の候補プールは Featured の **source** も除外し、decision slot の source diversity を保証する。
- **教訓**: UI の warning は「値が嘘か」だけでなく「値の意味が一意に読めるか」で発生する。generic label (`sources`, `freshness`) が複数の母集団・工程に跨るなら、semantic name に分解する。decision-critical slots の重複排除は entry ID だけでなく **source stream 単位**で行う。pending enrichment の隣に出す badge は scope (`collection`, `summary`, `body`) を機械可読属性でも明示する。

### LL-135: broad shared relevance に `code/tool/platform/processor` のような generic 単語を残すと consumer/automotive/marketing タイトルが通過する
- **事象**: shared `TECH_NEWS_RELEVANCE_KEYWORDS` の generic 単語だけで、`Quantum error correction can constantly recalibrate a processor`、`Like a cheat code for your car: We investigate ECU tuning`、`Cannes Lions 2026: Strengthen creative campaigns with new tools from YouTube`、`Airbnb-backed WeRoad raises $58M to take its group travel platform to the US` が broad feed live entry として通過した。
- **根本原因**: `code` / `tool` / `tools` / `platform` / `processor` / `processors` は title-only 判定でも意味が広すぎ、consumer / automotive / marketing の一般記事が tech-news relevance を満たしてしまう。一方で AWS Graviton / Bedrock や prompt-injection 記事のように、従来その generic 単語しか一致しない正当記事もあり、削除前に「その候補語だけで通る live entry」を列挙して保護しないと false negative を作る。
- **対策**: shared relevance から generic 単語を削除し、`prompt injection` / `graviton` / `bedrock` のような compound developer/security terms と named product families に置き換える。回帰防止として「候補語だけで通る keep corpus / drop corpus」を actual-registry table test に固定し、snippet に AI/developer 語があっても title scope では drop されることを確認する。
- **教訓**: broad shared relevance を削る前に、**削除候補語が唯一の一致になる実 entry を全列挙**する。generic 単語は source 固有 exclude で塞がず、shared relevance を compound term / product family へ狭める。検証は heuristic ではなく actual registry + actual title の table-driven test で keep/drop の両側を固定する。

### LL-136: verification skill は architecture contract が変わったら同時更新する
- **事象**: `self-critique` スキルが LL-115 後も旧「index に本文がある」前提のままで、C-01 で `body 欠落 0 件` を要求し、C-06 でも `noBodyJa/noBodyEn` を bad と扱っていた。実際の contract は `data/index.json` body-free + `data/bodies.json` 保持なので、検証スキル自体が drift していた。
- **根本原因**: body-file architecture への移行時に、コード / tests / ルールは更新したが、**検証スキルのチェック文言と実行コマンド**を同じ contract に揃える横展開が漏れた。verification skill はコードの consumer でもあるのに、architecture change の更新対象として扱われていなかった。
- **対策**: self-critique の R-012/R-013 と C-06 を body-file architecture に同期し、`index body present (expected 0)` と `bodies.json count/coverage` を確認するコマンドへ差し替える。architecture contract が変わる変更では、README / tests / rules に加えて **verification skills / runbooks / CLI examples** も同一セッションで更新する。
- **教訓**: 検証スキルが古い前提を持つと、正しい実装を false warning 扱いし、逆に本物の drift を見逃す。storage contract・publish contract・nav contract のような設計変更では、**検証文言・サンプルコマンド・完了報告テンプレートまで含めて更新**することを必須にする。

### LL-137: filtered feed の `collectedAt` は source last-checked telemetry ではないので、quality audit は inactivity を Critical にしない
- **事象**: `quality-audit` が zenn-ai / simonw-blog / techcrunch を `Critical` と判定したが、根拠は「live index に残る最新 qualifying entry の `collectedAt` が古い」だけだった。include/exclude filter で recent item が全落ちすると、source は正常収集でも retained entry は古く見える。
- **根本原因**: `quality-audit/run.ts` が per-entry `collectedAt` を pipeline health と同一視し、freshness `error` を source ごとに `Critical` 加算していた。`data/index.json` は retained entries しか持たず、「その source を最後にいつチェックしたか」は aggregate telemetry (`health.sourcesAttempted` / `sourcesOk` / `sourcesFailed`) にしか存在しないのに、この2種類のシグナルを混同していた。
- **対策**: quality audit は retained/listed-entry freshness を `🟠 inactive` / `🟠 stale` として**非 Critical の活動シグナル**に格下げし、severity 集計は (a) empty index、(b) aggregate telemetry で attempted 全件 failed のみを `Critical` にする。partial source failure は 1 Warning、stale/inactive listed source が 2 つ以上ある場合も 1 Warning にグループ化する。SKILL.md / tests も同じ契約に同期する。
- **教訓**: filtered feed の `collectedAt` は「その source の最新 retained item の age」であって「collector の最終成功時刻」ではない。quality audit では **pipeline run health と listed-entry activity を分離**し、Critical は aggregate run telemetry から、stale/inactive は grouped Warning として扱う。activity gap を隠さず出しつつ、pipeline outage と誤判定しないことが重要。

### LL-138: target-language field を source-language fallback で埋めると provenance が壊れる。data mutator CLI は毎回 fail-closed + atomic write にする
- **事象**: `scripts/fill-title-en.mjs` が `summaryEn` fallback / pending の entry に対し、元の日本語 `title` を `titleEn` にコピーしていた。これで `titleForLangWithFallback` が本来出すべき JA fallback badge が消え、英語欄に source-language title が「本物の English title」のように見えていた。加えて CLI は no-arg / unknown / help でも apply 経路に落ち、直接 overwrite で LL-132 と同じ mutation safety 欠陥を持っていた。
- **根本原因**: 「空よりまし」として target-language field を source-language 値で埋めると、UI は provenance (どの言語が原文か) を失う。さらに単発修復 script だからといって fail-closed/atomic write の共通安全規約を横展開していなかった。
- **対策**: `titleEn` は **real non-fallback `summaryEn`** からだけ導出し、deterministic/pending `summaryEn` の場合は空のまま残して UI の cross-language fallback + language badge に委ねる。導出は `Intl.Segmenter("en", { granularity: "sentence" })` を優先しつつ、**原文で terminal punctuation の直後が非 whitespace (`.NET` など) ならその境界を拒否**して portable scanner に fallback し、`GPT-5.6` / `v2.1.205` / `launch.json` / `.NET MAUI` のような token 内 punctuation で切らない sentence-aware 抽出にする。既存 `titleEn` は、同じ `summaryEn` から得た **旧 legacy extractor の値と完全一致する場合だけ**安全に補正し、genuine title は上書きしない。`scripts/fill-title-en.mjs` は pure helper export + direct-invoke 時のみ auto-run に refactorし、`--dry-run|--apply|--help` 以外は拒否、no-arg/unknown/conflict は nonzero、apply は same-dir temp + atomic rename に統一する。apply 後は **再 dry-run で `totalUpdated=0`** を確認して idempotence を検証する。
- **教訓**: i18n field の補完では **target-language field を source-language fallback で埋めない**。truthful provenance (JA/EN badge と actual field origin) を壊すから。補完は real target-language content からだけ行い、無い場合は空のまま UI fallback に委ねる。sentence 抽出は token 内 punctuation を文末扱いしないだけでなく、**segment boundary が原文の隣接文字と矛盾しないか**まで確認すること。既存値の repair も「旧機械抽出値と完全一致する場合のみ」に限定し、genuine title を推測で上書きしない。さらに JSON/data mutator CLI は例外なく LL-132 の安全規約 (help no-op、unknown fail-closed、atomic rename) を適用し、post-apply dry-run で 0 update を確認する。

### LL-139: body-file architecture 後はローカル harness の summarize も summary-only に揃える。queue/worker だけ直しても orchestrator が全件再処理する
- **事象**: body-file architecture (R-012 / LL-115) へ移行した後も、`harness/pipeline/summarize.ts` のローカル `summarize()` は `bodyJa/bodyEn` 欠落を incomplete とみなし、長文 bilingual body を要求する旧 `buildPrompt` を使い続けていた。結果として body-free index entry が every run で再要約対象になり、LL-106 の reasoning exhaustion 系失敗や高コスト生成をローカル経路だけで再導入し得る状態だった。
- **根本原因**: cloud path (worker prompt / summary queue / completion contract) は summary-only に更新されたが、local orchestrator path の prompt・completion・eligibility が**対称更新されていなかった**。queue/worker だけ直せば全経路が直ると思い込み、同じ summary contract を共有 helper に寄せる横展開が漏れた。
- **対策**: local harness は `worker/src/prompt.ts` の `buildSummaryPrompt` + `parseResponse` を直接再利用し、`SUMMARIZE_MAX_TOKENS` 既定を 1600 に下げる。`needsGeneratedContent` は summary-only (`summaryJa` / `summaryEn` 非空・非 fallback で完了)、`isCompleteSummaryResponse` は `titleJa + summaryJa + summaryEn` のみ必須にする。新規 cache record の `bodyJa/bodyEn` は空文字列で保持し、legacy cache body は読むだけで温存する。
- **教訓**: architecture contract を変えるときは **local path と cloud path の prompt / generation / completion / cache contract を対称化**する。queue/worker だけ summary-only にしても orchestrator が旧 contract のままなら、body-free index を「未完了」と誤判定して全件再処理する。shared prompt/parser を 1 箇所に寄せ、完了判定も同じ contract で揃えること。

### LL-140: taxonomy restamp / archive migration は downstream enrichment と related artifacts を上書きしない
- **事象**: independent review で taxonomy restamp が AI/cache 由来の `entry.importance` を heuristic `scoreImportance` で上書きし、live で **1,146 件**の importance 変化 (うち **126 件が 3->1、906 件が 2->1**) を発生させていた。archive migration では compact hot entries を warm/cold/dropped へ再計算し得るうえ、`data/bodies.json` の orphan body ID と health/stats count が index とずれていた。
- **根本原因**: migration が「source-owned field の restamp」と「downstream enrichment / storage-tier field」の境界を列挙せず、`importance` や `archiveTier` のような後段で確定した値まで再計算対象に含めていた。さらに related artifacts (`index` / `archive` / `bodies` / `stats`) を同じ ID 集合・同じ reference clock で再構成していなかった。
- **対策**: fresh `normalize()` だけが heuristic importance を計算し、既存 entry の restamp は `importance` を preserve する。archive migration は既存 `archiveTier` を preserve し、`dropped` は再公開せず除外する。すでに壊れている warm/cold compact rows で summary が欠けているものは、**summary を捏造せず、履歴件数も捨てずに stats-only の `hot` へ戻す**。write 前に index/archive/bodies payload を **consumer-facing schema 全体** (enum、timestamp、summary/title/image/body record 型、live summary 必須、warm/cold bilingual summary 必須) まで strict validate し、`data/bodies.json` は final live IDs に対して reconcile、health の body count も再計算する。stats は `index.generatedAt` を reference clock に 1 回だけ再構築し、**multi-file batch transaction + rollback** で更新する。
- **教訓**: migration では **どの field が migration-owned で、どの field が downstream enrichment / storage-tier owned かを先に列挙**してから触る。`importance`、`archiveTier`、body sidecar、stats clock のような後段責務を restamp で上書きしない。historical に壊れた compact archive rows は summary を発明せず、公開 tier を `hot` に戻して historical counts を保持する。validation も top-level JSON だけでなく、読者向けに解釈される field 型 (image/body/lang/enum) と context-specific summary invariants まで fail-closed に見る。related artifacts は同じ ID 集合と同じ reference clock を共有し、partial write を許さない batch mutate にする。

### LL-141: raw filter を lossy normalization 後に fresh entries へ再適用すると valid article を落とす。collector contract には cap も含まれる
- **事象**: Worker が fresh normalized entries に current-rule filter を再適用していたため、RSS raw snippet では 800 文字以内に relevance keyword があって pass した記事が、normalize 後に `contentSnippet` 280 文字へ truncate された結果、keyword が見えなくなって drop されていた。あわせて `collectHnAlgolia()` は `maxEntriesPerRun` を無視していた。
- **根本原因**: raw collection 時点の filter 契約と、lossy normalization 後の entry shape を同一視し、fresh entries まで再 filter していた。snippet length を縮めた後に raw filter をもう一度掛ければ、collector が pass させた valid entry を false negative 化する。HN collector では cap も collector contract の一部なのに未適用だった。
- **対策**: current-rule reapply は **prior merged entries のみ**に限定し、fresh entries は「current collector + current registry で既に filter 済み」とみなしてそのまま merge する。prior normalized entries は `keywordFilterScope !== "title"` なら、lossy/truncated snippet のため **missing include だけでは destructive drop しない**。exclude hit は従来どおり safe に drop し、title-scope source は missing include drop を維持する。fresh collector 側も shared registry contract を自前で守る必要があるため、`collectHnAlgolia()` には RSS collector と同様に **shared keyword filter を cap 前に適用し、その後 `maxEntriesPerRun` で slice** する。`hn-ai` の filter scope は title-only に固定する。
- **教訓**: **lossy normalization の後に raw filter を再実行しない**。migration で再評価すべきなのは prior artifact だけで、fresh collector output は current collector contract を信頼する。ただし、その前提は「各 fresh collector が shared keyword filter と per-source cap を raw output に対して正しく適用している」こと。normalized prior は raw snippet を失っているため、**non-title scope の missing include は ‘未検証’ であって ‘不適格’ ではない**。collector contract には keyword filter だけでなく scope と cap の順序も含まれるので、全 collector で同じ制約を適用する。

### LL-142: freshness の scope は article / source / run を分離して明示する
- **事象**: article detail が viewed entry 自身の `collectedAt` を source freshness として表示していたため、古い記事を読むと source 自体が stale に見えた。一方 quality audit は aggregate `health.lastRunAt` の stale run を severity に反映しておらず、実際には data generation が止まっていても Critical にならなかった。
- **根本原因**: `collectedAt` という 1 つの時刻を、(a) その記事の収集時刻、(b) source の最新 listed activity、(c) pipeline run health の 3 つの意味で混用していた。scope ごとの helper が分かれておらず、article/source/run の freshness が UI と audit で混線していた。
- **対策**: article detail には `latestListedActivityForSource()` を追加し、同一 source の最新 listed entry collectedAt を source freshness に使う。aggregate run health は `deriveWorkerRunStatus()` を quality audit から再利用し、`lastRunAt > 6h` を Critical、`copilotOk=false` を Warning に統一する。viewed article の age (`publishedAt` / own `collectedAt`) は source freshness と分けて扱う。
- **教訓**: freshness は **article age / source activity / pipeline run health** の 3 scope を明示的に分ける。同じ `collectedAt` を使っていても、どの集合の最新値かで意味が全く違う。helper と UI ラベルは scope 単位で共有し、混同を防ぐ。

### LL-143: shell helper の可搬性を前提にしない。宣言済みツールと portable scan を使う
- **事象**: このセッションの修正中、shell から `apply_patch` を使える前提で進めようとしたが runtime には無く、macOS/BSD の `grep` も `-P` を受け付けず U+FFFD scan コマンドがそのまま動かなかった。
- **根本原因**: Linux 環境でよく使う shell helper (`apply_patch`, GNU grep PCRE) を、runtime が宣言していないのに portable だと仮定していた。実際の実行環境は「提供された編集ツール」と BSD userland であり、shell helper の可用性保証が無かった。
- **対策**: file edit は runtime が提供する editor/file operation ツールを使い、shell helper を前提にしない。U+FFFD scan のような byte/codepoint 確認は `grep -P` ではなく Node/Python で file bytes を直接読む portable 実装に置き換える。
- **教訓**: **宣言されているツールだけを使う**。`apply_patch` や GNU `grep -P` を shell の既定能力だと思わない。portable validation は Node など repo 依存で確実に使える runtime で書き、OS 差分のある one-liner に依存しない。

### LL-144: lossy normalized prior では missing include だけで destructive drop しない
- **事象**: current-rule cleanup が normalized/compact prior entry に shared include filter を再適用すると、raw snippet にあった include hit が normalize 後の欠損/短縮 `contentSnippet` で消え、valid prior article が migration/Worker merge で drop され得た。
- **根本原因**: non-title scope source の include 判定は本来 `title + raw snippet + url` 契約だが、prior artifact は raw snippet を保持していない。lossy normalized context で include miss を「不適格」と断定していたのが過剰だった。
- **対策**: shared source-filter に decision helper を追加し、**exclude hit は常に drop、title-scope の missing include は drop、non-title scope prior normalized の missing include は `missing-include-unverified` として preserve/restamp** する。fresh collector は raw/full context の strict contract を維持し、`hn-ai` は title-only scope に固定する。`tests/data-schema.test.ts` の artifact gate も同じ evaluator (`allowLossyMissingInclude:true`) に同期し、keep=false と category drift だけを violation にする。
- **教訓**: **lossy normalized context は destructive cleanup の根拠に使わない**。raw input が失われた後は missing include を「確認不能」と扱い、drop するのは exclude hit か title-only のように証拠が十分な場合だけにする。fresh raw path、prior normalized path、artifact test gate の 3 者で同じ evaluator 契約を共有しないと、migration/Worker は通るのに test gate だけが過剰検出する drift が起こる。

### LL-145: i18n toggle は heading だけでなく本文コンテナ自体を切り替える
- **事象**: article detail の TL;DR は言語 toggle で heading だけ EN に変わる一方、本文は常に JA block が見え、EN bullets は `<details>` を開かないと読めなかった。EN user には「見出しだけ英語で本文は日本語」という半端な状態だった。
- **根本原因**: optional support content を隠す `<details>` と、active language の primary body を分けずに実装していた。`i18n-ja`/`i18n-en` class は heading には使われていたが、本文ブロックには適用されていなかった。
- **対策**: TL;DR body を `.i18n-ja` / `.i18n-en` の **別コンテナ**で描画し、JA は `pointsJa/summaryJa`、EN は `pointsEn/summaryEn.text` を active language で直接表示する。fallback text の `lang` は実際の言語に合わせ、duplicate English details は撤去する。E2E で detail page の JA body hidden / EN body visible を直接検証する。
- **教訓**: i18n toggle は **heading だけでなく primary content body まで切り替わって初めて完了**。`<details>` は補助情報には使えても、active language user が最初に読む主要本文を隠す場所ではない。visibility と `lang` は body container 単位で検証する。

### LL-146: multi-file mutator は per-file atomic では不十分。全出力を stage して batch rollback する
- **事象**: `clean-source-noise` は各 JSON file を temp + rename で個別 atomic write していたが、`index` / `archive` / `stats` / `bodies` を順次書く途中で後段 rename が失敗すると、先に置き換わった artifact だけ新状態、残りは旧状態という partial apply が起こり得た。
- **根本原因**: per-file atomicity を multi-file mutation の整合性まで保証すると誤解していた。related artifact 一式に対しては「全成功か全復旧か」の batch semantics が別途必要だった。
- **対策**: write 前に全 payload を serialize/validate し、same-dir temp と backup を全部 stage、journal を残してから swap する batch helper に統一した。swap 中に失敗したら、先に置換済み target も backup から全復旧し、temp/backup/journal を cleanup する。起動時に stale journal があれば自動 recovery する。SIGKILL の完全原子性は主張しない。
- **教訓**: related artifact を複数同時に更新する mutator では、**per-file atomic = safe** ではない。更新単位が 1 つの logical transaction なら、validate/stage/swap/rollback も transaction 単位にする。failure test は「後段 rename 失敗でも全 original hash が戻る」ことまで見る。

### LL-147: repair migration は input permissive / output strict を分けないと修復経路が到達不能になる
- **事象**: real `origin/main` data で `npm run noise:clean -- --dry-run` が `data/archive/2024-05.json.entries[0].summaryJa must be a non-empty string` で即時失敗した。warm/cold に誤って残った legacy compact row を `repairArchiveTierForMigration()` で hot へ戻す前に、strict archive validator が read 時点で落としていた。
- **根本原因**: 既知の historical corruption を修復する migration なのに、archive input read と final archive output validate の両方で同じ strict bilingual-summary rule を使っていた。strict pre-validation が repair path より先に走るため、修復ロジック自体が到達不能だった。
- **対策**: archive validation を **input structural validation** と **output invariant validation** に分離した。input 側は enum/type/timestamp など consumer-facing shape は strict に維持しつつ、known corruption である warm/cold missing summary だけを repairable として通す。transform 後の `buildArchiveMonthFile()` payload は write 前に strict validator へ通し、warm/cold bilingual required、hot のみ summary omission 可、dropped absent を保証する。
- **教訓**: repair migration では **読めること** と **最終出力として許されること** を分ける。known-corrupt input を直す処理なのに strict rule を read 時点で掛けると、修復経路が永久に発火しない。input は「この corruption だけは修復前提で許容」、output は「修復後 invariant を満たす」を明示的に二段化する。

### LL-148: Pagefind の近似候補を exact match 不在時に表示すると recovery state が偽装される
- **事象**: 検索語を含む結果が無い場合でも Pagefind 上位 10 件の近似候補を表示し、カテゴリやタグの navigation page が記事より上位に出た。
- **根本原因**: Pagefind ranking をそのまま actionable result と扱い、候補解決後の exact 判定と result type の優先順位を表示条件にしていなかった。
- **対策**: 上位 30 候補を解決して exact result だけを残し、article を navigation result より先に stable sort する。exact 0 件は closest match を出さず recovery links を表示する。
- **教訓**: 全文検索の近似候補は exact hit の代替ではない。検索 UI は exact 判定、result type 優先度、0 件 recovery を分離して検証する。

### LL-149: 非空 summary に生成途中の junk が混ざると completion gate を通過する
- **事象**: `zed-releases` の英語要約に README 作業メモと release note template が混入したが、非空だったため生成済みとして扱われた。
- **根本原因**: completion 判定が blank と deterministic pending marker だけを見ており、unsafe content と bare title echo を検査していなかった。生成、queue、fallback、web 表示、data schema の判定も分散していた。
- **対策**: root pipeline に shared summary quality contract を追加し、contamination、pending、title echo、bilingual completeness を統一判定する。web は R-005 のため同じ静的 marker を同期し、汚染言語を他言語へ fallback する。
- **教訓**: **非空は生成完了の証拠ではない**。unsafe-content contract は生成完了、queue/cache、publish fallback、表示、artifact gate の全層で共有する。

### LL-150: 後勝ちの重複 media query は非表示にした rail を再表示する
- **事象**: max-width 1100px で right rail を隠しても、後方の 901-1180px ルールが `display:block` を再適用し、980px 付近で 3 カラムが復活した。
- **根本原因**: 同じ selector 群の breakpoint 範囲が非対称で、後に宣言された compact 3-column rule が hide rule と重なっていた。
- **対策**: 3-column range を 981-1180px に限定し、980px 以下は既存 2-column layout と hidden rail を維持する。境界 981/980 の track 数、rail visibility、main 幅、overflow を E2E で固定する。
- **教訓**: responsive range は表示側と非表示側を同じ境界で対称に定義する。重複 media query は CSS 順序で再有効化されるため、境界直前と直後を必ず測る。

### LL-151: source freshness は選択記事の age ではなく source aggregate activity を参照する
- **事象**: Home の Spotlight / Ranked Top 3 が選択記事自身の `collectedAt` で source-feed freshness を判定し、同じ source に新しい listed entry があっても古い記事を stale 表示し得た。
- **根本原因**: 表示ラベルを source-feed freshness に明確化した一方、Home の参照時刻は article age のままで、detail page の source 集約判定とも分岐していた。
- **対策**: `latestListedCollectedAtForEntry()` を共通 helper とし、同 source の最新 listed collection 時刻、選択記事の `collectedAt`、`publishedAt` の順で参照する。Home と detail の両方を同 helper に統一した。
- **教訓**: source freshness は source aggregate activity から判定し、選択記事の age と混同しない。同じ status を出す画面は参照時刻 helper まで共有して drift を防ぐ。

### LL-152: subrequest budget は enrichment 合算と archive touched scope の両方で守る
- **事象**: harness Worker 更新後の batch 2/4 は sources 14/14 と summary enqueue 35 まで完了したが、pre-publish heartbeat 後に Too many subrequests by single Worker invocation で失敗し、data commit が作られなかった。summary/body lookup を 80+25 から 40+20、さらに 35+10 へ下げても同じ batch は再失敗した。
- **根本原因**: publishHistoryFiles のコメントは変更月だけ読む契約だったが、呼び出し側が全 contentReady entries を渡していたため、変更の有無に関係なく live entry を持つ最大 15 archive 月を毎回 raw fetch していた。incremental stats も old touched months を引いた後に全 live entries を再加算する実装で、この全月 read を暗黙の前提にしていた。lookup cap だけを下げても archive read の無駄が残るため budget exhaustion は解消しなかった。
- **対策**: body-free index の prior/next を canonical URL で比較し、新規または変更 entry の月だけを archive merge 対象にした。stats は old touched-month 全体を引き、merged touched-month 全体だけを足す対称 delta に修正し、baseline 欠落時のみ全 live 月を bootstrap する。加えて summary lookup/enqueue を 35、body lookup/enqueue を 10、固定 KV overhead 込み 50 以下へ制約した。同じ batch 2/4 を 2026-07-11 06:25 UTC に強制実行し、HTTP 200、sources 14/14、data commit c737c984 の作成を確認後、診断 cron と batch 固定を撤去した。
- **教訓**: subrequest cap は KV など個別 pipeline の局所値だけでなく、archive/history の fan-out を含む invocation 全体で設計する。incremental 処理のコメントが changed/touched-only を約束するなら、入力集合と stats delta も同じ touched 集合へ揃える。Worker deploy の完了判定には、失敗した同一 batch の publish 成功と通常 schedule への復帰を含める。

### LL-153: HTML entity のまま保存した media URL は画像 CDN で 403 / text/plain になり ORB を起こす
- **事象**: Qiita の画像 URL に `&amp;` が残り、raw URL は 403 text/plain、`&` へ戻した URL は image/jpeg を返した。
- **根本原因**: feed / OGP の HTML entity を URL として保存し、ブラウザが誤った query を画像 CDN へ送っていた。
- **対策**: shared media URL normalizer で named / numeric entity を反復 decode し、RSS、Worker OGP、既存 artifact migration に対称適用する。percent-encoded path/query は decode しない。
- **教訓**: media URL は ingestion 時に HTML serialization だけを正規化し、既存データにも同じ migration を適用する。画像失敗時は status だけでなく Content-Type と ORB も確認する。

### LL-154: provider の既知 domain alias は canonical helper を全 pipeline で共有する
- **事象**: Netflix TechBlog の Medium publication URL と custom-domain URL が同じ記事を別 entry として live/archive に残した。
- **根本原因**: collector dedupe が独自の弱い canonicalizer を持ち、Worker merge、archive/stats、tests、migration の alias contract と一致していなかった。
- **対策**: known publication path だけを shared `canonicalUrlKey` で custom domain へ写像し、collector dedupe も同 helper を使う。migration で live/archive/stats/index/bodies を一括再構築する。
- **教訓**: domain alias の正規化は provider 固有範囲に限定し、生成、merge、保存、監査、migration の全層で同じ canonical key を使う。

### LL-155: dismiss 経路は 1 つの close contract に集約する
- **事象**: search の Escape は値・結果・active state・focus を全て閉じたが、outside click は一部 state だけを閉じ、値と focus を残した。
- **根本原因**: close state transition を経路ごとに重複実装していた。
- **対策**: close button、Escape、outside click を shared `closeSearch()` に統一し、input focus も trigger と同じ open state を確立する。mobile の native close target は 44px 以上で検証する。
- **教訓**: dismissible widget は開閉の副作用を単一 contract に集約し、全 close 経路で value、results、ARIA/state、focus の後始末を同じにする。

### LL-156: archive migration は tier と canonical loser の enrichment sidecar を先に保全する
- **事象**: 過去の archive migration で共通 453 件が warm/cold から hot に変わり、hot compaction により EN のみの要約 452 件と bilingual 要約 1 件が失われた。synthetic fallback を canonical merge 前に足すと loser の実要約を妨げ、filter 後に body alias を作ると除外された canonical loser の sidecar も失われた。
- **根本原因**: tier、canonical enrichment、body sidecar の保全順序が migration の破壊的処理より後だった。
- **対策**: archive tier を維持し、canonical merge/enrichment 後に欠落言語を補修する。original-live から final-winner の alias を導出し、body を prune 前に移送する。最新 `origin/main` data を復元して再実行し、`lostJa=0`、`lostEn=0`、`tierChanged=0`、`warmColdMissing=0`、`lostBodies=0` を確認した。
- **教訓**: migration は canonical loser の要約と sidecar を final winner へ移してから filter、compaction、prune を行う。

### LL-157: multi-file transaction は committed marker を cleanup より先に永続化する
- **事象**: backup を durable committed state より先に削除する transaction は、crash 後に複数世代が混ざった状態を復旧し得る。journal を自動復旧する dry-run も read-only ではなかった。
- **根本原因**: commit point と cleanup の順序が逆で、dry-run が recovery write を許していた。
- **対策**: active journal 作成、全 target replace、atomic な committed journal marker、cleanup の順にする。recovery は active を rollback し、committed は保持する。dry-run は pending journal を検出したら書き込まず中止する。
- **教訓**: transaction の durable commit point を明示し、dry-run は recovery を含めて一切書き込まない。

### LL-158: async search の close は世代 token で未完了 Promise を無効化する
- **事象**: overlay を閉じても未完了の Pagefind Promise が後から DOM を更新し、検索 UI を再表示できた。また exact match で Unicode 表記差を吸収できなかった。
- **根本原因**: close が非同期処理の所有世代を無効化せず、await 後の DOM write に open state 検査がなかった。
- **対策**: monotonic generation token を close 時に更新し、全 await 後に generation と open state を確認してから DOM を更新する。exact-match policy は維持し、query と result の両方を Unicode normalize して `cafe` と `café` を一致させる。
- **教訓**: dismissible async UI は state を閉じるだけでなく、過去世代の非同期結果を全て失効させる。

### LL-159: subagent の read-only 指示は filesystem 境界ではない
- **事象**: read-only audit agent が指示に反して一時 Playwright file を 5 件作成した。
- **根本原因**: read-only は意図の指定であり、filesystem write を強制的に禁止する境界ではなかった。
- **対策**: subagent 完了直後に `git status --untracked-files=all` を確認し、生成元を確認できた一時 file だけを削除して commit に含めない。secret と branch 操作は LL-018 の通り親だけが行う。
- **教訓**: subagent の副作用は指示で防げると仮定せず、親が worktree 差分を監査して確定した一時成果物だけを除去する。

### LL-160: health telemetry は snapshot 全体の完全性を先に検証する
- **事象**: 個別 field の nullish default により、欠落 telemetry が false green になり得た。
- **根本原因**: aggregate health 判定前に telemetry snapshot の必須 field と型を検証していなかった。
- **対策**: `lastRunAt`、boolean の `copilotOk`、有限かつ非負の `sourcesAttempted` と `sourcesOk`、array の `sourcesFailed` が全て存在する場合だけ aggregate health を評価する。
- **教訓**: 必須 telemetry が 1 つでも欠ける snapshot は non-healthy とし、field 単位の default で正常化しない。

### LL-161: focus 復帰は「opener が自分の副作用で消える」場合に可視 fallback を用意する
- **事象**: search を閉じたとき opener (起動要素) に focus を戻す実装で、mobile の Menu→Search 経路だけ focus が `<body>` に落ちた。Menu 内の Search trigger で search を開くと、その副作用で Menu が閉じて **opener 自身が hidden になる**ため、閉じたとき復帰先が非表示要素になっていた。
- **根本原因**: focus 復帰先を「opener の参照」1 点に固定していた。dismissible widget を開く動作が別の overlay (menu) を閉じる副作用を持つと、opener がその場で不可視になり、復帰先として無効になる。
- **対策**: `restoreSearchFocus()` は保存した opener が可視 (`isConnected && getClientRects().length>0 && !disabled`) な場合のみそこへ戻し、不可視なら同種の可視コントロール (最初の可視 `[data-menu-trigger]`) へ fallback する。E2E は「復帰先が hidden な特定要素と等しい」ではなく「focus 先が可視かつ同種 role の要素」を assert する。
- **教訓**: focus 復帰は「元の要素」ではなく「到達可能な等価コントロール」を最終目標にする。opener が自分を開いた副作用で hidden 化しうる UI では、可視性を検証して可視 fallback に切り替える。テストも要素同一性でなく可視性・role で検証する。

### LL-162: transaction journal と backup も target と同じ atomic contract で保護する
- **事象**: `clean-source-noise` の multi-file transaction は target の atomic rename と committed marker を持っていたが、active journal と backup を直接書いていた。process crash で journal が途中 JSON になると、次の `--apply` が `JSON.parse` で停止し recovery に入れない状態だった。
- **根本原因**: transaction の安全対象を最終 target file に限定し、復旧の source of truth である journal と backup の durability を同じ contract に含めていなかった。
- **対策**: active journal と backup も同一 directory の temp file へ書いて atomic rename し、target replace より先に active journal を永続化する。journal の parse / schema が壊れている場合は自動削除や推測復旧をせず fail-closed にし、journal と `.bak` / `.tmp` を保持したまま手動復旧手順をエラーに出す。truncated journal と rename order の回帰テストを追加する。
- **教訓**: multi-file transaction の metadata と backup は target と同じ重要度を持つ。壊れた journal を消すと復旧証拠まで失うため、atomic write、shape validation、fail-closed preservation を一体で実装する。

### LL-163: migration transaction は recovery・read・write を同一の排他 ownership で囲む
- **事象**: `clean-source-noise --apply` を複数起動すると、同じ journal と data artifact に対して recovery と write が並行し得た。また rollback 中の restore が失敗しても cleanup が走り、次回復旧に必要な journal / backup を失う経路があった。
- **根本原因**: atomic rename は各 file の置換だけを保護し、migration 全体の単一 writer 性を保証しない。cleanup も rollback の成否と分離されていた。
- **対策**: journal sibling の lock file を exclusive create し、recovery、artifact read、migration compute、transaction write の全区間を同じ owner token で保護する。cleanup 前に ownership を再検証し、rollback が全 target で成功した場合だけ journal / backup / temp を削除する。rollback 失敗時は証拠を保持し、次回 recovery で復旧可能な回帰テストを追加する。
- **教訓**: multi-file migration の安全性は atomic write だけでは成立しない。単一 writer ownership と「復旧完了後だけ証拠を消す」条件を transaction contract に含める。

### LL-164: 品質不合格 cache は再生成対象にするだけでなく read path からも除外する
- **事象**: summary cache の汚染を検出して再生成対象へ追加しても、同じ cache 値を output entry へ適用していたため、認証不在や生成失敗時に有効な既存要約が汚染値で上書きされた。
- **根本原因**: cache 品質判定を scheduling にだけ使い、cache read / apply の可否判定へ共有していなかった。
- **対策**: cache と entry を合成した候補が summary quality contract を満たす場合だけ output に適用する。不合格 cache は entry の現行値を保持したまま再生成対象へ入れ、生成不能時にも汚染を publish しないテストを追加する。
- **教訓**: validation は「後で直す対象の選定」だけでなく「今その値を利用してよいか」の gate にもする。同じ validation 結果を scheduling と read path で対称に使う。

### LL-165: canonical URL key は hostname だけでなく非 default port を含む authority を保持する
- **事象**: `canonicalUrlKey` が `URL.hostname` だけで key を作り、同一 host の `:8443` と `:9443` を同じ記事として dedupe していた。
- **根本原因**: 一般的な公開 URL に port が無い前提で authority を hostname へ縮退し、origin を区別する非 default port を落としていた。
- **対策**: `URL.port` が非空の場合は `hostname:port` を canonical authority に使い、異なる custom port が別 key になるテストを追加する。default port は URL parser の正規化に従い省略する。
- **教訓**: URL identity の正規化では tracking query や default port は除去してよいが、origin を変える authority 情報は保持する。

### LL-166: visual active と `aria-current="page"` は別の状態として判定する
- **事象**: category detail や archive month で親 section の shortcut を visual active にする目的で `pageKey` を使った結果、現在 URL と一致しない親 link にも `aria-current="page"` が付いていた。top-level page の bare `Sidebar` では Timeline まで active になっていた。
- **根本原因**: section context を示す見た目の highlight と、現在の page そのものを示す accessibility semantic を 1 つの boolean で表現していた。
- **対策**: visual active は `pageKey` / sidebar の明示 `active` で維持し、`aria-current="page"` は正規化した pathname と href が完全一致する link だけに付ける。Sidebar の default は neutral にし、Timeline 系ページだけ `active="all"` を明示する。
- **教訓**: ancestor section の強調は navigation context、`aria-current` は exact destination である。両者を分離し、1 page 内で current page link が重複しないことを E2E で確認する。

### LL-167: bilingual DOM を検索 index に渡すときは title metadata を単一値で明示する
- **事象**: 記事 detail の H1 に JA / EN span を同居させたところ、Pagefind の自動 title 抽出が両方の text を連結し、検索結果 title が重複して見えた。
- **根本原因**: CSS で片方を非表示にしても static indexer は DOM text を読み、表示言語の状態を推測しない。
- **対策**: article head に `data-pagefind-meta="title[content]"` の meta を置き、表示用に選定した単一 title を明示する。E2E で metadata が 1 件で JA title と一致することを確認する。
- **教訓**: 多言語表示の DOM 構造と検索 index の文書 model は分ける。indexer が読む title / filter / sort は explicit metadata で単一値を渡す。

### LL-168: 同じ data artifact を更新する migration/cache writer は共有 lock を使う
- **事象**: migration の単一 writer lock は process が `SIGKILL` されると残り続け、後続実行を永久に拒否した。一方で summary cache writer は同じ index を lock なしで更新し、migration の結果を stale snapshot で上書きできた。
- **根本原因**: lock に owner の生存判定と安全な回収手順がなく、同じ artifact を更新する writer 間でも排他 contract を共有していなかった。
- **対策**: migration と summary cache apply が同じ journal sibling lock を使う。既存 lock は schema を検証し、PID が確実に存在しない場合だけ固有 quarantine path へ atomic rename してから `wx` で再取得する。alive、権限不明、malformed lock は証拠を保持して fail-closed にする。
- **教訓**: stale lock の自動削除は競合を再導入する。dead owner の確証、atomic claim、再取得の3条件を満たす場合だけ回収し、read-modify-write の全区間を同じ ownership で囲む。

### LL-169: body-file migration は index 本文を sidecar へ移してから strip する
- **事象**: cleaner が live entry の `bodyJa` / `bodyEn` を先に空にし、その後 `data/bodies.json` を canonical alias だけで整合していたため、index にだけ残る実本文を失い得た。
- **根本原因**: 破壊的 strip が enrichment sidecar への transfer より先に実行され、reconciliation の入力にも元 index entry を渡していなかった。
- **対策**: original index entry の実 bilingual body を final live ID または canonical winner ID へ `legacy-index-migration` として mergeし、その payload を transaction に含めてから index を本文フリーにする。
- **教訓**: artifact 分離 migration は copy、検証、strip の順にする。sidecar の既存値だけでなく、破壊前の source artifact 自体を transfer 入力に含める。

### LL-170: summary 品質 gate は元記事 title を含め、全 cache apply 経路へ対称適用する
- **事象**: model response の title が翻訳されていると、summary が元記事 title の裸 echo でも response 内だけの比較では合格した。また `--force-summary` は contaminated/pending/title-echo cache を index へ強制適用できた。
- **根本原因**: 品質判定の title candidates に original entry context がなく、通常生成と cache apply、force apply が同じ validation contract を共有していなかった。
- **対策**: `hasUsableBilingualSummary` に original `title` / `titleJa` / `titleEn` を追加候補として渡し、通常生成、cache read、force apply の全経路で同じ gate を通す。不合格 cache は title、summary、importance、tags を一切適用しない。
- **教訓**: 生成物の自己整合だけでは source echo を検出できない。validation は元入力を含む end-to-end contract とし、強制オプションでも品質 gate を迂回させない。

### LL-171: 検索の Unicode 正規化と focus 復帰は script と起動経路を限定しない
- **事象**: exact search が NFKD 後に全 combining mark を削除し、日本語の濁点・半濁点まで失った。また `/` shortcut は opener を保存せず、Escape 後の focus が body に落ちた。
- **根本原因**: Latin accent folding を全 script に一律適用し、click trigger だけを search opener と仮定していた。
- **対策**: combining mark は Latin 文字に続く場合だけ除去し、他 script は保持して NFC へ戻す。keyboard shortcut は起動時の active element が到達可能なら opener として保存し、close 時に focus を復帰する。
- **教訓**: Unicode normalization は言語横断の文字削除にしない。dismissible UI の opener は click、keyboard、programmatic の全経路で記録する。

### LL-172: broad-feed の security 語彙と run severity は境界ケースを end-to-end で固定する
- **事象**: 有効な Windows Defender `0-day` 記事が Tech News の include vocabulary に一致せず migration で archive から消えた。全 source failure は audit severity では Critical なのに共有表示は Warning だった。
- **根本原因**: broad-feed の妥当な security 表現と aggregate health の全滅条件が、それぞれ単一ソースの filter/status contract に含まれていなかった。
- **対策**: registry の Tech News relevance に `0-day` / `zero-day` を追加して実タイトルを regression test に固定する。共有 run-health に `sourcesAttempted` / `sourcesOk` を渡し、fresh run でも `attempted > 0 && ok === 0` は ERR とする。
- **教訓**: filter false negative は実際に失われた title を fixture にし、severity は監査と UI が同じ aggregate telemetry から導出する。検出側だけ Critical にして表示側を Warning に残さない。

1. 作業中の「想定外の挙動」「ユーザーからの行動修正フィードバック」「ツール失敗の根本原因」を都度メモする。
2. タスク完了の **前** に、本ファイルの `📚 Lessons Learned` へ LL-XXX として追記する。恒久ルール化すべきものは `🚨 絶対ルール` に R-XXX として昇格する。
3. 古くなった LL/R は更新または削除する（誤情報を残さない）。
4. 追記・更新は **コード修正と同一 commit** に含める（persona §8.1 の 3 点セットと同じ）。
