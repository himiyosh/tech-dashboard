# 05. AI Scrum Harness 適用設計

> **目的**: 公開されている AI Scrum の考え方を `tech-dashboard` の Dev-time Harness に薄く組み込み、要件整理、実装、検証、振り返りの品質を上げる。

---

## 1. 結論

本プロジェクトには AI Scrum を適用する。ただし、Cloudflare Worker による収集や Pages deploy などの Runtime Harness には組み込まない。AI Scrum は、開発時に Copilot / Claude Code の親エージェントがオーケストレーターとなり、サブエージェント相当の専門ロールへ調査、設計、実装、検証を分担するための運用レイヤとして扱う。

採用する理由は 3 つある。

1. すでに本リポジトリは Harness Engineering と Skill / Hook / Agent の構造を前提にしている
2. 変更の完成度は、実装そのものよりも要件、受入基準、検証証跡、振り返りの抜けで落ちやすい
3. AI Scrum のロール分担は Context Engineering の `Isolate` と相性がよく、親エージェントの文脈肥大を抑えられる

---

## 2. 参照した公開情報と採用範囲

| 出典 | 確認できた要点 | 本プロジェクトで採用する形 |
|---|---|---|
| Zenn: AIエージェントだけでスクラムを回してみた | カスタムエージェントで PO / SM / Developer / Customer のロールを定義し、skill でスクラムイベントを定義する | ロールを固定し、イベント単位でサブエージェント相当の委任を行う |
| `shyamagu-ms/ai-scrum` README | `/order-create`、`/backlog-refinement`、`/sprint-planning`、`/one-day-in-scrum`、`/sprint-review`、`/sprint-retrospective` の流れが示されている | `ai-scrum` skill に tech-dashboard 用の軽量フローとして取り込む |
| Scrum Guide 2020 Japanese PDF | ロール、イベント、成果物の正式な用語参照先 | 公式用語の確認先として扱う。本文の大量引用はしない |

注意点として、`ai-scrum` README では full sprint の一括実行は experimental と説明されている。このリポジトリでも、長時間一括実行よりイベント単位または ad-hoc sprint 単位の実行を標準とする。

---

## 3. tech-dashboard 向けロール定義

| ロール | 担当 | 主な出力 |
|---|---|---|
| Human Stakeholder | ユーザー。最終判断者 | 要望、優先度、受入判断 |
| Orchestrator | 親エージェント。タスク分解、委任、統合、完了判定を担当 | 作業計画、統合方針、最終報告 |
| Product Owner | 価値、優先度、受入基準を整理 | Product Goal、PBI、受入基準 |
| Scrum Master | スコープ、DoD、阻害要因、プロセス逸脱を監視 | impediment、DoD チェック、retro |
| Developer: Data Harness | `harness/`、`worker/`、`data/`、collector / pipeline 変更 | 実装案、差分、データ検証 |
| Developer: Web | `web/`、Astro UI、検索、RSS / JSON feed 変更 | UI 実装案、画面検証 |
| QA / Verifier | Typecheck、unit、web build、E2E、quality-audit を担当 | 検証ログ、未完了リスク |
| Security / Release Guard | secret、Cloudflare、main push / merge のガード | secret scan、deploy 影響確認 |

これらは必ずしも常設ファイルとして全員を置く必要はない。小さな変更では親エージェントがロールを内包し、調査やレビューが重い場合だけサブエージェントへ isolate する。

---

## 4. 成果物マッピング

| Scrum 成果物 | tech-dashboard での置き場所 |
|---|---|
| Product Goal | README、[SPEC.md](SPEC.md)、必要に応じて `scrum/product_goal.md` |
| Product Backlog | Issue / PR checklist、または `scrum/product_backlog.md` |
| Definition of Done | [.github/copilot-instructions.md](../.github/copilot-instructions.md) の完了ゲート、README の品質ゲート、必要に応じて `scrum/definition_of_done.md` |
| Sprint Backlog | 作業中 TODO、PR body、または `scrum/sprintNNN/sprint_backlog.md` |
| Increment | コード、ドキュメント、データ、テスト、監査レポートの差分 |
| Sprint Review | 最終報告、スクリーンショット、build / test 結果 |
| Sprint Retrospective | `.github/copilot-instructions.md` の Lessons Learned、または `scrum/sprintNNN/sprint_retrospective.md` |

