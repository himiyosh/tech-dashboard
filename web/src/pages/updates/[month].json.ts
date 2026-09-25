import type { APIRoute } from "astro";
import { MAJOR_UPDATE_STATE } from "../../lib/major-update-data.ts";
import { publicMajorUpdateMonth } from "../../lib/major-update-public.ts";

export function getStaticPaths() {
  return MAJOR_UPDATE_STATE.index.months.map(({ month }) => ({
    params: { month },
  }));
}

export const GET: APIRoute = ({ params }) => {
  const month = params.month;
  if (!month || !MAJOR_UPDATE_STATE.index.months.some((item) => item.month === month)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(
    JSON.stringify(publicMajorUpdateMonth(MAJOR_UPDATE_STATE, month)),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
};
