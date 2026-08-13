import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
} from "@playwright/test";

export const DECISION_JOURNEY_SCHEMA_VERSION = 3 as const;
export const DECISION_JOURNEY_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DECISION_JOURNEY_STEP_TIMEOUT_MS = 20_000;

export const DECISION_JOURNEY_VIEWPORTS = [
  {
    name: "desktop",
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
  },
  {
    name: "mobile",
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  },
] as const;

export const DECISION_JOURNEY_STEPS = [
  {
    name: "home_first_actionable_decision",
    startCondition: "Navigate to the production-built Home page in a fresh browser context.",
    completionCondition:
      "A summary-ready Spotlight article exposes a visible title link, source authority, and decision summary.",
  },
  {
    name: "search_exact_or_zero_recovery",
    startCondition:
      "Start from Home and open the production search control using the visible trigger for the viewport.",
    completionCondition:
      "The selected Timeline article appears as an exact result, or a corpus without an internal candidate exposes the truthful zero-result recovery links.",
  },
  {
    name: "subscription_path_discovery",
    startCondition: "Start from Home and open the production navigation menu.",
    completionCondition:
      "About is reached through the menu and its site-wide RSS, JSON Feed, and OPML actions are visible.",
  },
  {
    name: "not_found_recovery",
    startCondition: "Navigate to a deliberately unknown article detail route.",
    completionCondition:
      "The server returns HTTP 404 and the branded page exposes Search, Archive, and Home recovery actions.",
  },
  {
    name: "pending_summary_or_fully_summarized",
    startCondition: "Inspect the generated Home corpus for a real pending-summary article.",
    completionCondition:
      "A present pending article opens an honest pending detail state, or zero pending cards is recorded as a valid fully summarized corpus.",
  },
] as const;

export type DecisionJourneyViewportName =
  (typeof DECISION_JOURNEY_VIEWPORTS)[number]["name"];
export type DecisionJourneyStepName =
  (typeof DECISION_JOURNEY_STEPS)[number]["name"];
export type DecisionJourneyFailureStep =
  | DecisionJourneyStepName
  | "harness_build"
  | "harness_browser_context"
  | "harness_playwright_execution";
export type DecisionJourneyStepStatus =
  | "completed"
  | "not_applicable"
  | "failed";

export interface DecisionJourneyFailure {
  stepName: DecisionJourneyFailureStep;
  reason: string;
  observedState: Record<string, unknown>;
}

export interface DecisionJourneyStepResult {
  name: DecisionJourneyStepName;
  startCondition: string;
  completionCondition: string;
  status: DecisionJourneyStepStatus;
  elapsedMs: number;
  viewport: DecisionJourneyViewportName;
  route: string;
  actionCount: number;
  actionLimit: number;
  actions: DecisionJourneyAction[];
  documentNavigationCount: number;
  expectedDocumentRoutes: string[];
  documentRoutes: string[];
  navigationStable: boolean;
  completionViewport: DecisionJourneyCompletionViewport;
  evidence: Record<string, unknown>;
  failure?: DecisionJourneyFailure;
}

export interface DecisionJourneyAction {
  type: "click" | "fill";
  target: string;
}

export interface DecisionJourneyCompletionViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface DecisionJourneyViewportResult {
  viewport: {
    name: DecisionJourneyViewportName;
    width: number;
    height: number;
  };
  status: "completed" | "failed";
  elapsedMs: number;
  steps: DecisionJourneyStepResult[];
  failure?: DecisionJourneyFailure;
}

export interface DecisionJourneyReport {
  schemaVersion: typeof DECISION_JOURNEY_SCHEMA_VERSION;
  measurementKind: "local-synthetic-decision-journey";
  fieldData: false;
  timingAssessment: "informational-only";
  disclaimer:
    "Elapsed milliseconds are informational local synthetic timings from a production Web build. They do not determine pass/fail and are not field data or Core Web Vitals.";
  commit: string;
  generatedAt: string;
  outputLimitBytes: typeof DECISION_JOURNEY_OUTPUT_LIMIT_BYTES;
  status: "completed" | "failed";
  elapsedMs: number;
  runs: DecisionJourneyViewportResult[];
  failure?: DecisionJourneyFailure;
}

