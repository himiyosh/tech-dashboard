---
name: self-critique
description: "Use when: completing any tech-dashboard task, responding to regressions, reviewing fixes, or when the user asks for self-critique, thorough verification, regression checks, navigation checks, taxonomy checks, UI checks, or quality review. Verifies rules, nav, taxonomy, UI, tests, data quality, and empty states; fixes critical/warning issues and records lessons learned."
argument-hint: "scope or suspected regression"
---

# Self-Critique — tech-dashboard

## 目的

コードを書いた後に「本当に正しいか」を多角的に検査し、問題を自己修正する。  
「変更が通った」「テストが通った」で終わらせず、**ユーザーが使う画面と運用ルールの両方で品質を担保する**。

このスキルは以下の痛みを防ぐ:
- 以前に修正した箇所が別の変更で元に戻る (regression)
- テストは通るが画面が崩れる (visual regression)
- コードは動くが絶対ルール(R-xxx)を破っている (policy violation)
- 局所修正で他の領域に副作用が出る (blast radius)

## 起動条件

**必ず実行する場合**
- タスク完了を宣言する直前
- ユーザーから「問題がある」「戻っている」「崩れている」などの指摘を受けた後
- UI (Portal.astro / portal.css / Sidebar / EntryCard) を変更した場合
- ナビゲーション (nav, tabbar, hamburger, active state) を変更した場合
- taxonomy / カテゴリ分類 (`CATEGORY_META`, `data/index.json`) を変更した場合
- `data/index.json`, `data/stats.json`, archive を変更した場合

**任意実行**
- ユーザーから「自己批判して」「レビューして」「徹底的に確認して」と言われた場合

## 検査カテゴリ

### C-01: 絶対ルール遵守 (ABSOLUTE)

`.github/copilot-instructions.md` の `🚨 絶対ルール` を 1 項目ずつ確認する。

| チェック | 方法 |
|---|---|
| R-001: GitHub Actions に deploy job を追加していないか | `.github/workflows/*.yml` に `wrangler pages deploy` が含まれていないことを確認 |
| R-001b: protected branch へ直接 commit / push していないか | commit / push 直前に `git branch --show-current` と対象 ref を確認し、`main` / `master` / `develop` なら中断する。`tests/protected-branch-guard.test.ts` で pre-commit / pre-push の fail-closed contract を確認する |
| R-001c: feature→develop→main release flowを守っているか | 通常PRのbaseが`develop`、main向けPRのheadが`develop`で、`.github/workflows/ci.yml`がmain/develop両方を対象に`check-pr-branch-flow.mjs`を実行することを確認 |
| R-003: web build が web で自己完結しているか | `web/src/**` から `../../../harness/` への runtime import がないことを grep で確認 |
| R-009: secret が staged / tracked に混入していないか | `npm run secrets:scan` と `npm run secrets:scan:worktree` を実行 |
| R-012: live index が body-free architecture と retention を守っているか | `data/index.json` で非空 `bodyJa` / `bodyEn` 件数が 0、本文は `data/bodies.json` にあり、retention 対象外 record が 0 であることを `tests/data-schema.test.ts` で確認 |
| R-013: summary fallback が全 live entry に適用済みか | `summaryJa` / `summaryEn` の両方が非空であることを確認し、body は `data/bodies.json` 側で管理する |
| R-026: Free publisher / bridge contract が維持されているか | `worker/wrangler.toml` に cron / `[limits]` / GitHub token がなく Free bridge entrypoint を使い、Publisher workflow が毎時のdata/impact gateと毎日のfull reconciliationを分離し、Node jobで検証後にdata-only pushと遅延effects flushを行い、18,000 files / 18分 / route-family growth contractを守ることを確認 |
| R-027: publisher runtime / Queue cache fingerprint と snapshot CAS が同期しているか | `npm run publisher:contract -- --dry-run` が `CURRENT` を返し、`tests/worker-publisher-contract.test.ts` で immutable SHA read、parent drift 拒否、exact parent contractを、`tests/publisher-runner.test.ts` で副作用遅延と flush 境界を確認する。staged rolloutでは原則として旧harnessのmarker mismatchを観測する。deployment provenanceやguard到達性を確認できずmismatchを観測できなかった場合に限り、bridge deploy前に旧runのterminal failure、merge後data commit不在、旧heartbeat非更新の3点をすべて実測し、理由をLLへ記録したか確認する。いずれか未確認なら停止してユーザー判断を求める |
| R-028: in-place checkout の Git mutation が直列化されているか | Git mutation 前に session automation が停止済みで先行 turn が完了していることを確認し、`git branch --show-current`、`git status --short`、push 先 ref を直前に再取得する |

