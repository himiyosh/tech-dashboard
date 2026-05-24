---
goal: "Raise TECH Dashboard to a competitive professional-grade technical update dashboard"
version: "1.0"
date_created: "2026-05-25"
last_updated: "2026-05-25"
owner: "tech-dashboard maintainers"
status: "Planned"
tags: ["design", "ux", "taxonomy", "quality", "dashboard", "competitive-analysis"]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This implementation design defines the next work required for TECH Dashboard to compete credibly as a professional technical-update dashboard. The plan prioritizes decision quality over broad visual redesign: readers must understand what matters today, why it matters, how reliable the classification is, and what to do when data is delayed or incomplete.

## 1. Requirements & Constraints

- **REQ-001**: The home page must make "today's priority updates" visible above the deep-dive timeline without requiring desktop or mobile users to scroll past large explanatory blocks.
- **REQ-002**: Each priority item must expose a deterministic "why this is important" reason generated from entry metadata: `importance`, `sourceType`, `publishedAt`, `category`, `source`, and `tags`.
- **REQ-003**: Priority ranking must use a shared helper in `web/src/lib/data.ts`; `web/src/pages/index.astro` must not own independent scoring logic.
- **REQ-004**: Category and tag labels must support a two-level taxonomy: parent group plus child category, with stable existing URL slugs from `Category`.
- **REQ-005**: Broad sources in `harness/registry.ts` must keep `includeKeywords`, `excludeKeywords`, and `maxEntriesPerRun` controls so unrelated articles do not dominate `research` or `tech-news`.
- **REQ-006**: The Status page must explain source freshness, summarize disabled states, source errors, and partial-data states in reader-facing language.
- **REQ-007**: Search zero-state UI must state the likely cause and present next actions: shorten the keyword, remove filters, browse categories, and try another language.
- **REQ-008**: Mobile navigation must remain `Home / Categories / Menu`; Search, Archive, Status, and About must remain discoverable through `#site-menu`.
- **REQ-009**: The implementation must include regression tests for priority ranking, reason labels, taxonomy distribution, search empty state, hamburger ownership, and mobile overflow.
- **SEC-001**: No secrets, API tokens, credentials, or Wrangler OAuth token values may be printed, stored, committed, or included in logs.
- **SEC-002**: Do not add third-party analytics, personalization, or external tracking as part of this plan.
- **CON-001**: Do not add GitHub Actions deployment jobs or `wrangler pages deploy` workflow steps.
- **CON-002**: Do not push directly to `main`; implementation must happen on a feature branch and merge only after explicit user approval.
- **CON-003**: Do not perform Cloudflare Pages deploy or Worker deploy while executing this plan unless the user explicitly requests deployment.
- **CON-004**: `web/src/**` must not runtime-import root harness code; duplicate web-only metadata into `web/src/lib/*.ts` when required.
- **CON-005**: Keep the change set incremental; do not replace Astro, Pagefind, the existing `Portal.astro` layout, or the existing data artifacts.
- **GUD-001**: Run `modern-web-guidance` before any HTML, CSS, client-side JavaScript, accessibility, performance, or browser API implementation.
- **GUD-002**: Run `ui-display-guard` checks for changes to mobile, fixed, sticky, overflow, z-index, or safe-area behavior.
- **GUD-003**: Run the `self-critique` skill before declaring implementation complete; resolve all Critical and Warning findings.
- **PAT-001**: Keep `web/src/layouts/Portal.astro` as the source of truth for header search, hamburger menu, language toggle, and mobile tabbar behavior.
- **PAT-002**: Keep `web/src/lib/data.ts` as the source of truth for category metadata, title fallback, summary fallback, entry ranking, and display helper semantics.
- **PAT-003**: Keep `tests/e2e/smoke.spec.ts` as the main Playwright regression surface for top-page UX, navigation, search, sidebar labels, and mobile layout.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish measurable professional-quality criteria and shared dashboard scoring primitives.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create a quality baseline script in `scripts/audit-dashboard-quality.mjs` that reads `data/index.json` and prints JSON with these keys: `totalEntries`, `categoryCounts`, `researchPct`, `techNewsPct`, `zedInVscodeCount`, `emptySummaryJaCount`, `emptySummaryEnCount`, `emptyBodyBothCount`, `titleEnMissingPct`, `publishedEqualsCollectedPct`, and `topSourceSharePct`. The script must exit non-zero when `researchPct > 25`, `zedInVscodeCount > 0`, `emptyBodyBothCount > 0`, or either summary count is greater than `0`. |  |  |
| TASK-002 | Add `dashboardQuality` assertions to `tests/data-schema.test.ts` using the same thresholds as `scripts/audit-dashboard-quality.mjs`. The test must fail when broad categories dominate or required bilingual summary/body fields are missing. |  |  |
| TASK-003 | Add `priorityScore(entry: NormalizedEntry, now?: Date): number` to `web/src/lib/data.ts`. The score must be `importance * 100`, plus `sourceType` bonus `release/changelog=20`, `paper=10`, `blog/community=0`, minus `ageHours * 0.6`, clamped so future dates do not increase score. |  |  |
| TASK-004 | Add `priorityReasons(entry: NormalizedEntry, now?: Date): { ja: string; en: string; codes: string[] }` to `web/src/lib/data.ts`. The returned `codes` array must include deterministic values from `importance-high`, `importance-medium`, `official-release`, `paper-research`, `fresh`, `category-match`, and `fallback-summary` when applicable. |  |  |
| TASK-005 | Add `topDecisionEntries(limit = 5, now = new Date()): NormalizedEntry[]` to `web/src/lib/data.ts`. The helper must select entries with `importance >= 2`, sort by `priorityScore`, cap each `source` to `2` entries, and return exactly `min(limit, available)` entries. |  |  |

