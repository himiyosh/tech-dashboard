import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateIndependentReviewGate,
  fetchGitHubIndependentReviewEvidence,
  isIndependentReviewMarkerAttempt,
  isStrictRfc3339,
  parseIndependentReviewCliArgs,
  parseIndependentReviewMarker,
} from "../scripts/check-independent-review.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "check-independent-review.mjs");
const INSTRUCTION = join(
  ROOT,
  ".github",
  "instructions",
  "independent-review-gate.instructions.md",
);
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const MERGER = "11111111-aaaa-4aaa-8aaa-111111111111";
const REVIEWER = "22222222-bbbb-4bbb-8bbb-222222222222";
const OTHER_REVIEWER = "33333333-cccc-4ccc-8ccc-333333333333";
const AT = "2026-07-28T07:30:15.123Z";
const CLI_TIMEOUT_MS = 20_000;
const scratchRoots: string[] = [];

function marker({
  head = HEAD,
  verdict = "pass",
  by = REVIEWER,
  at = AT,
}: {
  head?: string;
  verdict?: string;
  by?: string;
  at?: string;
} = {}) {
  return `<!-- independent-review head=${head} verdict=${verdict} by=${by} at=${at} -->`;
}

function evidence({
  head = HEAD,
  state = "open",
  reviews = [],
  comments = [],
}: {
  head?: string;
  state?: string;
  reviews?: Array<{ body: string | null }>;
  comments?: Array<{ body: string | null }>;
} = {}) {
  return {
    repository: "owner/repo",
    pullRequestNumber: 7,
    pullRequest: { headSha: head, state },
    reviews,
    comments,
  };
}

function evaluate(
  reviewEvidence: ReturnType<typeof evidence>,
  overrides: Partial<{
    expectedHead: string;
    mergerSessionId: string;
    expectedReviewerSessionId: string;
  }> = {},
) {
  return evaluateIndependentReviewGate({
    evidence: reviewEvidence,
    repository: "owner/repo",
    pullRequestNumber: 7,
    expectedHead: HEAD,
    mergerSessionId: MERGER,
    expectedReviewerSessionId: REVIEWER,
    ...overrides,
  });
}

function createScratchRoot(label: string) {
  const root = mkdtempSync(join(tmpdir(), `tech-dashboard-review-${label}-`));
  scratchRoots.push(root);
  return root;
}

function writeEvidenceFixture(
  root: string,
  reviewEvidence: Record<string, unknown>,
) {
  const path = join(root, "evidence.json");
  writeFileSync(path, `${JSON.stringify(reviewEvidence, null, 2)}\n`, "utf8");
  return path;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    env,
  });
}

function requiredCliArgs(inputPath?: string) {
  return [
    "--repo",
    "owner/repo",
    "--pr",
    "7",
    "--head",
    HEAD,
    "--merger-session",
    MERGER,
    "--reviewer-session",
    REVIEWER,
    ...(inputPath ? ["--input", inputPath] : []),
  ];
}

