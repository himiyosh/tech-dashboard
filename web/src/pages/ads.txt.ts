import type { APIRoute } from "astro";
import { buildAdsTxt } from "../lib/ads-txt.ts";
import { ADSENSE_CLIENT_ID } from "../lib/site.ts";

const ADS_TXT_DOCUMENT = buildAdsTxt(ADSENSE_CLIENT_ID);

export const GET: APIRoute = () =>
  new Response(ADS_TXT_DOCUMENT, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
