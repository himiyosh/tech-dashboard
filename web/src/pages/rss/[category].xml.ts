import type { APIRoute } from "astro";
import {
  CATEGORY_META,
  GENERATED_AT,
  PUBLISHABLE_ENTRIES,
} from "../../lib/data.ts";
import {
  createRssResponse,
} from "../../lib/rss.ts";
import { filterCategoryListingEntries } from "../../lib/research-lane.ts";
import { SITE_URL } from "../../lib/site.ts";

export function getStaticPaths() {
  return CATEGORY_META.map((category) => ({
    params: { category: category.slug },
  }));
}

export const GET: APIRoute = ({ params }) => {
  const category = CATEGORY_META.find((item) => item.slug === params.category);
  if (!category) {
    return new Response("Not found", { status: 404 });
  }

  const entries = filterCategoryListingEntries(
    PUBLISHABLE_ENTRIES,
    category.slug,
  );
  return createRssResponse(entries, {
    title: `TECH Dashboard | ${category.name}`,
    link: `${SITE_URL}/c/${category.slug}/`,
    description: `${category.name} カテゴリの AI 要約済み最新記事`,
    lastBuildDate: GENERATED_AT,
  });
};
