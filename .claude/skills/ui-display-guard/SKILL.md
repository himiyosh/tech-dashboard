---
description: tech-dashboard のモバイル/レスポンシブ UI、固定ヘッダー/フッター、下部 tabbar、overflow、重なりの表示崩れを修正または確認するときに使う。実機相当 viewport と Playwright 寸法検証まで行う。
---

# UI Display Guard - tech-dashboard

## 目的

`web/` の UI 表示崩れを、見た目の印象だけでなく viewport 寸法、固定 UI の bounding box、横スクロール、重なりの検証まで含めて修正する。

特に mobile bottom navigation、sticky / fixed header、floating action、search overlay、カード内テキストなど、CSS の小さな差分で崩れやすい箇所を対象にする。

## 起動条件

次のいずれかに該当する場合に使う。

- ユーザーが mobile / smartphone / responsive / bottom menu / tabbar / footer / header の表示崩れを指摘している
- `web/src/styles/portal.css`、`web/src/layouts/Portal.astro`、主要 UI component を変更する
- fixed / sticky / absolute positioning、CSS grid/flex、safe-area、overflow、z-index を変更する
- 画面サイズ依存の E2E や screenshot 検証が必要である

## 必須手順

1. 対象 UI の所有コードを特定する
   - Layout: `web/src/layouts/Portal.astro`
   - CSS: `web/src/styles/portal.css`
   - Page / component: `web/src/pages/**`、`web/src/components/**`
2. 変更前に局所仮説を 1 つ置く
   - 例: 下部 tabbar の item 数と `grid-template-columns` が一致せず、空列や圧縮が発生している
3. 最小修正を行う
   - item 数を CSS に二重管理しない。可能なら `grid-auto-flow: column` と `grid-auto-columns: minmax(0, 1fr)` のように DOM 子要素数へ追従させる
   - safe area を考慮し、`env(safe-area-inset-bottom)` を既存パターンに沿って使う
   - fixed UI の z-index は既存レイヤー (`footer=40`, `tabbar=70`, `search=90`) と矛盾させない
4. Playwright で viewport 検証を追加または更新する
   - 代表 viewport: `390x844`、必要なら `375x667` も確認する
   - `document.documentElement.scrollWidth <= window.innerWidth` を確認する
   - fixed UI の `boundingBox()` が viewport 内に収まることを確認する
   - tabbar / toolbar は item count、first item left、last item right、item width の期待値を検証する
   - 主要導線の click / focus が壊れていないことを確認する
5. Focused E2E を実行する

```bash
npx playwright test tests/e2e/smoke.spec.ts -g "mobile"
```

6. UI 変更が広い場合は web build も実行する

```bash
npm run build:web
```

## Playwright 寸法チェック例

```ts
await page.setViewportSize({ width: 390, height: 844 });
await page.goto("/");

const tabbar = page.getByRole("navigation", { name: "Primary" });
await expect(tabbar).toBeVisible();
await expect
  .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  .toBe(true);

const tabbarBox = await tabbar.boundingBox();
expect(tabbarBox).not.toBeNull();
expect(Math.round(tabbarBox!.x)).toBe(0);
expect(Math.round(tabbarBox!.width)).toBe(390);

const items = tabbar.locator("a, button");
await expect(items).toHaveCount(4);
const boxes = await items.evaluateAll((nodes) =>
  nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  }),
);
expect(boxes[0].left).toBeGreaterThanOrEqual(0);
expect(boxes.at(-1)!.right).toBeLessThanOrEqual(390);
```

## 完了条件

| 項目 | 条件 |
|---|---|
| 表示 | 対象 viewport で固定 UI が欠けない、空列を持たない、横スクロールしない |
| 操作 | 主要導線の click / focus が維持されている |
| 回帰防止 | Playwright に寸法または overflow の検証が追加されている |
| 同期 | README / docs / `.github/copilot-instructions.md` に必要な学びが反映されている |

## 参照

- `web/src/layouts/Portal.astro`
- `web/src/styles/portal.css`
- `tests/e2e/smoke.spec.ts`
- `.github/copilot-instructions.md` LL-046
