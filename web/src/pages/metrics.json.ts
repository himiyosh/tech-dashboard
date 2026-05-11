import type { APIRoute } from "astro";
import { buildDashboardMetrics } from "../lib/metrics.ts";

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(buildDashboardMetrics(), null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};