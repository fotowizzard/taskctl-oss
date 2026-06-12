/**
 * WP2 Stage 2a — grace.mjs unit/integration tests.
 *   T2a-int-cycle : module graph is acyclic (subprocess import of each module
 *                   resolves) + grace.mjs exports the public surface.
 *   T2a-int-1     : runGraceGate degrades gracefully (skipped-no-repo /
 *                   skipped-non-pilot-branch) without a grace binary.
 *   T2a-unit-2    : buildContextMd read-path gate — graceOpts omitted (default
 *                   null) → NO GRACE block / note; graceOpts pointing at a
 *                   pilot-branch repo with a governed map → block present
 *                   (exercises the context-builder → grace call edge).
 *
 * No working tree is mutated: temp repos live under fs.mkdtemp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grace from '../grace.mjs';
import { buildContextMd } from '../context-builder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKCTL_DIR = path.resolve(__dirname, '..');

function makeIssue(summary, labels = []) {
  return {
    key: 'CP-1',
    fields: {
      summary,
      status: { name: 'Open' },
      priority: { name: 'High' },
      assignee: null,
      issuetype: { name: 'Task' },
      labels,
      description: { type: 'doc', version: 1, content: [] },
      issuelinks: [],
      attachment: [],
    },
  };
}

// ── T2a-int-cycle: acyclic module graph + exports ──────────────────────────

test('T2a-int-cycle: import of grace/context-builder/cli each resolve (acyclic)', () => {
  for (const mod of ['grace.mjs', 'context-builder.mjs', 'cli.mjs']) {
    const abs = path.join(TASKCTL_DIR, mod).replace(/\\/g, '/');
    const r = spawnSync('node', ['-e', `import('file://${abs}').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})`], {
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 0, `import('${mod}') failed: ${r.stderr}`);
  }
});

test('T2a-int-cycle: grace.mjs source imports nothing from context-builder', async () => {
  const src = await fs.readFile(path.join(TASKCTL_DIR, 'grace.mjs'), 'utf8');
  assert.equal(/from\s+['"]\.\/context-builder/.test(src), false,
    'grace.mjs must not import from context-builder (one-way edge only)');
});

test('T2a-int-cycle: grace.mjs exports the public surface', () => {
  for (const name of [
    'runGraceGate', 'buildGracePromptHint', 'buildGraceContextBlock',
    'formatGraceGateMarkdown', 'printGraceGateReport',
    'detectUnmergedPaths', 'classifyConflictingPaths', 'predictConflicts',
    'listIncomingDevCommits', 'detectNewGovernedFiles', 'detectXmlCascadeNeeds',
    'finalizeAfterCleanRebase', 'runAutoResolveLoop', 'writeMarkupAgentPrompt',
  ]) {
    assert.equal(typeof grace[name], 'function', `grace.${name} should be exported`);
  }
});

// ── T2a-int-1: gate degrades gracefully when enabled ───────────────────────

test('T2a-int-1: runGraceGate on a non-existent repo → skipped-no-repo', async () => {
  const gate = await grace.runGraceGate('S:/nope/does-not-exist', 'experiment/grace-pilot');
  assert.equal(gate.verdict, 'skipped-no-repo');
});

test('T2a-int-1: runGraceGate off-pilot branch → skipped-non-pilot-branch', async () => {
  // Inject a branch detector that reports a non-pilot branch — no real git.
  const gate = await grace.runGraceGate(TASKCTL_DIR, 'experiment/grace-pilot', () => 'dev');
  assert.equal(gate.verdict, 'skipped-non-pilot-branch');
  assert.equal(gate.branch, 'dev');
});

test('T2a-int-1: runGraceGate honors a CUSTOM pilot branch name (does not short-circuit when branch matches)', async () => {
  // With the injected detector reporting the CUSTOM pilot branch, the gate must
  // proceed PAST the branch check (it then runs lint — verdict depends on
  // whether the grace binary is installed on this machine: pass/fail/skipped-
  // no-grace are all "proceeded"). The ONE thing it must NOT be is
  // skipped-non-pilot-branch — that would mean the custom name was ignored.
  const gate = await grace.runGraceGate(TASKCTL_DIR, 'pilot-x', () => 'pilot-x');
  assert.notEqual(gate.verdict, 'skipped-non-pilot-branch',
    'matching custom pilot branch must not short-circuit as non-pilot');
  assert.equal(gate.branch, 'pilot-x');
});

// ── T2a-unit-2: read-path gate via buildContextMd ──────────────────────────

test('T2a-unit-2: buildContextMd with grace OMITTED (default) → no GRACE block/note', () => {
  // WP2 Stage 2b atomic signature: (issue, ctx, ctxOpts). No ctxOpts.grace → off.
  const md = buildContextMd(makeIssue('Add document extraction', ['document']), { comments: [], links: [] });
  assert.equal(/## GRACE Context/.test(md), false, 'no GRACE block when grace absent');
  assert.equal(/governed-module/.test(md), false, 'no governed-module note when grace absent');
});

test('T2a-unit-2: buildContextMd with graceOpts on a pilot-branch governed repo → GRACE block present', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-grace-repo-'));
  try {
    // Minimal governed XML mapping a path to an M-ID.
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'docs', 'development-plan.xml'),
      `<Modules>
        <M-DOC-EXTRACTION>
          <target><source>src/services/document-extraction/</source></target>
        </M-DOC-EXTRACTION>
      </Modules>`,
      'utf8',
    );
    // Make it a git repo on a custom pilot branch so detectRepoBranch matches.
    const run = (cmd) => execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    run('git init -b pilot-x');
    run('git config user.email t@t');
    run('git config user.name t');
    run('git add -A');
    run('git commit -m init --no-gpg-sign');

    // The summary "document" maps (via guessCodeAreas) to a governed path.
    // codeAreas map provides the keyword→path so the governed sniff fires.
    const md = buildContextMd(
      makeIssue('Fix document extraction bug', ['document']),
      { comments: [], links: [] },
      { codeAreas: { document: ['src/services/document-extraction/'] }, grace: { repoRoot: repo, pilotBranch: 'pilot-x' } },
    );
    assert.match(md, /## GRACE Context/, 'GRACE block injected on pilot branch with governed paths');
    assert.match(md, /M-DOC-EXTRACTION/, 'governed M-ID surfaced in the block');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('T2a-unit-2: buildContextMd with graceOpts on a NON-pilot branch → governed note, not block', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-grace-repo2-'));
  try {
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'docs', 'development-plan.xml'),
      `<Modules><M-DOC-EXTRACTION><target><source>src/services/document-extraction/</source></target></M-DOC-EXTRACTION></Modules>`,
      'utf8',
    );
    const run = (cmd) => execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    run('git init -b some-feature');
    run('git config user.email t@t');
    run('git config user.name t');
    run('git add -A');
    run('git commit -m init --no-gpg-sign');

    const md = buildContextMd(
      makeIssue('Fix document extraction bug', ['document']),
      { comments: [], links: [] },
      // pilot is pilot-x, repo is some-feature; codeAreas supplies the governed path.
      { codeAreas: { document: ['src/services/document-extraction/'] }, grace: { repoRoot: repo, pilotBranch: 'pilot-x' } },
    );
    assert.equal(/## GRACE Context/.test(md), false, 'no full block off-pilot');
    assert.match(md, /governed-module paths but repo branch is `some-feature`/, 'off-pilot note present');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
