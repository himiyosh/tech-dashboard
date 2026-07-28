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

   `verdict` is case-sensitive. Only lowercase `pass` and `fail` are valid. `PASS`, `Pass`, and other variants are invalid.
4. The expected reviewer must be external to the merger/coordinator session. A marker whose `by` session equals the merger/coordinator session never grants clearance.
5. Immediately before `gh pr merge`, obtain the PR state and exact current head again, then run:

   `node scripts/check-independent-review.mjs --repo <owner/name> --pr <number> --head <exact-head> --merger-session <uuid> --reviewer-session <uuid>`

6. Interpret the result only after checking the single review ticket/session state and the PR state. `UNKNOWN` means no authoritative exact-head pass was found after those checks. It is not permission to merge and is not a reason to create a duplicate ticket automatically.
7. If the PR head changes, the prior marker is stale. Send a new push request for the new exact head and rerun the gate. The command must exit 0 on that exact head immediately before merge.

## Deterministic marker policy

- Only markers from the expected reviewer session and for the expected head are authoritative.
- Duplicate authoritative `pass` markers are accepted.
- Any authoritative exact-head `fail` dominates all `pass` markers until that fail comment or review body is edited or deleted.
- Stale-head, malformed, boundary-spoofed, mixed-case, wrong-reviewer, and self-issued markers never satisfy the gate.
- A malformed count requires a marker-like HTML comment sentinel (`<!-- independent-review`). Ordinary discussion of the gate or `check-independent-review.mjs` is not a marker attempt. A marker-like comment embedded in prose is malformed because a valid marker must remain the complete standalone body.
- Both `reviews[].body` and `comments[].body` are scanned. An empty review list does not invalidate a valid owner comment.
- Missing evidence arrays, a non-open PR, an exact-head mismatch, or a GitHub CLI/API failure fails closed.
- A rejection reached after evidence normalization emits exactly one count summary in the form `ERR: markers valid=<n> stale=<n> wrongReviewer=<n> selfIssued=<n> malformed=<n> reviewsScanned=<n> commentsScanned=<n>`. CLI contract validation, JSON, GitHub API, and evidence-normalization failures occur before a result exists and do not synthesize counts.

## Lessons Learned

### LL-IR-001: Review clearance is case-sensitive and must be external

- **Incident**: An uppercase `verdict=PASS` marker issued by the merger/coordinator session was not accepted by the strict parser used for merge clearance and did not provide independent evidence.
- **Root cause**: Marker grammar and reviewer independence were informal rather than executable.
- **Mitigation**: Keep the lowercase whole-body marker grammar, expected external reviewer UUID, exact PR head, and fail-dominates policy in `scripts/check-independent-review.mjs` and its regression tests.
- **Lesson**: A review comment is not merge clearance unless one fail-closed command verifies its exact syntax, exact head, external issuer, authoritative reviewer, and current PR state.

### LL-IR-002: Diagnostics classify syntax attempts, not topic mentions

- **Incident**: Ordinary review discussion and the script filename increased the malformed marker count because both contained the substring `independent-review`.
- **Root cause**: Diagnostic classification used a topic substring instead of a marker syntax sentinel.
- **Mitigation**: Count malformed bodies only when a marker-like HTML comment starts with the protocol prefix, while preserving the standalone whole-body parser for clearance.
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
