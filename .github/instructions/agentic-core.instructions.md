---
applyTo: "**"
description: "Concise organization-neutral rules for safe, verifiable agentic engineering."
---

# Agentic core rules

## Rule ownership

- This base bundle is organization-neutral. Organization policy belongs in an organization overlay and project constraints belong in project-local instructions.
- Do not copy organization names, internal URLs, policy identifiers, approved-tool lists, data-transfer procedures, or commit/language conventions into the base.
- Resolve conflicts before action. For destructive or externally visible actions, stop and request clarification.

## Work cycle

1. Refresh and open the tracked work view when one exists, and read its outstanding items before starting.
2. Explore the relevant files, existing patterns, instructions, tests, and recent changes.
3. Define measurable completion criteria and a focused validation plan.
4. Implement the smallest coherent change that fully addresses the requirement.
5. Run the narrowest validation that proves the changed behavior, then expand only when needed.
6. Record changed behavior, validation, remaining risk, and recovery context.
7. End with a visible summary of what changed, how it was validated, what remains, and the next action.

Do not claim completion from file existence, non-empty output, or agent confidence alone.
Do not open a work view by writing a file alone, and do not end a turn silently or with progress claims that no validation supports.

## Change safety

- Preserve unrelated user changes and existing behavior outside the requested scope.
- Do not use force push, reset, rebase, amend, policy bypass, `--no-verify`, or destructive cleanup without explicit approval.
- Do not commit or push secrets, credentials, PII, dumps, logs, local databases, screenshots, or support data.
- Surface errors with their category and evidence. Do not use broad catches, silent defaults, or success-shaped fallbacks.
- Keep types and contracts explicit. Do not hide errors with unsafe casts or loosely validated state.

## Validation

- Use existing build, typecheck, lint, test, format, security, and runtime checks.
- Test normal, error, empty, boundary, cancellation, and recovery paths relevant to the change.
- Validate external writes by read-back or another authoritative signal.
- Distinguish pre-existing failures from regressions introduced by the change.
- Add a deterministic regression guard when a defect or repeated feedback could recur.

## Documentation and learning

- Update affected README, API, configuration, prompt, Skill, or instruction content in the same change.
- Keep one source of truth and link to it instead of duplicating tables or procedures.
- Store reusable findings in the owning general rule, organization overlay, or project rule. Do not leave Lessons Learned as background text without updating the active contract.
- Keep temporary plans, screenshots, and reports outside the repository unless they become maintained documentation.

## Agent and tool use

- Start with a function or single agent. Add workflows, loops, graphs, or multiple agents only when they provide measurable value.
- Give every delegated task a complete input, output contract, scope, stop condition, and tool boundary.
- Use isolated read-only reviewers for independent critique. The primary agent owns edits and final decisions.
- Do not let multiple agents edit the same artifact concurrently.
- Keep secrets and destructive operations under the primary agent's direct control.
- Measure authoritative runtime context utilization at turn and bounded-work boundaries. At or below 50%, continue normal bounded work while keeping the standalone compact handoff current through atomic 1-3 line updates after PR creation or merge, child creation or completion with push state, blocker changes, and owner-decision changes.
- At 60%, start no new increment, finish only the current safe bounded unit, then complete and read back the standalone handoff. At 65%, create exactly one prepared non-owner successor in the same turn with explicit `model=gpt-5.6-sol`, `context_tier=long_context`, `reasoning_effort=max`, and `detached=true`; immediately read back the actual configuration and full context capacity, and fail closed without a second successor or ownership transfer on any degradation. At 70%, hard-stop all new work, including current-unit completion, and perform transfer and predecessor retirement only.
- Complete threshold handling in the current turn with verified make-before-break automation and ownership transfer plus predecessor retirement. Never depend on external detection, a future wake, transcript replay, or CAPI failure, and never end a turn idle while a threshold action remains incomplete. If authoritative self-measurement is unavailable, fail closed as `CONTEXT_USAGE_UNMEASURABLE`; if successor readback is missing or degraded, fail closed as `SUCCESSOR_CONFIGURATION_DEGRADED` instead of assuming a safe value or configuration.

## Evidence

- Ground factual claims in code, tests, tool output, or authoritative sources.
- Separate observed facts, inference, and unverified assumptions.
- Do not invent URLs, identifiers, capabilities, or absence claims.
- Record limitations when a required source, tool, permission, or model is unavailable.

## Detailed references

Detailed engineering, persona, and knowledge-system guidance is distributed under this project's `knowledge/agentic-rules/` directory and loaded only when the task requires it. The exact root depends on the platform the bundle was installed for, so resolve the path from this project's agent entry point rather than assuming one. Do not report the guidance as missing without checking the entry point first.
Long-running multi-session orchestration, liveness, stale-report handling, blank-session lifecycle, manifest coverage, retirement, and categorized dashboard guidance is in `agentic-engineering-rules.md` §6.
The start-of-work view and end-of-work summary contracts are in `agentic-engineering-rules.md` §6.16.1 and §6.16.2.
