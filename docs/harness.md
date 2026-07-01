# The harness layer — `taskctl init-harness`

`taskctl` (the engine) turns an idea or a repo into an orchestrated workspace. The **harness layer** is
the project-facing scaffold that sits on top of the engine and makes a workspace *operable by an agent*:
the operating contract, onboarding, a session-state monitor, a GRACE skeleton, and the task playbook.

`taskctl init-harness` materializes that layer into the current workspace from `templates/harness/`.

## Why it exists

Multiple orchestration sidecars built on this base each rebuilt the same harness by hand — same
skeleton, ~100% different content. The lesson: the reusable artifact is **templates + a generic core**,
not copied files. `init-harness` captures that so the next project is one command, not a day of
copy-paste.

## The three classes

| Class | Ships as | Rendered? | Examples |
|---|---|---|---|
| **Engine** | `taskctl/` | — | cli.mjs, config.mjs, the lifecycle |
| **Generic (Class-A)** | `templates/harness/**` (verbatim) | No — reads `taskctl.config.json` + `.env` at RUNTIME | `ops/session-state.sh`, `grace/check-freshness.sh` |
| **Template scaffold** | `templates/harness/**.tmpl` | Yes — `{{PLACEHOLDER}}` filled, `TODO:` left for the human | `CLAUDE.md.tmpl`, `SETUP.md.tmpl`, onboarding, playbook, bootstrap |

Generic files carry **no** per-project value — they resolve everything at runtime, so they ship byte-for-byte
and stay correct across projects. Template scaffolds carry a shared skeleton (the generic role/discipline/
methodology, which is the reusable value) plus two kinds of project-specific spans:

- **Mechanical** → a `{{PLACEHOLDER}}` filled by the renderer. The vocabulary is fixed (see below).
- **Prose** (domain description, current-state snapshot, guardrails, doc-map) → a literal `TODO:` marker
  the human fills after materializing.

## Placeholder vocabulary

`init-harness` resolves exactly these keys (from `taskctl.config.json` + `.env` + the target's git remote),
and the renderer **asserts no `{{...}}` is left unfilled**, so a template may use ONLY these:

`{{PROJECT}}` `{{PROJECT_SLUG}}` `{{TARGET_REPO}}` `{{TRACKER}}` `{{JIRA_KEY}}`
`{{INTEGRATION_BRANCH}}` `{{PR_TARGET}}` `{{GRACE_ENABLED}}` `{{GRACE_PILOT}}`

Anything else project-specific is a `TODO:` marker, never a new token.

## Where it fits (two entry modes)

- **Existing repo** → `taskctl attach <repo>` (read-only profile → `taskctl.config.json`) → **`taskctl init-harness`**.
- **Greenfield** → `taskctl new-project "<idea>"` (scaffolds + self-attaches); run `init-harness` after.

## Safety

`init-harness` **never overwrites**. A dest that is byte-identical to the template is skipped; a dest that
DIFFERS is **kept** (reported, untouched); only ABSENT files are written. So it is idempotent — re-run any
time, and your edits to `CLAUDE.md` (etc.) are never clobbered. `--dry-run` prints the plan without writing.

## Extending the harness

1. Add a file under `templates/harness/` — a `*.tmpl` (rendered) or a verbatim file.
2. Add one entry to `HARNESS_MANIFEST` in `taskctl/harness.mjs` (`{ kind, src, dest }`).
3. Templates may use only the 9 placeholders above (+ `TODO:` prose). `taskctl/__tests__/harness.test.mjs`
   renders the whole manifest and fails on any leftover placeholder.

## After materializing

Fill the `TODO:` markers in the rendered files (start with `CLAUDE.md` §3/§7 and `SETUP.md` §1), author the
GRACE graph if you use it, then restart your agent so `CLAUDE.md` + `/bootstrap` load automatically.
