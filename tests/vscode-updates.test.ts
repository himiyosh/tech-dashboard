import { describe, expect, it } from "vitest";
import { parseVscodeUpdatesFeed } from "../harness/collectors/vscode-updates.ts";

function feed(entries: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  ${entries}
</feed>`;
}

function entry(version: number, updated: string, content = `Learn what's new in Visual Studio Code 1.${version}`): string {
  return `<entry>
    <title>Visual Studio Code 1.${version}</title>
    <link href="https://code.visualstudio.com/updates/v1_${version}" />
    <link rel="related" href="https://code.visualstudio.com/assets/updates/1_${version}/release-highlights.webp" />
    <updated>${updated}</updated>
    <id>https://code.visualstudio.com/updates/v1_${version}</id>
    <category term="release" />
    <content type="html">&lt;p&gt;${content}&lt;/p&gt;</content>
  </entry>`;
}

describe("collectVscodeUpdates feed parser", () => {
  it("Atom feed の updated を publishedAt として使う", () => {
    const parsed = parseVscodeUpdatesFeed(
      feed(entry(119, "2026-05-06T17:00:00.000Z")),
      new Date("2026-05-10T00:00:00.000Z"),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.title).toBe("Visual Studio Code 1.119 Release Notes");
    expect(parsed[0]!.publishedAt).toBe("2026-05-06T17:00:00.000Z");
    expect(parsed[0]!.mediaThumbnail).toContain("release-highlights.webp");
  });

  it("future / Insiders entries を除外する", () => {
    const parsed = parseVscodeUpdatesFeed(
      feed([
        entry(120, "2026-05-13T17:00:00.000Z", "Learn what's new in Visual Studio Code 1.120 (Insiders)"),
        entry(119, "2026-05-06T17:00:00.000Z"),
      ].join("\n")),
      new Date("2026-05-10T00:00:00.000Z"),
    );

    expect(parsed.map((item) => item.url)).toEqual(["https://code.visualstudio.com/updates/v1_119"]);
  });
});