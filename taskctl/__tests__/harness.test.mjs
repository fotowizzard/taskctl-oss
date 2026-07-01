import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveHarnessVars, deriveProjectName, materializeHarness, confinedDestPath,
  HARNESS_MANIFEST, HARNESS_TEMPLATES_DIR,
} from '../harness.mjs';

const tmp = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

// A complete vars map (the 9 keys resolveHarnessVars always provides) for fixture tests.
const VARS = {
  PROJECT: 'demo', PROJECT_SLUG: 'demo', TARGET_REPO: 'git@x:me/demo.git', TRACKER: 'local',
  JIRA_KEY: 'k', INTEGRATION_BRANCH: 'main', PR_TARGET: 'main', GRACE_ENABLED: 'false',
  GRACE_PILOT: 'experiment/grace-pilot',
};
const TEST_MANIFEST = [
  { kind: 'template', src: 'greet.md.tmpl', dest: 'CLAUDE.md' },
  { kind: 'verbatim', src: 'nested/plain.sh', dest: 'ops/plain.sh' },
];

async function fixtureTemplates() {
  const dir = await tmp('harness-fix-');
  await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(dir, 'greet.md.tmpl'), '# {{PROJECT}}\ntracker={{TRACKER}}\n', 'utf8');
  await fs.writeFile(path.join(dir, 'nested', 'plain.sh'), '#!/bin/sh\necho generic\n', 'utf8');
  return dir;
}

test('deriveProjectName strips orchestration/sidecar suffix', () => {
  assert.equal(deriveProjectName('/x/acme-orchestration'), 'acme');
  assert.equal(deriveProjectName('/x/acme-orchestartion'), 'acme'); // tolerate the common misspelling too
  assert.equal(deriveProjectName('/x/foo-sidecar'), 'foo');
  assert.equal(deriveProjectName('/x/plainname'), 'plainname');
});

test('resolveHarnessVars falls back safely with empty config/env', () => {
  const v = resolveHarnessVars({}, {}, { workspaceRoot: '/x/acme-orchestration' });
  assert.equal(v.PROJECT, 'acme');
  assert.equal(v.TRACKER, 'local');
  assert.equal(v.INTEGRATION_BRANCH, 'main');
  assert.equal(v.PR_TARGET, 'main');
  assert.equal(v.GRACE_ENABLED, 'false');
  assert.equal(v.GRACE_PILOT, 'experiment/grace-pilot');
  assert.match(v.TARGET_REPO, /TODO/);
  assert.match(v.JIRA_KEY, /TODO/);
});

test('resolveHarnessVars uses config + env + gitRemote; prTarget falls back to integration', () => {
  const cfg = { tracker: { type: 'jira' }, branches: { integration: 'dev' }, grace: { enabled: true, pilotBranch: 'exp/g' } };
  const v = resolveHarnessVars(cfg, { JIRA_PROJECT_KEY: 'ABC' }, { name: 'myproj', gitRemote: 'git@github.com:me/repo.git' });
  assert.equal(v.PROJECT, 'myproj');
  assert.equal(v.TRACKER, 'jira');
  assert.equal(v.JIRA_KEY, 'ABC');
  assert.equal(v.INTEGRATION_BRANCH, 'dev');
  assert.equal(v.PR_TARGET, 'dev'); // falls back to integration when unset
  assert.equal(v.GRACE_ENABLED, 'true');
  assert.equal(v.GRACE_PILOT, 'exp/g');
  assert.equal(v.TARGET_REPO, 'git@github.com:me/repo.git');
});

test('materializeHarness writes rendered + verbatim, is idempotent, and never overwrites edits', async () => {
  const templatesDir = await fixtureTemplates();
  const ws = await tmp('harness-ws-');

  const s1 = await materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: TEST_MANIFEST });
  assert.deepEqual(s1.written.sort(), ['CLAUDE.md', 'ops/plain.sh']);
  assert.equal(s1.keptExisting.length, 0);
  assert.equal(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8'), '# demo\ntracker=local\n');
  assert.equal(await fs.readFile(path.join(ws, 'ops', 'plain.sh'), 'utf8'), '#!/bin/sh\necho generic\n');

  // re-run → idempotent (nothing written, both identical)
  const s2 = await materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: TEST_MANIFEST });
  assert.equal(s2.written.length, 0);
  assert.deepEqual(s2.skippedIdentical.sort(), ['CLAUDE.md', 'ops/plain.sh']);

  // user edits a rendered file → next run KEEPS it (never overwrites)
  await fs.writeFile(path.join(ws, 'CLAUDE.md'), '# my own edits\n', 'utf8');
  const s3 = await materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: TEST_MANIFEST });
  assert.deepEqual(s3.keptExisting, ['CLAUDE.md']);
  assert.equal(await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf8'), '# my own edits\n');
});

test('dry-run reports the plan but writes nothing', async () => {
  const templatesDir = await fixtureTemplates();
  const ws = await tmp('harness-dry-');
  const s = await materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: TEST_MANIFEST, dryRun: true });
  assert.equal(s.dryRun, true);
  assert.deepEqual(s.written.sort(), ['CLAUDE.md', 'ops/plain.sh']);
  assert.equal(fsSync.existsSync(path.join(ws, 'CLAUDE.md')), false);
  assert.equal(fsSync.existsSync(path.join(ws, 'ops', 'plain.sh')), false);
});