単発タスクでは `scrum/` 配下の成果物を必須にしない。複数セッションにまたがる変更、複数領域を同時に触る変更、またはユーザーが明示的に AI Scrum 運用を求めた場合に作成する。

---

## 5. 標準イベントフロー

### 5.1 Order Create

ユーザー要望を、変更対象、価値、完了条件、制約、未確認事項に分解する。不明点が成果物の品質に直結する場合だけ質問する。

### 5.2 Backlog Refinement

Product Owner ロールが PBI を切り出し、受入基準を明文化する。Scrum Master ロールは DoD と既存ルールへの抵触を確認する。

### 5.3 Sprint Planning

Orchestrator が今回の sprint goal を 1 文で定義し、Developer / QA / Security のどのロールを isolate するか決める。スコープは PR 1 本でレビュー可能な大きさに抑える。

### 5.4 Sprint Execution

Developer ロールが実装またはドキュメント更新を行い、QA / Verifier が検証コマンドと観点を先に決める。長い調査や大きな diff review はサブエージェントへ委任し、親は結果だけを統合する。

### 5.5 Sprint Review

受入基準、DoD、検証結果、未解決リスクを照合する。UI 変更ではスクリーンショット、データ変更では quality-audit、deploy 影響では Cloudflare Pages の公開 URL 確認を含める。

### 5.6 Sprint Retrospective

同じミスが再発しそうな学びを `.github/copilot-instructions.md` または該当 skill に残す。単なる感想ではなく、次回の行動を変えるルールだけを記録する。

---

## 6. Definition of Done

AI Scrum を使うタスクは、少なくとも以下を確認する。

| 観点 | 完了条件 |
|---|---|
| Branch | `main` / `master` / `develop` で直接作業していない |
| Scope | sprint goal と受入基準に含まれない変更を混ぜていない |
| Docs | ファイル追加、構成変更、skill 追加時に README / docs を同期している |
| Validation | 変更に応じて `npm run typecheck`、`npm test`、`npm run build:web`、`npm run test:e2e`、`quality-audit` を選択して実行している |
| Security | secret を表示、保存、commit していない。必要に応じて `npm run secrets:scan` を実行している |
| Release | main merge / push、Cloudflare deploy、Worker deploy は明示承認なしに実行していない |
| Retrospective | 新しい再発防止ルールが必要な場合、同じセッションで instruction / skill に反映している |

---

## 7. 使い分け

| タスク種別 | 推奨フロー |
|---|---|
| 誤字修正、単一行修正 | AI Scrum は使わず通常対応 |
| 単一ファイルの小変更 | ad-hoc sprint。PO / QA 観点だけを軽く通す |
| 複数ファイル変更、仕様変更 | `ai-scrum` skill で Planning から Review まで実行 |
| UI / data / worker / docs が跨る変更 | PO、Developer、QA、Security を分離してレビュー |
| 長時間の調査、品質監査 | 既存の `quality-audit` skill または探索サブエージェントを先に使う |

---

## 8. 今後の拡張

1. `.claude/agents/` に PO / SM / QA などの常設 persona を追加する
2. `scrum/` 配下に長期 sprint 用の template を追加する
3. `ai-scrum` skill から `quality-audit`、secret scan、web build を明示的に呼び出す手順を強化する
4. Sprint review 用に Playwright screenshot と公開 URL check をまとめた report generator を追加する

現時点では、まず skill と設計ドキュメントだけを追加し、過度な常設 scaffolding は作らない。これは本プロジェクトの「薄く、置換可能、検証可能」という Harness Engineering 原則に合わせるためである。