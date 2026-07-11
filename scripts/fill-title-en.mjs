#!/usr/bin/env node

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "data", "index.json");

export const FALLBACK_MARKERS = [
  "AI summary",
  "このエントリは",
  "このエントリ",
  "の関連アップデート",
  "関連アップデート。AI 要約未生成",
  "Update related to",
  "AI-generated summary",
];

export function isFallbackSummary(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return true;
  return FALLBACK_MARKERS.some((marker) => value.includes(marker));
}

function clampTitle(title) {
  const line = String(title ?? "").trim().replace(/[.!?]+$/, "").trim();
  if (!line) return "";
  if (line.length <= 80) return line;
  const trimmed = line.slice(0, 80);
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace > 40 ? `${trimmed.slice(0, lastSpace)}…` : `${trimmed}…`;
}

export function extractLegacyTitleFromSummary(summary) {
  const line = String(summary ?? "").split("\n")[0].trim();
  if (!line) return "";
  const sentenceEnd = line.search(/[.!?]/);
  if (sentenceEnd > 10 && sentenceEnd <= 120) {
    return line.slice(0, sentenceEnd).trim();
  }
  return clampTitle(line);
}

function normalizeSummary(summary) {
  return String(summary ?? "").replace(/\s+/g, " ").trim();
}

function fallbackSentenceMatch(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!/[.!?]/.test(char)) continue;
    if (char === "!") {
      if (i < text.length - 1 && !/\s/.test(text[i + 1])) continue;
      return text.slice(0, i + 1);
    }
    if (char === "?") {
      if (i < text.length - 1 && !/\s/.test(text[i + 1])) continue;
      return text.slice(0, i + 1);
    }
    const next = text[i + 1] ?? "";
    if (next && !/\s/.test(next)) continue;
    const nextNonSpace = text.slice(i + 1).trimStart()[0] ?? "";
    if (nextNonSpace && !/["'([{A-Z0-9]/.test(nextNonSpace)) continue;
    return text.slice(0, i + 1);
  }
  return text;
}

export function extractTitleFromSummary(summary) {
  const text = normalizeSummary(summary);
  if (!text) return "";
  if (typeof Intl?.Segmenter === "function") {
    const segments = new Intl.Segmenter("en", { granularity: "sentence" }).segment(text);
    for (const segment of segments) {
      const rawSegment = segment.segment;
      if (!rawSegment?.trim()) continue;
      const segmentText = rawSegment.replace(/\s+$/, "");
      const terminalMatch = segmentText.match(/[.!?]+$/);
      if (terminalMatch) {
        const punctuationIndex = segment.index + segmentText.length - terminalMatch[0].length;
        const nextChar = text[punctuationIndex + terminalMatch[0].length] ?? "";
        if (nextChar && !/\s/.test(nextChar)) {
          return clampTitle(fallbackSentenceMatch(text));
        }
      }
      const candidate = clampTitle(segment.segment);
      if (candidate) return candidate;
    }
  }
  return clampTitle(fallbackSentenceMatch(text));
}

export function deriveTitleEnFromEntry(entry) {
  const summaryEn = (entry?.summaryEn ?? "").trim();
  if (!summaryEn || isFallbackSummary(summaryEn)) return "";

  return extractTitleFromSummary(summaryEn);
}

export function shouldCorrectLegacyDerivedTitle(entry) {
  const existing = (entry?.titleEn ?? "").trim();
  if (!existing) return false;
  const originalTitle = (entry?.title ?? "").trim();
  if (originalTitle && existing === originalTitle) return false;
  const summaryEn = (entry?.summaryEn ?? "").trim();
  if (!summaryEn || isFallbackSummary(summaryEn)) return false;
  const legacy = extractLegacyTitleFromSummary(summaryEn);
  const derived = extractTitleFromSummary(summaryEn);
  return existing === legacy && derived !== legacy;
}

export function fillMissingTitleEn(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  let alreadySet = 0;
  let missing = 0;
  let fromSummaryEn = 0;
  let correctedDerivedTitles = 0;
  let pendingOrFallback = 0;

  const nextEntries = entries.map((entry) => {
    const existing = (entry?.titleEn ?? "").trim();
    const derived = deriveTitleEnFromEntry(entry);
    if (existing) {
      if (derived && shouldCorrectLegacyDerivedTitle(entry)) {
        correctedDerivedTitles++;
        return { ...entry, titleEn: derived };
      }
      alreadySet++;
      return entry;
    }

    missing++;
    if (!derived) {
      pendingOrFallback++;
      return entry;
    }

    fromSummaryEn++;
    return { ...entry, titleEn: derived };
  });

  return {
    nextData: { ...data, entries: nextEntries },
    counts: {
      alreadySet,
      missing,
      fromSummaryEn,
      correctedDerivedTitles,
      pendingOrFallback,
      totalUpdated: fromSummaryEn + correctedDerivedTitles,
    },
  };
}

export function parseCliArgs(args) {
  const allowed = new Set(["--dry-run", "--apply", "--help", "-h"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    return { ok: false, exitCode: 1, message: `ERR: unknown argument(s): ${unknown.join(", ")}` };
  }

  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) {
      return { ok: false, exitCode: 1, message: "ERR: --help/-h cannot be combined with other arguments" };
    }
    return { ok: true, mode: "help" };
  }

  if (args.includes("--dry-run") && args.includes("--apply")) {
    return { ok: false, exitCode: 1, message: "ERR: choose either --dry-run or --apply, not both" };
  }

  if (args.length === 0) {
    return { ok: false, exitCode: 1, message: "ERR: missing mode; use --dry-run, --apply, or --help" };
  }

  if (args.length !== 1) {
    return { ok: false, exitCode: 1, message: "ERR: expected exactly one mode flag" };
  }

  if (args[0] === "--dry-run") return { ok: true, mode: "dry-run" };
  if (args[0] === "--apply") return { ok: true, mode: "apply" };

  return { ok: false, exitCode: 1, message: "ERR: unsupported mode" };
}

function writeJsonAtomically(path, value) {
  const tempPath = `${path}.fill-title-en.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function usage() {
  console.log("Usage: npm run titleen:fill -- --dry-run");
  console.log("       npm run titleen:fill -- --apply");
  console.log("       npm run titleen:fill -- --help");
}

export function runCli(args, options = {}) {
  const parsed = parseCliArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    usage();
    return parsed.exitCode;
  }

  if (parsed.mode === "help") {
    usage();
    return 0;
  }

  const indexPath = options.indexPath ?? INDEX_PATH;
  const raw = readFileSync(indexPath, "utf8");
  const data = JSON.parse(raw);
  const { nextData, counts } = fillMissingTitleEn(data);

  console.log(`fill-title-en [${parsed.mode}]`);
  console.log(`missing titleEn: ${counts.missing}`);
  console.log(`real summaryEn: ${counts.fromSummaryEn}`);
  console.log(`corrected legacy-derived titleEn: ${counts.correctedDerivedTitles}`);
  console.log(`deterministic/pending summaryEn: ${counts.pendingOrFallback}`);
  console.log(`already set: ${counts.alreadySet}`);
  console.log(`total updated: ${counts.totalUpdated}`);

  if (parsed.mode === "apply" && counts.totalUpdated > 0) {
    writeJsonAtomically(indexPath, nextData);
    console.log(`OK: wrote ${indexPath}`);
  } else if (parsed.mode === "apply") {
    console.log("OK: no changes needed");
  } else {
    console.log("OK: dry-run only; no files written");
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  process.exitCode = runCli(process.argv.slice(2));
}
