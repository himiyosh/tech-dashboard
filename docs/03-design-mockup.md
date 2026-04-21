# 03. UI/UX デザイン案

> **設計指針**: 「情報量は多く、認知負荷は低く」。タイムライン中心、フィルタ中心。AI 工業製品感 (過度な絵文字、装飾、AI 生成っぽさ) を排除。

## 0. ライブプレビュー

ブラウザで確認できる HTML モックを用意しています。

| バリアント            | 用途                                                                                    | ファイル                                                                     |
| --------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A: サイドバー / Light | **デスクトップ (>= 960px) の本番レイアウト**                                            | [mockups/mockup-A-sidebar-light.html](mockups/mockup-A-sidebar-light.html)   |
| B: チップ / Dark      | **モバイル・タブレット (< 960px) のレイアウト** + Dark モードの見本                     | [mockups/mockup-B-chips-dark.html](mockups/mockup-B-chips-dark.html)         |
| C: アクセント色比較   | Teal / Indigo / Amber / Rose の並列比較 (**Teal 確定済み**)                             | [mockups/mockup-C-accent-preview.html](mockups/mockup-C-accent-preview.html) |
| D: ポータル版 (採用)  | **本番トップページの正式モック**。ヒーロー / KPI / フィーチャード / カテゴリ / トレンド | [mockups/mockup-D-portal-dark.html](mockups/mockup-D-portal-dark.html)       |
| E: Status ページ      | `/_status` 専用ページ。ソース一覧 / チャート / 実行ログ                                 | [mockups/mockup-E-status-page.html](mockups/mockup-E-status-page.html)       |

本プロジェクトでは **D (トップ)** を基準レイアウトとし、詳細な運用情報は **E (/_status)** に分離する。モバイル時は B のチップレイアウトに切替。

---

## 1. コンセプト

### 1.1 ペルソナ
- **Primary**: AI ツールを業務で使うエンジニア。朝 5 分で「昨日-今日の AI 周りの動き」を把握したい
- **Secondary**: ML リサーチ / SRE / PdM などの周辺職。深追いは週 1 程度

### 1.2 デザイン原則

| 原則                      | 意味                                             |
| ------------------------- | ------------------------------------------------ |
| Information density first | ヘッダ / 余白を抑え、1 画面で 20-30 件見える     |
| Fast scan                 | 見出し・ソース・日付・タグで一目で重要度判別     |
| Keyboard first            | `j/k` で移動、`/` で検索、`f` でフィルタ         |
| No dark patterns          | 通知ポップアップ、無限スクロールの ajax 遅延無し |
| Monospace accents         | 日付・バージョン番号は等幅で視認性確保           |

---

## 2. 画面構成

### 2.1 ページ一覧

| パス            | 役割                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| `/`             | タイムライン (全件、最新順)                                             |
| `/c/:category`  | カテゴリ別 (copilot / claude / codex / local-llm / opencode / research) |
| `/t/:tag`       | タグ別                                                                  |
| `/s/:source`    | ソース別                                                                |
| `/search?q=...` | 検索結果 (Pagefind)                                                     |
| `/about`        | このサイトについて・情報ソース一覧                                      |
| `/_status`      | ハーネス実行状況 (直近 30 日の成功率、収集件数)                         |
| `/feed.xml`     | RSS                                                                     |

### 2.2 メインレイアウト (ワイヤーフレーム)

