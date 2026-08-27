import { execFileSync, spawn } from "node:child_process";
import {
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeLegacyTagRedirects } from "./legacy-tag-redirects.mjs";
import { validateSitemapDist } from "./validate-sitemap-dist.mjs";
import {
  resolveBuildMemoryConfig,
  rssBudgetFailure,
} from "./build-resource-policy.mjs";
import {
  MAX_BUILD_SECONDS,
  MAX_STATIC_FILES,
  buildOutputBudgetFailures,
} from "./build-output-policy.mjs";

const HEARTBEAT_MS = 30_000;
const SAMPLE_MS = 2_000;
// A larger old-space delays major GC while thousands of detail pages allocate
// temporary render objects. The lower ceiling keeps process RSS bounded.
const IS_WINDOWS = process.platform === "win32";
// GitHub's public ARM runner has 16 GiB. Stop before the host OOM killer so the
// build reports the measured budget failure instead of an unexplained SIGKILL.
const {
  heapLimitMiB: ASTRO_HEAP_LIMIT_MIB,
  rssBudgetMiB: ASTRO_RSS_BUDGET_MIB,
} = resolveBuildMemoryConfig();

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function cpuSeconds(value) {
  const [dayPart, clockPart] = value.includes("-")
    ? value.split("-", 2)
    : ["0", value];
  const parts = clockPart.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  const seconds = parts.pop() ?? 0;
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return Number(dayPart) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function formatCpuTime(totalSeconds) {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const seconds = rounded % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function processTelemetry(pid) {
  if (!pid || IS_WINDOWS) return null;
  try {
    const output = execFileSync(
      "ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "time=", "-o", "rss=", "-o", "comm="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const processes = output.split("\n").map((line) => {
      const [processId, parentId, cpuTime, rssKiB, ...commandParts] = line.trim().split(/\s+/);
      return {
        processId: Number(processId),
        parentId: Number(parentId),
        cpuTime,
        rssKiB: Number(rssKiB),
        command: path.basename(commandParts.join(" ")),
      };
    }).filter(
      (process) =>
        Number.isFinite(process.processId)
        && Number.isFinite(process.parentId)
        && Number.isFinite(process.rssKiB),
    );
    const descendants = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of processes) {
        if (!descendants.has(process.parentId) || descendants.has(process.processId)) continue;
        descendants.add(process.processId);
        changed = true;
      }
    }
    const tree = processes.filter((process) => descendants.has(process.processId));
    if (tree.length === 0) return null;
    const rssKiB = tree.reduce((total, process) => total + process.rssKiB, 0);
    const totalCpuSeconds = tree.reduce(
      (total, process) => total + cpuSeconds(process.cpuTime),
      0,
    );
    return {
      cpuTime: formatCpuTime(totalCpuSeconds),
      cpuSeconds: totalCpuSeconds,
      rssMiB: rssKiB / 1024,
      processes: tree
        .sort((left, right) => right.rssKiB - left.rssKiB)
        .map((process) => ({
          pid: process.processId,
          command: process.command,
          rssMiB: process.rssKiB / 1024,
        })),
    };
  } catch {
    return null;
  }
}

function collectOutputStats(root) {
  const routeFamilies = new Map();
  let files = 0;
  let html = 0;
  let bytes = 0;

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      bytes += statSync(absolute).size;
      if (entry.name !== "index.html") continue;
      html++;
      const relative = path.relative(root, absolute);
      const family = relative.includes(path.sep)
        ? relative.split(path.sep)[0]
        : "root";
      routeFamilies.set(family, (routeFamilies.get(family) ?? 0) + 1);
    }
  };
  walk(root);

  return {
    files,
    html,
    bytes,
    routeFamilies: [...routeFamilies.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([family, count]) => `${family}=${count}`)
      .join(","),
  };
}

