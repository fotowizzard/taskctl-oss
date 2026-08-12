# P2 — Engine launch safety: launch-value refusal

**Row:** P2, `[design]`, issues #5 and #22.
**Date:** 2026-08-12. Written against `work/p2-launch-safety`, based on `d716a94`.
**Status of the note:** required by the plan for a `[design]` row. D6 names P2 as one of the two
rows outside the design-note gate's scope, so nothing enforces this file's existence; it is
written as a matter of practice and its absence would have failed nothing.

This note covers the problem, the containment chosen and why, each route class and how it is
covered, what is **not** covered, the self-audit answers, and the exact commands run with their
real results.

**Round 2** answered two blocking review findings and changed the shape of the containment, so the
sections below are not uniformly round-1 text: §2.5 (the space regression and the routes that had to
be converted before it could be fixed), §2.6 (the artifact-injection sink), §5.1 (the round-2
self-audit, including one test that turned out to prove less than it claimed) and §6.1a / §6.5 /
§6.6 (the round-2 runs and controls) are new. §2.1, §3, §4 and §7 were revised where round 1 had
said something that is no longer true.

---

## 1. The problem, verified rather than restated

The plan's P2 section enumerates seven configuration keys plus one environment variable reaching
twenty-one destination sites. I did not take that on trust for the value the issue was filed for.
Against the code at `d716a94`, in a throwaway workspace whose `taskctl.config.json` carried
`engines.reasoningEffort: "medium; touch /tmp/pwned"`, `taskctl plan demo` **exited 0** and
printed:

```
Launch codex:
  codex --full-auto -s danger-full-access -c model_reasoning_effort=medium; touch /tmp/pwned -C "…"
  > Read …/.prompt-plan.md and follow the instructions
```

That is the whole defect in one line. The tool did not execute it — it composed it from a
committed configuration file and told a person to paste it into their own shell, where `;` ends
the codex command and starts a second one. The precondition is "run this tool in a repository you
did not write", which is the situation the onboarding flow exists to invite.

The same value also reaches `child_process.spawn(cmd, args, { shell: true })`, where Node joins
the argv array into a single command string. There, too, it is syntax rather than an argument.

---

## 2. The containment

### 2.1 Shape

A new module, `taskctl/launch-safety.mjs`, exporting one check —
`assertLaunchValue(value, { key, where, site })` — and one walker over the resolved runtime
config, `assertLaunchConfig(runtimeConfig, configPath)`. The check **throws**
(`LaunchValueError`); it does not warn and it has no `skipped` outcome. There is no state in
which continuing is safe: continuing means running the injected text.

The rule is three parts, each with its own message:

| Rule | Refuses | Why it is separate |
|---|---|---|
| allow-list | anything outside `\p{L}`, `\p{N}`, and `. _ - : / \` — **plus the space, for path-shaped keys only** (see §2.5) | shell syntax, argument splitting, control characters |
| edge whitespace | a path-shaped value that begins or ends with whitespace | added in round 2 with the space. A space is meaningful inside a path and is a typo at either end; Windows strips a trailing space in some path APIs and keeps it in others, so a padded value can pass an existence check and then address a different directory |
| leading `-` | a value whose first character is `-` | several sinks spawn with `shell: false`; there the exposure is argv **position**, not syntax. A rule about shell characters admits `--repo` |
| trailing `\` | a value whose last character is `\` | on a POSIX shell it escapes the closing quote of a double-quoted argv element and swallows the rest of the line. `cmd.exe` does not, so leaving this to the developer's platform would be a silent asymmetry |

**Why letters and digits in any script are admitted.** Every shell metacharacter is ASCII
punctuation or whitespace. Admitting `\p{L}\p{N}` refuses nothing dangerous, and refusing them
would reject an install under a home directory named in a non-Latin script for no security
benefit.

**The space was refused in round 1, and that was wrong.** Round 1 refused it everywhere and
recorded the cost as a finding rather than fixing it. The reasoning was that `grace.repoRoot`
reached `grace lint --path` **unquoted** under `shell: true`, so a space there really did split one
argument into two — and that a uniform rule was the only kind the escape policy supported.

Both halves were wrong in the same way. `C:/Users/First Last/repo` and `C:/Program Files/…` are
ordinary Windows paths; refusing them means the tool does not start, and "the tool refuses to run"
is not an improvement on "the tool runs". And the unquoted sink was not a fact about spaces — it
was a fact about that spawn, which could be changed. Round 2 changed it. §2.5 is the whole of what
that took and what it did not reach.

### 2.2 Where the check runs, and why there

**The primary gate is at config resolution, not at the sinks.** The argument is about provenance,
and it is the load-bearing decision in this note.

At a sink, a string is just a string. `spawnAI` receives `repoPath`, and on one path that is the
configured repo and on another it is the new-project flow directory under the install root
(`runEngineStep` passes the flow dir as both `cwd` and `repoPath`). A check placed there either
refuses ordinary installs whose path contains a space, or waves the configured value through.
There is no third option, because by the time the value is a function parameter its origin has
been erased.

At `config.mjs` the origin is still known. That file is the only place in the repository that
reads `taskctl.config.json` and `REPO_PATH` into a value. So the gate sits there, in two calls:

- **`loadTaskctlConfig`** clears the resolved `repoPath`. It is checked here as well as in
  normalization because this object is reachable **without** normalization: `init-harness`
  dispatches on it before the runtime config is built, and hands the value to
  `harness.readGitRemote`, which puts it in a `git -C <value>` argv element. The refusal names
  whichever layer supplied the value — environment outranks the file, and pointing a reader at
  `taskctl.config.json` for a value that came from `REPO_PATH` sends them to edit a file that does
  not contain it.
- **`normalizeRuntimeConfig`** clears the whole resolved object, as the last thing it does before
  returning.

**The walk is structural, not a list of names.** `assertLaunchConfig` walks the returned object.
Every string leaf is checked unless its dotted path appears in `NON_LAUNCH_KEYS`, a seven-entry
table where each entry states where the value goes *instead* of a command line. The inversion is
the point: a key added to `normalizeRuntimeConfig`'s return next year is checked with no edit to
the checker, and the only way to have one skipped is to name it and write down why. This, and not
the plan's table, is what makes the containment survive the enumeration's own stated blind spot
that "it sees one commit".

The arithmetic closes against the plan's population of 18 leaf paths:

```
11 string leaves checked   repoPath, tracker.type, promptLanguage,
                           branches.{integration,prTarget},
                           engines.{planner,reviewer,reasoningEffort},
                           grace.{repoRoot,pilotBranch,upstreamBranch}
 1 boolean skipped by type grace.enabled  (a boolean cannot carry syntax)
 6 declared exclusions     projectContext, constraints, codeAreas,
                           previewUrlTemplate, tracker.assigneeEmail, configPath
                                                              11 + 1 + 6 = 18  ✓
