# 02. Agent / Skill / Hook / Prompt 構成

> **現状**: Runtime は Cloudflare Worker + Queue + Cloudflare Pages Git Integration で完結する。GitHub Actions は CI のみで、harness 実行や deploy 経路には使わない。Dev-time は `.github/copilot-instructions.md`、`.claude/skills/*`、`scripts/git-hooks/*` を中心に運用する。
>
> **注意**: `.github/prompts/`、`.claude/agents/`、`.claude/hooks/` は導入候補 / 設計パターンとして扱う。実装済みの source of truth は以下の現状マップを優先する。

---

## 1. 全体マップ

```
tech-dashboard/
├─ .github/
│  ├─ copilot-instructions.md       ← Memory 層 (Copilot)
│  ├─ prompts/                     ← 任意: Copilot CLI prompt 化する場合
│  └─ workflows/
│     └─ ci.yml                     ← 検証のみ。deploy / harness 実行はしない
│
├─ .claude/
│  ├─ CLAUDE.md                     ← 任意: Claude Code Memory
│  ├─ settings.json                 ← 任意: Claude hooks 設定
│  ├─ agents/                       ← 任意: Claude subagents
│  │  ├─ source-researcher.md
│  │  ├─ ui-designer.md
│  │  └─ quality-auditor.md
│  ├─ skills/                       ← Skills (SKILL.md)
│  │  ├─ ai-scrum/
│  │  ├─ ui-display-guard/
│  │  ├─ modern-web-guidance/
│  │  └─ quality-audit/
│  └─ hooks/                        ← 任意: Claude hooks。現状は scripts/git-hooks/ を使用
│
└─ harness/                         ← Runtime Harness 本体
   ├─ orchestrator.ts               ← Outer loop
   ├─ collectors/
   │  ├─ anthropic-blog.ts
   │  ├─ github-changelog.ts
   │  └─ ...
   ├─ pipeline/
   │  ├─ normalize.ts
   │  ├─ dedupe.ts
   │  ├─ summarize.ts               ← ローカル backfill 用 Copilot 呼出
   │  └─ tag.ts
   └─ publishers/
      ├─ index-builder.ts
      └─ rss-builder.ts
```

### 1.1 現状インベントリ

| 種別 | 実装 | 備考 |
|---|---|---|
| 常時 instruction | `.github/copilot-instructions.md` | tech-dashboard 固有の絶対ルール / LL |
| User-level instruction | VS Code User `Main.instructions.md` | 全プロジェクト共通の応答スタイル |
| Prompts | `.github/prompts/quality-audit.prompt.md`, `worker-health.prompt.md` | 単発の監査 / Worker health 確認を slash prompt 化 |
| Skills | `.claude/skills/ai-scrum`, `quality-audit`, `ui-display-guard`, `modern-web-guidance` | `modern-web-guidance` は `skills-lock.json` で外部 skill として追跡。local skills はリポジトリ内ファイルを source of truth とする |
| Git hooks | `scripts/git-hooks/pre-commit`, `pre-push` | secret scan / typecheck / unit / web build / E2E / Worker deploy opt-in |
| CI | `.github/workflows/ci.yml` | dependency audit は soft gate。deploy は行わない |
| Runtime | `worker/`, `worker-summarizer/` | Cloudflare cron + Queue consumer |

---

## 2. Runtime Harness (Cloudflare Worker + Queue)

### 2.1 Orchestrator (ハーネス中枢)

**責務**: Initializer + Worker パターンを踏襲。ローカルでは `npm run collect` / `npm run collect:dry`、本番では Cloudflare Worker cron が同系統の collector / pipeline を実行する。要約生成は Queue consumer に分離する。