test('a template with an unknown placeholder is a hard error (never a silent leftover)', async () => {
  const templatesDir = await tmp('harness-bad-');
  await fs.writeFile(path.join(templatesDir, 'bad.tmpl'), 'hello {{NOPE}}', 'utf8');
  const ws = await tmp('harness-badws-');
  await assert.rejects(
    () => materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: [{ kind: 'template', src: 'bad.tmpl', dest: 'x.md' }] }),
    /unsubstituted placeholder|NOPE/,
  );
  assert.equal(fsSync.existsSync(path.join(ws, 'x.md')), false); // nothing written on failure
});

// Integration: the REAL shipped harness renders cleanly with fully-resolved vars —
// this also enforces that every template uses ONLY the 9 known placeholders.
test('real HARNESS_MANIFEST renders with no leftover placeholder', async () => {
  const ws = await tmp('harness-real-');
  const vars = resolveHarnessVars(
    { tracker: { type: 'jira' }, branches: { integration: 'main' }, grace: { enabled: true } },
    { JIRA_PROJECT_KEY: 'DEMO' },
    { name: 'demo', gitRemote: 'git@github.com:me/demo.git' },
  );
  const summary = await materializeHarness({ workspaceRoot: ws, vars }); // real templatesDir + manifest
  assert.equal(summary.written.length, HARNESS_MANIFEST.length, 'every manifest entry written into a fresh workspace');
  for (const entry of HARNESS_MANIFEST) {
    const body = await fs.readFile(path.join(ws, entry.dest), 'utf8');
    assert.ok(body.length > 0, `${entry.dest} is non-empty`);
    assert.equal(/\{\{\w+\}\}/.test(body), false, `${entry.dest} has no leftover {{placeholder}}`);
  }
});

// Public-neutrality guard: the shipped harness templates must be project-neutral
// English — no Cyrillic (they were generalized from Russian-narrative references).
// (\u escape so this test file carries no literal Cyrillic either.)
test('shipped harness templates are public-neutral (Cyrillic-free)', () => {
  const hasCyrillic = (str) => { for (const ch of str) { const c = ch.codePointAt(0); if (c >= 0x0400 && c <= 0x04FF) return true; } return false; };
  const root = HARNESS_TEMPLATES_DIR;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (hasCyrillic(fsSync.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `harness templates must be Cyrillic-free (project-neutral):\n${offenders.join('\n')}`);
});

test('materializeHarness refuses a manifest dest that escapes the workspace', async () => {
  const templatesDir = await fixtureTemplates();
  const ws = await tmp('harness-esc-');
  for (const badDest of ['../evil.md', 'a/../../evil', process.platform === 'win32' ? 'C:/evil' : '/etc/evil']) {
    await assert.rejects(
      () => materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: [{ kind: 'template', src: 'greet.md.tmpl', dest: badDest }] }),
      /relative path|escapes the workspace/,
      `dest "${badDest}" must be rejected`,
    );
  }
  // a normal nested dest resolves under the workspace
  assert.ok(confinedDestPath(ws, 'onboarding/00-START-HERE.md').startsWith(path.resolve(ws)));
});

test('a non-word leftover placeholder ({{ spaced }} / {{hy-phen}}) is also a hard error', async () => {
  const templatesDir = await tmp('harness-broad-');
  await fs.writeFile(path.join(templatesDir, 'spaced.tmpl'), 'x {{ PROJECT }} y', 'utf8');
  await fs.writeFile(path.join(templatesDir, 'hyphen.tmpl'), 'x {{HY-PHEN}} y', 'utf8');
  const ws = await tmp('harness-broadws-');
  for (const src of ['spaced.tmpl', 'hyphen.tmpl']) {
    await assert.rejects(
      () => materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: [{ kind: 'template', src, dest: 'x.md' }] }),
      /unsubstituted placeholder/,
      `${src} must be rejected`,
    );
    assert.equal(fsSync.existsSync(path.join(ws, 'x.md')), false);
  }
});

test('verbatim files are copied byte-for-byte (multibyte preserved)', async () => {
  const templatesDir = await tmp('harness-bytes-');
  const bytes = Buffer.from('#!/bin/sh\n# check ok ✓ alpha αβγ\n', 'utf8');
  await fs.writeFile(path.join(templatesDir, 'v.sh'), bytes);
  const ws = await tmp('harness-bytez-');
  await materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: [{ kind: 'verbatim', src: 'v.sh', dest: 'ops/v.sh' }] });
  const out = await fs.readFile(path.join(ws, 'ops', 'v.sh'));
  assert.ok(out.equals(bytes), 'verbatim bytes preserved exactly');
});

test('materializeHarness refuses to write OR mkdir through a symlink/junction parent that escapes', async () => {
  const templatesDir = await fixtureTemplates();
  const ws = await tmp('harness-link-');
  const outside = await tmp('harness-outside-');
  try {
    // make ws/ops a link to a dir OUTSIDE the workspace (junction on Windows, dir symlink elsewhere)
    await fs.symlink(outside, path.join(ws, 'ops'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch { return; } // environment lacks symlink privilege — skip
  // NESTED dest: the confinement check must fire BEFORE mkdir, so not even `outside/sub` is created.
  await assert.rejects(
    () => materializeHarness({ workspaceRoot: ws, templatesDir, vars: VARS, manifest: [{ kind: 'verbatim', src: 'nested/plain.sh', dest: 'ops/sub/plain.sh' }] }),
    /outside the workspace|escape/,
  );
  assert.equal(fsSync.existsSync(path.join(outside, 'plain.sh')), false, 'no file written outside the workspace');
  assert.equal(fsSync.existsSync(path.join(outside, 'sub')), false, 'no directory created outside the workspace');
});
