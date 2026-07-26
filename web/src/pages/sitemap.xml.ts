import type { APIRoute } from "astro";
import { SITEMAP_DOCUMENT } from "../lib/sitemap.ts";

export const GET: APIRoute = () =>
  new Response(SITEMAP_DOCUMENT.xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
    },
  });
