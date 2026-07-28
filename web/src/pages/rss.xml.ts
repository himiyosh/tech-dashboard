import type { APIRoute } from "astro";
import {
  PUBLISHABLE_ENTRIES,
  GENERATED_AT,
} from "../lib/data.ts";
import { createRssResponse } from "../lib/rss.ts";
import { SITE_URL } from "../lib/site.ts";

export const GET: APIRoute = () =>
  createRssResponse(PUBLISHABLE_ENTRIES, {
    title: "TECH Dashboard — AI Daily",
    link: SITE_URL,
    description: "AI コーディング/エコシステムの公式情報を毎日自動収集・要約",
    lastBuildDate: GENERATED_AT,
  });