interface TimerDependencies {
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

interface MeasuredStepDefinition {
  name: DecisionJourneyStepName;
  startCondition: string;
  completionCondition: string;
  actionLimit: number;
  execute: (activity: DecisionJourneyActivity) => Promise<{
    status?: Exclude<DecisionJourneyStepStatus, "failed">;
    expectedDocumentRoutes: string[];
    evidence: Record<string, unknown>;
  }>;
  observe: () => Promise<Record<string, unknown>>;
}

interface DecisionJourneyActivity {
  readonly actions: DecisionJourneyAction[];
  readonly documentRoutes: string[];
  click: (locator: Locator, target: string) => Promise<void>;
  fill: (locator: Locator, target: string, value: string) => Promise<void>;
  stop: () => void;
}

interface JourneyRuntime {
  page: Page;
  runtimeErrors: string[];
  exactSearchCandidate: {
    href: string;
    title: string;
  } | null;
}

const TIMELINE_ENTRY_LINK_SELECTOR =
  'main article.card h3.title > a[href^="/e/"]';
const UNKNOWN_ARTICLE_ROUTE = "/e/0000000000000000/";
const ZERO_RESULT_QUERY = "techdb-synthetic-no-match-9f6f2e45";
const OBSERVATION_TIMEOUT_MS = 1_000;
const EVIDENCE_MAX_STRING_LENGTH = 320;
const EVIDENCE_MAX_ARRAY_LENGTH = 12;
const EVIDENCE_MAX_OBJECT_KEYS = 24;

async function readerFacingTitle(link: Locator): Promise<string> {
  return link
    .locator(":scope > .i18n-ja:visible, :scope > .i18n-en:visible")
    .first()
    .evaluate((node) => {
      const clone = node.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(
          ".language-fallback-badge, [data-external-link-hint]",
        )
        .forEach((element) => element.remove());
      return clone.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    });
}

export function isExactSearchTitleCandidate(title: string): boolean {
  const normalized = title.replace(/\s+/gu, " ").trim();
  if (
    normalized.length < 8
    || normalized.length > 160
    || /[=<>{}]/u.test(normalized)
  ) {
    return false;
  }
  const hasJapanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
    .test(normalized);
  const wordCount = normalized.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return hasJapanese ? normalized.length >= 10 : wordCount >= 2;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function routeFor(page: Page): string {
  try {
    const url = new URL(page.url());
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function documentRoute(url: string): string {
  const pathname = new URL(url).pathname.replace(/\/+$/u, "");
  return pathname || "/";
}

function createDecisionJourneyActivity(page: Page): DecisionJourneyActivity {
  const actions: DecisionJourneyAction[] = [];
  const documentRoutes: string[] = [];
  const recordNavigation = (request: Request) => {
    if (
      request.isNavigationRequest()
      && request.frame() === page.mainFrame()
      && request.resourceType() === "document"
    ) {
      documentRoutes.push(documentRoute(request.url()));
    }
  };
  page.on("request", recordNavigation);

  return {
    actions,
    documentRoutes,
    async click(locator, target) {
      actions.push({ type: "click", target });
      await locator.click({ timeout: 10_000 });
    },
    async fill(locator, target, value) {
      actions.push({ type: "fill", target });
      await locator.fill(value);
    },
    stop() {
      page.off("request", recordNavigation);
    },
  };
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function deterministicStepContractFailure(input: {
  actionCount: number;
  actionLimit: number;
  documentRoutes: string[];
  expectedDocumentRoutes: string[];
  runtimeErrors: string[];
  allowExpected404Console?: boolean;
}): string | null {
  if (input.actionCount > input.actionLimit) {
    return `action count ${input.actionCount} exceeds limit ${input.actionLimit}`;
  }
  if (!sameStringArray(input.documentRoutes, input.expectedDocumentRoutes)) {
    return `document routes ${JSON.stringify(input.documentRoutes)} do not match ${JSON.stringify(
      input.expectedDocumentRoutes,
    )}`;
  }
  const unexpectedRuntimeErrors = input.runtimeErrors.filter(
    (message) =>
      !(
        input.allowExpected404Console
        && message.includes("status of 404")
      ),
  );
  if (unexpectedRuntimeErrors.length > 0) {
    return `unexpected runtime errors: ${unexpectedRuntimeErrors.join(" | ")}`;
  }
  return null;
}

async function completionViewport(
  page: Page,
): Promise<DecisionJourneyCompletionViewport> {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }));
}

async function visibleGeometry(locator: Locator): Promise<{
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  intersectsViewport: boolean;
}> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      intersectsViewport:
        rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth,
    };
  });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, EVIDENCE_MAX_STRING_LENGTH);
}

export function boundedEvidence(
  value: unknown,
  depth = 0,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return value.length <= EVIDENCE_MAX_STRING_LENGTH
      ? value
      : `${value.slice(0, EVIDENCE_MAX_STRING_LENGTH - 1)}…`;
  }
  if (depth >= 4) return "[depth-limited]";
  if (Array.isArray(value)) {
    return value
      .slice(0, EVIDENCE_MAX_ARRAY_LENGTH)
      .map((entry) => boundedEvidence(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, EVIDENCE_MAX_OBJECT_KEYS)
        .map(([key, entry]) => [key, boundedEvidence(entry, depth + 1)]),
    );
  }
  return String(value);
}

function normalizedEvidence(value: unknown): Record<string, unknown> {
  const bounded = boundedEvidence(value);
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : { value: bounded };
}

