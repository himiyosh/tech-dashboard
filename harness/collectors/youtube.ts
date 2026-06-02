import type { SourceDefinition } from "../types.ts";
import { collectRss } from "./rss.ts";

/**
 * YouTube channel RSS — YouTube still exposes per-channel RSS at
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UCxxx
 * This is a thin wrapper around collectRss for readability.
 */
export async function collectYoutube(source: SourceDefinition) {
  try {
    return await collectRss(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("HTTP 404") && source.feedUrl.includes("youtube.com/feeds/videos.xml")) {
      console.warn(`[youtube] feed returned 404, treating as empty: ${source.id}`);
      return [];
    }
    throw err;
  }
}

/** Builds a channel-id SourceDefinition stub for the registry. */
export function youtubeChannel(
  id: string,
  displayName: string,
  channelId: string,
  autoTags: string[] = [],
): Omit<SourceDefinition, "collect"> & { collect: typeof collectYoutube } {
  return {
    id,
    displayName,
    category: "research",
    sourceType: "blog",
    defaultLang: "en",
    autoTags: ["youtube", ...autoTags],
    feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    tier: 3,
    collect: collectYoutube,
  };
}
