import {
  handleGetReactions,
  type ReactionEnv,
} from "../_shared/reactions.ts";

interface PagesContext {
  request: Request;
  env: ReactionEnv;
}

export function onRequestGet(context: PagesContext): Promise<Response> {
  return handleGetReactions(context.request, context.env);
}
