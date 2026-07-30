import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import bodiesJson from "../data/bodies.json";
import {
  ALL_ENTRIES,
  KNOWLEDGE_ENTRIES,
  MAIN_TIMELINE_ENTRIES,
  RAW_ENTRIES,
  entriesFor,
} from "../web/src/lib/data.ts";
import { collectAddressableDetailEntries } from "../web/src/lib/detail-addressability.ts";
import { SOURCE_META } from "../web/src/lib/source-meta.ts";

const ISSUE_237_ENTRIES = [
  {
    id: "bed450615ddfd03d",
    url: "https://aws.amazon.com/blogs/machine-learning/introducing-claude-opus-5-on-aws-anthropics-most-capable-opus-model/",
  },
  {
    id: "7ce8f0655e5249f3",
    url: "https://aws.amazon.com/blogs/machine-learning/openai-gpt-5-6-sol-terra-and-luna-are-now-generally-available-on-amazon-bedrock/",
  },
  {
    id: "7b3cb462c9d102ab",
    url: "https://cloud.google.com/blog/products/sap-google-cloud/sap-and-google-cloud-launch-bdc-connect-for-bigquery/",
  },
  {
    id: "52a59dad31dc17b8",
    url: "https://cloud.google.com/blog/products/ai-machine-learning/google-is-a-leader-in-the-gartner-magic-quadrant-for-conversational-ai/",
  },
  {
    id: "5abc0b85ffaee46f",
    url: "https://cloud.google.com/blog/products/management-tools/alert-with-sql-in-cloud-monitoring-observability-analytics/",
  },
  {
    id: "07df858350edbc9d",
    url: "https://cloud.google.com/blog/products/identity-security/securing-agentic-ai-whats-new-in-vpc-service-controls/",
  },
  {
    id: "37803898e498b24d",
    url: "https://devblogs.microsoft.com/foundry/document-translation-build-2026/",
  },
  {
    id: "1fe4d821705368ab",
    url: "https://aws.amazon.com/blogs/machine-learning/introducing-claude-apps-gateway-for-aws/",
  },
  {
    id: "4804d6346be88fc2",
    url: "https://aws.amazon.com/blogs/machine-learning/introducing-grok-on-amazon-bedrock/",
  },
  {
    id: "b774ed271b22e41b",
    url: "https://cloud.google.com/blog/products/data-analytics/conversational-analytics-in-google-data-cloud-in-q326/",
  },
  {
    id: "592d34bdee2e8b6a",
    url: "https://cloud.google.com/blog/products/identity-security/future-proofing-data-integrity-quantum-safe-digital-signatures-in-cloud-kms/",
  },
] as const;

const archiveEntries = readdirSync("data/archive")
  .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
  .flatMap((name) => {
    const payload = JSON.parse(
      readFileSync(join("data/archive", name), "utf8"),
    ) as { entries?: Array<{ id?: string }> };
    return payload.entries ?? [];
  });

const addressableIds = new Set(
  collectAddressableDetailEntries(RAW_ENTRIES, []).map((entry) => entry.id),
);

describe("Knowledge eligibility artifacts", () => {
  it.each(ISSUE_237_ENTRIES)(
    "keeps $id everywhere except the Knowledge lane",
    ({ id, url }) => {
      const entry = RAW_ENTRIES.find((candidate) => candidate.id === id);
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        id,
        url,
        evergreen: true,
        knowledgeEligible: false,
      });
      expect(entry?.summaryJa.trim()).not.toBe("");
      expect(entry?.summaryEn.trim()).not.toBe("");
      expect(ALL_ENTRIES.some((candidate) => candidate.id === id)).toBe(true);
      expect(MAIN_TIMELINE_ENTRIES.some((candidate) => candidate.id === id)).toBe(true);
      expect(
        entry ? entriesFor(entry.category).some((candidate) => candidate.id === id) : false,
      ).toBe(true);
      expect(addressableIds.has(id)).toBe(true);
      expect(archiveEntries.some((candidate) => candidate.id === id)).toBe(true);
      expect(id in bodiesJson.bodies).toBe(true);
      expect(
        SOURCE_META.some((source) => source.id === entry?.source),
      ).toBe(true);
      expect(KNOWLEDGE_ENTRIES.some((candidate) => candidate.id === id)).toBe(false);
    },
  );
});
