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

1. Read the current tracked work view when one exists; inspect relevant rules, code, tests, and recent changes before editing.
2. State the observable outcome and pair each planned step with a check that can prove it. Resolve assumptions from evidence; escalate material choices instead of silently deciding for the user.
3. Implement the smallest coherent change that meets the outcome, preserving existing contracts.
4. Run focused checks for affected behavior and relevant failure paths. Expand validation when focused evidence is insufficient.
5. Read back externally written state, record recovery context, and give a visible summary of change, evidence, remaining risk, and next owner/action.

Do not claim completion from file existence, non-empty output, or agent confidence alone.
Do not open a work view by writing a file alone, and do not end a turn silently or with progress claims that no validation supports.
When HOME manages a shared work view, HOME alone writes Priorities after verifying reports. Coordinators and children use the read-only dashboard when available, report plan/start/completion/blocked to HOME, and do not write shared state or repeat its checklist in chat.

## Simplicity checks

- Before adding a feature, setting, agent, or abstraction, ask: is it requested or required by an observed recurring need? Do not build speculative flexibility or a one-use abstraction.
- Before removing code, ask: did this change make it unused? Clean up only orphans caused by your change; report unrelated pre-existing dead code without deleting it.
- Before reporting success, ask: does the diff trace to the request, did the relevant checks actually execute, and can the resulting state be read back? These are observable signals, not a style or line-count quota.
- For detailed scope, complexity, and compatibility rules use `agentic-engineering-rules.md` §1.1, §1.3, §3.2, and §3.3 rather than copying them into project instructions.

## Change safety

- Preserve unrelated user changes and existing behavior outside the requested scope; do not refactor neighboring code for tidiness.
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
- Keep a compact, independently readable handoff current at material work and ownership changes; record exact identities, validation, remaining work, and any uncommitted or unpushed state without copying transcripts or full diffs.
- At any turn, if measured context approaches a dangerous limit or the runtime explicitly warns of one, stop new work, finish and read back the handoff in that turn, and notify the responsible lifecycle owner. At a hard limit, do not extend even the current work unit. A status message alone is not a recovery artifact.
- Do not create your own successor to work around a context limit. A verified owner-led handoff must prevent concurrent ownership and preserve dirty work before a predecessor is retired. If utilization cannot be measured, use bounded work and explicit warnings rather than assuming unlimited capacity or halting forever.

## Evidence

- Ground factual claims in code, tests, tool output, or authoritative sources.
- Separate observed facts, inference, and unverified assumptions.
- Do not invent URLs, identifiers, capabilities, or absence claims.
- Record limitations when a required source, tool, permission, or model is unavailable.

## Detailed references

Detailed engineering, persona, and knowledge-system guidance is distributed under this project's `knowledge/agentic-rules/` directory and loaded only when the task requires it. The exact root depends on the platform the bundle was installed for, so resolve the path from this project's agent entry point rather than assuming one. Do not report the guidance as missing without checking the entry point first.
Long-running multi-session orchestration, liveness, stale-report handling, owner-led recovery, and retirement guidance is in `agentic-engineering-rules.md` §6.
The HOME Priorities, read-only project-dashboard, start-of-work, and end-of-work contracts are in `agentic-engineering-rules.md` §6.16.
