# Limitations & deliberate exceptions

This page is the public companion to the internal extraction ledger. It states,
for an outside reader, what is intentionally present, what is not yet supported,
and which environment variables exist. Read it alongside the
[roadmap](plans/ROADMAP.md).

## Status (read this first)

- **Pre-alpha.** There is no installable release. The tool has been dogfooded
  only on this repository's own extraction; it has not been used by third
  parties.
- **Windows-first.** Developed and tested on Windows 11. The CLI tool-detection
  probe chain and path handling are Windows-first. POSIX (macOS/Linux) is
  *expected* to work but is **UNTESTED** — bug reports are welcome.

## Deliberate exceptions (intentionally present)

These are not oversights; they are kept on purpose:

- **The GRACE methodology name and attribution.** The words `GRACE` / `grace`,
  the module `taskctl/grace.mjs`, the `grace.enabled` config flag, and the
  attribution to its author (osovv) appear by design. GRACE is a public upstream
  methodology that the optional governance module integrates with (it wraps, it
  does not vendor — see [NOTICE](../NOTICE)).
- **Non-English prompt text.** The CLI can emit prompts in more than one
  language. The bundled non-English prompt pack (`taskctl/prompts/ru.mjs`) ships
  intentionally so installs that prefer that language work out of the box; the
  default prompt language is English (`promptLanguage: "en"`).
- **GRACE governance-artifact filenames.** When the optional GRACE integration is
  enabled, it references a small set of governance XML artifact filenames. These
  appear only as part of that opt-in integration, never as a required default.

## Environment variables

taskctl reads configuration from `taskctl.config.json` and, optionally, from a
`.env` file (see [`.env.example`](../.env.example)). The variables it recognises:

| Variable | Purpose | Notes |
|----------|---------|-------|
| `REPO_PATH` | Absolute path to the repository under orchestration | Optional; `taskctl.config.json` `repoPath` is the primary mechanism. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | Jira tracker credentials | Optional. Only needed when the tracker is `jira`; the default tracker is `local`. |
| `GRACE_REPO_ROOT` | Root of the governed repository for the optional GRACE integration | **Primary** name. Read only when GRACE is enabled. |
| `VP_REPO_ROOT` | Legacy alias for `GRACE_REPO_ROOT` | **Deprecated** — silently honoured for back-compat, not advertised in `.env.example`. Prefer `GRACE_REPO_ROOT`. |

Engine API keys are **not** read from taskctl's environment — taskctl shells out
to your installed coding-agent CLIs, and each engine is configured through its
own CLI.

## Known limitations

- **No installable release.** Clone-and-run only; the public packaging step is
  gated behind the owner's review.
- **Tracker backends.** The tracker abstraction ships with `local` (default) and
  `jira`. No other backends exist yet.
- **`--auto` has no orchestrator audit between iterations.** The unattended
  `--auto` loop is opt-in and runs author → reviewer → fix without the
  human-or-orchestrator verification step that the default human-gated flow
  applies to every finding. Use it knowing that trade-off; the lived workflow is
  single-stage and human-gated.
- **Cross-platform.** As above — Windows-tested, POSIX untested. Worktree
  `node_modules` reuse uses a junction on Windows and is expected to use a
  symlink on POSIX.
