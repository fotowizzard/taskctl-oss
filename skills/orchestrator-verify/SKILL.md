---
name: orchestrator-verify
description: Independently verify every cross-model reviewer finding before acting on it. Activates when a review returns NEEDS REVISION / NEEDS WORK / REJECT, before invoking any fix or revise loop, and after any fast single-iteration APPROVE.
allowed-tools: Read, Grep, Edit
---

# Orchestrator-verify

A reviewer verdict is INPUT, not authority. Before acting on any finding, independently re-read the cited code and classify it — then record an audit artifact.

## Contract

Before invoking a fix/revise loop on any cross-model review, the orchestrator independently re-reads every Critical and Important finding against the cited code, classifies each (confirmed / theoretical / false positive), pushes back on false positives, and writes an `audit-iter<n>.md`. Run the audit EVERY failing iteration — not just at a flip threshold. Fast APPROVEs get audited too: in the track record, every single-iteration APPROVE hid a bug.

## When to trigger

- A review returns `NEEDS REVISION` (plan stage) or `NEEDS WORK` / `REJECT` (code stage) — verify before any `fix` / `revise`.
- A review returns `APPROVE` after only one iteration — audit before accepting it.
- You are tempted to forward findings straight to the fix loop because they "look reasonable" or "it's a late iteration" — that is exactly when to verify.
- You already audited at a flip moment and a later iteration also failed — audit that one too.

## Protocol

1. Read the review fully: verdict, summary, every Critical, Important, Suggestion, and any Missing-Coverage note.
2. For each Critical / Important finding:
   1. Open the cited `path:line` with `Read`.
   2. Confirm the claim by inspecting the actual code / schema / test.
   3. Classify it: **confirmed** (forward to fix), **theoretical** (legitimate but won't trigger given documented invariants — escalate or defer), or **false positive** (reviewer wrong — do NOT invoke fix; comment why).
3. Push back on false positives. Do not let the fix loop run on an unverified finding — the fix loop trusts its prompt and never pushes back, so you are the only gate before mutation.
4. Write `audit-iter<n>.md` alongside the review: what you read, the classification per finding, and any bug YOU found that the reviewer missed.
5. Add reviewer-missed bugs to the fix scope, then forward only the verified set.

## Anti-patterns

- Forwarding reviewer findings to a fix loop unverified — the flagship anti-pattern.
- Skipping the audit because "findings look reasonable" or "we're past iteration 4".
- Treating a one-shot audit at the flip moment as sufficient for all later iterations — the flip is the floor, not the ceiling.
- Skipping the audit on a fast APPROVE.

## Worked micro-example

In this repo's WP5 the orchestrator pre-flagged an `ours-stale` replacement path as suspicious before review. The cross-model review then returned NEEDS WORK (4 Critical + 5 Important); the audit opened each cited location and confirmed the suspicion as **C2 — a real data-loss path** (a stale-replacement branch recursively deleting a user's edits on restart). Classified confirmed; added to fix scope; the fix halts on mismatch instead of deleting. A second finding (C3) was likewise confirmed as an unscoped cleanup deleting an unrelated temp dir. Neither shipped, because the audit read the code rather than trusting the verdict.
