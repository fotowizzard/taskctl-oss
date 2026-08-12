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
  attribution to GRACE's designer (Vladimir Ivanov) and to the grace-marketplace
  repository (osovv / Aleksey Chendemerov) appear by design. GRACE is a public
  upstream methodology that the optional governance module integrates with (it
  wraps, it does not vendor — see [NOTICE](../NOTICE)).
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

## Launch-value validation: what it covers and what it does not

`taskctl.config.json` is a committed file, so running taskctl in a repository
someone else wrote means running it on someone else's configuration. Several
configured values end up in a command line: in an argv element of a spawn that
has the shell enabled, or in a command taskctl **prints for you to paste into
your own shell**. Those values are therefore validated when the config is loaded,
against a conservative allow-list (letters, digits, and `. _ - : / \`), and a
value outside it makes the command refuse rather than warn.

**Covered.** `repoPath` and the `REPO_PATH` environment variable;
`branches.integration`; `branches.prTarget`; `engines.planner`,
`engines.reviewer` and `engines.reasoningEffort`; `grace.repoRoot`,
`grace.pilotBranch` and `grace.upstreamBranch`. `grace.repoRoot` is checked
*after* a relative value has been resolved against the config file's directory,
so a metacharacter in that directory is caught too.

**Spaces in paths.** `repoPath`, `REPO_PATH` and `grace.repoRoot` accept a space,
so `C:\Users\First Last\repo` works. The other values do not, because they reach
a position where a space would change what runs — and because git forbids spaces
in branch names anyway, so there is nothing to allow. The space is allowed
*inside* a path, not at either end.

**Precisely what is claimed:** *no configured or pinned value reaches a command
line unvalidated.* The qualifier is doing real work — see the next list.

**Not covered, and stated rather than implied:**

- **The shell is still there, on two routes.** The engine spawn runs with the
  shell enabled, because npm installs `claude` and `codex` on Windows as `.cmd`
  shims and Node refuses to spawn one without a shell. The commands taskctl
  prints for you to paste are run by a shell of your choosing, which no API of
  ours can reach. On both, a configured value is safe because it sits inside
  double quotes and the allow-list refuses every character the two shell families
  read differently inside quotes — which is a narrower guarantee than an argument
  vector, and it is why widening the allow-list is refused. The `git`, `gh` and
  `grace` invocations were converted to argument vectors and no longer use a
  shell at all.
- **CLI arguments and task artifacts.** A `--repo-path` argument and a worktree
  path read back out of a task's `state.json` travel the same routes and are
  outside this check. **"No value reaches a shell unvalidated" is not true** —
  only the configured ones are checked. One artifact-sourced case was fixed
  outright: the Jira comment summary used to interpolate your `plan.md`,
  `progress.md` and `review.md` text into a `claude -p …` command string, so
  prose written into an artifact could execute; that text now goes to the child
  process on stdin, where nothing parses it. That is one place repaired, not a
  guarantee about the class.
- **Install-derived paths.** The orchestration root and the per-task directory
  reach argv (`claude --add-dir "<root>"`, `codex -C "<dir>"`). They come from
  where you installed taskctl, not from configuration, and are not checked: the
  allow-list is narrower than what a real install path may contain (`C:\Program
  Files (x86)\…` has parentheses), so checking them would refuse ordinary
  installs.
- **Values read out of the raw config by a computed key.** The check walks the
  *resolved* configuration object. A future code path that reaches into the
  parsed file by a dynamically-built key would not be seen by it.

**If the rule rejects something legitimate,** the answer is not to widen it —
admitting a character the shell interprets removes the containment globally, for
every value, to admit one. Use an equivalent identifier the rule accepts if the
tool you are configuring offers one; otherwise open an issue against the check
itself, quoting the four facts the refusal prints (key, file, character,
destination). There is no per-value opt-out and no interim workaround. That
route is how the space came to be allowed in a path: every command carrying a
path was converted or shown to be safe first, and only then was the character
admitted — for those keys, not globally.

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
