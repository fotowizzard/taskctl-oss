---
name: cross-model-review
description: Who wrote it does not review it — a different model reviews plans and diffs and returns a structured, cited verdict. Activates when a plan or a diff is ready for review, before any fix or merge, whenever you would otherwise self-review your own output.
allowed-tools: Read, Bash
---

# Cross-model-review

The author never reviews their own work. A different model — ideally a different vendor — reviews against an explicit checklist and returns a structured, cited verdict.

## Contract

The engine that authored a plan or diff does not review it. A *different* engine reviews it against an explicit checklist and returns a structured verdict (`APPROVE` / `NEEDS REVISION` / `NEEDS WORK`) with `file:line` citations. Complementary blind spots between models catch a strictly larger bug class than self-review. The verdict is INPUT to the orchestrator, never final authority.

## When to trigger

- A plan is drafted and about to advance — review it before locking it.
- A diff is implemented and about to be marked done — review it before any fix loop or merge.
- You are about to accept your own output without a second model seeing it — don't.
- The same model that wrote the artifact is the one you were going to ask to review it — pick a different one.

## Protocol

1. The author engine (engine A) produces the plan or diff.
2. A *different* engine (engine B, ideally a different vendor) reviews it against an explicit checklist — correctness, scope fidelity, missing coverage, regressions.
3. Engine B returns a structured verdict: one of `APPROVE` / `NEEDS REVISION` / `NEEDS WORK`, with concrete `file:line` citations for each finding, graded Critical / Important / Suggestion.
4. Hand the verdict to **orchestrator-verify** — never straight to a fix loop. The orchestrator re-reads each finding before anything mutates.
5. On the next iteration keep roles fixed (A authors, B reviews) for stability — switch to alternating roles only late and deliberately (see [flipped-flow](../../docs/methodology/flipped-flow.md)). **Local rule if that doc is unavailable:** stay classic for iterations 1–3; only after ~3 iterations, when the remaining findings are all small / document-class (no Critical / architectural), swap so the prior reviewer authors the next fix.

## Anti-patterns

- The same model reviewing its own output (no complementary blind spot — defeats the purpose).
- A free-form verdict with no `file:line` citations (un-verifiable; invites churn).
- Treating the reviewer verdict as authority instead of input (skips the orchestrator gate).
- Downshifting reviewer effort silently — calibrate it to budget, but know that you did.

## Worked micro-example

A structured verdict block the reviewer returns:

```
Verdict: NEEDS WORK
- Critical: newproject.mjs:282 — `ours-stale` branch deletes user edits on restart.
- Important: cli.mjs:1027 — descendant symlink escape not re-checked before write.
Skeleton CONFIRMED SOUND; failures are 1 data-loss path + 1 confinement gap.
```

The orchestrator does not act on this directly — it opens each cited line, confirms or rejects, and only then forwards the verified scope.
