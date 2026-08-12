# H1 — extend the committed-path guard (issue #18)

All changes are in `taskctl/__tests__/config-2b.test.mjs`, the T4-scrub section. No new files, no
new dependencies (Node built-ins only: `node:child_process` spawnSync, alongside the existing
`node:fs`/`node:path`). The two-tier structure (mechanical scan + deferred manual checklist) is
unchanged; the manual-tier "this test does NOT assert the manual classes absent" statement is
still in the header comment and its companion-file test is untouched.

## What changed, per gap

**Gap 1 — origin-unknown patterns.** `SHIPPED_DOC_PATTERNS` gains four entries: `windows-drive-root`,
`posix-home-root`, `macos-home-root`, `unc-share-root`. Each excludes `<`/`>` from its tail so
illustrative prose like `/home/<user>/…` (used by the plan document itself) isn't mistaken for a
real path — verified against all 25 currently-tracked shipped files with zero false positives
before landing the patterns.

**Gap 2 — format coverage.** `SHIPPED_EXT_RE` now matches `.md`, `.json`, `.toml`, `.yml`, `.yaml`
(case-insensitive), applied inside the same `collectShippedDocs()` — one enumeration, one
exclusion, no second walk. Confirmed against the real repo: 25 files collected, of which
`.gitleaks.toml`, `taskctl.config.example.json`, `taskctl.config.json`, `taskctl/package.json` are
the newly-in-scope non-Markdown files (verified clean by both the FORBIDDEN-literal and
pattern-regex scan tests).

