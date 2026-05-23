#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const marker = join(root, "web", "node_modules", "astro", "tsconfigs", "strict.json");

if (existsSync(marker)) {
  process.exit(0);
}

console.log("[ensure-web-deps] web/node_modules is missing; running npm --prefix web ci");
const result = spawnSync("npm", ["--prefix", "web", "ci"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
