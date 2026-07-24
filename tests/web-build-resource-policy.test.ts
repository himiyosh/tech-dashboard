import { describe, expect, it } from "vitest";
import {
  resolveBuildMemoryConfig,
  rssBudgetFailure,
} from "../web/scripts/build-resource-policy.mjs";

describe("Web build resource policy", () => {
  it("uses a small heap and a bounded RSS budget on GitHub Linux runners", () => {
    expect(resolveBuildMemoryConfig({ GITHUB_ACTIONS: "true" }, "linux")).toEqual({
      heapLimitMiB: 512,
      rssBudgetMiB: 12_000,
    });
    expect(resolveBuildMemoryConfig({}, "darwin")).toEqual({
      heapLimitMiB: 512,
      rssBudgetMiB: 0,
    });
  });

  it("rejects invalid limits and unsupported Windows RSS telemetry", () => {
    expect(() =>
      resolveBuildMemoryConfig({ ASTRO_HEAP_LIMIT_MIB: "255" }, "linux")
    ).toThrow("Invalid ASTRO_HEAP_LIMIT_MIB");
    expect(() =>
      resolveBuildMemoryConfig({ ASTRO_RSS_BUDGET_MIB: "-1" }, "linux")
    ).toThrow("Invalid ASTRO_RSS_BUDGET_MIB");
    expect(() =>
      resolveBuildMemoryConfig({ ASTRO_RSS_BUDGET_MIB: "12000" }, "win32")
    ).toThrow("requires Unix process telemetry");
  });

  it("fails only after a real RSS overage or 30 continuous seconds without telemetry", () => {
    const base = {
      phase: "astro",
      rssBudgetMiB: 12_000,
      lastTelemetryAt: 1_000,
    };
    expect(
      rssBudgetFailure({
        ...base,
        telemetry: { rssMiB: 11_999 },
        now: 31_000,
      }),
    ).toBeNull();
    expect(
      rssBudgetFailure({
        ...base,
        telemetry: { rssMiB: 12_001 },
        now: 2_000,
      }),
    ).toBe("astro exceeded RSS budget: 12001MiB > 12000MiB");
    expect(
      rssBudgetFailure({
        ...base,
        telemetry: null,
        now: 30_999,
      }),
    ).toBeNull();
    expect(
      rssBudgetFailure({
        ...base,
        telemetry: null,
        now: 31_000,
      }),
    ).toBe("astro RSS telemetry unavailable for 30s");
  });

  it("does not apply the Astro RSS policy to other phases or disabled budgets", () => {
    expect(
      rssBudgetFailure({
        phase: "pagefind",
        rssBudgetMiB: 12_000,
        telemetry: null,
        lastTelemetryAt: 0,
        now: 60_000,
      }),
    ).toBeNull();
    expect(
      rssBudgetFailure({
        phase: "astro",
        rssBudgetMiB: 0,
        telemetry: null,
        lastTelemetryAt: 0,
        now: 60_000,
      }),
    ).toBeNull();
  });
});
