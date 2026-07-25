import { describe, expect, it } from "vitest";

import {
  tagHref,
} from "../web/src/lib/data.ts";
import { SINGLETON_INDEXED_TAG_ENTRY_IDS } from "../web/src/lib/tag-recovery.ts";
import { GET } from "../web/src/pages/tag-recovery.json.ts";

describe("singleton tag recovery", () => {
  it("adds the canonical entry id to an indexed singleton tag link", () => {
    const [tag, entryId] = Object.entries(SINGLETON_INDEXED_TAG_ENTRY_IDS)[0] ?? [];
    expect(tag).toBeTruthy();
    expect(entryId).toMatch(/^[a-f0-9]{16}$/);
    expect(tagHref(tag!, entryId)).toContain(`entry=${entryId}`);
  });

  it("publishes the same tag-to-entry mapping for client validation", async () => {
    const response = GET();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(SINGLETON_INDEXED_TAG_ENTRY_IDS);
  });
});
