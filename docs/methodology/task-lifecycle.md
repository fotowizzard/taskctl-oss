# Task lifecycle

Every task moves through a small state machine, one inspected stage at a time. The default workflow
is **human-gated single-stage**: you advance a stage, look at the result, then advance the next.
Unattended `--auto` loops exist and work, but they are an opt-in, risk-accepting mode — the lived,
recommended workflow drives stages individually with a human eyeball between them. See
[cross-model-review.md](./cross-model-review.md) and [flipped-flow.md](./flipped-flow.md) for the
review discipline that rides on top of this machine.

## State machine

```
analysis -> planned -> plan_reviewed -> running -> review -> done
  ^            |                          ^          |
  |            v                          |          v
  +--- plan-review (non-APPROVE)          +--- review (non-APPROVE)
       (via revise)                            (via fix)

  blocked   (reserved / display-only — present in the stage set and shown,
             but no shipped command and no automatic transition sets it)
```

## Stages

| Stage           | Meaning                                | Entry condition                                            |
|-----------------|----------------------------------------|------------------------------------------------------------|
| `analysis`      | Context recorded, ready to plan        | After the task is created, after `replan`, or after a non-APPROVE plan-review |
| `planned`       | `plan.md` written, with a verdict line | After `plan --finalize` or `revise --finalize`             |
| `plan_reviewed` | Plan approved by cross-model review    | After `plan-review --finalize` with `APPROVE`              |
| `running`       | Execution in progress                  | After `run` (prepare), or after a non-APPROVE review        |
| `review`        | Execution done, awaiting final review  | After `run --finalize` or `fix --finalize`                 |
| `done`          | Review passed, ready to publish        | After `review --finalize` with `APPROVE`                   |
| `blocked`       | Reserved / display-only                | **No shipped command sets it.** It is part of the stage set and displayed, but nothing assigns it automatically. |

## Transition rules

