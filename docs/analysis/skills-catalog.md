# Skills catalog — the operational knowledge worth shipping

> Mined from the origin workspace's memory notes, operator rules, and per-task audit trails, then
> validated by this project's own dogfooding (every WP here ran the same loop). This is the SOURCE
> document for WP4: Tier-1 entries become real skill files; the methodology docs explain the why.

## Tier 1 — the differentiators (ship as skills)

| Skill | One-line contract |
|---|---|
| **orchestrator-verify** | A reviewer verdict is INPUT, not authority. Before acting on any Critical/Important finding, independently re-read the cited code; classify each finding (confirmed / theoretical / false positive); push back on false positives; record an `audit-iterN` artifact EVERY failing iteration. Fast APPROVEs get audited too — they historically hid bugs. |
| **cross-model-review** | Who wrote it doesn't review it. A different model (ideally different vendor) reviews plans and diffs against an explicit checklist and returns a structured verdict (APPROVE / NEEDS REVISION / NEEDS WORK) with file:line citations. Complementary blind spots catch a strictly larger bug class than self-review. |
| **empirical-first** | Ground-truth before planning: live API > docs > inference. Ping the real schema/API/repo state before locking assumptions into a plan; verify a reported state ("it's broken / it's merged") before acting on it. |
| **review-loop-autopilot** | Drive prompt → review → verify → fix → re-review to APPROVE autonomously, but stop dead at outward actions (push/PR/merge/publish). Calibrate reviewer effort to budget; cap iterations; switch to alternating author/reviewer only late (polish-class findings) and never during architectural churn. |
| **worktree-isolate** | One task = one worktree cut from a FRESHLY FETCHED `origin/<base>` (stale local refs produce wrong diffs). Dependencies via junction/symlink from the main checkout, not reinstall. |
| **branch-guard / pr-base-guard** | Hooks, not vigilance: block direct commits/pushes to protected branches; assert the PR base is the configured integration branch (a CLI silently ignoring `--base` caused a real near-miss). |

## Tier 2 — disciplines (ship as methodology docs / rules)

- **Single-stage human gating** as the default; unattended loops are opt-in (the lived workflow).
- **Scope fidelity:** a proposal in chat is not authorization; fix what was asked; flag the rest.
- **Investigate, don't punt:** check git history / dates / 3-way diffs and deliver an
  evidence-backed verdict instead of "I don't know".
- **Reuse-first:** grep for an existing service/hook/helper before writing a new one.
- **Outward-action gate:** push/PR/merge/publish/state-mutating writes require explicit OK,
  re-authorized per session for destructive forms.
- **Budget-aware review batches:** high effort for single deep reviews, medium for wide batches;
  detect caps by exit code, not output grepping.
- **Print-only execution of generated commands:** engine-authored shell is an artifact for a
  human to run, never something the tool executes silently (validated hard in WP5).
- **Tests that mask integration are worse than none:** a "replica" of the integration under test
  passed while the real seam was broken; prefer driving the real path with a recording fake.
- **Backlog inbox ≠ active pipeline:** imported-but-unworked tasks should not wear the full
  artifact costume.

## Guardrails (anti-patterns with teeth)

- Never forward reviewer findings straight to a fix loop unverified (the flagship anti-pattern).
- Never skip the audit because "findings look reasonable" or "it's a late iteration".
- Never hand-edit machine state (state.json) — drive it through the lifecycle commands.
- Never `--no-verify` / bypass a secret scanner without manually verifying the finding.
- Never delete/overwrite on mismatch — halt and name the path (data-loss findings in WP5 both
  came from violating this).
- Never claim parity while shipping deliberate behavior changes — keep an explicit
  deliberate-exceptions ledger, tested.

## Provenance note

Each Tier-1 skill traces to repeated, dated incidents in the origin workspace (reviewer
hallucination overrides; bugs surviving N review rounds until an audit forced a from-scratch
re-read; a stale-base worktree producing a wrong PR diff; the silent `--base` near-miss). The
dogfooding of THIS repo reproduced the pattern: 5 plan iterations and 17 code-review fixes across
WP5 alone, including two data-loss paths caught before commit — every one surfaced by the
cross-model + orchestrator-verify loop these skills encode.