```ts
// harness/orchestrator.ts (擬似コード)
async function run() {
  const runId = new Date().toISOString();
  const stateFile = "data/_state.json";

  // Initializer: 初回のみ
  if (!exists(stateFile)) {
    await initialize();           // schema 作成、feeds 雛形、progress.md
  }

  // Worker: 各サイクル
  const sources = loadSourceRegistry();
  const results = await Promise.allSettled(       // ← 原則 1: Isolate
    sources.map(s => collectWithTimeout(s, 60_000))
  );
  const raw = results.filter(ok).flatMap(r => r.value);

  const normalized = raw.map(normalize);          // 決定論的
  const deduped = dedupe(normalized);
  const contentReady = applyDeterministicFallback(deduped);
  const queued = await enqueueMissingSummaries(contentReady); // Queue

  await publish(contentReady);
  await writeRunLog(runId, { queued });     // 可観測性
}
```

**Hook ポイント (Node 内)**:
- 各 collector の前後で URL / schema バリデーション
- Queue 投入前に deterministic fallback / cache / subrequest budget を確認
- Publish 前に `index.json` の形式検証 (Zod)

### 2.2 CI と Runtime の分離

GitHub Actions は `.github/workflows/ci.yml` の検証用途だけに限定する。`harness-daily.yml` や deploy job は作らない (R-001)。

以下は旧設計案であり、現在は採用しない。

```yaml
# .github/workflows/harness-daily.yml
name: Harness - Daily
on:
  schedule: [{ cron: "0 */6 * * *" }]
  workflow_dispatch:
concurrency: { group: harness, cancel-in-progress: false }

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run collect
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Validate output          # ← 決定論的 Hook 相当
        run: npm test
      - name: Commit & push
        run: |
          git config user.name "harness-bot"
          git config user.email "harness-bot@users.noreply.github.com"
          git add data/
          git diff --staged --quiet || git commit -m "chore(data): $(date -u +%FT%TZ) update"
          git push
```

---

## 3. Prompts (一次情報ソースの処方箋)

### 3.1 Summarize Prompt (`.github/prompts/summarize.prompt.md`)

```markdown
# Summarize AI Ecosystem Update

You are a Japanese technical news summarizer.

## Input
- title (原文)
- body (原文、最大 4000 字)
- source (ソース名)
- url

## Output (JSON only, no prose)
{
  "titleJa": "日本語タイトル (40字以内、原文が日本語なら原文をそのまま)",
  "summaryJa": "要約 (120字以内、1-2文、断定は出典にある事実のみ)",
  "importance": 1 | 2 | 3,
  "suggestedTags": ["..."]
}

## Rules (ABSOLUTE)
- 推論で断定しない。body に無い情報を追加しない
- 誇張表現 (「革命的」「画期的」) を避ける
- 絵文字・em dash (---) を使わない
- 不確実な情報は要約に含めない
- importance: 3=新モデル/メジャーリリース, 2=機能追加, 1=改善/小さな変更
```