`raw` is held out exactly as the plan holds it out of its own population: it is the
object the other 18 are computed from, not a nineteenth value. §4 states the cost.
```

All eight members the plan found reaching a sink are inside the checked set: the seven leaf paths
above, plus `REPO_PATH` at `loadTaskctlConfig`.

**Validation runs after composition.** `grace.repoRoot` arrives at the walk with the config
file's own directory already resolved into it by `resolveMaybeRelative`. A validator on
`raw.grace.repoRoot` would pass a config whose `repoRoot` field is spotless and still let the
resolved prefix reach `grace lint --path` unquoted. There is a test for exactly that, with a
fixture directory that contains a space.

### 2.3 The second layer, at four sinks

Four call sites re-assert. Each covers a value whose provenance is unambiguous *there*, and each
exists because the site is reachable without the primary gate having run:

| Site | Value | Why here as well |
|---|---|---|
| `cli.mjs buildLaunchCommand` | `repoPath`, `reasoningEffort` | the one builder all eight printed launches share; it is exported, so an options bag can reach it without passing through `normalizeRuntimeConfig`, and `launchCmd` reads `process.env.REPO_PATH` directly |
| `automation.mjs spawnAI` | `reasoningEffort` | the last point at which refusing still means nothing ran |
| `grace.mjs runGraceGate` **and** `runGraceLintOnce` | `grace.repoRoot` | round 1's worst sink (unquoted under a shell); round 2 made it `shell: false`, and the check stays because shell syntax was never the only exposure — a repoRoot beginning with `-` is read by grace as an option. Placed at the gate's entry *as well as* at the spawn because the gate short-circuits to `skipped-no-repo` when the path does not exist — and a path with an injected fragment almost never exists, so a check only at the spawn would report an injection attempt as a benign skip |
| `harness.mjs readGitRemote` | `repoPath` | sink 9, `shell: false`. Placed **outside** the function's catch: that catch exists to make a missing remote a best-effort `null`, and swallowing a refusal into the same `null` would turn "this config is injecting an argument" into "no remote found" |

Two of these deliberately do **not** check everything they could. `buildLaunchCommand` does not
check `cwd`, `orchestrationDir` or `prompt`; `spawnAI` does not check `repoPath` or `cwd`. Those
are install-derived on at least one live path, so a check there would refuse an ordinary install
rather than an injection. §4 records this.

### 2.4 Alternatives rejected

- **Warn instead of throw.** A warning is printed either just before or just after the injected
  text runs. Rejected on plan principles 2 and 10.
- **Validate at each of the twenty-one sinks.** That is a fix scoped to what one search found, and
  it fails on provenance (§2.2): most sinks cannot tell a configured value from an install path.
- **Validate the raw config file wholesale.** Rejected twice over: it checks the wrong value
  (before composition — see the `grace.repoRoot` case), and it would reject the free prose that
  legitimately lives in `projectContext` / `constraints`.
- **Escape or quote instead of refusing.** Correct *escaping* differs between `cmd.exe` and POSIX —
  `\"` is an escaped quote to one and a quote-terminator to the other — so a generic escaper emits a
  different command to each. Refusal remains the containment. Round 2 added **quoting on top of the
  refusal** for the printed commands, which is a different thing and only works because the refusal
  has already narrowed the alphabet to characters the two shells agree about (§2.5). Quoting is not
  a substitute for the check; it is what the check makes safe.
- **A per-value opt-out for a legitimate rejected identifier.** Refused by the plan's escape
  policy, and the message says so rather than implying a workaround exists.

### 2.5 Round 2 — the space regression, and the routes that had to change first

Two blocking findings came back on round 1. This section is the answer to the first; §2.6 is the
answer to the second.

