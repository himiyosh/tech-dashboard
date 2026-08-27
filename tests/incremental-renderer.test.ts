import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";
import {
  applyDetailAssetShell,
  assertDetailHtmlParity,
  buildIncrementalSearchDeltaRecord,
  captureDetailAssetShell,
  validateDetailAssetShell,
} from "../web/scripts/incremental-render-core.mjs";
import { runIncrementalRendererCli } from "../web/scripts/render-incremental-shadow.mjs";
import { SITE_PUBLICATION_GATE } from "../web/src/lib/publication-gate-data.ts";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "../web/src/lib/detail-addressability.ts";

const fingerprint = DEPLOYED_PUBLISHER_FINGERPRINT;
const metadata = [
  '<title data-meta-key="title" data-meta-content-en="English title">日本語タイトル</title>',
  '<meta data-meta-key="description" data-meta-content-en="English description" content="日本語の説明">',
  '<meta data-meta-key="og:title" data-meta-content-en="English title" content="日本語タイトル">',
  '<meta data-meta-key="og:description" data-meta-content-en="English description" content="日本語の説明">',
  '<meta data-meta-key="og:url" data-meta-content-en="https://example.com/e/entry/?lang=en" content="https://example.com/e/entry/">',
  '<meta data-meta-key="og:image:alt" data-meta-content-en="English image" content="日本語画像">',
  '<meta data-meta-key="og:locale" data-meta-content-en="en_US" content="ja_JP">',
  '<meta data-meta-key="og:locale:alternate" data-meta-content-en="ja_JP" content="en_US">',
  '<meta data-meta-key="twitter:title" data-meta-content-en="English title" content="日本語タイトル">',
  '<meta data-meta-key="twitter:description" data-meta-content-en="English description" content="日本語の説明">',
  '<meta data-meta-key="twitter:image:alt" data-meta-content-en="English image" content="日本語画像">',
].join("");

function productionHtml() {
  return `<!doctype html><html lang="ja"><head>${metadata}<link rel="canonical" href="https://example.com/e/entry/"><link rel="stylesheet" href="/_astro/page.css"><style>.inline{color:red}</style></head><body><main><h1>Article</h1><p>Summary</p></main><script type="module" src="/_astro/sidebar.js"></script><script type="module" src="/_astro/article.js"></script><script type="module" src="/_astro/portal.js"></script></body></html>`;
}

function incrementalHtml() {
  return `<!doctype html><html lang="ja"><head>${metadata}<link rel="canonical" href="https://example.com/e/entry/"></head><body><main><h1>Article</h1><p>Summary</p></main><script type="module" src="/repo/src/sidebar.astro?astro&type=script"></script><script type="module" src="/repo/src/article.astro?astro&type=script"></script><script type="module" src="/repo/src/portal.astro?astro&type=script"></script></body></html>`;
}

function shellFixture() {
  const root = mkdtempSync(join(tmpdir(), "incremental-shell-"));
  mkdirSync(join(root, "_astro"), { recursive: true });
  writeFileSync(join(root, "_astro/page.css"), ".page{}\n", "utf8");
  writeFileSync(join(root, "_astro/sidebar.js"), "export const sidebar = 1;\n", "utf8");
  writeFileSync(join(root, "_astro/article.js"), "export const article = 1;\n", "utf8");
  writeFileSync(join(root, "_astro/portal.js"), "export const portal = 1;\n", "utf8");
  return {
    root,
    shell: captureDetailAssetShell({
      html: productionHtml(),
      distDirectory: root,
      capturedFromPath: "/e/entry/",
      publisherFingerprint: fingerprint,
    }),
  };
}

