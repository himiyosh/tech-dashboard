import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAdsTxt } from "../web/src/lib/ads-txt.ts";
import { ADSENSE_CLIENT_ID } from "../web/src/lib/site.ts";
import { GET as getAdsTxt } from "../web/src/pages/ads.txt.ts";

const EXPECTED_ADS_TXT = buildAdsTxt(ADSENSE_CLIENT_ID);

describe("ads.txt", () => {
  it("formats a valid AdSense client ID as one authorized seller record", () => {
    expect(buildAdsTxt("ca-pub-0000000000000000")).toBe(
      "google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n",
    );
  });

  it.each([
    "",
    "pub-0000000000000000",
    "ca-pub-123",
    "ca-pub-000000000000000x",
    " ca-pub-0000000000000000",
    "ca-pub-0000000000000000 ",
  ])("rejects malformed client ID %j", (clientId) => {
    expect(() => buildAdsTxt(clientId)).toThrow(
      "ADSENSE_CLIENT_ID must match ca-pub- followed by exactly 16 digits",
    );
  });

  it("serves the configured publisher record as plain text with one trailing newline", async () => {
    const response = (await getAdsTxt({} as never)) as Response;
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(body).toBe(EXPECTED_ADS_TXT);
    expect(body.match(/\n/g)).toHaveLength(1);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("derives the endpoint from the existing configured client ID", () => {
    const endpointSource = readFileSync("web/src/pages/ads.txt.ts", "utf8");
    const helperSource = readFileSync("web/src/lib/ads-txt.ts", "utf8");

    expect(endpointSource).toContain("buildAdsTxt(ADSENSE_CLIENT_ID)");
    expect(endpointSource).not.toMatch(/ca-pub-\d{16}/);
    expect(helperSource).not.toMatch(/ca-pub-\d{16}/);
  });
});
