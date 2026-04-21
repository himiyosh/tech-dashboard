# Tech Dashboard - AI Ecosystem Update Portal

AI 関連アップデート (Copilot / Claude / Codex / Gemini / Cursor / Cline / Aider / VSCode / OpenCode / Local LLM / Agent FW / MCP / Research の **13 カテゴリ**) を **一括で追跡** できるポータルサイト。Harness Engineering のプラクティスに沿って、AI エージェントが自律的に情報収集・正規化・公開を行う。

**現状**: Phase 1〜4 完了 — 31 ソース (Tier 1 / 2 / 3) を自動収集、Astro 静的サイト生成、RSS/JSON Feed 配信、GitHub Copilot Enterprise (Claude Opus 4.7) による要約パイプライン、Pagefind 全文検索、品質監査 Skill、ユーザ OPML カスタマイズ基盤まで動作可能です。

## ドキュメント構成

| #   | ドキュメント                                                            | 概要                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 00  | [Harness Engineering リサーチ](docs/00-research-harness-engineering.md) | Anthropic / OpenAI の原典を元にした原則整理  |
| 01  | [システム設計書](docs/01-architecture.md)                               | アーキテクチャ・データモデル・データフロー   |
| 02  | [Agent / Skill / Hook / Prompt 構成](docs/02-agents-skills-hooks.md)    | ハーネスの内部構成と責務分割                 |
| 03  | [UI/UX デザイン案](docs/03-design-mockup.md)                            | 画面構成・ワイヤーフレーム・デザイントークン |
| 04  | [サイト仕様書 v1.0](docs/04-site-spec.md)                               | 13 カテゴリ / 30 ソース / 画面別仕様         |
| 02c | [ユーザカスタマイズ](docs/02-customization.md)                          | OPML / YouTube / HN クエリの追加方法         |

モック: [`docs/mockups/`](docs/mockups/) (mockup-D が確定デザイン)

## クイックスタート

```bash
# ============ ハーネス (ルート) ============
npm install                  # 依存インストール
npm run typecheck            # 型チェック
npm run collect              # 31 ソース収集 → data/index.json 生成
npm run collect:dry          # ドライラン (ファイル書き込みなし)

# ============ Web サイト ============
cd web
npm install
npm run dev                  # http://localhost:4321 で開発サーバ
npm run build                # dist/ に静的ビルド + Pagefind インデックス

# ============ 品質監査 ============
npx tsx .claude/skills/quality-audit/run.ts
#   → data/_runs/audit-<ts>.md に Markdown レポート出力
```

### 環境変数 (要約パイプライン)

要約は **GitHub Copilot Enterprise** の Chat Completions API 経由で Claude Opus 4.7 を呼び出します (GitHub Models とは別体系)。

#### GitHub Actions での設定

1. Copilot Enterprise 権限のあるアカウントで **Classic PAT** を発行 (scope: `read:user` で十分)
2. リポジトリの **Settings → Secrets → Actions** で `COPILOT_PAT` として登録
3. (任意) **Variables** で `SUMMARIZE_MODEL` を設定 (既定 `claude-opus-4.7`、他に `claude-opus-4.6` / `claude-sonnet-4.5` / `gpt-4o` 等)

```bash
# ローカル実行用 (いずれか片方)
COPILOT_PAT=ghp_...               # PAT → 一時トークン交換を自動で行う
COPILOT_TOKEN=tid=...              # 既に交換済みの一時トークンを直接注入する場合

# モデル切替
SUMMARIZE_MODEL=claude-opus-4.7    # 既定
SUMMARIZE_MAX_NEW=15               # 1 ラン当たりの新規要約上限
```

> どのトークンも無ければ要約フェーズは自動でスキップされます (ローカル dev を妨げない設計)。

## プロジェクト構造

```
tech-dashboard/
├─ docs/                     # 設計ドキュメント
│  └─ mockups/               # HTML モック (mockup-D が確定)
├─ harness/                  # ハーネス本体 (TypeScript)
│  ├─ orchestrator.ts        # 外側ループ (並列 collect → normalize → dedupe → tag → summarize → publish)
│  ├─ registry.ts            # ソース定義テーブル (31 ソース)
│  ├─ types.ts               # 共通型 (Category / NormalizedEntry / SourceDefinition)
│  ├─ collectors/
│  │  ├─ rss.ts              # 汎用 RSS/Atom/RDF コレクター
│  │  ├─ vscode-updates.ts   # VS Code リリースページ HTML スクレイパー
│  │  ├─ anthropic.ts        # Anthropic News / Engineering HTML スクレイパー
│  │  ├─ hn-algolia.ts       # Hacker News Algolia API
│  │  ├─ opml.ts             # ユーザ OPML インポート
│  │  └─ youtube.ts          # YouTube チャンネル RSS
│  ├─ pipeline/
│  │  ├─ normalize.ts        # RawEntry → NormalizedEntry
│  │  ├─ dedupe.ts           # URL 正規化ベース重複排除
│  │  ├─ tag.ts              # キーワードベースのタグ補完
│  │  └─ summarize.ts        # Claude Opus 4.7 日本語要約 + 重要度判定 (API キー任意)
│  └─ publishers/
│     └─ index-builder.ts    # data/index.json & raw スナップショット
├─ web/                      # Astro 静的サイト
│  ├─ src/
│  │  ├─ layouts/Portal.astro
│  │  ├─ components/{Sidebar,EntryCard}.astro
│  │  ├─ lib/data.ts         # data/index.json を型付きで読み込む
│  │  └─ pages/
│  │     ├─ index.astro      # ポータルトップ (mockup-D 準拠)
│  │     ├─ c/[slug].astro   # カテゴリ別 (13 ページ)
│  │     ├─ t/[tag].astro    # タグ別
│  │     ├─ sources.astro, about.astro, status.astro
│  │     └─ {rss.xml,feed.json}.ts  # RSS 2.0 / JSON Feed 1.1
│  └─ astro.config.mjs
├─ .claude/skills/
│  └─ quality-audit/         # 品質監査スキル (SKILL.md + run.ts)
├─ .github/workflows/
│  ├─ harness-daily.yml      # 6h おき収集 + auto commit
│  └─ build-web.yml          # Astro ビルド
└─ data/                     # 成果物 (git-as-DB)
   ├─ index.json             # サイト配信用 (最新 500 件)
   ├─ raw/                   # 生データ (.gitignore, 監査用ローカル保持)
   ├─ _runs/                 # 実行レポート + 監査レポート (.gitignore)
   ├─ _summary-cache.json    # Claude 要約キャッシュ (.gitignore)
   └─ user-opml.xml          # ユーザ個別 OPML (.gitignore)
```

## フェーズ進捗

| フェーズ                 | 内容                                              | 状態   |
| ------------------------ | ------------------------------------------------- | ------ |
| P0 設計                  | ドキュメント群 + サイト仕様 v1.0                  | ✅ 完了 |
| P1 MVP                   | Tier 1 コア 15 ソース + Astro サイト + daily cron | ✅ 完了 |
| P2 Tier 2 + LLM          | Tier 2 残り + Claude Opus 要約 + Pagefind 検索    | ✅ 完了 |
| P3 Feed + 監査           | RSS/JSON Feed + /status + quality-audit skill     | ✅ 完了 |
| P4 Tier 3 + カスタマイズ | HN / YouTube / OPML + ユーザカスタマイズ基盤      | ✅ 完了 |

