import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LOCKFILES = [
  "package-lock.json",
  "web/package-lock.json",
  "worker/package-lock.json",
  "worker-summarizer/package-lock.json",
  "worker-body/package-lock.json",
];

interface LockPackage {
  integrity?: string;
  link?: boolean;
  resolved?: string;
}

interface PackageLock {
  packages?: Record<string, LockPackage>;
}

describe("package-lock provenance", () => {
  it.each(LOCKFILES)("%s uses canonical npmjs HTTPS tarballs with SHA-512 integrity", (path) => {
    const lock = JSON.parse(readFileSync(path, "utf8")) as PackageLock;
    const violations: string[] = [];
    let checked = 0;

    for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
      if (!name || pkg.link || !pkg.resolved) continue;
      checked += 1;

      let resolved: URL;
      try {
        resolved = new URL(pkg.resolved);
      } catch {
        violations.push(`${name}: invalid resolved URL`);
        continue;
      }

      if (resolved.protocol !== "https:" || resolved.hostname !== "registry.npmjs.org") {
        violations.push(`${name}: resolved from ${resolved.protocol}//${resolved.hostname}`);
      }
      if (!pkg.integrity?.startsWith("sha512-")) {
        violations.push(`${name}: integrity is not SHA-512`);
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
