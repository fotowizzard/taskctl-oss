# Flipped flow — alternating author/reviewer

In a classic review loop one engine always authors/revises and a different engine always reviews. In
**flipped flow** those roles alternate between iterations: the reviewer of one iteration becomes the
reviser of the next. It is a late-stage convergence tool, not a default — and it carries one important
compatibility warning (below).

## Principle

### Classic loop

```
iter 1: A writes   → B reviews → non-APPROVE (B's findings)
iter 2: A revises  → B reviews → non-APPROVE
iter 3: A revises  → B reviews → APPROVE
```

Author is always A; reviewer is always B. B's findings are interpreted by A, who applies the fix.

### Flipped loop

```
iter 1: A writes   → B reviews → non-APPROVE (B's findings)
iter 2: B revises  → A reviews → non-APPROVE (A's findings)
iter 3: A revises  → B reviews → APPROVE
```

Author alternates; reviewer alternates. Each iteration, the new author applies findings the other
model previously missed.

## Why it works

1. **No context-transfer loss.** Classic: B finds an issue → writes it in the review → A reads → A
   interprets → A applies the fix. Four boundaries where intent can distort. Flipped: B finds the issue
   → B applies the fix directly. Zero boundaries.
2. **Cross-model verification preserved.** Classic is "A authored, B reviews"; flipped is "B authored,
   A reviews". Symmetric — both keep a different-author + different-reviewer check.
3. **Alternating blind-spot classes.** Different models tend to miss different classes of problem
   (e.g. one drifts on document-consistency and forgotten parallel-section updates, another toward
   over-specification and strict contract interpretation). Flipping alternates which class surfaces per
   iteration; classic only ever exposes one.

## When to use / when not

**Use it:**
- Late-stage iterations (after ~3 classic ones) where only polish-class findings remain — flipping
  speeds convergence.
- When document-consistency findings dominate — the reviewer's corrections apply directly.
- Tactical fixes (wording, naming, formatting) where no strategic reasoning needs to transfer.

**Do not use it:**
- Architectural pivots (the early iterations where the plan is being rethought) — single-author
  ownership keeps it consistent.
- Domain-asymmetric engines, where one model is significantly stronger on the specific stack.
- Early iterations of a fresh plan — the author is still establishing the baseline voice; flipping
  fragments the direction.

**Rule of thumb:** classic for iterations 1–3. If iteration 4+ findings are all small / document-class,
switch to flipped. If an iteration-4+ finding is still Critical / architectural, stay classic or re-plan.

## Mandatory orchestrator verification at every failing iteration

The flip threshold is the **floor**, not the ceiling. Crossing it makes the orchestrator audit
*explicitly* mandatory so it is never skipped — but the audit is required at **every** non-APPROVE
iteration regardless of mode. For each Critical/Important finding, the orchestrator opens the cited
code, classifies it (confirmed / theoretical / false positive), and writes `audit-iter<n>.md` before
any fix runs. Flipping changes *which engine reviews* — it does not change the orchestrator's audit
role. See [cross-model-review.md](./cross-model-review.md) and the `orchestrator-verify` skill.

## Compatibility warning: `--auto` and `--auto --flip` skip the audit

The unattended auto-loops are **not** protocol-compliant. After a non-APPROVE review they forward the
findings **straight to fix/revise with no audit step** — there is no verification hook between review
and mutation. `--flip` only swaps the author/reviewer engine roles each iteration; it adds no audit.
So both `--auto` and `--auto --flip` skip the mandatory per-iteration verification and must be used only
when that risk is explicitly accepted. A production audit hook that would make an unattended loop
compliant is a deferred future note, not a current feature — do not treat `--auto --flip` as the
compliant way to run the flipped flow.

## Failure modes

1. **Divergence** — both engines raise the same class of finding but prefer different fixes; the loop
   oscillates. *Mitigation:* fingerprint finding themes to detect it; the iteration cap (default 3)
   forces a human decision.
2. **Symmetric blind spot** — both models consistently miss the same issue, so neither review catches
   it. *Mitigation:* a scheduled human review after a fixed number of iterations regardless of verdict;
   divergent review prompts (e.g. security-focused vs. UX-focused) can surface different issues.
3. **Infinite alternation** — A's fix triggers a B finding, B's fix triggers an A finding, endlessly.
   *Mitigation:* the iteration cap, plus divergence detection (a stable finding-count across iterations
   with no resolution → escalate to a human).

## CLI usage

There is exactly **one** CLI-implemented flipped loop: `do <stage> --auto --flip`. The `--flip` flag is
read only inside the `--auto` auto-loop branches — it swaps the reviser/reviewer engine roles each
iteration there. Without `--auto`, a bare `do <stage> --flip` runs a single stage and swaps **nothing**:
there is no loop for the flag to alternate. The iteration cap for the auto-loop is `--max-iterations N`
(**default 3**); without `--flip` the auto-loop is classic. Per the compatibility warning above,
`--auto --flip` skips the mandatory per-iteration audit, so it is **not** recommended as the compliant
way to run the flipped flow.

**Interactive flipped flow is a manually orchestrated A/B procedure** — not a single flag. You drive
single-stage commands (`do plan` / `do plan-review`, `do run` / `do review`, `do revise` / `do fix`)
and swap the author/reviewer roles yourself between iterations by pointing each stage at the other
engine (via `--engine`, or by swapping the configured author/reviewer pair). That keeps the orchestrator
audit between every review and every fix — the property the unattended `--auto --flip` loop drops.

## Worked example (in place of any private incident)

This repository's own WP5 dogfooding shows the pattern without a private label: a small, well-scoped
change converges in 1–3 classic iterations; a large workstream stalls into many iterations of
small/document-class findings — that stall is the signal to flip. WP5's review found real bugs (a
NEEDS-WORK verdict with multiple Critical findings, two of them data-loss paths caught before commit),
and every one of them was forwarded only **after** the orchestrator audited it — exactly the discipline
the unattended `--auto --flip` would have skipped.
