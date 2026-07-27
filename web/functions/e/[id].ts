import { handleLocalizedMetadataRequest } from "../_shared/localized-metadata.ts";

interface PagesContext {
  request: Request;
  next(): Promise<Response>;
}

export function onRequestGet(context: PagesContext): Promise<Response> {
  return handleLocalizedMetadataRequest(context);
}
