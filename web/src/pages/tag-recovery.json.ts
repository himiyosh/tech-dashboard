import { SINGLETON_TAG_ENTRY_IDS } from "../lib/data.ts";

export const prerender = true;

export function GET(): Response {
  return new Response(JSON.stringify(SINGLETON_TAG_ENTRY_IDS), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