**Gap 3 — `unknown` state.** `gitTrackedFiles(root)` returns `{ ok: true, files }` or
`{ ok: false, reason }` (mirrors `profiler.mjs`'s `gitRead` shape) instead of throwing internally.
`collectShippedDocs()` throws when `ok` is false, so a broken enumeration fails the calling test
rather than silently returning `[]`. The two scan tests that lacked a lower-bound assertion
(origin-pattern regex, Cyrillic) now have one, matching the FORBIDDEN-literal test's existing
`targets.length > 3`.

**Gap 4 — subject re-derivation.** `collectShippedDocs(root = ORCH_ROOT)` now enumerates via
`git ls-files -z` instead of a directory walk. The `ai/tasks/**` exclusion is a prefix check on the
git-relative path (`rel.startsWith('ai/tasks/')`) rather than the old absolute-path string compare.
`node_modules` and `.git` exclusions are dropped — neither is ever tracked, so nothing restores
them as if the walk were still filesystem-based. The two existing collector controls (dot-directory
inclusion, uppercase-extension match) now `git add` their fixture before asserting collection and
`git reset` it in `finally`, since the subject changed from "present on disk" to "tracked/staged" —
the assertions themselves are unchanged, only what makes a fixture eligible.

`findPatternOffenders()` was factored out of the inline loop in the origin-pattern test so the new
planted-offender tests reuse the exact same scan, rather than a second copy that could drift.

## Demonstration: each new/strengthened test fails against the pre-H1 guard

Self-audit requires this be demonstrated, not asserted. I extracted the pre-H1
`collectShippedDocs`/`SHIPPED_DOC_PATTERNS` verbatim from `git show HEAD:...` into a scratch
harness and replayed each new test's core assertion against it:

```
REGRESSION-DETECTED :: gap1: windows-drive-root pattern exists :: FAILED-under-old (good)
REGRESSION-DETECTED :: gap1: planted UNC-share path caught :: FAILED-under-old (good): no unc-share-root offender found
REGRESSION-DETECTED :: gap2: .json fixture with planted path is collected+caught :: FAILED-under-old (good): .json fixture not collected (old walk is .md-only)
REGRESSION-DETECTED :: gap4-important: force-added ignored file — offender detected :: FAILED-under-old (good): collected=true but offender NOT detected (no unc-share-root pattern)
REGRESSION-DETECTED :: gap4: nested checkout contributes no offenders :: FAILED-under-old (good): nested checkout file(s) DID leak into the old collected set: 1 file(s)
REGRESSION-DETECTED :: gap3: assert.throws(() => collectShippedDocs(notARepo), /unknown/i) :: FAILED-under-old (good): old collectShippedDocs did NOT throw
```

One honesty note on the gap-4 "important" control: it fails against the *actual* pre-H1 code, but
not for the reason it's designed to guard against. The old fs-walk has no ignore-awareness at
all, so it *already* picks up a file under `.tmp/` regardless of git status — it's too wide, not
too narrow, in that specific dimension. The test fails against old code because the old code lacks
the `unc-share-root` pattern, not because of a coverage gap. Its real job — separating the correct
subject (tracked+staged) from the plausible-but-wrong one (filesystem minus ignored paths) — is a
control against a fix nobody has written, not against today's code; I verified this by reasoning
through what an ignore-based `collectShippedDocs` would do (exclude the force-added file, miss the
planted path) rather than by running one, since building a second, wrong implementation just to
watch it fail felt like manufacturing evidence for its own sake.

The nested-checkout test is the one that demonstrates gap 4's actual defect directly: the old walk
leaked exactly 1 file from a live nested checkout into its collected set, matching the plan's own
`f7e7707` measurement in kind (smaller in magnitude only because this repo doesn't already have a
stray checkout sitting under `worktrees/`).

I did not build an equivalent demonstration for `gitTrackedFiles` in isolation (the "two kinds of
empty" test) — that function doesn't exist in the pre-H1 file at all, so calling it there is a
`ReferenceError`, which is a true but not very illuminating failure mode.

## Self-audit

**Does every new test fail against the current unfixed guard?** Yes, demonstrated above for all
six new/behavior-changing controls (gap1 ×2, gap2, gap4 ×2, gap3). The two strengthened tests
(added lower-bound assertions) and the two retrofitted collector-control tests
(dot-dir/uppercase-ext) aren't "new failures" in the same sense — they're existing assertions kept
valid under the new subject, which is the point: staging the fixture is required precisely because
the subject is no longer "present on disk".

**Is there a file type a reader acts on that I still do not scan?** Yes, two: `.tmpl` template
files (`ai/templates/*.tmpl`, `templates/harness/**/*.tmpl`) and `.sh`/`.ps1` scripts
(`templates/harness/grace/check-freshness.sh`, `templates/harness/ops/session-state.sh`). `.tmpl`
under `ai/templates/` is scanned by the *other*, older tier (`collectScrubTargets`/T2b-int-grep) for
the FORBIDDEN-literal and Cyrillic lists only — not for absolute-path patterns, and not at all for
`templates/harness/**`. `.sh`/`.ps1` are scanned by neither tier for anything. I left these out
because the plan's gap-2 criterion names exactly `.json`/`.toml`/`.yml`/`.yaml`, and widening
further risks false positives in source-like content (shell scripts and templates legitimately
reference relative paths and shell variables in ways `.md`/config files don't) without a stated
criterion to bound it. I checked by hand: none of the 8 currently-tracked `.sh`/`.tmpl` files
contain a literal matching any of the four new patterns, so this is a real but currently-latent gap,
not a live leak. Worth a follow-up row, not a silent scope creep into this one.

**Does any test of mine pass for a reason other than the one it claims?** Checked each for
coincidental-match risk: the planted-offender assertions (`offenders.some(o => o.includes(label))`)
rely on zero pre-existing hits for the new labels across the real tracked set, which I verified
directly (a standalone sweep of all 25 files against all four new patterns, zero matches) before
relying on it — so a hit can only come from the planted fixture. The nested-checkout assertion
matches on the fixture's own absolute path prefix (pid-scoped, unique per run), not a label, so
there's no coincidental-match surface there. The `gitTrackedFiles` empty-repo comparison is an exact
`deepEqual` against `{ ok: true, files: [] }`, not a truthiness check.

## Noticed, not fixed

- `docs/methodology/scrub-checklist.md:3-4` still describes the mechanical tier as scanning "all
  `**/*.md` repo-wide" via `collectShippedDocs()`. That's now incomplete (subject is tracked+staged,
  formats include config files too). Per the plan's own sequencing, this documentation update
  belongs to PR 8, which depends on H1 merging first for exactly this reason — I left it alone
  rather than doing PR 8's job piecemeal.
- The header comment above `collectShippedDocs()`'s old home still references
  `ai/tasks/WP4-skills-methodology/WP4-scrub-checklist.md`, which doesn't match the actual checklist
  path used by the companion-exists test (`docs/methodology/scrub-checklist.md`). Pre-existing,
  unrelated to this change — left as found.
- See the `.tmpl`/`.sh` gap above.

## Verification

`node --test __tests__/*.test.mjs` from `taskctl/`, three consecutive runs: **346/346, 346/346,
346/346**, no failures, no flaked test. The `config-2b.test.mjs` file alone: 29/29. `git status`
after every run confirms no leftover staged fixtures or stray files — all new tests clean up via
`try/finally`.

## Self-review: APPROVE
