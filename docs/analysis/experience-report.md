# Experience report — how the source workspace was actually used

> Distilled from a five-agent mining pass over the origin workspace (~95 real tasks, ~40 memory
> notes, ~300 ad-hoc scripts, the full CLI source, and the operator's rules), plus operator
> corrections. Identifiers are sanitized; patterns are what matter. This document is the evidence
> base behind the ROADMAP and the WP4 skills catalog.

## Usage profile (quantitative)

- **~95 task dirs; ~50% never left `analysis`.** A contiguous block of tracker tickets was synced
  in bulk and never planned — the tool doubled as a **backlog inbox**. Implication (shipped in WP1):
  keep lightweight task records separate from the heavyweight pipeline artifacts.
- **Plan-review iteration count is bimodal.** Small bugfixes converge in 1–2 cross-model
  iterations; large workstreams took **8–13** plan versions. Late-stage stalls were the trigger for
  the alternating author/reviewer ("flipped") mode — used rarely and deliberately.
- **Unattended automation was built and then deliberately bypassed.** `--auto` loops exist and
  work, but both operator runbooks say to drive stages one at a time (`do plan`, `do run`, …) with
  a human eyeball between stages. The lived workflow is **human-gated single-stage**; `--auto` is a
  power-user opt-in. (Shipped as the default UX stance.)
- **Engines had fixed roles:** one vendor's model plans/implements, the other reviews. Reviewer
  reasoning effort was consciously downshifted after hitting usage caps on batches.
- **Tracker WRITES were dead in practice** (kept read-only by policy/sandbox); real write-backs
  happened out-of-band. Implication (shipped in WP1): tracker is a pluggable adapter, local-first.
- **Governance (the contract/markup layer) gate was inert on feature branches BY DESIGN.** Its
  real value was the **read path** — agents reading module contracts / a knowledge graph during
  planning for cross-module acuity — while markup writing was batched separately. Early mining
  misread the inert gate as "dead weight"; the operator corrected this. (Shipped in WP2 as an
  optional, off-by-default module with the read path preserved.)

## Friction patterns (qualitative)

1. **Reviewer false positives were the #1 recurring cost.** The cross-model reviewer repeatedly
   produced NEEDS-WORK verdicts citing stale line numbers, hallucinated identifiers, or
   out-of-scope escalations. The countermeasure that stuck: **orchestrator-verify** — re-read every
   Critical/Important against the cited code before acting; write an audit artifact each iteration.
   Audits also caught real bugs the reviewer missed. *Reviewer is input, not authority.*
2. **Fast APPROVEs hid bugs.** Every single-iteration APPROVE in the track record concealed
   something. Fast approval triggers an audit rather than skipping it.
3. **Scope creep mid-PR** (unrelated changes folded into a diff) and **corrupt review patches**
   recurred → patch integrity checks + scope guards belong in the tool, not in vigilance.
4. **State drift:** local lifecycle state said "running" while the host said "merged weeks ago" —
   no automatic reconciliation with the VCS host existed.
5. **A six-iteration-reviewed change still shipped a regression** because all QA ran under an
   admin account that short-circuited the failing branch. Lesson: review depth does not substitute
   for role/path-diverse verification.
6. **~20 classes of ad-hoc scripts** accumulated for recurring operations (review harnesses,
   read-only DB probes, migrate-and-verify, secret digests, sprint reports) — the "shadow tool"
   that signals missing first-class commands.

## What the data corrected

- "GRACE is dead weight" → wrong; the value is the **read path**; the lint gate being quiet on
  feature branches is intended. Don't measure a comprehension layer by its write-gate metrics.
- "Automation is the product" → wrong; the **discipline** is the product. The human-gated loop
  with verified cross-model review is what produced quality, not unattended `--auto`.

## Implications carried into this repo

| Implication | Where it landed |
|---|---|
| Human-gated single-stage default; `--auto` opt-in | preserved CLI semantics |
| Orchestrator-verify as a first-class pipeline stage, persisted audits | WP4 skills + the audit-iter convention used by this very project |
| Tracker = adapter (local default, others pluggable) | WP1 |
| Governance → optional module, read-path value, off by default | WP2 |
| Comprehension layer: analyze the repo, don't assume | WP3 profiler/attach |
| Engine roles configurable; adapters; availability probes | WP5a |
| Backlog inbox ≠ pipeline artifacts | WP1 local tracker |
| Reconcile state with the VCS host | future work (post-WP6) |
