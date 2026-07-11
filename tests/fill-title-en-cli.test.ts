import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  deriveTitleEnFromEntry,
  extractLegacyTitleFromSummary,
  fillMissingTitleEn,
  parseCliArgs,
} from "../scripts/fill-title-en.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "data", "index.json");
const SCRIPT_PATH = join(ROOT, "scripts", "fill-title-en.mjs");

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

describe("fill-title-en pure helpers", () => {
  it("derives titleEn from a real English summary", () => {
    expect(
      deriveTitleEnFromEntry({
        titleEn: "",
        summaryEn: "Amazon Bedrock introduces new advanced prompt optimization and migration tool. The update streamlines model onboarding.",
      }),
    ).toBe("Amazon Bedrock introduces new advanced prompt optimization and migration tool");
  });

  it("keeps version numbers and file names inside the derived title", () => {
    expect(
      deriveTitleEnFromEntry({
        titleEn: "",
        summaryEn: "Amazon Bedrock v2.1.205 improves launch.json handling for GPT-5.6 workflows. The update also simplifies setup.",
      }),
    ).toBe("Amazon Bedrock v2.1.205 improves launch.json handling for GPT-5.6 workflows");
  });

  it("does not truncate before .NET token boundaries", () => {
    const versionTitle = deriveTitleEnFromEntry({
      titleEn: "",
      summaryEn: "A hands-on post trying the .NET version of the new SDK in a real sample app. It also notes setup tradeoffs.",
    });
    const mauiTitle = deriveTitleEnFromEntry({
      titleEn: "",
      summaryEn: "A practical walkthrough integrating push notifications from a .NET MAUI app into the latest toolkit. It covers deployment notes too.",
    });

    expect(versionTitle).toContain(".NET version");
    expect(versionTitle.endsWith(" ")).toBe(false);
    expect(mauiTitle).toContain(".NET MAUI");
    expect(mauiTitle.endsWith(" ")).toBe(false);
  });

  it("leaves titleEn empty when summaryEn is deterministic or pending", () => {
    expect(
      deriveTitleEnFromEntry({
        titleEn: "",
        summaryEn: "AI summary not yet available.",
      }),
    ).toBe("");
  });

  it("counts fallback/pending entries without stuffing source-language titles into titleEn", () => {
    const { nextData, counts } = fillMissingTitleEn({
      entries: [
        {
          title: "日本語タイトル",
          titleEn: "",
          summaryEn: "The article explains how the release improves model evaluation quality.",
        },
        {
          title: "別の日本語タイトル",
          titleEn: "",
          summaryEn: "AI summary not yet available.",
        },
      ],
    });

    expect(counts).toEqual({
      alreadySet: 0,
      missing: 2,
      fromSummaryEn: 1,
      correctedDerivedTitles: 0,
      pendingOrFallback: 1,
      totalUpdated: 1,
    });
    expect(nextData.entries[0].titleEn).toBe("The article explains how the release improves model evaluation quality");
    expect(nextData.entries[1].titleEn ?? "").toBe("");
  });

  it("repairs only exact legacy-derived existing titleEn values", () => {
    const summaryEn = "Amazon Bedrock v2.1.205 improves launch.json handling for GPT-5.6 workflows. The update also simplifies setup.";
    expect(extractLegacyTitleFromSummary(summaryEn)).toBe("Amazon Bedrock v2");

    const { nextData, counts } = fillMissingTitleEn({
      entries: [
        {
          titleEn: "Amazon Bedrock v2",
          summaryEn,
        },
        {
          titleEn: "Custom editorial title",
          summaryEn,
        },
      ],
    });

    expect(counts).toEqual({
      alreadySet: 1,
      missing: 0,
      fromSummaryEn: 0,
      correctedDerivedTitles: 1,
      pendingOrFallback: 0,
      totalUpdated: 1,
    });
    expect(nextData.entries[0].titleEn).toBe("Amazon Bedrock v2.1.205 improves launch.json handling for GPT-5.6 workflows");
    expect(nextData.entries[1].titleEn).toBe("Custom editorial title");
  });

  it("preserves a non-empty titleEn that equals the original source title", () => {
    const summaryEn = "Amazon Bedrock v2.1.205 improves launch.json handling for GPT-5.6 workflows. The update also simplifies setup.";
    const { nextData, counts } = fillMissingTitleEn({
      entries: [
        {
          title: "Amazon Bedrock v2",
          titleEn: "Amazon Bedrock v2",
          summaryEn,
        },
      ],
    });

    expect(nextData.entries[0].titleEn).toBe("Amazon Bedrock v2");
    expect(counts.correctedDerivedTitles).toBe(0);
    expect(counts.alreadySet).toBe(1);
    expect(counts.totalUpdated).toBe(0);
  });

  it("is idempotent for .NET-derived fills and legacy-derived corrections", () => {
    const mauiSummary = "A practical walkthrough integrating push notifications from a .NET MAUI app into the latest toolkit. It covers deployment notes too.";
    const source = {
      entries: [
        {
          titleEn: "",
          summaryEn: "A hands-on post trying the .NET version of the new SDK in a real sample app. It also notes setup tradeoffs.",
        },
        {
          titleEn: extractLegacyTitleFromSummary(mauiSummary),
          summaryEn: mauiSummary,
        },
      ],
    };

    const firstPass = fillMissingTitleEn(source);
    const secondPass = fillMissingTitleEn(firstPass.nextData);

    expect(firstPass.counts.totalUpdated).toBe(2);
    expect(firstPass.nextData.entries[0].titleEn).toContain(".NET version");
    expect(firstPass.nextData.entries[1].titleEn).toContain(".NET MAUI");
    expect(secondPass.counts).toEqual({
      alreadySet: 2,
      missing: 0,
      fromSummaryEn: 0,
      correctedDerivedTitles: 0,
      pendingOrFallback: 0,
      totalUpdated: 0,
    });
  });
});

describe("fill-title-en CLI safety", () => {
  it("parses only explicit safe modes", () => {
    expect(parseCliArgs(["--dry-run"])).toEqual({ ok: true, mode: "dry-run" });
    expect(parseCliArgs(["--apply"])).toEqual({ ok: true, mode: "apply" });
    expect(parseCliArgs(["--help"])).toEqual({ ok: true, mode: "help" });
    expect(parseCliArgs([])).toMatchObject({ ok: false, exitCode: 1 });
    expect(parseCliArgs(["--dry-run", "--apply"])).toMatchObject({ ok: false, exitCode: 1 });
    expect(parseCliArgs(["--wat"])).toMatchObject({ ok: false, exitCode: 1 });
  });

  it("help, no args, unknown args, conflict, and dry-run preserve data/index.json", () => {
    const before = sha256(INDEX_PATH);
    const cases = [
      { args: ["--help"], status: 0 },
      { args: [], status: 1 },
      { args: ["--wat"], status: 1 },
      { args: ["--dry-run", "--apply"], status: 1 },
      { args: ["--dry-run"], status: 0 },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(testCase.status);
      expect(sha256(INDEX_PATH)).toBe(before);
    }
  });
});
