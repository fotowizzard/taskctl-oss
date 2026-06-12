/**
 * WP1 — config loader unit tests (T-unit-1, 1b, 1c, 1d, 1e).
 * Built-in node:test runner. No new dependency.
 *
 * Every test snapshots/restores process.env and uses { loadEnv:false } so the
 * loader never pulls in real .env files — process.env is fully controlled here.
 * Config files live in fs.mkdtemp temp dirs so the working tree is never mutated.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadTaskctlConfig,
  loadJiraCreds,
  validateTrackerType,
  loadConfig,
  loadEnvOnly,
  normalizeRuntimeConfig,
  validateGraceConfig,
} from '../config.mjs';

const JIRA_VARS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'];
// TASKCTL_SIBLING_SENTINEL is used by T-unit-1f to prove a sibling
// jira-importer/.env is NOT probed (the old VIBE_ROOT sibling-probe was removed).
const TOUCHED = [...JIRA_VARS, 'REPO_PATH', 'VIBE_ROOT', 'TASKCTL_SIBLING_SENTINEL'];

let envSnapshot;

beforeEach(() => {
  envSnapshot = {};
  for (const k of TOUCHED) envSnapshot[k] = process.env[k];
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-cfg-'));
}

async function writeConfig(dir, obj) {
  await fs.writeFile(path.join(dir, 'taskctl.config.json'), JSON.stringify(obj), 'utf8');
}

function setJira() {
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'dev@example.com';
  process.env.JIRA_API_TOKEN = 'tok-xxx';
  process.env.JIRA_PROJECT_KEY = 'CP';
}

// T-unit-1 — defaults: no file, no JIRA env → local, repoPath null, no branches, never throws.
test('T-unit-1: no config + no Jira env → local, repoPath null, never throws', async () => {
  const dir = await tmpDir();
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.tracker.type, 'local');
  assert.equal(cfg.repoPath, null);
  assert.equal(cfg.fileFound, false);
  assert.equal('branches' in cfg, false, 'no branches key in WP1');
});

// T-unit-1b — config file surfaces; relative repoPath resolved against config dir; no projectKey key.
test('T-unit-1b: config file with relative repoPath resolves against config dir; jira type; no projectKey', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: './sub', tracker: { type: 'jira' } });
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.tracker.type, 'jira');
  assert.equal(cfg.repoPath, path.resolve(dir, './sub'));
  assert.equal('projectKey' in cfg.tracker, false, 'projectKey is env-only, not a config field');
});

// T-unit-1c — legacy-env back-compat.
test('T-unit-1c: no config + complete JIRA env → jira (legacy preserved)', async () => {
  const dir = await tmpDir();
  setJira();
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.tracker.type, 'jira');
});

test('T-unit-1c: config file present but no tracker.type + complete JIRA env → local (file opts into new model)', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: '.' }); // no tracker field
  setJira();
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.tracker.type, 'local');
});

// T-unit-1d — env precedence + unknown type + loadJiraCreds behavior.
test('T-unit-1d: REPO_PATH env wins over file repoPath', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: './sub', tracker: { type: 'local' } });
  process.env.REPO_PATH = 'S:/explicit/env/repo';
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.repoPath, 'S:/explicit/env/repo');
});

test('T-unit-1d: unknown tracker.type throws a precise error', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { tracker: { type: 'jria' } });
  await assert.rejects(
    () => loadTaskctlConfig({ configRoot: dir, loadEnv: false }),
    /Invalid tracker\.type "jria"/
  );
});

test('T-unit-1d: validateTrackerType throws for unknown, accepts known', () => {
  assert.throws(() => validateTrackerType('jria'), /Invalid tracker\.type/);
  assert.doesNotThrow(() => validateTrackerType('local'));
  assert.doesNotThrow(() => validateTrackerType('jira'));
});

test('T-unit-1d: loadJiraCreds returns projectKey from env when all JIRA_* set', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { tracker: { type: 'jira' } });
  setJira();
  const tcfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  const creds = await loadJiraCreds(tcfg, {}); // loadConfig with no envPath; env already set
  assert.equal(creds.projectKey, 'CP');
  assert.equal(creds.baseUrl, 'https://example.atlassian.net');
});

test('T-unit-1d: loadJiraCreds is a pass-through to loadConfig (same creds object shape)', async () => {
  // loadJiraCreds adds NO override logic — it returns exactly loadConfig()'s
  // result. With all four JIRA_* set, the creds object carries the env values.
  // (The missing-var THROW is loadConfig's own unchanged contract; we don't
  // re-test it here because loadConfig hard-loads real .env files from the
  // generic chain (taskctl/.env → workspace root .env), which could re-populate
  // the var and make a "missing var" assertion environment-dependent. The
  // pass-through identity below is what proves no override path was introduced.)
  const dir = await tmpDir();
  await writeConfig(dir, { tracker: { type: 'jira' } });
  setJira();
  const tcfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  const viaCreds = await loadJiraCreds(tcfg, {});
  const viaConfig = await loadConfig();
  assert.deepEqual(viaCreds, viaConfig, 'loadJiraCreds returns exactly loadConfig() output');
  assert.equal(viaCreds.projectKey, process.env.JIRA_PROJECT_KEY);
});

// T-unit-1f — regression: the loaders do not probe `$VIBE_ROOT/jira-importer/.env`.
// The old code read TWO origin-coupled sources removed in WP6: (1) the
// `$VIBE_ROOT/jira-importer/.env` probe — exercised here at runtime (VIBE_ROOT
// pointed at a temp dir that DOES contain jira-importer/.env; the sentinel must
// not leak); (2) an ORCH_ROOT-relative `../jira-importer/.env` probe — NOT
// runtime-testable hermetically (it would require planting a file OUTSIDE the
// workspace, at <install>/../), so its removal is pinned by code review only
// (config.mjs no longer references it). This test's coverage claim is therefore
// deliberately scoped to the VIBE_ROOT probe.
test('T-unit-1f: loaders do not read $VIBE_ROOT/jira-importer/.env (sibling probe removed)', async () => {
  const vibeRoot = await tmpDir();
  const importerDir = path.join(vibeRoot, 'jira-importer');
  await fs.mkdir(importerDir, { recursive: true });
  // A sentinel the old VIBE_ROOT sibling-probe would have loaded.
  await fs.writeFile(
    path.join(importerDir, '.env'),
    'TASKCTL_SIBLING_SENTINEL=leaked-from-sibling\n',
    'utf8'
  );
  process.env.VIBE_ROOT = vibeRoot;

  // loadEnvOnly never throws — call it and assert the sentinel did not leak.
  await loadEnvOnly();
  assert.equal(
    process.env.TASKCTL_SIBLING_SENTINEL,
    undefined,
    'loadEnvOnly must not load a sibling jira-importer/.env'
  );

  // loadConfig WILL throw (no JIRA_* provided), but the throw happens AFTER the
  // .env chain has been loaded — so a probe would still have populated the
  // sentinel. Assert it stayed unset regardless of the throw.
  await assert.rejects(() => loadConfig(), /Missing required env vars/);
  assert.equal(
    process.env.TASKCTL_SIBLING_SENTINEL,
    undefined,
    'loadConfig must not load a sibling jira-importer/.env'
  );
});

// T-unit-1e — partial legacy Jira env → local (intentional migration behavior).
test('T-unit-1e: no config + only 3 of 4 JIRA_* (missing JIRA_PROJECT_KEY) → local', async () => {
  const dir = await tmpDir();
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'dev@example.com';
  process.env.JIRA_API_TOKEN = 'tok-xxx';
  // JIRA_PROJECT_KEY intentionally unset
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.tracker.type, 'local', 'incomplete legacy env is not a Jira install');
});

// Malformed config JSON should surface (not be swallowed as ENOENT).
test('malformed config JSON surfaces as an error', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'taskctl.config.json'), '{ not json', 'utf8');
  await assert.rejects(() => loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
});

// Absolute repoPath in config is preserved as-is.
test('absolute repoPath in config is used verbatim', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: 'S:/REPS/some-repo', tracker: { type: 'local' } });
  const cfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  assert.equal(cfg.repoPath, 'S:/REPS/some-repo');
});

// ── WP2 Stage 2a: normalizeRuntimeConfig + grace block ─────────────────────

// T2a-unit-0 — runtime config object: fields present + grace defaulted off.
test('T2a-unit-0: normalizeRuntimeConfig surfaces {repoPath, tracker, grace} with grace disabled by default', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: 'S:/REPS/r', tracker: { type: 'local' } });
  const tcfg = await loadTaskctlConfig({ configRoot: dir, loadEnv: false });
  const rcfg = normalizeRuntimeConfig(tcfg);
  assert.equal(rcfg.repoPath, 'S:/REPS/r');
  assert.equal(rcfg.tracker.type, 'local');
  assert.equal(rcfg.grace.enabled, false, 'grace disabled by default');
  assert.equal(rcfg.grace.pilotBranch, 'experiment/grace-pilot', 'default pilot branch');
  assert.equal(rcfg.grace.upstreamBranch, 'dev', 'default upstream branch');
});

// T2a-unit-1 — grace config: absent → disabled; explicit true + custom branches surfaced; bad types throw.
test('T2a-unit-1: no grace block → grace.enabled false', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { tracker: { type: 'local' } });
  const rcfg = normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
  assert.equal(rcfg.grace.enabled, false);
});

test('T2a-unit-1: grace.enabled:true + custom branches surfaced', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, {
    repoPath: 'S:/REPS/r',
    grace: { enabled: true, pilotBranch: 'pilot-x', upstreamBranch: 'main-y' },
  });
  const rcfg = normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
  assert.equal(rcfg.grace.enabled, true);
  assert.equal(rcfg.grace.pilotBranch, 'pilot-x');
  assert.equal(rcfg.grace.upstreamBranch, 'main-y');
});

test('T2a-unit-1: non-boolean grace.enabled throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { grace: { enabled: 'yes' } });
  await assert.rejects(
    async () => normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false })),
    /Invalid grace\.enabled/
  );
});

test('T2a-unit-1: non-string grace branch throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { grace: { pilotBranch: 42 } });
  await assert.rejects(
    async () => normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false })),
    /Invalid grace\.pilotBranch/
  );
});

test('T2a-unit-1: validateGraceConfig accepts absent + valid; rejects bad enabled', () => {
  assert.doesNotThrow(() => validateGraceConfig(undefined));
  assert.doesNotThrow(() => validateGraceConfig({ enabled: true, pilotBranch: 'p' }));
  assert.throws(() => validateGraceConfig({ enabled: 1 }), /Invalid grace\.enabled/);
  assert.throws(() => validateGraceConfig([]), /expected an object/);
});

// T2a-unit-5 — grace.repoRoot fallback (C5).
test('T2a-unit-5: grace.repoRoot falls back to repoPath when grace.repoRoot unset', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: 'S:/REPS/r', grace: { enabled: true } });
  const rcfg = normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
  assert.equal(rcfg.grace.repoRoot, 'S:/REPS/r');
});

test('T2a-unit-5: explicit grace.repoRoot wins over repoPath', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { repoPath: 'S:/REPS/r', grace: { enabled: true, repoRoot: 'S:/REPS/governed' } });
  const rcfg = normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
  assert.equal(rcfg.grace.repoRoot, 'S:/REPS/governed');
});

test('T2a-unit-5: grace.enabled:true with no repoRoot/repoPath/REPO_PATH throws', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { grace: { enabled: true } }); // no repoPath
  await assert.rejects(
    async () => normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false })),
    /grace\.enabled is true but no repo root resolved/
  );
});

test('T2a-unit-5: grace disabled with no repoRoot does NOT throw (repoRoot null)', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { tracker: { type: 'local' } }); // no repoPath, grace absent
  const rcfg = normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
  assert.equal(rcfg.grace.enabled, false);
  assert.equal(rcfg.grace.repoRoot, null);
});
