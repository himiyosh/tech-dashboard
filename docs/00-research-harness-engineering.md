# 00. Harness Engineering リサーチサマリ

> **目的**: 本プロジェクトの設計に先立ち、Anthropic / OpenAI / 実務コミュニティが 2025-2026 に体系化した「Harness Engineering」のイロハを整理し、設計原則として採用する根拠を明確化する。

---

## 1. 用語定義 - そもそも Harness とは

### Agent = Model + Harness

> An agent equals a model plus a harness. The harness is every piece of code, configuration, and execution logic that is not the model itself. - *Decoding AI, "Agentic Harness Engineering"*

Harness (馬具の「ハーネス」) は、LLM というエンジンに接続されるすべてのスキャフォールディング。具体的には:

- ツール実行ロジック
- メッセージ履歴管理
- コンテキストウィンドウ管理
- サンドボックス / 権限制御
- メモリシステム (セッション横断)
- オーケストレーション (サブエージェント起動、計画ループ)
- 配信レイヤ (サーバ、UI、ログ)

### 3 段階のエンジニアリング

| 段階                    | スコープ     | 担当するもの                     |
| ----------------------- | ------------ | -------------------------------- |
| **Prompt Engineering**  | 1 回の推論   | 指示文の書き方                   |
| **Context Engineering** | 1 セッション | モデルが見るものの管理           |
| **Harness Engineering** | システム全体 | インフラ・ループ・ツール・メモリ |

プロンプトエンジニアリングだけでは長期タスクに対応できないため、2025 年以降 Harness Engineering が新しい工学領域として確立された。

---

## 2. 原典

本設計で参照する一次情報:

| 出典                                                                          | 内容                                    | URL                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| Anthropic "Effective harnesses for long-running agents" (2025-11)             | Initializer + Coding agent パターン     | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| Anthropic "Harness design for long-running application development" (2026-03) | 長時間アプリ開発向けハーネス設計        | https://www.anthropic.com/engineering/harness-design-long-running-apps            |
| Anthropic "Effective context engineering for AI agents"                       | Reduce / Offload / Isolate              | https://www.anthropic.com/engineering                                             |
| OpenAI "Harness Engineering" (2026-02)                                        | 3 名で 100 万行を書かないで出荷した事例 | https://openai.com/index/harness-engineering/                                     |
| Claude Code Docs - Skills / Hooks / Subagents                                 | 4 層スタックの仕様                      | https://docs.claude.com                                                           |
| "The Bitter Lesson" (Rich Sutton)                                             | モデル進化に合わせたアーキ再構築論      | -                                                                                 |

---

## 3. 採用する 5 原則

### 原則 1: Context Engineering - Reduce / Offload / Isolate

**Context rot** (コンテキスト肥大による指示追従性低下) はミリオントークンでも発生する。以下を徹底:

- **Reduce**: 古いツール結果は要約に置換。Trajectory summarization を閾値到達時に実行
- **Offload**: 大きな成果物はファイルシステムへ。アクションスペースも offload (100 個のツールより bash 1 つ)
- **Isolate**: トークンを食うサブタスクはサブエージェントに委任、結果のみを親に返す

### 原則 2: Initializer + Worker パターン

長期タスクは「1 回目の特別な文脈」と「反復ワーカー」に分離:

- **Initializer**: 環境セットアップ、`init.sh`、進捗ログファイル、初回コミット
- **Worker (Coding agent 相当)**: 1 セッション 1 機能、毎回アーティファクトを残す
- **Handoff artifacts**: 次セッションが文脈復元できる成果物 (progress.md、commit log、test report)

### 原則 3: Workflows vs Agents - 使い分け

| 種別                          | 用途                               | 本プロジェクトでの適用     |
| ----------------------------- | ---------------------------------- | -------------------------- |
| **Workflow** (予定された手順) | テスト実行、移行、定期バッチ       | ソース収集・正規化・公開   |
| **Agent** (自律判断)          | オープンエンドなリサーチ、デバッグ | 新ソース発見、要約品質向上 |

**Start simple**: まず Workflow。開放性が必要になったら Agent 化する。

### 原則 4: Verifier's Law

> 成功が検証可能なタスクは解きやすい

すべての成果物に自動検証を埋め込む:

- 収集: スキーマバリデーション、URL 到達性
- 正規化: 必須フィールド、日付妥当性
- 公開: ビルド成功、リンクチェック、Lighthouse

検証不能な成果物は出力しない (= Hook で blocking)。

### 原則 5: Bitter Lesson への備え

モデル進化が早い (2026 年時点でタスク長が 7 ヶ月毎に倍増)。ハーネスは:

- シンプルに保つ。過度なスキャフォールドはモデル進化で逆効果になる
- 定期的に剥がす (Manus は 8 ヶ月で 5 回リアーキ、Anthropic も Claude Code harness を削る)
- モデル依存の指示を避け、ツールとプロトコルで組む

---

## 4. Claude Code の 4 層スタック (採用モデル)

本プロジェクトは Claude Code / GitHub Copilot の両方で動かせるように、4 層を意識して構成する:

| 層         | ファイル                                        | 役割                                      | 起動               |
| ---------- | ----------------------------------------------- | ----------------------------------------- | ------------------ |
| **Memory** | `CLAUDE.md` / `.github/copilot-instructions.md` | 常にロードされる静的知識                  | 毎セッション       |
| **Skills** | `.claude/skills/*/SKILL.md`                     | 反復ルーチン (コマンド化)                 | ユーザ or 自動呼出 |
| **Hooks**  | `.claude/hooks/*.sh` + `settings.json`          | 決定論的な強制 (バリデーション、ロギング) | イベント駆動       |
| **Agents** | `.claude/agents/*.md`                           | 並列・隔離コンテキストでの委任            | 親から起動         |

**使い分けの判断フレーム:**
- 常に知っていてほしい → Memory
- 毎回同じ手順 → Skills
- 必ず守らせたい (確率ではなく確定) → Hooks
- 並列処理 / 別コンテキストが欲しい → Agents

---

## 5. 本プロジェクトへの含意

AI エコシステムの「更新情報ポータル」は、Harness Engineering の典型ユースケース:

1. **多ソース長期稼働**: 10+ ソースを毎日クロール → 長時間 / 反復ジョブ
2. **Context rot リスク**: ソースが増えるほど 1 エージェントの文脈が肥大 → **Isolate (サブエージェント per ソース)** 必須
3. **検証可能性**: 記事 URL、日付、タイトルは機械検証可能 → **Verifier's Law** で品質ガード
4. **アーキ陳腐化リスク**: LLM 進化で要約品質が毎月変わる → **シンプルな harness + 置換可能なモデル** が必須

よって本プロジェクトは「**薄く**、**置換可能**、**検証可能**」を設計指針とする。

---

## 6. アンチパターン (避けるもの)

| アンチパターン                        | 根拠                             |
| ------------------------------------- | -------------------------------- |
| 100 ツールを 1 エージェントに詰め込む | プロンプト肥大、context rot      |
| 全履歴を毎回渡す                      | トークン浪費、指示追従性低下     |
| LLM の出力をそのまま公開              | Verifier's Law 違反、品質ブレ    |
| モデル固有の裏技に依存                | 次モデルで壊れる                 |
| Hook なしで「自律」に期待             | 決定論が必要な場所で確率に賭ける |

---

## 7. 次のドキュメントへ

→ [01. システム設計書](01-architecture.md) で本原則をどう具体化するかを定義する。
