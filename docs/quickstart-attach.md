# Quickstart — `taskctl attach` (entry mode 1: I already have a repo)

`attach` profiles an EXISTING git repository read-only and writes a
`taskctl.config.json` into your orchestration workspace (the **sidecar**). For a
foreign target repo it never writes into the target — the profiler only reads it,
and a config destination resolving inside the target is rejected. **The one
documented exception is *self-attach***: when the target IS the orchestration
workspace itself (`configRoot === target`), the config intentionally lands inside
it, and `--force` may replace an existing one (details in the "Self-attach" section
below). Later code changes always go through the worktree + PR flow, never a
direct write from `attach`.

Use this when you already have a codebase and want taskctl to drive tasks
against it. If you are starting from a bare idea instead, see
[quickstart-new-project.md](./quickstart-new-project.md).

## Prerequisites

- The target is a **git work tree** (`git init` has been run, or it's a clone).
- You are running `taskctl` from an **orchestration workspace** — any directory
  that already has (or will receive) the sidecar `taskctl.config.json`. taskctl
  discovers this workspace by walking up from your current directory to the
  nearest ancestor that contains a `taskctl.config.json`; with none found it
  falls back to the install directory.

## Steps

```sh
# 1. Profile the repo and write the sidecar config.
taskctl attach /path/to/your/repo

#    Review the printed "Project Understanding" (detected branches, etc.).
#    The config lands at <orchestration-workspace>/taskctl.config.json.

# 2. Create your first task (local, no Jira) and start planning.
taskctl new my-first-task --title "Wire up X"
taskctl plan my-first-task

#    or just inspect state:
taskctl status
```

### Flags

- `--force` — overwrite an existing `taskctl.config.json` (the existing file is
  left intact unless you pass this). `attach` is the tolerant bootstrap: it runs
  even when the current config is malformed, which is exactly what `--force`
  exists to repair.
- `--deep` — **reserved** for a future LLM-enrichment tier. It is currently
  rejected with a clear message (no silent no-op).

## Where the config lands (the containment rule)

The sidecar config is written **OUTSIDE** the target you profile — the profiler
is strictly read-only on the target. The one sanctioned exception is
**self-attach**: when the target IS the orchestration workspace itself
(`configRoot === target`), the config is written at that root. That self-attach
path is exactly what `new-project` uses for the self-contained workspace it
creates (`repoPath: "."`).

If you point `--configRoot` (or run from a cwd) such that the config would land
*inside* the target, `attach` refuses — the config must live in a separate
orchestration workspace.

## Next steps

- If the defaults don't fit, edit `taskctl.config.json`:
  - `engines.{planner,reviewer}` — default `claude` / `codex`. A single-vendor
    setup (`planner:"claude", reviewer:"claude"`) is expressible and supported.
  - `branches.integration` — default `dev` (the worktree base + review diff base).
- Run `taskctl --help` for the full command surface.
