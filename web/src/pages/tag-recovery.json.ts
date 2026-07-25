import { SINGLETON_INDEXED_TAG_ENTRY_IDS } from "../lib/tag-recovery.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(JSON.stringify(SINGLETON_INDEXED_TAG_ENTRY_IDS), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
