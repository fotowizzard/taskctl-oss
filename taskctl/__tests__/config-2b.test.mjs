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
];

// Recursively collect every Markdown file in the repo. Excludes ONLY `ai/tasks/**`
// (the contract's single content exclusion) plus the two non-shipped VCS/dependency
// trees `.git` and `node_modules`. Other dot-directories — notably publication dirs
// like `.github/` — are INCLUDED so a future `.github/*.md` cannot bypass the gate.
// Extension match is case-INSENSITIVE (`.md` and `.MD`) so "all Markdown" is honest.
function collectShippedDocs() {
  const out = [];
  const skipTasks = path.join(ORCH_ROOT, 'ai', 'tasks');
  const walk = (dir) => {
    for (const ent of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (full === skipTasks) continue;            // ai/tasks/** excluded (content)
        if (ent.name === 'node_modules') continue;   // dependency tree, not shipped
        if (ent.name === '.git') continue;           // VCS internals, not shipped
        walk(full);                                  // includes .github & other dot-dirs
      } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
        out.push(full);
      }
    }
  };
  walk(ORCH_ROOT);
  return out;
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
  const offenders = [];
  for (const file of targets) {
    const content = fsSync.readFileSync(file, 'utf8');
    for (const { label, re } of SHIPPED_DOC_PATTERNS) {
      const m = content.match(re);
      if (m) offenders.push(`${path.relative(ORCH_ROOT, file)} :: [${label}] "${m[0]}"`);
    }
  }
  assert.deepEqual(offenders, [], `origin pattern leaked into shipped docs:\n${offenders.join('\n')}`);
});

test('T4-scrub: no Cyrillic in any shipped Markdown (ru-pack carve-out is .mjs-only)', () => {
  const targets = collectShippedDocs();
  const offenders = [];
  for (const file of targets) {
    const content = fsSync.readFileSync(file, 'utf8');
    if (CYRILLIC.test(content)) offenders.push(path.relative(ORCH_ROOT, file));
  }
  assert.deepEqual(offenders, [], `Cyrillic leaked into shipped docs (English-only): ${offenders.join(', ')}`);
});

test('T4-scrub: collectShippedDocs scans a publication dot-directory (.github/*.md)', () => {
  // A future `.github/*.md` (e.g. ISSUE_TEMPLATE) must be in-scope for the gate —
  // dot-directories other than `.git`/`node_modules` are NOT excluded. Plant a
  // benign fixture, assert it is collected, then remove it.
  const ghDir = path.join(ORCH_ROOT, '.github');
  const fixture = path.join(ghDir, `__t4_scrub_dotdir_${process.pid}.md`);
  const preexisting = fsSync.existsSync(ghDir);
  try {
    if (!preexisting) fsSync.mkdirSync(ghDir, { recursive: true });
    fsSync.writeFileSync(fixture, '# scrub fixture (publication dot-dir)\n', 'utf8');
    const collected = collectShippedDocs();
    assert.ok(collected.includes(fixture),
      '.github/*.md must be scanned by collectShippedDocs (publication dot-dir, not excluded)');
  } finally {
    if (fsSync.existsSync(fixture)) fsSync.rmSync(fixture);
    if (!preexisting && fsSync.existsSync(ghDir)) fsSync.rmSync(ghDir, { recursive: true });
  }
});

test('T4-scrub: collectShippedDocs matches an uppercase extension (.MD)', () => {
  // "All Markdown" means case-insensitive — an `.MD` file must not bypass the gate.
  const fixture = path.join(ORCH_ROOT, 'docs', `__t4_scrub_upper_${process.pid}.MD`);
  try {
    fsSync.writeFileSync(fixture, '# scrub fixture (uppercase extension)\n', 'utf8');
    const collected = collectShippedDocs();
    assert.ok(collected.includes(fixture),
      '.MD (uppercase) must be scanned by collectShippedDocs (case-insensitive extension)');
  } finally {
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