```
┌──────────────────────────────────────────────────────────────────────┐
│  tech-dashboard                          [/ 検索]  [RSS]  [GitHub]   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─ Sidebar ───────┐  ┌─ Timeline ────────────────────────────────┐ │
│  │                 │  │                                            │ │
│  │ CATEGORIES      │  │  Today ─ 2026-04-19                       │ │
│  │  All        231 │  │                                            │ │
│  │  Copilot     42 │  │  ┌───────────────────────────────────────┐│ │
│  │  Claude      38 │  │  │ [release] [claude]     2h  Anthropic  ││ │
│  │  Codex       19 │  │  │ Claude Opus 4.7 リリース ─ …          ││ │
│  │  Local LLM   57 │  │  │ 長期推論で 15% 改善、ツール呼出の…     ││ │
│  │  OpenCode    12 │  │  │ anthropic.com/news/claude-opus-4-7    ││ │
│  │  Research    63 │  │  └───────────────────────────────────────┘│ │
│  │                 │  │                                            │ │
│  │ TAGS            │  │  ┌───────────────────────────────────────┐│ │
│  │  release    89  │  │  │ [tutorial] [copilot]   5h  GitHub Blog││ │
│  │  tutorial   34  │  │  │ Agent mode のベストプラクティス ─ …    ││ │
│  │  paper      41  │  │  │ プランニング層で精度向上、Hook 活用…   ││ │
│  │  ...            │  │  └───────────────────────────────────────┘│ │
│  │                 │  │                                            │ │
│  │ SOURCES         │  │  Yesterday ─ 2026-04-18                   │ │
│  │  anthropic   12 │  │  ...                                       │ │
│  │  github      18 │  │                                            │ │
│  │  arxiv       25 │  │                                            │ │
│  │                 │  │                                            │ │
│  │ RANGE           │  │                                            │ │
│  │  [●] 7 days     │  │                                            │ │
│  │  [ ] 30 days    │  │                                            │ │
│  │  [ ] All        │  │                                            │ │
│  └─────────────────┘  └────────────────────────────────────────────┘│
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.3 エントリカード (詳細)

```
┌──────────────────────────────────────────────────────────────────┐
│ [release] [claude] [important]          2h  ·  Anthropic News    │ ← meta row
│ Claude Opus 4.7 リリース ─ 長期推論タスクで大幅改善                │ ← titleJa
│ ─────────────────────────────────────────────────────────────── │
│ 長期推論で 15% 改善。ツール呼出の安定性向上と新しい harness       │ ← summaryJa
│ design 機能を搭載。                                               │
│                                                                  │
│ anthropic.com/news/claude-opus-4-7                         [→]   │ ← url (hover で prefetch)
└──────────────────────────────────────────────────────────────────┘
```

- **高さ**: 約 140px (フォールドで大量表示)
- **クリック**: カード全体で原記事を新規タブで開く
- **ホバー**: 1px のアウトライン、`border-color` でアクセント
- **重要度バッジ** (`importance=3`): 左端に 3px の縦ライン (アクセントカラー)

### 2.4 レスポンシブ戦略 (ハイブリッド)

`960px` をブレークポイントとし、デスクトップとモバイルで **情報構造は同じ / 表現のみ切替** る。

| ブレークポイント | レイアウト                                             | 根拠                                                                                        |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `>= 960px`       | **A: 左サイドバー固定** (幅 220px) + タイムライン      | デスクトップは情報密度を優先。カテゴリ/タグ/ソース/期間を常時表示して 1-2 クリックで絞込    |
| `< 960px`        | **B: 上部チップ横スクロール** + 単一カラムタイムライン | サイドバー折畳は UX 劣化。チップは Twitter / Reddit など主要 SNS でも採用される慣習パターン |

- 両方で **URL クエリによる状態管理** は共通 (`?tag=release&range=7d`)
- 両方で **同じカードコンポーネント** を使用 (分岐は layout のみ)
- **Dark モードをデフォルト** とする。header のトグルで Light に切替可能 (ユーザ選択は `localStorage` に保存)。初回のみ `prefers-color-scheme` も尊重。

### 2.6 言語切替 (JA / EN)

タイトル・要約は LLM で JA / EN の両方を生成し、ページで切替可能にする。

| パス       | 言語                |
| ---------- | ------------------- |
| `/` (root) | 日本語 (デフォルト) |
| `/en/`     | 英語                |

- 右上に言語トグル (`JA | EN`)、選択は localStorage 保存
- `<html lang="ja">` / `<html lang="en">` を切替 (a11y / 検索)
- データスキーマに `titleJa / titleEn / summaryJa / summaryEn` を持たせる (docs/01 の NormalizedEntry に追加)
- LLM 呼出しは 1 度で両言語生成 (JSON で返す)。コストは 2x にはならず +30-40% 程度
- 原文がすでに日本語の場合は EN を翻訳、逆も同様

### 2.5 モバイルレイアウト (ワイヤーフレーム)

```
┌─────────────────────────────┐
│ tech·dashboard  [/] [RSS]   │ ← sticky header
├─────────────────────────────┤
│ [All 231] [Copilot 42] [→]  │ ← sticky chips (horiz scroll)
├─────────────────────────────┤
│                             │
│  Today · 2026-04-19         │
│  ┌───────────────────────┐  │
│  │ [release] [claude] 2h │  │
│  │ Claude Opus 4.7 …     │  │
│  │ 長期推論で 15% 改善…   │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ [tutorial] [copilot]  │  │
│  │ Agent mode …          │  │
│  └───────────────────────┘  │
│                             │
└─────────────────────────────┘
```


---

## 3. デザイントークン

### 3.1 カラーパレット (Light / Dark)

```ts
// web/src/styles/tokens.ts
export const tokens = {
  light: {
    bg:        "#fafaf9",   // stone-50
    surface:   "#ffffff",
    border:    "#e7e5e4",   // stone-200
    text:      "#1c1917",   // stone-900
    muted:     "#78716c",   // stone-500
    accent:    "#0f766e",   // teal-700  (落ち着いたアクセント)
    accentBg:  "#ccfbf1",   // teal-100
    danger:    "#b91c1c",
  },
  dark: {
    bg:        "#0c0a09",
    surface:   "#1c1917",
    border:    "#292524",
    text:      "#f5f5f4",
    muted:     "#a8a29e",
    accent:    "#5eead4",   // teal-300
    accentBg:  "#134e4a",
    danger:    "#f87171",
  },
};
```

**選定理由**:
- Stone (warm gray) 基調 - 純黒/純白より目が疲れにくい
- アクセントは teal。GitHub / Anthropic / OpenAI いずれのブランドカラーとも衝突しない中立色
- 過度な彩度は避ける (「AI 生成っぽさ」の排除)

### 3.2 タイポグラフィ

```css
font-family:
  ui-sans-serif, system-ui,
  "Hiragino Sans", "Noto Sans JP", sans-serif;

