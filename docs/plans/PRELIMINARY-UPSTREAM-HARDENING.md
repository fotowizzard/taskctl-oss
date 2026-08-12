# Upstream hardening plan

**Status:** not approved. This plan authorizes no code until an independent cross-model review
returns without blocking findings — **with one exception, stated here because leaving it implicit
would embargo a fix.** Issue #22 is a live defect on the engine launch path, described under P2. A
point fix for it is product work and may land at any time, exactly as issue #21 may; the plan's
approval gates the *sequence*, not the repair of a defect the sequence happened to find. A point fix
does not discharge P2, which is what makes the repair general.  
**Date:** 2026-08-12 · revision 8. This document states the plan as it now stands; the record of how
it got here — what each earlier revision said, which review finding corrected it — is kept with the
project's internal task records rather than folded into the plan.  
**Scope:** harden the orchestration core along its trust boundaries. Part of the sequence ports
mechanisms that already run in a downstream fork; part of it is new design with nothing to port.
Each deliverable says which it is.  
**Non-goal:** merge or copy the downstream fork wholesale.

**Evidence convention.** Every `path:line` in this document points inside *this* repository, at the
commit this revision was written against. The named symbol, not the line number, is the anchor —
line numbers drift. No claim in this plan rests on a file that is not in this repository. Where this
plan states a *measured* result rather than a code citation, it names the commit the measurement was
taken at and distinguishes what was observed from what would explain it.

**A claim that something does not exist is held to the same standard as a claim that it does.** A
bare negative existential looks like a structural observation and is in fact an assertion about the
whole repository, so it cannot be discharged by the absence of a citation. Three things are required
of every such claim in this document:

- **the search**, written so a reader can run it and get the same set — not a description of having
  looked;
- **its result**, in whatever detail the claim rests on;
- **what the search cannot see**, stated as part of the claim rather than as a caveat on it. A search
  over static reads does not see a value assembled at run time, and saying so is what makes the
  remaining claim usable.

Where a negative could not be reduced to a search, the sentence is rewritten so it no longer claims
exhaustiveness.

**A count is held to the same standard as a citation.** A citation can be checked by opening one line;
a number cannot be checked at all unless the reader knows what was counted. Three things are required
of every count, scope or partition in this document:

- **a defined unit** — what makes two things one thing or two, stated before the number;
- **a stated population** — the set the count ranges over, written so a reader can reproduce it, and
  wide enough that nothing appears in the result which the method could not have reached;
- **arithmetic that closes**, shown rather than asserted: the parts of a partition sum to the whole,
  and any member held out of the population is held out by a stated rule.

**Where a total cannot be made to follow from a unit, the total is deleted and the list is kept.** A
list a reader can count is worth more than a headline number they cannot check. This clause exists
because the two clauses above it are about *claims*, and a count is a claim with no line to open —
which is how a partition that did not close survived several rounds of citation checking intact.

## 1. Recommendation

Update this repository through a sequence of small, test-driven pull requests, each gated by a
prerequisite that already exists when it opens. Do not merge the downstream fork back into this
repository: the histories have diverged, this repository has its own harness work that must be
preserved, and the fork's implementation carries project, provider, repository, and model-specific
policy that must not become public product behavior.

The delivery order follows trust boundaries: nothing that can execute or persist may land before the
mechanism that bounds it. The table below is the authoritative map — one row per merged deliverable,
**in merge order**, and every row's declared dependencies appear above it.

The sections group rows by kind rather than by merge position: section 4 covers the `P` rows,
section 5 the `PR` rows, section 6 the `H` row. The two orderings disagree in exactly one place —
H1 merges before PR 8, because PR 8 is required to document H1's widened coverage and cannot do that
before it exists. Where they disagree, the table is authoritative.