- `plan` requires stage `analysis` (the context record exists).
- `plan-review` requires stage `planned` (`plan.md` exists).
- `run` requires stage `plan_reviewed` or `running`, with the plan verdict `APPROVE`.
- `review` requires stage `review`. `review --external` skips the stage check (for reviewing another
  contributor's PR).
- `publish` requires stage `done`.

### Reverse transitions (feedback loops)

These are where the honest, shipped behavior matters: the tool routes on a single condition —
**APPROVE advances; everything else falls back** — it does NOT validate the verdict against the stage.

- `plan-review --finalize`: `APPROVE` → `plan_reviewed`. **Any** other value — `NEEDS REVISION`,
  `REJECT`, an unrecognized string, or a *missing* verdict — routes to `analysis` (the revise cycle).
- `review --finalize`: `APPROVE` → `done`. **Any** other value — `NEEDS WORK`, `REJECT`, an
  unrecognized string, or a *missing* verdict — routes to `running` with the execution marked
  needs-fix (the fix cycle). A missing verdict is logged as `NEEDS WORK` and still falls through, which
  is the proof that the routing is "APPROVE vs not-APPROVE", not strict validation.
- `revise --finalize` → `planned` (back into plan-review).
- `fix --finalize` → `review` (back into review).
- `replan` → `analysis` (archives the current plan, starts fresh).

## Verdicts

| Verdict line in `plan.md` / `review.md` | Stage          | Effect             |
|-----------------------------------------|----------------|--------------------|
| `APPROVE`                               | plan-review    | → `plan_reviewed`  |
| `APPROVE`                               | review         | → `done`           |
| anything else (incl. missing)           | plan-review    | → `analysis`       |
| anything else (incl. missing)           | review         | → `running` (fix)  |

## Artifacts per stage

Three *distinct* things happen at each stage — keep them separate. A stage transition mutates state;
it does **not** author the substantive Markdown. The prepare step writes the prompt; the author/reviewer
writes the deliverable; the finalize step advances the stage.

Rows are organized **by command**, not by target stage — because a single command's prepare step and
finalize step land on *different* stages, and the finalize transition for review-bearing commands
*branches* on the verdict. (`new`/`replan` are listed for the entry/reset edges they own.)

| Command       | Prepare artifact (prompt) | Author / reviewer output                          | Finalize state transition (incl. fallback)                         |
|---------------|---------------------------|---------------------------------------------------|--------------------------------------------------------------------|
| `new`         | —                         | `context.md`                                       | stage → `analysis` (entry point)                                   |
| `plan`        | `.prompt-plan.md`         | `plan.md` (with a verdict line)                    | `--finalize` → `planned` (verdict not branched here)               |
| `plan-review` | `.prompt-plan-review.md`  | `review.md` (+ `audit-iter<n>.md` from the audit) | `--finalize`: `APPROVE` → `plan_reviewed`; **else → `analysis`**   |
| `run`         | `.prompt-run.md`          | `progress.md`, the diff produced                   | prepare → `running`; `--finalize` → **`review`**                   |
| `review`      | `.prompt-review.md`       | `review.md`, the diff captured for review          | `--finalize`: `APPROVE` → `done`; **else → `running`** (fix cycle) |
| `revise`      | `.prompt-revise.md`       | revised `plan.md`                                  | `--finalize` → `planned` (back into plan-review)                   |
| `fix`         | `.prompt-fix.md`          | revised diff, updated `progress.md`                | `--finalize` → **`review`** (back into review)                     |
| `replan`      | —                         | (archives the plan)                                | → `analysis` (reset)                                               |

Reading note: a stage advance is a *state* change. It never creates `plan.md` / `review.md` — those are
authored by an engine in the middle column, then `--finalize` parses the verdict and moves the stage.
Two finalize transitions are easy to get backwards and are the load-bearing corrections here: `run
--finalize` advances to **`review`** (not `running` — `running` is the *prepare*-stage state), and
`review --finalize` advances to **`done`** on APPROVE but falls back to **`running`** on anything else.
`plan-review --finalize` likewise falls back to **`analysis`** (the revise cycle) on a non-APPROVE
verdict. Verified against `taskctl/cli.mjs`: plan-finalize → `planned` (`state.stage = 'planned'`);
plan-review-finalize → `plan_reviewed` | `analysis`; run prepare → `running`, run-finalize → `review`;
review-finalize → `done` | `running`; revise-finalize → `planned`; fix-finalize → `review`.

## Lifecycle commands

The first task-entry command is **`new <slug>`** — it authors `context.md` + the task state with the
local tracker, no external issue tracker required. Other lifecycle commands:

| Command          | Purpose                                                          |
|------------------|-----------------------------------------------------------------|
| `new <slug>`     | Create a task (local tracker) — the default entry point         |
| `refresh`        | Re-sync context from the tracker without changing the stage     |
| `resume`         | Generate a re-entry summary after a break                       |
| `handoff`        | Snapshot state before pausing / handing off                     |
| `replan`         | Archive the plan, return to `analysis` for fresh planning       |
| `create-followup`| Create a child task linked to a parent                          |
| `deps`           | Show the dependency graph (read-only)                           |
| `sync`           | Tracker-adapter entry point — **Jira-gated** (see notes)        |

## Honest notes (shipped behavior)

- **Jira-only command gate.** `sync`, `jira-sync`, `refresh`, `autopilot`, and `publish` are rejected
  *before* any tracker client is constructed when the configured tracker is not Jira. In a local
  project, `sync` prints a pointer to `new <slug>` instead.
- **The PR reference is a literal fallback, not adapter-gated.** When `review` runs, it unconditionally
  reads `context.md`, matches a literal `PR-<n>` token, and calls `gh pr view <n>` to resolve the
  branch and PR URL. This runs regardless of tracker. The local default tracker has no label step, so
  there is simply nothing to match unless a `PR-<n>` token is present in the context.
- **The integration branch is configurable.** The diff base and worktree base come from the configured
  integration branch (default `dev`, overridable), and the PR target defaults to it (also overridable).
  Use *your* configured branch names; the defaults are just defaults.
- **Use your strongest available planning model** for architecture- and discovery-heavy tasks, require
  a cross-model plan review, and execute step-by-step with manual diff checkpoints.

> **Direction (not yet implemented).** A tracker-adapter generalization — so a non-Jira adapter could
> record a PR reference and the PR-resolution step would read it generically rather than scanning for a
> literal `PR-<n>` — is a desirable future direction. It is **not** current behavior; today the
> resolution is the literal scan described above.
