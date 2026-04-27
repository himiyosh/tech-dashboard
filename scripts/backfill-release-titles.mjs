import fs from "node:fs";
import { REGISTRY as SOURCES } from "../harness/registry.ts";

const re = /^(?:release\s+)?v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.\-]+)?$/i;
const d = JSON.parse(fs.readFileSync("data/index.json", "utf8"));
let n = 0;
for (const e of d.entries) {
  if (e.sourceType !== "release" && e.sourceType !== "changelog") continue;
  const t = (e.title || "").trim();
  if (!re.test(t)) continue;
  const src = SOURCES[e.source];
  if (!src) continue;
  if (t.toLowerCase().includes(src.displayName.toLowerCase())) continue;
  const newT = `${src.displayName} ${t}`;
  e.title = newT;
  if (e.titleJa) e.titleJa = newT;
  if (e.titleEn) e.titleEn = newT;
  n++;
}
fs.writeFileSync("data/index.json", JSON.stringify(d, null, 2) + "\n");
console.log("updated", n, "entries");