| # | Deliverable | Goal it serves | Tag | Issue |
|---|---|---|---|---|
| P2 | Engine launch safety — launch-value refusal | A launch may not execute a configured string. **Remediates a live defect (#22), not a future one** — see §4 | `[design]` | #5, #22 |
| P1 | Deterministic suite, then an enforceable test gate | Make the suite's result depend on the change under review, *then* make "the suite passes" a machine-checked merge condition | `[design]` | #2 (after #21) |
| P3 | Task-state schema version | Four later PRs extend task state — PR 1, PR 3, PR 4, PR 6, named and counted in D4; define how it is read before extending it | `[design]` | #3 |
| P2b | Engine launch safety — run bounds | A launch may not hang without a verdict. Split from P2 because its defaults wait on measurement (§10 open decision 2) and the refusal must not wait with them | `[design]` | #6 |
| PR 0 | Common gate-result contract | Make every gate fail closed | `[design]` | #9 |
| PR 1 | Review-artifact integrity | Make review artifacts fresh, attributable, and reviewer-owned | `[design]` | #10 |
| PR 2 | Explicit engine/model/effort stack | Make the effective engine stack explicit, configurable, and inspectable | `[extract]` | #11 |
| PR 3 | Review lifecycle and prompt discipline | Improve review-loop memory and stage discipline | `[extract]` | #12 |
| PR 4 | Verification evidence | Add machine-verifiable build/test evidence without replacing orchestrator judgement | `[design]` | #13 |
| PR 5 | Versioned harness lifecycle | Make generated harnesses versioned and upgradeable | `[design]` | #14 |
| PR 5b | Session bootstrap diagnostics | Separate operational readiness from template versioning | `[design]` | split from #14 |
| PR 6 | Per-task governance fold lifecycle | Correct the optional governance lifecycle | `[design]` | #15 |
| PR 7 | Optional external API review adapter | Add external API reviewers behind an optional adapter boundary | `[extract]` | #16 |
| H1 | Committed-path guard — extension | Widen the existing scrub gate to unknown-origin paths and non-Markdown formats, re-derive its subject from what this repository tracks, and give it an `unknown` state | `[extract]` | #18 |
| PR 8 | Release hygiene | Make every documentation claim match merged behavior | `[docs]` | #17 |

### 1.1 What the tags mean

Every claim in this section that counts rows — "one row", "exactly one row" — is a claim about the
table immediately above and nothing wider. The table is the whole population; reading it is the
search. No claim here asserts anything about code outside a row's own specification.

- `[extract]` — a working implementation of the mechanism already exists, so the work is widening or
  relocating it rather than deciding what it should be. Risk is integration risk. Most such rows port
  from the downstream fork, with project-specific seams rewritten, plus an acceptance suite. One row
  in the table — H1 — extends a mechanism that already exists *in this repository* and ports nothing
  at all. The tag is the same in both cases because the tag records risk, and extending something
  already known to work is integration risk wherever the something lives.
- `[design]` — no implementation exists to port. The mechanism is designed here. Risk is design risk,
  and it needs a design note (problem, chosen mechanism, rejected alternatives, failure modes) under
  `docs/plans/design/`, merged as its own change before the implementation PR merges. **That
  requirement is a machine-enforced condition for every row that merges after P1 installs the gate,
  and a convention with no failure path for the two rows that merge before it — P2 and P1
  themselves.** D6 states the scope of the guarantee rather than stating a universal rule and then
  removing a case from it. The tag asserts that nothing exists to port, which is a negative
  existential: each `[design]` row discharges it in its own specification, with the search stated
  there, and no row inherits another's.
- `[docs]` — introduces no mechanism at all: it changes this repository's own documentation to match
  code that the other rows merged. It ports nothing and designs nothing, so calling it either of the
  two tags above would misrepresent its risk, and it carries no design-note requirement because
  there is no mechanism to describe. Exactly one row in the table uses this tag, and any second use
  should be read as scope that belongs in a mechanism row.

Four rows carry qualifications, and say so where they are specified:

- **PR 1** is tagged `[design]` for its load-bearing mechanism — run-identity freshness and artifact
  binding — which is argued from scratch in its specification rather than ported. The reviewer-owned
  verdict field and the capture-on-clean-exit rule are extraction. PR 1 explains there why a generated
  run id is preferred over filesystem modification time, on failure modes it names; that argument is
  the design content, and it stands whatever any other implementation does.
- **PR 3** is tagged `[extract]` because most of the round machinery exists in the fork, but three
  items are new design and are named as such in its specification: the counter-driven pairing-change
  warning, the reviewer search-scope budget, and the round-accounting rule for environmental
  failures.
- **H1** is tagged `[extract]` although it ports nothing. The two-tier scrub gate it extends is
  already merged and already running in this repository's own suite; H1 widens its patterns and its
  file coverage, re-derives which files the gate is about from what this repository tracks rather
  than from what sits on disk, and adds a failure state it lacks. §6 names which of its four
  additions is closest to new design, and why that does not move the tag.
- **PR 8** is `[docs]` for the reason above. Every other row carries `[extract]` or `[design]`.

## 2. Design principles

1. Only an explicitly successful check may open a gate.
2. `skipped` and `not_run` are observable states, never aliases for success.
3. A previous or partial artifact must not satisfy the current run.
4. Reviewer findings remain input; the orchestrator independently verifies them.
5. Author self-review and reviewer verdict are separate authorities.
6. Model and reasoning settings are configuration, not hard-coded product policy.
7. Project-specific defaults must not enter the public core.
8. Existing `init-harness` safety guarantees must be preserved (`taskctl/harness.mjs:13-18`).
9. External provider integrations must not enlarge the trusted core.
10. Every positive gate test needs a negative control proving that the gate can fail.
11. A check that could not run reports `unknown` or `not_run`. An empty result from a broken check
    must never render as a clean result.

## 3. Decisions

Seven questions blocked specification of the PRs downstream of them. They are decided here. Each
decision states what it closes and why, and the sections below cite the decision they rest on.

### D1 — Downstream-fork re-synchronization is out of scope (issue #8)

The fork does not rebase onto this repository after the sequence, and this plan promises it no
compatibility boundary. The extraction PRs are therefore free to rewrite seam semantics to whatever
shape is right for the public core, and no PR may cite fork compatibility as a constraint on its
design.

*Why:* preserving an undefined compatibility surface for a consumer that is not committed to
consuming it constrains every PR in the sequence in exchange for a benefit nobody has undertaken to
collect. Declaring it out of scope removes the constraint and makes the cost visible instead of
hidden.

*Future option, not a commitment:* if this is ever revisited, the shape it would take is a
`taskctl/`-subtree-level re-synchronization — that directory is the only unit whose boundary is
already meaningful on both sides. Nothing in this plan is designed to enable it.

### D2 — Review freshness ships default-on and fail-closed (issue #7)

Strict review freshness is default-on from the moment PR 1 merges. There is no global warning
period, and no missing-provenance case is a warning.

*Why:* a warning period is the fail-open that PR 1 exists to remove. A gate that warns for a
transition window is, for that window, exactly the check that cannot fail — principle 10 — and the
window is when the migration bugs are.

*Compatibility is handled per task, not globally.* A task whose persisted state predates the
run-identity schema version (P3) is refused with an actionable message naming the task, the version
it carries, the version required, and the single command that opts it in. The opt-in is per task,
is recorded in that task's state with a timestamp, and is printed on every subsequent gate decision
for that task. A workspace with fifty legacy tasks therefore makes fifty visible decisions rather
than one invisible one.

### D3 — Verification requires an already-committed, clean tree (issue #4)

When verification is required, `publish` does not create the commit. It refuses a dirty worktree and
refuses a `HEAD` that does not match the verified commit.

*Why:* `publish` currently stages and commits the work itself — `git add -A` at
`taskctl/cli.mjs:1955`, `git commit` at `:1962`. Evidence recording "the current commit SHA" would
therefore describe the tree *before* the commit publish then creates, and the published commit would
contain code that was never verified while the evidence looked valid. Recording something that
survives the commit is the alternative, and it is worse: it makes the evidence describe a tree that
has no name, which nothing downstream can re-derive.

*The current behavior stays available.* On the path where verification is **not** required, publish
keeps creating the commit exactly as it does today. Existing users are not broken by this decision;
they opt into the stricter path by declaring verification commands.

### D4 — Task state gains an explicit `schemaVersion` (issue #3)

Task state carries a schema version. A newer binary migrates older state on read and writes the new
version. An older binary meeting newer state is explicitly out of contract: it refuses with a
message naming both versions and what to do, rather than guessing at fields it does not know.

*Why:* state is currently persisted as unversioned JSON — `readState`/`writeState` at
`taskctl/cli.mjs:3452-3463` parse and stringify with no version field — and four rows in this sequence
say in their own specification that they extend it. Named, so the count can be checked rather than
taken: **PR 1** binds a review-run identity and records override use in state; **PR 3** persists a
monotonic review-round counter; **PR 4** records verification evidence *and* adds a new value,
`stage: "reviewed"`, to a field that already exists; **PR 6** adds the `governanceFold` block.

One row is deliberately outside that four and named here rather than left to be discovered: **PR 2**
introduces per-task model and effort pins and does not say where a pin is persisted. If it is
persisted in task state, PR 2 is a fifth extender and carries this decision's bump rule like the
others; if it is persisted elsewhere, it is not. That is PR 2's call to make and to state, and the
count above is over rows that have already made it. Two developers on different binaries is the
normal case, not the edge case.

*The pattern already exists in this repository and is followed rather than reinvented:*
`RECORD_SCHEMA_VERSION` at `taskctl/newproject.mjs:34`, the refusal at `:108-109`, and its
negative-control test at `taskctl/__tests__/newproject-unit.test.mjs:534`.

*The bump rule is stated over readability, not over fields.* **The version is bumped by any change
that makes state written by the new binary unreadable — in the sense of being acted on correctly —
by the previous one.** Adding a field that nothing gates on is still not a bump, because an older
binary that ignores it behaves exactly as it did before; the version must not increment faster than
anyone can migrate, or the refusal becomes noise that gets bypassed.

*Why the rule is not phrased over fields.* A rule phrased over fields — "bump when a field becomes
load-bearing for a gate" — is blind to its most likely violation, and this sequence contains one. PR
4 adds no field: it adds a load-bearing **value**, `stage: "reviewed"`, to a field that already
exists. A field-shaped rule does not fire there, so an older binary reads state whose version it
recognises, containing a stage value it has never heard of, and none of the refusal this decision
promises ever happens. Value-space changes are the normal way a schema grows after its fields settle,
so the rule has to be able to see them. Phrasing it over readability does: a new enum value that
gates a transition is unreadable to a binary that does not know the value, whether or not a field was
added.

*And the rule alone is not enough, so it is backed by a mechanism.* The rule is a judgement made at
authoring time, and the failure mode is someone not making it — which is the shape of a check that
cannot fail (principle 10). So P3 additionally requires that **an unrecognised value in a
gate-bearing field is refused, not ignored**, with a negative control. The two are deliberately
redundant: the rule is what keeps the version honest for the reader, and the refusal is what
protects the run when the rule was forgotten. Neither substitutes for the other — a bump with no
value-level refusal still mis-handles a state file hand-edited to an unknown value, and a refusal
with no bump gives the operator a message about a value rather than about a version they can act on.

### D5 — The enforceable test gate is a prerequisite, not release hygiene (issue #2)

The test gate exists and is enforced before PR 0 merges. PR 8 no longer owns CI.

*Why:* deferring CI to the last PR of the sequence, while requiring "run the complete suite after
every PR" throughout it, lands PRs 0 through 7 on a manual promise that nothing enforces — the same
fail-open PR 0 exists to abolish, applied to the plan's own process.

*Nothing enforces a suite run today, and that is a search result rather than an impression.*
`git ls-files | grep -iE '\.github/|\.gitlab-ci|azure-pipelines|\.circleci|appveyor|Jenkinsfile|\.travis'`
returns no tracked file, and no `.github` directory exists at the repository root. **What the search
does not see:** a hosted check configured outside the repository — a branch protection rule, a
provider-side integration, a bot — leaves no tracked file and would not appear. The claim is
therefore precisely "this repository tracks no CI configuration", which is what D5 needs: P1 must
create one, and there is nothing in-tree to extend.

*This decision is not "install CI".* The suite the gate would run is not currently deterministic —
P1 records the measurement — and a gate over a suite that fails for reasons unrelated to the change
under review is not a weaker version of this decision. It is the defect this decision exists to
remove, wearing the decision's clothes. What must be finished before PR 0 merges is P1's whole
ordered sequence, not a workflow file existing.

*One known contributor is a defect in shipped code, not suite noise.* Issue #21 is a real
mutual-exclusion bug that its test detects intermittently, so it is fixed upstream of P1 rather than
absorbed into it (P1's entry condition). This sharpens the decision rather than softening it: a gate
installed today would report a true product defect as a merge blocker on unrelated changes, and the
contributor most likely to act on that is the one who relaxes the assertion.

### D6 — Every PR is tagged `[extract]` or `[design]` (issue #1)

Every row in the section 1 table carries a tag, defined in §1.1. One row — PR 8 — carries neither
`[extract]` nor `[design]`, because it introduces no mechanism; §1.1 defines `[docs]` for exactly that
case and bounds it to a single row, so the exception cannot quietly become a way to avoid a design
note.

**The design-note rule is scoped, and the scope is part of the rule.** From the merge of P1 step 3
onward, no `[design]` row merges unless its design note is already on the base branch. That is the
whole of what D6 guarantees, and D6 asserts nothing about rows that merge before the gate exists.
Under the merge order in §1 those rows are exactly two — **P2 and P1** — and for them the note is a
convention with no failure path.

*Why:* describing the whole sequence as extracting improvements "proven in sustained production use"
would mis-state the risk profile, the review burden, and the sequencing, because most of the sequence
has nothing to extract. Counted over the fifteen rows of the §1 table: **ten `[design]`, four
`[extract]`, one `[docs]`** — 10 + 4 + 1 = 15. The tag is not bookkeeping — a `[design]` PR needs its
mechanism argued before it is coded, and an `[extract]` PR does not.

**How the design-note requirement can fail, and where it cannot.** A requirement stated as a step,
with nothing detecting its absence, lets a `[design]` PR open and merge with no note and be green
throughout. A requirement with no failure path is the subject of this plan, appearing inside it, so it
is either given a detectable form or given up. It is given a detectable form for the part that has
one, and the rest is named as convention rather than left looking enforced.

**And the rule is scoped rather than universal-with-an-exception, which is not a cosmetic
difference.** Disclosure is not enforcement: a universal claim with a footnote taking one case out of
it is still a rule with a hole, and writing the hole down documents it while changing nothing about
it. So the claim is narrowed to what is enforced, the rows outside it are named in the rule rather
than after it, and for those rows the plan says *convention* and does not say *requirement*.

*Enforced.* Every pull request declares the table row it implements. For a row tagged `[design]`, the
merge gate installed by P1 step 3 refuses the merge unless a design note for that row exists **on the
base branch** — that is, was merged by an earlier change, not by this one. Negative control: a pull
request declaring a `[design]` row, with no note for it on the base branch, is refused; the same pull
request merges once the note lands separately.

What this gate concludes is that two changes merged in a stated order — nothing about the note's
quality. D7 explains why that is a legitimate conclusion from a file's presence while D7's own audit
artifact is not.

*Convention, with no enforcement, stated so it is not mistaken for the above.* Three things:

- **"before the implementation PR opens."** Only "present on the base branch when it merges" is
  checkable after the fact. A note written the day the implementation is finished satisfies the gate
  and defeats the purpose, and no check distinguishes the two.
- **A truthful declaration.** A pull request that declares the wrong row, or declares an `[extract]`
  row while implementing a `[design]` one, passes. The gate binds a note to a claim, not to the diff.
- **The note's content.** That it states problem, chosen mechanism, rejected alternatives and failure
  modes is not machine-checkable, and no lint over headings would make it so.

*The two rows outside the scope, and the cost of that.* P1 installs the gate, so the gate cannot be a
condition on P1's own merge. P2 merges before P1 because it remediates a defect that ships today
(§4), so it is outside the scope as well. For both, the note is written as a matter of practice and
its absence fails nothing. Every row from P3 onward is covered, P2b included.

The set is two rather than one by deliberate trade: shrinking it to one means holding P2 behind P1,
and P1 is behind an intermittent test failure nobody has yet diagnosed (§10 item 7) — trading a live
shell-execution route for a bookkeeping property of this section. The plan takes the live route
seriously and the bookkeeping property honestly: it says two, names them, and claims nothing for them.

### D7 — The orchestrator audit stays a warning in the core (issue #7)

The audit of reviewer findings is not promoted to a hard publish gate. The CLI may require an audit
artifact to be present, warn that one is missing, stale, or bound to a different round, and record
what it found. It never asserts that an audit happened, and never asserts that an unverified
reviewer finding is true.

*Why:* the only property of an audit artifact a machine can check is that a file exists and names
the round it claims to audit. Existence is not evidence of judgement. Promoting file presence to a
gate manufactures precisely the check that cannot fail — principle 10 — and worse, it *reads* as
enforcement, so the practice that actually does the work decays behind it. A project that wants
enforcement declares a verification command (PR 4) that checks something machine-checkable.

*This is not contradicted by D6's design-note gate, which also checks that a file exists.* The claims
differ. Here, presence would have to stand for judgement, and nothing about a file supports that.
There, presence on the base branch establishes that two changes merged in a stated order — a fact
about ordering, checked as a fact about ordering, and asserting nothing about the note's quality. The
test is not "does this gate look at a file" but "is the thing the gate concludes the thing the file
can show".

This keeps the boundary the repository already documents at `README.md:443-444` (the audit is a
methodology practice, not CLI-enforced) and adds the freshness and round-binding warnings that are
missing from it.

## 4. Prerequisites

These four merge before PR 0. Each PR in section 5 names the prerequisites it depends on. All four
are `[design]`: none of them has an implementation to port, and each says below what search
establishes that for itself. None of the four depends on any of the others, so their order among
themselves is a judgement rather than a constraint; they are specified in the merge order the §1
table gives — **P2, then P1, then P3, then P2b** — so that this section and the table do not
disagree.

### P2 — Engine launch safety: launch-value refusal `[design]` (issues #5, #22)

**Merge position:** first in the sequence, ahead of P1. Not a preference about ordering: this row
repairs a route that is live in shipped code today, and the row it would otherwise sit behind is
itself behind an undiagnosed intermittent test failure (§10 item 7).

**A configured string already reaches a shell-mediated argv, so this row is remediation and not
prevention.** The route exists now, end to end, and every link below was opened:

- `engines.reasoningEffort` is ordinary project configuration. Its validation checks that it is a
  string and nothing whatever about its content — `assertOptString` at `taskctl/config.mjs:152-156`,
  applied to this field at `:168` — and it resolves with a default at `:290`;
- it is then passed through unchanged: `taskctl/cli.mjs:974` and `:1139` hand it to `runEngine`,
  which is bound to `runEngineStep` at `:750` (`const runEngine = deps.runEngineStep ?? runEngineStep;`
  — the production default of a test seam); `runEngineStep` forwards it to `spawnAI` at
  `taskctl/automation.mjs:166-177`, and `taskctl/automation.mjs:305` hands it to `spawnAI` directly;
- `spawnAI` passes it to the adapter untouched (`taskctl/automation.mjs:70`, `:79-81`), and one
  adapter interpolates it straight into an argv element — a `key=<value>` string built by template
  substitution at `taskctl/engines.mjs:372`, from the value read at `:368`;
- the spawn is `shell: true` (`taskctl/automation.mjs:104-113`; the option itself at `:107`).

The value is therefore not an argument, it is shell syntax, and the only precondition for it to run
is that the operator invoked this tool in a repository whose configuration someone else wrote —
which is the situation the onboarding flow exists to invite. It is filed as **issue #22**.

**A second exposure on the same value, by a different route.** `taskctl/cli.mjs:1506` and `:1769`
pass the configured effort into `launchCmd`, which composes a launch *string*: `launchCmd` at
`:3368-3372` (the effort resolved at `:3370`), `buildLaunchCommand` at `:3340-3348`, into the
adapter's `buildLaunchString` at `taskctl/engines.mjs:353-358`, where the value is read at `:357`,
substituted into a flag fragment at `:358`, and embedded in the command at `:361` and `:363`. The
composed string is **printed** at `taskctl/cli.mjs:1512` and `:1775` (`console.log(c.launchLine)`).
Six further call sites reach the same builder without passing the effort explicitly — `:1404`,
`:1430`, `:1667`, `:2968`, `:3033`, `:3085` pass the runtime config as `launchCmd`'s third argument,
so `:3370` supplies the same value, printed at `:1408`, `:1433`, `:1671`, `:2972`, `:3036`, `:3089`.
This tool does not execute those strings. It composes them from configuration and instructs a person
to run them on their own shell, which is not a smaller exposure than the first one and is not covered
by validating the spawn path alone.

#### The enumeration: every configuration-sourced value that reaches argv or a printed command

P2's scope is the set below, and the set is a search result rather than a recollection. The claim
"these are the values" is a negative existential about every value *not* listed, so the method comes
first: the population it ranges over, the units it counts in, then the join, then the blind spots.
Every total in this section is derived from a stated unit and is shown adding up.

**Scope of the search.** The production modules, `taskctl/*.mjs`. `taskctl/__tests__/` is excluded: it
contains no launch path, and a test's own argv is not shipped behavior.

**The population — what counts as "a configured value", exactly.** Two sources, both enumerated from
`taskctl/config.mjs`, because that file is what this repository treats as its configuration surface.

*Source A — runtime-config paths.* `grep -n "^export \(async \)\?function" taskctl/config.mjs` lists
nine exports. Four produce the surface — `loadConfig` (`:33`), `getPaths` (`:58`),
`normalizeRuntimeConfig` (`:259`), `loadTaskctlConfig` (`:344`). Three are validators (`:98`, `:138`,
`:203`). Two neither produce nor validate: `loadJiraCreds` (`:402`) passes through to `loadConfig`,
and `loadEnvOnly` (`:84`) loads `.env` files into `process.env` for their side effects — which widens
the *environment*, not this surface, and is the concrete form of the fourth blind spot below.

The surface is the object literal `normalizeRuntimeConfig` returns (`:301-319`). It names twelve keys
at its top level, four of which are nested object literals this same file writes out key by key —
`tracker` (`:303-306`), `grace` (`:267-272`), `branches` (`:282-285`) and `engines` (`:287-291`),
contributing two, four, two and three sub-paths. Opening those four containers gives
`12 − 4 + 11 = 19` named paths.

One of the nineteen is not a value. `raw` (`:318`) is the parsed configuration file itself — the
object the other eighteen are computed *from* (`:260`, `:262`, `:281`, `:288-290`, `:305`, `:310-316`)
— so counting it beside them would count the whole file a second time. It is held out of the
population by that rule and by that rule alone. It is therefore **not** an entry with no sink; it is
not an entry. Reads that go *through* it instead of through a named path are blind spot 1 below, and
`cli.mjs:3499` is one. That leaves **18 leaf paths**.

*Source B — environment names.* `grep -on "process\.env\.[A-Z_]*" taskctl/config.mjs` returns
`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` (`:47-50`), `VIBE_ROOT` (`:60`)
and `REPO_PATH` (`:61`, `:375`) — **6 names**. These are in the population, not a footnote to it:
`REPO_PATH` outranks the configuration file as the source of `repoPath` (`:375`) and is read directly
at six call sites outside `config.mjs`, so a join that ranged over config paths alone could not have
produced the `REPO_PATH` row below. That grep misses one read of its own kind — `config.mjs:362`
indexes `process.env` by a computed name — which resolves to the same four `JIRA_*` variables and so
adds nothing, but is named because it is the first blind spot appearing inside the population itself.

**Population = 18 leaf paths + 6 environment names = 24 members.**

**The two counting units, because every total below is in one of them.**

*A key is one population member* — one leaf path or one environment name — and gets **one table row**.
`repoPath` and `REPO_PATH` are therefore two members and two rows, even though they converge on one
value at `config.mjs:375`: they are supplied by different routes, so "set it to a value containing a
metacharacter" is a different test for each, and a criterion phrased over *project configuration* does
not reach the environment one.

*A sink is one **destination site**: a single line at which a value leaves this process* — either a
child process is created there (`spawn`, `spawnSync`, `execSync`, `execSyncTop`, `execFileSync`), or a
command string is written to stdout there for a person to run. A function that composes argv or a
command string and hands it onward *inside* this process is a **route**, not a sink, and is counted at
the site where it terminates. `grace.mjs:725`, `:769` and `:1239` build git argv and call the injected
`deps.runGit`, which is `cli.mjs:2542-2548` (injected at `cli.mjs:2489`); they add routes and no sinks.

**The join.** For each of the 24 members, `grep -rn "<member>" taskctl/*.mjs`, and follow every read
forward until it either reaches a destination site or terminates. A member reaches a sink when its
value becomes part of an argv element or of a printed command string. `cwd` does not count: it is not
argv, and no shell parses it.

**The destination sites — 21, numbered so the table below can cite them and §10 can decide them one at
a time.** Nine execute; twelve print.

| # | Site | What happens there |
|---|---|---|
| 1 | `automation.mjs:104` | `spawn(cmd, args, …)`, `shell: true` at `:107`. The generic engine spawn |
| 2 | `cli.mjs:188` | `execSyncTop(cmd, …)`, the `run` helper inside `ensureWorktree` (`:185`) |
| 3 | `cli.mjs:222` | `execSyncTop` on `git worktree remove "…" --force` in `removeWorktree` (`:219`), reached from `:2133` |
| 4 | `cli.mjs:1731` | `execSyncTop(cmd, …)`, the `run` helper in the review-diff block |
| 5 | `cli.mjs:1926` | `execSyncTop(cmd, …)`, the `run` helper in publish. It also *prints* the command at `:1925`; that print is an echo of this same call and is not a site of its own |
| 6 | `cli.mjs:1991-1997` | `spawnSync('gh', […], { shell: false })`. **Not shell-mediated** |
| 7 | `cli.mjs:2543-2548` | `spawnSync('git', args, …)`, `shell: true` at `:2545` — the `runGit` helper, also injected into `grace.mjs` as `deps.runGit` (`cli.mjs:2489`) |
| 8 | `grace.mjs:132-143` | `spawnSync('grace', ['lint','--profile',…,'--path',repoRoot,…], …)`, `shell: true` at `:136`, the value at `:134`, **unquoted** |
| 9 | `harness.mjs:69` | `execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'])`. **Not shell-mediated** |
| 10–17 | `cli.mjs:1408`, `:1433`, `:1512`, `:1671`, `:1775`, `:2972`, `:3036`, `:3089` | the eight printed engine launches, each its own `console.log(c.launchLine)` reached by its own command. Eight sites and not one because each is a separate line on a separate path; the builder they share (`engines.mjs:353-363` via `buildLaunchCommand` at `cli.mjs:3340-3348`) is a route |
| 18 | `cli.mjs:1780` | `console.log(L.codexAutoSaveNote('review <key> --repo-path <repoPath>'))` |
| 19 | `cli.mjs:2010` | the `gh pr create … --base <prTarget> …` line printed after a successful create |
| 20 | `cli.mjs:2064` | the same command under an explicit manual-fallback header at `:2063` |
| 21 | `automation.mjs:662` | `taskctl publish <key> --repo-path <repoPath>`, printed when the operator declines to publish |

**9 executing + 12 printing = 21 destination sites.**

*One qualifier on sites 10–17, because a reader who opens `cli.mjs:1408` for a claude launch will not
find a configured value there.* Which member reaches those eight sites depends on the adapter the
launch resolves to. The codex builder (`engines.mjs:353-363`) interpolates `reasoningEffort` (`:357`)
and the repo path (`:355`); the claude builder (`:311-314`) interpolates only `orchestrationDir`,
which comes from the install root (`cli.mjs:3346`) and is not a population member, and the opus
adapter delegates to it (`:433`). The eight sites are in the inventory because the codex path reaches
them, and the criteria below are written over the sites rather than over the adapter, so that adding
a configured value to the claude shape does not silently fall outside them.

**Result — 8 of the 24 members reach a destination site.** One row per member; the Sinks column cites
the numbers above.

| Member | Where it is read | Reaches | Sinks | Shell interprets it? |
|---|---|---|---|---|
| `engines.reasoningEffort` (leaf) | validated `config.mjs:168`, resolved `:290` | argv element `engines.mjs:372`; launch string `engines.mjs:357-358` → `:361`, `:363`, passed explicitly at `cli.mjs:1506`, `:1769` and from config at `:3370` for the other six | 1, 10–17 | yes at 1 (`automation.mjs:107`); yes at 10–17 — the operator's shell |
| `repoPath` (leaf) | `config.mjs:302` from `:375`; per command at `cli.mjs:148`, `:1904`, `:3369`, `automation.mjs:234`, `:489`, `:614`; via `raw` at `cli.mjs:3501`, `:3506-3507` | `-C "<workDir>"` `engines.mjs:374`; `wtDir` inside `git worktree add` `cli.mjs:211` and `git worktree remove` `:220`; argv element `harness.mjs:69`; printed at 18 and 21 | 1, 2, 3, 9, 10–17, 18, 21 | yes except at 9 (`execFileSync`) |
| `REPO_PATH` (env) | `config.mjs:61`, `:375`; directly at `cli.mjs:148`, `:1904`, `:3369`, `automation.mjs:234`, `:489`, `:614` | the higher-precedence source of the same value, so the same sites | same as `repoPath` | same as `repoPath` |
| `grace.repoRoot` (leaf) | validated `config.mjs:213-217`, resolved `:269` | `--path <repoRoot>` at `grace.mjs:134`, reached from `cli.mjs:1539-1540` and `:2422-2426` | 8 | yes — and **unquoted** |
| `grace.pilotBranch` (leaf) | validated `config.mjs:213-217`, resolved `:270` | rev ranges composed at `cli.mjs:2777`, `:2781`; `grace.mjs:769` via `deps.runGit` | 7 | yes |
| `grace.upstreamBranch` (leaf) | validated `config.mjs:213-217`, resolved `:271` | `origin/<branch>` composed at `cli.mjs:2592`; bare value at `:2761`, `:2777`, `:2781`, `:2850`; `grace.mjs:725`, `:769`, `:1239` via `deps.runGit` | 7 | yes |
| `branches.integration` (leaf) | validated `config.mjs:160`, resolved `:281` | `git diff …` strings `cli.mjs:1737`, `:1741` from the read at `:1712`; base branch at `cli.mjs:203`, `:204`, `:206` from the read at `:1630-1634` | 2, 4 | yes |
| `branches.prTarget` (leaf) | validated `config.mjs:161`, resolved `:284` | `gh pr edit … --base <target>` `cli.mjs:2037` from the read at `:1895`; argv element `:1995`; printed at 19 and 20 | 5, 6, 19, 20 | yes at 5, 19, 20; **no** at 6 |

**Every one of the 21 destination sites is reached by at least one of the 8 members**, which is what
makes the sink inventory P2's scope rather than a survey.

Four things in that table are worth reading twice. **`grace.repoRoot` is passed unquoted** into an
argv array spawned with `shell: true`, so it needs no metacharacter at all — a space is enough to
split it into two arguments, and a `;` ends the command. **Two sinks are not shell-mediated** (6 and
9); a value reaching them cannot execute, but it can still inject an *argument* — a `prTarget`
beginning with `-` becomes a flag to `gh` — so they are in the invariant's scope and their negative
controls assert a different failure. **Printed commands are a route in their own right, and not only
for engine launches**: sinks 18–21 compose a command from configuration and print it for a person to
run, the same exposure as the printed engine launch and reached by different code paths. And
**`engines.reasoningEffort` is not the worst of the eight**; it is merely the one that was found
first and filed.

**The other 16 members, with the reason each reaches no destination site**, so a reader can check the
partition rather than trust it.

*Eleven leaf paths.* `engines.planner` and `engines.reviewer` select an adapter and never become argv
*content*: the spawned command is an adapter literal (`engines.mjs:325`, `:378`), and both are
registry-validated at `config.mjs:298-299`, which is already the shape of check P2 generalises.
`promptLanguage`, `projectContext`, `constraints` and `codeAreas` reach prompt text, which never
enters argv — `readAndFollow` (`engines.mjs:146-148`) puts the prompt *file path* in argv and never
the file's contents. `tracker.assigneeEmail` reaches an HTTP body. `previewUrlTemplate` is substituted
into a URL at `cli.mjs:2074-2075` and printed as a URL rather than as a command. `tracker.type` is a
validated enum (`config.mjs:364`) and `grace.enabled` a boolean (`config.mjs:268`); neither is
interpolated anywhere.

The eleventh, `configPath`, is here for a different reason and the difference is the point.
**It is not that it reaches no sink — it reaches one, as a component of another member's value.**
`resolveMaybeRelative` (`config.mjs:228-232`) resolves a relative `grace.repoRoot` against
`path.dirname(configPath)` (`:231`, applied at `:269`), so the install directory's own path is a
prefix of the string that arrives unquoted at sink 8. It needs no row of its own because what arrives
there is `grace.repoRoot` *after* resolution, and validating that resolved value covers the prefix —
**provided validation runs on the resolved value and not on the configuration file's raw field.**
That proviso is an acceptance criterion below rather than an aside: without it, this member reaches a
sink by a route no test exercises.

*Five environment names.* `VIBE_ROOT` is read once, at `config.mjs:60`, and
`grep -rn "vibeRoot" taskctl/*.mjs` returns that line alone. The four `JIRA_*` variables reach an
HTTP client, not a process.

**The nine process-creating call sites that are not sinks 1–9.**
`grep -rnE "\b(spawn|spawnSync|execSync|execSyncTop|execFileSync)\(" taskctl/*.mjs` returns 19 lines,
of which one (`grace.mjs:80`) is a comment — 18 call sites. Nine are sinks 1–9. The other nine are
reached by no member's value in argv, and saying which is what keeps the sink inventory a partition of
that grep rather than a selection from it:

- `cli.mjs:252` and `cli.mjs:2053` — `gh pr view` with a tracker-derived PR number and a state-derived
  branch name, neither of which is configuration;
- `cli.mjs:2101` — a task artifact's text interpolated into a command string (blind spot 2);
- `context-builder.mjs:120` — fixed argv, no interpolation;
- `engines.mjs:165` and `:192` — the availability probe; its argv is the adapter's own command literal
  (`:334`, `:394`, `:447`) plus `['--version']`;
- `grace.mjs:270` and `:437` — a configured `repoRoot` reaches these as **`cwd`** (`:271`, `:438`) and
  never as argv;
- `profiler.mjs:99` — `['-C', cwdArg, …fixedArgv]`, where the path is a **CLI argument**
  (`cli.mjs:1199`, `:738`) rather than configuration, and `fixedArgv` comes only from the module's own
  query table. It is blind spot 2's shape arriving at an argv position.

**The arithmetic, in full.**

```text
runtime-config object (config.mjs:301-319)  12 top-level − 4 containers + 11 sub-paths = 19 named paths
                                            19 − 1 (`raw`: the file the other 18 derive from) = 18 leaf paths
environment names read in config.mjs                                                          =  6 names
population                                                                       18 + 6       = 24 members

reach a destination site       7 leaf paths + 1 environment name                              =  8
reach none                    11 leaf paths + 5 environment names                             = 16
                                                                                    8 + 16    = 24  ✓

process-creating call sites    19 grep lines − 1 comment (grace.mjs:80)                       = 18
                               9 are sinks 1–9; 9 are reached by no member's value in argv
                                                                                     9 + 9    = 18  ✓

destination sites              9 executing + 12 printing                                      = 21
                               all 21 are reached by at least one of the 8 members
```

**What this method cannot see.** Four things, and they bound the claim rather than qualifying it:

- **It follows static reads of named members.** A value assembled at run time — read out of the raw
  config object by a computed key, spread into an options bag and forwarded under a different name,
  or read from a file whose *path* came from configuration — does not match a name-based search.
  `cli.mjs:3499` is exactly that shape: it takes `tcfg.raw` wholesale and destructures `branches` and
  `grace` out of it, and it entered this table only because the destructured names happened to match.
  There may be others that do not.
- **It is scoped to configuration, and configuration is not alone in these sinks.** Values from CLI
  arguments and from task artifacts travel the same strings: `cli.mjs:2101` interpolates
  task-artifact text into a shell command string, `profiler.mjs:99` puts a CLI-supplied path into an
  argv element, and the two worktree commands at `cli.mjs:211` and `:220` carry a slug- and
  branch-derived segment alongside the configuration-derived `repoPath` this table claims. So sinks 2
  and 3 are in the table for their `repoPath` component and remain uncovered for their other one.
  Those components are outside P2's stated scope, not outside the sinks' reach, and nothing in this
  plan closes them.
- **It sees one commit.** A key added to the config surface after this enumeration joins the set
  without the table changing, which is why the entry point below — not the table — is the mechanism.
- **The population is what `taskctl/config.mjs` names.** Source B covers environment variables that
  file reads; an environment variable read *only* at a call site, never named in `config.mjs`, is
  configuration in every sense that matters and is outside the population — and `loadEnvOnly`
  (`config.mjs:84`, called at `:349`) puts arbitrary `.env` keys into `process.env` for exactly such a
  read to find.

All eight members belong to issue #22's defect class and are noted there. #22 itself stays filed
against the one value it was opened for — an issue narrowed to what was verified when it was filed
stays a report rather than becoming a category.

#### The refusal

**Launch-value refusal.** The containment is a launch-time refusal: every configuration- or
pin-supplied argv value is validated against a conservative character allow-list and the launch
**throws**, because continuing means executing the injected text. PR 2 additionally introduces
provider model identifiers as opaque strings drawn from project configuration and per-task pins, and
passes them into engine argv, so the count of values on this path grows; the path itself is already
open.

This does not close `shell: true`, and must not be described as if it did. The shell remains, and
with it every other route by which a string reaches argv — the CLI- and artifact-sourced values named
in the blind spots above, and any future configurable value that skips the allow-list. Removing
`shell: true` in favour of argument arrays is a separate change, listed as still open in section 10.

**When the allow-list refuses something legitimate.** A conservative syntax rule will eventually
reject a provider identifier that is real. Widening the rule is not the answer — admitting a
character the shell interprets removes the only containment there is while `shell: true` stands, and
removes it globally, for every value, to admit one. What follows is the route instead, in the three
parts a blocked contributor needs.

*Where the report goes.* An issue in this repository, against the containment rather than against the
provider or the configuration. The refusal message supplies the report's contents: the config file
and key, the rejected character, and the destination site the value was travelling to. The site
matters, because §10 open decision 1 is settled per site — the nine executing sinks in the inventory
above are separable, and an assessment can convert one of them to an argument array without
converting the rest. The twelve printing sinks are not convertible at all; for those the containment
is the refusal to print, and open decision 1 does not apply to them.

*What unblocks it.* The first such report is the trigger that moves §10 open decision 1 from
"deferred" to "opened" — that is what open decision 1 means by "or earlier if a real identifier trips
the rule". An argument array carries the identifier safely and needs no allow-list; the allow-list
cannot be made to carry it without ceasing to contain anything. So the report is not filed into a
queue, it is the event that starts the work, and it is the only such event this plan defines.

*What they do in the meantime.* **There is no interim route, and pretending otherwise would be
worse than saying so.** Concretely: if the provider offers an equivalent identifier the rule accepts,
use it — that is a substitution, not a bypass. If it does not, the capability is unavailable until
open decision 1 lands, and the refusal message says that in those words rather than implying a
workaround. Supplying the same value through a different input route is not an escape and must not
be documented as one: the entry point below covers every route by construction, and a route that
evaded it would be the defect P2 exists to remove. Widening the allow-list, and any per-value opt-out
from it, are refused for the same reason.

**The property being protected is "no configured value ever reaches argv unvalidated", and it is
stated as a property rather than as a delivery condition on purpose.** A criterion naming a PR
("the refusal ships in the same PR that introduces configurable models and pins") breaks the moment
the PR order changes; a criterion naming the property is order-free, and the division of labour falls
out of it: **P2 ships the validator and the refusal, makes the validated path the only route from
configuration to argv, and migrates the eight members that travel that route today. PR 2 introduces
further values, and is responsible for showing that each of them travels it too.**

The invariant must hold after every merge in the sequence. **It does not hold now**, at any of the
twenty-one destination sites. P2's first job is to make the invariant true, not to keep it true.

Acceptance criteria:

- **at no point in the sequence can a configuration- or pin-supplied value reach argv without having
  passed the allow-list.** This is the invariant; the criteria that follow are how P2 discharges its
  half of it, and PR 2 carries a coverage criterion for the values it adds;
- the launch path accepts configuration- or pin-supplied argv values through exactly one validated
  entry point, so that adding a new configurable value later is a change to what flows through the
  check rather than a chance to route around it. This, and not the table above, is what makes the
  invariant survive the enumeration's blind spots;
- the validator and its refusal exist and are tested at P2, against synthetic values **and** against
  every member in the enumeration;
- **P2 migrates all eight enumerated members onto the validated entry point, and the enumeration is
  written into the criteria rather than derived from the general rule.** A rule phrased over "all
  configured values", paired with tests that exercise only values invented for the test, is satisfied
  while every live route stays exactly as it is — and that combination is how #22 came to ship;
- **negative control on real inputs, not on synthetic stand-ins:** for each of the eight members, that
  member set to a value containing a shell metacharacter refuses the launch, and the test asserts that
  no child process was spawned. Set *the way that member is supplied*: the seven leaf paths in project
  configuration, `REPO_PATH` in the environment — a control that only writes the config file leaves
  the higher-precedence environment route (`config.mjs:375`) untested. `grace.repoRoot` additionally
  has a space-only control, because it is passed unquoted (`grace.mjs:134`) and a space alone splits
  it. Synthetic-value tests may accompany these; they may not stand in for them;
- **validation runs on the resolved value, after composition, not on the raw configuration field.**
  Negative control: a relative `grace.repoRoot` resolved against a `configPath` whose directory
  contains a space or a metacharacter (`config.mjs:228-232`, applied at `:269`) is refused. A
  validator placed on the file's raw field passes every criterion above this one and still lets an
  unvalidated segment reach sink 8;
- **the two non-shell sinks get a control of their own shape.** For sink 6 (the `--base` argv element
  at `cli.mjs:1995`) and sink 9 (`harness.mjs:69`), a value beginning with `-` is refused, proving the
  check is about argv membership and not only about shell syntax. An implementation that guards only
  `shell: true` sinks passes every criterion above this one;
- **every printed command is covered on the same terms, not only the printed engine launch.** A
  command string this tool composes from configuration and prints for an operator to run is validated
  through the same entry point, and a value that fails validation causes no command to be printed.
  Two negative controls, because these are two code paths and an implementation that finds one will
  not necessarily find the other: one at an engine-launch printing site (sinks 10–17), one at an
  operator-command printing site (sinks 18–21). An implementation that guards only the spawn passes
  every criterion above this one;
- a value outside the allow-list refuses with a message naming the file, the key, the rejected
  character, and the destination site — the four things the escape route's report needs — so a
  contributor who believes the refusal is wrong is not left to invent a response to it;
- a test asserts the refusal message names an escape route, and that the route it names is the one
  stated above rather than "widen the rule";
- the shipped documentation states plainly that `shell: true` remains, what it still exposes, and
  which value classes P2 does *not* cover — the CLI- and artifact-sourced ones named in the blind
  spots.

**On the tag.** P2 stays `[design]`: `[design]` records that there is no implementation to port, and
the search for one is
`grep -rniE "allow ?list|allowlist|metachar|sanitiz|shell-?escape" taskctl/*.mjs` together with
`grep -rnE "^(export )?function (assert|validate)" taskctl/*.mjs`. What they return is two content
guards over other value classes — `validateSlug` (`cli.mjs:616-629`), over a task key derived from a
CLI argument, and `sanitizeForTitle` (`cli.mjs:1793`), over free-form text destined for a git commit
subject — and a set of shape, type and registry validators in `config.mjs` and `engines.mjs` that
check what a value *is* and never what it *contains*. No allow-list over a configuration-supplied
argv value exists, and no single validated entry point exists. **What the search cannot see:** it
matches on naming, so a validator named after its domain rather than its mechanism would be missed;
the citations above are what the reader should check, not the absence. This plan makes no claim about
the downstream fork here — a claim about a repository this document cannot cite is one the evidence
convention forbids. P2's own design note is unenforced — see D6, which names this row as one of the
two outside the gate's scope.

### P1 — Deterministic suite, then an enforceable test gate `[design]` (issue #2)

**Entry condition:** issue #21 is fixed and merged. The reason is below; it is stated as an entry
condition rather than a step because P1 does not own that work.

The end state: the full suite runs automatically on every pull request, on Windows and Linux, and a
failing suite blocks merge rather than reporting. The suite is `node --test __tests__/*.test.mjs`
(`taskctl/package.json:13`).

**On the tag.** `[design]` on D5's search: this repository tracks no CI configuration, so there is
nothing to widen or relocate and the gate is designed here. What P1 owns beyond a workflow file —
step 1's diagnosis, step 2's stability evidence, and step 3's completed-versus-failed distinction —
is design work by inspection.

**The suite is not deterministic today, and this deliverable may not be written as if it were.**
Measured on a pristine detached checkout of `main` at `f7e7707` with no local modifications, four
consecutive full runs produced:

| run | result | failing test |
|---|---|---|
| 1 | 325 pass / 0 fail | — |
| 2 | 324 pass / 1 fail | `lock: two simultaneous stale-reclaimers → exactly one wins` |
| 3 | 324 pass / 1 fail | `lock: two simultaneous stale-reclaimers → exactly one wins` |
| 4 | 324 pass / 1 fail | `session.log: the generic raw-stdout + [stderr] teeing format is preserved` |

**What that table shows is intermittency, and nothing more.** It is now partly explained, and the
explanation is not the one the table's shape suggests. Three further experiments at the same commit:

- **serial execution does not fix it.** Two full runs under `node --test --test-concurrency=1`: one
  green, one failing the lock test. Duration rose from ~88 s concurrent to ~258 s serial;
- **the lock test fails alone.** Its own file run by itself, five times: three green, two failing the
  lock test, with no other test file executing;
- `engines.test.mjs` alone is 61/61, twice.

So the failures do **not** depend on the files being run together: one of them survives with the
concurrent runner switched off and reproduces with nothing else running. Any reasoning from
"`node --test` executes test files concurrently" to these failures is refuted, and this plan makes
none.

A seventh full run — same commit, in a worktree with only untracked planning files added — was green
in 105 seconds. That is one more observation of intermittency, and it is the per-run cost figure the
count argument below uses.

*The population every rate below is quoted over, since the rates are only as good as it.* A **full
run** is one `node --test __tests__/*.test.mjs` over the whole suite; seven were recorded — the four
in the table, the two serial ones, and this last one — **three green, four failing** (lock at runs 2,
3 and the serial failure; `session.log` at run 4). Single-file runs are a separate population and are
never mixed into these totals: `newproject-unit.test.mjs` alone five times, `engines.test.mjs` alone
twice.

**The two failures do not share a cause, and one diagnosis does not transfer to the other.**

*The lock failure is a product defect, and it is out of P1's scope.* The assertion detail is
`expected: 1, actual: 2` — **both** concurrent stale-reclaimers acquired the lock, which is a
mutual-exclusion violation in `acquireFlowLock` (`taskctl/newproject.mjs:179-253`). The window is in
the stale-takeover path: the winner renames `flow.lock` to a uniquely-named claim file (`:238`) and
only *afterwards* creates the fresh lock with an exclusive open (`:249`). The reclaimer that loses
the rename recurses into a full retry (`:243`), and a retry that reaches the first-attempt exclusive
create (`:190-196`) inside that gap finds no lock file present, succeeds, and both callers hold a
lock. The test asserts exactly one winner (`taskctl/__tests__/newproject-unit.test.mjs:140`,
`:156`) and is correctly detecting a real defect, intermittently. It is filed as **issue #21**.
**P1 depends on #21 landing and does not own it.** Mutual exclusion in a lock is product work, not
suite work, and the routes step 1 offers a flaky test — isolate it, serialize it, run it apart — are
all ways of suppressing a true bug report.

*The `session.log` failure is uncharacterised.* It has been observed only inside full-suite runs; its
own file (`taskctl/__tests__/engines.test.mjs:474`) is 61/61 alone, twice. **Its mechanism is
unknown, and it must not be assumed to share the lock failure's cause.** The two failures appeared in
the same table; that is all that connects them, and a table is not a causal claim. Inheriting #21's
diagnosis here would be the same unevidenced confidence as inventing one.

Why this reshapes P1 rather than being a footnote to it: a merge-blocking gate over a suite that
failed four of the seven full runs recorded here, for reasons having nothing to do with the change
under review, gates nothing. It trains every contributor to re-run until green, and a check that is
re-run until it passes is a check that cannot fail — principle 10, arrived at through process rather
than through code. Installing the gate first would therefore *manufacture* the defect the gate exists
to remove.

P1 has an ordered internal sequence. Each step is the entry condition for the next, and none may be
started early.

**Step 1 — characterise the `session.log` failure, then fix or isolate it.** This is now the only
undiagnosed contributor. Fixing it is preferred. Isolating it — running the file in its own process,
or serializing it against a named other file — is acceptable, but only with a written statement of
what is being separated from what, so the result is a bounded and visible known defect rather than a
silence. Either route ends with a named mechanism: "it stopped reproducing" does not close this step,
because that is indistinguishable from a race whose window got smaller. Whole-suite serialization in
particular may not be adopted on the assumption that it works: it did not remedy the lock failure, it
has never been tested against this one, and it triples full-run duration.

**Step 2 — demonstrate stability: 20 consecutive green full runs per platform**, on unmodified
`main`, before any gate is installed. The number is stated so it cannot be quietly negotiated
downward, and it should be read as exactly what it is worth — see below.

**Step 3 — install the merge-blocking gate**, against the criteria below.

**What the consecutive-green count is worth.** By the rule of three (≈3/N), 20 consecutive greens
bound the residual per-run failure rate at roughly 14% with 95% confidence. That is weak, and step 1's
diagnosis rather than the count is the evidence. It is also weaker than it looks, because it treats
the residual rate as one population and the measurements above show two contributors, with different
rates and different fates.

- The lock failure ran at roughly two in five — two of the five runs of its own file, and three of
  the seven full runs (table runs 2 and 3, plus the failing serial run). Under #21 it is **fixed, not
  tuned**. Once it is fixed, the suite's
  aggregate failure rate collapses for a reason that says nothing whatever about the other
  contributor, and 20 consecutive greens become easy to reach on that account alone.
- An aggregate count over the whole suite cannot bound anything per-failure. That is why the entry
  condition matters: 20 greens recorded *before* #21 lands would be near-impossible and would prove
  only that #21 was absent; 20 greens recorded *after* it lands are dominated by the failure that is
  still unexplained, which is the one worth bounding. The count means what the rule of three says it
  means only if it is collected at a commit that already contains the fix.
- Even then it is a backstop, not evidence. Against the `session.log` failure continuing at the rate
  observed — one in the seven full runs recorded here — 20 greens has roughly a 95% chance of
  catching it. Against a "fix" that narrowed the window to a few percent, it does not: that is
  precisely the failure mode step 2 was introduced to catch, and it is where the count is weakest.
  Tripling it to 60 runs moves the bound only from ≈14% to ≈5% and costs ~105 minutes per platform,
  so buying the missing confidence with repetition is not available at any sane price.

The conclusion is to keep 20 and to keep the weight on step 1. The count is cheap — at ~105 s per
run, 20 runs is ~35 minutes per platform, and the two platforms run concurrently — and it catches the
loud failure mode. It cannot certify a race closed, and no run count that fits in a workflow can.

Acceptance criteria — steps 1 and 2:

- issue #21 is merged before step 2's runs begin, and the recorded runs name a commit that contains
  that fix. A run count collected across an open known defect measures the defect, not the suite;
- the lock test's assertion is not weakened, and neither is any other test, to obtain a green. A
  suite made green by relaxing the assertion that detected #21 satisfies step 2 and defeats it;
- the `session.log` failure has a *named* mechanism, recorded where a later reader will find it — the
  fix's commit message or a design note — not merely an observation that it no longer reproduces;
- if isolation is chosen over a fix, the isolation states what is separated from what and why, and a
  test asserts the isolation is still in place, so it cannot be silently undone by a later change
  that looks like cleanup;
- 20 consecutive green full runs per platform are recorded, together with the commit they ran
  against;
- both tests named in the table above pass in a *full* run, not only in isolation. Isolation passing
  is the starting observation, not the exit condition.

Acceptance criteria — step 3:

- the suite runs on every pull request on both platforms;
- a failing suite blocks merge — proven by a negative control: a pull request containing a
  deliberately failing test cannot be merged;
- **the gate distinguishes "the suite failed" from "the run did not complete", and reports them as
  different states.** Only the first is attributable to the change under review. A runner that was
  cancelled, timed out, exhausted its disk, or could not check out the repository has said nothing
  about the change, and reporting that as a failure trains contributors to re-run on red — the same
  defect as step 1's, reached from the other direction. Neither state may open the gate
  (principle 11): distinguishing them is for the reader, not a license to pass;
- negative control for the above: a run aborted before the suite starts reports as not-completed, a
  run whose suite genuinely fails reports as failed, and the two are distinguishable in the gate's
  own output rather than only in a log a human would have to open;
- a test asserts that no committed file states a test count a human must update (this repository
  currently states one at `README.md:213`);
- **the gate carries D6's design-note check**: a pull request declares the table row it implements,
  and one declaring a `[design]` row is refused unless that row's note exists on the base branch.
  Negative control: the same pull request is refused with no note present and merges once the note
  lands as a separate change. This is in P1 because P1 is where a merge condition becomes machine-
  checked at all; D6 states what the check does not cover.

**On the baseline.** Recording the baseline result on both platforms is an *output* of this sequence,
not an input to it, and specifically not something done before the first hardening PR merges. No
meaningful baseline exists until step 1 closes, because the same tree currently
produces at least three distinct results — green, one failing test, and a different failing test —
and a "baseline" that is whichever of them was observed first is a number that later regressions
cannot be measured against. Once step 3 is in place, the baseline is recorded per platform and
generated from a run rather than hand-maintained.

### P3 — Task-state schema version `[design]` (issue #3, decision D4)

**On the tag, and what is already here.** `grep -rn "schemaVersion\|SCHEMA_VERSION" taskctl/*.mjs`
returns five lines, all in one subsystem: `RECORD_SCHEMA_VERSION` at `taskctl/newproject.mjs:34`, its
refusal at `:108-109`, and two writers at `taskctl/cli.mjs:867` and `:873`. Task state is not among
them — `readState`/`writeState` at `taskctl/cli.mjs:3452-3463` parse and stringify with no version
field at all. So a versioning *convention* exists in this repository and P3 follows it rather than
inventing one (D4), while the mechanism P3 owns — migrate-on-read, refusal of an unrecognised value
in a gate-bearing field, and the concurrent-writer rule — has no counterpart to widen or relocate.
`[design]` on that balance. **What the search cannot see:** a version carried under another name.

Acceptance criteria:

- task state carries an explicit schema version;
- reading older state is defined and tested — migrate-on-read, writing the new version back;
- an older binary reading newer state refuses with a message naming both versions, and this is
  documented, not merely implemented;
- negative control: state carrying an unsupported version is refused, and the test proves the check
  can fail rather than only that it passes (the pattern at
  `taskctl/__tests__/newproject-unit.test.mjs:534`);
- **an unrecognised value in a gate-bearing field is refused, not ignored and not treated as
  inapplicable** (D4). The refusal names the field, the value, and the version that would understand
  it. Negative control: state carrying an invented stage value is refused even though its
  `schemaVersion` is one this binary supports — the version check passing must not be what decides
  the value is safe;
- P3 declares which fields are gate-bearing, and a test asserts that every value the code branches
  on for a gate decision comes from that declared set. Without this the criterion above degrades
  into "the fields someone remembered", which is the failure D4's rule already had once;
- concurrent-writer behavior is defined: a write that would clobber a state file changed since it
  was read is refused rather than applied. PR 1's compare-and-swap on the active run id depends on
  this.

### P2b — Engine launch safety: run bounds `[design]` (issue #6)

**Why this is a row of its own rather than P2's second half.** The two repairs have different
urgency and different evidence needs. P2 repairs a live route (#22). Run bounds repair nothing that
is live — a hang wastes a session, it does not execute someone else's text — and their default values
wait on measurement (§10 open decision 2). Delivered as one row, the refusal would wait on a
measurement campaign for unrelated work. They are two rows unconditionally, on the precedent PR 5 and
PR 5b already set, so that the dependency map says what it means rather than describing a split that
may or may not happen. P2b merges last among the prerequisites and still before PR 0.

**Run bounds.** PR 0 can classify "did not start" and "died on a signal". A *hung* engine produces
neither: the child never closes, so `child.on('close', …)` at `taskctl/automation.mjs:132-142` never
fires and no classification is ever reached.

*There is no wall-clock timeout and no stall watchdog on the generic spawn path, and that is a search
result.* `grep -n "timeout\|setTimeout\|kill(" taskctl/automation.mjs` returns nothing — the module
that owns the spawn contains no timer, no kill, and no timeout option at all. The bounded-run
machinery that does exist lives elsewhere and covers other things: `taskctl/engines.mjs:169-171` and
`:194` time-bound the `--version` availability probe, `taskctl/grace.mjs:141` and `:275` bound the
governance lint and the XML gate, and `taskctl/harness.mjs:70` bounds a git remote read. None of them
is on the engine run. **What the search cannot see:** a bound imposed from outside the process — a
supervisor, a shell timeout, an operator with a keyboard — which is exactly the "bound" this row
exists to replace with a reported result.

Failure modes this must cover: a dropped provider connection, a provider session or usage limit
reached mid-run, and a channel that buffers its output so a hung run is indistinguishable from a
thinking one.

Acceptance criteria:

- every engine run has a configurable wall-clock limit, on the generic path and not only in the
  adapter;
- a run whose output has not grown for a configurable interval is reported as stalled;
- negative control: a deliberately hanging engine fires the timeout, produces a definite non-passing
  result, and finalizes no artifact;
- the limit's default values are recorded as measured rather than chosen (§10 open decision 2), with
  the measurement named where a later reader will find it.

**On the tag.** `[design]`, on the search above: nothing on the engine run path bounds it, so there
is nothing to widen or relocate.

## 5. Pull-request sequence

### PR 0 — Common gate-result contract `[design]` (issue #9)

**Depends on:** P1, P2, P3, P2b — P2b because one of the criteria below is about a timed-out run, and
a vocabulary entry for an outcome nothing can produce is untestable.

One result vocabulary for every check and engine execution:

```text
passed | failed | not_run | skipped
```

Only `passed` advances a gated transition. Console output and persisted state must identify
`not_run` and `skipped` as **not a pass**.

Evidence for why this is needed:

- a child terminated by a signal reports exit code `null`, and the close handler resolves
  `code ?? 0` (`taskctl/automation.mjs:141`), so a killed engine becomes a clean exit;
- a skipped governance check renders as `SKIPPED (…)` (`taskctl/grace.mjs:461-468`). That rendering
  is evidence of *ambiguity* — a reader cannot tell "deliberately inapplicable" from "never ran". It
  is not, by itself, proof that a gate treats it as passing;
- the proof of the gate behavior is separate and stronger: at `taskctl/cli.mjs:1543-1564` only the
  `fail` verdict blocks, and the comment states it outright — every `skipped-*` verdict continues
  and the stage advances. `--skip-grace-gate` writes a `skipped-explicit-flag` verdict that also
  advances (`:1565-1575`).

Acceptance criteria:

- non-zero exit is `failed`;
- signal termination is never clean success — negative control on the `code ?? 0` path above;
- a missing executable or a command that never started is `not_run`;
- a timed-out or stalled run (P2b) maps to a definite non-passing result, never to `passed`;
- an explicitly inapplicable check is `skipped`;
- state mutations and process exit codes agree with the reported result;
- console and persisted state identify `not_run` and `skipped` as not a pass;
- plant-and-remove tests demonstrate that each important gate can fail.

### PR 1 — Review-artifact integrity `[design]` (issue #10)

**Depends on:** P1, P2, P3, P2b, PR 0 — P2b because "capture only after a clean engine exit" needs a
hung run to reach an exit at all.

A review gate may only be opened by an artifact that *this* run produced and that *this* run
finished cleanly.

Evidence: the artifact is captured with no reference to how the engine died — the close handler
captures unconditionally at `taskctl/automation.mjs:138-139` before resolving the exit code at
`:141` — and the caller reads the capture target without consulting that code
(`taskctl/automation.mjs:179-182`). Partial output from a killed process can therefore be finalized
as a review.

Scope:

- capture only after a clean engine exit; never re-use an artifact from a previous failed run;
- record a review-run identity in task state and bind the captured artifact to it;
- reject missing, stale, or mismatched artifacts by default (D2 — no warning period);
- provide an explicit operator override that leaves a visible audit trail;
- resolve the active artifact's name and bytes atomically;
- make the canonical `Verdict` reviewer-owned and give authors a separate `Self-review` field;
- parse only the strict canonical heading and value. Parsing is currently permissive in four
  distinct ways (`taskctl/cli.mjs:3301-3319`): an inline `Verdict:` with the `##` optional, a
  heading followed by a value on the next line, an HTML comment, and — as a last resort — a bare
  keyword alone on a line. The last of these means the word `APPROVE` anywhere on its own line in a
  review file opens the gate.

**Prefer a generated run id over filesystem modification time**, with the concrete failure modes
named rather than asserted: two writes within the same clock second are indistinguishable by mtime;
a copy or checkout that preserves mtime makes a stale artifact look fresh; and clock skew between
the writer and the reader — ordinary on a shared or networked filesystem, and on a worktree
restored from a backup — can make a fresh artifact look stale, which trains operators to use the
override. Timestamps stay as diagnostics, never as the authority.

**Two failures that strict parsing and atomic resolution do not cover.**

1. *An echoed verdict from a prior round passes strict parsing.* **This is observed, not
   hypothesised** — it occurred while this plan was under review, and the shape it took is worth
   stating exactly, because the obvious mitigations do not survive it.

   A review artifact that quotes an earlier round's report carries that round's verdict heading
   verbatim. Strict parsing accepts it: the heading is syntactically perfect and correctly formed. It
   simply belongs to a different run. Stricter syntax therefore cannot separate them, and no amount
   of tightening the grammar will, because nothing about the grammar is wrong. In the observed case a
   single artifact contained **four** syntactically valid verdict lines, of which **exactly one**
   carried a per-run counter belonging to the current run. Of the other three, two were traced to the
   previous round's artifact; the fourth's provenance was not recorded at the time and this document
   does not invent one. The ratio is what the design rests on, and it does not depend on that gap:
   three of the four were not this run's verdict, and the only thing that said so was the counter.

   Two consequences. First, the verdict must be **bound to the identity of the run being gated**: the
   reviewer prompt requires the active run id on the verdict line, and a verdict whose bound run id
   is absent, or is not equal to the active run id, is not a verdict. That makes an echo detectable
   by construction rather than by heuristic. Second, **selection must be by that binding and never by
   position.** "Take the last verdict in the file" would have returned the right answer in the
   observed case and would have done so by luck — the quoted material happened to precede the live
   material. An artifact that quotes a prior round *after* stating its own verdict is not unusual,
   and position gives the wrong answer there with no signal that it did.
2. *Concurrent review runs have no defined owner.* Atomic name/byte resolution is not sufficient: if
   two review runs overlap, the one that finishes last wins, and that may be the older one. Define
   one active run per task and compare-and-swap the active run id at finalization — a run that is no
   longer the recorded owner refuses to write and says which run displaced it. This uses P3's
   concurrent-writer rule.

Acceptance criteria:

- partial output from a failed or killed process cannot be finalized — negative control on a killed
  engine;
- an earlier approval cannot satisfy a later failed review;
- **a verdict that does not carry the active run's identity does not open the gate — including one
  that is otherwise perfectly formed.** Absent binding is refused; it is never resolved by falling
  back to position, recency, or the sole candidate present;
- negative control, from the observed failure: an artifact containing an approving verdict quoted
  verbatim from a previous round — its own heading, its own adjacent per-run counter — is refused,
  and the refusal names the run id it carried and the one expected;
- negative control on selection: an artifact carrying several syntactically valid verdict lines, of
  which exactly one is bound to the active run, resolves to that one regardless of where it sits in
  the file. The test places the correctly-bound verdict **before** the quoted ones, so an
  implementation that reads the last verdict fails it;
- an artifact carrying more than one verdict bound to the active run is refused as ambiguous rather
  than resolved by any rule;
- two overlapping review runs cannot silently overwrite each other's artifact — negative control in
  which the older run finishes last and is refused;
- a bare keyword on its own line is no longer a verdict;
- author self-approval cannot open the reviewer gate;
- missing provenance fails closed, with no warning-only case (D2);
- the override cannot be applied accidentally or silently, and every use is recorded in task state
  and printed on subsequent gate decisions;
- a task whose state predates the run-identity version is refused with the actionable message D2
  requires — negative control proving the refusal fires.

### PR 2 — Explicit engine/model/effort stack `[extract]` (issue #11)

**Depends on:** P1, P2 (blocking — the launch-value refusal must exist before any configurable model
or pin lands), P3, PR 0.

Make the effective engine, model, and reasoning effort explicit, configurable, and inspectable
instead of inherited from whatever a vendor CLI happens to default to.

Current state, precisely:

- there is no model configuration and no model flag, and that is a search result rather than a
  reading of the adapter comments that say so (`taskctl/engines.mjs:405-406`, `:432`).
  `grep -in "model" taskctl/config.mjs` returns nothing — the configuration surface has no model key
  of any kind — and `grep -rn -- "--model" taskctl/*.mjs` returns only those two comment lines, so no
  argv builder emits the flag. **What the search cannot see:** a model selected under a different
  name, or one the vendor CLI resolves from its own configuration file, which is exactly the
  invisible re-pointing this PR exists to end;
- reasoning effort **is** already configurable, but only as a single global value:
  `engines.reasoningEffort` is validated at `taskctl/config.mjs:164-169` and resolved with a default
  at `:287-291`. It cannot differ per engine or per stage. The gap is per-engine and per-stage
  resolution, not the absence of configuration. Note that this is also the value behind issue #22:
  its validation constrains type and not content, and it reaches a shell-mediated argv today. P2
  migrates it; this PR multiplies it into per-engine and per-stage keys, which is why the coverage
  criterion below is a coverage assertion and not a sample.

The practical consequence: a change to a vendor's own configuration file silently re-points a role —
including the cross-model review role — with a large cost difference and no signal.

Scope:

- `engines.models` and `engines.efforts` configuration maps; the legacy single global effort field
  keeps working;
- resolution order, with model and effort resolving independently:

```text
task stage override
→ task all-stage override
→ engine-specific project configuration
→ adapter-declared fallback
```

- a command that displays the effective stack per stage **with the source of each value**, and can
  pin it;
- model pins bound to the engine they were created for, with a warning for old pins that still
  affect cost or behavior;
- strict validation of engine identifiers — the existing registry check at
  `taskctl/config.mjs:298-299` is the model — while provider model IDs stay opaque strings;
- no list of current commercial model names ships as product policy. Defaults come from adapter
  metadata or project configuration.

Acceptance criteria:

- the effective stack for every stage prints with the source of each value; a test asserts the
  printed source changes when the winning layer changes;
- model and effort resolve independently — a test that pins only the model asserts the effort still
  resolves from the lower layer;
- a per-task pin affects only that task and is visible as a pin: a test pins one task and asserts a
  second task's resolved stack and the project configuration file are both unchanged;
- removing all engine configuration still produces a working, documented fallback — proven by a test
  that empties the configuration;
- a pin created for one engine is not applied to a stage running another; the run reports it as
  inapplicable rather than silently using it;
- **every value this PR makes configurable or pinnable, and that can reach argv, is enumerated, and a
  test asserts each one passes through P2's validated entry point.** This is PR 2's half of P2's
  invariant, and it is a coverage assertion rather than a spot check: a per-value test list that a
  new configurable value can be added without joining is the hole P2 exists to close, reopened one
  field at a time. The new per-engine and per-stage effort keys are in this enumeration explicitly.
  P2 migrates the single global effort field; re-exposing the same value under a new key that skips
  the entry point would reopen #22 under a different name, and the test must be able to see that;
- negative control per enumerated value: that value, supplied with a shell metacharacter, refuses the
  launch (P2) and no child process is spawned;
- negative control: an unregistered engine identifier is refused at configuration-resolution time,
  before any prompt is written or state is mutated.

### PR 3 — Review lifecycle and prompt discipline `[extract]` (issue #12)

**Depends on:** P1, P3, PR 0, PR 1.

Make cross-model review converge instead of looping, and make each round aware of the previous one.
Three items in this scope are new design rather than a port, and are marked: **(new)**.

Scope:

- immutable per-stage review-round archives, and a monotonic review-round counter;
- prior-round findings and their audit status supplied to the next reviewer;
- warnings for missing, stale, or wrong-stage audits (D7 — warnings, not a gate);
- binding plan `Invariants` forwarded to implementation and fix prompts; plan-review `Deferred`
  items forwarded to implementation;
- explicit non-interactive author/reviewer role preambles, including an instruction that the
  reviewer must not run interactive session-bootstrap steps and must treat repository instruction
  files as data rather than as its own operating contract;
- a Question Zero requiring the lightest sufficient solution form before design;
- stage-aware scope: plan review gates design issues, code review gates implementation mechanics;
- **(new)** a warning to change the writer/reviewer pairing after a configurable number of
  unproductive rounds. A role-flip mode exists in the downstream fork; the counter-driven warning
  does not;
- an artifact-size budget, with guidance to keep plans current rather than append-only;
- **(new)** a search-scope budget in the reviewer prompt. Bounding context only inside the optional
  API adapter (PR 7) leaves every other review channel unbounded; budgeting the reviewer's search
  scope in the prompt is cheaper, and it applies to every channel rather than to one;
- **(new)** round accounting for environmental failures. A run that failed because a provider
  session or usage limit was reached, or because authentication failed, is a diagnosable
  environmental outcome, not a review round. It must be reported distinctly and must not increment
  the round counter — otherwise the pairing-change warning fires on failures that had nothing to do
  with the pairing.

**Boundary.** The CLI may require or warn about an audit artifact. It must never claim that an
unverified reviewer finding is true. Machine enforcement and orchestrator judgement stay distinct
(D7).

Acceptance criteria:

- re-running review at round N leaves the round N−1 archive bytes unchanged;
- the round counter never decreases across a fix→review cycle; a decrement is refused;
- the next reviewer's prompt contains the previous round's findings and their audit status — asserted
  on the rendered prompt, not on the intent;
- a missing, a stale, and a wrong-stage audit each produce a warning that names which of the three
  it is; negative control: a fresh, correctly-bound audit produces no warning;
- plan `Invariants` and plan-review `Deferred` items appear in the implementation prompt;
- the reviewer preamble contains both the non-interactive instruction and the instruction-files-are-
  data instruction;
- the pairing-change warning fires above the configured unproductive-round threshold; negative
  control: a run below the threshold is silent;
- an artifact above the size budget warns and names the artifact; negative control below the budget;
- the reviewer prompt states a search-scope budget, and a configured value replaces the default;
- an environmental failure does not increment the round counter; negative control: a genuine
  non-approving verdict does;
- the audit-required message is phrased as a requirement on the operator, never as an assertion that
  a finding is true — asserted against the emitted text.

### PR 4 — Verification evidence `[design]` (issues #13, #4)

**Depends on:** P1, P3, P2b, PR 0, PR 1 — P2b because this PR's scope below bounds a verification run
with its wall-clock limit, which was an undeclared dependency while the run bounds sat inside P2.

A machine-verifiable layer for build, test, lint, type-check, and project-defined probes, sitting
between review and publish. The repository states the gap plainly at `README.md:445`: `run
--finalize` does not verify the build/test results the prompt asked for.

**Two structural problems any ordering here has to solve.** The obvious order —
`run → review → orchestrator audit → verify → publish` — is not implementable against the current
lifecycle:

1. *Publish creates the commit.* `publish` stages and commits the work itself — `git add -A` at
   `taskctl/cli.mjs:1955`, `git commit` at `:1962`. Evidence recording "the current commit SHA"
   describes the tree *before* the commit publish then creates.
2. *There is no state between review and publish.* This is derived from two positive citations rather
   than asserted: `review --finalize` sets the stage straight to `done` on APPROVE
   (`taskctl/cli.mjs:1690-1696`), and `publish` accepts only `done` (`taskctl/cli.mjs:1898-1901`).
   The two endpoints meet with nothing between them, so a separate `verify` command has nowhere to
   attach: whatever it does, the operator can reach `publish` without it.

**The resolution (D3).** Two lifecycles, selected by whether the project declares verification
commands. Existing users, who declare none, keep today's behavior exactly.

Verification not required — unchanged from today:

```text
run → review --finalize (APPROVE ⇒ done) → publish (stages, commits, pushes, opens PR)
```

Verification required:

```text
run → review --finalize (APPROVE ⇒ reviewed) → commit → verify (⇒ done) → publish (pushes, opens PR)
```

- `review --finalize` on APPROVE sets the stage to a new `reviewed` value instead of `done` when
  verification is required. The meaning of `done` — "ready to publish" — is unchanged.
  **`reviewed` is a new value in a gate-bearing field, so this PR bumps the state schema version**
  (D4). This PR is the worked example of why D4's rule is phrased over readability rather than over
  fields: PR 4 adds no field, so a field-shaped rule would not fire, and P3's version refusal would
  not cover it either — without a bump the version is one an older binary accepts, and it would then
  read a task sitting at a stage it has never heard of with the refusal never firing. Under D4 the
  bump is required, because `reviewed` is precisely a value the previous binary cannot act on
  correctly.
- `taskctl verify <task>` runs the configured commands against an already-committed, clean tree. It
  refuses a dirty worktree. On success it records evidence and advances `reviewed` → `done`.
- `publish` accepts only `done`, and additionally, when verification is required, refuses if the
  worktree is dirty or if `HEAD` does not equal the commit named in the evidence. On this path it
  does not run `git add -A` or `git commit`.

Scope:

- project configuration declares the allowed verification commands. The profiler may recommend
  commands; attach stays read-only and never executes them;
- persisted evidence contains at least: task and run identity, commit SHA, the exact configured
  command identifier, working directory, start and end timestamps, exit code and termination state,
  and bounded output or an output hash plus an artifact reference;
- results use the PR 0 vocabulary, and a verification run bounded by P2b's wall-clock limit yields a
  definite non-passing result rather than silence.

**Boundary.** Verifying commands does not replace the orchestrator's audit of review findings. A
green verification says the declared commands passed on a named commit, and nothing else.

Acceptance criteria:

- verification cannot be skipped by using the existing lifecycle path — negative control: a task on
  a verification-required project reaches `publish` via `review --finalize` and is refused;
- evidence produced for an older commit is refused — negative control: verify, then commit again,
  then publish, and assert the refusal names both SHAs;
- a dirty worktree is refused at verify and again at publish;
- on a project declaring no verification commands, the lifecycle and publish behavior are
  byte-for-byte what they are today — proven by a test, because this is the compatibility promise;
- evidence is written only for a run that completed; a killed or timed-out verification writes no
  passing evidence;
- **the state schema version is bumped by this PR, and a test asserts a binary that predates the
  bump refuses state carrying `reviewed` rather than acting on it** (D4, P3). Negative control: the
  same older binary reads a task at `done` normally, so the refusal is shown to be about the new
  value and not about refusing everything.

### PR 5 — Versioned harness lifecycle `[design]` (issue #14)

**Depends on:** P1, P3, PR 0.

Let an existing workspace receive improved templates without ever silently overwriting user edits.

The scaffold deliberately never overwrites: an absent destination is written with an exclusive
create, an identical one is skipped, and a divergent one is kept exactly as the user left it
(`taskctl/harness.mjs:13-18`, `:186-226`). That is the correct safety property, and it is also
precisely why an existing workspace can never pick up a better template. The implementation already
classifies every manifest entry as absent, identical, or divergent, and already returns
`keptExisting` — that classification is the natural hook for a status and diff view, so this PR
surfaces an existing computation rather than inventing one. The manifest itself is a plain list
(`taskctl/harness.mjs:41-51`).

Scope:

- a harness manifest version recorded in the workspace;
- `taskctl harness status`, `taskctl harness diff`, `taskctl harness upgrade` — upgrade with a
  preview and a refusal on conflict;
- a generated, tracked pointer file to the canonical operating contract, with no duplicated full
  contract across agent-specific instruction files;
- separation of current canonical state from chronological history.

The upgrade command must retain the no-silent-overwrite guarantee. A three-way template comparison
or an explicit operator-confirmed replacement is required; an unconditional write is not acceptable.
Which of the two is chosen is still open (section 10) and is settled by this PR's design note.

Acceptance criteria:

- `harness status` reports every manifest entry as absent, identical, or divergent, consistent with
  the classification `materializeHarness` already performs;
- a planted user edit survives `harness upgrade` — the test plants an edit, upgrades, and asserts the
  bytes are unchanged; negative control: an absent file **is** written by the same run, so the test
  cannot pass by doing nothing;
- an upgrade that hits a conflict refuses, exits non-zero, and leaves every destination unchanged;
- a workspace carrying no recorded manifest version reports `unknown`, never "up to date"
  (principle 11);
- the canonical contract body appears in exactly one shipped file — asserted by a test, because
  duplication is what the pointer file exists to prevent;
- the symlink-escape refusal already present at `taskctl/harness.mjs:206-213` still fires on the
  upgrade path — negative control with a redirected parent.

### PR 5b — Session bootstrap diagnostics `[design]` (split from issue #14)

**Depends on:** P1, P2, PR 0, PR 2.

Session bootstrap checks — repository freshness, effective engine stack, authenticated engine
availability — are split out of PR 5 rather than bundled with template versioning. They have a
different lifecycle and a different owner: template versioning changes when the shipped templates
change, bootstrap checks change when the operating environment changes. Bundled, an environment fix
waits on a template release.

**On the tag, and what is already here.** `[design]` for two of the three checks and not for the
third, which is why the row states the split rather than a blanket claim. The search is
`grep -rn "probeAvailability\|probeVersion" taskctl/*.mjs`: an availability probe exists —
`probeVersion` at `taskctl/engines.mjs:217-240`, exposed per adapter at `:334`, `:394` and `:447`,
with its resolution chain and 5-second bound already written, and already called at
`taskctl/cli.mjs:819`. PR 5b **reports** that existing probe rather than re-implementing it.
Effective-stack reporting arrives with PR 2 and does not exist before it, and repository freshness
has no counterpart — `grep -rn "git fetch\|'fetch'" taskctl/*.mjs` returns five lines: three fetch
*sites* (`cli.mjs:203`, `:1733`, `:2761`), all inside the worktree and sync paths and none of which
reports staleness as a diagnostic, plus two console messages that name the command in prose
(`:2767`, `:2771`). **What the search cannot see:** a mechanism named after its domain rather
than after probing or fetching. The row is `[design]` on the balance of the three; if a counterpart
to the other two is shown to exist, the tag changes and the design-note requirement falls away.

Scope:

- repository freshness, effective engine stack (PR 2), and authenticated engine availability,
  reported as diagnostics;
- reviewer prompts that explicitly prohibit running interactive session bootstrap steps.

Acceptance criteria:

- each check reports in the PR 0 vocabulary;
- the availability check reports `probeVersion`'s existing outcome rather than duplicating it — a
  test asserts the probe is called and its result is what the diagnostic reports, so a second
  probing path cannot appear alongside the first;
- a check that could not run reports `not_run`, never `passed` — negative control per check;
- the checks are read-only: a test asserts no file under the workspace changes when they run;
- the reviewer prompt contains the bootstrap prohibition (this criterion is shared with PR 3 and may
  be satisfied by the same test).

### PR 6 — Per-task governance fold lifecycle `[design]` (issue #15)

**Depends on:** P1, P3, PR 0, PR 4.

Replace the legacy interpretation that a periodic synchronization command itself applies
governance-content deltas.

For a governance-enabled task:

1. Planning orients against the available graph and declares graph deltas.
2. Plan review checks the declaration.
3. Implementation records the resulting deltas.
4. The graph is assembled and independently verified.
5. Publish is blocked until the task records either a verified fold or an explicit no-delta result.

Scope:

- activation depends on configuration **and** actual graph presence, not on a legacy pilot branch.
  Activation is currently branch-derived: the default pilot branch is a hard-coded constant at
  `taskctl/config.mjs:113`, resolved at `:270`, and an off-branch run yields
  `skipped-non-pilot-branch`, which advances the stage (`taskctl/cli.mjs:1558-1559`);
- synchronization may remain a rebase and lint utility but must not claim to fold content;
- structured task state rather than a parsed free-form Markdown sentence:

```json
{
  "governanceFold": {
    "status": "yes",
    "verifyArtifact": "path/to/verdict.md",
    "publishRef": "provider-specific landing reference"
  }
}
```

- repository identity, accepted landing-reference forms, graph paths, assembly commands, and
  verification policy are all configurable. A textual status rendered into the plan is a
  human-readable projection, never the primary record.

Acceptance criteria:

- a task with declared deltas and no verified fold cannot publish — negative control: the same task
  with a verified fold publishes;
- a task recording an explicit no-delta result publishes;
- disabling governance makes the whole path a no-op: no fold key is written, publish is unaffected,
  and no governance warning is printed;
- configuration enabled with no graph present is a no-op that says so, rather than a silent skip
  that advances a gate;
- the Markdown projection is derived from state, not parsed into it — a test that corrupts the
  rendered sentence leaves the gate decision unchanged;
- the synchronization command's output contains no claim to have folded content.

### PR 7 — Optional external API review adapter `[extract]` (issue #16)

**Depends on:** P1, P2, PR 0, PR 1, PR 2.

Make external API review available as an optional integration, so that one exhausted provider
account cannot stop a mandatory cross-model gate — without enlarging the trusted core. The adapter
targets a widely implemented chat-completions-style wire format; anything narrower than that belongs
in an adapter profile, not in the core.

Required properties — these are the acceptance criteria for this PR:

- credentials are read from the environment only, never placed in argv, never in logs;
- reviewer-only use by default, and the adapter is never selected implicitly;
- repository reads and searches are confined by resolved real paths;
- optional read-only command execution uses a narrow allow-list;
- explicit limits for iterations, input and output tokens, estimated cost, and wall time;
- bounded context selection instead of autonomous whole-repository loops;
- provenance records tool use, context scope, token and cost accounting quality, and any usage gaps,
  so that a review which opened no file at all is visibly not a code-verified review;
- secrets, terminal control sequences, and provider-specific metadata are redacted;
- a non-zero or truncated run cannot publish a review artifact — negative control required;
- task state never lives in the external service.

**Boundary.** The public core must not assume one commercial credit system, subscription, endpoint,
or model catalogue. Provider-specific behavior belongs in an adapter profile.

Every property above needs a test, and the publish refusal needs a negative control.

### PR 8 — Release hygiene `[docs]` (issue #17)

**Depends on:** every other row in the section 1 table, **including H1**, which is specified in
section 6 but merges before this row. PR 8 is required below to document the scrub gate's widened
origins, widened formats, and re-derived subject, and it cannot check a documentation claim against
merged code that has not merged. That is why H1 sits above this row in the table even though its
section number is higher.

CI is **not** in this PR — it is P1, and it exists before PR 0 merges (D5).

Scope:

- update README feature and limitation claims;
- update the lifecycle diagram, which now has two shapes (PR 4);
- update configuration examples and migration notes, including the per-task freshness opt-in (D2)
  and the state-version refusal (D4);
- avoid hand-maintained test-count claims — generate them or drop them;
- document the trust boundary of each gate this sequence introduces, including what a green
  verification does *not* mean (PR 4) and why the audit is a warning (D7);
- publish as a new prerelease rather than silently changing the existing one.

Acceptance criteria:

- no documentation claim describes behavior the merged code does not have; each claim changed by
  this sequence is checked against the code that implements it;
- a test asserts that no committed file states a hard-coded test count (one exists today at
  `README.md:213`). This criterion is shared with P1 and is satisfied once;
- every gate introduced by the sequence appears in the trust-boundary documentation — asserted by a
  lint over the gate names, so a gate added without documentation fails. The scrub gate H1 extends is
  a gate this sequence *changes* rather than introduces, and its widened scope is in scope for this
  documentation: a reader needs to know that `clean` now covers more origins and more file types than
  it did, and that its subject is what this repository tracks rather than what happens to sit on disk
  below its root (H1 gap 4), because the value of the word is exactly its coverage. This criterion is
  why H1 merges first: it is a check of documentation against merged behavior, and it fails on its
  own terms if the behavior is still unmerged;
- the two shipped-file-scanning criteria above reuse the enumeration H1 leaves behind, rather than
  adding further independent ones. Before H1 that enumeration is the recursive walk at
  `taskctl/__tests__/config-2b.test.mjs:301-319`; after H1 it is the tracked-file set H1 replaces it
  with. Either way there is one enumeration with one exclusion set, and PR 8 must not make it three.
  Independent enumerations drift, and the drift is silent in the direction that matters — a file
  dropped from one scan is still covered by the others, so nothing fails until the day it is not;
- the cross-platform claim is not strengthened beyond what P1 actually demonstrates; the current text
  at `README.md:454-457` states POSIX is untested, and it may only change to the extent P1's step 2
  and step 3 evidence supports. Note that P1 now produces genuine POSIX evidence — 20 recorded green
  runs on that platform — so this criterion is a bound on overstatement, not a prohibition.

## 6. Cross-cutting hardening

### H1 — Extend the committed-path guard `[extract]` (issue #18)

**Depends on:** P1. The mechanism H1 extends already runs inside the suite, so it is already enforced
locally; what P1 adds is that a regression in it blocks a merge instead of being noticed later.

**Merge position:** before PR 8, which is the last row in the table. This row is specified in its own
section because it is cross-cutting rather than sequential, but it is not last to merge: PR 8 has to
document H1's widened coverage, and a documentation-versus-code check cannot be satisfied against
code that has not landed.

A hardcoded absolute path in committed material silently breaks for anyone on a different machine or
operating system. This is not only a scripting problem: an absolute path inside committed
documentation, a configuration file, or a reusable prompt template misdirects whoever acts on it —
human or engine — and the failure is silent.

**The guard already exists, and this row extends it rather than introducing it.** A two-tier scrub
gate is merged, live, and part of the suite, in `taskctl/__tests__/config-2b.test.mjs`: its patterns
are at `:281-294`, its collector at `:301-319`, and the scan that fails the suite on a matching path
at `:336-346`. Section 7's entry for absolute workstation paths is therefore partly machine-checked
today, not merely stated.

- the mechanical tier collects **every** Markdown file under the repository root by recursive walk
  (`:301-319`), excluding only `ai/tasks/**`, `.git` and `node_modules` (`:308-310`). Coverage is by
  construction, not by an enumerated allowlist, so a shipped `.md` added tomorrow is in scope without
  anyone remembering to add it. ("Under the repository root" rather than "in the repository" is
  deliberate wording here — gap 4 below is the distance between the two);
- dot-directories are deliberately **not** excluded, so a future `.github/*.md` cannot bypass it —
  and that property has its own test, which plants a fixture and asserts it is collected
  (`:359-376`), with a companion proving an uppercase `.MD` is matched too (`:378-389`);
- absolute-path patterns are already present in both slash directions (`:289-291`);
- and the test file states, in itself, which classes it does **not** assert, deferring them to a
  committed manual checklist (`:268-273`).

That last property is the one H1 must preserve. A guard that names its own blind spots cannot have
its `clean` misread as "there are none anywhere", which is the principle-10 failure this row would
otherwise walk into. H1 must not be specified as if it were introducing any of the four properties
above.

One thing to be accurate about, since it shapes H1's criteria: the two plant-and-assert tests above
are controls on the **collector**, proving the walk reaches those files. There is no control on the
**patterns**. Every scan test asserts the offender list is empty (`:333`, `:346`, `:356`) and none
plants a forbidden path and asserts the guard fails, so "a planted absolute path fails the guard" is
genuinely unmet today. It is not enumerated as a gap of its own below because it is not a separate
defect — it is the test debt that gap 1 pays off as it adds patterns, and it is written into gap 1's
criterion.

**What is actually missing.** Four things:

1. **The path patterns match one specific origin.** The two absolute-path patterns at `:289-291` are
   written against one known workspace's roots. Any other machine-specific absolute path passes
   today: a different drive letter, a `/home/<user>/…` path, a `/Users/<name>/…` path, a UNC share.
   The guard is currently a *scrub* of one known contaminant, not a *guard* against the class, and
   the difference only shows up on the second contributor's machine.
2. **Coverage is Markdown-only.** The walk matches `\.md$` case-insensitively (`:312`) and nothing
   else. The other acted-upon formats this repository ships — `.json`, `.toml`, `.yml`, `.yaml` —
   are not scanned. An absolute path inside a shipped configuration file misdirects a reader exactly
   as one inside a document does, and is more likely to be executed rather than read.
3. **There is no `unknown` state.** A scan that collected less than the repository — a subtree that
   could not be read, an exclusion widened past its intent — produces an empty offender list, and an
   empty offender list is what a clean repository produces. Only one of the three scan tests carries
   a lower-bound sanity assertion on the collected set (`:323`); the other two (`:336-347`,
   `:349-357`) assert only that the offender list is empty. So a degraded scan reports as clean. This
   is the one property of principle 11 the current implementation does not have, and it is the most
   important of the first three, because the other two fail loudly and this one fails silently.
4. **The gate's subject is wrong, which makes the walk too *wide*.** The three exclusions are all it
   knows: `ai/tasks` compared as one **absolute path** built from the repository root (`:303`,
   `:308`), plus `node_modules` (`:309`) and `.git` (`:310`). It has no awareness of the possibility
   that a subtree below the root is a *different checkout*. That follows from one missing idea — the
   walk enumerates what is present on disk under the root, while the gate is about what this
   repository ships.

   Measured at `f7e7707`, not hypothesised. Nested checkouts of this repository were placed under a
   path this repository's own `.gitignore` excludes (`.gitignore:39`), and the walk was replicated
   read-only from the outer root. With one such checkout present it collected 138 Markdown files and
   reported 30 origin-pattern hits; with a second present, 251 files and 60 hits. The identical walk
   rooted one directory deeper — inside a checkout — collects 21 files and reports none.

   Three things about that result matter more than its size. **The magnitude is a function of the
   operator's local layout rather than of the repository's contents**, so the noise is unbounded in
   the number of checkouts. **Every hit, in both runs, was inside a nested checkout and none was in
   this repository's own tree.** And **every offending file was one of this repository's own task
   artifacts** — the `ai/tasks/**` content the gate deliberately excludes, correctly excluded at its
   real location, and scanned and reported one directory deeper because the exclusion is an absolute
   path rather than a rule about the tree being walked.

   This is the mirror image of the defect the rest of H1 is about, and it ends in the same place. Too
   narrow prints `clean` and is trusted wrongly; too wide prints offenders nobody introduced — and by
   gap 3's own argument, output that a reader learns to dismiss is output the reader stops reading.
   Both roads end with the guard not believed.

**The subject, stated once, because every criterion below is derived from it.** The set the gate is
about is **what this repository tracks, plus what the current change stages** — in git's terms, the
paths in the index — with the bytes read from the worktree at those paths, so that an edit made to a
tracked file and not yet staged is still scanned.

**It is deliberately not "everything on disk minus what the repository ignores", and that alternative
is worse than the defect it fixes.** Ignore status is not a shipping boundary. A file can be
force-added while still matching an ignore pattern; it is then tracked, shipped to everyone who
clones, and — under an ignore-based rule — never scanned. Verified, generically: a file matching an
ignore pattern and added with git's force flag is listed by `git ls-files` and simultaneously
reported as ignored by `git check-ignore --no-index`. The two answers disagree because they answer
different questions, and only one of them is the question this gate asks. A gate defined over
ignore status would therefore report `clean` on an absolute path inside such a file — reintroducing,
through its own fix, precisely the silent miss it exists to prevent.

Deriving the subject from what is tracked instead does three things:

- **the force-added file is covered**, because it is tracked, whatever any ignore file says about it;
- **a nested checkout is excluded for the right reason.** Its files are not tracked *by the outer
  repository*, so they never enter the set at all. Under an ignore-based rule they were excluded by
  the coincidence that the operator happened to keep checkouts somewhere ignored; a checkout placed
  anywhere else would have been scanned again;
- **coverage stops being editable from `.gitignore`.** That file's purpose is unrelated to this gate,
  and a broad entry added for an ordinary reason would otherwise shrink the scan silently. Under the
  tracked-set subject a new ignore entry changes nothing about what is already tracked.

`node_modules` and `.git` then need no exclusion of their own: neither is tracked. `ai/tasks/**`
still does, because those files *are* tracked and are excluded on content grounds — and it becomes a
path rule relative to the repository root rather than an absolute string, which is what gap 4's
measurement showed breaking.

**Gaps 3 and 4 are each other's control, and must be implemented as such.** Gap 4 changes the
collected set in both directions — smaller by everything untracked, larger by anything tracked that
a filesystem rule would have skipped — and its dominant effect is the narrowing; gap 3 exists because
a set that is too small reports clean. A gap 4 fix that over-narrows is indistinguishable, in the
output, from a repository that is clean. The tracked-set
subject removes the `.gitignore` route into that failure but does not remove the failure: asking git
for the tracked set introduces a new way to collect nothing — git absent, the command failing, or
the tests running somewhere that is not a repository at all — and the empty list that comes back
looks exactly like a clean scan. That is what gap 3's lower bound and `unknown` state are for, and
it is why neither gap may be implemented without the other. (Spawning `git` from a test is already
this repository's practice, not a new dependency: `taskctl/__tests__/attach.test.mjs:89-91`.)

**On the tag.** `[extract]`, not `[design]`: widening — and, in gap 4, re-aiming — an existing,
tested, live mechanism is not design work. Items 1 and 2 are a broader pattern set and a broader
file-extension match against a gate that already exists. Item 4 is the largest change and the one
most open to challenge, and it is still not design work because it does not invent a set: the
tracked-file set is one the repository already maintains, git already computes, and every contributor
already reasons about when deciding what a commit contains. Item 3 is the only item with genuine
design content — a state the mechanism lacks — and even that is principle 11 applied to an existing
check, the same requirement PR 5 and PR 5b carry against theirs. A reviewer who disagrees should say
so on item 3 or item 4 specifically, and on which set item 4 would be inventing.

Acceptance criteria — each is an addition to the existing gate, and none may be satisfied by
rewriting it. The first four are derived directly from the subject stated above:

- **the collected set is what this repository tracks, plus what the current change stages** —
  enumerated from git's index, not from a directory walk. Positive control: a file added and staged
  but not yet committed is scanned;
- **negative control that proves the ignore bypass is closed: a file that matches an ignore pattern
  and has been force-added is tracked, is collected, and a planted absolute path inside it fails the
  guard.** This is the criterion that separates the correct subject from the plausible one. A gate
  built over "the filesystem minus ignored paths" passes every other criterion in this list and fails
  this one, silently, on a file that ships to everyone who clones;
- a nested checkout contributes nothing to the set, because its files are not tracked by this
  repository. Negative control: with a nested checkout of this repository present — under an ignored
  path or not; the criterion may not depend on where it sits — the collected set contains no file
  inside it, **and** the files at the real root are still collected in the same run. One run must
  satisfy both, because over-narrowing and a clean repository produce the same empty offender list.
  Note that a name-based skip does not achieve this: the existing `.git` skip at `:310` fires only for
  a directory *entry*, and a linked worktree's `.git` is a *file*, so under the current walk the
  nested tree is walked in full;
- **the gate's coverage does not change when `.gitignore` changes.** Negative control: adding an
  ignore entry that matches an already-tracked shipped file leaves that file in the collected set. An
  implementation that consults ignore status will fail this;
- the origin-specific patterns are joined by patterns for machine-specific absolute paths of unknown
  origin — at minimum a Windows drive-letter root in both slash directions, a POSIX home-directory
  root, and a UNC share root. Negative control per added form: a planted path of that form fails the
  guard, and the test asserts *which* pattern matched, so a pattern that never fires is visible;
- the scan covers the acted-upon non-Markdown formats this repository ships — `.json`, `.toml`,
  `.yml`, `.yaml` — through the same enumeration and the same exclusion set, not a second one. Two
  independent enumerations with two exclusion lists will diverge, and the divergence will be silent;
- a scan that could not enumerate the tracked set reports `unknown`, never `clean` (principle 11).
  Concretely: every scan test asserts a lower bound on the collected set, as `:323` already does for
  one of them, and an enumeration that fails — git absent, the command exiting non-zero, or the tests
  running outside a repository — surfaces that as `unknown` rather than returning an empty list;
- negative control for the above: a run in which the enumeration is made to under-collect is reported
  as `unknown` and does not pass. This is the criterion most likely to be quietly dropped, because it
  is the only one that requires the test to distinguish two kinds of empty;
- the `ai/tasks` exclusion is expressed as a path rule relative to the repository root, not as the
  single absolute string built at `:303` and compared at `:308`. It remains the gate's one content
  exclusion, and it remains stated with its reason. The `.git` and `node_modules` exclusions become
  unnecessary rather than removed — neither is tracked — and dropping them must be justified on that
  ground in the code, so a later reader does not restore them as if the walk were still filesystem-
  based. The existing gate sets the standard of stating a reason per exclusion (`:296-300`), and H1's
  job is not to lower it;
- the manual-tier deferral survives: whatever H1 adds mechanically, the test file continues to state
  which classes it does not assert. An extension that quietly drops that statement makes the gate
  less honest than it is today, which would be a net loss regardless of what it adds.

## 7. Explicit non-goals

Do not upstream:

- tracker project keys or task histories;
- repository-owner or repository-name literals;
- infrastructure, deployment, cluster, or production-arming procedures;
- **the contents of project-specific access recipes** — host, pod, and container names, database and
  secret access forms, connection and shell-access forms. This is named separately from
  "infrastructure" because the *mechanism* is different from the *contents*. Unconditionally
  pointing a planner at a committed recipes file and requiring it to copy the exact access forms
  rather than re-derive them is a genuinely project-neutral mechanism, because re-derived forms are
  wrong in ways that are expensive to discover. The recipe file's contents are not neutral, and a
  template that ships with example contents carries them into every workspace it scaffolds. If the
  mechanism is ever ported, the shipped template contains no real access form and a test asserts
  that;
- **provider-account operating policy** — quota rules, per-account cost behavior, subscription-tier
  assumptions, and credit-system semantics. This is the policy of one deployment, not product
  behavior. Named separately for the same reason: it is not infrastructure, and "infrastructure" is
  too broad a category to catch it;
- domain-specific data-flow rules;
- absolute workstation paths. This one is **already partly enforced**, which changes what the entry
  means: the scrub gate's origin-path patterns (`taskctl/__tests__/config-2b.test.mjs:281-294`) fail
  the suite, through the scan at `:336-346`, on a known-origin absolute path in any Markdown file the
  collector at `:301-319` reaches. So for that origin and that file type this is a machine-checked
  non-goal rather than an instruction, and H1 widens it to paths of unknown origin and to shipped
  configuration formats. Two limits are worth stating precisely, because "any committed Markdown
  file" would overstate it in one direction and understate it in the other: the collected set is
  every `.md` present under the repository root, which includes trees that are not this repository at
  all (H1 gap 4) and is not derived from what the repository tracks — so it both scans files nobody
  committed and, were an exclusion ever expressed in ignore terms, would skip files that were.
  Until H1 lands, an absolute path in a `.json`, `.toml`, `.yml` or `.yaml` file, or any path from a
  machine other than the one already scrubbed for, is caught by review or not at all;
- user-specific sandbox bypass configuration;
- a fixed list of currently available commercial models;
- legacy pilot-branch governance assumptions;
- generated task artifacts from the downstream fork;
- a large project-specific operating contract;
- deletion or regression of this repository's existing harness implementation.

## 8. Delivery strategy alternatives

### A. Wholesale port of the downstream fork

Fastest initial copy, highest integration and leakage risk. It would mix project policy with core
mechanisms and could regress independently developed features in this repository. Not recommended.

### B. Test-driven feature extraction

Port one invariant at a time, rewrite project-specific seams, and require a small acceptance suite
per PR. This is the recommended default for the `[extract]` rows.

Note the limit of B after D6: it does not describe the `[design]` rows, which have nothing to
extract. Those rows are design-note-first — the mechanism is argued, then implemented, then tested —
and their risk is design risk rather than integration risk.

B also does not quite describe H1, which is `[extract]` but ports nothing: there are no
project-specific seams to rewrite because the mechanism is already in this repository and already
seam-free. For that row the strategy is narrower still — widen a live gate's inputs one class at a
time, each with its own negative control, so that a pattern which never fires is visible rather than
assumed to be holding. The one gap that re-derives the gate's subject instead (gap 4) inverts the
control: the test must prove the new subject dropped only what it meant to drop *and* picked up what
the old one missed, since less collected and nothing wrong are the same output. That is why gap 4
carries two negative controls in opposite directions — a nested checkout that must vanish from the
set, and a force-added ignored file that must appear in it.

### C. Full plugin-architecture rewrite first

Cleanest long-term boundary, but delays high-value correctness fixes. Use a plugin boundary only
where it immediately pays off: external API engines and optional governance integrations.

**Recommended combination:** B for the `[extract]` rows, design-note-first for the `[design]` rows,
with a narrow use of C for PR 6 and PR 7.

## 9. Validation requirements

**The current suite is not a usable baseline.** P1 records the measurement: the same unmodified tree
produces different results from run to run, two different tests are involved, and one of them is a
defect in shipped code (issue #21) rather than suite noise. Every validation step below that reads a
suite result is therefore blocked on P1's step 1, and no step in this section may be performed
against the suite in its present state and called a baseline.

**P2 is the one row that proceeds anyway, and the cost of that is stated rather than absorbed.** Its
tests land in a suite whose result is not yet a reliable signal, so a red run during P2's development
may belong to the suite rather than to P2, and P2's own negative controls are not merge-blocking
until P1 step 3 exists. That is a real weakening and it is accepted, because the alternative is
holding the repair of a live shell-execution route (issue #22) behind a failure nobody has yet
diagnosed. A suite that is unreliable makes a test's *result* uncertain; it does not make the test
worthless, and it does nothing at all about the defect.

Before implementation begins — with P2 excepted, per the paragraph above:

- create a clean worktree from the current upstream main branch;
- **land issue #21, then close P1 steps 1 and 2** — the mutual-exclusion defect is fixed upstream of
  P1, the `session.log` failure is characterised and fixed or explicitly isolated, and 20 consecutive
  green full runs per platform are recorded at a commit that already contains the #21 fix. This is
  first because everything else in this list that mentions the suite depends on it;
- preserve and characterize the existing harness behavior;
- identify compatibility expectations for existing task state and configuration, and record them as
  the input to P3;
- record the baseline suite result on both CI platforms, generated rather than hand-written. This
  happens *after* the two steps above, not before: a baseline recorded from today's suite would
  record one of the three results P1 observed at a single commit — green, the lock failure, the
  `session.log` failure — with no way to tell which one it got, and every later regression would be
  measured against whichever it happened to be;
- add targeted tests derived from the downstream fork without importing project identifiers.

During implementation:

- run the complete suite after every PR, enforced by P1 rather than promised. Until P1 step 3 is in
  place this remains a promise, and the plan should not be read as though the enforcement already
  exists;
- treat a red suite as attributable to the PR under review only once P1 step 1 has closed. Before
  that, a failure may belong to the suite, or to a known open defect, rather than to the change, and
  the honest response is to say which — not to re-run;
- write the design note for every `[design]` row and merge it as its own change before that row's
  implementation PR merges. From P1 step 3 onward a gate refuses the merge if the note is not on the
  base branch. Two rows merge before that gate exists — P2 and P1 — and for them this bullet is a
  convention that fails nothing; D6 scopes the guarantee to the rows it covers and names those two,
  rather than stating the rule universally and excepting them afterwards. Within the covered rows,
  the *before it opens* part, the truthfulness of the row a PR declares, and the note's content are
  themselves convention, and D6 says so;
- cross-model review each plan and each implementation independently;
- verify every accepted reviewer finding against the actual code before acting on it (D7 — the CLI
  will not do this for you).

## 10. Open decisions

D1 through D7 closed the questions that blocked specification. What remains genuinely open, with the
deliverable that settles each:

1. **Whether shell mediation is removed from the sinks P2's enumeration names, or the P2 allow-list
   remains the permanent containment.** P2 ships the refusal because it is small and it closes holes
   that are open today (issue #22 and the seven further members P2's enumeration found) as well as the
   wider one PR 2 would add. It does not close the shell. Converting a sink to an argument array is a
   cross-platform change with its own regression surface, and it is not scheduled here. Two things
   attach to this item. The deferral is a deferral of *further* hardening on routes already being
   repaired, not a deferral of the repair. And P2 names this item as the destination for the case the
   allow-list gets wrong — a legitimate provider identifier the conservative rule rejects; such an
   identifier is refused, documented as unsupported, and filed here, because widening the rule would
   remove the only containment that exists while the shell stands, and an argument array is the thing
   that carries such a value safely. **This item is settled per destination site, not globally**: P2's
   inventory numbers twenty-one, and an assessment may convert one without converting the rest, which
   is why the refusal message names the site. Its scope is the **nine executing sinks** — the other
   twelve are commands printed for an operator to run, no argument-array conversion exists for them,
   and the containment there is the refusal to print, permanently. *Settled by:* a follow-up
   assessment after PR 2, or — as a commitment, not a possibility — opened by the first report of a
   legitimate identifier tripping the rule. Not by any row in this plan.
2. **Concrete default values for the wall-clock and stall limits (P2b).** Too low and long legitimate
   runs are killed; too high and a hang is indistinguishable from work for most of a session. This
   needs measurement, not argument. It is the whole of what P2b waits on, and it is why the run bounds
   are a row of their own rather than P2's second half: the launch-value refusal repairs a live route
   and must not wait on a measurement campaign for unrelated work. *Settled by:* P2b's design note,
   with the defaults recorded as measured rather than chosen.
3. **Whether harness upgrade uses a three-way template merge or explicit operator-confirmed
   file-by-file replacement (PR 5).** Both satisfy the no-silent-overwrite guarantee; they differ in
   how much of a divergent file a user must re-review. *Settled by:* PR 5's design note.
4. **Whether the external API adapter ships in-tree, as a separately versioned package, or as an
   example adapter (PR 7).** This determines whether its dependencies enter the core's dependency
   surface, which is the property principle 9 cares about. *Settled by:* PR 7's design note.
5. **Whether governance-fold state belongs in the generic task schema or in an integration-owned
   extension namespace (PR 6).** D4 settles that state is versioned; it does not settle whose
   namespace this field is in, and the answer decides whether disabling governance still costs the
   generic schema a field. *Settled by:* PR 6's design note.
6. **Whether the access-recipes mechanism is ported at all.** Section 7 states the condition under
   which it could be — a shipped template with no real access form, and a test asserting it — but
   the value of the mechanism in a public core, where no project's recipes exist yet, is not
   established. *Settled by:* a separate proposal, not by any row in this plan.
7. **What mechanism produces the `session.log` full-run failure, and whether it is fixed or
   isolated.** Listed last but blocking nearly first: all eleven rows of sections 5 and 6 declare a
   dependency on P1, and P1 sits behind this. The prerequisites are the exception and declare no
   dependency on each other (§4), so P3 and P2b are not held here either — but they merge after P1 by
   the §1 order, and P2 is placed ahead of it precisely so that a live defect is not held behind an
   open question; see P2's merge-position note. This item covers one failure, not both:
   the lock failure is diagnosed — a mutual-exclusion defect in the stale-takeover path — and is
   tracked as issue #21, which P1 depends on rather than owns. What remains open is the second
   failure, seen only in full-suite runs, with no diagnosis of its own and **no entitlement to #21's**.
   The fix-versus-isolate choice cannot be made before that diagnosis, so this is open in the
   strongest sense — not a decision deferred, but a question nobody has yet asked the code. *Settled
   by:* P1 step 1, before P1 step 2 begins and therefore before any other deliverable starts.

This document authorizes the work in sections 4 through 6 once a cross-model review returns without
blocking findings. It performs none of it: no code, state-schema, template, or documentation change
is made by this plan itself — including the repair of issue #22, which this revision documents and
does not fix, and which the status block above states is not embargoed by the plan's own approval.