### Implementation Phase 2

- GOAL-002: Rework the home page into a compact decision surface followed by a deep-dive timeline.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Replace the local `topThree` calculation in `web/src/pages/index.astro` with `topDecisionEntries(5, now)` imported from `web/src/lib/data.ts`. Remove duplicate scoring code from `index.astro`. |  |  |
| TASK-007 | Update the banner in `web/src/pages/index.astro` so the first viewport contains: short value statement, source/cadence facts, a primary anchor to `#today-priority`, a search trigger, and a categories link. The banner must not exceed `520px` height at `1280x900` or `360px` height at `390x844`. |  |  |
| TASK-008 | Add a compact `.decision-list` block to `web/src/pages/index.astro` inside `#today-priority`. Each item must show rank, title via `titleForLangWithFallback`, source, category child label, published date, and `priorityReasons(...).ja/en`. |  |  |
| TASK-009 | Rename or annotate the timeline section in `web/src/pages/index.astro` as a deep-dive list. The heading copy must explicitly state that Timeline/All entries is for exploration after the decision list. |  |  |
| TASK-010 | Update `web/src/styles/portal.css` for `.decision-list`, `.decision-item`, `.decision-reason`, and compact banner spacing. The CSS must preserve no-horizontal-overflow at mobile width `390px`. |  |  |

### Implementation Phase 3

- GOAL-003: Improve article-card decision cues without adding visual noise.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | Refactor `web/src/components/EntryCard.astro` to import and use `priorityReasons` from `web/src/lib/data.ts` instead of constructing `rankReasonJa` and `rankReasonEn` locally. |  |  |
| TASK-012 | In `web/src/components/EntryCard.astro`, replace the raw category slug badge with the category child label from `CATEGORY_META.name` while preserving the slug in `aria-label` and link context where applicable. |  |  |
| TASK-013 | Add a low-noise summary-pending state in `EntryCard.astro`: if `summaryJa` or `summaryEn` starts with the deterministic fallback pattern, display a short "AI summary pending" badge and keep the fallback text visible. |  |  |
| TASK-014 | Update `web/src/styles/portal.css` so `.card-insight` fits in two lines on mobile, uses `line-clamp` only for reason text, and keeps source/date/category visible. |  |  |

### Implementation Phase 4

- GOAL-004: Make taxonomy and source quality auditable and understandable.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | Add `categoryGroupLabel(group: CategoryGroup): string` and `categoryDisplayLabel(category: Category): { group: string; name: string; full: string }` to `web/src/lib/data.ts`. The function must return English visible labels and must not change existing slugs. |  |  |
| TASK-016 | Update `web/src/components/Sidebar.astro` to use `categoryDisplayLabel` for tooltip and `CATEGORY_META.name` for visible compact text. The existing hover marquee behavior must remain active for overflowing labels. |  |  |
| TASK-017 | Update `web/src/pages/categories.astro` so the compact directory groups categories by `CategoryGroup` and each card shows `live`, `live 30d`, source count, and top tags. Do not show `all time` as the primary card metric. |  |  |
| TASK-018 | Update `web/src/lib/source-meta.ts` after any source category change so it remains synchronized with `harness/registry.ts`. The source id, displayName, category, tier, and sourceType values must match. |  |  |
| TASK-019 | Add a taxonomy regression test to `tests/data-schema.test.ts` that rejects entries whose title/source/url contain `zed` while `category === "vscode"` unless the URL host is an official VS Code or Microsoft domain. |  |  |

