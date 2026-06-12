# Quickstart — `taskctl new-project` (entry mode 2: start from a bare idea)

`new-project` turns an idea into a **self-contained orchestration workspace**:

> idea → brainstorm (one pass) → proposal (alternatives) → **print-only**
> scaffold → initial backlog → **self-attach**.

The new project directory gets its OWN `taskctl.config.json` (`repoPath: "."`),
its own `ai/tasks/` backlog, and a seeded `ai/templates/`. The orchestration
workspace you ran the command from is **byte-unchanged EXCEPT the
exclusively-owned `ai/newproject/<target-id>/` flow directory** (the flow record
+ the transient brainstorm/proposal/scaffold artifacts).

If you already have a repo, use [quickstart-attach.md](./quickstart-attach.md)
instead.

## Prerequisites

- At least one engine is **registered AND runnable** (`config.engines.planner`;
  default `claude`). The flow probes the engine before any scaffolding write and
  fails early with a clear message if none is available. claude/codex are the
  reference engines; a single-vendor fallback (`planner:"claude",
  reviewer:"claude"`) works.
- `git` on PATH (you'll `git init` the target during the scaffold step).

## The flow is RESUMABLE and human-paced

`new-project` runs in steps and **pauses** at the points where a human is in the
loop. Re-invoke the SAME command (same `--dir`) to continue from where it
stopped. You don't pass a "step" — taskctl reads the flow record and resumes.

```sh
# 1. Kick it off. The brainstorm runs, then PAUSES for you to review/edit.
taskctl new-project "a habit-tracking PWA for runners" --dir ./runner-habits

#    → it writes ai/newproject/<id>/brainstorm.md and stops.
#    Open brainstorm.md, ANSWER the open questions inline, save.

# 2. Re-invoke. Proposal runs; you pick an option; the scaffold PLAN is printed.
taskctl new-project "a habit-tracking PWA for runners" --dir ./runner-habits

#    → it writes proposal.md, asks you to choose (or pass --yes to take the
#      recommended option), then writes scaffold-plan.md and stops.
#    scaffold-plan.md contains the EXACT commands to run — taskctl NEVER runs them.

# 3. Run the printed scaffold commands YOURSELF in the target, then `git init`.
cd ./runner-habits
npm create vite@latest . -- --template react-ts   # (whatever scaffold-plan.md printed)
git init
cd -

# 4. Re-invoke. It detects the git work tree, generates the backlog under the
#    target, seeds ai/templates, and self-attaches.
taskctl new-project "a habit-tracking PWA for runners" --dir ./runner-habits

#    → it prints the next steps.

# 5. Work the project — discovery makes `taskctl` inside the new dir drive it.
cd ./runner-habits
taskctl plan runner-habits-01-<first-task>
```

### Why `cd ./runner-habits; taskctl plan ...` works

taskctl **discovers the workspace root** from your current directory: it walks up
to the nearest ancestor with a `taskctl.config.json`. Inside the generated
project that's the project's own config, so commands run there drive the new
project — not the install.

## Flags

- `--dir <path>` — the target directory (default `./<slug-of-idea>`).
- `--yes` — non-interactive: auto-pick the proposal's recommended option (CI).
- `--engine <name>` — override the planner engine for the engine-driven steps.
- `--restart` — archive the current flow (into
  `ai/newproject/<target-id>/archive-<ts>/`) and start fresh from brainstorm.
  **It never deletes the target** — your scaffolded code AND any
  already-generated backlog tasks stay. A half-done restart self-recovers on the
  next invocation. See **Restart, collisions, and your edits** below for how the
  fresh run treats existing backlog directories.

## Notes that match the actual behavior

- **The scaffold is print-only.** There is no `--run-scaffold`. taskctl prints
  the native-generator commands; you run them. (Gated/structured execution is a
  deferred follow-up.)
- **Brainstorm is one structured pass.** You answer by editing `brainstorm.md`
  and re-invoking — the re-invoke loop is the dialog. A multi-turn engine
  conversation is deferred.
- **Artifacts are English.** `brainstorm.md` / `proposal.md` / `scaffold-plan.md`
  and the generated task `context.md` files are always written in English, even
  if your prompt pack language is set to something else (the language pack
  changes the prompt phrasing, not the artifact language).
- **Refusals:** a non-empty target on the FIRST run is refused (pick an empty dir
  or a new path); a `--dir` that is, contains, or sits inside the orchestration
  workspace is refused.

## Restart, collisions, and your edits

`new-project` **never overwrites or deletes** a directory it did not just create.
This matters most around `--restart` and the generated backlog:

- **Existing backlog tasks are preserved.** On a fresh run (including after
  `--restart`), a backlog task directory under `<TARGET>/ai/tasks/<slug>/` that is
  a byte-exact, unmodified copy of what this flow previously generated is **adopted
  as-is** (treated as already published) — it is not regenerated.
- **Collisions and your edits HALT the flow.** If a backlog task directory already
  exists but does **not** match what the flow would publish — because you **edited
  a generated `context.md`/`state.json`**, added a file, or because an unrelated
  directory happens to share the name — the flow **stops with a clear error naming
  the directory** and writes nothing there. Your edits are left **exactly** as you
  made them. This is why re-running `--restart` on an already-completed project
  stops at the backlog step: the regenerated tasks no longer match the originals
  on disk, so the flow refuses to touch them.
- **Manual resolution.** When the flow halts on a collision, decide deliberately:
  move or remove the directory yourself (e.g. `mv ai/tasks/<slug> ai/tasks/<slug>.bak`
  or delete it once you've saved anything you want), then re-invoke. taskctl will
  never make that destructive choice for you.
- **Abandoned temporaries are flow-owned.** While publishing, the flow builds each
  task in a temp directory named `.tmp-<targetId>-<lockToken>-<slug>` and only ever
  cleans up temps that carry **its own** ownership marker. A scratch directory of
  yours such as `.tmp-notes` (or even `.tmp-<slug>` without the flow marker) is left
  untouched.

## Stuck-lock recovery

Each flow holds a single lock file `ai/newproject/<target-id>/flow.lock` for the
duration of an invocation. If a `new-project` process was killed and its process
id happens to be reused by an unrelated process, the lock can read as "still
running" and wedge re-invocation.

There is **no `--break-lock`** in this release. If you are sure no `new-project`
is running for that target, delete the lock file by hand:

```sh
rm ai/newproject/<target-id>/flow.lock
```

Then re-invoke — the flow resumes from the last recorded step (a half-done
`--restart` self-recovers via the sweep).
