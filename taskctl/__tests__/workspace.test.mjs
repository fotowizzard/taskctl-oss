/**
 * WP5 Stage 5b — T5b-0: workspace-root DISCOVERY (New-C1, the keystone).
 *
 * resolveWorkspaceRoot(cwd) finds the nearest ancestor with a
 * taskctl.config.json; with none above cwd it falls back to the installation
 * root (the EXACT pre-5b behavior). These tests pin the three branches +
 * first-match-stop via _statHooks. The TRUE e2e threading proof (a subprocess
 * with cwd:<TARGET> actually reading the target workspace) lives in the
 * new-project end-to-end test (T5b-8 / audit-iter3 I-3) — a resolver assertion
 * alone cannot prove call-sites thread the discovered root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveWorkspaceRoot, workspaceBundle, INSTALLATION_ROOT } from '../workspace.mjs';

const DEFAULT_CONFIG_NAME = 'taskctl.config.json';

async function tmp(prefix = 'taskctl-ws-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('T5b-0: planted-config dir → root === that dir (parity with today)', async () => {
  const ws = await tmp();
  // realpath: macOS/Windows tmp can be a symlink (/var → /private/var); the
  // resolver returns the dir it walked to, so compare on realpath both sides.
  const real = await fs.realpath(ws);
  await fs.writeFile(path.join(real, DEFAULT_CONFIG_NAME), '{}', 'utf8');
  const { root, source } = resolveWorkspaceRoot(real);
  assert.equal(root, real);
  assert.equal(source, 'discovered');
});

test('T5b-0: nested subdir of a planted-config dir → walks UP to it', async () => {
  const ws = await fs.realpath(await tmp());
  await fs.writeFile(path.join(ws, DEFAULT_CONFIG_NAME), '{}', 'utf8');
  const nested = path.join(ws, 'a', 'b', 'c');
  await fs.mkdir(nested, { recursive: true });
  const { root, source } = resolveWorkspaceRoot(nested);
  assert.equal(root, ws);
  assert.equal(source, 'discovered');
});

test('T5b-0: bare dir with NO ancestor config → install fallback', async () => {
  // A temp dir with no config anywhere up-tree. Override installRoot to a known
  // sentinel so the fallback is unambiguous (the real INSTALLATION_ROOT may
  // itself sit under a config on a dev box).
  const bare = await fs.realpath(await tmp());
  const sentinel = '/__install_sentinel__';
  const { root, source } = resolveWorkspaceRoot(bare, { installRoot: sentinel });
  assert.equal(root, sentinel);
  assert.equal(source, 'install');
});

test('T5b-0: default installRoot is the package INSTALLATION_ROOT', async () => {
  // With _statHooks reporting "no config anywhere", the fallback is the real
  // install root (no override).
  const { root, source } = resolveWorkspaceRoot('/somewhere/deep', {
    _statHooks: { exists: () => false },
  });
  assert.equal(root, INSTALLATION_ROOT);
  assert.equal(source, 'install');
});

test('T5b-0: _statHooks proves the walk STOPS at the first ancestor config (no over-walk)', () => {
  // Layout (win32-agnostic via path.join): /w has a config; /w/x/y is cwd. The
  // resolver must probe y, then x, then HIT w and STOP — never probing above w.
  const root = path.resolve(path.sep, 'w');
  const x = path.join(root, 'x');
  const y = path.join(x, 'y');
  const probed = [];
  const hasConfig = new Set([path.join(root, DEFAULT_CONFIG_NAME)]);
  const res = resolveWorkspaceRoot(y, {
    _statHooks: {
      exists: (p) => { probed.push(p); return hasConfig.has(p); },
    },
  });
  assert.equal(res.root, root);
  assert.equal(res.source, 'discovered');
  // It probed y and x (misses) then w (hit) — and NOTHING above w.
  assert.deepEqual(probed, [
    path.join(y, DEFAULT_CONFIG_NAME),
    path.join(x, DEFAULT_CONFIG_NAME),
    path.join(root, DEFAULT_CONFIG_NAME),
  ]);
});

test('T5b-0: workspaceBundle derives the four values + is frozen', () => {
  const root = path.resolve(path.sep, 'proj', 'demo');
  const b = workspaceBundle(root);
  assert.equal(b.root, root);
  assert.equal(b.tasksDir, path.join(root, 'ai', 'tasks'));
  assert.equal(b.templatesDir, path.join(root, 'ai', 'templates'));
  assert.equal(b.O, root.replace(/\\/g, '/'));
  assert.ok(Object.isFrozen(b), 'bundle is frozen (no mutable post-discovery state)');
});
