# Cross-model review — the rationale

This is the "why" behind the loop, for anyone who has never run it. The short version: the author of a
change is the worst reviewer of it, a *different* model catches a different class of bug, and the
reviewer's verdict is **input to a human-controlled audit**, not a final authority.

## The problem: self-review's blind spot

A model that just authored a plan or a diff has already committed to its own framing. Asked to review
its own output, it tends to re-confirm the assumptions it made while writing — the very assumptions most
likely to hide the bug. Self-review is structurally weak: the reviewer and the author share the same
blind spot.

## Complementary blind spots

Different models — especially different vendors — fail in different ways. One drifts toward
document-consistency errors and forgotten parallel updates; another toward over-specification and
strict, sometimes-spurious contract objections. Because the failure classes differ, a review by a
*different* model catches a **strictly larger** bug class than self-review: the union of "what the
author would catch on a second pass" and "what the other model's distinct strengths surface". That
union is the whole point.

## Reviewer is INPUT, not authority

This is the load-bearing rule. The fix loop trusts its prompt and **never pushes back** — hand it a
finding and it will dutifully change code, whether or not the finding is real. So the cross-model
reviewer cannot be the final word: if its verdict went straight to the fix loop, a hallucinated finding
would mutate correct code unchallenged.

The orchestrator is therefore the **only** quality gate between the review and a code/plan mutation. The
reviewer produces a structured verdict (`APPROVE` / `NEEDS REVISION` / `NEEDS WORK`) with `file:line`
citations; the orchestrator decides what is real. The reviewer informs; it does not command.

## The compliant executable workflow

Drive single stages with a human-controlled audit between review and fix — this is THE protocol:

```
author engine        →  produces plan / diff
different engine      →  reviews against a checklist → structured verdict + file:line citations
orchestrator audit    →  re-read each Critical/Important against the cited code;
                         classify confirmed / theoretical / false positive; write audit-iter<n>.md
fix / revise          →  apply ONLY the verified scope (+ any bug the audit itself found)
re-review             →  until APPROVE
STOP                   →  push / PR / merge / publish require explicit human OK
```

> **Warning.** The unattended auto-loops (`--auto`, and `--auto --flip`) **skip the audit** — after a
> non-APPROVE review they forward findings straight to fix/revise with no verification step between
> review and mutation. They are the risk-accepting exception, not the norm. A production audit hook that
> would make them compliant is a deferred future note, not a current feature.

## The audit protocol (summary)

For each Critical / Important finding the orchestrator: (1) opens the cited `path:line`; (2) confirms
the claim by reading the actual code / schema / test; (3) classifies it — **confirmed** (forward),
**theoretical** (legitimate but won't trigger given documented invariants → escalate or defer), or
**false positive** (reviewer wrong → push back, do not fix); (4) records the classification, and any bug
the reviewer *missed*, in `audit-iter<n>.md`; (5) forwards only the verified set. Run it every failing
iteration, and audit fast APPROVEs too. The full step-by-step lives in the `orchestrator-verify` skill.

## Evidence (sanitized)

The patterns below come from real usage of the source workspace and this repository's own dogfooding;
identifiers are anonymized, the patterns are what matter.

- **Reviewer false positives were the #1 recurring cost.** Cross-model reviewers repeatedly produced
  non-APPROVE verdicts citing stale line numbers, hallucinated identifiers, or out-of-scope
  escalations. The countermeasure that stuck was the orchestrator audit — re-read before acting.
- **Every fast APPROVE hid something.** In the track record, single-iteration APPROVEs concealed a
  real issue often enough that a fast approval now *triggers* an audit rather than skipping one.
- **Iteration counts are bimodal.** Small bugfixes converge in 1–2 cross-model iterations; large
  workstreams took many more — the late-stage stall is the signal to alternate author/reviewer (see
  [flipped-flow.md](./flipped-flow.md)).
- **This repository's WP5 numbers.** The cross-model review of WP5 returned **NEEDS WORK with 4 Critical
  + 5 Important**, while confirming the protocol skeleton was sound. The audit confirmed **two data-loss
  paths caught before commit** — a stale-replacement branch that would have recursively deleted a user's
  edits on restart, and an unscoped cleanup that would have removed an unrelated temp directory. The
  orchestrator had independently **pre-flagged the first** before the review, and the audit validated it.
- **Review depth is not role-diverse verification.** A change that survived six review iterations still
  shipped a regression, because all the testing ran under one privileged path that masked the failing
  branch. Depth of review does not substitute for verifying along diverse roles/paths.

## See also

- [task-lifecycle.md](./task-lifecycle.md) — the stage machine this review discipline rides on.
- [flipped-flow.md](./flipped-flow.md) — when to alternate author/reviewer, and the same `--auto` warning.
- the `orchestrator-verify` and `cross-model-review` skills — the agent-loadable contracts.
