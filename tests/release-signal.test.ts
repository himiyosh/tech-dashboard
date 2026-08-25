import { describe, expect, it } from "vitest";
import { scoreImportance } from "../harness/pipeline/normalize.ts";
import type { RawEntry, SourceDefinition } from "../harness/types.ts";
import {
  classifyReleaseTitleSignal,
  isRoutineReleaseEntry,
} from "../web/src/lib/release-signal.ts";

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

const changelogSource: SourceDefinition = {
  ...releaseSource,
  id: "cursor-changelog",
  displayName: "Cursor Changelog",
  category: "cursor",
  sourceType: "changelog",
};

const blogSource: SourceDefinition = {
  ...releaseSource,
  id: "anthropic-news",
  displayName: "Anthropic News",
  category: "claude",
  sourceType: "blog",
};

function raw(title: string, contentSnippet = "Release note"): RawEntry {
  return {
    externalId: title,
    url: `https://example.com/releases/${encodeURIComponent(title)}`,
    title,
    contentSnippet,
    publishedAt: "2026-05-10T00:00:00.000Z",
  };
}

describe("classifyReleaseTitleSignal", () => {
  it("patch 版 (x.y.Z, Z>0) は patch", () => {
    expect(classifyReleaseTitleSignal("Cline CLI v3.0.58")).toBe("patch");
    expect(classifyReleaseTitleSignal("Zed Editor Releases v1.16.2")).toBe("patch");
    expect(classifyReleaseTitleSignal("Cline Desktop v0.0.17")).toBe("patch");
    expect(classifyReleaseTitleSignal("langchain-core==1.4.3")).toBe("patch");
  });

  it("minor 版 (x.Y.0, Y>0) は minor", () => {
    expect(classifyReleaseTitleSignal("Ollama v0.12.0")).toBe("minor");
    expect(classifyReleaseTitleSignal("Aider v0.86.0")).toBe("minor");
    expect(classifyReleaseTitleSignal("VS Code September 2026 (version 1.104)")).toBe("minor");
  });

  it("major 版 (x.0.0 / x.0) は major", () => {
    expect(classifyReleaseTitleSignal("LangChain v1.0.0")).toBe("major");
    expect(classifyReleaseTitleSignal("OpenHands 2.0")).toBe("major");
  });

  it("nightly / prerelease / RC / PR-ref は low", () => {
    expect(classifyReleaseTitleSignal("Zed Nightly (2026-06-22 17:56)")).toBe("low");
    expect(classifyReleaseTitleSignal("Cline v3.1.0-rc1")).toBe("low");
    expect(classifyReleaseTitleSignal("Continue 1.2.0-beta")).toBe("low");
    expect(classifyReleaseTitleSignal("ui: Fix flickering tab bar (#4231)")).toBe("low");
  });

  it("version token の無い見出しは none", () => {
    expect(classifyReleaseTitleSignal("Improvements to Cursor Automations")).toBe("none");
    expect(classifyReleaseTitleSignal("")).toBe("none");
  });
});

describe("scoreImportance (release/changelog)", () => {
  it("patch リリースは importance 1 に落とす (旧 'v3.' 部分一致による 3 を修正)", () => {
    expect(scoreImportance(raw("Cline CLI v3.0.58"), releaseSource)).toBe(1);
    expect(scoreImportance(raw("Zed Editor Releases v1.16.2"), releaseSource)).toBe(1);
    expect(scoreImportance(raw("Cline Desktop v0.0.17"), releaseSource)).toBe(1);
  });

  it("prerelease/nightly は importance 1 (旧: 2)", () => {
    expect(scoreImportance(raw("Cline v3.1.0-rc1"), releaseSource)).toBe(1);
    expect(scoreImportance(raw("Zed Nightly (2026-06-22 17:56)"), releaseSource)).toBe(1);
  });

  it("minor リリースは importance 2、major リリースは 3", () => {
    expect(scoreImportance(raw("Ollama v0.12.0"), releaseSource)).toBe(2);
    expect(scoreImportance(raw("LangChain v1.0.0"), releaseSource)).toBe(3);
  });

  it("version の無い changelog 見出しは keyword で判定する", () => {
    expect(
      scoreImportance(raw("Improvements to Cursor Automations"), changelogSource),
    ).toBe(2);
    expect(
      scoreImportance(
        raw("Announcing general availability of Cursor Agents"),
        changelogSource,
      ),
    ).toBe(3);
  });

  it("blog ソースの採点は据え置き (keyword 2 / default 1)", () => {
    expect(scoreImportance(raw("Announcing Claude for Excel"), blogSource)).toBe(2);
    expect(scoreImportance(raw("How we build agent tools"), blogSource)).toBe(1);
  });
});

describe("isRoutineReleaseEntry", () => {
  it("release/changelog の patch/low ビルドだけを routine とする", () => {
    expect(
      isRoutineReleaseEntry({
        sourceType: "release",
        title: "Cline CLI v3.0.58",
        titleEn: "Cline CLI v3.0.58",
        titleJa: "",
      }),
    ).toBe(true);
    expect(
      isRoutineReleaseEntry({
        sourceType: "release",
        title: "LangChain v1.0.0",
        titleEn: "LangChain v1.0.0",
        titleJa: "",
      }),
    ).toBe(false);
    expect(
      isRoutineReleaseEntry({
        sourceType: "blog",
        title: "Fixing v3.0.58 regressions in production",
      }),
    ).toBe(false);
  });
});
