/**
 * WP2 Stage 2b — config externalization + engine + scrub unit tests.
 *
 *   T2b-unit-1     : extended config defaults + overrides + validation.
 *   T2b-unit-2     : guessCodeAreas generic stub + context sections via ctxOpts;
 *                    project sections omitted when empty, emitted when set.
 *   T2b-unit-3     : exported pure buildLaunchCommand (NOT the private launchCmd).
 *   T2b-int-grep   : repo-level grep-clean acceptance gate (no VP literals /
 *                    Cyrillic outside prompts/ru.mjs).
 *
 * Every config test snapshots/restores process.env and uses { loadEnv:false }
 * with a temp config dir so the working tree is never mutated.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadTaskctlConfig, normalizeRuntimeConfig, validateRuntimeConfigShape } from '../config.mjs';
import { buildContextMd, guessCodeAreas } from '../context-builder.mjs';
import { buildLaunchCommand } from '../cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKCTL_DIR = path.resolve(__dirname, '..');
const ORCH_ROOT = path.resolve(__dirname, '..', '..');

const TOUCHED = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VIBE_ROOT', 'VP_REPO_ROOT', 'GRACE_REPO_ROOT'];
let envSnapshot;
beforeEach(() => {
  envSnapshot = {};
  for (const k of TOUCHED) { envSnapshot[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

async function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-2b-')); }
async function writeConfig(dir, obj) { await fs.writeFile(path.join(dir, 'taskctl.config.json'), JSON.stringify(obj), 'utf8'); }
async function rcfgFrom(dir) {
  return normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
}

// ── T2b-unit-1: extended config defaults + overrides + validation ───────────

test('T2b-unit-1: defaults — integration=dev, prTarget=dev, engines, language=en, repoPath null, empty arrays/maps', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { tracker: { type: 'local' } });
  const rcfg = await rcfgFrom(dir);
  assert.equal(rcfg.repoPath, null);
  assert.equal(rcfg.branches.integration, 'dev');
  assert.equal(rcfg.branches.prTarget, 'dev');
  assert.equal(rcfg.engines.planner, 'claude');
  assert.equal(rcfg.engines.reviewer, 'codex');
  assert.equal(rcfg.engines.reasoningEffort, 'high');
  assert.equal(rcfg.promptLanguage, 'en');
  assert.deepEqual(rcfg.projectContext, []);
  assert.deepEqual(rcfg.constraints, []);
  assert.deepEqual(rcfg.codeAreas, {});
  assert.equal(rcfg.previewUrlTemplate, null);
  assert.equal(rcfg.tracker.assigneeEmail, null);
});

test('T2b-unit-1: prTarget falls back to integration when only integration set', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { branches: { integration: 'main' } });
  const rcfg = await rcfgFrom(dir);
  assert.equal(rcfg.branches.integration, 'main');
  assert.equal(rcfg.branches.prTarget, 'main');
});

test('T2b-unit-1: overrides surface for every field', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, {
    branches: { integration: 'develop', prTarget: 'release' },
    engines: { planner: 'opus', reviewer: 'claude', reasoningEffort: 'medium' },
    promptLanguage: 'ru',
    projectContext: ['Tech: Go + Postgres'],
    constraints: ['No direct commits to main'],
    codeAreas: { billing: ['internal/billing/'] },
    previewUrlTemplate: 'https://pr{pr}.example.com/',
    tracker: { type: 'jira', assigneeEmail: 'dev@example.com' },
  });
  const rcfg = await rcfgFrom(dir);
  assert.equal(rcfg.branches.integration, 'develop');
  assert.equal(rcfg.branches.prTarget, 'release');
  assert.equal(rcfg.engines.planner, 'opus');
  assert.equal(rcfg.engines.reviewer, 'claude');
  assert.equal(rcfg.engines.reasoningEffort, 'medium');
  assert.equal(rcfg.promptLanguage, 'ru');
  assert.deepEqual(rcfg.projectContext, ['Tech: Go + Postgres']);
  assert.deepEqual(rcfg.constraints, ['No direct commits to main']);
  assert.deepEqual(rcfg.codeAreas, { billing: ['internal/billing/'] });
  assert.equal(rcfg.previewUrlTemplate, 'https://pr{pr}.example.com/');
  assert.equal(rcfg.tracker.assigneeEmail, 'dev@example.com');
});

test('T2b-unit-1: bad types throw', async () => {
  assert.throws(() => validateRuntimeConfigShape({ branches: { integration: 42 } }), /Invalid branches\.integration/);
  assert.throws(() => validateRuntimeConfigShape({ engines: { reasoningEffort: 5 } }), /Invalid engines\.reasoningEffort/);
  assert.throws(() => validateRuntimeConfigShape({ promptLanguage: 'de' }), /Invalid promptLanguage/);
  assert.throws(() => validateRuntimeConfigShape({ projectContext: 'not-an-array' }), /Invalid projectContext/);
  assert.throws(() => validateRuntimeConfigShape({ constraints: [1, 2] }), /Invalid constraints/);
  assert.throws(() => validateRuntimeConfigShape({ codeAreas: { x: 'not-array' } }), /Invalid codeAreas\.x/);
  assert.throws(() => validateRuntimeConfigShape({ tracker: { assigneeEmail: 7 } }), /Invalid tracker\.assigneeEmail/);
  assert.doesNotThrow(() => validateRuntimeConfigShape(undefined));
  assert.doesNotThrow(() => validateRuntimeConfigShape({ promptLanguage: 'ru' }));
});

// ── T2b-unit-2: guessCodeAreas stub + context sections via ctxOpts ──────────

function makeIssue(summary = 'Fix the thing', labels = []) {
  return {
    key: 'CP-1',
    fields: {
      summary, status: { name: 'Open' }, priority: { name: 'High' },
      assignee: null, issuetype: { name: 'Task' }, labels,
      description: { type: 'doc', version: 1, content: [] }, attachment: [],
    },
  };
}

test('T2b-unit-2: guessCodeAreas with no config map → neutral stub; no VP path', () => {
  const areas = guessCodeAreas('Fix billing subscription bug', ['billing'], {});
  assert.deepEqual(areas, ['src/ (determine based on task description)']);
  // No origin-project path leaks through (the VP keyword map is gone).
  assert.equal(areas.some((a) => /supabase\/functions|components\/billing/.test(a)), false);
});

test('T2b-unit-2: guessCodeAreas honors a config-supplied codeAreas map', () => {
  const areas = guessCodeAreas('Fix billing flow', ['billing'], { billing: ['internal/billing/', 'cmd/api/'] });
  assert.deepEqual(areas.sort(), ['cmd/api/', 'internal/billing/']);
});

test('T2b-unit-2: buildContextMd omits Project Context + Constraints when ctxOpts empty', () => {
  const md = buildContextMd(makeIssue(), { comments: [], links: [] }, {});
  assert.equal(/## Project Context/.test(md), false, 'no Project Context when unset');
  assert.equal(/## Constraints/.test(md), false, 'no Constraints when unset');
  // And no origin-project literal anywhere.
  assert.equal(/Supabase|React 18|zvngkkiygawotmxobfbc|mhnhwvgqrkzcqqkrzroo/.test(md), false);
});

test('T2b-unit-2: buildContextMd emits Project Context + Constraints verbatim when set', () => {
  // Lines are emitted VERBATIM (a config author includes its own bullets/markup).
  const md = buildContextMd(makeIssue(), { comments: [], links: [] }, {
    projectContext: ['- Tech stack: Go + Postgres', '- Docs: see README'],
    constraints: ['- No direct commits to main', '- Tests required'],
  });
  assert.match(md, /## Project Context\n- Tech stack: Go \+ Postgres\n- Docs: see README/);
  assert.match(md, /## Constraints\n- No direct commits to main\n- Tests required/);
});

// ── T2b-unit-3: exported pure buildLaunchCommand (NOT private launchCmd) ─────

test('T2b-unit-3: buildLaunchCommand codex honors explicit reasoningEffort', () => {
  const cmd = buildLaunchCommand('codex', { repoPath: '/r', cwd: '/r', reasoningEffort: 'medium' });
  assert.match(cmd, /model_reasoning_effort=medium/);
  assert.match(cmd, /-C "\/r"/);
});

test('T2b-unit-3: buildLaunchCommand codex defaults effort to high when omitted', () => {
  const cmd = buildLaunchCommand('codex', { repoPath: '/r', cwd: '/r' });
  assert.match(cmd, /model_reasoning_effort=high/);
});

test('T2b-unit-3: buildLaunchCommand codex exec form quotes the prompt + skip-git-repo-check', () => {
  const cmd = buildLaunchCommand('codex', { repoPath: '/r', cwd: '/r', prompt: 'Read x', skipGitRepoCheck: true });
  assert.match(cmd, /^codex exec /);
  assert.match(cmd, /--skip-git-repo-check/);
  assert.match(cmd, /"Read x"/);
});

test('T2b-unit-3: buildLaunchCommand claude emits the --add-dir form with orchestrationDir', () => {
  const cmd = buildLaunchCommand('claude', { repoPath: '/r', orchestrationDir: '/orch' });
  assert.equal(cmd, 'claude --add-dir "/orch"');
});

test('T2b-unit-3: buildLaunchCommand is PURE — reads no env (REPO_PATH ignored)', () => {
  process.env.REPO_PATH = '/should/be/ignored';
  const cmd = buildLaunchCommand('codex', { repoPath: '/explicit', cwd: '/explicit' });
  assert.match(cmd, /-C "\/explicit"/);
  assert.equal(/should\/be\/ignored/.test(cmd), false, 'pure helper must not read env');
});

// ── T2b-int-grep: repo-level grep-clean acceptance gate (I3) ────────────────

const FORBIDDEN = [
  'zvngkkiygawotmxobfbc',
  'mhnhwvgqrkzcqqkrzroo',
  'dmitry_vibe@',
  'vision-pitch-product-box',
  'Vision Pitch',
  'visionpitch.atlassian.net',
  'portal.dev.visionpitch.com.au',
  'vision-pitch-context.md',
  'find-children',
  'vp-orchestration',
];
const CYRILLIC = /[Ѐ-ӿ]/;

// Collect every taskctl/*.mjs, taskctl/prompts/*.mjs, ai/templates/*.tmpl, and
// the committed config examples — the files that ship to a public install.
function collectScrubTargets() {
  const targets = [];
  for (const f of fsSync.readdirSync(TASKCTL_DIR)) {
    if (f.endsWith('.mjs')) targets.push(path.join(TASKCTL_DIR, f));
  }
  const promptsDir = path.join(TASKCTL_DIR, 'prompts');
  for (const f of fsSync.readdirSync(promptsDir)) {
    if (f.endsWith('.mjs')) targets.push(path.join(promptsDir, f));
  }
  const tmplDir = path.join(ORCH_ROOT, 'ai', 'templates');
  for (const f of fsSync.readdirSync(tmplDir)) {
    if (f.endsWith('.tmpl')) targets.push(path.join(tmplDir, f));
  }
  for (const cfg of ['taskctl.config.json', 'taskctl.config.example.json']) {
    const p = path.join(ORCH_ROOT, cfg);
    if (fsSync.existsSync(p)) targets.push(p);
  }
  return targets;
}

test('T2b-int-grep: no VP literals in shipped taskctl/ + templates + config examples', () => {
  const targets = collectScrubTargets();
  assert.ok(targets.length > 5, 'sanity: collected the scrub targets');
  const offenders = [];
  for (const file of targets) {
    const content = fsSync.readFileSync(file, 'utf8');
    for (const lit of FORBIDDEN) {
      if (content.includes(lit)) offenders.push(`${path.basename(file)} :: "${lit}"`);
    }
  }
  assert.deepEqual(offenders, [], `VP literals leaked:\n${offenders.join('\n')}`);
});

test('T2b-int-grep: only prompts/ru.mjs may contain Cyrillic', () => {
  const targets = collectScrubTargets();
  const offenders = [];
  for (const file of targets) {
    if (path.basename(file) === 'ru.mjs') continue; // allowlisted
    const content = fsSync.readFileSync(file, 'utf8');
    if (CYRILLIC.test(content)) offenders.push(path.basename(file));
  }
  assert.deepEqual(offenders, [], `Cyrillic leaked outside prompts/ru.mjs: ${offenders.join(', ')}`);
});

test('T2b-int-grep: find-children.mjs is deleted', () => {
  assert.equal(fsSync.existsSync(path.join(TASKCTL_DIR, 'find-children.mjs')), false,
    'find-children.mjs must be removed');
});

// ── T4-scrub: two-tier scrub gate (WP4) ─────────────────────────────────────
//
// MECHANICAL tier — scans EVERY shipped Markdown file (all `**/*.md` repo-wide,
// with the single explicit exclusion `ai/tasks/**`: the per-task review plans +
// audit artifacts intentionally quote origin literals and are not publication
// content). The two quickstarts, the methodology docs, the skill files, the
// READMEs, and any future shipped `.md` are covered BY CONSTRUCTION — not by an
// enumerated allowlist. No YAML/glob dependency is added; uses fs recursion +
// RegExp only.
//
// The MANUAL tier (person names, origin file:line citations, engine-role
// hardcoding, origin-domain residue, incident/narrative refs, configurable-
// default-vs-policy, GRACE-XML-filename residue) is what regex CANNOT prove and
// is reviewed by hand per the committed companion checklist:
//   ai/tasks/WP4-skills-methodology/WP4-scrub-checklist.md
// This test does NOT assert the manual classes absent.
//
// Note: `GRACE` / `grace` is deliberately NOT a mechanical token. It is the
// public upstream methodology name, the shipped code carries `grace.mjs` /
// `grace.enabled`, and attribution must name it; only the `experiment/grace-pilot`
// branch literal (a true origin artifact with no product meaning) stays
// mechanical. The four GRACE artifact XML filenames are a MANUAL class (item 7).
//
// H1 (issue #18) widens the mechanical tier along four axes, each ADDING to the
// guarantees above rather than replacing them:
//   1. absolute-path patterns of UNKNOWN origin (a Windows drive root, a POSIX
//      home root, a macOS home root, a UNC share root) join the two
//      origin-specific patterns, so a path from a different machine fails the
//      guard the same way a known-origin path already does;
//   2. the walk also covers the other shipped, acted-upon formats this
//      repository ships — `.json`, `.toml`, `.yml`, `.yaml` — through the SAME
//      collector and the SAME `ai/tasks/**` exclusion, never a second one;
//   3. the collector's SUBJECT is now what this repository TRACKS, plus what
//      the current change STAGES — git's index — rather than "everything on
//      disk below the repo root minus three names". A directory walk cannot
//      tell a nested checkout of this very repository from this repository's
//      own tree, and it cannot tell a file that matches `.gitignore` but was
//      force-added — and therefore ships — from one correctly left out.
//      `git ls-files` answers both for free: an embedded repository's files
//      are never in this repository's index, and a force-added file is,
//      whatever `.gitignore` says about it;
//   4. an enumeration that could not run reports `unknown`, never `clean` — an
//      empty offender list must not be produced by a scan that never actually
//      enumerated its subject (git absent, the command failing, no repository
//      present).

const SHIPPED_DOC_PATTERNS = [
  // Real ticket IDs — shipped docs use `<task-id>` placeholders. Catches both
  // `CP-123` and `CP-TBD-...`.
  { label: 'ticket-id', re: /\bCP-(?:\d+|TBD-[0-9A-Za-z-]+)\b/ },
  // Workstream IDs (e.g. WS-P2-FOUNDATION, WS-P5b).
  { label: 'workstream-id', re: /\bWS-P[0-9A-Za-z-]+\b/ },
  // Governance module IDs (e.g. M-SUBSCRIPTIONS, M-DASHBOARD).
  { label: 'module-id', re: /\bM-[A-Z][A-Z0-9-]+\b/ },
  // Absolute origin workspace / repo paths — BOTH slash directions.
  { label: 'origin-path-vibe', re: /S:[/\\]Vibe[/\\]vp-orchestration/ },
  { label: 'origin-path-reps', re: /S:[/\\]REPS\b/ },
  // The origin pilot branch literal — a true origin artifact, no product meaning.
  { label: 'pilot-branch', re: /experiment\/grace-pilot/ },
  // H1 gap 1 — machine-specific absolute-path roots of UNKNOWN origin. The two
  // patterns above catch ONE known workspace; any OTHER machine's absolute path
  // passed the guard until now. Each form gets its own label so a form that
  // never fires in this suite is visible rather than assumed to be holding.
  // `<>` are excluded from the tail so illustrative prose like `/home/<user>/…`
  // (this very plan document uses that shape) is not mistaken for a real path.
  { label: 'windows-drive-root', re: /\b[A-Za-z]:[\\/][^\s"'`<>]+/ },
  { label: 'posix-home-root', re: /\/home\/[^\s"'`<>]+/ },
  { label: 'macos-home-root', re: /\/Users\/[^\s"'`<>]+/ },
  { label: 'unc-share-root', re: /\\\\[\w.-]+\\[\w.-]+/ },
];

// SUBJECT (H1 gap 4): what this repository TRACKS, plus what the current change
// STAGES — git's index, with bytes read from the worktree at those paths, so an
// edit to a tracked file that hasn't been staged yet is still scanned. This is
// deliberately NOT "everything on disk minus what `.gitignore` excludes": ignore
// status answers a different question than "does this ship". A file can be
// force-added while still matching an ignore pattern — it is then tracked and
// ships to every clone, and an ignore-based rule would silently never scan it.
// `node_modules` and `.git` need no exclusion of their own under this subject —
// neither is ever tracked. `ai/tasks/**` is still excluded, on content grounds
// (per-task review plans + audit artifacts intentionally quote origin literals
// and are not publication content) — expressed as a path rule relative to the
// repository root, not the single absolute string the old walk compared.
//
// Extension match is case-INSENSITIVE and covers every acted-upon shipped
// format (H1 gap 2): Markdown, plus the config formats this repo ships —
// `.json`, `.toml`, `.yml`, `.yaml`. One enumeration, one exclusion, one
// extension filter — not a second walk per format.
const SHIPPED_EXT_RE = /\.(?:md|json|toml|ya?ml)$/i;

// Ask git for the tracked+staged path set rooted at `root`. Returns a sentinel
// rather than throwing so a caller can tell "enumerated, zero files" apart from
// "could not enumerate" (H1 gap 3) — the two kinds of empty a directory walk
// cannot distinguish. Mirrors the `gitRead` shape in profiler.mjs.
function gitTrackedFiles(root) {
  const r = spawnSync('git', ['-C', root.replace(/\\/g, '/'), 'ls-files', '-z'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    const reason = r.error ? r.error.message : (r.stderr || `git ls-files exited ${r.status}`).trim();
    return { ok: false, reason };
  }
  // git's own path format: forward-slash, relative to root, NUL-separated.
  return { ok: true, files: r.stdout.split('\0').filter(Boolean) };
}

// Collect every tracked/staged shipped file (Markdown + config formats) under
// `root`. Coverage is by construction — a shipped file added tomorrow needs no
// allowlist entry — but the set it is constructed FROM is git's index, not the
// filesystem: that is what makes a nested checkout contribute nothing (its
// files are never in THIS repository's index) and a force-added ignored file
// still count (it IS in the index, whatever `.gitignore` says).
function collectShippedDocs(root = ORCH_ROOT) {
  const tracked = gitTrackedFiles(root);
  if (!tracked.ok) {
    // unknown, never clean (H1 gap 3): an enumeration failure must not read as
    // an empty — and therefore clean — offender list.
    throw new Error(`scrub gate: tracked-file enumeration is UNKNOWN, not clean (${tracked.reason})`);
  }
  const out = [];
  for (const rel of tracked.files) {
    if (rel.startsWith('ai/tasks/')) continue; // the gate's one content exclusion
    if (!SHIPPED_EXT_RE.test(rel)) continue;
    out.push(path.join(root, rel));
  }
  return out;
}

// Scan already-collected targets for SHIPPED_DOC_PATTERNS hits. Shared by the
// "stays clean" tests below and the H1 planted-offender tests, so there is one
// implementation of "what counts as a hit", not two that can drift apart.
function findPatternOffenders(targets) {
  const offenders = [];
  for (const file of targets) {
    const content = fsSync.readFileSync(file, 'utf8');
    for (const { label, re } of SHIPPED_DOC_PATTERNS) {
      const m = content.match(re);
      if (m) offenders.push(`${path.relative(ORCH_ROOT, file)} :: [${label}] "${m[0]}"`);
    }
  }
  return offenders;
}

// ── H1 test fixture helpers — throwing git() for setup/teardown, distinct from
// the sentinel-returning gitTrackedFiles() used by the gate itself. Mirrors
// attach.test.mjs's `git()` fixture helper.
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo.replace(/\\/g, '/'), ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function stageFixture(repoRoot, absPath, extraArgs = []) {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
  git(repoRoot, ['add', ...extraArgs, '--', rel]);
}
function unstageFixture(repoRoot, absPath) {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
  spawnSync('git', ['-C', repoRoot.replace(/\\/g, '/'), 'reset', '-q', '--', rel], { encoding: 'utf8' });
}

test('T4-scrub: no FORBIDDEN literals in any shipped Markdown (ai/tasks/** excluded)', () => {
  const targets = collectShippedDocs();
  assert.ok(targets.length > 3, 'sanity: collected shipped docs');
  const offenders = [];
  for (const file of targets) {
    const content = fsSync.readFileSync(file, 'utf8');
    for (const lit of FORBIDDEN) {
      if (content.includes(lit)) {
        offenders.push(`${path.relative(ORCH_ROOT, file)} :: "${lit}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `FORBIDDEN literal leaked into shipped docs:\n${offenders.join('\n')}`);
});

test('T4-scrub: no origin IDs / paths / pilot-branch regex hits in any shipped Markdown', () => {
  const targets = collectShippedDocs();
  assert.ok(targets.length > 3, 'sanity: collected shipped docs');
  const offenders = findPatternOffenders(targets);
  assert.deepEqual(offenders, [], `origin pattern leaked into shipped docs:\n${offenders.join('\n')}`);
});

test('T4-scrub: no Cyrillic in any shipped Markdown (ru-pack carve-out is .mjs-only)', () => {
  const targets = collectShippedDocs();
  assert.ok(targets.length > 3, 'sanity: collected shipped docs');
  const offenders = [];
  for (const file of targets) {
    const content = fsSync.readFileSync(file, 'utf8');
    if (CYRILLIC.test(content)) offenders.push(path.relative(ORCH_ROOT, file));
  }
  assert.deepEqual(offenders, [], `Cyrillic leaked into shipped docs (English-only): ${offenders.join(', ')}`);
});

test('T4-scrub: collectShippedDocs scans a publication dot-directory (.github/*.md)', () => {
  // A future `.github/*.md` (e.g. ISSUE_TEMPLATE) must be in-scope for the gate —
  // dot-directories other than `.git`/`node_modules` are NOT excluded. H1: the
  // subject is tracked+staged, so a merely-written fixture no longer qualifies —
  // stage it, assert it is collected, then unstage and remove it.
  const ghDir = path.join(ORCH_ROOT, '.github');
  const fixture = path.join(ghDir, `__t4_scrub_dotdir_${process.pid}.md`);
  const preexisting = fsSync.existsSync(ghDir);
  try {
    if (!preexisting) fsSync.mkdirSync(ghDir, { recursive: true });
    fsSync.writeFileSync(fixture, '# scrub fixture (publication dot-dir)\n', 'utf8');
    stageFixture(ORCH_ROOT, fixture);
    const collected = collectShippedDocs();
    assert.ok(collected.includes(fixture),
      '.github/*.md must be scanned by collectShippedDocs (publication dot-dir, not excluded)');
  } finally {
    unstageFixture(ORCH_ROOT, fixture);
    if (fsSync.existsSync(fixture)) fsSync.rmSync(fixture);
    if (!preexisting && fsSync.existsSync(ghDir)) fsSync.rmSync(ghDir, { recursive: true });
  }
});

test('T4-scrub: collectShippedDocs matches an uppercase extension (.MD)', () => {
  // "All Markdown" means case-insensitive — an `.MD` file must not bypass the gate.
  const fixture = path.join(ORCH_ROOT, 'docs', `__t4_scrub_upper_${process.pid}.MD`);
  try {
    fsSync.writeFileSync(fixture, '# scrub fixture (uppercase extension)\n', 'utf8');
    stageFixture(ORCH_ROOT, fixture);
    const collected = collectShippedDocs();
    assert.ok(collected.includes(fixture),
      '.MD (uppercase) must be scanned by collectShippedDocs (case-insensitive extension)');
  } finally {
    unstageFixture(ORCH_ROOT, fixture);
    if (fsSync.existsSync(fixture)) fsSync.rmSync(fixture);
  }
});

test('T4-scrub: the manual-tier checklist companion exists', () => {
  // The mechanical tier cannot prove the manual classes; the committed checklist
  // is the authoritative companion the reviewer walks by hand. It lives in the
  // PUBLIC docs tree (docs/methodology/), never under ai/tasks/** — the public
  // surface must not depend on internal task artifacts.
  const checklist = path.join(ORCH_ROOT, 'docs', 'methodology', 'scrub-checklist.md');
  assert.ok(fsSync.existsSync(checklist), 'docs/methodology/scrub-checklist.md (manual tier) must be committed');
});

// ── H1: extend the committed-path guard (issue #18) ─────────────────────────

test('H1 gap 1: unknown-origin absolute-path patterns fire, and the label proves which one', () => {
  // A pattern that never fires in this suite is a pattern nobody can trust —
  // name the label so it is visible rather than assumed to be holding.
  const cases = [
    ['windows-drive-root', 'D:\\build\\workspace\\secrets.txt'],
    ['posix-home-root', '/home/ci-runner/.taskctl/state'],
    ['macos-home-root', '/Users/alice/Projects/taskctl-oss'],
    ['unc-share-root', '\\\\build-server\\shared\\artifacts'],
  ];
  for (const [label, sample] of cases) {
    const entry = SHIPPED_DOC_PATTERNS.find((p) => p.label === label);
    assert.ok(entry, `pattern ${label} must exist`);
    assert.match(sample, entry.re, `${label} must match its own sample: ${sample}`);
  }
});

test('H1 gap 1: a planted unknown-origin absolute path (outside the origin-specific patterns) fails the guard', () => {
  const fixture = path.join(ORCH_ROOT, `__h1_gap1_${process.pid}.md`);
  try {
    fsSync.writeFileSync(fixture, '# fixture\nDrop artifacts at \\\\build-server\\shared\\ci.\n', 'utf8');
    stageFixture(ORCH_ROOT, fixture);
    const targets = collectShippedDocs();
    assert.ok(targets.includes(fixture), 'sanity: the fixture itself must be in the collected set');
    const offenders = findPatternOffenders(targets);
    assert.ok(offenders.some((o) => o.includes('unc-share-root')),
      'a UNC share root of unknown origin must fail the guard');
  } finally {
    unstageFixture(ORCH_ROOT, fixture);
    if (fsSync.existsSync(fixture)) fsSync.rmSync(fixture);
  }
});

test('H1 gap 2: a planted absolute path is caught in each newly covered format', () => {
  const cases = [
    ['json', '{ "note": "C:\\Users\\bob\\dump" }\n'],
    ['toml', 'note = "C:\\Users\\bob\\dump"\n'],
    ['yml', 'note: "C:\\Users\\bob\\dump"\n'],
    ['yaml', 'note: "C:\\Users\\bob\\dump"\n'],
  ];
  for (const [ext, body] of cases) {
    const fixture = path.join(ORCH_ROOT, `__h1_gap2_${process.pid}.${ext}`);
    try {
      fsSync.writeFileSync(fixture, body, 'utf8');
      stageFixture(ORCH_ROOT, fixture);
      const targets = collectShippedDocs();
      assert.ok(targets.includes(fixture), `sanity: .${ext} must be in the collected set`);
      const offenders = findPatternOffenders(targets);
      assert.ok(offenders.some((o) => o.includes(`.${ext}`) && o.includes('windows-drive-root')),
        `a planted absolute path in .${ext} must fail the guard`);
    } finally {
      unstageFixture(ORCH_ROOT, fixture);
      if (fsSync.existsSync(fixture)) fsSync.rmSync(fixture);
    }
  }
});

test('H1 gap 4 (important): a force-added file matching an ignore pattern is still covered', () => {
  // `.tmp/` is an EXISTING .gitignore rule (`.gitignore:35`), unrelated to this
  // gate. This is the control that separates the correct subject (tracked+
  // staged) from the plausible-but-wrong one (filesystem minus ignored paths):
  // an ignore-based "fix" for gap 4 would exclude this file and silently miss
  // the planted path inside it, even though it ships to everyone who clones.
  const tmpSubdir = path.join(ORCH_ROOT, '.tmp');
  const fixture = path.join(tmpSubdir, `__h1_gap4_forceadd_${process.pid}.md`);
  const preexisting = fsSync.existsSync(tmpSubdir);
  try {
    if (!preexisting) fsSync.mkdirSync(tmpSubdir, { recursive: true });
    fsSync.writeFileSync(fixture, '# fixture\nDrop artifacts at \\\\build-server\\shared\\ci.\n', 'utf8');

    const rel = path.relative(ORCH_ROOT, fixture).split(path.sep).join('/');
    const ignoreCheck = spawnSync('git', ['-C', ORCH_ROOT.replace(/\\/g, '/'), 'check-ignore', '--no-index', '-q', '--', rel], { encoding: 'utf8' });
    assert.equal(ignoreCheck.status, 0, 'sanity: the fixture must actually match a .gitignore rule');

    stageFixture(ORCH_ROOT, fixture, ['-f']); // force-add: tracked despite matching .gitignore

    const targets = collectShippedDocs();
    assert.ok(targets.includes(fixture), 'a force-added, ignore-matching file must still be in the collected set');
    const offenders = findPatternOffenders(targets);
    assert.ok(offenders.some((o) => o.includes('unc-share-root')),
      'a planted absolute path inside a force-added ignored file must fail the guard');
  } finally {
    unstageFixture(ORCH_ROOT, fixture);
    if (fsSync.existsSync(fixture)) fsSync.rmSync(fixture);
    if (!preexisting && fsSync.existsSync(tmpSubdir)) fsSync.rmSync(tmpSubdir, { recursive: true });
  }
});

test('H1 gap 4: a nested checkout of this repository contributes no offenders', () => {
  // Placed under `worktrees/` — this repository's own .gitignore excludes it
  // (`.gitignore:39`), matching how the plan's own measurement found the old
  // fs-walk collecting 30-60 offenders from a nested checkout. The criterion
  // does not depend on the ignore status of where it sits (a tracked-set
  // subject excludes it either way) — this placement just matches precedent.
  const nestedRoot = path.join(ORCH_ROOT, 'worktrees', `__h1_gap4_nested_${process.pid}`);
  try {
    fsSync.mkdirSync(nestedRoot, { recursive: true });
    git(nestedRoot, ['init', '-q']);
    git(nestedRoot, ['config', 'user.email', 'h1-fixture@test']);
    git(nestedRoot, ['config', 'user.name', 'H1 Fixture']);
    git(nestedRoot, ['config', 'commit.gpgsign', 'false']);
    const nestedFile = path.join(nestedRoot, 'README.md');
    fsSync.writeFileSync(nestedFile, '# nested checkout\nSee /Users/carol/leftover-notes for the draft.\n', 'utf8');
    git(nestedRoot, ['add', '-A']);
    git(nestedRoot, ['commit', '-q', '-m', 'nested fixture']);

    const targets = collectShippedDocs();
    assert.ok(targets.length > 3, 'sanity: the real root is still collected in the same run');
    assert.ok(!targets.some((t) => t.startsWith(nestedRoot)),
      'no file inside the nested checkout may enter the collected set');
  } finally {
    if (fsSync.existsSync(nestedRoot)) fsSync.rmSync(nestedRoot, { recursive: true, force: true });
  }
});

test('H1 gap 3: gitTrackedFiles distinguishes a genuinely empty repo from an unenumerable one', async () => {
  // The two kinds of empty gap 3 exists to tell apart: a real, empty repository
  // enumerates cleanly to zero files; a directory that is not a repository at
  // all must not be mistaken for the same thing.
  const emptyRepo = await tmpDir();
  const notARepo = await tmpDir();
  git(emptyRepo, ['init', '-q']);

  const cleanEmpty = gitTrackedFiles(emptyRepo);
  assert.deepEqual(cleanEmpty, { ok: true, files: [] }, 'a real, empty repo enumerates to zero files, cleanly');

  const broken = gitTrackedFiles(notARepo);
  assert.equal(broken.ok, false, 'a directory that is not a repository must not enumerate as ok:true');
  assert.ok(broken.reason, 'the unknown result must carry a reason');
});

test('H1 gap 3: a scan that cannot enumerate the tracked set reports unknown and fails, not clean', async () => {
  const notARepo = await tmpDir();
  assert.throws(() => collectShippedDocs(notARepo), /unknown/i,
    'a broken enumeration must throw (fail the test), never return an empty — and therefore falsely clean — list');
});