export class DecisionJourneyTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`operation exceeded ${timeoutMs}ms`);
    this.name = "DecisionJourneyTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function withBoundedTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  dependencies: TimerDependencies = {},
): Promise<T> {
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? clearTimeout;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeoutImpl(
      () => reject(new DecisionJourneyTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeoutImpl(timeoutHandle);
  }
}

export async function withResourceCleanup<
  Resource extends { close: () => Promise<unknown> },
  Result,
>(
  create: () => Promise<Resource>,
  execute: (resource: Resource) => Promise<Result>,
): Promise<Result> {
  const resource = await create();
  try {
    return await execute(resource);
  } finally {
    await resource.close();
  }
}

export function pendingSummaryOutcome(pendingCount: number): {
  status: Exclude<DecisionJourneyStepStatus, "failed">;
  corpusState: "pending-summary-present" | "fully-summarized-corpus";
} {
  if (!Number.isInteger(pendingCount) || pendingCount < 0) {
    throw new Error(`pendingCount must be a non-negative integer: ${pendingCount}`);
  }
  return pendingCount > 0
    ? { status: "completed", corpusState: "pending-summary-present" }
    : { status: "not_applicable", corpusState: "fully-summarized-corpus" };
}

async function observeBounded(
  observe: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return normalizedEvidence(
      await withBoundedTimeout(observe(), OBSERVATION_TIMEOUT_MS),
    );
  } catch (error) {
    return { observationError: errorMessage(error) };
  }
}

async function measureStep(
  definition: MeasuredStepDefinition,
  viewport: DecisionJourneyViewportName,
  page: Page,
): Promise<DecisionJourneyStepResult> {
  const startedAt = performance.now();
  const activity = createDecisionJourneyActivity(page);
  let expectedDocumentRoutes: string[] = [];
  try {
    const result = await withBoundedTimeout(
      definition.execute(activity),
      DECISION_JOURNEY_STEP_TIMEOUT_MS,
    );
    expectedDocumentRoutes = result.expectedDocumentRoutes;
    const runtimeErrors = Array.isArray(result.evidence.runtimeErrors)
      ? result.evidence.runtimeErrors.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const contractFailure = deterministicStepContractFailure({
      actionCount: activity.actions.length,
      actionLimit: definition.actionLimit,
      documentRoutes: activity.documentRoutes,
      expectedDocumentRoutes,
      runtimeErrors,
      allowExpected404Console: definition.name === "not_found_recovery",
    });
    if (contractFailure) throw new Error(contractFailure);
    return {
      name: definition.name,
      startCondition: definition.startCondition,
      completionCondition: definition.completionCondition,
      status: result.status ?? "completed",
      elapsedMs: elapsedSince(startedAt),
      viewport,
      route: routeFor(page),
      actionCount: activity.actions.length,
      actionLimit: definition.actionLimit,
      actions: [...activity.actions],
      documentNavigationCount: activity.documentRoutes.length,
      expectedDocumentRoutes,
      documentRoutes: [...activity.documentRoutes],
      navigationStable: true,
      completionViewport: await completionViewport(page),
      evidence: normalizedEvidence(result.evidence),
    };
  } catch (error) {
    const observedState = normalizedEvidence({
      ...(await observeBounded(definition.observe)),
      actionCount: activity.actions.length,
      actionLimit: definition.actionLimit,
      actions: activity.actions,
      documentRoutes: activity.documentRoutes,
      expectedDocumentRoutes,
    });
    const failure: DecisionJourneyFailure = {
      stepName: definition.name,
      reason: errorMessage(error),
      observedState,
    };
    return {
      name: definition.name,
      startCondition: definition.startCondition,
      completionCondition: definition.completionCondition,
      status: "failed",
      elapsedMs: elapsedSince(startedAt),
      viewport,
      route: routeFor(page),
      actionCount: activity.actions.length,
      actionLimit: definition.actionLimit,
      actions: [...activity.actions],
      documentNavigationCount: activity.documentRoutes.length,
      expectedDocumentRoutes,
      documentRoutes: [...activity.documentRoutes],
      navigationStable: sameStringArray(
        activity.documentRoutes,
        expectedDocumentRoutes,
      ),
      completionViewport: await completionViewport(page),
      evidence: observedState,
      failure,
    };
  } finally {
    activity.stop();
  }
}