**The rule that replaced the ban.** The space is admitted **per key**, not globally, and a key
earns it only when *every* route that key's value travels has been shown to carry a space without
changing what runs. `launch-safety.mjs` holds this as `SPACE_PERMITTED_KEYS`, a table whose entries
are the route accounting itself rather than a conclusion:

| Key | Space admitted | Routes |
|---|---|---|
| `repoPath`, `REPO_PATH` | yes | out-of-band `cwd:`; `git -C` argv; `git worktree add\|remove` argv; double-quoted in the engine spawn and the printed commands |
| `grace.repoRoot` | yes | `grace lint --path` argv; out-of-band `cwd:` on the python and git gates |
| `engines.reasoningEffort` | **no** | reaches `-c model_reasoning_effort=<v>`, which is **unquoted** even inside the double-quoted engine spawn |
| `engines.planner`, `engines.reviewer` | **no** | these are the executable *name* — the command, not an argument to it |
| `branches.*`, `grace.pilotBranch`, `grace.upstreamBranch` | **no** | git ref names, which git itself forbids spaces in, so there is no regression to fix |
| `tracker.type`, `promptLanguage` | **no** | reach no command line at all today |

The per-key split is what the round-2 direction asked for and is *not* the "safe on one route,
refused on another" failure it warned against — that would be the same key admitted at one sink and
refused at another. Here a key is admitted or refused everywhere, and the keys differ because their
route sets differ.

**Which routes lost `shell: true` / stopped being command strings.**

| Route | Was | Now | Why it could change |
|---|---|---|---|
| `grace.mjs` `grace lint --path <v>` | `spawnSync(..., { shell: true })`, value **unquoted** | `shell: false` | the shell was only ever doing executable *resolution* — the module's own comment says so. Resolution is what the existing `buildGraceSpawnEnv` PATH augmentation is for, and libuv searches the **child's** PATH, so `grace` → `grace.exe` resolves with no shell |
| `cli.mjs` `ensureWorktree` (5 git calls) | `execSync` command **strings** | `execFileSync` argv | `git` is a real `git.exe` on Windows, so it spawns directly |
| `cli.mjs` `removeWorktree` | `execSync` command string | `execFileSync` argv | same |
| `cli.mjs` `runGit` | `spawnSync(..., { shell: true })` | `shell: false` | the stated reason for the shell was "consistency with the rest of this module" — consistency with the thing being removed |
| `cli.mjs` Jira summary | `execSync('claude -p <json>')` | `spawnSync` argv + **stdin** | §2.6 |

**Which routes kept `shell: true`, and why they genuinely could not change.** Recorded in
`launch-safety.mjs` as `DOUBLE_QUOTED_SHELL_ROUTES` so it is a named constant rather than a comment
that drifts:

1. **The engine spawn** (`automation.mjs`). npm installs `claude` and `codex` on Windows as a
   `.cmd` shim, not an executable. Node 22 **refuses** to spawn a `.cmd` without a shell — measured
   on this machine, not assumed: `spawnSync('claude.cmd', …, {shell:false})` returns `EINVAL`, and
   the bare name returns `ENOENT`. This is CVE-2024-27980's fix, and it means "spawn the engine
   with `shell: false`" is not a thing that can be written on Windows. `git` and `gh` are real
   `.exe`s, which is exactly why those converted and this one did not.
2. **The printed operator and launch commands.** Nothing of ours executes them; a person pastes
   them into a shell we do not choose and cannot see. There is no argv API for a string somebody
   else will run.

**What makes a space safe on those two anyway — the printed-command decision.** The round-2
direction required a choice between emitting a shell-specific serialization and changing the output
form so no unquoted configured value is embedded. The choice taken is neither exactly: **restrict
the alphabet until the two shell families agree, then double-quote and escape nothing.**

The justification is a claim about an intersection, and it is checkable. Every one of these routes
embeds the value inside `"…"`. cmd.exe and POSIX shells disagree about a great deal inside double
quotes — `%VAR%` vs `$VAR`, `` ` ``, whether `\"` is an escape — but they agree completely about the
space: it is literal inside `"…"` on both. And every character they disagree about,

```
"   $   `   %   !   ^   &   |   ;   <   >   (   )   '   ~   *   ?   newline   tab
```

is outside the admitted class and refused before it can reach any of this. So a shell-specific
serialization is unnecessary, and *escaping* is actively avoided: `\"` is an escaped quote to a
POSIX shell and a quote-terminator to cmd.exe, so any code that emitted one would be emitting a
different command to each. `quoteForPastedCommand()` therefore re-asserts the value and wraps it,
and does nothing else.

**This is a weaker guarantee than argv, and the note says which way.** An argument vector is safe
because of the operating system. These two routes are safe because of an argument about an
alphabet — an argument that stops holding the moment somebody widens the class, or emits one of
these values without its surrounding quotes. Neither failure is visible from the call site. That is
the residual cost of the two routes that could not be converted, and it is recorded rather than
rounded off.

Two printed commands were **bare** and are now quoted: `taskctl publish … --repo-path <v>`
(`automation.mjs`) and `taskctl review … --repo-path <v>` (`cli.mjs`). Those were straightforwardly
broken for any repo path with a space, independently of any injection concern.