describe("incremental detail renderer", () => {
  it("captures production assets and replaces development-only references", () => {
    const { shell } = shellFixture();
    const validated = validateDetailAssetShell(shell, fingerprint);
    const rendered = applyDetailAssetShell(incrementalHtml(), validated);

    expect(rendered).toContain('href="/_astro/page.css"');
    expect(rendered).toContain('src="/_astro/article.js"');
    expect(rendered).toContain("<style>.inline{color:red}</style>");
    expect(rendered).not.toContain("/repo/src/");
    expect(rendered).not.toContain("astro&amp;type=script");
    expect(shell.assets).toHaveLength(4);
    expect(shell.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256))).toBe(true);
  });

  it("detects stale or tampered shell manifests", () => {
    const { shell } = shellFixture();
    expect(() =>
      validateDetailAssetShell(
        { ...shell, headAssets: [...shell.headAssets, "<style>.tampered{}</style>"] },
        fingerprint,
      ),
    ).toThrow(/digest mismatch/);
    expect(() => validateDetailAssetShell(shell, `sha256:${"b".repeat(64)}`)).toThrow(
      /invalid/,
    );
  });

  it("compares semantic HTML instead of serialization whitespace", () => {
    const { shell } = shellFixture();
    const rendered = applyDetailAssetShell(incrementalHtml(), shell);
    expect(() => assertDetailHtmlParity(productionHtml(), rendered)).not.toThrow();
    expect(() =>
      assertDetailHtmlParity(
        productionHtml(),
        rendered.replace("<p>Summary</p>", "<p>Different</p>"),
      ),
    ).toThrow(/semantic snapshot/);
    expect(() =>
      assertDetailHtmlParity(
        productionHtml(),
        rendered.replace(
          "https://example.com/e/entry/",
          "https://example.com/e/other/",
        ),
      ),
    ).toThrow(/semantic snapshot/);
    expect(() =>
      assertDetailHtmlParity(
        productionHtml(),
        rendered.replace(".inline{color:red}", ".inline{color:blue}"),
      ),
    ).toThrow(/semantic snapshot/);
  });

  it("builds a bounded search delta from the same changed detail", () => {
    const record = buildIncrementalSearchDeltaRecord(
      {
        id: "entry",
        title: "Title",
        titleJa: "タイトル",
        titleEn: "Title",
        summaryJa: "要約",
        summaryEn: "Summary",
        source: "official",
        category: "copilot",
        tags: ["agent"],
        publishedAt: "2026-08-13T00:00:00.000Z",
      },
      { bodyJa: "本文", bodyEn: "Body" },
    );

    expect(record).toMatchObject({
      id: "entry",
      path: "/e/entry/",
      bodyJa: "本文",
      bodyEn: "Body",
    });
  });

  it("records byte-identical production assets", () => {
    const { root, shell } = shellFixture();
    const css = readFileSync(join(root, "_astro/page.css"));
    const cssRecord = shell.assets.find((asset) => asset.path.endsWith(".css"));
    expect(cssRecord?.bytes).toBe(css.byteLength);
  });

  it("renders exactly one detail and one search delta for a body-only impact", async () => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: DetailAddressableEntry[];
    };
    // Detail routes exist only for addressable (summary-ready hot/warm)
    // entries that the publication gate has released, so neither a
    // summary-pending nor a queued index head may be the fixture: either one
    // trips the fail-closed throw in render-incremental-shadow.mjs:257.
    const id = index.entries.find((entry) =>
      isAddressableDetailEntry({
        ...entry,
        publicationHold: !SITE_PUBLICATION_GATE.isReleased(entry.id),
      }),
    )?.id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const { shell } = shellFixture();
    const root = mkdtempSync(join(tmpdir(), "incremental-render-"));
    const shellPath = join(root, "shell.json");
    const impactPath = join(root, "impact.json");
    const output = join(root, "bundle");
    writeFileSync(shellPath, `${JSON.stringify(shell)}\n`, "utf8");
    writeFileSync(
      impactPath,
      `${JSON.stringify({
        version: 2,
        baseRef: "a".repeat(40),
        incremental: {
          detailUpsertIds: [id],
          detailTombstoneIds: [],
          searchDeltaIds: [id],
          shadowSafe: true,
          blockers: [],
        },
      })}\n`,
      "utf8",
    );

    await expect(
      runIncrementalRendererCli([
        "--render",
        "--impact",
        impactPath,
        "--shell",
        shellPath,
        "--output",
        output,
      ]),
    ).resolves.toBe(0);

    const bundle = JSON.parse(readFileSync(join(output, "bundle.json"), "utf8")) as {
      routes: unknown[];
      searchDelta: { file: string } | null;
      fullDetailSnapshot: boolean;
    };
    expect(bundle.routes).toHaveLength(1);
    expect(bundle.searchDelta).not.toBeNull();
    expect(bundle.fullDetailSnapshot).toBe(false);
  }, 30_000);
});
