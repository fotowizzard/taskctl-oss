/**
 * WP2 Stage 2b — engine + reasoningEffort WIRING tests (code-review fixes
 * C1 / C2 / C3, Important-1).
 *
 * The prior Stage-2b engine test (config-2b.test.mjs T2b-unit-3) proved only the
 * PURE helper (`buildLaunchCommand`) honors an explicitly-passed value. It never
 * proved that config actually REACHES a launched command. These tests close that
 * gap on two seams:
 *
 *   - exported helpers: `parseEngine(args, rcfg, role)` (cli.mjs, C1) and
 *     `engineForStage` / `rolePair` (automation.mjs, C2) — pure role selection.
 *   - end-to-end subprocess: a planted taskctl.config.json drives a real
 *     `taskctl plan` / `taskctl review`, and we assert on the PRINTED launch
 *     command line (the exact string the user would run), proving:
 *       · planner-role direct commands pick `engines.planner`           (C1)
 *       · reviewer-role direct commands pick `engines.reviewer`          (C1)
 *       · a non-default `engines.reasoningEffort` reaches the launch     (C3)
 *       · `--engine` still overrides config                             (C1)
 *
 * Hermetic: each subprocess test runs in an isolated temp workspace (copy of
 * taskctl/ + ai/templates/ + a planted config); the tracked tree is untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEngine } from '../cli.mjs';
import { engineForStage, rolePair } from '../automation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

// rcfg fixtures: non-default engines so a leak of the OLD hardcoded value fails.
const RCFG_SWAPPED = { engines: { planner: 'codex', reviewer: 'claude', reasoningEffort: 'medium' } };

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VP_REPO_ROOT', 'GRACE_REPO_ROOT', 'VIBE_ROOT']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

async function makeWorkspace(configObj) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-2b-eng-'));
  await fs.cp(TASKCTL_DIR, path.join(root, 'taskctl'), { recursive: true });
  await fs.cp(TEMPLATES_DIR, path.join(root, 'ai', 'templates'), { recursive: true });
  await fs.writeFile(path.join(root, 'taskctl.config.json'), JSON.stringify(configObj), 'utf8');
  return root;
}

function runWs(ws, args, { env = cleanEnv(), timeout = 30000 } = {}) {
  const cli = path.join(ws, 'taskctl', 'cli.mjs');
  return spawnSync('node', [cli, ...args], { cwd: ws, encoding: 'utf8', env, timeout });
}

async function seedLocalTask(ws, slug, title = 'x') {
  const r = runWs(ws, ['new', slug, '--title', title]);
  assert.equal(r.status, 0, `new ${slug} exit 0; stderr=${r.stderr}`);
}

// ── C1 (pure): parseEngine is role-aware; --engine always wins ──────────────

test('C1 parseEngine: planner role defaults to engines.planner', () => {
  assert.equal(parseEngine([], RCFG_SWAPPED, 'planner'), 'codex');
  assert.equal(parseEngine([], RCFG_SWAPPED), 'codex'); // default role = planner
});

test('C1 parseEngine: reviewer role defaults to engines.reviewer', () => {
  assert.equal(parseEngine([], RCFG_SWAPPED, 'reviewer'), 'claude');
});

test('C1 parseEngine: role defaults when config omits engines (planner=claude, reviewer=codex)', () => {
  assert.equal(parseEngine([], null, 'planner'), 'claude');
  assert.equal(parseEngine([], null, 'reviewer'), 'codex');
  assert.equal(parseEngine([], {}, 'reviewer'), 'codex');
});

test('C1 parseEngine: explicit --engine overrides config for BOTH roles', () => {
  assert.equal(parseEngine(['--engine', 'opus'], RCFG_SWAPPED, 'planner'), 'opus');
  assert.equal(parseEngine(['--engine', 'opus'], RCFG_SWAPPED, 'reviewer'), 'opus');
});

// ── C2 (pure): automation role mapping derives from config ──────────────────

test('C2 engineForStage: reviewer stages → engines.reviewer, others → engines.planner', () => {
  assert.equal(engineForStage('plan-review', RCFG_SWAPPED), 'claude');
  assert.equal(engineForStage('review', RCFG_SWAPPED), 'claude');
  assert.equal(engineForStage('plan', RCFG_SWAPPED), 'codex');
  assert.equal(engineForStage('run', RCFG_SWAPPED), 'codex');
  assert.equal(engineForStage('fix', RCFG_SWAPPED), 'codex');
  assert.equal(engineForStage('revise', RCFG_SWAPPED), 'codex');
});

test('C2 engineForStage: defaults when no config (reviewer=codex, planner=claude)', () => {
  assert.equal(engineForStage('review', null), 'codex');
  assert.equal(engineForStage('plan', null), 'claude');
});

test('C2 rolePair: author=planner, reviewer=reviewer (flip swaps these at the call site)', () => {
  assert.deepEqual(rolePair(RCFG_SWAPPED), { author: 'codex', reviewer: 'claude' });
  assert.deepEqual(rolePair(null), { author: 'claude', reviewer: 'codex' });
  // Flip semantics live in the loop: classic uses (author, reviewer); flip uses
  // (reviewer, author) and alternates. rolePair just supplies the two endpoints.
  const { author, reviewer } = rolePair(RCFG_SWAPPED);
  const flipStartReviser = reviewer; // flip starts with reviewer-as-reviser
  const flipStartReviewer = author;
  assert.equal(flipStartReviser, 'claude');
  assert.equal(flipStartReviewer, 'codex');
});

// ── C1 + C3 end-to-end: config reaches the PRINTED launch command ───────────

test('C1+C3 e2e: planner-role `plan` selects engines.planner (codex) AND emits engines.reasoningEffort (medium)', async () => {
  // planner=codex, reasoningEffort=medium. A planner command (plan) must launch
  // codex with model_reasoning_effort=medium — NOT the old "high" fallback.
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'codex', reviewer: 'claude', reasoningEffort: 'medium' } });
  try {
    await seedLocalTask(ws, 'demo-planner');
    const r = runWs(ws, ['plan', 'demo-planner']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const out = (r.stdout || '') + (r.stderr || '');
    // The printed launch line is the resolved command the user would run.
    assert.match(out, /codex --full-auto/, 'planner role selected the configured planner engine (codex)');
    assert.match(out, /model_reasoning_effort=medium/, 'configured reasoningEffort reached the planner launch command');
    assert.equal(/model_reasoning_effort=high/.test(out), false, 'no stale "high" fallback when effort is configured');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('C1 e2e: reviewer-role `review` selects engines.reviewer (claude), NOT engines.planner (codex)', async () => {
  // planner=codex but reviewer=claude → `taskctl review` MUST launch claude.
  // This is the exact bug C1 fixes (review previously fell back to planner).
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-2b-engrepo-'));
  const ws = await makeWorkspace({
    repoPath: repo,
    tracker: { type: 'local' },
    branches: { integration: 'trunk', prTarget: 'trunk' },
    engines: { planner: 'codex', reviewer: 'claude', reasoningEffort: 'medium' },
  });
  try {
    const run = (cmd) => spawnSync(cmd, { cwd: repo, shell: true, encoding: 'utf8' });
    run('git init -b trunk');
    run('git config user.email t@t');
    run('git config user.name t');
    await fs.writeFile(path.join(repo, 'a.txt'), 'base\n', 'utf8');
    run('git add -A'); run('git commit -m base --no-gpg-sign');
    run('git checkout -b feature/demo-rev --quiet');
    await fs.writeFile(path.join(repo, 'b.txt'), 'change\n', 'utf8');
    run('git add -A'); run('git commit -m change --no-gpg-sign');
    run('git checkout trunk --quiet');

    await seedLocalTask(ws, 'demo-rev');
    const statePath = path.join(ws, 'ai', 'tasks', 'demo-rev', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.stage = 'review';
    state.branch = 'feature/demo-rev';
    state.execution = { engine: 'codex', status: 'completed', lastRunAt: new Date().toISOString() };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['review', 'demo-rev', '--repo-path', repo]);
    assert.equal(r.status, 0, `review exit 0; stderr=${r.stderr}`);
    const out = (r.stdout || '') + (r.stderr || '');
    // claude launch form (no codex exec / no model_reasoning_effort flag).
    assert.match(out, /claude --add-dir/, 'reviewer role selected the configured reviewer engine (claude)');
    assert.equal(/codex (exec|--full-auto)/.test(out), false, 'reviewer did NOT fall back to the planner engine (codex)');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('C1 e2e: explicit --engine on a reviewer command overrides config', async () => {
  // reviewer=claude in config, but --engine codex on the command must win.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-2b-engrepo2-'));
  const ws = await makeWorkspace({
    repoPath: repo,
    tracker: { type: 'local' },
    branches: { integration: 'trunk', prTarget: 'trunk' },
    engines: { planner: 'codex', reviewer: 'claude', reasoningEffort: 'medium' },
  });
  try {
    const run = (cmd) => spawnSync(cmd, { cwd: repo, shell: true, encoding: 'utf8' });
    run('git init -b trunk');
    run('git config user.email t@t');
    run('git config user.name t');
    await fs.writeFile(path.join(repo, 'a.txt'), 'base\n', 'utf8');
    run('git add -A'); run('git commit -m base --no-gpg-sign');
    run('git checkout -b feature/demo-rev2 --quiet');
    await fs.writeFile(path.join(repo, 'b.txt'), 'change\n', 'utf8');
    run('git add -A'); run('git commit -m change --no-gpg-sign');
    run('git checkout trunk --quiet');

    await seedLocalTask(ws, 'demo-rev2');
    const statePath = path.join(ws, 'ai', 'tasks', 'demo-rev2', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.stage = 'review';
    state.branch = 'feature/demo-rev2';
    state.execution = { engine: 'codex', status: 'completed', lastRunAt: new Date().toISOString() };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['review', 'demo-rev2', '--repo-path', repo, '--engine', 'codex']);
    assert.equal(r.status, 0, `review exit 0; stderr=${r.stderr}`);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /codex exec/, 'explicit --engine codex overrode the configured reviewer (claude)');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});