**原則 4 適用**: 出力は JSON スキーマで検証可能 (Verifier's Law)。

### 3.2 Tag Prompt / Collect Prompt も同様に小型・単一責務で作成。

---

## 4. Dev-time Harness: Memory (CLAUDE.md / copilot-instructions.md)

### 4.1 `.claude/CLAUDE.md` (例)

```markdown
# tech-dashboard - Claude Code Memory

## プロジェクト概要
AI エコシステムアップデートの集約ポータル。ハーネスエンジニアリング準拠。

## 設計原則 (MUST)
1. Context Engineering: Reduce / Offload / Isolate
2. Workflow を Agent より優先する
3. すべての成果物は検証可能にする (Verifier's Law)
4. ハーネスはシンプルに保つ (Bitter Lesson)

## コード規約
- TypeScript strict: true
- 1 collector = 1 ファイル、外部依存は最小
- LLM 呼出は harness/pipeline/ にのみ存在
- データは data/ 配下の JSON のみ (DB 禁止)

## 禁止事項
- API キーのコミット
- LLM 出力の未検証コミット
- dev データ (data/raw/) の git ignore 忘れ

## よく使うコマンド
- `npm run collect:dry` - LLM 呼出なしで pipeline を走らせる
- `npm test` - data schema / quality audit / pipeline を検証
- `npm --prefix web run dev` - Astro dev server
```

### 4.2 `.github/copilot-instructions.md` は上記を Copilot 向けに再記述 (内容は揃える)。

---

## 5. Dev-time Harness: Skills

> **Skill の原則**: YAML frontmatter に `use when` を明記し、auto-invocation を効かせる。Skill は 1 目的 1 ファイル、500 行以内。

### 5.1 `add-source` — 新ソース追加

```markdown
---
name: add-source
description: Use when user asks to add a new AI update source (RSS, GitHub repo, blog).
---

# Add Source Skill

## Steps
1. ソースの URL を確認。RSS があれば優先、なければ HTML スクレイプ
2. `harness/collectors/<source-id>.ts` を作成 (既存ファイルを雛形にコピー)
3. `harness/collectors/registry.ts` に登録
4. `npm run collect:dry` でローカル動作確認
5. 収集件数・スキーマ検証結果を報告
6. docs/01-architecture.md の 1.3 表にソースを追記
```

### 5.2 その他の Skills

| Skill             | use when                            | 効果                                             |
| ----------------- | ----------------------------------- | ------------------------------------------------ |
| `ai-scrum`        | 複数領域の開発 / 要件整理から検証まで必要 | PO / SM / Developer / QA 観点を分けて成果物を検証 |
| `ui-display-guard` | モバイル / レスポンシブ UI の表示崩れ修正 | viewport 寸法、固定 UI、overflow、導線操作を Playwright で検証 |
| `modern-web-guidance` | HTML / CSS / client-side JS / アクセシビリティ / パフォーマンス / セキュリティの実装 | Chrome Modern Web Guidance の use case を search / retrieve し、Baseline、fallback、基礎 guide を確認 |
| `re-summarize`    | 要約の品質が悪い / プロンプト変更時 | 指定期間のエントリを再要約                       |
| `audit-quality`   | 週次 / 月次レビュー                 | ランダムサンプル 20 件を人手監査用にエクスポート |
| `debug-collector` | Collector が 0 件 / エラー時        | ネットワーク、セレクタ、レート制限を順に切り分け |

---

### 5.3 Chrome Modern Web Guidance の適用ルール

- プロジェクトには `.claude/skills/modern-web-guidance/` を同梱し、`skills-lock.json` で `GoogleChrome/modern-web-guidance` を追跡する。
- Web UI 変更では、実装目的を 1 文にして `npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_05_16-c5e7870` を先に実行する。
- 検索結果の該当 guide は `npx -y modern-web-guidance@latest retrieve "<id>"` で読み、Astro / CSS の既存構成に最小差分で適用する。
- 広めの UI / CSS / パフォーマンス / セキュリティ変更では `accessibility`、`css`、`performance`、`security` を基礎 guide として確認する。
- Baseline Widely available ではない機能は guide の fallback 方針に従う。mobile / fixed / sticky / overflow / z-index / safe-area の表示崩れを伴う場合は `ui-display-guard` も併用する。

---

## 6. Dev-time Harness: Subagents

> **Subagent の原則**: 親エージェントの文脈を汚染しない。トークン重いタスクは必ず isolate (原則 1)。

### 6.1 `source-researcher`

**役割**: 「この AI ツールの新しいソースを探して」という曖昧な指示に対し、Web 検索・GitHub 検索・RSS 発見を並列実行し、候補リストだけを親に返す。

```markdown
---
name: source-researcher
description: Research new information sources for AI tools. Returns candidate list only.
tools: [web_search, github_search, fetch_url]
---

You are a source-discovery specialist. Given a topic (e.g., "local LLM tooling"):
1. Search: blog, newsletter, GitHub org, changelog
2. For each candidate: verify RSS/API availability, update frequency (last 3 posts)
3. Return JSON list: [{ name, url, feedUrl, type, updateFrequency, signalToNoise }]

Do NOT suggest sources with < 1 post/month or > 80% non-AI content.
Do NOT return a long narrative - JSON list only.
```

### 6.2 `ui-designer`

デザイントークン、コンポーネント構成、アクセシビリティの提案を行う専門エージェント。(詳細は 03. UI/UX ドキュメント参照)

### 6.3 `quality-auditor`

生成済み要約の品質監査専門。hallucination 検知、翻訳精度、タグ適合性をレポート。

### 6.4 AI Scrum ロール

AI Scrum を使うタスクでは、親エージェントが Orchestrator として振る舞い、必要に応じて以下のロールを isolate する。

| ロール | isolate する場面 |
|---|---|
| Product Owner | 要望を PBI と受入基準に落とすとき |
| Scrum Master | DoD、スコープ過多、阻害要因を確認するとき |
| Developer: Data Harness | `harness/`、`worker/`、`data/` の変更を扱うとき |
| Developer: Web | `web/`、Astro UI、Feed / search 体験を扱うとき |
| QA / Verifier | typecheck、unit、web build、E2E、quality-audit の検証計画を作るとき |
| Security / Release Guard | secret、Cloudflare、main merge / push 影響を確認するとき |

詳細は [05. AI Scrum Harness 適用設計](05-ai-scrum-harness.md) と `.claude/skills/ai-scrum/SKILL.md` を参照する。

---

## 7. Dev-time Harness: Hooks (決定論的ゲート)

> **Hooks の原則**: エージェントの「うっかり」を確定で防ぐ。確率ではなく決定論。

### 7.1 `settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "./.claude/hooks/pre-tool-validate.sh" }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "command": "./.claude/hooks/post-edit-schema-check.sh" }
    ],
    "Stop": [
      { "command": "./.claude/hooks/stop-verify-tasks.sh" }
    ]
  }
}
```

### 7.2 実装する Hooks

| Hook                        | 発火                | 目的                                                                    | Block 条件                            |
| --------------------------- | ------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| `pre-tool-validate.sh`      | Bash 実行前         | 危険コマンド拒否 (`rm -rf`, `git push --force`, credential を含む echo) | exit 2                                |
| `post-edit-schema-check.sh` | Edit/Write 後       | `data/normalized/*.json` 編集時は Zod schema で検証                     | schema 違反で exit 2                  |
| `stop-verify-tasks.sh`      | セッション終了前    | TODO 未完 / テスト未実行 / lint エラーを検出                            | 未完了なら continue_reason で再開要求 |
| `pre-commit-secret-scan.sh` | pre-commit (git 側) | API キー漏洩防止                                                        | 検出で reject                         |

### 7.3 Hook の責務範囲

Hook は **速く、依存を持たず、冪等** であること。LLM を呼ばない。失敗しても親を壊さない。

---

## 8. 層の使い分け判断フロー (Decision Flow)

```
「やりたいこと」を以下の順に当てはめる:

1. ほぼ毎セッションで必要な知識か?
   → YES: Memory (CLAUDE.md / copilot-instructions.md)

2. 毎回同じ手順で再現したいか?
   → YES: Skills (SKILL.md + auto-invoke description)

3. 確率ではなく 100% 強制したいか?
   → YES: Hooks (settings.json + shell script)

4. 親の文脈を汚さずに並列・隔離で実行したいか?
   → YES: Subagents (.claude/agents/*.md)

5. 本番で決定論的に走らせたいか?
   → YES: Runtime Harness (Cloudflare Worker + Queue + orchestrator.ts)

それ以外 → ユーザとの対話で都度対応 (プロンプトのみ)
```

---

## 9. 原則へのマッピング

| 原則                     | 本構成での実装                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| **Reduce**               | Orchestrator は件数を絞って LLM に渡す。Summarize は 1 件 ≤ 4000 字            |
| **Offload**              | 生データ / 過去ログは `data/raw/` にファイルとして。プロンプトに入れない       |
| **Isolate**              | Subagents / Collector プロセス分離 / Summarize は 1 件ずつ                     |
| **Initializer+Worker**   | `orchestrator.ts` が state 無しを検知して init、以後 worker                    |
| **Verifier's Law**       | Zod schema + Hook + LLM 出力の JSON 検証                                       |
| **Simple & Replaceable** | LLM は抽象インタフェース (Claude → OpenAI 差替可)、DB なし、フレームワーク最小 |

---

## 10. 次のドキュメントへ

→ [03. UI/UX デザイン案](03-design-mockup.md) で画面設計を定義する。