### C-02: ナビゲーション状態 (NAVIGATION)

`.github/copilot-instructions.md` の LL-019, LL-046 を参照。

- [ ] Desktop: `Categories` / `arXiv` / `Knowledge` が primary nav shortcut として表示される (`header .nav-shortcut`)
- [ ] Desktop: `Archive` / `About` がハンバーガー内に存在する (`#site-menu a`)
- [ ] Desktop: `Categories` がハンバーガー内に**含まれない** (`#site-menu a[href="/categories/"]` が 0 件)
- [ ] Desktop: `Categories` ページを開いてもハンバーガーボタンが active にならない
- [ ] Mobile: 下部 tabbar は `Home`, `Categories`, `arXiv`, `Knowledge`, `Menu` の 5 action で表示される
- [ ] Mobile: `header .menu-trigger` が表示されず、ハンバーガー/Menu は下部 tabbar に統一されている
- [ ] Mobile: `#site-menu` は下部 tabbar の Menu から開き、tabbar 上に収まる bottom-sheet として表示される
- [ ] Mobile: hero 直下に重複 stats / 長い説明文の余白がなく、最初の Featured/article が `390x844` で十分上に見える (目安: `y <= 340`)
- [ ] Mobile: tabbar の item 数と CSS grid 列数が一致している (item 数と `grid-auto-columns` か `repeat(N,...)` を比較)
- [ ] Mobile: fixed tabbar が DOM 上でも main content より前にあり、keyboard navigation の primary route が footer 後へ回らない
- [ ] Mobile: 横スクロールが発生しない (`scrollWidth <= innerWidth`)
- [ ] Mobile: tabbar の `safe-area-inset-bottom` が考慮されている

**検査コマンド**:
```bash
npx playwright test tests/e2e/smoke.spec.ts -g "hamburger|mobile tabbar|navigation" --reporter=line
```

### C-03: taxonomy / カテゴリ分類 (TAXONOMY)

LL-015, LL-044, LL-055 を参照。

- [ ] `CATEGORY_META` の全 slug が `data/index.json` に存在するか (0 件カテゴリを確認)
- [ ] 同一 canonical URL が複数カテゴリで重複していないか
- [ ] Zed の記事が `vscode` カテゴリに含まれていないか
- [ ] `research` カテゴリの比率が 25% を超えていないか (過剰分類チェック)
- [ ] タグに明らかな揺れがないか (`llm` vs `LLM` vs `大規模言語モデル`)

**検査コマンド**:
```bash
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('./data/index.json','utf8'));
const live=d.entries;
const bycat={};
live.forEach(e=>{bycat[e.category]=(bycat[e.category]||0)+1;});
const total=live.length;
console.log('Category distribution ('+total+' entries):');
Object.entries(bycat).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>
  console.log('  '+k+': '+v+' ('+(v/total*100).toFixed(1)+'%)'));
const research=bycat['research']||0;
if(research/total>0.25) console.log('⚠️ research over 25%: '+research);
"
```

### C-04: サイドバーラベル表示 (SIDEBAR LABELS)

LL-046 を参照。

