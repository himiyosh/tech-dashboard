import {
  sourceAuthority,
  sourceLabel,
  type SourceAuthority,
} from "./source-meta.ts";
import {
  summaryForLangWithFallback,
  type SummaryDisplayEntry,
} from "./summary-display.ts";

export interface FeedDecisionDigestEntry extends SummaryDisplayEntry {
  sourceType?: string | null;
  url?: string | null;
  importance: 1 | 2 | 3;
}

export interface FeedDecisionDigest {
  source: string;
  authority: SourceAuthority;
  importance: FeedDecisionDigestEntry["importance"];
  summary: string;
  metadata: string;
  text: string;
}

export function buildFeedDecisionDigest(
  entry: FeedDecisionDigestEntry,
): FeedDecisionDigest {
  const source = sourceLabel(entry.source, entry.url ?? undefined);
  const authority = sourceAuthority(entry.source, entry.sourceType ?? undefined);
  const summary = summaryForLangWithFallback(entry, "ja").text;
  if (!summary) {
    throw new Error(`Feed decision digest requires a validated summary for ${source}`);
  }

  const metadata = `出典: ${source} | 種別: ${authority.ja} | 重要度: ${entry.importance}/3`;
  return {
    source,
    authority,
    importance: entry.importance,
    summary,
    metadata,
    text: `${metadata}\n\n${summary}`,
  };
}
