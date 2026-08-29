/**
 * tests/worker-copilot-client.test.ts
 *
 * Pins the Copilot endpoint routing and request/response shaping both Queue
 * consumers share (worker/src/copilot-client.ts). The live contract these
 * tests encode was measured against the real API on 2026-08-29:
 * gpt-5.6 models are /responses-only, reject `temperature`, and return text
 * as output[] message items; claude stays on /chat/completions.
 */
import { describe, expect, it } from "vitest";
import {
  COPILOT_CHAT_ENDPOINT,
  COPILOT_RESPONSES_ENDPOINT,
  buildCopilotRequestBody,
  copilotEndpointForModel,
  copilotEndpointUrl,
  extractCopilotText,
  parseModelChain,
} from "../worker/src/copilot-client.ts";

describe("copilotEndpointForModel", () => {
  it("routes every gpt-5.5/5.6 variant to /responses and everything else to chat", () => {
    for (const model of [
      "gpt-5.6-sol-fast",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      expect(copilotEndpointForModel(model), model).toBe("responses");
    }
    // Chat-capable ids must NOT be swept up by a loose "gpt-" match, and an
    // unknown future id defaults to chat where a wrong guess fails loudly.
    for (const model of [
      "claude-sonnet-4.6",
      "claude-opus-4.8",
      "gpt-4o",
      "gpt-5-mini",
      "gpt-5.4",
      "some-future-model",
    ]) {
      expect(copilotEndpointForModel(model), model).toBe("chat");
    }
  });

  it("maps endpoints to their URLs", () => {
    expect(copilotEndpointUrl("chat")).toBe(COPILOT_CHAT_ENDPOINT);
    expect(copilotEndpointUrl("responses")).toBe(COPILOT_RESPONSES_ENDPOINT);
  });
});

describe("buildCopilotRequestBody", () => {
  const base = {
    systemPrompt: "system text",
    userPrompt: "user text",
    maxTokens: 1600,
    temperature: 0.2,
  };

  it("keeps the historical chat shape for claude, including reasoning_effort", () => {
    const body = buildCopilotRequestBody({
      ...base,
      model: "claude-opus-4.8",
      reasoningEffort: "high",
    });
    expect(body).toEqual({
      model: "claude-opus-4.8",
      temperature: 0.2,
      max_tokens: 1600,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "system text" },
        { role: "user", content: "user text" },
      ],
    });
  });

  it('omits reasoning_effort on chat for "" and "none"', () => {
    for (const reasoningEffort of ["", "none", undefined]) {
      const body = buildCopilotRequestBody({
        ...base,
        model: "claude-sonnet-4.6",
        reasoningEffort,
      });
      expect(Object.keys(body)).not.toContain("reasoning_effort");
    }
  });

  it("shapes /responses requests without temperature or reasoning fields", () => {
    const body = buildCopilotRequestBody({
      ...base,
      model: "gpt-5.6-sol-fast",
      // Even when a caller passes the claude knob it must not leak into the
      // responses shape: gpt-5.6 rejects unknown chat parameters.
      reasoningEffort: "max",
    });
    expect(body).toEqual({
      model: "gpt-5.6-sol-fast",
      instructions: "system text",
      input: [
        { role: "user", content: [{ type: "input_text", text: "user text" }] },
      ],
      max_output_tokens: 1600,
      stream: false,
    });
    expect(Object.keys(body)).not.toContain("temperature");
    expect(Object.keys(body)).not.toContain("reasoning_effort");
  });
});

describe("extractCopilotText", () => {
  it("reads the chat shape", () => {
    expect(
      extractCopilotText("chat", {
        choices: [{ message: { content: "hello" } }],
      }),
    ).toBe("hello");
  });

  it("returns empty for the chat reasoning-exhaustion shape (empty choices)", () => {
    expect(extractCopilotText("chat", { choices: [] })).toBe("");
    expect(extractCopilotText("chat", {})).toBe("");
  });

  it("concatenates output_text items and skips reasoning items on /responses", () => {
    expect(
      extractCopilotText("responses", {
        status: "completed",
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            content: [
              { type: "output_text", text: "part one " },
              { type: "output_text", text: "part two" },
            ],
          },
        ],
      }),
    ).toBe("part one part two");
  });

  it("extracts empty text from a reasoning-only /responses payload", () => {
    expect(
      extractCopilotText("responses", {
        output: [{ type: "reasoning", summary: [] }],
      }),
    ).toBe("");
    expect(extractCopilotText("responses", {})).toBe("");
  });
});

describe("parseModelChain", () => {
  it("builds the ordered chain, trimming and de-duplicating", () => {
    expect(
      parseModelChain(
        "gpt-5.6-sol-fast",
        " gpt-5.6-sol, gpt-5.6-terra ,gpt-5.6-luna,claude-sonnet-4.6",
      ),
    ).toEqual([
      "gpt-5.6-sol-fast",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-sonnet-4.6",
    ]);
  });

  it("drops blanks and duplicates of the primary", () => {
    expect(parseModelChain("claude-sonnet-4.6", " ,claude-sonnet-4.6,,")).toEqual([
      "claude-sonnet-4.6",
    ]);
  });

  it("returns just the primary when no fallbacks are configured", () => {
    expect(parseModelChain("claude-sonnet-4.6", undefined)).toEqual([
      "claude-sonnet-4.6",
    ]);
  });
});

describe("production wrangler configuration", () => {
  it("pins the site-owner model priority in both consumers", async () => {
    const { readFileSync } = await import("node:fs");
    for (const [path, primaryKey, fallbackKey] of [
      ["worker-summarizer/wrangler.toml", "SUMMARIZE_MODEL", "SUMMARIZE_MODEL_FALLBACKS"],
      ["worker-body/wrangler.toml", "BODY_MODEL", "BODY_MODEL_FALLBACKS"],
    ] as const) {
      const config = readFileSync(path, "utf8");
      expect(config, path).toMatch(
        new RegExp(`^${primaryKey} = "gpt-5\\.6-sol"$`, "m"),
      );
      const fallbacks = config.match(
        new RegExp(`^${fallbackKey} = "([^"]+)"$`, "m"),
      )?.[1];
      expect(fallbacks, path).toBeTruthy();
      const chain = parseModelChain("gpt-5.6-sol", fallbacks);
      expect(chain.slice(0, 3), path).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
      // Sol Fast is excluded on purpose: its picker name marks it
      // "(Internal only)" and the site owner opted out of depending on it.
      expect(chain, path).not.toContain("gpt-5.6-sol-fast");
      // The final safety net stays a claude model on the proven chat path.
      expect(chain[chain.length - 1], path).toMatch(/^claude-/);
    }
  });
});
