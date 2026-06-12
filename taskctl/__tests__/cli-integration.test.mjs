/**
 * WP1 — CLI integration tests (subprocess; no Jira).
 *   T-int-1      : headline AC — `new demo` then `plan demo` (NO --repo-path),
 *                  config fallback to the committed local repoPath.
 *   T-int-3      : gate negative — `sync` in local mode prints the tracker hint,
 *                  exits non-zero, does NOT throw missing-creds.
 *   T-int-3b/c/d/e: gate negative for refresh / jira-sync / autopilot / publish.
 *   T-int-5      : `new` in a jira-mode config still creates a LOCAL task, no network.
 *
 * T-int-1/3* subprocesses run from the real ORCH_ROOT so they exercise the
 * committed taskctl.config.json (tracker.type:'local'), which forces local mode
 * even if JIRA_* are present in the environment — the intended dogfood
 * behavior. T-int-5 instead runs in an ISOLATED temp workspace (the CLI derives
 * all its roots + config path from cli.mjs's own dir, so it cannot take an
 * injected config path) — it NEVER writes the tracked taskctl.config.json.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ORCH_ROOT, 'taskctl', 'cli.mjs');
const TASKS_DIR = path.join(ORCH_ROOT, 'ai', 'tasks');
const CONFIG_PATH = path.join(ORCH_ROOT, 'taskctl.config.json');

// Env with all Jira vars explicitly cleared (so behavior is config-driven).
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

function runCli(args, { env = cleanEnv(), timeout = 30000 } = {}) {
  return spawnSync('node', [CLI, ...args], { cwd: ORCH_ROOT, encoding: 'utf8', env, timeout });
}

const createdTasks = new Set();
async function cleanupTask(slug) {
  await fs.rm(path.join(TASKS_DIR, slug), { recursive: true, force: true });
}
afterEach(async () => {
  for (const slug of createdTasks) await cleanupTask(slug);
  createdTasks.clear();
});

// ── T-int-1 ───────────────────────────────────────────────────────────────

test('T-int-1: `new demo` then `plan demo` (no --repo-path) works with no Jira', async () => {
  createdTasks.add('demo');
  await cleanupTask('demo');

  const r1 = runCli(['new', 'demo', '--title', 'x', '--desc', 'hello']);
  assert.equal(r1.status, 0, `new exit 0; stderr=${r1.stderr}`);

  const ctxPath = path.join(TASKS_DIR, 'demo', 'context.md');
  const statePath = path.join(TASKS_DIR, 'demo', 'state.json');
  assert.equal(fsSync.existsSync(ctxPath), true, 'context.md created');
  assert.equal(fsSync.existsSync(statePath), true, 'state.json created');

  const ctx = await fs.readFile(ctxPath, 'utf8');
  assert.match(ctx, /# demo: x/);
  assert.equal(/\{\{\w+\}\}/.test(ctx), false, 'no unsubstituted token');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.stage, 'analysis');
  assert.equal(state.issueType, 'Task');

  // plan WITHOUT --repo-path: must not error on Jira; repo resolves from config.
  const r2 = runCli(['plan', 'demo']);
  assert.equal(r2.status, 0, `plan exit 0; stderr=${r2.stderr}`);
  const combined = (r2.stdout || '') + (r2.stderr || '');
  assert.equal(/Missing required env vars/i.test(combined), false, 'no Jira creds error');
  // repoPath resolves to the config dir (orchestration root) because repoPath:"."
  assert.equal(combined.includes(ORCH_ROOT.replace(/\\/g, '/')) || combined.includes(ORCH_ROOT), true,
    'planning prompt references the configured repo (orchestration root)');
});

// ── T-int-3 / 3b–e : gate negatives ────────────────────────────────────────

function assertLocalGate(r, command) {
  assert.notEqual(r.status, 0, `${command} should exit non-zero in local mode`);
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.match(combined, /tracker is "local"|is local; Jira is not configured/i,
    `${command} prints the local-tracker hint`);
  assert.equal(/Missing required env vars/i.test(combined), false,
    `${command} must NOT reach loadConfig missing-creds throw`);
  // No unhandled TypeError / null deref from a null config reaching a JiraClient.
  assert.equal(/TypeError/.test(combined), false, `${command} no TypeError`);
}

test('T-int-3: `sync` in local mode → tracker hint, non-zero, no missing-creds', () => {
  const r = runCli(['sync', 'demo']);
  assertLocalGate(r, 'sync');
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.match(combined, /taskctl new/i, 'sync suggests `taskctl new`');
});

test('T-int-3b: `refresh` in local mode → tracker error before any JiraClient', () => {
  assertLocalGate(runCli(['refresh', 'demo']), 'refresh');
});

test('T-int-3c: `jira-sync` in local mode → tracker error', () => {
  assertLocalGate(runCli(['jira-sync', 'demo']), 'jira-sync');
});

test('T-int-3d: `autopilot` in local mode → tracker error (never reaches automation creds)', () => {
  assertLocalGate(runCli(['autopilot', 'demo', '--yes']), 'autopilot');
});

test('T-int-3e: `publish` in local mode → tracker error', () => {
  assertLocalGate(runCli(['publish', 'demo']), 'publish');
});

// ── T-int-5 : new is always local, even in a jira-mode config ───────────────
//
// HERMETIC (F3): the CLI resolves ORCHESTRATION_ROOT / TASKS_DIR / TEMPLATES_DIR
// and its taskctl.config.json path from cli.mjs's OWN dir, so it cannot accept an
// injected config path. We therefore build an ISOLATED temp workspace (copy the
// taskctl/ module + ai/templates/, plant a jira-mode taskctl.config.json) and run
// the CLI from there. The tracked taskctl.config.json is NEVER written — even if
// this test throws mid-way — because we only ever touch files under the temp dir.

const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

// Build a self-contained temp workspace with a jira-mode config. Returns its root.
async function makeJiraModeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-int5-'));
  // Copy the whole taskctl/ module dir (cli.mjs + every sibling it imports).
  await fs.cp(TASKCTL_DIR, path.join(root, 'taskctl'), { recursive: true });
  // Copy ai/templates/ (cmdNew -> renderTemplate reads context.md.tmpl from here).
  await fs.cp(TEMPLATES_DIR, path.join(root, 'ai', 'templates'), { recursive: true });
  // Plant a jira-mode config at the workspace root (explicit type wins inference).
  await fs.writeFile(
    path.join(root, 'taskctl.config.json'),
    JSON.stringify({ tracker: { type: 'jira' } }),
    'utf8',
  );
  return root;
}

test('T-int-5: `new` in a jira-mode config creates a LOCAL task, no network', async () => {
  // Guard: snapshot the tracked config so we can prove it is untouched afterward.
  const trackedConfigBefore = await fs.readFile(CONFIG_PATH, 'utf8');

  const ws = await makeJiraModeWorkspace();
  try {
    const wsCli = path.join(ws, 'taskctl', 'cli.mjs');
    const wsTasksDir = path.join(ws, 'ai', 'tasks');
    // Point JIRA_BASE_URL at an unroutable host so any network attempt would
    // hang/fail; `new` must never construct a JiraClient, so it returns fast.
    // No VIBE_ROOT/REPO_PATH so the loader can't pull in the real repo's .env.
    const env = cleanEnv({
      JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_EMAIL: 'e@e', JIRA_API_TOKEN: 't', JIRA_PROJECT_KEY: 'CP',
    });
    delete env.VIBE_ROOT;
    const r = spawnSync('node', [wsCli, 'new', 'demo-jira', '--title', 'x'],
      { cwd: ws, encoding: 'utf8', env, timeout: 15000 });
    assert.equal(r.status, 0, `new (jira-mode) exit 0; stderr=${r.stderr}`);

    const statePath = path.join(wsTasksDir, 'demo-jira', 'state.json');
    assert.equal(fsSync.existsSync(statePath), true, 'local task created in jira-mode project');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(state.issueType, 'Task');
    assert.equal(state.stage, 'analysis');

    const ctx = await fs.readFile(path.join(wsTasksDir, 'demo-jira', 'context.md'), 'utf8');
    assert.match(ctx, /\*\*Status:\*\* local/, 'local-shaped context (Status: local)');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }

  // The tracked taskctl.config.json must be byte-identical (never written).
  const trackedConfigAfter = await fs.readFile(CONFIG_PATH, 'utf8');
  assert.equal(trackedConfigAfter, trackedConfigBefore, 'tracked taskctl.config.json unchanged');
});

// `new` refuses to clobber an existing task.
test('`new` refuses to overwrite an existing task', async () => {
  createdTasks.add('demo');
  await cleanupTask('demo');
  const r1 = runCli(['new', 'demo', '--title', 'first']);
  assert.equal(r1.status, 0);
  const r2 = runCli(['new', 'demo', '--title', 'second']);
  assert.notEqual(r2.status, 0, 'second new must fail');
  assert.match((r2.stdout || '') + (r2.stderr || ''), /already exists/i);
});

// `new` with a traversal slug is rejected and creates nothing outside ai/tasks.
test('`new ../escape` is rejected with no escape dir created', async () => {
  const r = runCli(['new', '../escape', '--title', 'x']);
  assert.notEqual(r.status, 0);
  assert.match((r.stdout || '') + (r.stderr || ''), /Invalid slug/i);
  assert.equal(fsSync.existsSync(path.join(ORCH_ROOT, 'ai', 'escape')), false);
});