font-family-mono:
  ui-monospace, "SF Mono", "JetBrains Mono", monospace;
```

- 本文: 15px / line-height 1.6
- 見出し (カテゴリ区切り): 14px uppercase tracking-wide, muted
- カードタイトル: 16px / 600
- メタ情報 (日時・ソース): 12px monospace

### 3.3 スペーシング

4 / 8 / 12 / 16 / 24 / 32 / 48 の 4px ベーススケール。カード内余白は 12px、カード間 gap は 8px。

### 3.4 アイコン

- [Lucide](https://lucide.dev) のみを使用 (オープンソース、軽量、一貫したストローク)
- カテゴリアイコンはソース元ロゴは使わず、抽象形に統一 (ライセンス回避)

---

## 4. アクセシビリティ

| 項目               | 対応                                           |
| ------------------ | ---------------------------------------------- |
| コントラスト       | WCAG AA 以上 (本文 4.5:1, 大文字 3:1)          |
| キーボード操作     | `j/k/gg/G/f/s/?` (Vim ライク)、Tab で順次移動  |
| スクリーンリーダー | カードは `<article>`, メタは `<time dateTime>` |
| 動作環境           | `prefers-reduced-motion` で遷移アニメを無効化  |
| カラー依存性       | 重要度は色 + 縦ラインの「二重符号化」          |

---

## 5. 性能予算

| 指標        | 目標                | 手段                                       |
| ----------- | ------------------- | ------------------------------------------ |
| LCP         | < 2.0s              | Astro SSG + CDN、ヒーロー画像なし          |
| CLS         | < 0.05              | カード高さ固定                             |
| TBT         | < 100ms             | React Island (必要箇所のみ hydrate)        |
| JS バンドル | < 50KB gzip         | サイドバーは Island、タイムラインは純 HTML |
| 画像        | 0 枚 (favicon 除く) | 意図的にテキスト中心                       |

**CI ゲート**: Lighthouse CI で Performance >= 95、Accessibility >= 100 を必須化。

---

## 6. コンポーネント構成 (Astro + React)

```
web/src/
├─ pages/
│  ├─ index.astro                 (timeline)
│  ├─ c/[category].astro
│  ├─ t/[tag].astro
│  ├─ s/[source].astro
│  ├─ about.astro
│  ├─ _status.astro
│  └─ feed.xml.ts
├─ components/
│  ├─ Timeline.astro              (データから SSG 生成)
│  ├─ EntryCard.astro             (pure HTML, no JS)
│  ├─ Sidebar.tsx                 (Island - フィルタ状態管理)
│  ├─ SearchBox.tsx               (Island - Pagefind)
│  └─ ThemeToggle.tsx             (Island)
├─ lib/
│  ├─ data.ts                     (data/index.json 読込)
│  └─ format.ts                   (日時・URL 表示)
└─ styles/
   ├─ tokens.css
   └─ global.css
