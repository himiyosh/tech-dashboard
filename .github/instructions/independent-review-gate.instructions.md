---
applyTo: "**"
description: "Exact-head independent review gate for pull request merges"
---

# Exact-head independent review gate

This repository requires an external exact-head review clearance before a pull request is merged. This is a local merge gate, not a GitHub Actions deployment workflow.

## Required workflow

1. At pull request creation, the topology owner sends one push-style review request to an external reviewer. Use `send_session_message` when project sessions are available. Include the repository, PR number, exact 40-character lowercase head SHA, merger/coordinator session UUID, and expected reviewer session UUID.
2. Keep one outstanding review ticket per repository, PR, and head SHA. Do not create duplicate tickets while that ticket is active.
3. The reviewer posts this complete marker body in a GitHub review or PR issue comment:

   `<!-- independent-review head=<40 lowercase hex> verdict=pass|fail by=<full lowercase session UUID> at=<RFC3339> -->`

   The protocol name and `verdict` are case-sensitive. Only lowercase `independent-review`, `pass`, and `fail` are valid. `Independent-Review`, `INDEPENDENT-REVIEW`, `PASS`, `Pass`, and other variants are invalid.
4. The expected reviewer must be external to the merger/coordinator session. A marker whose `by` session equals the merger/coordinator session never grants clearance.
5. Immediately before `gh pr merge`, obtain the PR state and exact current head again, then run:

   `node scripts/check-independent-review.mjs --repo <owner/name> --pr <number> --head <exact-head> --merger-session <uuid> --reviewer-session <uuid>`

   When using `--input`, source `pullRequest.state` from GitHub REST `repos/<owner>/<repo>/pulls/<n>`, which returns lowercase values such as `open`. Do not use `gh pr view --json state`, which emits uppercase enum values such as `OPEN`; uppercase evidence remains invalid and fails closed.

6. Interpret the result only after checking the single review ticket/session state and the PR state. `UNKNOWN` means no authoritative exact-head pass was found after those checks. It is not permission to merge and is not a reason to create a duplicate ticket automatically.
7. If the PR head changes, the prior marker is stale. Send a new push request for the new exact head and rerun the gate. The command must exit 0 on that exact head immediately before merge.

## Pull request CI enforcement

- `.github/workflows/ci.yml` executes `npm run check:independent-review` only for a `pull_request` event whose event snapshot is open. It resolves the PR number and expected head from `github.event.pull_request`, never from branch names or free-form PR text.
- Configure `INDEPENDENT_REVIEW_MERGER_SESSION_ID` and `INDEPENDENT_REVIEW_REVIEWER_SESSION_ID` as GitHub Actions repository variables. Both values must be full lowercase UUIDs and must identify different sessions. Missing, malformed, or identical values fail closed.
- Before executing the strict gate, the workflow reads the current PR state from GitHub REST. A current `closed` state skips only that historical rerun. A current `open` state proceeds to the existing REST evidence loader, which revalidates lowercase `state=open`, the exact event head, reviews, comments, and both session IDs. Any other state or API failure stops the workflow.
- Posting a marker does not create a new `pull_request` event. Rerun the failed job for the same head after the external reviewer posts the marker. If the head changed, use the new workflow run and request a new exact-head review.
- CI enforcement does not replace the immediate pre-merge command in step 5. The merger must still refetch the exact head and run the local gate immediately before merge.

## Deterministic marker policy

- Only markers from the expected reviewer session and for the expected head are authoritative.
- Duplicate authoritative `pass` markers are accepted.
- Any authoritative exact-head `fail` dominates all `pass` markers until that fail comment or review body is edited or deleted.
- Stale-head, malformed, boundary-spoofed, mixed-case, wrong-reviewer, and self-issued markers never satisfy the gate.
- A malformed count requires a marker-like HTML comment sentinel whose protocol-name prefix is a case variant of `independent-review`. The diagnostic classifier normalizes only that protocol-name prefix, so case variants are visible as malformed attempts without loosening head, verdict, session, timestamp, or whole-body validation. Ordinary discussion of the gate or `check-independent-review.mjs` is not a marker attempt. A marker-like comment embedded in prose is malformed because a valid marker must remain the complete standalone body.
- Both `reviews[].body` and `comments[].body` are scanned. An empty review list does not invalidate a valid owner comment.
- Missing evidence arrays, a non-open PR, an exact-head mismatch, or a GitHub CLI/API failure fails closed.
- A rejection reached after evidence normalization emits exactly one count summary in the form `ERR: markers parsed=<n> stale=<n> wrongReviewer=<n> selfIssued=<n> malformed=<n> reviewsScanned=<n> commentsScanned=<n>`. Diagnostic categories are intentionally non-exclusive: `parsed` counts bodies that satisfy the strict marker grammar before head and reviewer authority checks, so it can overlap with `stale`, `wrongReviewer`, and `selfIssued`; for an exact-head marker issued by the merger while the expected reviewer is a different session, `wrongReviewer` and `selfIssued` both increment. Overlap never grants clearance, and the counters are not intended to sum to the number of scanned messages. CLI contract validation, JSON, GitHub API, and evidence-normalization failures occur before a result exists and do not synthesize counts.

