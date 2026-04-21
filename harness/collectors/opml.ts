import { XMLParser } from "fast-xml-parser";
import type { RawEntry } from "../types.ts";
import { collectRss } from "./rss.ts";

/**
 * OPML importer — reads an OPML file and fans out to collectRss for each <outline>.
 * Gives end-users a way to bring their own feed list without touching registry.ts.
 *
 * Expected OPML location: data/user-opml.xml (gitignored; user-local).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceDefinition } from "../types.ts";

export async function collectOpml(_: SourceDefinition): Promise<RawEntry[]> {
  const path = join(process.cwd(), "data", "user-opml.xml");
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    // No user OPML present → treat as empty feed; do not error.
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
  });
  const doc = parser.parse(xml) as {
    opml?: { body?: { outline?: unknown } };
  };

  const outlines = flattenOutlines(doc.opml?.body?.outline);
  const feedUrls = outlines
    .map((o) => (typeof o === "object" && o !== null ? (o as any)["@xmlUrl"] : null))
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"));

  // Collect each feed, skip failures silently. Aggregate and cap to 200.
  const all: RawEntry[] = [];
  await Promise.all(
    feedUrls.slice(0, 20).map(async (feedUrl) => {
      try {
        const raw = await collectRss({
          ...(_ as SourceDefinition),
          feedUrl,
        });
        all.push(...raw.slice(0, 10));
      } catch {
        /* swallow per-feed error */
      }
    }),
  );
  return all.slice(0, 200);
}

function flattenOutlines(node: unknown): unknown[] {
  if (!node) return [];
  const arr = Array.isArray(node) ? node : [node];
  const out: unknown[] = [];
  for (const item of arr) {
    out.push(item);
    if (typeof item === "object" && item !== null && "outline" in item) {
      out.push(...flattenOutlines((item as any).outline));
    }
  }
  return out;
}