- [ ] `.side-item .name` が `white-space: nowrap` になっているか
- [ ] `.name-marquee` が hover/focus 時に marquee アニメーションをするか
- [ ] グループ見出し `.side-group-label` が折り返していないか
- [ ] 横スクロールが発生しないか

**検査コマンド**:
```bash
npx playwright test tests/e2e/smoke.spec.ts -g "sidebar category labels" --reporter=line
```

### C-05: ビルド & E2E (BUILD & TEST)

- [ ] `npm --prefix web run build` が成功するか
- [ ] `npx playwright test tests/e2e/smoke.spec.ts --reporter=line` が全件 PASS するか
- [ ] Featured / EntryCard の thumbnail fallback テストがあり、画像エラー時に broken image icon ではなく fallback artwork が表示されるか
- [ ] Mobile 通常カードの thumbnail が本文幅を削らず、非表示または省スペース表示になっており、隣接カードとの gap が見えるか
- [ ] Mobile 通常カードの summary text が `AI要約` などのバッジ横で狭くならず、本文幅いっぱいで自然に折り返すか
- [ ] `npm run typecheck 2>/dev/null` (または `cd web && npx tsc --noEmit`) でエラーがないか

**検査コマンド**:
```bash
npm --prefix web run build 2>&1 | tail -10
npx playwright test tests/e2e/smoke.spec.ts --reporter=line
```

### C-06: data artifact 品質 (DATA QUALITY)

- [ ] `data/index.json` のサイズが極端に大きくないか (目安: 15 MB 未満)
- [ ] `data/index.json` に非空 `bodyJa` / `bodyEn` が残っていないか (expected: 0)
- [ ] `data/bodies.json` が存在し、record count / coverage が確認できるか
- [ ] `data/bodies.json` に body retention 対象外 (non-evergreen、importance 1、既定 30 日より古い) の record が残っていないか (`npx vitest run tests/data-schema.test.ts`)
- [ ] archive 月別ファイルが 8 MB 未満か
- [ ] `data/index.json` の `generatedAt` が古すぎず、`data/stats.json` / `data/archive/_index.json` と大きく乖離していないか
- [ ] `publishedAt === collectedAt` のミリ秒一致が全体の 5% 未満か
- [ ] `titleEn` が空の live entry が全体の 10% 未満か

**検査コマンド**:
```bash
# data/index.json の entries に status フィールドは無く、全件が live 扱い
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('./data/index.json','utf8'));
const bodies=JSON.parse(fs.readFileSync('./data/bodies.json','utf8'));
const live=d.entries;
const total=live.length;
const noSumJa=live.filter(e=>!e.summaryJa).length;
const noSumEn=live.filter(e=>!e.summaryEn).length;
const indexBodyPresent=live.filter(e=>String(e.bodyJa??'').trim()||String(e.bodyEn??'').trim()).length;
const bodyRecords=Object.keys(bodies.bodies||{}).length;
const bodyCoverage=(bodyRecords/Math.max(1,total)*100).toFixed(1);
const noTitleEn=live.filter(e=>!e.titleEn).length;
const staleDate=live.filter(e=>e.publishedAt&&e.collectedAt&&Math.abs(new Date(e.publishedAt)-new Date(e.collectedAt))<100).length;
console.log('entries:', total);
console.log('no summaryJa:', noSumJa, '('+(noSumJa/total*100).toFixed(1)+'%)');
console.log('no summaryEn:', noSumEn, '('+(noSumEn/total*100).toFixed(1)+'%)');
console.log('index body present:', indexBodyPresent);
console.log('bodies.json count:', bodyRecords, '('+bodyCoverage+'% of live entries)');
console.log('no titleEn:', noTitleEn, '('+(noTitleEn/total*100).toFixed(1)+'%)');
console.log('publishedAt==collectedAt:', staleDate, '('+(staleDate/total*100).toFixed(1)+'%)');
"
```

### C-07: 検索・空状態 UX (SEARCH & EMPTY STATES)

