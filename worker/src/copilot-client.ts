/**
 * Endpoint routing and request/response shaping for the Copilot API, shared by
 * the summary and body Queue consumers.
 *
 * Why two endpoints: GPT-5.x models on Copilot are /responses-only. LL-010
 * recorded `unsupported_api_for_model` for gpt-5.5 on /chat/completions, and a
 * live probe on 2026-08-29 confirmed the same for every gpt-5.6 variant
 * (sol-fast / sol / terra / luna) while all four succeeded on /responses.
 * Claude models remain on /chat/completions, the shape both consumers have run
 * in production since LL-037.
 *
 * /responses contract differences measured in the same probe:
 *   - `temperature` is REJECTED for gpt-5.6 models ("Unsupported parameter"),
 *     so the responses shape never carries it.
 *   - `max_output_tokens` INCLUDES reasoning tokens (486-1034 observed for
 *     summary calls), unlike claude on chat where reasoning_effort is a
 *     separate knob. Callers keep their existing token budgets; the reasoning
 *     share stayed well inside them in every measured call.
 *   - Output text arrives as `output[] -> {type:"message"} -> content[] ->
 *     {type:"output_text"}` items; `reasoning` items are skipped.
 *
 * This module is pure request/response shaping (no fetch, no token handling):
 * each consumer keeps its own fetch loop because their retry semantics differ
 * (401 token re-exchange mid-batch, LL-105) and must not drift behind a shared
 * abstraction untested against them.
 */

export const COPILOT_CHAT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
export const COPILOT_RESPONSES_ENDPOINT = "https://api.githubcopilot.com/responses";

export type CopilotEndpoint = "chat" | "responses";

/**
 * Prefix list rather than a regex on "gpt-": gpt-4o / gpt-4.1 and the
 * embeddings models stay on chat-compatible endpoints, and an unknown future
 * model id defaults to the chat endpoint where a wrong guess fails loudly
 * (unsupported_api_for_model) instead of silently changing request semantics.
 */
const RESPONSES_ONLY_MODEL_PREFIXES = ["gpt-5.5", "gpt-5.6"] as const;

export function copilotEndpointForModel(model: string): CopilotEndpoint {
  return RESPONSES_ONLY_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? "responses"
    : "chat";
}

export function copilotEndpointUrl(endpoint: CopilotEndpoint): string {
  return endpoint === "responses" ? COPILOT_RESPONSES_ENDPOINT : COPILOT_CHAT_ENDPOINT;
}

export interface CopilotPromptRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  /** Applied on the chat endpoint only; /responses models reject it. */
  temperature: number;
  /**
   * Applied on the chat endpoint only (claude). "" or "none" omits the field.
   * The /responses default reasoning behavior is used as-is for GPT models:
   * measured reasoning shares fit the existing budgets, and none of the
   * empty-output failures seen with claude reasoning=max occurred.
   */
  reasoningEffort?: string;
}

/** Request body for the endpoint the model requires. Pure and test-covered. */
export function buildCopilotRequestBody(
  request: CopilotPromptRequest,
): Record<string, unknown> {
  const endpoint = copilotEndpointForModel(request.model);
  if (endpoint === "responses") {
    return {
      model: request.model,
      instructions: request.systemPrompt,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: request.userPrompt }],
        },
      ],
      max_output_tokens: request.maxTokens,
      stream: false,
    };
  }
  const body: Record<string, unknown> = {
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
  };
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    body.reasoning_effort = request.reasoningEffort;
  }
  return body;
}

/**
 * The model's visible text from either endpoint's JSON. Reasoning items are
 * skipped; a reasoning-only response therefore extracts to "" and trips the
 * callers' existing empty-output guards.
 */
export function extractCopilotText(
  endpoint: CopilotEndpoint,
  payload: unknown,
): string {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (endpoint === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    const message = (choices[0] as Record<string, unknown> | undefined)?.message as
      | Record<string, unknown>
      | undefined;
    return typeof message?.content === "string" ? message.content : "";
  }
  const output = record.output;
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output) {
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== "message" || !Array.isArray(itemRecord.content)) continue;
    for (const part of itemRecord.content) {
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === "output_text" && typeof partRecord.text === "string") {
        texts.push(partRecord.text);
      }
    }
  }
  return texts.join("");
}

/**
 * Ordered, de-duplicated model chain from a primary plus a comma-separated
 * fallback list ("gpt-5.6-sol, gpt-5.6-terra"). Blanks are dropped; the
 * primary always leads. Never returns an empty array for a non-empty primary.
 */
export function parseModelChain(
  primary: string,
  fallbacks: string | undefined,
): string[] {
  const chain: string[] = [];
  for (const candidate of [primary, ...(fallbacks ?? "").split(",")]) {
    const model = candidate.trim();
    if (model && !chain.includes(model)) chain.push(model);
  }
  return chain;
}
