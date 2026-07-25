import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";

const SAMPLE_MS = 15_000;
const MIB = 1024 * 1024;
const startedAt = Date.now();
const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
let renderedHtml = 0;
let lastRouteFamily = "none";

function toMiB(value) {
  return Math.round(value / MIB);
}

function report(reason = "interval") {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  const heapSpaces = Object.fromEntries(
    getHeapSpaceStatistics().map((space) => [space.space_name, space.space_used_size]),
  );
  const nonHeapRssApprox = Math.max(0, memory.rss - memory.heapTotal - memory.external);
  console.log(
    [
      "ASTRO_MEMORY:",
      `reason=${reason}`,
      `elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
      `html=${renderedHtml}`,
      `family=${lastRouteFamily}`,
      `rss=${toMiB(memory.rss)}MiB`,
      `heapUsed=${toMiB(memory.heapUsed)}MiB`,
      `heapTotal=${toMiB(memory.heapTotal)}MiB`,
      `external=${toMiB(memory.external)}MiB`,
      `arrayBuffers=${toMiB(memory.arrayBuffers)}MiB`,
      `nonHeapRssApprox=${toMiB(nonHeapRssApprox)}MiB`,
      `oldSpace=${toMiB(heapSpaces.old_space ?? 0)}MiB`,
      `largeObjectSpace=${toMiB(heapSpaces.large_object_space ?? 0)}MiB`,
      `malloced=${toMiB(heap.malloced_memory)}MiB`,
      `peakMalloced=${toMiB(heap.peak_malloced_memory)}MiB`,
      `nativeContexts=${heap.number_of_native_contexts}`,
    ].join(" "),
  );
}

report();
setInterval(report, SAMPLE_MS).unref();

fs.promises.writeFile = async (target, data, options) => {
  const targetPath = target instanceof URL ? fileURLToPath(target) : String(target);
  const result = await originalWriteFile(target, data, options);
  if (path.basename(targetPath) !== "index.html") return result;

  // Astro exposes build-wide hooks but not route progress. Counting completed
  // HTML writes ties heap growth to the route family without retaining bodies.
  renderedHtml++;
  const relative = path.relative(path.resolve("dist"), targetPath);
  lastRouteFamily = relative.includes(path.sep)
    ? relative.split(path.sep)[0]
    : "root";
  if (renderedHtml % 100 === 0) report("html-progress");
  return result;
};
