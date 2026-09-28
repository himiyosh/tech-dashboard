import { describe, expect, it } from "vitest";
import { prepareMajorUpdateFiles } from "../scripts/publisher-updates.ts";
import type { RawIndexEntry } from "../web/src/lib/data.ts";
import { parseMajorUpdateState } from "../web/src/lib/major-update-ledger.ts";

const beforeAt = "2026-09-30T23:00:00.000Z";
const afterAt = "2026-10-01T01:00:00.000Z";

function entry(id: string, importance: 1 | 2 | 3 = 3): RawIndexEntry {
  return {
    id,
    source: "openai-blog",
    sourceType: "blog",
    url: `https://example.com/${id}`,
    title: `Official release ${id}`,
    titleJa: `重要な更新 ${id}`,
    titleEn: `Official release ${id}`,
    summaryJa: "実際の機能と対象地域を説明する要約です。",
    summaryEn: "A usable summary of the feature and its availability.",
    lang: "en",
    publishedAt: beforeAt,
    collectedAt: beforeAt,
    tags: ["model"],
    category: "codex",
    importance,
    archiveTier: "hot",
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const oldArticle = entry("000000000000000a");
const newArticle = entry("000000000000000b");
const initialIndex = {
  schemaVersion: 1,
  initializedAt: null,
  lastObservedAt: null,
  lastSequence: 0,
  baseline: { sourceKeys: [], topicKeys: [] },
  months: [],
};
const approvalManifest = {
  version: 1,
  dailyReleaseLimit: 5,
  baseline: { capturedAt: beforeAt, ids: [oldArticle.id] },
  approvals: [],
};

describe("Publisher major-update artifacts", () => {
  it("seeds prior main from the captured snapshot, never the after image", () => {
    const baseline = new Map([
      ["data/index.json", json({ generatedAt: beforeAt, entries: [oldArticle] })],
      ["data/updates/_index.json", json(initialIndex)],
      ["data/approved-entries.json", json(approvalManifest)],
    ]);
    const after = json({ generatedAt: afterAt, entries: [oldArticle, newArticle] });
    const output = prepareMajorUpdateFiles({
      readAtRef: (path) => baseline.get(path) ?? null,
      changes: [{ path: "data/index.json", content: after }],
    });
    expect(output.map((file) => file.path)).toEqual([
      "data/updates/2026-10.json",
      "data/updates/_index.json",
    ]);
    const state = parseMajorUpdateState(
      JSON.parse(output[1]!.content) as unknown,
      [JSON.parse(output[0]!.content) as unknown],
    );
    expect(state.index.initializedAt).toBe(beforeAt);
    expect(state.index.lastSequence).toBe(1);
    expect(state.index.baseline.sourceKeys).toEqual(["example.com/000000000000000a"]);
    expect(state.months[0]?.events.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      observedAt: event.observedAt,
      publicationHold: event.publicationHold,
    }))).toEqual([{
      sequence: 1,
      id: newArticle.id,
      observedAt: afterAt,
      publicationHold: true,
    }]);

    const nextBaseline = new Map(baseline);
    nextBaseline.set("data/index.json", after);
    for (const file of output) nextBaseline.set(file.path, file.content);
    expect(prepareMajorUpdateFiles({
      readAtRef: (path) => nextBaseline.get(path) ?? null,
      changes: [{ path: "data/index.json", content: after }],
    })).toEqual([]);
  });

  it("records an empty baseline without generating old-item events", () => {
    const baseline = new Map([
      ["data/index.json", json({ generatedAt: beforeAt, entries: [oldArticle] })],
      ["data/updates/_index.json", json(initialIndex)],
      ["data/approved-entries.json", json(approvalManifest)],
    ]);
    const files = prepareMajorUpdateFiles({
      readAtRef: (path) => baseline.get(path) ?? null,
      changes: [{ path: "data/bodies.json", content: json({ bodies: {} }) }],
    });
    expect(files.map((file) => file.path)).toEqual(["data/updates/_index.json"]);
    const index = JSON.parse(files[0]!.content) as { lastSequence: number; initializedAt: string };
    expect(index.lastSequence).toBe(0);
    expect(index.initializedAt).toBe(beforeAt);
  });

  it("rejects missing or corrupt captured files before any write", () => {
    expect(() => prepareMajorUpdateFiles({
      readAtRef: () => null,
      changes: [{ path: "data/index.json", content: "{}" }],
    })).toThrow(/missing data\/index.json/);
    expect(() => prepareMajorUpdateFiles({
      readAtRef: (path) => path === "data/index.json"
        ? json({ generatedAt: beforeAt, entries: [oldArticle] })
        : path === "data/updates/_index.json"
          ? "{broken"
          : null,
      changes: [{ path: "data/index.json", content: json({ generatedAt: afterAt, entries: [oldArticle] }) }],
    })).toThrow(/invalid JSON in data\/updates\/_index.json/);
    expect(() => prepareMajorUpdateFiles({
      readAtRef: (path) => ({
        "data/index.json": json({ generatedAt: beforeAt, entries: [oldArticle] }),
        "data/updates/_index.json": json(initialIndex),
        "data/approved-entries.json": json(approvalManifest),
      })[path] ?? null,
      changes: [{
        path: "data/index.json",
        content: json({ generatedAt: afterAt, entries: [{ id: newArticle.id }] }),
      }],
    })).toThrow(/invalid next data\/index.json.entries\[0\].source/);
  });
});