**One fix outside the configured-value population, because the story would otherwise have a hole in
it.** `grace.mjs`'s python gate retries through a shell with `spawnSync('python', [scriptPath], …)`,
and `scriptPath` is under `os.tmpdir()` — which on Windows sits inside the user's profile and
therefore contains a space whenever the account name does. It is now quoted on the shell retry and
left bare on the argv attempt. Install-derived, not configured, but claiming "a path with a space
works now" while leaving that would be false for exactly the user the claim is aimed at.

### 2.6 Round 2 — the artifact-injection sink (`cli.mjs`)

The second blocking finding. `cli.mjs` built the Jira comment with:

```js
execSync(`claude -p ${JSON.stringify(summaryPrompt)} --verbose`, …)
```

`summaryPrompt` is assembled from `plan.md`, `progress.md` and `review.md`, so it is text a person
or an engine wrote into an artifact. `JSON.stringify` is **JSON** quoting: it escapes `"` and `\`
and nothing else, and the string it produces is then handed to a shell. Both shell families are
exploitable, by different mechanisms:

- **POSIX** — a backtick or `$(…)` inside double quotes is command substitution, which JSON
  escaping does not touch at all.
- **cmd.exe** — worse, because cmd.exe does not recognise `\"` as an escaped quote. JSON's own
  escaping **closes** the quoted section, and everything after it (`&`, `|`, `>`) is command syntax.

The fix is not better quoting. `generateJiraSummary()` puts the artifact text on the child's
**stdin** and leaves argv as three constants (`claude`, `-p`, `--verbose`). There is no
serialization to get right because there is no serialization. It tries `shell: false` first and
falls back to the shell only for the `.cmd`-shim case above — and that fallback is safe for the
reason the original was not: the command line has no value interpolated into it at all.

It returns `null` on every failure path rather than throwing, because `cmdPublish` falls back to a
`progress.md` extraction and a publish must not fail because a summary could not be generated.

**One behavioural dependency I could not execute, stated because it is the weak point of this
change.** Moving the prompt from argv to stdin assumes `claude -p` reads a piped prompt from stdin
— documented behaviour (`cat file | claude -p`) and the reason the change is possible at all, but I
did not verify it by running the real CLI: doing so costs a live model call, and the tests
deliberately use a stand-in so they need nothing installed. What the tests *do* establish is the
invocation shape and that the artifact text is not parsed by anything. If the assumption is wrong,
the failure mode is benign and already handled: `generateJiraSummary` returns `null` and the Jira
comment falls back to the `progress.md` extraction, which is exactly what happened before whenever
the call failed. It would be a worse summary, not a broken publish, and never an injection.

**What this does and does not say about the containment.** It repairs *one* artifact-sourced sink.
It is not a claim about the population. Stated precisely, and this is the distinction the round-2
direction asked to be made explicit:

- **Claimed:** *no configured or pinned value reaches argv unvalidated.* Round 1 established this
  and round 2 does not weaken it.
- **Not claimed:** *no value reaches a shell unvalidated.* That is false for artifact-sourced and
  CLI-sourced values, which were never this deliverable's population and were not audited. One sink
  of that class is now fixed; the rest are §4.2.

---

## 3. Route classes and how each is covered

| Route class | Sinks | Covered by | Test |
|---|---|---|---|
| argv under `shell: true` | 1, 7, 8 | config gate; `spawnAI`. **Sink 8 (grace lint) is no longer in this class — round 2 made it `shell: false`** | *route (argv, shell:true)* — asserts the refusal **and** that no child process was created; *route (shell:true, double-quoted)* — runs a pre-quoted element through a real shell and checks what the child received, with the bare form as its sensitivity control |
| command strings through `execSync` | 2, 3, 4, 5 | config gate (`repoPath`, `branches.integration`). **Sinks 2–3 (worktree add/remove) left this class in round 2** | *route (execSync command string)* — end-to-end, asserts nothing printed and no review prompt composed |
| printed engine launches | 10–17 | config gate; `buildLaunchCommand` | *route (printed engine launch)* — end-to-end, asserts stdout is empty; and *a spaced repoPath produces a launch string that pastes correctly*, which parses the printed argument back through a real shell |
| printed operator commands | 18–21 | config gate; `quoteForPastedCommand` at the two bare sites | *route (printed operator command)* — a different call site from the launch builder, so an implementation that guards only the builder fails here; and the spaced-path paste test, which has its own unquoted sensitivity control |
| argv injection, `shell: false` | 6, 9 | config gate (leading-dash rule); `readGitRemote` | *member: a leading "-" in branches.prTarget*; *route (argv, shell:false — git remote get-url)* |
| **argv, no shell (round 2)** | 2, 3, 8 | the conversion itself — there is no word-splitting left to contain | *route (grace lint)* — records the spawn and asserts the path is one element and `shell === false`; *route (git worktree)* — creates and removes a real worktree under a real spaced directory |

Two things about how these are asserted, because both were wrong on the first attempt and passing
for the wrong reason:

**The channel matters.** The refusal message quotes the rejected value and describes the
destination site, so it legitimately contains both the injected fragment and strings like
`model_reasoning_effort`. An assertion over `stdout + stderr` is satisfied by the refusal's own
text. The tests assert over `r.stdout` — the channel `console.log` prints commands on — and
require it to be **empty**; the refusal is asserted separately on `r.stderr`.

**Every route test carries a positive control in the same test body.** "No command was printed"
is also true of a command that was broken for an unrelated reason. So each hostile run is followed
by the same command with the legitimate value, asserting the launch line / operator command /
review prompt *is* produced. For the spawn test the control is the fake adapter's `record` array:
empty proves `buildSpawn` never ran, and the following legitimate call pushes exactly one entry
and writes the replay artifact.

