# tech-dashboard — Copilot 運用ルール / 自己学習ハーネス

このリポジトリで Copilot / agent が作業する際の絶対ルールと、過去事象から得た Lessons Learned を集約する。
新しい知見を得たら **同一セッション内で本ファイルに追記** すること（ユーザーから指摘される前に行う）。

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

### R-007: 記事要約 / 補完 backfill のモデルは Opus 4.7 または GPT-5.5 に限定する
- 通常要約も補完/backfill も `SUMMARIZE_MODEL` は `claude-opus-4.7` または `gpt-5.5` のみ使用する。
- `gpt-4o` は記事要約 / 補完 backfill の代替モデルとして使用しない。
- 長文生成が詰まる場合は、max_tokens / timeout / concurrency を調整し、それでも必要な場合のみ `gpt-5.5` へ切り替える。`gpt-5.5` は Copilot endpoint で利用可能か小 batch で事前確認する。

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

---

## 🧪 完了ゲート (LL Hook)

タスクを「完了」と報告する前に、以下を **必ず実行** すること。

1. ✅ `npm --prefix web run build` がローカルで PASS する
2. ✅ Cloudflare Pages の最新 production deployment が `latest=deploy status=success`
3. ✅ `https://techdb.studio344.net/` と `https://tech-dashboard-6a7.pages.dev/` が `200`
4. ✅ 変更内容に応じて README / docs / 本ファイル (LL) を同一 commit で更新
5. ✅ 推論禁止ゲート: 出典のない断定を出力に含めない

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

---

## 🔄 自己学習ハーネス手順

1. 作業中に発生した「想定外の挙動」「ユーザーからの行動修正フィードバック」「ツール失敗の根本原因」を都度メモする。
2. タスク完了の **前** に、本ファイルの `📚 Lessons Learned` に LL-XXX として追記する。
3. ルールとして恒久化すべきものは `🚨 絶対ルール` に R-XXX として昇格する。
4. 既存 LL/R が古くなったら更新または削除する（誤情報を残さない）。
5. 追記/更新は **コード修正と同一 commit** に含める (Main.instructions.md G-1 準拠)。