function sourceSnapshot() {
  return [
    SCRIPT,
    INSTRUCTION,
    join(ROOT, "package.json"),
    join(ROOT, "data", "index.json"),
  ].map((path) => readFileSync(path).toString("base64"));
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("independent review marker parser", () => {
  it("accepts the exact lowercase whole-body marker and surrounding whitespace", () => {
    expect(parseIndependentReviewMarker(` \n${marker()}\n`)).toEqual({
      head: HEAD,
      verdict: "pass",
      by: REVIEWER,
      at: AT,
    });
    expect(parseIndependentReviewMarker(marker({ verdict: "fail" }))).toMatchObject({
      verdict: "fail",
    });
  });

  it.each([
    marker({ verdict: "PASS" }),
    marker({ verdict: "Pass" }),
    marker({ head: HEAD.toUpperCase() }),
    marker({ by: REVIEWER.toUpperCase() }),
    `prefix ${marker()}`,
    `${marker()} suffix`,
    marker().replace(` by=${REVIEWER}`, ""),
    marker().replace(` at=${AT}`, ""),
    marker({ at: "2026-02-30T10:00:00Z" }),
    `${marker()}\n${marker()}`,
    `<!-- independent-reviewer head=${HEAD} verdict=pass by=${REVIEWER} at=${AT} -->`,
  ])("rejects malformed, mixed-case, or boundary-spoofed marker %s", (body) => {
    expect(parseIndependentReviewMarker(body)).toBeNull();
  });

  it("validates real RFC3339 timestamps rather than syntax alone", () => {
    expect(isStrictRfc3339("2026-07-28T07:30:15Z")).toBe(true);
    expect(isStrictRfc3339("2026-07-28T16:30:15.123+09:00")).toBe(true);
    expect(isStrictRfc3339("2026-02-29T00:00:00Z")).toBe(false);
    expect(isStrictRfc3339("2024-02-29T00:00:00Z")).toBe(true);
    expect(isStrictRfc3339("2026-07-28 07:30:15Z")).toBe(false);
  });

  it.each([
    { label: "valid marker", body: marker() },
    { label: "prose-embedded marker", body: `prose ${marker()}` },
    {
      label: "malformed standalone marker",
      body: marker({ verdict: "PASS" }),
    },
    {
      label: "truncated marker comment",
      body: `<!-- independent-review head=${HEAD}`,
    },
    {
      label: "marker comment without canonical spacing",
      body: "<!--independent-review verdict=pass -->",
    },
    {
      label: "boundary-spoofed marker comment",
      body: `<!-- independent-reviewer head=${HEAD} verdict=pass -->`,
    },
  ])("recognizes $label as a high-confidence marker attempt", ({ body }) => {
    expect(isIndependentReviewMarkerAttempt(body)).toBe(true);
  });

  it.each([
    {
      label: "ordinary gate discussion",
      body: "The independent-review gate scans reviews and comments.",
    },
    {
      label: "script filename mention",
      body: "Please inspect scripts/check-independent-review.mjs before merging.",
    },
    {
      label: "plain verdict discussion",
      body: `The expected verdict=pass belongs to reviewer ${REVIEWER}.`,
    },
  ])("does not treat $label as a marker attempt", ({ body }) => {
    expect(isIndependentReviewMarkerAttempt(body)).toBe(false);
  });
});

describe("independent review gate policy", () => {
  it("accepts a comment marker even when reviews is empty", () => {
    const result = evaluate(evidence({ comments: [{ body: marker() }] }));

    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({
      reviewsScanned: 0,
      commentsScanned: 1,
      authoritativePasses: 1,
      authoritativeFails: 0,
    });
  });

  it("accepts a review marker even when comments is empty", () => {
    expect(evaluate(evidence({ reviews: [{ body: marker() }] })).ok).toBe(true);
  });

  it("accepts deterministic duplicate passes", () => {
    const result = evaluate(
      evidence({
        reviews: [{ body: marker() }],
        comments: [{ body: marker({ at: "2026-07-28T07:31:00Z" }) }],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.counts.authoritativePasses).toBe(2);
  });

  it("does not count ordinary discussion as malformed evidence", () => {
    const result = evaluate(
      evidence({
        reviews: [
          { body: "Discussion of the independent-review gate only." },
          { body: "No clearance marker was posted in this review." },
        ],
        comments: [
          { body: "See scripts/check-independent-review.mjs for the implementation." },
          { body: "This is unrelated PR discussion." },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({
      reviewsScanned: 2,
      commentsScanned: 2,
      validMarkers: 0,
      malformedMarkerBodies: 0,
    });
  });

  it.each([
    {
      comments: [
        { body: marker({ verdict: "pass" }) },
        { body: marker({ verdict: "fail", at: "2026-07-28T07:31:00Z" }) },
      ],
    },
    {
      comments: [
        { body: marker({ verdict: "fail" }) },
        { body: marker({ verdict: "pass", at: "2026-07-28T07:31:00Z" }) },
      ],
    },
  ])("makes an authoritative fail dominate passes regardless of order", ({ comments }) => {
    const result = evaluate(evidence({ comments }));

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({
      authoritativePasses: 1,
      authoritativeFails: 1,
    });
    expect(result.reasons.join("\n")).toContain("fail dominates pass");
  });

  it.each([
    {
      label: "uppercase verdict",
      body: marker({ verdict: "PASS" }),
      count: "malformedMarkerBodies",
    },
    {
      label: "malformed standalone marker",
      body: marker().replace(` by=${REVIEWER}`, ""),
      count: "malformedMarkerBodies",
    },
    {
      label: "stale head",
      body: marker({ head: OTHER_HEAD }),
      count: "staleMarkers",
    },
    {
      label: "wrong reviewer",
      body: marker({ by: OTHER_REVIEWER }),
      count: "wrongReviewerMarkers",
    },
    {
      label: "self-issued marker",
      body: marker({ by: MERGER }),
      count: "selfIssuedMarkers",
    },
    {
      label: "boundary-spoofed marker",
      body: `text ${marker()}`,
      count: "malformedMarkerBodies",
    },
    {
      label: "boundary-spoofed marker name",
      body: `<!-- independent-reviewer head=${HEAD} verdict=pass by=${REVIEWER} at=${AT} -->`,
      count: "malformedMarkerBodies",
    },
  ])("rejects $label as clearance", ({ body, count }) => {
    const result = evaluate(evidence({ comments: [{ body }] }));

    expect(result.ok).toBe(false);
    expect(result.counts[count as keyof typeof result.counts]).toBe(1);
    expect(result.counts.authoritativePasses).toBe(0);
  });

  it("rejects a merger configured as the expected reviewer", () => {
    const result = evaluate(
      evidence({ comments: [{ body: marker({ by: MERGER }) }] }),
      { expectedReviewerSessionId: MERGER },
    );

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain(
      "merger/coordinator and external reviewer session IDs must differ",
    );
  });

  it("rejects a non-open PR and an exact-head mismatch", () => {
    const closed = evaluate(
      evidence({ state: "closed", comments: [{ body: marker() }] }),
    );
    const changedHead = evaluate(
      evidence({ head: OTHER_HEAD, comments: [{ body: marker() }] }),
    );

    expect(closed.ok).toBe(false);
    expect(closed.reasons.join("\n")).toContain("pull request state is closed");
    expect(changedHead.ok).toBe(false);
    expect(changedHead.reasons.join("\n")).toContain(
      `pull request head is ${OTHER_HEAD}`,
    );
  });

  it.each([
    { ...evidence(), reviews: undefined },
    { ...evidence(), comments: undefined },
    { ...evidence(), pullRequest: undefined },
  ])("fails closed when required evidence is missing", (reviewEvidence) => {
    expect(() => evaluate(reviewEvidence as ReturnType<typeof evidence>)).toThrow();
  });
});

describe("GitHub evidence loader", () => {
  it("fetches PR state and scans both paginated review and comment bodies", () => {
    const calls: string[][] = [];
    const reviewBody = marker();
    const commentBody = marker({ at: "2026-07-28T07:31:00Z" });
    const runGhApi = (args: string[]) => {
      calls.push(args);
      const endpoint = args.at(-1) ?? "";
      if (endpoint.endsWith("/pulls/7")) {
        return { head: { sha: HEAD }, state: "open" };
      }
      if (endpoint.includes("/pulls/7/reviews")) return [[{ body: reviewBody }]];
      if (endpoint.includes("/issues/7/comments")) return [[{ body: commentBody }]];
      throw new Error(`unexpected endpoint: ${endpoint}`);
    };

    const loaded = fetchGitHubIndependentReviewEvidence({
      repository: "owner/repo",
      pullRequestNumber: 7,
      runGhApi,
    });

    expect(loaded.reviews).toEqual([{ body: reviewBody }]);
    expect(loaded.comments).toEqual([{ body: commentBody }]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("--paginate");
    expect(calls[2]).toContain("--paginate");
  });
});

describe("independent review CLI", () => {
  it("parses only the explicit complete contract", () => {
    expect(parseIndependentReviewCliArgs(requiredCliArgs())).toMatchObject({
      ok: true,
      help: false,
    });
    expect(parseIndependentReviewCliArgs(["--help"])).toEqual({
      ok: true,
      help: true,
      options: {},
    });
    expect(parseIndependentReviewCliArgs([])).toMatchObject({
      ok: false,
      exitCode: 2,
    });
    expect(parseIndependentReviewCliArgs(["--unknown"])).toMatchObject({
      ok: false,
      exitCode: 2,
    });
    expect(
      parseIndependentReviewCliArgs([
        ...requiredCliArgs(),
        "--repo",
        "other/repo",
      ]),
    ).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("help, no args, and unknown args do not mutate repository files", () => {
    const before = sourceSnapshot();
    const cases = [
      { args: ["--help"], status: 0 },
      { args: [], status: 2 },
      { args: ["--unknown"], status: 2 },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(testCase.status);
      expect(sourceSnapshot()).toEqual(before);
    }
  }, CLI_TIMEOUT_MS);

  it("passes with an exact fixture and rejects missing comments evidence", () => {
    const root = createScratchRoot("fixture");
    const validPath = writeEvidenceFixture(
      root,
      evidence({ comments: [{ body: marker() }] }),
    );
    const valid = runCli(requiredCliArgs(validPath));

    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain(
      "OK: independent review gate passed for owner/repo#7",
    );

    const missingPath = writeEvidenceFixture(root, {
      ...evidence({ comments: [{ body: marker() }] }),
      comments: undefined,
    });
    const missing = runCli(requiredCliArgs(missingPath));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "review evidence comments must be present as an array",
    );
    expect(missing.stderr).not.toContain("ERR: markers ");
  });

  it.each([
    {
      label: "no marker",
      body: undefined,
      expected:
        "ERR: markers valid=0 stale=0 wrongReviewer=0 selfIssued=0 malformed=0 reviewsScanned=0 commentsScanned=0",
    },
    {
      label: "self-issued marker",
      body: marker({ by: MERGER }),
      expected:
        "ERR: markers valid=1 stale=0 wrongReviewer=1 selfIssued=1 malformed=0 reviewsScanned=0 commentsScanned=1",
    },
    {
      label: "prose-embedded malformed marker",
      body: `prose ${marker()}`,
      expected:
        "ERR: markers valid=0 stale=0 wrongReviewer=0 selfIssued=0 malformed=1 reviewsScanned=0 commentsScanned=1",
    },
    {
      label: "stale marker",
      body: marker({ head: OTHER_HEAD }),
      expected:
        "ERR: markers valid=1 stale=1 wrongReviewer=0 selfIssued=0 malformed=0 reviewsScanned=0 commentsScanned=1",
    },
    {
      label: "wrong-reviewer marker",
      body: marker({ by: OTHER_REVIEWER }),
      expected:
        "ERR: markers valid=1 stale=0 wrongReviewer=1 selfIssued=0 malformed=0 reviewsScanned=0 commentsScanned=1",
    },
  ])(
    "prints stable marker counts and exits 1 for $label",
    ({ label, body, expected }) => {
      const root = createScratchRoot(`rejection-${label.replaceAll(" ", "-")}`);
      const inputPath = writeEvidenceFixture(
        root,
        evidence({
          comments: body === undefined ? [] : [{ body }],
        }),
      );

      const result = runCli(requiredCliArgs(inputPath));
      const diagnosticLines = result.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith("ERR: markers "));

      expect(result.status).toBe(1);
      expect(diagnosticLines).toEqual([expected]);
    },
  );

  it("distinguishes empty evidence from fetched non-marker discussion", () => {
    const root = createScratchRoot("discussion-population");
    const inputPath = writeEvidenceFixture(
      root,
      evidence({
        reviews: [{ body: "Discussing the independent-review policy." }],
        comments: [
          { body: "See scripts/check-independent-review.mjs." },
          { body: "No marker was posted." },
        ],
      }),
    );

    const result = runCli(requiredCliArgs(inputPath));
    const diagnosticLines = result.stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith("ERR: markers "));

    expect(result.status).toBe(1);
    expect(diagnosticLines).toEqual([
      "ERR: markers valid=0 stale=0 wrongReviewer=0 selfIssued=0 malformed=0 reviewsScanned=1 commentsScanned=2",
    ]);
  });

  it("does not synthesize marker counts when JSON parsing fails", () => {
    const root = createScratchRoot("invalid-json");
    const inputPath = join(root, "invalid.json");
    writeFileSync(inputPath, "{", "utf8");

    const result = runCli(requiredCliArgs(inputPath));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERR:");
    expect(result.stderr).not.toContain("ERR: markers ");
  });

  it("fails closed when gh/API execution fails", () => {
    const root = createScratchRoot("gh-failure");
    const bin = join(root, "bin");
    const fakeGh = join(bin, "gh");
    mkdirSync(bin);
    writeFileSync(fakeGh, "#!/bin/sh\nexit 42\n", "utf8");
    chmodSync(fakeGh, 0o755);

    const result = runCli(requiredCliArgs(), {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub CLI request failed (exit 42)");
    expect(result.stderr).not.toContain("ERR: markers ");
  });

  it("keeps the documented command and durable merge policy guarded", () => {
    const instruction = readFileSync(INSTRUCTION, "utf8");
    const script = readFileSync(SCRIPT, "utf8");

    expect(instruction).toContain(
      "node scripts/check-independent-review.mjs --repo <owner/name>",
    );
    expect(instruction).toContain("send_session_message");
    expect(instruction).toContain("one outstanding review ticket");
    expect(instruction).toContain("Immediately before `gh pr merge`");
    expect(instruction).toContain("`UNKNOWN` means no authoritative exact-head pass");
    expect(instruction).toContain("Only lowercase `pass` and `fail` are valid");
    expect(instruction).toContain("expected reviewer must be external");
    expect(instruction).toContain(
      "ERR: markers valid=<n> stale=<n> wrongReviewer=<n> selfIssued=<n> malformed=<n> reviewsScanned=<n> commentsScanned=<n>",
    );
    expect(script).toContain("evidence.reviews.map");
    expect(script).toContain("evidence.comments.map");
    expect(script).toContain("fail dominates pass until edited or deleted");
  });
});
