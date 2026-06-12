# Skills

Agent-loadable encodings of the operational discipline that actually produced quality — the
differentiator, not the automation. Each skill is a single self-contained `SKILL.md` an agent can load
and follow: a one-line contract, checkable trigger conditions, a numbered protocol, anti-patterns with
teeth, and one worked micro-example. The human-readable rationale lives in
[../docs/methodology/](../docs/methodology/).

| Skill | Contract (one line) | Triggers on |
|-------|---------------------|-------------|
| [orchestrator-verify](./orchestrator-verify/SKILL.md) | A reviewer verdict is INPUT, not authority — re-read every Critical/Important against the cited code, classify it, and record an audit before any fix. | A non-APPROVE review, or a fast single-iteration APPROVE, before any fix/revise. |
| [cross-model-review](./cross-model-review/SKILL.md) | The author never reviews their own work — a *different* model reviews against a checklist and returns a structured, cited verdict. | A plan or diff is ready for review, before any fix or merge. |
| [empirical-first](./empirical-first/SKILL.md) | Ground-truth before planning — live API / schema / repo state beats docs beats inference; verify a reported state before acting. | Before planning against an assumed schema/interface, or acting on a reported "broken"/"merged". |
| [review-loop-autopilot](./review-loop-autopilot/SKILL.md) | Drive prompt → review → verify → fix → re-review to APPROVE autonomously, but stop dead at outward actions. | Running a review/fix loop unattended; before any push / PR / merge / publish. |
| [worktree-isolate](./worktree-isolate/SKILL.md) | One task = one worktree from a freshly fetched `origin/<base>`; halt if freshness can't be proven; junction deps, don't reinstall. | Starting a task; creating a branch/worktree; wiring deps into a fresh worktree. |
| [branch-guard](./branch-guard/SKILL.md) | Hooks, not vigilance — block direct commits/pushes to protected branches, and re-assert the PR base after the PR opens. | Before any commit/push to a protected branch; immediately after a PR is created. |

## How an agent loads these

The **portable core** of a skill is `name` + `description` — that is the cross-loader contract any
agent runtime can read. The `description` carries the activation trigger ("Activates when/before/after
…"), so a runtime can match the skill to the situation.

`allowed-tools` is a **Claude-compatible extension** — a labeled optional field naming the tools the
skill expects. It is included on every skill here, but it is not claimed universal; a non-Claude loader
may rely on `name` + `description` alone. The body skeleton (Contract, When to trigger, Protocol,
Anti-patterns, Worked micro-example) is consistent across all six so an agent consumes them the same way.