## Lessons Learned

### LL-IR-001: Review clearance is case-sensitive and must be external

- **Incident**: An uppercase `verdict=PASS` marker issued by the merger/coordinator session was not accepted by the strict parser used for merge clearance and did not provide independent evidence.
- **Root cause**: Marker grammar and reviewer independence were informal rather than executable.
- **Mitigation**: Keep the lowercase whole-body marker grammar, expected external reviewer UUID, exact PR head, and fail-dominates policy in `scripts/check-independent-review.mjs` and its regression tests.
- **Lesson**: A review comment is not merge clearance unless one fail-closed command verifies its exact syntax, exact head, external issuer, authoritative reviewer, and current PR state.

### LL-IR-002: Diagnostics classify syntax attempts, not topic mentions

- **Incident**: Ordinary review discussion and the script filename increased the malformed marker count because both contained the substring `independent-review`.
- **Root cause**: Diagnostic classification used a topic substring instead of a marker syntax sentinel.
- **Mitigation**: Count malformed bodies only when a marker-like HTML comment starts with the protocol prefix, including case variants of that prefix, while preserving the lowercase standalone whole-body parser for clearance.
- **Lesson**: Diagnostic counters should identify high-confidence syntax attempts. Discussion about a protocol is evidence population, not malformed protocol data.

### LL-IR-003: Count summaries belong only to normalized gate results

- **Incident**: The CLI normalized fixture evidence before validating the expected head and session IDs, so invalid gate inputs could fail after evidence normalization without producing either a gate result or the required count summary.
- **Root cause**: Input validation, evidence normalization, and gate rejection were ordered independently, while regression tests covered marker classifications but not every PR-state and fail-dominates rejection.
- **Mitigation**: Validate the complete CLI gate context before loading evidence, reject multiline PR state values during evidence normalization, format counts from the normalized result object in one place, and exercise every normalized rejection through the CLI.
- **Lesson**: Emit diagnostics from a completed normalized result exactly once. Failures before a result exists must remain distinguishable and must not invent marker counts.

### LL-IR-004: Dynamic errors must not forge machine-readable diagnostics

- **Incident**: A newline in an unknown CLI argument or missing input path could place a forged `ERR: markers ...` line inside a pre-result error.
- **Root cause**: Dynamic error text was printed without escaping control characters, while operators and tests identify count summaries by their line prefix.
- **Mitigation**: Escape control characters in every dynamic diagnostic and reserve the count prefix for the result-owned formatter.
- **Lesson**: Machine-readable diagnostic lines require an exclusive emitter. Untrusted error text must remain on one escaped line before it reaches logs or parsers.

### LL-IR-005: Parsed markers are not authoritative clearances

- **Incident**: The former diagnostic counter name described every body accepted by the strict marker parser as valid even when all of those markers were stale or came from a non-authoritative session.
- **Root cause**: The counter increments immediately after syntax parsing, before the exact-head, expected-reviewer, self-issued, and verdict checks that determine clearance. A merger-issued exact-head marker also independently satisfies both the self-issued and wrong-reviewer diagnostics when the configured external reviewer is another session.
- **Mitigation**: Name the internal field `parsedMarkers` and the diagnostic label `parsed`, document all intentional overlaps, keep authoritative pass and fail counts separate, and fixture one marker that increments `parsedMarkers`, `wrongReviewerMarkers`, and `selfIssuedMarkers` without granting clearance.
- **Lesson**: Diagnostic terminology must describe the stage that produced the count, and diagnostic categories need not form a partition. Syntax acceptance and overlapping rejection reasons are not exact-head review clearance.

### LL-IR-006: Fixture PR state must preserve REST evidence semantics

- **Incident**: `gh pr view --json state` emits uppercase enum values such as `OPEN`, while the REST pull request response used by the gate provides lowercase `state` values such as `open`; copying the former into `--input` produced a fail-closed error without identifying the correct evidence source.
- **Root cause**: The fixture validation error stated the lowercase shape but omitted the GitHub REST endpoint that defines the normalized evidence contract.
- **Mitigation**: Keep uppercase values invalid, direct operators to REST `repos/<owner>/<repo>/pulls/<n>` in both CLI usage and validation errors, and fixture lowercase success plus uppercase pre-result failure with no count summary.
- **Lesson**: Fail-closed validation should preserve the authoritative evidence source and tell operators how to produce conforming evidence without silently normalizing a different API's enum format.
