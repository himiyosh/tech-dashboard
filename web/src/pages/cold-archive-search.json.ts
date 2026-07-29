import { COLD_ARCHIVE_SEARCH_SERIALIZED } from "../lib/cold-archive-search.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(COLD_ARCHIVE_SEARCH_SERIALIZED, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