**A task is seeded before the hostile config is planted.** `taskctl new` resolves the config too,
so a workspace born hostile cannot be seeded at all, and the printed-command tests would have
passed without ever reaching the printing code.

---

## 4. What is not covered

Stated as scope, not as caveats.

1. **`shell: true` remains on two routes.** Round 2 removed it from four (§2.5) and kept it on the
   engine spawn and the printed commands, where it could not be removed. On those two, a configured
   value is contained by an argument about an alphabet rather than by the operating system, and any
   *other* string reaching those command lines is not contained at all. This still must not be
   described as closed.
2. **CLI arguments and task artifacts.** `--repo-path` and `state.json`'s `worktreePath` travel the
   same routes. Blind spot 2 in the plan; this does not close it, and **"no value reaches a shell
   unvalidated" is not true and is not asserted anywhere.** Round 2 repaired exactly one sink of
   this class — the `claude -p` Jira summary (§2.6) — because it was the same defect class on the
   same path as the configured-value work. That is one sink, not an audit of the population. Two of
   the sink-side checks — `runGraceGate` and `readGitRemote` — happen to see some artifact-sourced
   values, because their parameter is a path regardless of who supplied it. That is a side effect
   and is not claimed as coverage.
3. **Install-derived paths that reach argv.** `orchestrationDir` (`claude --add-dir "<root>"`) and
   the per-task directory (`codex -C "<dir>"`) are interpolated into both the spawn and the printed
   launch. The plan explicitly holds `orchestrationDir` out of the population. They are still not
   checked, but round 2 changed the *reason*: it is no longer "a check would refuse installs under a
   directory with a space", since the space is now admitted for path keys. It is that the admitted
   alphabet is narrower than what a legitimate install path may contain — `C:\Program Files (x86)\…`
   has parentheses in it — and the install root is not a value an attacker supplies. Refusing it
   would be the space regression again in a different costume. The exposure is real; it is out of
   P2's scope and is named in `docs/limitations.md`.
4. **Values read out of `raw` by a computed key.** The walk covers the resolved object. A code path
   that reaches into `tcfg.raw` with a dynamically-built key is invisible to it. This is the
   plan's blind spot 1, which the plan itself does not close. The one *current* `raw` consumer that
   reaches a destination site — `cmdInitHarness` → `readGitRemote` — consumes `tcfg.repoPath`, not
   `raw`, and `tcfg.repoPath` is checked at `loadTaskctlConfig`.
5. **Environment variables never named in `config.mjs`.** The plan's fourth blind spot. I checked
   the two the documentation advertises: `GRACE_REPO_ROOT` and its legacy alias `VP_REPO_ROOT` are
   read only at `context-builder.mjs:38-41`, and the only consumer is
   `loadGovernedModules(repoRoot)`, which **reads files** — it composes no argv and no command
   string. So these two reach no destination site. That is a result for those two names and not a
   claim about the class: `loadEnvOnly` puts arbitrary `.env` keys into `process.env`, and a
   variable read only at some future call site would still be outside the population.
6. **`--engine` and the engine registry.** Already covered by an existing registry allow-list
   (`assertEngineRegistered`); not touched.
7. **Non-argv uses of configured values.** `cwd` is not argv and no shell parses it; the plan
   excludes it and so does this.

---

## 5. Self-audit

**Is there a route in the enumeration I did not cover, and can I name it?**
Of the twenty-one destination sites, all are reached by at least one of the eight members, and all
eight members are checked at the config gate — so every site is covered *for the configured
values that reach it*. Sites 2 and 3 (`git worktree add/remove`) additionally carry a slug- and
branch-derived segment which is **not** covered; the plan says so and I have not changed that.
Site 5's `run` helper in publish also carries a commit subject built from `plan.md` — artifact
provenance, uncovered, and already guarded by a different mechanism (`sanitizeForTitle`) whose
adequacy I did not assess because it is outside this diff.

**Is there a route the enumeration itself could not see, and does my containment cover it?**
Yes, and partly. The enumeration cannot see a value read out of `raw` by a computed key
(§4.4) — my containment does **not** cover that, and I chose not to extend the walk over `raw`
because doing so would reject the free prose in `projectContext`/`constraints` and would check the
pre-composition value that the plan explicitly says is the wrong one. What my containment *does*
cover, which the enumeration could not, is a key added to the runtime-config surface after the
enumeration was written: the walk is structural, so a new key is checked by default. There is a
test for that (*fail-closed: a key the site table has never heard of*), and its refusal message
says the destination is unclassified rather than inventing one.

**Does any test of mine pass for a reason other than the one it claims?**
Three did on the first run, and all three were caught and fixed rather than accommodated:

- The three end-to-end route tests asserted the injected fragment was absent from `stdout+stderr`.
  They failed — because the *refusal message* quotes the rejected value and names the site, which
  includes the literal `model_reasoning_effort` and `git diff`. Had I written the assertion the
  other way round (looking only for the fragment's absence from combined output on the *fixed*
  build) it would have passed while proving nothing. Fixed by asserting per channel.
- The execSync route test would have passed on a task in the wrong stage: `cmdReview` refuses on
  its stage check before composing any diff, so both the hostile and the clean run would have
  printed nothing. Fixed by moving the task to a reviewable state and adding a positive control
  that asserts the clean run *does* write the review prompt.
