---
name: branch-guard
description: Hooks, not vigilance — block direct commits/pushes to protected branches, and assert the PR base is the configured target. Activates before any commit or push (protected-branch guard) and immediately after a PR is created (PR-base guard, because a CLI can silently ignore --base).
allowed-tools: Bash
---

# Branch-guard

Hooks, not vigilance. A guard blocks direct commits/pushes to protected branches *before* they happen, and a second guard asserts the PR base *after* the PR opens — because a CLI can silently ignore `--base`.

## Contract

Protection is enforced by hooks, not by remembering. (§A) A pre-action guard blocks direct commits/pushes to protected branches and fires **before** the commit/push. (§B) A PR-base guard asserts the PR base equals the configured PR-target branch and fires **after** the PR is created — and because a CLI can silently ignore `--base`, the base is re-read after the PR opens; on a mismatch it **reports and stops**, requiring explicit authorization before any retarget (`gh pr edit` is an outward action).

## When to trigger

- §A — before any `git commit` or `git push` that could land on a protected branch (the configured integration branch and any other protected names).
- §B — immediately after a PR is created, before treating it as correct.
- You just passed `--base` to a PR-create command — verify it was actually honored.
- You are about to rely on discipline ("I'll just remember not to commit to the integration branch") instead of a hook.

## Protocol

### §A Protected-branch guard (fires before commit/push)
1. A pre-action hook intercepts `git commit` / `git push` and reads the current/target branch.
2. If it is in the protected set (the configured integration branch + any others), the hook **blocks** the action and points at the worktree + feature-branch + PR flow.
3. Never bypass a secret scanner or this guard with `--no-verify` without manually verifying the underlying finding first.

### §B PR-base guard (fires after PR creation)
1. On PR creation, assert the base == the configured PR-target branch.
2. Re-read the base **after** the PR opens — do not trust that `--base` was honored.
3. If the base is wrong, **detect and report it** — surface the mismatch (actual vs. expected) and STOP.
   `gh pr edit --base` is an outward state-mutating action: **require explicit authorization** before
   retargeting. Do not auto-correct the live PR.

## Anti-patterns

- Relying on vigilance instead of a hook to stay off a protected branch.
- Trusting that `--base` was honored without re-reading the opened PR's base.
- Loading only §A and missing the §B postcondition (or vice versa).
- `--no-verify` to get past the guard or a secret scanner without verifying the finding.

## Worked micro-example

```
# §A — a PreToolUse-style guard, before the action:
on git commit|push:
  if target_branch in PROTECTED: block → "use worktree + feature branch + PR"

# §B — after the PR opens (DETECT + REPORT; do NOT auto-edit):
gh pr create --base <pr-target> ...
actual=$(gh pr view <n> --json baseRefName -q .baseRefName)
if [ "$actual" != "<pr-target>" ]; then
  echo "PR #<n> base is '$actual', expected '<pr-target>' — CLI ignored --base. STOP."
  # gh pr edit <n> --base <pr-target>   # outward action: run ONLY after explicit human OK
fi
```

The near-miss this guards against: a PR-create CLI silently ignored `--base` and opened against the
wrong branch — caught only because §B re-read the base instead of trusting the flag. The guard
*reports* the mismatch; retargeting the live PR is an outward action that waits for explicit
authorization (it is never auto-applied).
