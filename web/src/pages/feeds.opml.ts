import type { APIRoute } from "astro";
import { createOpmlResponse } from "../lib/opml.ts";

export const GET: APIRoute = () => createOpmlResponse();