- Two rule tests used fixtures (`--repo=evil`, `--upload-pack=touch /tmp/pwned`) that contain a
  metacharacter as well as a leading dash, so they passed on the *character* rule while claiming
  to test the *position* rule. Fixed to `--repo` and `--git-dir`, whose every character is on the
  allow-list, so only the position rule can refuse them.

One class remains where a test asserts something weaker than its title suggests, and I would
rather name it than let a reviewer find it. The printed-command tests refuse at config load, which
is *upstream* of the printing code. They prove "with this configuration, no command is printed" —
which is the acceptance criterion — but they do not prove the printing code itself is individually
guarded. For the engine-launch route, `buildLaunchCommand` *is* individually guarded and separately
tested; for the operator-command route (sinks 18–21) it is not, and coverage there rests on the
config gate alone.

### 5.1 Round-2 self-audit

**Is there a route carrying a configured value that I made space-permissive without making it
safe?**

The space was admitted for three keys — `repoPath`, `REPO_PATH`, `grace.repoRoot` — so this is a
question about those three and nothing else. I enumerated their routes twice: once by grepping for
every command string and argv element that interpolates any of them or a value derived from one
(`workDir`, `wtDir`, `repoRoot`, `graceRoot`), and once by an independent read-only audit that was
given the safe/unsafe classification and asked only for unsafe findings. The routes and their
classification are the `SPACE_PERMITTED_KEYS` table in §2.5.

Two things that turned up and were fixed rather than argued away: the two bare printed
`--repo-path` hints (§2.5), and the python gate's `scriptPath` under a spaced `os.tmpdir()`. One
that was *not* a route and is worth naming because it looks like one: `cwd:` appears everywhere
these values do, and it is never parsed by anything.

The honest residual is the one in §2.5's last paragraph: on the two routes that kept `shell: true`,
"safe" rests on the value being double-quoted *at that site*. I verified that empirically rather
than by reading — a pre-quoted element through a real `shell: true` spawn returns
`C:/Users/First Last/repo` intact, and the same value bare returns `C:/Users/First` — but the
property lives in `engines.mjs`, not in the checker, and nothing mechanically enforces it.

**Does any test of mine pass for a reason other than the one it claims?**

One did, I measured it, and the finding changed what the test claims rather than the test.

*route (git worktree)* creates and removes a real worktree under a real spaced directory, and I
had written it as evidence for the string→argv conversion. It is not. I reverted `ensureWorktree`
to the original `execSync(\`git worktree add "<dir>" <branch>\`)` and re-ran: **40/40, still
green**. The old form was already quoted, so a space never broke it. What made a spaced `repoPath`
fail end to end was the round-1 *rule* refusing it at config resolution — and that is the
resolution test, not this one. The test comment now says so explicitly and calls itself a
regression guard on the converted form. The conversion is still worth making, for the reason the
round-2 direction gave: correctness there no longer depends on someone remembering the quotes.

Two more that could have passed vacuously and were built so they cannot:

- The artifact-injection test's payload is platform-specific in both halves (cmd.exe needs a quote
  break-out, POSIX needs a backtick). "No marker file appeared" would be equally consistent with a
  working fix and with a payload that was inert on the platform. So there is a **separate
  sensitivity test** that asserts the payload *does* execute under the old form, and it is written
  to say "fix the payload, do not delete the test" if it ever stops firing.
- The spaced-path paste tests would pass for a path that happened to contain no space. Each carries
  an in-test control that runs the *unquoted* form through the same shell and asserts it does
  **not** survive.

**Have I demonstrated the sensitivity of every check I cite as evidence?**

Yes, by reverting one thing at a time against the finished tree and recording real counts (§6.5).
Four controls, because the round-2 claims have four independent causes and a single stash would not
have separated them: the rule (A), the worktree sink (B), the summary call (C), and the grace-lint
spawn (D). Control B is the one that returned a negative result, and §5.1 above is what I did with
it.

I also re-verified the round-1 negative control's premise rather than restating it, since the
orchestrator's first attempt at it was vacuous: `git stash push -- <tracked files>` refuses when the
pathspec names the untracked new module, so the tests ran against unmodified code. Redone by
reverting only the tracked wiring and keeping the module, it reproduces 14 pass / 18 fail. Round 2's
controls are all of the "revert one thing in the finished tree" shape for exactly this reason —
there is no stash to get wrong.

**Have I demonstrated the sensitivity of every check I cite as evidence, against a known-broken
build?**
Yes, and the demonstration is in §6.3. I stashed the five source modifications, leaving the new
`launch-safety.mjs` and the new test file in place, and re-ran the new test file: **14 pass / 18
fail**. The 18 that fail are exactly the containment tests. The 14 that pass are the seven
pure-rule/message tests, the four no-regression tests, and the three fail-closed tests — and they
pass *because they exercise the new module directly*, which is present in the broken build. That
is not a defect in them, but it does mean **those 14 are not evidence that the wiring works**, and
I am not citing them as such. The full-suite counts in §6.1 are cited only for "nothing else
broke", which is what they can show.

---

## 6. Verification — exact commands and real results

All runs from `taskctl/`, Node v22.14.0, Windows 11.

### 6.1 The full suite, five times, after the fix

