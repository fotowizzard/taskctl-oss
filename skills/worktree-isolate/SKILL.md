---
name: worktree-isolate
description: One task equals one worktree cut from a freshly fetched origin base; halt if origin freshness can't be proven. Activates before starting work on a task, when creating a branch or worktree, and when wiring dependencies into a fresh worktree.
allowed-tools: Bash
---

# Worktree-isolate

One task, one worktree, cut from a freshly fetched `origin/<base>`. A stale local base produces a wrong diff — so prove freshness or halt. Wire dependencies by junction, not reinstall.

## Contract

Each task gets its own git worktree, cut from a **freshly fetched** `origin/<base>` (the configured integration branch). A stale local base yields a wrong PR diff, so freshness is a precondition: if it cannot be proven, **halt** rather than silently branch from a local ref. Dependencies are linked from the main checkout via junction/symlink, never reinstalled per worktree.

## When to trigger

- You are about to start work on a task and need an isolated branch.
- You are about to create a worktree or a feature branch off the integration branch.
- The new worktree needs dependencies (`node_modules` or equivalent) to build/test.
- You are offline or cannot reach the remote — decide deliberately, do not auto-fall-back.

## Protocol

1. `git fetch origin <integration-branch>` first — never branch off the local ref untested.
2. Verify the freshly-fetched base resolves: `git rev-parse --verify origin/<integration-branch>`. If it does NOT resolve (offline / no remote-tracking ref), **halt and confirm freshness** before proceeding — do not silently use the local base.
3. Create the branch from the verified `origin/<integration-branch>`, then `git worktree add <dir> <branch>`.
4. Link dependencies from the main checkout into the worktree by junction/symlink (no `npm ci` / reinstall).
5. Stage from inside the worktree only — never `git add -A` at the repository root (it can leak a gitlink for the worktree itself).

## Anti-patterns

- Branching off a stale local base instead of a freshly fetched `origin/<base>`.
- Accepting a silent fallback to the local base when the remote ref can't be verified — confirm freshness instead. (The shipped CLI falls back silently; this skill is deliberately stricter and treats that fallback as a risk to confirm, not a default.)
- `git add -A` at the repo root (gitlink leak).
- Reinstalling dependencies per worktree instead of junctioning them.

## Worked micro-example

```
git fetch origin dev
git rev-parse --verify origin/dev      # resolves → safe to branch
git branch feat/<task-id> origin/dev
git worktree add ../.worktrees/<task-id> feat/<task-id>
# link deps instead of reinstalling:
#   junction/symlink <main>/node_modules → <worktree>/node_modules
```

If `rev-parse --verify origin/dev` fails, the procedure stops here and asks for confirmation — it does not fall through to the local `dev`.