function journeyStepDefinitions(
  runtime: JourneyRuntime,
  baseURL: string,
  viewport: (typeof DECISION_JOURNEY_VIEWPORTS)[number],
): MeasuredStepDefinition[] {
  const { page, runtimeErrors } = runtime;
  let notFoundStatus: number | null = null;
  let pendingCount: number | null = null;

  return [
    {
      ...DECISION_JOURNEY_STEPS[0],
      actionLimit: 0,
      execute: async () => {
        const response = await page.goto(`${baseURL}/`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        if (!response || response.status() >= 400) {
          throw new Error(`Home returned ${response?.status() ?? "no response"}`);
        }
        const priority = page.locator(
          '#today-priority[data-decision-eligibility="summary-ready"]',
        );
        const spotlight = priority.locator("article.featured");
        const link = spotlight.locator(".featured-title > a");
        await spotlight.waitFor({ state: "visible", timeout: 15_000 });
        await link.waitFor({ state: "visible", timeout: 15_000 });
        await spotlight
          .locator(".featured-meta [data-source-authority]")
          .waitFor({ state: "visible", timeout: 15_000 });
        const summary = spotlight.locator(".featured-summary:visible");
        await summary.waitFor({ state: "visible", timeout: 15_000 });
        const href = await link.getAttribute("href");
        if (!href) throw new Error("Spotlight article link has no href");
        const geometry = await visibleGeometry(spotlight);
        if (!geometry.intersectsViewport) {
          throw new Error("Spotlight does not intersect the initial viewport");
        }
        return {
          expectedDocumentRoutes: ["/"],
          evidence: {
            surface: "spotlight",
            href,
            title: (await link.innerText()).trim(),
            sourceAuthority:
              await spotlight
                .locator(".featured-meta [data-source-authority]")
                .getAttribute("data-source-authority"),
            summaryCharacters: (await summary.innerText()).trim().length,
            geometry,
            runtimeErrors,
          },
        };
      },
      observe: async () => ({
        url: page.url(),
        priorityCount: await page.locator("#today-priority").count(),
        spotlightCount: await page.locator("article.featured").count(),
        visibleSpotlights: await page.locator("article.featured:visible").count(),
        runtimeErrors,
      }),
    },
    {
      ...DECISION_JOURNEY_STEPS[1],
      actionLimit: viewport.name === "mobile" ? 3 : 2,
      execute: async (activity) => {
        await page.goto(`${baseURL}/`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        const candidates = page.locator(TIMELINE_ENTRY_LINK_SELECTOR);
        const candidateCount = Math.min(await candidates.count(), 12);
        for (let index = 0; index < candidateCount; index += 1) {
          const candidate = candidates.nth(index);
          const href = await candidate.getAttribute("href");
          const title = await readerFacingTitle(candidate);
          if (href && isExactSearchTitleCandidate(title)) {
            runtime.exactSearchCandidate = { href, title };
            break;
          }
        }

        const visibleSearchTrigger = page
          .locator("button[data-search-trigger]:visible")
          .first();
        if ((await visibleSearchTrigger.count()) === 0) {
          const menuTrigger = page.locator("button[data-menu-trigger]:visible").first();
          await activity.click(menuTrigger, "open-menu");
          await activity.click(
            page.locator("#site-menu [data-search-trigger]"),
            "open-search-from-menu",
          );
        } else {
          await activity.click(visibleSearchTrigger, "open-search");
        }

        const input = page.locator("#pagefind-search-input");
        await input.waitFor({ state: "visible", timeout: 10_000 });
        const query = runtime.exactSearchCandidate?.title ?? ZERO_RESULT_QUERY;
        await activity.fill(input, "search-query", query);
        const settledPanel = page.locator("#pagefind-results:not([aria-busy])");
        await settledPanel.waitFor({ state: "visible", timeout: 18_000 });

        if (runtime.exactSearchCandidate) {
          const exactHit = settledPanel.locator(
            `.search-hit[href="${runtime.exactSearchCandidate.href}"]`,
          );
          await exactHit.waitFor({ state: "visible", timeout: 8_000 });
          const geometry = await visibleGeometry(exactHit);
          if (!geometry.intersectsViewport) {
            throw new Error("Exact search result does not intersect the viewport");
          }
          return {
            expectedDocumentRoutes: ["/"],
            evidence: {
              outcome: "exact-result",
              query,
              href: runtime.exactSearchCandidate.href,
              matchScope: await exactHit.getAttribute("data-match-scope"),
              hitCount: await settledPanel.locator(".search-hit").count(),
              geometry,
              runtimeErrors,
            },
          };
        }

        const zeroState = settledPanel.locator(".search-empty");
        const recoveryActions = zeroState.locator(".search-empty-actions a");
        await zeroState.waitFor({ state: "visible", timeout: 2_000 });
        if ((await recoveryActions.count()) !== 3) {
          throw new Error("Zero-result state does not expose all three recovery actions");
        }
        const geometry = await visibleGeometry(zeroState);
        if (!geometry.intersectsViewport) {
          throw new Error("Zero-result recovery does not intersect the viewport");
        }
        return {
          expectedDocumentRoutes: ["/"],
          evidence: {
            outcome: "truthful-zero-result-recovery",
            query,
            recoveryHrefs: await recoveryActions.evaluateAll((links) =>
              links.map((link) => link.getAttribute("href")),
            ),
            geometry,
            runtimeErrors,
          },
        };
      },
      observe: async () => ({
        url: page.url(),
        inputValue: await page.locator("#pagefind-search-input").inputValue().catch(() => ""),
        panelBusy: await page.locator("#pagefind-results").getAttribute("aria-busy"),
        hitCount: await page.locator("#pagefind-results .search-hit").count(),
        zeroStateText: await page
          .locator("#pagefind-results .search-empty")
          .innerText()
          .catch(() => ""),
        expectedHref: runtime.exactSearchCandidate?.href ?? null,
        runtimeErrors,
      }),
    },
    {
      ...DECISION_JOURNEY_STEPS[2],
      actionLimit: 2,
      execute: async (activity) => {
        await page.goto(`${baseURL}/`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        await activity.click(
          page.locator("button[data-menu-trigger]:visible").first(),
          "open-menu",
        );
        const menu = page.locator("#site-menu");
        await menu.waitFor({ state: "visible", timeout: 10_000 });
        await Promise.all([
          page.waitForURL(/\/about\/?$/, { timeout: 10_000 }),
          activity.click(menu.locator('a[href="/about"]'), "open-about"),
        ]);

        const rss = page.locator('.page-hero-actions a[href="/rss.xml"]');
        const jsonFeed = page.locator('.page-hero-actions a[href="/feed.json"]');
        const opml = page.locator('.page-hero-actions a[href="/feeds.opml"]');
        await Promise.all([
          rss.waitFor({ state: "visible", timeout: 10_000 }),
          jsonFeed.waitFor({ state: "visible", timeout: 10_000 }),
          opml.waitFor({ state: "visible", timeout: 10_000 }),
        ]);
        const actionGeometry = await Promise.all(
          [rss, jsonFeed, opml].map((action) => visibleGeometry(action)),
        );
        if (actionGeometry.some((geometry) => !geometry.intersectsViewport)) {
          throw new Error("A subscription action does not intersect the viewport");
        }
        return {
          expectedDocumentRoutes: ["/", "/about"],
          evidence: {
            menuDestination: "/about",
            subscriptionHrefs: [
              await rss.getAttribute("href"),
              await jsonFeed.getAttribute("href"),
              await opml.getAttribute("href"),
            ],
            opmlMediaType: await opml.getAttribute("type"),
            actionGeometry,
            runtimeErrors,
          },
        };
      },
      observe: async () => ({
        url: page.url(),
        menuVisible: await page.locator("#site-menu").isVisible().catch(() => false),
        aboutMenuLinkCount: await page.locator('#site-menu a[href="/about"]').count(),
        visibleFeedActions: await page
          .locator(
            '.page-hero-actions a[href="/rss.xml"]:visible, .page-hero-actions a[href="/feed.json"]:visible, .page-hero-actions a[href="/feeds.opml"]:visible',
          )
          .count(),
        runtimeErrors,
      }),
    },
    {
      ...DECISION_JOURNEY_STEPS[3],
      actionLimit: 0,
      execute: async () => {
        const response = await page.goto(`${baseURL}${UNKNOWN_ARTICLE_ROUTE}`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        notFoundStatus = response?.status() ?? null;
        if (notFoundStatus !== 404) {
          throw new Error(`Unknown route returned ${notFoundStatus ?? "no response"}`);
        }
        await page
          .locator("#not-found-heading")
          .waitFor({ state: "visible", timeout: 10_000 });
        const actions = page.locator("[data-recovery-action]");
        if ((await actions.count()) !== 3) {
          throw new Error("404 page does not expose all three recovery actions");
        }
        const exactRecoveryPath = await actions.evaluateAll((links) =>
          links.map((link) => ({
            action: link.getAttribute("data-recovery-action"),
            href: link.getAttribute("href"),
          })),
        );
        const expectedRecoveryPath = [
          { action: "search", href: "/search" },
          { action: "archive", href: "/archive" },
          { action: "home", href: "/" },
        ];
        if (JSON.stringify(exactRecoveryPath) !== JSON.stringify(expectedRecoveryPath)) {
          throw new Error("404 recovery path does not match the product contract");
        }
        return {
          expectedDocumentRoutes: [
            documentRoute(`${baseURL}${UNKNOWN_ARTICLE_ROUTE}`),
          ],
          evidence: {
            httpStatus: notFoundStatus,
            recoveryActions: exactRecoveryPath,
            runtimeErrors,
          },
        };
      },
      observe: async () => ({
        url: page.url(),
        httpStatus: notFoundStatus,
        headingVisible: await page
          .locator("#not-found-heading")
          .isVisible()
          .catch(() => false),
        recoveryActionCount: await page.locator("[data-recovery-action]").count(),
        runtimeErrors,
      }),
    },
    {
      ...DECISION_JOURNEY_STEPS[4],
      actionLimit: 1,
      execute: async (activity) => {
        await page.goto(`${baseURL}/`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        const pendingCards = page.locator(
          '#timeline article.card[data-summary-state="pending"]',
        );
        pendingCount = await pendingCards.count();
        const outcome = pendingSummaryOutcome(pendingCount);
        if (pendingCount === 0) {
          return {
            status: outcome.status,
            expectedDocumentRoutes: ["/"],
            evidence: {
              corpusState: outcome.corpusState,
              pendingCardCount: 0,
              runtimeErrors,
            },
          };
        }

        const pendingCard = pendingCards.first();
        const detailHref = await pendingCard
          .locator('a[href^="/e/"]')
          .first()
          .getAttribute("href");
        if (!detailHref) throw new Error("Pending card has no internal detail link");
        await Promise.all([
          page.waitForURL(new RegExp(`${detailHref.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`), {
            timeout: 15_000,
          }),
          activity.click(
            pendingCard.locator('a[href^="/e/"]').first(),
            "open-pending-detail",
          ),
        ]);
        const article = page.locator(
          'article.entry-detail[data-summary-state="pending"]',
        );
        await article.waitFor({ state: "visible", timeout: 10_000 });
        await article
          .locator(".ed-pending-summary")
          .waitFor({ state: "visible", timeout: 10_000 });
        return {
          expectedDocumentRoutes: ["/", documentRoute(`${baseURL}${detailHref}`)],
          evidence: {
            corpusState: outcome.corpusState,
            pendingCardCount: pendingCount,
            detailHref,
            detailSummaryState: await article.getAttribute("data-summary-state"),
            sourceExcerptVisible: await article
              .locator("[data-source-excerpt]")
              .isVisible()
              .catch(() => false),
            runtimeErrors,
          },
        };
      },
      observe: async () => ({
        url: page.url(),
        pendingCardCount: pendingCount,
        detailSummaryState: await page
          .locator("article.entry-detail")
          .getAttribute("data-summary-state")
          .catch(() => null),
        pendingPanelVisible: await page
          .locator(".ed-pending-summary")
          .isVisible()
          .catch(() => false),
        runtimeErrors,
      }),
    },
  ];
}

async function runJourneyInContext(
  context: BrowserContext,
  viewport: (typeof DECISION_JOURNEY_VIEWPORTS)[number],
  baseURL: string,
): Promise<DecisionJourneyViewportResult> {
  const startedAt = performance.now();
  const page = await context.newPage();
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (runtimeErrors.length < EVIDENCE_MAX_ARRAY_LENGTH) {
      runtimeErrors.push(`pageerror: ${error.message}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && runtimeErrors.length < EVIDENCE_MAX_ARRAY_LENGTH) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  const runtime: JourneyRuntime = {
    page,
    runtimeErrors,
    exactSearchCandidate: null,
  };
  const steps: DecisionJourneyStepResult[] = [];

  for (const definition of journeyStepDefinitions(runtime, baseURL, viewport)) {
    runtimeErrors.length = 0;
    const result = await measureStep(definition, viewport.name, page);
    steps.push(result);
    if (result.status === "failed") {
      return {
        viewport: {
          name: viewport.name,
          width: viewport.width,
          height: viewport.height,
        },
        status: "failed",
        elapsedMs: elapsedSince(startedAt),
        steps,
      };
    }
  }

  return {
    viewport: {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
    },
    status: "completed",
    elapsedMs: elapsedSince(startedAt),
    steps,
  };
}

export async function measureDecisionJourneyViewport(
  browser: Browser,
  baseURL: string,
  viewport: (typeof DECISION_JOURNEY_VIEWPORTS)[number],
): Promise<DecisionJourneyViewportResult> {
  const startedAt = performance.now();
  try {
    return await withResourceCleanup(
      () =>
        browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
        }),
      (context) => runJourneyInContext(context, viewport, baseURL),
    );
  } catch (error) {
    const failure: DecisionJourneyFailure = {
      stepName: "harness_browser_context",
      reason: errorMessage(error),
      observedState: {
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
      },
    };
    return {
      viewport: {
        name: viewport.name,
        width: viewport.width,
        height: viewport.height,
      },
      status: "failed",
      elapsedMs: elapsedSince(startedAt),
      steps: [],
      failure,
    };
  }
}

function firstRunFailure(
  runs: DecisionJourneyViewportResult[],
): DecisionJourneyFailure | undefined {
  for (const run of runs) {
    if (run.failure) return run.failure;
    const failedStep = run.steps.find((step) => step.status === "failed");
    if (failedStep?.failure) return failedStep.failure;
  }
  return undefined;
}

export function createDecisionJourneyReport(
  commit: string,
  generatedAt: string,
  elapsedMs: number,
  runs: DecisionJourneyViewportResult[],
): DecisionJourneyReport {
  const runFailure = firstRunFailure(runs);
  const completedViewports = new Set(
    runs
      .filter((run) => run.status === "completed")
      .map((run) => run.viewport.name),
  );
  const status =
    !runFailure
    && completedViewports.has("desktop")
    && completedViewports.has("mobile")
      ? "completed"
      : "failed";

  return {
    schemaVersion: DECISION_JOURNEY_SCHEMA_VERSION,
    measurementKind: "local-synthetic-decision-journey",
    fieldData: false,
    timingAssessment: "informational-only",
    disclaimer:
      "Elapsed milliseconds are informational local synthetic timings from a production Web build. They do not determine pass/fail and are not field data or Core Web Vitals.",
    commit,
    generatedAt,
    outputLimitBytes: DECISION_JOURNEY_OUTPUT_LIMIT_BYTES,
    status,
    elapsedMs,
    runs,
    failure: runFailure,
  };
}

export function createInfrastructureFailureReport(
  commit: string,
  stepName: Extract<
    DecisionJourneyFailureStep,
    "harness_build" | "harness_playwright_execution"
  >,
  reason: string,
  observedState: Record<string, unknown>,
): DecisionJourneyReport {
  return {
    schemaVersion: DECISION_JOURNEY_SCHEMA_VERSION,
    measurementKind: "local-synthetic-decision-journey",
    fieldData: false,
    timingAssessment: "informational-only",
    disclaimer:
      "Elapsed milliseconds are informational local synthetic timings from a production Web build. They do not determine pass/fail and are not field data or Core Web Vitals.",
    commit,
    generatedAt: new Date().toISOString(),
    outputLimitBytes: DECISION_JOURNEY_OUTPUT_LIMIT_BYTES,
    status: "failed",
    elapsedMs: 0,
    runs: [],
    failure: {
      stepName,
      reason: errorMessage(reason),
      observedState: normalizedEvidence(observedState),
    },
  };
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertFiniteNonNegative(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

export function validateDecisionJourneyReport(
  value: unknown,
): asserts value is DecisionJourneyReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("report must be an object");
  }
  const report = value as Partial<DecisionJourneyReport>;
  if (report.schemaVersion !== DECISION_JOURNEY_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${DECISION_JOURNEY_SCHEMA_VERSION}`);
  }
  if (report.measurementKind !== "local-synthetic-decision-journey") {
    throw new Error("measurementKind is invalid");
  }
  if (report.fieldData !== false) throw new Error("fieldData must be false");
  if (report.timingAssessment !== "informational-only") {
    throw new Error("timingAssessment must be informational-only");
  }
  if (report.disclaimer !==
    "Elapsed milliseconds are informational local synthetic timings from a production Web build. They do not determine pass/fail and are not field data or Core Web Vitals.") {
    throw new Error("disclaimer is invalid");
  }
  assertString(report.commit, "commit");
  assertString(report.generatedAt, "generatedAt");
  if (!Number.isFinite(Date.parse(report.generatedAt))) {
    throw new Error("generatedAt must be RFC3339-compatible");
  }
  if (report.outputLimitBytes !== DECISION_JOURNEY_OUTPUT_LIMIT_BYTES) {
    throw new Error(
      `outputLimitBytes must be ${DECISION_JOURNEY_OUTPUT_LIMIT_BYTES}`,
    );
  }
  if (report.status !== "completed" && report.status !== "failed") {
    throw new Error("status must be completed or failed");
  }
  assertFiniteNonNegative(report.elapsedMs, "elapsedMs");
  if (!Array.isArray(report.runs)) throw new Error("runs must be an array");

  const requiredStepNames = DECISION_JOURNEY_STEPS.map((step) => step.name);
  for (const [runIndex, run] of report.runs.entries()) {
    if (!run || typeof run !== "object") {
      throw new Error(`runs[${runIndex}] must be an object`);
    }
    if (!["desktop", "mobile"].includes(run.viewport?.name)) {
      throw new Error(`runs[${runIndex}].viewport.name is invalid`);
    }
    assertFiniteNonNegative(run.viewport?.width, `runs[${runIndex}].viewport.width`);
    assertFiniteNonNegative(run.viewport?.height, `runs[${runIndex}].viewport.height`);
    if (run.status !== "completed" && run.status !== "failed") {
      throw new Error(`runs[${runIndex}].status is invalid`);
    }
    assertFiniteNonNegative(run.elapsedMs, `runs[${runIndex}].elapsedMs`);
    if (!Array.isArray(run.steps)) {
      throw new Error(`runs[${runIndex}].steps must be an array`);
    }
    const names = run.steps.map((step) => step.name);
    if (new Set(names).size !== names.length) {
      throw new Error(`runs[${runIndex}].steps contains duplicate names`);
    }
    for (const [stepIndex, step] of run.steps.entries()) {
      if (!requiredStepNames.includes(step.name)) {
        throw new Error(`runs[${runIndex}].steps[${stepIndex}].name is invalid`);
      }
      assertString(
        step.startCondition,
        `runs[${runIndex}].steps[${stepIndex}].startCondition`,
      );
      assertString(
        step.completionCondition,
        `runs[${runIndex}].steps[${stepIndex}].completionCondition`,
      );
      if (!["completed", "not_applicable", "failed"].includes(step.status)) {
        throw new Error(`runs[${runIndex}].steps[${stepIndex}].status is invalid`);
      }
      assertFiniteNonNegative(
        step.elapsedMs,
        `runs[${runIndex}].steps[${stepIndex}].elapsedMs`,
      );
      if (step.viewport !== run.viewport.name) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].viewport does not match its run`,
        );
      }
      if (typeof step.route !== "string" || !step.route.startsWith("/")) {
        throw new Error(`runs[${runIndex}].steps[${stepIndex}].route is invalid`);
      }
      assertFiniteNonNegative(
        step.actionCount,
        `runs[${runIndex}].steps[${stepIndex}].actionCount`,
      );
      assertFiniteNonNegative(
        step.actionLimit,
        `runs[${runIndex}].steps[${stepIndex}].actionLimit`,
      );
      if (
        !Number.isInteger(step.actionCount)
        || !Number.isInteger(step.actionLimit)
      ) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}] action counts must be integers`,
        );
      }
      if (!Array.isArray(step.actions) || step.actions.length !== step.actionCount) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].actions must match actionCount`,
        );
      }
      for (const action of step.actions) {
        if (
          !action
          || (action.type !== "click" && action.type !== "fill")
          || typeof action.target !== "string"
          || !action.target
        ) {
          throw new Error(
            `runs[${runIndex}].steps[${stepIndex}].actions contains an invalid action`,
          );
        }
      }
      assertFiniteNonNegative(
        step.documentNavigationCount,
        `runs[${runIndex}].steps[${stepIndex}].documentNavigationCount`,
      );
      if (!Number.isInteger(step.documentNavigationCount)) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].documentNavigationCount must be an integer`,
        );
      }
      if (
        !Array.isArray(step.documentRoutes)
        || step.documentRoutes.length !== step.documentNavigationCount
        || step.documentRoutes.some(
          (documentRouteValue) =>
            typeof documentRouteValue !== "string"
            || !documentRouteValue.startsWith("/"),
        )
      ) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].documentRoutes is invalid`,
        );
      }
      if (
        !Array.isArray(step.expectedDocumentRoutes)
        || step.expectedDocumentRoutes.some(
          (expectedRoute) =>
            typeof expectedRoute !== "string" || !expectedRoute.startsWith("/"),
        )
      ) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].expectedDocumentRoutes is invalid`,
        );
      }
      if (typeof step.navigationStable !== "boolean") {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].navigationStable must be boolean`,
        );
      }
      if (!step.completionViewport || typeof step.completionViewport !== "object") {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}].completionViewport is invalid`,
        );
      }
      assertFiniteNonNegative(
        step.completionViewport.width,
        `runs[${runIndex}].steps[${stepIndex}].completionViewport.width`,
      );
      assertFiniteNonNegative(
        step.completionViewport.height,
        `runs[${runIndex}].steps[${stepIndex}].completionViewport.height`,
      );
      assertFiniteNonNegative(
        step.completionViewport.scrollX,
        `runs[${runIndex}].steps[${stepIndex}].completionViewport.scrollX`,
      );
      assertFiniteNonNegative(
        step.completionViewport.scrollY,
        `runs[${runIndex}].steps[${stepIndex}].completionViewport.scrollY`,
      );
      if (!step.evidence || typeof step.evidence !== "object") {
        throw new Error(`runs[${runIndex}].steps[${stepIndex}].evidence is invalid`);
      }
      if (step.status !== "failed") {
        if (step.actionCount > step.actionLimit) {
          throw new Error(
            `runs[${runIndex}].steps[${stepIndex}] exceeds its action limit`,
          );
        }
        if (
          !step.navigationStable
          || !sameStringArray(
            step.documentRoutes,
            step.expectedDocumentRoutes,
          )
        ) {
          throw new Error(
            `runs[${runIndex}].steps[${stepIndex}] has unexpected document navigation`,
          );
        }
      }
      if (step.status === "failed" && step.failure?.stepName !== step.name) {
        throw new Error(
          `runs[${runIndex}].steps[${stepIndex}] must identify its exact failed step`,
        );
      }
    }
    if (run.status === "completed") {
      if (names.length !== requiredStepNames.length) {
        throw new Error(`runs[${runIndex}] completed without every required step`);
      }
      for (const requiredName of requiredStepNames) {
        if (!names.includes(requiredName)) {
          throw new Error(`runs[${runIndex}] is missing ${requiredName}`);
        }
      }
      if (run.steps.some((step) => step.status === "failed")) {
        throw new Error(`runs[${runIndex}] is completed with a failed step`);
      }
      if (run.failure) {
        throw new Error(`runs[${runIndex}] is completed with a failure`);
      }
    } else if (
      !run.failure
      && !run.steps.some((step) => step.status === "failed" && step.failure)
    ) {
      throw new Error(`runs[${runIndex}] failed without exact failure evidence`);
    }
  }

  if (report.status === "completed") {
    const names = new Set(report.runs.map((run) => run.viewport.name));
    if (
      report.runs.length !== DECISION_JOURNEY_VIEWPORTS.length
      || !names.has("desktop")
      || !names.has("mobile")
      || report.runs.some((run) => run.status !== "completed")
    ) {
      throw new Error("completed report requires completed desktop and mobile runs");
    }
    if (report.failure) throw new Error("completed report must not contain failure");
  } else if (!report.failure && !report.runs.some((run) => run.status === "failed")) {
    throw new Error("failed report must expose exact failure evidence");
  }
}

export function serializeDecisionJourneyReport(
  report: DecisionJourneyReport,
): string {
  validateDecisionJourneyReport(report);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > DECISION_JOURNEY_OUTPUT_LIMIT_BYTES) {
    throw new Error(
      `decision journey output is ${bytes} bytes; limit is ${DECISION_JOURNEY_OUTPUT_LIMIT_BYTES}`,
    );
  }
  return serialized;
}