- [ ] 検索 0 件時に「次に取れる行動」が表示されるか
- [ ] 要約未生成の記事カードが適切な placeholder を表示するか
- [ ] カテゴリ一覧で記事 0 件のカテゴリが適切に扱われているか

**検査コマンド**:
```bash
npx playwright test tests/e2e/smoke.spec.ts -g "search|empty|zero" --reporter=line
```

### C-08: ペルソナ回遊監査 (PERSONA JOURNEY)

`.github/agents/TechDBAgent.agent.md` を使い、実ユーザーに近い行動パターンで UI / taxonomy / trust / mobile の摩擦を検査する。

- [ ] `persona-dev-lead` が desktop で「今日読むべきもの」を 5 分以内に判断できるか
- [ ] `persona-mobile-commuter` が mobile で Home / Categories / Menu / Search を迷わず使え、重複 hamburger・Featured 崩れ・broken thumbnail を寸法/DOMで検査したか
- [ ] `persona-tech-pm` が source freshness / summary pending / shareability を信頼できるか
- [ ] `persona-ai-researcher` が Research / Local LLM / Tech News / tags の分類品質を deep-dive できるか
- [ ] 2 つ以上の persona が同じ問題を報告した場合、severity を 1 段階上げたか

**実行方法**:
```text
Agent selector で TechDBAgent を選び、対象 URL または local preview URL を渡す。
例: "http://127.0.0.1:4321 の top page / mobile / taxonomy を persona audit してください"
```

---

## 実行手順

1. **現状スキャン** — 上記 C-01 〜 C-08 をすべて実行し、問題をリストアップする
2. **severity 分類** — 🔴 Critical (ビルド失敗 / ルール違反) / 🟠 Warning (UX 劣化 / 回帰) / 🟢 Minor (軽微な改善余地)
3. **自己修正** — Critical / Warning を自己修正する。ユーザー判断が必要な場合は提示する
4. **再検査** — 修正後に関連チェックを再実行する
5. **LL 追記** — 新しい根本原因・再発パターンが見つかった場合、`.github/copilot-instructions.md` に LL-xxx として追記する
6. **レポート出力** — 以下のフォーマットで結果をユーザーに報告する

## レポートフォーマット

```markdown
# 自己批判レポート — <YYYY-MM-DD HH:mm>

**サマリ**: <N> 件の問題 (🔴 X · 🟠 Y · 🟢 Z)

## 🔴 Critical

- [ C-01 ] R-xxx 違反: ...

## 🟠 Warning

- [ C-02 ] ハンバーガーに Categories が含まれている → 修正済み

## 🟢 Minor

- [ C-03 ] research カテゴリ XX% — 許容範囲内だが監視

## ✅ 問題なし

- C-05 build & E2E: 全件 PASS
- C-06 data quality: index body populated 0 件, bodies.json coverage X%, retention violations 0 件, titleEn 欠落 X% (閾値内)
- C-08 persona journey: Critical / Warning なし

## 新規 LL

(新しいパターンが見つかった場合のみ)
```

---

## 禁止事項

- main への直接 push / merge を自己修正の一環として行わない
- Cloudflare deploy / Worker deploy を自動実行しない
- secret を出力に含めない
- 「テストが通った」だけで完了としない — ビジュアル・ポリシーも確認する
- 修正に自信がない場合は推測で実行せず、ユーザーに確認する

---

## 参照

- `.github/copilot-instructions.md` — 絶対ルール (R-xxx) と Lessons Learned (LL-xxx)
- `tests/e2e/smoke.spec.ts` — 回帰テスト一式
- `.github/agents/TechDBAgent.agent.md` — ペルソナ回遊監査の統括エージェント
- `web/src/layouts/Portal.astro` — ナビ実装
- `web/src/components/Sidebar.astro` — サイドバー実装
- `web/src/lib/data.ts` — taxonomy metadata
- `data/index.json` — live data artifact