### Implementation Phase 5

- GOAL-005: Improve trust surfaces for data freshness, missing summaries, and partial failures.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Update `web/src/pages/status.astro` so Worker state copy distinguishes `healthy`, `summarize disabled`, `source delayed`, `source error`, and `legacy index`. Each state must include one sentence explaining user impact. |  |  |
| TASK-021 | Add an `attentionSources` panel in `web/src/pages/status.astro` that lists up to `8` stale or error sources with display name, category label, last collected time, latest published time, and a link to the latest article when available. |  |  |
| TASK-022 | Update `web/src/pages/about.astro` with a short "Limitations" section that states: hourly collection can lag, AI summaries can be pending, and categories are deterministic but continuously audited. |  |  |
| TASK-023 | Update the Pagefind zero-state rendering inside the inline script in `web/src/layouts/Portal.astro` so it displays all next actions: shorter keyword, browse categories, open status, and try another language. |  |  |
| TASK-024 | Add keyboard/a11y coverage in `tests/e2e/smoke.spec.ts` for search zero state links and `#site-menu` Search action focus restoration. |  |  |

### Implementation Phase 6

- GOAL-006: Add verification gates that prevent regression before completion.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-025 | Add Playwright assertions in `tests/e2e/smoke.spec.ts` that `#today-priority` appears before the first `article.card`, `.decision-list` contains at least `3` items, and every decision item has non-empty reason text in both `.i18n-ja` and `.i18n-en`. |  |  |
| TASK-026 | Add Playwright assertions in `tests/e2e/smoke.spec.ts` that the top banner height is below `520px` at `1280x900` and below `360px` at `390x844`, and that `document.documentElement.scrollWidth <= window.innerWidth` at `390x844`. |  |  |
| TASK-027 | Add Playwright assertions in `tests/e2e/smoke.spec.ts` that mobile tabbar has exactly `3` actions, Categories is not in `#site-menu`, Archive/About/Status/Search are in `#site-menu`, and Categories does not activate Menu. |  |  |
| TASK-028 | Add or update npm validation documentation in `README.md` with the exact local command sequence: `npm run typecheck`, `npm test`, `npm --prefix web run build`, `npx playwright test tests/e2e/smoke.spec.ts --reporter=line`, and `node scripts/audit-dashboard-quality.mjs`. |  |  |
| TASK-029 | Run the `self-critique` skill and resolve all Critical and Warning findings before reporting completion. The final report must include which C-01 to C-07 checks were executed and any unresolved Minor items. |  |  |

## 3. Alternatives

- **ALT-001**: Build a full editorial CMS and manual curation workflow. Not chosen because the current product value is automated hourly aggregation; manual editing would add operational burden before ranking and taxonomy quality are stable.
- **ALT-002**: Replace the existing UI with a new framework or full design system. Not chosen because the constraint requires minimal diff and preserving Astro, `Portal.astro`, Pagefind, and current components.
- **ALT-003**: Compete with large companies through broad news coverage. Not chosen because broad coverage weakens differentiation and increases noise; the competitive path is focused AI/developer-tool decision quality.
- **ALT-004**: Add personalized recommendations. Not chosen because it would require user tracking, storage, privacy decisions, and a larger data model outside the current static dashboard architecture.
- **ALT-005**: Hide uncertain or pending-summary entries. Not chosen because hiding data reduces transparency; the selected approach keeps entries visible while labeling uncertainty.

## 4. Dependencies

- **DEP-001**: Astro static build in `web/package.json` with `npm --prefix web run build`.
- **DEP-002**: Pagefind search index generated by `pagefind --site dist` during web build.
- **DEP-003**: Data artifacts in `data/index.json`, `data/stats.json`, and `data/archive/*.json`.
- **DEP-004**: Source registry in `harness/registry.ts` and web copy in `web/src/lib/source-meta.ts`.
- **DEP-005**: Existing Playwright smoke tests in `tests/e2e/smoke.spec.ts`.
- **DEP-006**: Existing data schema tests in `tests/data-schema.test.ts`.
- **DEP-007**: Project skills `modern-web-guidance`, `ui-display-guard`, and `self-critique`.

