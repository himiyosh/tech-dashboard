import { describe, expect, it } from "vitest";
import {
  MODEL_SOURCES,
  missingModels,
  modelsFromToml,
  runVerifyCopilotModelsCli,
} from "../scripts/verify-copilot-models.mjs";

// Regression guard for the retired-model outage: claude-sonnet-4.6 vanished
// from the Copilot endpoint while it was still the summarizer's last fallback,
// so a job that exhausted the gpt-5.6 models had nowhere left to go and the
// worker's /health returned 503 about twice a day.

const SUMMARIZER_TOML = `
name = "tech-dashboard-summarizer"
[vars]
SUMMARIZE_MODEL = "gpt-5.6-sol"
SUMMARIZE_MODEL_FALLBACKS = "gpt-5.6-terra, gpt-5.6-luna ,claude-sonnet-5"
SUMMARIZE_TIMEOUT_MS = "60000"
`;

describe("modelsFromToml", () => {
  it("expands comma lists, trims, de-duplicates and keeps order", () => {
    expect(modelsFromToml(SUMMARIZER_TOML, ["SUMMARIZE_MODEL", "SUMMARIZE_MODEL_FALLBACKS"])).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-sonnet-5",
    ]);
  });

  it("ignores keys the file does not set and never matches a similar key", () => {
    expect(modelsFromToml(SUMMARIZER_TOML, ["BODY_MODEL"])).toEqual([]);
    expect(modelsFromToml('X_SUMMARIZE_MODEL = "ghost"\n', ["SUMMARIZE_MODEL"])).toEqual([]);
  });
});

describe("missingModels", () => {
  it("reports only configured ids the endpoint does not offer", () => {
    expect(missingModels(["a", "b"], ["a", "b", "c"])).toEqual([]);
    expect(missingModels(["a", "gone"], ["a"])).toEqual(["gone"]);
    expect(missingModels([], ["a"])).toEqual([]);
  });
});

describe("runVerifyCopilotModelsCli", () => {
  const readFile = (file: string) =>
    file.includes("summarizer")
      ? SUMMARIZER_TOML
      : '[vars]\nBODY_MODEL = "gpt-5.6-sol"\nBODY_MODEL_FALLBACKS = "claude-opus-4.8"\n';

  it("exits 1 and names the retired model", async () => {
    const lines: string[] = [];
    const code = await runVerifyCopilotModelsCli([], {
      log: (line: string) => lines.push(line),
      readFile,
      pat: "pat",
      fetchAvailableModels: async () => ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-4.8"],
    });
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith("MISSING") && line.includes("claude-sonnet-5"))).toBe(true);
    expect(lines.at(-1)).toContain("no longer exist");
  });

  it("exits 0 when every configured model is offered", async () => {
    const lines: string[] = [];
    const code = await runVerifyCopilotModelsCli([], {
      log: (line: string) => lines.push(line),
      readFile,
      pat: "pat",
      fetchAvailableModels: async () => [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "claude-sonnet-5",
        "claude-opus-4.8",
      ],
    });
    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(/^OK: all 5 configured model/);
  });

  it("skips without a token instead of failing the caller", async () => {
    const lines: string[] = [];
    const code = await runVerifyCopilotModelsCli([], {
      log: (line: string) => lines.push(line),
      readFile,
      pat: null,
      fetchAvailableModels: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^SKIPPED/);
  });

  it("reports the endpoint failure instead of guessing", async () => {
    const lines: string[] = [];
    const code = await runVerifyCopilotModelsCli([], {
      log: (line: string) => lines.push(line),
      readFile,
      pat: "pat",
      fetchAvailableModels: async () => {
        throw new Error("copilot models endpoint returned HTTP 500");
      },
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("HTTP 500");
  });

  it("covers both workers in MODEL_SOURCES", () => {
    expect(MODEL_SOURCES.map((source) => source.file)).toEqual([
      "worker-summarizer/wrangler.toml",
      "worker-body/wrangler.toml",
    ]);
  });
});
