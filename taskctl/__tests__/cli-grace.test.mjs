/**
 * WP2 Stage 2a — CLI subprocess tests for the GRACE opt-in shim.
 *
 *   T2a-int-3   : command guard — `sync-grace` / `grace-gate` rejected when
 *                 grace disabled (non-zero + "requires GRACE governance"); they
 *                 dispatch when enabled (binary-missing path tolerated).
 *   T2a-int-4   : footgun gone — `--help` has no --deferred-grace/--full-grace;
 *                 preparing `plan` writes no state.graceMode.
 *   T2a-int-2   : disabled writers — a prepared `plan` prompt carries no GRACE
 *                 hint text with grace disabled (default).
 *   T2a-int-5   : readers gated (C2) — with grace disabled and a legacy
 *                 state.graceGate on disk, handoff.md OMITS the gate section.
 *   T2a-smoke   : enabled-GRACE fixture — with grace.enabled + custom branches,
 *                 `sync-grace --dry-run` references the CUSTOM branch names and
 *                 NO `origin/dev` / `experiment/grace-pilot` literal.
 *
 * Each test runs in an ISOLATED temp workspace (copy of taskctl/ + ai/templates/
 * + a planted taskctl.config.json) so the tracked config is never touched and
 * grace.enabled can be controlled per-test. The CLI derives all roots from
 * cli.mjs's own dir, so the workspace copy is self-contained.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VP_REPO_ROOT', 'VIBE_ROOT']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

// Build a self-contained temp workspace with the given config object.
async function makeWorkspace(configObj) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-grace-cli-'));
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

// ── T2a-int-3: command guard ───────────────────────────────────────────────

test('T2a-int-3: sync-grace / grace-gate rejected when grace disabled (default)', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    for (const cmd of ['sync-grace', 'grace-gate']) {
      const r = runWs(ws, [cmd]);
      assert.notEqual(r.status, 0, `${cmd} should exit non-zero when grace disabled`);
      const combined = (r.stdout || '') + (r.stderr || '');
      assert.match(combined, /requires GRACE governance, which is disabled/i,
        `${cmd} prints the disabled-grace message`);
    }
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('T2a-int-3: sync-grace dispatches when grace enabled (env/repo error, NOT the guard)', async () => {
  // grace.enabled:true + repoPath '.' → passes the main() guard, then the
  // sync-grace adapter runs and fails on env sanity (the workspace isn't the
  // pilot branch). The key assertion: it is NOT rejected by the disabled guard.
  const ws = await makeWorkspace({
    repoPath: '.', grace: { enabled: true, pilotBranch: 'pilot-x', upstreamBranch: 'main-y' },
  });
  try {
    const r = runWs(ws, ['sync-grace']);
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(/requires GRACE governance, which is disabled/i.test(combined), false,
      'enabled grace must NOT hit the disabled guard');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2a-int-4: footgun gone ────────────────────────────────────────────────

test('T2a-int-4: --help has no --deferred-grace / --full-grace flags', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    const r = runWs(ws, ['--help']);
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(/--deferred-grace/.test(combined), false, 'no --deferred-grace in usage');
    assert.equal(/--full-grace/.test(combined), false, 'no --full-grace in usage');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('T2a-int-4: preparing plan writes no state.graceMode', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-fg');
    const r = runWs(ws, ['plan', 'demo-fg']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const state = JSON.parse(await fs.readFile(path.join(ws, 'ai', 'tasks', 'demo-fg', 'state.json'), 'utf8'));
    assert.equal('graceMode' in state, false, 'state.json carries no graceMode');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2a-int-2: disabled writers ────────────────────────────────────────────

test('T2a-int-2: prepared plan prompt has no GRACE hint when grace disabled', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-w');
    const r = runWs(ws, ['plan', 'demo-w']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const prompt = await fs.readFile(path.join(ws, 'ai', 'tasks', 'demo-w', '.prompt-plan.md'), 'utf8');
    // Look for the GRACE *hint markers* (not the bare word "GRACE", which can
    // appear in the embedded workspace temp path, e.g. taskctl-grace-cli-...).
    assert.equal(/GRACE Pilot Mode|GRACE Context \(Deferred|## GRACE Context|GRACE Packet/.test(prompt), false,
      'no GRACE hint in the prepared prompt');
    const ctx = await fs.readFile(path.join(ws, 'ai', 'tasks', 'demo-w', 'context.md'), 'utf8');
    assert.equal(/## GRACE Context/.test(ctx), false, 'no GRACE block in context.md');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2a-int-5: readers gated (C2) ──────────────────────────────────────────

test('T2a-int-5: handoff OMITS gate section when grace disabled even with a legacy state.graceGate', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-r');
    // Inject a legacy graceGate into state.json (as a prior GRACE run would have).
    const statePath = path.join(ws, 'ai', 'tasks', 'demo-r', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.graceGate = {
      verdict: 'pass', branch: 'experiment/grace-pilot', ranAt: new Date().toISOString(),
      checks: {
        standard: { status: 'pass', summary: '0 errors / 0 warnings', output: '' },
        autonomous: { status: 'pass', summary: '0 errors / 0 warnings', output: '' },
        pythonXml: { status: 'pass', summary: 'OK', output: '' },
      },
    };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['handoff', 'demo-r']);
    assert.equal(r.status, 0, `handoff exit 0; stderr=${r.stderr}`);
    const handoff = await fs.readFile(path.join(ws, 'ai', 'tasks', 'demo-r', 'handoff.md'), 'utf8');
    assert.equal(/## GRACE Gates/.test(handoff), false,
      'handoff omits the gate section when grace disabled (legacy state ignored)');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('T2a-int-5: handoff INCLUDES gate section when grace enabled and a gate is present', async () => {
  const ws = await makeWorkspace({ repoPath: '.', grace: { enabled: true } });
  try {
    await seedLocalTask(ws, 'demo-r2');
    const statePath = path.join(ws, 'ai', 'tasks', 'demo-r2', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.graceGate = {
      verdict: 'pass', branch: 'experiment/grace-pilot', ranAt: new Date().toISOString(),
      checks: {
        standard: { status: 'pass', summary: '0 errors / 0 warnings', output: '' },
        autonomous: { status: 'pass', summary: '0 errors / 0 warnings', output: '' },
        pythonXml: { status: 'pass', summary: 'OK', output: '' },
      },
    };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['handoff', 'demo-r2']);
    assert.equal(r.status, 0, `handoff exit 0; stderr=${r.stderr}`);
    const handoff = await fs.readFile(path.join(ws, 'ai', 'tasks', 'demo-r2', 'handoff.md'), 'utf8');
    assert.match(handoff, /## GRACE Gates/, 'handoff includes the gate section when grace enabled');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2a-smoke: enabled-GRACE fixture with CUSTOM branches ──────────────────

test('T2a-smoke: sync-grace --dry-run references CUSTOM branches, no origin/dev or pilot literal', async () => {
  // Build a real git repo on a CUSTOM pilot branch, with a CUSTOM upstream
  // remote-tracking ref, so the dry-run divergence/conflict prediction runs
  // against the configured names — proving C3 branch threading end to end.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-grace-syncrepo-'));
  const ws = await makeWorkspace({
    repoPath: '.', grace: { enabled: true, pilotBranch: 'pilot-x', upstreamBranch: 'main-y' },
  });
  try {
    const run = (cmd) => execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    run('git init -b pilot-x');
    run('git config user.email t@t');
    run('git config user.name t');
    await fs.writeFile(path.join(repo, 'a.txt'), 'base\n', 'utf8');
    run('git add -A');
    run('git commit -m base --no-gpg-sign');
    // Build a CUSTOM upstream (main-y) one commit AHEAD of pilot-x so the
    // dry-run takes the divergence/predict path (not the up-to-date fast path).
    run('git branch main-y');
    run('git checkout main-y --quiet');
    await fs.writeFile(path.join(repo, 'b.txt'), 'upstream change\n', 'utf8');
    run('git add -A');
    run('git commit -m upstream --no-gpg-sign');
    run('git checkout pilot-x --quiet');
    // Remote-tracking ref origin/main-y at the upstream tip + an origin remote
    // (points at the repo itself) so `git fetch origin main-y` doesn't hard-fail.
    run('git update-ref refs/remotes/origin/main-y main-y');
    run(`git remote add origin "${repo.replace(/\\/g, '/')}"`);

    const r = runWs(ws, ['sync-grace', '--dry-run', '--repo-path', repo]);
    const combined = (r.stdout || '') + (r.stderr || '');
    // It reached the sync logic (not the disabled guard, not a wrong-branch bail).
    assert.equal(/requires GRACE governance/i.test(combined), false, 'not blocked by disabled guard');
    // The CUSTOM branch names appear; the VP defaults do NOT. Scope the literal
    // checks to the program OUTPUT only (the repo temp path itself can't contain
    // these tokens since mkdtemp uses a different prefix).
    assert.match(combined, /main-y/, 'references custom upstream branch name');
    assert.match(combined, /origin\/main-y is \d+ ahead/, 'divergence line uses the custom upstream');
    assert.equal(/origin\/dev\b/.test(combined), false, 'no origin/dev literal in sync path');
    assert.equal(/experiment\/grace-pilot/.test(combined), false, 'no experiment/grace-pilot literal in sync path');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});
