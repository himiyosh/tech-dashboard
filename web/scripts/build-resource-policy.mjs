export const TELEMETRY_UNAVAILABLE_MS = 30_000;

export function resolveBuildMemoryConfig(env = process.env, platform = process.platform) {
  const heapLimitMiB = Number(env.ASTRO_HEAP_LIMIT_MIB ?? "512");
  const defaultRssBudgetMiB =
    env.GITHUB_ACTIONS === "true" && platform !== "win32" ? 12_000 : 0;
  const rssBudgetMiB = Number(env.ASTRO_RSS_BUDGET_MIB ?? defaultRssBudgetMiB);

  if (!Number.isInteger(heapLimitMiB) || heapLimitMiB < 256) {
    throw new Error(`Invalid ASTRO_HEAP_LIMIT_MIB: ${env.ASTRO_HEAP_LIMIT_MIB}`);
  }
  if (!Number.isFinite(rssBudgetMiB) || rssBudgetMiB < 0) {
    throw new Error(`Invalid ASTRO_RSS_BUDGET_MIB: ${env.ASTRO_RSS_BUDGET_MIB}`);
  }
  if (platform === "win32" && rssBudgetMiB > 0) {
    throw new Error("ASTRO_RSS_BUDGET_MIB requires Unix process telemetry");
  }

  return { heapLimitMiB, rssBudgetMiB };
}

export function rssBudgetFailure({
  phase,
  rssBudgetMiB,
  telemetry,
  lastTelemetryAt,
  now,
}) {
  if (phase !== "astro" || rssBudgetMiB <= 0) return null;
  if (telemetry && telemetry.rssMiB > rssBudgetMiB) {
    return `astro exceeded RSS budget: ${telemetry.rssMiB.toFixed(0)}MiB > ${rssBudgetMiB}MiB`;
  }
  if (!telemetry && now - lastTelemetryAt >= TELEMETRY_UNAVAILABLE_MS) {
    return "astro RSS telemetry unavailable for 30s";
  }
  return null;
}
