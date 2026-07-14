import {
  handleEnsureReactionIdentity,
  type ReactionEnv,
} from "../../_shared/reactions.ts";

interface PagesContext {
  request: Request;
  env: ReactionEnv;
}

export function onRequestPost(context: PagesContext): Promise<Response> {
  return handleEnsureReactionIdentity(context.request, context.env);
}
