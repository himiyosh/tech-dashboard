import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollForFingerprint,
  readExpectedFingerprint,
  runVerifyWorkerDeployCli,
} from "../scripts/verify-worker-deploy.mjs";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";

const EXPECTED = "sha256:new0000000000000000000000000000000000000000000000000000000000";
const STALE = "sha256:old0000000000000000000000000000000000000000000000000000000000";

function healthResponse(fingerprint) {
  return Response.json({
    ok: true,
    status: "bridge",
    publisherContractFingerprint: fingerprint,
  });
}

// A virtual clock so tests never wait on real timers: `sleep()` advances the
// same counter `now()` reads, keeping elapsedMs math exact and deterministic.
function makeVirtualClock(startMs = 0) {
  let current = startMs;
  return {
    nowImpl: () => current,
    sleepImpl: async (ms) => {
      current += ms;
    },
  };
}

describe("pollForFingerprint", () => {
  it("succeeds immediately when every poll already matches", async () => {
    const clock = makeVirtualClock();
    const fetchImpl = vi.fn(async () => healthResponse(EXPECTED));
    const onAttempt = vi.fn();

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 3,
      intervalMs: 5_000,
      timeoutMs: 30_000,
      fetchImpl,
      ...clock,
      onAttempt,
    });

    expect(result).toEqual({
      ok: true,
      attempts: 3,
      elapsedMs: 10_000,
      consecutiveMatches: 3,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onAttempt).toHaveBeenCalledTimes(3);
    // The health URL must be cache-busted on every attempt.
    for (const [calledUrl, init] of fetchImpl.mock.calls) {
      expect(calledUrl).toMatch(/^https:\/\/bridge\.example\/health\?_verify=/);
      expect(init.cache).toBe("no-store");
      expect(init.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("succeeds after the propagation window resolves partway through polling", async () => {
    const clock = makeVirtualClock();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First two polls still see the old bundle; from the third poll on the
      // new fingerprint has propagated everywhere.
      return healthResponse(call <= 2 ? STALE : EXPECTED);
    });

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 3,
      intervalMs: 5_000,
      timeoutMs: 90_000,
      fetchImpl,
      ...clock,
    });

    expect(result.ok).toBe(true);
    // 2 stale + 3 matching = 5 attempts; 4 intervals of 5s elapsed.
    expect(result.attempts).toBe(5);
    expect(result.elapsedMs).toBe(20_000);
    expect(result.consecutiveMatches).toBe(3);
  });

  it("resets the consecutive counter on a flap and only succeeds after a clean streak", async () => {
    const clock = makeVirtualClock();
    const sequence = [EXPECTED, EXPECTED, STALE, EXPECTED, EXPECTED, EXPECTED];
    let call = 0;
    const fetchImpl = vi.fn(async () => healthResponse(sequence[call++]));

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 3,
      intervalMs: 5_000,
      timeoutMs: 60_000,
      fetchImpl,
      ...clock,
    });

    expect(result.ok).toBe(true);
    expect(call).toBe(sequence.length);
    expect(result.attempts).toBe(6);
  });

  it("fails closed after the bounded timeout when the fingerprint never converges", async () => {
    const clock = makeVirtualClock();
    const fetchImpl = vi.fn(async () => healthResponse(STALE));

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 3,
      intervalMs: 5_000,
      timeoutMs: 20_000,
      fetchImpl,
      ...clock,
    });

    expect(result.ok).toBe(false);
    expect(result.lastFingerprint).toBe(STALE);
    expect(result.reason).toContain(`fingerprint is still ${STALE}`);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(20_000);
  });

  it("fails closed when the endpoint keeps erroring", async () => {
    const clock = makeVirtualClock();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 2,
      intervalMs: 5_000,
      timeoutMs: 10_000,
      fetchImpl,
      ...clock,
    });

    expect(result.ok).toBe(false);
    expect(result.lastFingerprint).toBeUndefined();
    expect(result.lastError).toBe("network unreachable");
    expect(result.reason).toContain("no valid fingerprint observed");
  });

  it("treats a non-2xx health response as a non-match without throwing", async () => {
    const clock = makeVirtualClock();
    const fetchImpl = vi.fn(async () => Response.json({ ok: false }, { status: 503 }));

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 1,
      intervalMs: 1_000,
      timeoutMs: 2_000,
      fetchImpl,
      ...clock,
    });

    expect(result.ok).toBe(false);
    expect(result.lastError).toBe("HTTP 503");
  });

  it("treats a body missing publisherContractFingerprint as a non-match", async () => {
    const clock = makeVirtualClock();
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, status: "bridge" }));

    const result = await pollForFingerprint({
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      requiredConsecutive: 1,
      intervalMs: 1_000,
      timeoutMs: 1_000,
      fetchImpl,
      ...clock,
    });

    expect(result.ok).toBe(false);
    expect(result.lastFingerprint).toBeUndefined();
    expect(result.lastError).toBe("response is missing publisherContractFingerprint");
  });

  it("validates its inputs before making any request", async () => {
    const fetchImpl = vi.fn();
    const base = {
      url: "https://bridge.example/health",
      expectedFingerprint: EXPECTED,
      fetchImpl,
    };
    await expect(pollForFingerprint({ ...base, url: "" })).rejects.toThrow("url is required");
    await expect(
      pollForFingerprint({ ...base, expectedFingerprint: "" }),
    ).rejects.toThrow("expectedFingerprint is required");
    await expect(pollForFingerprint({ ...base, timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs must be a positive number",
    );
    await expect(pollForFingerprint({ ...base, intervalMs: -1 })).rejects.toThrow(
      "intervalMs must be a positive number",
    );
    await expect(
      pollForFingerprint({ ...base, requiredConsecutive: 0 }),
    ).rejects.toThrow("requiredConsecutive must be an integer >= 1");
    await expect(
      pollForFingerprint({ ...base, requiredConsecutive: 1.5 }),
    ).rejects.toThrow("requiredConsecutive must be an integer >= 1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a timeout too small to ever observe the required consecutive streak", async () => {
    await expect(
      pollForFingerprint({
        url: "https://bridge.example/health",
        expectedFingerprint: EXPECTED,
        requiredConsecutive: 5,
        intervalMs: 10_000,
        timeoutMs: 20_000,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/timeoutMs \(20000\) is too small/);
  });
});

describe("readExpectedFingerprint", () => {
  it("reads the fingerprint from the repository publisher contract by default", () => {
    expect(readExpectedFingerprint()).toBe(DEPLOYED_PUBLISHER_FINGERPRINT);
  });

  it("matches the raw JSON on disk (no drift between the two readers)", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../worker/publisher-contract.json", import.meta.url), "utf8"),
    );
    expect(readExpectedFingerprint()).toBe(raw.fingerprint);
  });
});

describe("runVerifyWorkerDeployCli", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  it("prints usage and exits 0 for --help without polling", async () => {
    const poll = vi.fn();
    const exitCode = await runVerifyWorkerDeployCli(["--help"], {
      pollForFingerprint: poll,
    });
    expect(exitCode).toBe(0);
    expect(poll).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some(([line]) => line.includes("Usage:"))).toBe(true);
  });

  it("fails closed on an unknown argument without polling", async () => {
    const poll = vi.fn();
    const exitCode = await runVerifyWorkerDeployCli(["--bogus"], {
      pollForFingerprint: poll,
    });
    expect(exitCode).toBe(1);
    expect(poll).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("ERR: unknown argument: --bogus");
  });

  it("fails closed when a flag is missing its value", async () => {
    const poll = vi.fn();
    const exitCode = await runVerifyWorkerDeployCli(["--timeout-ms"], {
      pollForFingerprint: poll,
    });
    expect(exitCode).toBe(1);
    expect(poll).not.toHaveBeenCalled();
  });

  it("fails closed on a non-numeric --interval-ms", async () => {
    const exitCode = await runVerifyWorkerDeployCli(["--interval-ms", "soon"], {
      pollForFingerprint: vi.fn(),
    });
    expect(exitCode).toBe(1);
  });

  it("reads the expected fingerprint from the contract file when --expected is omitted", async () => {
    const readFingerprint = vi.fn(() => EXPECTED);
    const poll = vi.fn(async () => ({ ok: true, attempts: 1, elapsedMs: 0, consecutiveMatches: 1 }));
    const exitCode = await runVerifyWorkerDeployCli([], {
      pollForFingerprint: poll,
      readExpectedFingerprint: readFingerprint,
    });
    expect(exitCode).toBe(0);
    expect(readFingerprint).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFingerprint: EXPECTED }),
    );
  });

  it("uses an explicit --expected fingerprint without reading the contract file", async () => {
    const readFingerprint = vi.fn(() => EXPECTED);
    const poll = vi.fn(async () => ({ ok: true, attempts: 1, elapsedMs: 0, consecutiveMatches: 1 }));
    const exitCode = await runVerifyWorkerDeployCli(["--expected", STALE], {
      pollForFingerprint: poll,
      readExpectedFingerprint: readFingerprint,
    });
    expect(exitCode).toBe(0);
    expect(readFingerprint).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFingerprint: STALE }),
    );
  });

  it("exits 1 and prints an actionable hint when the poll fails closed", async () => {
    const poll = vi.fn(async () => ({
      ok: false,
      attempts: 24,
      elapsedMs: 120_000,
      consecutiveMatches: 0,
      lastFingerprint: STALE,
      lastError: undefined,
      reason: `fingerprint is still ${STALE}; expected ${EXPECTED}`,
    }));
    const exitCode = await runVerifyWorkerDeployCli(["--expected", EXPECTED], {
      pollForFingerprint: poll,
    });
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      `ERR: fingerprint is still ${STALE}; expected ${EXPECTED}`,
    );
    expect(
      errorSpy.mock.calls.some(([line]) => line.includes("Re-run this command")),
    ).toBe(true);
  });

  it("propagates an unexpected error from the poll as a clean failure", async () => {
    const poll = vi.fn(async () => {
      throw new Error("boom");
    });
    const exitCode = await runVerifyWorkerDeployCli(["--expected", EXPECTED], {
      pollForFingerprint: poll,
    });
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("ERR: boom");
  });
});
