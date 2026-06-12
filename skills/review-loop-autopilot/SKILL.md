---
name: review-loop-autopilot
description: Drive prompt → review → verify → fix → re-review to APPROVE autonomously, but stop dead at outward actions. Activates when running a review/fix loop unattended, when deciding whether to use an unattended --auto mode, and before any push / PR / merge / publish.
allowed-tools: Bash, Read
---

# Review-loop-autopilot

Drive the gated loop to APPROVE on your own, but stop dead at outward actions. The unattended mode skips the mandatory audit — treat it as the risk-accepting exception.

## Contract

Run the loop autonomously: prompt → cross-model review → **orchestrator audit** → fix → re-review, repeating until APPROVE, with a hard stop at every outward action (push / PR / merge / publish). The audit step is mandatory each iteration. The fully-unattended mode (`do <stage> --auto`, and `--auto --flip`) forwards a failed review straight to fix/revise with **no audit step** — so it is NOT protocol-compliant and is used only when that risk is explicitly accepted.

## When to trigger

- You have an APPROVE target and want to converge without a human between every micro-step.
- You are choosing between driving stages one at a time and an unattended `--auto` run.
- You hit a push / PR / merge / publish — stop and get explicit sign-off.
- You want to set reviewer effort or an iteration cap for the run.

## Protocol

1. Drive single stages: `do plan`, `do run`, etc. — one stage, with an eyeball on the result.
2. After each review, run the **orchestrator audit** (see [orchestrator-verify](../orchestrator-verify/SKILL.md)) before any fix — every iteration, not just at a flip. **Local rule if that skill is unavailable:** for each Critical/Important finding, open the cited `file:line`, classify it confirmed / theoretical / false-positive, record the classification in `audit-iter<n>.md`, and forward only the confirmed scope to the fix.
3. Loop prompt → review → audit → fix → re-review until APPROVE; cap iterations (default 3) so a non-converging loop forces a human decision.
4. Calibrate reviewer effort to budget: high effort for a single deep review, medium for wide batches; detect usage caps by exit code, not by grepping output.
5. Switch to alternating author/reviewer only late (polish-class findings), never during architectural churn.
6. STOP at every outward action. Push / PR / merge / publish each require explicit OK, re-authorized per session for destructive forms.

## Anti-patterns

- Auto-pushing or auto-merging at the end of a loop — outward actions are always gated.
- Treating `--auto` / `--auto --flip` output as if it were audited — those modes skip the mandatory verification.
- Running an uncapped loop with no iteration ceiling.
- Flipping author/reviewer during an architectural pivot instead of after convergence on small findings.

## Worked micro-example

The compliant gated loop, with the hard stop:

```
do run <task-id>            # author implements
→ cross-model review        # reviewer returns NEEDS WORK + citations
→ orchestrator audit        # re-read each finding, classify, write audit-iter<n>.md
→ do fix <task-id>          # apply only the verified scope
→ re-review                 # APPROVE
STOP → push / open PR        # requires explicit human OK
```

The `--auto` form collapses the middle into review→fix with no audit — convenient, but it is the risk-accepting exception, not this loop.
