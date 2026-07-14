import {
  handlePutReaction,
  type ReactionEnv,
} from "../../_shared/reactions.ts";

interface PagesContext {
  request: Request;
  env: ReactionEnv;
  params: { id?: string | string[] };
}

export function onRequestPut(context: PagesContext): Promise<Response> {
  const id = typeof context.params.id === "string" ? context.params.id : "";
  return handlePutReaction(context.request, context.env, id);
}