## 5. Files

- **FILE-001**: `web/src/lib/data.ts` — Add shared ranking, reason, and taxonomy display helpers.
- **FILE-002**: `web/src/pages/index.astro` — Replace local top-item scoring and render compact decision list plus deep-dive timeline framing.
- **FILE-003**: `web/src/components/EntryCard.astro` — Consume shared priority reasons and improve category/summary-pending display.
- **FILE-004**: `web/src/components/Sidebar.astro` — Keep compact labels with full taxonomy context and marquee behavior.
- **FILE-005**: `web/src/pages/categories.astro` — Render grouped category directory and live-focused category cards.
- **FILE-006**: `web/src/pages/status.astro` — Explain source freshness, Worker state, summary-pending state, and partial failure impact.
- **FILE-007**: `web/src/pages/about.astro` — Document limitations and trust model.
- **FILE-008**: `web/src/layouts/Portal.astro` — Improve search zero-state actions and preserve menu/tabbar ownership.
- **FILE-009**: `web/src/styles/portal.css` — Add compact decision-list, banner density, card-insight, status, and mobile overflow styles.
- **FILE-010**: `harness/registry.ts` — Maintain broad-feed filters and source category assignments.
- **FILE-011**: `web/src/lib/source-meta.ts` — Keep web source metadata synchronized with the registry.
- **FILE-012**: `tests/e2e/smoke.spec.ts` — Add UX, mobile, search, priority, and navigation regression checks.
- **FILE-013**: `tests/data-schema.test.ts` — Add taxonomy, data completeness, and category distribution gates.
- **FILE-014**: `scripts/audit-dashboard-quality.mjs` — Add machine-readable quality audit script.
- **FILE-015**: `README.md` — Document local validation commands.

## 6. Testing

- **TEST-001**: Run `npm run typecheck`; it must exit with code `0`.
- **TEST-002**: Run `npm test`; it must exit with code `0`.
- **TEST-003**: Run `npm --prefix web run build`; it must exit with code `0` and generate Pagefind output in `web/dist/pagefind`.
- **TEST-004**: Run `npx playwright test tests/e2e/smoke.spec.ts --reporter=line`; all tests must pass.
- **TEST-005**: Run `npx playwright test tests/e2e/smoke.spec.ts -g "mobile|hamburger|navigation|search|decision|sidebar" --reporter=line`; all matching tests must pass.
- **TEST-006**: Run `node scripts/audit-dashboard-quality.mjs`; it must exit with code `0` and print valid JSON.
- **TEST-007**: Run the self-critique C-01 to C-07 checks; no Critical or Warning findings may remain.

## 7. Risks & Assumptions

- **RISK-001**: Ranking may appear editorial even though it is deterministic. Mitigation: expose reason codes and keep scoring rules in `web/src/lib/data.ts`.
- **RISK-002**: More taxonomy labels can increase visual complexity. Mitigation: show compact child labels by default and expose full group context through tooltips, aria labels, and category pages.
- **RISK-003**: Broad feed filters can reject useful edge-case articles. Mitigation: keep relevance keyword lists explicit in `harness/registry.ts` and monitor quality audit output.
- **RISK-004**: Additional E2E coverage can increase test runtime. Mitigation: keep checks in `tests/e2e/smoke.spec.ts` targeted and reuse existing page loads where possible.
- **RISK-005**: Pagefind behavior differs before and after `web` build. Mitigation: run Playwright against the configured build-and-preview server, not only Astro dev server.
- **ASSUMPTION-001**: Existing category slugs remain stable to preserve URLs and archive links.
- **ASSUMPTION-002**: The primary competitive differentiator is fast technical reading decisions, not general-purpose news coverage.
- **ASSUMPTION-003**: The dashboard remains static-first and does not add accounts, personalization, or server-side user state.

## 8. Related Specifications / Further Reading

- `.github/copilot-instructions.md`
- `.claude/skills/self-critique/SKILL.md`
- `.claude/skills/ui-display-guard/SKILL.md`
- `.claude/skills/modern-web-guidance/SKILL.md`
- `web/src/lib/data.ts`
- `web/src/pages/index.astro`
- `tests/e2e/smoke.spec.ts`
- `tests/data-schema.test.ts`