```

React Island は 3 箇所のみ (Sidebar / SearchBox / ThemeToggle)。それ以外は純 HTML。

---

## 7. 状態遷移

### 7.1 フィルタ状態

- URL クエリで保持 (`?tag=release&range=7d`)
- ブラウザバック対応
- JS 無効でも機能する (サイドバーのリンクは全て `<a href>`)

### 7.2 検索

- Pagefind でビルド時にインデックス生成 (`web/dist/pagefind/`)
- `/search?q=...` で SSG 結果ページ (ない場合は JS で即応)
- 初期ロード時に Pagefind のみ lazy load

---

## 8. 将来拡張 (P4 以降)

| 機能            | 概要                                              |
| --------------- | ------------------------------------------------- |
| パーソナライズ  | localStorage で「興味タグ」保存、タイムライン並替 |
| Webhook/通知    | Discord / Slack / Email 通知 (importance=3 のみ)  |
| 多言語          | en/ja 切替 (now: ja primary, en title 併記)       |
| コメント / 共有 | GitHub Discussions 連携                           |

---

## 9. デザインレビュー観点 (ユーザ確認用チェックリスト)

- [x] カラートーン (Stone + Teal `#5eead4`) → **確定**
- [x] レイアウト方針 → **ハイブリッド** (Desktop: サイドバー A / Mobile: チップ B) を採用
- [x] Dark モード → **デフォルト Dark** (Light はトグルで切替)
- [x] 日英併記 → **JA (デフォルト) / EN (`/en/`)** のページ切替で対応
- [x] アクセント色 → **Teal `#5eead4` / Teal-bg `#134e4a`** で確定
- [ ] 1 カードの情報量 (titleJa / summaryJa / タグ / URL) で十分か (後日修正可)
- [ ] 重要度バッジの表現 (縦ライン + 色) で OK か
- [x] `/_status` ページ → 公開デフォルト (問題があれば Cloudflare Access で後から制限可能)

---

## 10. 完了

以上で設計フェーズのドキュメントは以下の 4 本が揃いました。

- [00. Harness Engineering リサーチ](00-research-harness-engineering.md)
- [01. システム設計書](01-architecture.md)
- [02. Agent / Skill / Hook / Prompt 構成](02-agents-skills-hooks.md)
- [03. UI/UX デザイン案](03-design-mockup.md)

レビュー後、合意が取れたら実装フェーズ (P1: MVP) に進みます。