async function runPhase(label, command, args, options = {}) {
  const startedAt = Date.now();
  let peakRssMiB = 0;
  let peakCpuSeconds = 0;
  let budgetError = "";
  let latestTelemetry = null;
  let lastTelemetryAt = startedAt;
  console.log(`BUILD: phase=${label} state=started`);

  const child = spawn(command, args, {
    stdio: "inherit",
    shell: IS_WINDOWS,
    env: options.env ?? process.env,
  });

  const sample = () => {
    const telemetry = processTelemetry(child.pid);
    const now = Date.now();
    if (telemetry) {
      lastTelemetryAt = now;
      latestTelemetry = telemetry;
      peakRssMiB = Math.max(peakRssMiB, telemetry.rssMiB);
      peakCpuSeconds = Math.max(peakCpuSeconds, telemetry.cpuSeconds);
    }
    const failure = rssBudgetFailure({
      phase: label,
      rssBudgetMiB: ASTRO_RSS_BUDGET_MIB,
      telemetry,
      lastTelemetryAt,
      now,
    });
    if (failure && !budgetError) {
      budgetError = failure;
      child.kill("SIGTERM");
    }
    return telemetry ?? null;
  };
  sample();
  const sampler = setInterval(sample, SAMPLE_MS);

  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const telemetry = latestTelemetry ?? sample();
    const resources = telemetry
      ? ` cpu=${telemetry.cpuTime} rss=${telemetry.rssMiB.toFixed(0)}MiB peakRss=${peakRssMiB.toFixed(0)}MiB processes=${telemetry.processes.map((process) => `${process.command}:${process.rssMiB.toFixed(0)}MiB`).join(",")}`
      : "";
    console.log(`BUILD: phase=${label} state=running elapsed=${elapsedSeconds}s${resources}`);
  }, HEARTBEAT_MS);

  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (budgetError) {
        reject(new Error(budgetError));
        return;
      }
      if (signal) {
        reject(new Error(`${label} terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  }).finally(() => {
    clearInterval(sampler);
    clearInterval(heartbeat);
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  });

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `BUILD: phase=${label} state=completed elapsed=${elapsedSeconds}s cpu=${peakCpuSeconds > 0 ? formatCpuTime(peakCpuSeconds) : "n/a"} peakRss=${peakRssMiB > 0 ? `${peakRssMiB.toFixed(0)}MiB` : "n/a"}`,
  );
}

const buildStartedAt = Date.now();
const dist = path.resolve("dist");
const astroCommand = IS_WINDOWS ? "astro.cmd" : "astro";
const pagefindCommand = IS_WINDOWS ? "pagefind.cmd" : "pagefind";

console.log(`BUILD: environment node=${process.version} platform=${process.platform}-${process.arch}`);
rmSync(dist, { recursive: true, force: true });
console.log("BUILD: phase=clean state=completed");

const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? "";
const astroNodeOptions = [
  existingNodeOptions,
  `--max-old-space-size=${ASTRO_HEAP_LIMIT_MIB}`,
  `--import=${pathToFileURL(path.resolve("scripts/build-memory-probe.mjs")).href}`,
].filter(Boolean).join(" ");
console.log(
  `BUILD: phase=astro heapLimit=${ASTRO_HEAP_LIMIT_MIB}MiB rssBudget=${ASTRO_RSS_BUDGET_MIB > 0 ? `${ASTRO_RSS_BUDGET_MIB}MiB` : "disabled"}`,
);
await runPhase("astro", astroCommand, ["build", "--silent"], {
  env: {
    ...process.env,
    NODE_OPTIONS: astroNodeOptions,
  },
});
const astroOutput = collectOutputStats(dist);
console.log(
  `BUILD: output=astro files=${astroOutput.files} html=${astroOutput.html} size=${formatBytes(astroOutput.bytes)} routes=${astroOutput.routeFamilies}`,
);
const legacyTagRedirectCount = writeLegacyTagRedirects({
  distDirectory: dist,
  indexPath: path.resolve("../data/index.json"),
});
console.log(`BUILD: phase=legacy-tag-redirects state=completed files=${legacyTagRedirectCount}`);

const crawlParity = validateSitemapDist({
  distDirectory: dist,
});
console.log(
  `BUILD: phase=crawl-parity state=completed sitemapUrls=${crawlParity.sitemapUrlCount} sitemapBytes=${crawlParity.sitemapByteLength} canonicalHtml=${crawlParity.canonicalHtmlCount} noindexHtml=${crawlParity.noindexHtmlCount} redirects=${crawlParity.redirectCount} internalDetailLinks=${crawlParity.internalDetailLinkCount} invalidInternalDetailLinks=${crawlParity.invalidInternalDetailLinkCount}`,
);

await runPhase("pagefind", pagefindCommand, ["--site", "dist"]);
const finalOutput = collectOutputStats(dist);
console.log(
  `BUILD: output=final files=${finalOutput.files} html=${finalOutput.html} size=${formatBytes(finalOutput.bytes)} routes=${finalOutput.routeFamilies}`,
);

const elapsedSeconds = Math.round((Date.now() - buildStartedAt) / 1000);
const budgetFailures = buildOutputBudgetFailures({
  files: finalOutput.files,
  elapsedSeconds,
});
if (budgetFailures.length > 0) {
  throw new Error(budgetFailures.join("; "));
}
console.log(
  `BUILD: policy=cloudflare-free maxFiles=${MAX_STATIC_FILES} maxSeconds=${MAX_BUILD_SECONDS} state=passed`,
);
console.log(`BUILD: state=completed elapsed=${elapsedSeconds}s`);
