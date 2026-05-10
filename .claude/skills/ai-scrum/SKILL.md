---
description: tech-dashboard の開発タスクを AI Scrum 形式で整理し、オーケストレーターが専門ロールへ分担して成果物を検証する
---

# AI Scrum - tech-dashboard

## 目的

`tech-dashboard` の開発タスクを、軽量な Scrum イベントとして進める。親エージェントは Orchestrator として振る舞い、必要に応じて Product Owner、Scrum Master、Developer、QA / Verifier、Security / Release Guard の観点をサブエージェント相当へ isolate する。

この skill は Runtime Harness ではなく Dev-time Harness 用である。Cloudflare Worker の収集処理や Pages deploy 経路は変更しない。

## 起動条件

次のいずれかに該当する場合に使う。

- ユーザーが AI Scrum、スクラム、オーケストラ、サブエージェント連携を求めている
- 複数ファイル、複数領域、または仕様変更を含むタスクである
- 実装だけでなく、要件、受入基準、検証、振り返りまで残す必要がある
- 調査、実装、QA、security / release guard を分けたほうが品質が上がる

小さな誤字修正や単一行修正では使わない。

## 基本原則

1. 親エージェントが最終責任を持つ。サブエージェントの結論はそのまま採用せず、親が統合する
2. 長い調査、大きな diff review、独立した QA は isolate する
3. すべての PBI に受入基準と検証方法を持たせる
4. Definition of Done は [.github/copilot-instructions.md](../../../.github/copilot-instructions.md) と README の品質ゲートを優先する
5. main merge / push、Cloudflare deploy、Worker deploy はユーザーの明示承認なしに実行しない
6. 新しい再発防止ルールが必要な場合は、完了前に instruction / skill / docs へ反映する

## ロール

| ロール | 責務 |
|---|---|
| Orchestrator | ブランチ確認、要件整理、サブエージェント委任、差分統合、完了判定 |
| Product Owner | 価値、優先度、PBI、受入基準を定義する |
| Scrum Master | DoD、スコープ、阻害要因、プロセス逸脱を確認する |
| Developer: Data Harness | `harness/`、`worker/`、`data/`、collector / pipeline を担当する |
| Developer: Web | `web/`、Astro UI、RSS / JSON Feed、検索体験を担当する |
| QA / Verifier | typecheck、unit、web build、E2E、quality-audit、公開 URL check を担当する |
| Security / Release Guard | secret scan、Cloudflare 影響、main push / merge guard を担当する |

## イベントフロー

### 1. Order Create

- ユーザー要望を 1 から 3 個の PBI に分解する
- 価値、変更対象、制約、未確認事項を整理する
- 不明点が品質に直結する場合だけ質問する

### 2. Backlog Refinement

- Product Owner 観点で PBI と受入基準を作る
- Scrum Master 観点で DoD、既存ルール、スコープ過多を確認する
- タスクが大きい場合は、PR 1 本でレビュー可能な単位へ分割する

### 3. Sprint Planning

- Sprint Goal を 1 文で書く
- 対象ファイル、影響範囲、検証コマンドを決める
- どのロールをサブエージェントへ isolate するか決める
- `main` / `master` / `develop` では作業しない。必要なら作業ブランチを作る

### 4. Sprint Execution

- 既存パターンを読んでから最小差分で変更する
- 実装と docs / README / instruction 同期を同じタスク内で行う
- サブエージェント結果は要点だけを親に戻し、親が最終判断する

### 5. Sprint Review

- PBI の受入基準を 1 つずつ照合する
- 変更に応じて検証を実行する
- 検証できなかった項目は完了扱いにせず、理由と代替確認を記録する

### 6. Sprint Retrospective

- 再発しそうな問題、ユーザーからの行動修正、ツール失敗の根本原因を列挙する
- 未記録の学びがあれば `.github/copilot-instructions.md` または該当 skill に追記する
- レトロを完了してから final / task_complete に進む

## 標準 DoD

| 観点 | チェック |
|---|---|
| Branch | 作業ブランチ上で変更している |
| Scope | 受入基準外の変更が混ざっていない |
| Build | `npm run typecheck` と `npm run build:web` を基本ゲートにする |
| Test | 実装変更では関連 unit / E2E を実行する |
| Data | `data/index.json` や collector 変更では `quality-audit` を検討する |
| Security | secret を出力していない。必要に応じて `npm run secrets:scan` を実行する |
| Docs | README、docs、instruction、skill の同期漏れがない |
| Retrospective | 新しい学びを完了前に恒久化している |

## 出力フォーマット

作業開始時は短く提示する。

```markdown
## AI Scrum Planning

- Sprint Goal: ...
- PBI: ...
- Acceptance Criteria: ...
- Roles: ...
- Verification: ...
```

完了時は以下を報告する。

```markdown
## Sprint Review

| 項目 | 状態 | 詳細 |
|---|---|---|
| 受入基準 | ✅ | ... |
| 検証 | ✅ | ... |
| Docs 同期 | ✅ | ... |
| Retrospective | ✅ | ... |

**サマリ**: 全件 ✅ OK
```

## 参照

- [docs/05-ai-scrum-harness.md](../../../docs/05-ai-scrum-harness.md)
- [docs/02-agents-skills-hooks.md](../../../docs/02-agents-skills-hooks.md)
- [.github/copilot-instructions.md](../../../.github/copilot-instructions.md)