/**
 * VS Code Updates HTML scraper (Tier 1 source #9).
 *
 * The /updates page lists all past releases with links of form /updates/v1_NNN.
 * VS Code ships monthly, so this produces one entry per month.
 *
 * Fragile by nature — if the DOM shifts we fall back to an empty list rather
 * than crash the whole run (see site-spec §1.4 note on Feed 未公開ソース).
 */
import type { RawEntry, SourceDefinition } from "../types.ts";

const BASE = "https://code.visualstudio.com";

export async function collectVscodeUpdates(source: SourceDefinition): Promise<RawEntry[]> {
  const res = await fetch(source.feedUrl, {
    headers: {
      "User-Agent": "tech-dashboard-bot/0.1 (+https://github.com/himiyosh/tech-dashboard)",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source.feedUrl}`);
  const html = await res.text();

  // Collect unique /updates/v1_NNN links with the version number as rank key.
  const seen = new Map<number, { version: string; path: string }>();
  const linkRegex = /href="(\/updates\/v1_(\d+))"/g;
  for (const m of html.matchAll(linkRegex)) {
    const path = m[1];
    if (!path) continue;
    const num = Number(m[2]);
    if (!Number.isFinite(num) || seen.has(num)) continue;
    seen.set(num, { version: `1.${num}`, path });
  }

  // Newest 12 versions (≈1 year of monthly releases).
  const items = [...seen.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 12)
    .map(([, v]) => v);

  // VS Code publishes roughly one release per month; publication date isn't
  // on the index page. We approximate from the current month going backwards.
  // This is only used for sort order; the cards will still show the version.
  const now = new Date();
  return items.map((item, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    return {
      externalId: `vscode-${item.version}`,
      url: `${BASE}${item.path}`,
      title: `Visual Studio Code ${item.version} Release Notes`,
      contentSnippet: `Monthly release notes for VS Code ${item.version}.`,
      publishedAt: d.toISOString(),
    };
  });
}
