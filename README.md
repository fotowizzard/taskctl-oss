# taskctl

> **Pre-alpha (`v0.1.0-prealpha`).** Dogfooded only on its own extraction — no
> third-party use yet, no package-manager release. Expect rough edges; behaviour may change.

A CLI + methodology for **disciplined, multi-model AI software development**: one engine
plans and implements, a *different* engine reviews, and an orchestrator independently
verifies every finding before acting on it. Point it at an existing repository
(non-invasively) or start a new project from a plain idea.

This tool was extracted from a private single-project workspace into a generic,
embeddable open-source CLI — with a fresh git history and no secrets carried over.
See [docs/plans/ROADMAP.md](docs/plans/ROADMAP.md) for the scope, the phased build,
and the hard constraints the extraction held to.

## Status

**Pre-alpha.** It has been *dogfooded only on its own extraction* — it has not
been used by third parties, and there is no package-manager release (clone it to
use it). Expect rough edges; treat behaviour as subject to change. See
[docs/plans/ROADMAP.md](docs/plans/ROADMAP.md) for status and
[docs/limitations.md](docs/limitations.md) for the known limitations and the
deliberate exceptions.

## Two entry modes

taskctl meets a project in one of two ways:

1. **Attach** to an existing repository, non-invasively (read-only analysis).
2. **New project from an idea** — go from a plain-language idea to a scaffolded
   project with a backlog.

### Attach to a repo

```
taskctl attach <repo-path> [--force]
```

`attach` performs a **strictly read-only** analysis of a target repository — it reads
files and runs read-only git queries, and never mutates or runs a build/test command in
the target. It detects the stack, package manager, build/test/lint commands,
default + integration branches, and code-area structure, prints a "Project Understanding"
summary, and writes a derived `taskctl.config.json` to **this orchestration workspace**
(the sidecar) — not the target. A failed/aborted attach leaves zero trace in the target.
**One documented exception — *self-attach*:** when the target IS the orchestration
workspace itself (`configRoot === target`, e.g. a workspace produced by `new-project`),
the generated config intentionally lands inside it, and `--force` may replace an existing
one. For any *foreign* repository, a write destination resolving inside the target is
rejected outright.

It refuses to clobber an existing `taskctl.config.json` without `--force`. Because
`attach` runs before any config is loaded, `attach --force` can replace a config even if
the existing one is broken.

See [docs/quickstart-attach.md](docs/quickstart-attach.md) for a walk-through.

### New project from an idea

```
taskctl new-project "<your idea in a sentence>"
```

`new-project` drives an idea to a starting point: a brainstorm to sharpen the
concept, a proposed stack, a scaffold, and an initial backlog — so the
disciplined lifecycle has something to run against from day one. See
[docs/quickstart-new-project.md](docs/quickstart-new-project.md).

## Methodology & skills

The differentiator is the *discipline*, not the automation. It ships in two consumable forms — readable
methodology for humans and loadable skills for agents.

**Methodology** (the "why", in [docs/methodology/](docs/methodology/)):

- [task-lifecycle.md](docs/methodology/task-lifecycle.md) — the stage machine, verdicts, feedback
  loops, and the artifacts each stage produces (human-gated single-stage by default).
- [cross-model-review.md](docs/methodology/cross-model-review.md) — why a *different* model reviews,
  why the reviewer is input and not authority, and the orchestrator audit that gates every mutation.
- [flipped-flow.md](docs/methodology/flipped-flow.md) — when to alternate author/reviewer, when not,
  the failure modes, and the `--auto` compatibility warning.

**Skills** (agent-loadable, in [skills/](skills/)): six `SKILL.md` files — `orchestrator-verify`,
`cross-model-review`, `empirical-first`, `review-loop-autopilot`, `worktree-isolate`, `branch-guard`.
See the [skills index](skills/README.md) for the contract-and-trigger table and how an agent loads them.

## Limitations & deliberate exceptions

[docs/limitations.md](docs/limitations.md) is the honest accounting: the current
status, the things kept on purpose (the GRACE attribution, the non-English prompt
pack), the environment variables taskctl recognises, and what is not yet
supported. Read it before relying on anything here.

## Cross-platform

Developed and tested on **Windows 11**. The CLI tool-detection probe chain
(`Get-Command` / `where`) and path handling are Windows-first. POSIX
(macOS/Linux) is *expected* to work — the code is plain Node.js — but is
**UNTESTED** there. One concrete platform difference: worktree `node_modules`
reuse uses a junction on Windows and is expected to use a symlink on POSIX.
Bug reports from other platforms are welcome.

## License & attribution

taskctl is licensed under the [MIT License](LICENSE).

The optional, off-by-default governance module integrates with (it *wraps*, it
does not vendor) the **GRACE** methodology — Graph-RAG Anchored Code Engineering
— by Vladimir Ivanov (osovv),
[github.com/osovv/grace-marketplace](https://github.com/osovv/grace-marketplace)
(MIT). See [NOTICE](NOTICE) for the full attribution and how to verify that no
upstream GRACE code is vendored here.