```
$ node --test __tests__/*.test.mjs
# tests 371 · pass 371 · fail 0 · duration_ms 117211.6346   run A — code + tests
# tests 371 · pass 371 · fail 0 · duration_ms 124595.8310   run B — + README / limitations
# tests 371 · pass 371 · fail 0 · duration_ms 116928.1207   run C — + this design note
# tests 371 · pass 371 · fail 0 · duration_ms 106902.0426   run D — + a grace.mjs tidy-up
# tests 371 · pass 371 · fail 0 · duration_ms 120941.2052   run E — final tree
```

Five rather than two because the tree kept changing and the suite's Markdown scrub gate scans
**every** `.md` in the repository, so the documentation and this note are themselves inputs to it.
Each run is labelled with what it actually covered. **Run E covered the final state of all code,
tests and documentation.** Stating the exception rather than rounding it off: the only edits made
after run E are inside this section — the line recording run E's own result, and this paragraph.
The only test that reads this file is the Markdown scrub gate, which matches a fixed list of
origin literals and identifier patterns; neither edit introduces one.

Baseline before any change, same command, same machine: **339 pass / 0 fail**,
`duration_ms 96518.3936`. 371 − 339 = 32, the new file's test count. No existing test was
modified.

The suite is recorded elsewhere in the plan as intermittently failing (§10 item 7 / P1). It was
green on all six runs here, baseline included; that is six observations at this commit and not a
claim that the intermittency is gone. Issue #21, the diagnosed contributor, is fixed on this
branch's base (`c9498fc`), which is the likeliest reason. The `session.log` failure the plan
records as uncharacterised did not reproduce here, which is one more observation of an
intermittent failure not firing — not a diagnosis of it.

An earlier intermediate run surfaced two real failures, both fixed rather than worked around:
the repository's Cyrillic scrub gate (`T2b-int-grep`) caught a non-Latin example in a comment in
`launch-safety.mjs`, and my own test file had a syntax error. Reporting them because a clean
sequence of green runs would misrepresent how this went.

### 6.1a Round 2 — the full suite after the round-2 changes

```
$ node --test __tests__/*.test.mjs        # from taskctl/
# tests 379 · pass 379 · fail 0 · duration_ms 145544   run 1 — code + tests
# tests 379 · pass 379 · fail 0                        run 2 — repeat, unchanged tree
# tests 381 · pass 381 · fail 0 · duration_ms 104469   run 3 — + the last 2 tests
# tests 381 · pass 381 · fail 0 · duration_ms 108273   run A — + README + limitations + this note
# tests 381 · pass 381 · fail 0 · duration_ms 102536   run B — repeat of A, unchanged tree
# tests 381 · pass 381 · fail 0 · duration_ms 110587   run C — final code (quoteForPastedCommand null guard)
# tests 381 · pass 381 · fail 0 · duration_ms  78082   run D — repeat of C, unchanged tree
# tests 381 · pass 381 · fail 0 · duration_ms 104015   run E — + the §2.6 / §6 additions to this note
# tests 381 · pass 381 · fail 0 · duration_ms 108075   run F — repeat of E, unchanged tree
```

371 → 381 is ten new tests, all in `launch-safety.test.mjs` (32 → 42). **No pre-existing test was
modified.** Runs E and F are the two required runs on the finished tree; the earlier ones are
recorded because the tree kept changing and reporting only the final pair would misrepresent that.
Six rather than two for the same reason round 1 needed five: the suite's Markdown scrub gate scans
**every** `.md` in the repository, so this note is itself an input to it.

Before those, an intermediate run against the round-2 code produced **367 pass / 4 fail**. All four
were in `launch-safety.test.mjs`, and all four were the tests asserting the round-1 space ban —
the ones §2.5 inverts. No pre-existing test failed at any point in round 2.

Stating the exception rather than rounding it off, as in §6.1: **run F covered the final state of
all code, tests and documentation.** The only edits made after it are inside this code block and
the paragraph above. The one test that reads this file is the Markdown scrub gate, which matches a
fixed list of origin literals and identifier patterns; neither edit introduces one.

### 6.2 The new file alone

```
$ node --test __tests__/launch-safety.test.mjs
# tests 42 · pass 42 · fail 0        (round 2; was 32 · 32 · 0 in round 1)
```

### 6.3 Negative control — the same tests against the unfixed build

```
$ git stash push -- automation.mjs cli.mjs config.mjs grace.mjs harness.mjs
$ node --test __tests__/launch-safety.test.mjs
# tests 32 · pass 14 · fail 18
$ git stash pop
```

The 18 failures are tests 8–25: the eight enumerated members, the environment route, the
space-only control, the leading-dash member, the resolved-value control, and all six route-class
tests. The remaining 14 are analysed in §5.

**A correction to how this control must be run**, because the first attempt to reproduce it was
vacuous. `git stash push -- <pathspec>` **refuses** when the pathspec names an untracked file, so a
command that also lists `launch-safety.mjs` stashes nothing, the tests run against unmodified code,
and the result is a meaningless green. The control is only valid when the *tracked wiring* is
reverted and the new module is **kept** — which is the form written above, and which reproduces
14 / 18. Every round-2 control below avoids the failure mode entirely by editing the finished tree
in place and restoring it.

### 6.4 Negative control — the defect itself, before and after

