---
name: empirical-first
description: Ground-truth the real state before locking it into a plan — live API / schema / repo state beats docs beats inference. Activates before planning against any assumed schema or interface, and before acting on a reported state like "it's broken" or "it's merged".
allowed-tools: Bash, Read
---

# Empirical-first

Ground-truth before planning. Live state beats documentation beats inference. Verify a *reported* state before acting on it.

## Contract

Before locking any assumption into a plan, ground-truth it against reality: live API / schema / repo state is the primary source, documentation is secondary, remembered or inferred state is last. A *reported* state ("it's broken", "it's merged", "the default is X") is a claim to verify, not a fact to act on.

## When to trigger

- You are about to plan against a schema, interface, config default, or data shape from memory or docs.
- Someone reports a state — broken, fixed, merged, deployed — and you are about to act on it.
- A doc and the code could disagree, and the plan depends on which is right.
- You catch yourself writing "it should be X" instead of "I checked, it is X".

## Protocol

1. Identify every assumption the plan rests on (schema field, default value, branch state, whether a thing exists).
2. For each, pick the strongest available source: query the live API / read the actual schema / run a read-only repo or VCS command. Fall back to docs only when live state is unavailable, and say so.
3. Diff the ground truth against the assumption. If they disagree, the ground truth wins and the plan changes.
4. For a *reported* state, reproduce or inspect it directly before acting — check the history, dates, or a three-way diff rather than trusting the report.
5. Record what you checked and what you found, so the plan is evidence-backed, not asserted.

## Anti-patterns

- Planning off a remembered schema or a doc that may be stale.
- Acting on "it's broken" / "it's merged" without reproducing or inspecting it.
- Answering "I don't know" when the fact is one read-only query away — investigate instead of punting.
- Treating documentation as ground truth when the code is right there to read.

## Worked micro-example

A plan assumes a config default is `6`. Before writing it down, read the source that sets it:

```
default in code: --max-iterations N   (default: 3)
plan assumed:    6
```

The assumption was wrong by inheritance from an older doc. The plan is corrected to `3` and cites the line it read, instead of repeating the stale figure.
