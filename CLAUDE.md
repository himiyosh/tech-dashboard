# Project memory

<!-- agentic-rules:begin -->
<!-- Managed by the agentic-rules bundle (platform: claude-code, profile: core). -->
<!-- Do not hand-edit inside this block. Re-copy from the pinned source ref instead. -->

## 常時適用ルール

組織非依存の安全契約、work cycle、validation、evidence は `.claude/rules/agentic-core.md` にあり、
Claude Code が launch 時に自動ロードする。**このファイルから import しない。**
`@` import は working directory の外を指すと承認ダイアログの対象になり、一度拒否すると恒久的に無効化されるため、
安全契約をそこへ依存させない。

## 詳細ルール（Progressive Disclosure。常時ロードしない）

以下は**読み込まない**。表の「いつ読むか」に該当する作業へ入る直前に、その 1 ファイルだけを読む。
すべてこのプロジェクト内の相対パスであり、bundle の配布時に実体がコピーされる。

| いつ読むか | パス |
| --- | --- |
| 実装方針、検証、ブランチ運用、依存、Web スタックの判断に迷った時 | `.claude/knowledge/agentic-rules/agentic-engineering-rules.md` |
| 応答スタイル、自己改善、エンコーディング、MCP の扱いを確認する時 | `.claude/knowledge/agentic-rules/agent-persona-rules.md` |
| 出典付き調査、RAG、ナレッジ検索エージェントを設計・実装する時 | `.claude/knowledge/agentic-rules/agentic-knowledge-system-rules.md` |
| bounded loop、graph/DAG workflow、checkpoint、HITL を設計する時 | `.claude/loop-graph-engineering.instructions.md` |

profile によっては配布されないファイルがある。存在しないパスは無視し、不足を推測で補わない。

<!-- agentic-rules:end -->

## このプロジェクト固有のルール

このプロジェクトだけに効く絶対制約をここに書く。上の共通ルールと重複する一般論は書かない。

- 導入元 ref: `v0.6.1` (`5792d8bb3ea23d3812e10c5b7f4ced214ac73753`)
- 導入 profile: `core`（platform: `claude-code`）