Same throwaway workspace, same hostile `taskctl.config.json`
(`engines.reasoningEffort: "medium; touch /tmp/pwned"`), same command.

**Before** (`git stash` applied, i.e. the code as it ships today) — `taskctl plan demo` exits
**0** and prints to **stdout**:

```
  codex --full-auto -s danger-full-access -c model_reasoning_effort=medium; touch /tmp/pwned -C "…"
```

**After** — the same command exits **1**, prints **nothing at all on stdout**, and prints to
stderr:

```
Error: refusing to launch — engines.reasoningEffort contains a character that is not allowed in a launch value.

  key:       engines.reasoningEffort
  set in:    …\taskctl.config.json
  value:     "medium; touch /tmp/pwned"
  rejected:  ";" (U+003B)
  reaches:   the engine spawn (shell:true, as `-c model_reasoning_effort=<value>`) and the printed engine launch command
  …
```

followed by the escape route: use an equivalent identifier the rule accepts if one exists,
otherwise open an issue against the check; widening the allow-list and per-value opt-outs are
refused.

### 6.5 Round-2 negative controls — one cause reverted at a time

Each control edits the finished tree, runs `node --test __tests__/launch-safety.test.mjs`, and is
restored immediately. Real counts, all from the same tree:

| # | What was reverted | Result | What it proves |
|---|---|---|---|
| A | the space removed from `LAUNCH_PATH_CHAR` (the round-1 blanket ban) | **35 pass / 5 fail** | the five space tests are sensitive to the **rule**: the two member tests, the resolution test, the printed-operator paste test, and the grace-lint argv test |
| B | `ensureWorktree`'s `git worktree add` back to the quoted `execSync` command string | **40 pass / 0 fail** | **negative result.** The worktree test is *not* sensitive to the sink conversion — the old form was already quoted. Recorded in §5.1; the test's own comment now says so |
| C | `generateJiraSummary` back to `spawn(\`claude -p ${JSON.stringify(p)} --verbose\`)` | **39 pass / 1 fail** | the artifact-injection test is sensitive to the **call shape**, and fails on the argv assertion |
| D | grace lint's spawn back to `shell: true` | **39 pass / 1 fail** | the grace-lint test is sensitive to the **spawn**, independently of the rule (control A moves the same test for a different reason) |

Two further sensitivity demonstrations live *inside* the tests rather than as controls, because
they have to run on whatever platform the suite runs on:

- *artifact injection (SENSITIVITY)* runs the payload through `execSync` with `JSON.stringify`
  quoting — the exact old form — and asserts the marker file **is** created. On this machine it
  fires via the cmd.exe quote break-out. Without it, the fix test's "no marker appeared" would prove
  nothing.
- the two paste tests run the *unquoted* form through a real shell and assert it does **not**
  survive the round trip.

And the claim underpinning the two routes that kept `shell: true`, measured rather than reasoned:

```
$ node -e '…spawnSync("node",["-p","process.argv[1]", <arg>],{shell:true})…'
shell:true + pre-quoted  -> "C:/Users/First Last/repo"   match: true
shell:true + BARE        -> "C:/Users/First"             match: false
shell:true unquoted flag -> ""                           (a space in `-c k=v` breaks it)
```

The third line is why `engines.reasoningEffort` did **not** get the space.

### 6.6 The independent route audit

The §5.1 question "is there a route I made space-permissive without making it safe" was also put to
a separate read-only audit, given the safe/unsafe classification and asked only for unsafe findings
across every `.mjs` under `taskctl/`. It returned **no unsafe findings**, agreeing with my own grep.

Recording one inaccuracy in it rather than quoting it as clean: it reported that `engines.mjs`'s
printed launch commands "use `quoteForPastedCommand()`". They do not — `engines.mjs` hardcodes the
`"…"` wrapping in `buildLaunchString`, and only the two `--repo-path` operator hints call
`quoteForPastedCommand`. The conclusion (double-quoted, therefore space-safe) is the same either
way, but the mechanism is not, and the difference matters: the hardcoded quotes are the unenforced
property §5.1 names as the residual risk.

---

## 7. Other defects noticed and deliberately not fixed

Kept out of this diff to keep it scoped to launch safety.

- **`taskctl/grace.mjs`'s hard-coded developer home directory** as the fallback for the
  `~/.bun/bin` PATH augmentation when `USERPROFILE`/`HOME` is unset. The literals are not reproduced
  here for the same reason they should not be in the source. It reaches the child's `PATH`, not
  argv, so it is not a launch-value issue. **Now tracked as issue #25** and deliberately left there
  rather than folded into this diff.
- ~~**`cli.mjs:2101`** interpolates task-artifact text into `claude -p <json> --verbose`~~ —
  **fixed in round 2**, see §2.6. It was judged in scope on review: the same defect class, on the
  same path, and leaving it would have shipped a fix whose neighbour was still open. Its provenance
  is still artifact rather than configured, so it changes §4.2's contents but not §4.2's claim.
- **`docs/limitations.md` advertises `GRACE_REPO_ROOT` and `VP_REPO_ROOT`** as recognised
  environment variables, but neither is read by `config.mjs` — they are read at
  `context-builder.mjs:38-41`. The documentation is accurate; the point is that the plan's
  Source-B population, derived from `config.mjs` alone, would not have found them. It cost nothing
  to check them (§4.5) and they turned out to reach no sink.

## Self-review: APPROVE
