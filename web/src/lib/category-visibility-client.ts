/**
 * category-visibility-client.ts — DOM wiring for the timeline category
 * filter (see category-visibility.ts for the pure policy).
 *
 * Server-rendered state: every timeline card carries
 * `data-category` + `data-catvis="muted"|"visible"` (shipped defaults), and
 * CSS hides `[data-category-filter-scope] .card[data-catvis="muted"]` so the
 * default works without JavaScript and without a flash. This module replays
 * the reader's stored overrides over that default, keeps the filter chips /
 * day headers / hidden-count note / Daily Summary board rows in sync, and
 * persists toggles.
 *
 * localStorage access is wrapped in try/catch: a blocked or cleared store
 * degrades to the shipped defaults (LL-083 style fail-safe).
 */
import {
  CATEGORY_VISIBILITY_STORAGE_KEY,
  isCategoryHidden,
  parseCategoryVisibilityOverrides,
  serializeCategoryVisibilityOverrides,
  toggleCategoryVisibility,
  type CategoryVisibilityOverrides,
} from "./category-visibility.ts";

function readOverrides(): CategoryVisibilityOverrides {
  try {
    return parseCategoryVisibilityOverrides(
      window.localStorage.getItem(CATEGORY_VISIBILITY_STORAGE_KEY),
    );
  } catch {
    return {};
  }
}

function writeOverrides(overrides: CategoryVisibilityOverrides): void {
  try {
    window.localStorage.setItem(
      CATEGORY_VISIBILITY_STORAGE_KEY,
      serializeCategoryVisibilityOverrides(overrides),
    );
  } catch {
    // Private mode / blocked storage: the toggle still works for this view.
  }
}

function timelineCards(scope: Element): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("article.card[data-category]")];
}

/**
 * Daily Summary "top stories" rows live inside the same scope and follow the
 * same policy, so the board never advertises a lane the reader muted. They are
 * counted separately from the cards: the "N hidden" note is about the article
 * list, and the board rows are the same articles seen a second time.
 */
function boardRows(scope: Element): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-board-row][data-category]")];
}

/** Re-stamp card visibility, then fix day headers and the hidden count. */
function applyOverrides(
  scope: Element,
  overrides: CategoryVisibilityOverrides,
): number {
  let hiddenCount = 0;
  for (const card of timelineCards(scope)) {
    const slug = card.dataset.category ?? "";
    const hidden = isCategoryHidden(slug, overrides);
    card.dataset.catvis = hidden ? "muted" : "visible";
    if (hidden) hiddenCount += 1;
  }
  syncBoardRows(scope, overrides);
  syncDayHeaders(scope);
  return hiddenCount;
}

/** Re-stamp board rows and keep the "N items" label on the visible count. */
function syncBoardRows(
  scope: Element,
  overrides: CategoryVisibilityOverrides,
): void {
  const rows = boardRows(scope);
  if (rows.length === 0) return;
  let visible = 0;
  for (const row of rows) {
    const hidden = isCategoryHidden(row.dataset.category ?? "", overrides);
    row.dataset.catvis = hidden ? "muted" : "visible";
    if (!hidden) visible += 1;
  }
  for (const count of scope.querySelectorAll<HTMLElement>("[data-board-count]")) {
    count.textContent = String(visible);
  }
}

/**
 * Day headers are flat siblings of their cards. A day whose cards are all
 * muted hides entirely; a partially muted day shows "visible / total".
 */
function syncDayHeaders(scope: Element): void {
  const headers = [...scope.querySelectorAll<HTMLElement>(".day-header")];
  for (const header of headers) {
    let visible = 0;
    let total = 0;
    for (
      let node = header.nextElementSibling;
      node && !node.classList.contains("day-header");
      node = node.nextElementSibling
    ) {
      if (!(node instanceof HTMLElement) || !node.matches("article.card[data-category]")) {
        continue;
      }
      total += 1;
      if (node.dataset.catvis !== "muted") visible += 1;
    }
    if (total === 0) continue;
    header.hidden = visible === 0;
    const count = header.querySelector<HTMLElement>(".day-count");
    if (count) {
      if (!count.dataset.totalEntries) {
        count.dataset.totalEntries = String(total);
      }
      const storedTotal = count.dataset.totalEntries;
      count.textContent = visible < total
        ? `${visible} / ${storedTotal} entries`
        : `${storedTotal} entries`;
    }
  }
}

function syncFilterUi(
  root: Element,
  overrides: CategoryVisibilityOverrides,
  hiddenCardCount: number,
): void {
  for (const chip of root.querySelectorAll<HTMLElement>("[data-category-toggle]")) {
    const slug = chip.dataset.categoryToggle ?? "";
    const hidden = isCategoryHidden(slug, overrides);
    chip.setAttribute("aria-pressed", hidden ? "false" : "true");
    chip.dataset.state = hidden ? "muted" : "on";
  }
  const note = root.querySelector<HTMLElement>("[data-category-filter-note]");
  if (note) {
    note.hidden = hiddenCardCount === 0;
    const target = note.querySelector<HTMLElement>("[data-category-filter-hidden-count]");
    if (target) target.textContent = String(hiddenCardCount);
  }
}

/**
 * Initializes one timeline page: `filterRoot` is the CategoryFilter panel,
 * `scope` the element carrying `data-category-filter-scope`.
 */
export function initCategoryVisibility(
  filterRoot: Element,
  scope: Element,
): void {
  let overrides = readOverrides();
  syncFilterUi(filterRoot, overrides, applyOverrides(scope, overrides));

  filterRoot.addEventListener("click", (event) => {
    const chip = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-category-toggle]",
    );
    if (!chip) return;
    const slug = chip.dataset.categoryToggle;
    if (!slug) return;
    overrides = toggleCategoryVisibility(slug, overrides);
    writeOverrides(overrides);
    syncFilterUi(filterRoot, overrides, applyOverrides(scope, overrides));
  });
}
