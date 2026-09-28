import type { APIRoute } from "astro";
import { MAJOR_UPDATE_STATE } from "../../lib/major-update-data.ts";
import { publicMajorUpdateIndex } from "../../lib/major-update-public.ts";

export const GET: APIRoute = () =>
  new Response(JSON.stringify(publicMajorUpdateIndex(MAJOR_UPDATE_STATE)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
