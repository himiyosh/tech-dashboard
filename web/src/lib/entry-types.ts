import type { Category } from "./category-meta.ts";

export interface NormalizedEntry {
  id: string;
  /**
   * Build-time publication-gate decision (publication-gate.ts). True while the
   * entry is queued: it stays in every listing and links out to the source
   * (entry-destination.ts), and receives no /e/[id]/ route.
   */
  publicationHold: boolean;
  source: string;
  sourceType: "blog" | "release" | "changelog" | "paper" | "community";
  url: string;
  title: string;
  titleJa: string;
  titleEn: string;
  summaryJa: string;
  summaryEn: string;
  contentSnippet?: string;
  bodyJa?: string;
  bodyEn?: string;
  lang: "ja" | "en";
  publishedAt: string;
  collectedAt: string;
  tags: string[];
  category: Category;
  importance: 1 | 2 | 3;
  clusterId?: string;
  archiveTier?: "hot" | "warm" | "cold" | "dropped";
  halfLife?: "news" | "tutorial" | "architecture" | "fundamental";
  evergreen?: boolean;
  knowledgeEligible?: boolean;
  image?: {
    src: string;
    origSrc: string;
    alt: string;
    width: number;
    height: number;
    source: "media" | "og" | "fallback";
  };
}

/** The entry shape data/index.json stores, without a build-time gate annotation. */
export type RawIndexEntry = Omit<NormalizedEntry, "publicationHold">;
