# Roadmap — taskctl (working title)

> Status: **pre-alpha, not published, not usable by others yet.** This repository
> extracts a generic, embeddable AI-development *orchestration discipline* (and its CLI,
> `taskctl`) from a private single-project workspace. Until WP6 everything here is
> internal WIP. The private origin workspace is the **read-only**
> source of truth for extraction and is never modified by work done here.

## What this is

A CLI + methodology that orchestrates a disciplined, multi-model software-development
lifecycle on top of existing coding agents (e.g. Claude Code + Codex CLI). Its
differentiators, validated by mining ~95 real tasks in the source workspace:

- **Cross-vendor adversarial review** — one engine plans/implements, a *different* engine
  reviews. The moat: no single vendor builds this, because it pits two providers against
  each other.
- **Orchestrator-verify** — a reviewer verdict is *input, not authority*; every
  Critical/Important finding is independently re-read against the cited code before any
  fix. Catches reviewer hallucinations and real bugs the reviewer missed.
- **Empirical-first** — ground-truth live APIs / DB / schema before planning.
  Live API > docs > inference.
- **Human-gated single-stage lifecycle** — `analysis → planned → plan_reviewed → running
  → review → done`, advanced one inspected stage at a time. (Unattended `--auto` exists
  but is opt-in; the lived workflow is human-gated.)
- **Git isolation** — per-task worktree from `origin/<base>`, protected-branch guard,
  PR-only.
- **Codebase comprehension layer** — agents get a structured understanding of the target
  repo *before* planning: a lightweight auto-profiler by default, with an optional curated
  contract layer (GRACE-style) for large/critical repos.

## Who it's for

Two first-class entry modes:

1. **Attach** to any existing repo, non-invasively — all orchestration state lives in a
   sidecar; the target repo is only *read*, and only ever changed via worktree + PR.
2. **New project from an idea** — brainstorm → stack proposal → scaffold → backlog.

Consumers: humans running the CLI, and agents loading the methodology as skills.

## Hard constraints

- **Fresh git history.** Never carry the upstream workspace's history (it is saturated
  with secrets / PII). This repo started from `git init`, file-copy only.
- **No secrets / PII, ever.** No `.env`, no `.tmp`, no per-task tracker/client data, no
  credentials. WP6 runs a full scrub audit before any remote / push.
- **Decouple before publish.** The copied `taskctl/` still contains source-of-origin
  identifiers (repo path, Supabase project IDs, assignee email, Russian prompt text).
  These are scrubbed in WP2. No public push until WP6.
- **Upstream is read-only.** The private origin workspace is never modified by this project.
- **No remote / no push / no PR without explicit owner OK.** Local commits only until then.

## Scope = full, executed in phases

"Fully" means all tiers (CLI + profiler + skills + methodology + attach + new-from-idea),
sequenced so each phase is independently shippable and the early phases also de-risk the
later ones. Each work package runs through the lifecycle discipline (analysis → plan →
plan-review → implement → review); artifacts live in `ai/tasks/WPx-*/`. From WP1 onward
the project increasingly **dogfoods** its own CLI.

| WP | Deliverable | Status |
|----|-------------|--------|
| **WP0** | Workspace bootstrap: separate folder, fresh git, skeleton, copied `taskctl/` source + templates, this roadmap, `.gitignore`, README; experience-mining analysis captured to `docs/analysis/`. | done |
| **WP1** | Config + local task source. `taskctl.config.json` schema + loader; Jira made optional behind a `tracker` abstraction with a `local` default; `taskctl new <slug>` authors `context.md` without a tracker. Unblocks dogfooding the cycle on this very repo. | done |
| **WP2** | Decouple from the origin project. Lift GRACE into an optional, off-by-default module; externalize repoPath / branches / engines into config; scrub origin literals (backend project IDs, paths, assignee, prompt language); drop a one-off helper script. | done |
| **WP3** | Comprehension layer / profiler (attach). Read-only analyzer derives stack, branches, structure, build/test commands → generates per-project config. Lightweight default + opt-in curated (contract) tier. `taskctl attach <repo>`. | done |
| **WP4** | Skills catalog + methodology docs. Tier-1 skills as real files (orchestrator-verify, cross-model-review, empirical-first, review-loop-autopilot, worktree-isolate, branch-guard / pr-base-guard); generalize port-ready docs (task-lifecycle, flipped-flow) + write the cross-model-review rationale. | done |
| **WP5** | New-from-idea + onboarding. `taskctl new-project "<idea>"` (brainstorm → stack → scaffold); engine adapter abstraction (claude / codex pluggable); attach / new quickstarts. | done |
| **WP6** | Public-ready. Full secret/PII scrub audit (gitleaks + manual grep), README/LICENSE (MIT) + GRACE attribution / NOTICE, `.env.example`, cross-platform notes — then, **only with explicit owner OK**, create remote + first public push. | done |

## Reference (from experience-mining of the source workspace)

These capture the analysis that this roadmap is built on; added during WP0 so the plan is
self-contained and not dependent on chat history:

- `docs/analysis/experience-report.md` — how the system was actually used (usage profile,
  friction patterns, what the data corrected). *(to be added in WP0)*
- `docs/analysis/coupling-map.md` — every origin-specific hardcode → its generic
  replacement (the decoupling spec for WP2). *(to be added in WP0)*
- `docs/analysis/skills-catalog.md` — the Tier-1 / Tier-2 skills shortlist for WP4.
  *(to be added in WP0)*

## Dogfooding note

The current `taskctl` is too coupled to its origin project to run its own cycle literally:
`sync` requires Jira, `run` cuts a worktree in the origin code repo, and `init` would even
copy a rules file that contains a plaintext admin password. So WP0–WP1 are executed by
following the lifecycle **as a discipline** (hand-authored `context.md` / `plan.md`,
cross-model review, orchestrator-verify). Once WP1 lands the config + local task source,
later WPs run the decoupled CLI on this repo itself — the first real proof that the generic
tool works away from its origin.
