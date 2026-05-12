import { describe, expect, it } from "vitest";
import { detectLang, normalize } from "../harness/pipeline/normalize.ts";
import type { RawEntry, SourceDefinition } from "../harness/types.ts";

const releaseSource: SourceDefinition = {
  id: "cline-releases",
  displayName: "Cline Releases",
  category: "cline",
  sourceType: "release",
  defaultLang: "en",
  autoTags: ["cline"],
  feedUrl: "https://example.com/releases.atom",
  collect: async () => [],
  tier: 1,
};

function rawEntry(title: string): RawEntry {
  return {
    externalId: title,
    url: `https://example.com/releases/${encodeURIComponent(title)}`,
    title,
    contentSnippet: "Release note",
    publishedAt: "2026-05-10T00:00:00.000Z",
  };
}

describe("detectLang", () => {
  it("記号や区切り文字が多い短文でも日本語シグナルを拾う", () => {
    expect(detectLang("Claude 4 / GPT-5 / MCP / VS Code / 新機能", "en")).toBe("ja");
  });
});

describe("normalize release title decoration", () => {
  it("空の contentSnippet は title に fallback して summary を空にしない", () => {
    const raw = { ...rawEntry("Claude Code Auto Mode"), contentSnippet: "" };
    const entry = normalize(raw, releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.summaryEn).toBe("Claude Code Auto Mode");
  });

  it("version-only release title に source 名を前置する", () => {
    const entry = normalize(rawEntry("v3.8.0"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases v3.8.0");
  });

  it("date-only release title に source 名を前置する", () => {
    const entry = normalize(rawEntry("Release 2026-05-10"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases Release 2026-05-10");
  });

  it("date separator variants も source 名を前置する", () => {
    const entry = normalize(rawEntry("2026.05.10"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases 2026.05.10");
  });

  it("source 名が既に含まれる title は二重に前置しない", () => {
    const entry = normalize(rawEntry("Cline Releases v3.8.0"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases v3.8.0");
  });
});