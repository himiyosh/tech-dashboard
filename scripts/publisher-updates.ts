import {
  advanceMajorUpdateLedger,
  MAJOR_UPDATE_INDEX_PATH,
  MAJOR_UPDATE_MAX_INDEX_BYTES,
  MAJOR_UPDATE_MAX_MONTH_BYTES,
  parseMajorUpdateState,
  type MajorUpdateSnapshot,
} from "../web/src/lib/major-update-ledger.ts";
import {
  buildPublicationGate,
  parsePublicationApprovalManifest,
  PUBLICATION_MANIFEST_PATH,
} from "../web/src/lib/publication-gate.ts";
import type { PublisherCommitFile } from "../worker/src/index.ts";

export interface UpdatePreparationInput {
  readAtRef: (path: string) => string | null;
  changes: readonly PublisherCommitFile[];
}

function requireJson(readAtRef: UpdatePreparationInput["readAtRef"], path: string): unknown {
  const content = readAtRef(path);
  if (content === null) {
    throw new Error(`publisher major updates: missing ${path} in captured main snapshot`);
  }
  return parseJsonContent(content, path);
}

function parseJsonContent(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`publisher major updates: invalid JSON in ${path}`);
  }
}

function indexSnapshot(value: unknown, path: string): MajorUpdateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("generatedAt" in value) || typeof value.generatedAt !== "string"
    || !("entries" in value) || !Array.isArray(value.entries)) {
    throw new Error(`publisher major updates: invalid ${path}`);
  }
  for (const [position, candidate] of value.entries.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`publisher major updates: invalid ${path}.entries[${position}]`);
    }
    const row = candidate as Record<string, unknown>;
    for (const key of [
      "id", "source", "sourceType", "url", "title", "titleJa", "titleEn",
      "summaryJa", "summaryEn", "lang", "publishedAt", "collectedAt", "category",
    ]) {
      if (typeof row[key] !== "string") {
        throw new Error(`publisher major updates: invalid ${path}.entries[${position}].${key}`);
      }
    }
    if ((row.importance !== 1 && row.importance !== 2 && row.importance !== 3)
      || !Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`publisher major updates: invalid ${path}.entries[${position}] taxonomy`);
    }
  }
  return {
    generatedAt: value.generatedAt,
    entries: value.entries,
  };
}

function serializeBounded(value: unknown, maxBytes: number, path: string): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`publisher major updates: ${path} exceeds ${maxBytes} bytes (${bytes})`);
  }
  return content;
}

export function prepareMajorUpdateFiles(input: UpdatePreparationInput): PublisherCommitFile[] {
  const baselineIndex = indexSnapshot(requireJson(input.readAtRef, "data/index.json"), "data/index.json");
  const nextIndexContent = input.changes.find((file) => file.path === "data/index.json")?.content;
  const nextIndex = indexSnapshot(
    nextIndexContent === undefined
      ? requireJson(input.readAtRef, "data/index.json")
      : parseJsonContent(nextIndexContent, "next data/index.json"),
    "next data/index.json",
  );
  const rawLedger = requireJson(input.readAtRef, MAJOR_UPDATE_INDEX_PATH);
  if (!rawLedger || typeof rawLedger !== "object" || Array.isArray(rawLedger)
    || !("months" in rawLedger) || !Array.isArray(rawLedger.months)) {
    throw new Error("publisher major updates: invalid month index");
  }
  const months = rawLedger.months.map((range: unknown) => {
    if (!range || typeof range !== "object" || !("month" in range)
      || typeof range.month !== "string" || !/^\d{4}-\d{2}$/.test(range.month)) {
      throw new Error("publisher major updates: invalid stored month");
    }
    return requireJson(input.readAtRef, `data/updates/${range.month}.json`);
  });
  const state = parseMajorUpdateState(rawLedger, months);
  const approvals = parsePublicationApprovalManifest(
    requireJson(input.readAtRef, PUBLICATION_MANIFEST_PATH),
  );
  const advanced = advanceMajorUpdateLedger(
    state,
    baselineIndex,
    nextIndex,
    buildPublicationGate({ manifest: approvals, now: baselineIndex.generatedAt }),
    buildPublicationGate({ manifest: approvals, now: nextIndex.generatedAt }),
  );
  if (!advanced.changed) return [];
  const changedMonths = new Set(advanced.added.map((event) => event.observedAt.slice(0, 7)));
  const files = [...changedMonths].sort().map((month) => {
    const path = `data/updates/${month}.json`;
    const payload = advanced.state.months.find((file) => file.month === month);
    if (!payload) throw new Error(`publisher major updates: missing output month ${month}`);
    return { path, content: serializeBounded(payload, MAJOR_UPDATE_MAX_MONTH_BYTES, path) };
  });
  files.push({
    path: MAJOR_UPDATE_INDEX_PATH,
    content: serializeBounded(advanced.state.index, MAJOR_UPDATE_MAX_INDEX_BYTES, MAJOR_UPDATE_INDEX_PATH),
  });
  return files;
}
