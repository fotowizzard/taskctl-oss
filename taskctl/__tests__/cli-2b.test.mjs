/**
 * WP2 Stage 2b — CLI subprocess tests (config externalization + scrub).
 *
 *   T2b-unit-repo  : a repo-needing command with no --repo-path/REPO_PATH/repoPath
 *                    → TASKCTL_EXIT + clear "No repo path" message.
 *   T2b-int-1      : config repoPath reaches the prepared prompt (no --repo-path).
 *   T2b-int-2      : custom branches.integration drives the review diff command;
 *                    branches.prTarget is honored by config (publish base).
 *   T2b-int-3      : promptLanguage + neutrality (I2) — default 'en' prompts have
 *                    NO Cyrillic and NO VP-semantic tokens; 'ru' yields Russian
 *                    but STILL no VP-semantic tokens.
 *   T2b-int-tmpl   : local-tracker `new` renders a context.md with NO Supabase IDs
 *                    / VP stack / VP constraints; project sections come from config.
 *
 * Each test runs in an ISOLATED temp workspace (copy of taskctl/ + ai/templates/
 * + a planted taskctl.config.json). The tracked config is never touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pack as enPack } from '../prompts/en.mjs';
import { pack as ruPack } from '../prompts/ru.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

const CYRILLIC = /[Ѐ-ӿ]/;
const VP_SEMANTIC = /Vision Pitch|vision-pitch-context\.md|Supabase|\bRLS\b|\bDeno\b|shadcn|zvngkkiygawotmxobfbc|mhnhwvgqrkzcqqkrzroo/;

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VP_REPO_ROOT', 'GRACE_REPO_ROOT', 'VIBE_ROOT']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

async function makeWorkspace(configObj) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-2b-cli-'));
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

async function readTaskFile(ws, slug, name) {
  return fs.readFile(path.join(ws, 'ai', 'tasks', slug, name), 'utf8');
}

// ── T2b-unit-repo: no repo path → clear error ───────────────────────────────

test('T2b-unit-repo: plan with no --repo-path/REPO_PATH/repoPath → TASKCTL_EXIT + clear message', async () => {
  // Config WITHOUT repoPath (and no REPO_PATH env) → resolveRepoPath must error.
  const ws = await makeWorkspace({ tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-norepo');
    const r = runWs(ws, ['plan', 'demo-norepo']);
    assert.notEqual(r.status, 0, 'plan must exit non-zero without a repo path');
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.match(combined, /No repo path configured/i, 'prints the clear no-repo message');
    assert.match(combined, /--repo-path|REPO_PATH|taskctl\.config\.json/, 'names the resolution options');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2b-int-1: config repoPath reaches the prepared prompt ──────────────────

test('T2b-int-1: config repoPath reaches the prepared plan prompt (no --repo-path)', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-repo');
    const r = runWs(ws, ['plan', 'demo-repo']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const prompt = await readTaskFile(ws, 'demo-repo', '.prompt-plan.md');
    // repoPath:"." resolves to the workspace root, which appears in the workspace-layout preamble.
    assert.match(prompt, /Source code \(repository\):/, 'prompt carries the resolved repo path');
    assert.equal(/No repo path/.test((r.stdout || '') + (r.stderr || '')), false, 'no no-repo error with config repoPath');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2b-int-2: custom branches.integration drives the review diff ───────────

test('T2b-int-2: custom branches.integration drives the review diff base', async () => {
  // A real git repo on a custom integration branch with a feature branch ahead,
  // so `taskctl review` computes `git diff <integration>...<feature>`.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-2b-reporepo-'));
  const ws = await makeWorkspace({
    repoPath: repo,
    tracker: { type: 'local' },
    branches: { integration: 'trunk', prTarget: 'trunk' },
  });
  try {
    const run = (cmd) => spawnSync(cmd, { cwd: repo, shell: true, encoding: 'utf8' });
    run('git init -b trunk');
    run('git config user.email t@t');
    run('git config user.name t');
    await fs.writeFile(path.join(repo, 'a.txt'), 'base\n', 'utf8');
    run('git add -A'); run('git commit -m base --no-gpg-sign');
    run('git checkout -b feature/demo-br --quiet');
    await fs.writeFile(path.join(repo, 'b.txt'), 'change\n', 'utf8');
    run('git add -A'); run('git commit -m change --no-gpg-sign');
    run('git checkout trunk --quiet');

    // Seed a task whose state points at the feature branch + review stage so the
    // diff path runs. (We bypass the full lifecycle by writing state directly.)
    await seedLocalTask(ws, 'demo-br');
    const statePath = path.join(ws, 'ai', 'tasks', 'demo-br', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.stage = 'review';
    state.branch = 'feature/demo-br';
    state.execution = { engine: 'claude', status: 'completed', lastRunAt: new Date().toISOString() };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['review', 'demo-br', '--repo-path', repo]);
    assert.equal(r.status, 0, `review exit 0; stderr=${r.stderr}`);
    // The diff against the custom integration branch should have been collected.
    const prompt = await readTaskFile(ws, 'demo-br', '.prompt-review-final.md');
    // Neutral diff text references the integration branch name (trunk), not 'dev'.
    const collected = (r.stdout || '').includes('Diff collected');
    assert.ok(collected || /Diff (saved|is empty)/.test(prompt) || /vs trunk/.test(prompt),
      'review diff path ran against the custom integration branch');
    assert.equal(/git diff dev\.\.\./.test((r.stdout || '') + (r.stderr || '')), false, 'no hardcoded dev diff base');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2b-int-3: promptLanguage + neutrality (I2) ─────────────────────────────

test('T2b-int-3: default-config (en) prompts have no Cyrillic and no VP-semantic tokens', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-en');
    // plan
    assert.equal(runWs(ws, ['plan', 'demo-en']).status, 0);
    const planPrompt = await readTaskFile(ws, 'demo-en', '.prompt-plan.md');
    assert.equal(CYRILLIC.test(planPrompt), false, 'plan prompt has no Cyrillic in en mode');
    assert.equal(VP_SEMANTIC.test(planPrompt), false, 'plan prompt has no VP-semantic tokens');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('T2b-int-3: promptLanguage:ru yields Russian but STILL no VP-semantic tokens', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, promptLanguage: 'ru' });
  try {
    await seedLocalTask(ws, 'demo-ru');
    assert.equal(runWs(ws, ['plan', 'demo-ru']).status, 0);
    const planPrompt = await readTaskFile(ws, 'demo-ru', '.prompt-plan.md');
    assert.equal(CYRILLIC.test(planPrompt), true, 'ru mode produces Cyrillic');
    assert.equal(VP_SEMANTIC.test(planPrompt), false, 'ru mode still has no VP-semantic tokens');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2b-int-tmpl: local template scrub (C4) ─────────────────────────────────

test('T2b-int-tmpl: local `new` renders a context.md with no VP literals; sections omitted when unset', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' } });
  try {
    await seedLocalTask(ws, 'demo-tmpl', 'My Task');
    const ctx = await readTaskFile(ws, 'demo-tmpl', 'context.md');
    assert.equal(VP_SEMANTIC.test(ctx), false, 'no VP stack / Supabase IDs in local context.md');
    assert.equal(/## Project Context/.test(ctx), false, 'Project Context omitted when config has none');
    assert.equal(/## Constraints/.test(ctx), false, 'Constraints omitted when config has none');
    assert.equal(/\{\{\w+\}\}/.test(ctx), false, 'no unsubstituted template token');
    assert.match(ctx, /# demo-tmpl: My Task/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('T2b-int-tmpl: local `new` emits config Project Context + Constraints when set', async () => {
  const ws = await makeWorkspace({
    repoPath: '.',
    tracker: { type: 'local' },
    projectContext: ['- Tech stack: Go + Postgres'],
    constraints: ['- PRs only'],
  });
  try {
    await seedLocalTask(ws, 'demo-tmpl2');
    const ctx = await readTaskFile(ws, 'demo-tmpl2', 'context.md');
    assert.match(ctx, /## Project Context\n- Tech stack: Go \+ Postgres/);
    assert.match(ctx, /## Constraints\n- PRs only/);
    assert.equal(/\{\{\w+\}\}/.test(ctx), false, 'no unsubstituted token');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── T2b-int-neutral-all7: prompt-neutrality for ALL seven prompts, en + ru ──
// Important-2: the prior neutrality gate (T2b-int-3) checked only the `plan`
// body in each language. A VP-semantic regression in run/review/fix/revise/
// replan/plan-review would have slipped through. Here we render EVERY body
// builder from BOTH packs and assert: (a) no VP-semantic token in any of the 14
// bodies, (b) en↔ru builder-surface parity (same builder keys), (c) ru bodies
// actually produce Russian (Cyrillic) while en bodies do not.

const O = '/orch';
const ISSUE = 'CP-1';

// The seven prompt-BODY builders (what becomes the .prompt-*.md content). Each
// returns an array of lines. `planDirect` is the body for `plan`; the *Console
// builders are console output, not prompt bodies, so they're out of scope here.
function buildAllSevenBodies(pack) {
  return {
    plan: pack.planDirect({ O, issueKey: ISSUE }),
    'plan-review': pack.planReview({ O, issueKey: ISSUE, issueType: 'Task' }),
    run: pack.run({ O, issueKey: ISSUE }),
    review: pack.review({ O, issueKey: ISSUE, issueType: 'Task', diffInfo: '- Diff: (n/a in test)' }),
    fix: pack.fix({ O, issueKey: ISSUE }),
    revise: pack.revise({ O, issueKey: ISSUE }),
    replan: pack.replan({ O, issueKey: ISSUE, planVersion: 2 }),
  };
}

test('T2b-int-neutral-all7: en+ru expose the SAME body-builder surface (7 builders each)', () => {
  const SEVEN = ['planDirect', 'planReview', 'run', 'review', 'fix', 'revise', 'replan'];
  for (const name of SEVEN) {
    assert.equal(typeof enPack[name], 'function', `en pack is missing builder ${name}`);
    assert.equal(typeof ruPack[name], 'function', `ru pack is missing builder ${name}`);
  }
  // Full surface parity: every key in en exists in ru and vice-versa.
  assert.deepEqual(Object.keys(enPack).sort(), Object.keys(ruPack).sort(),
    'en and ru packs must export an identical builder surface');
});

test('T2b-int-neutral-all7: NONE of the 7 EN prompt bodies carry VP-semantic tokens or Cyrillic', () => {
  const bodies = buildAllSevenBodies(enPack);
  for (const [stage, lines] of Object.entries(bodies)) {
    const body = lines.join('\n');
    assert.equal(VP_SEMANTIC.test(body), false, `en ${stage} prompt leaked a VP-semantic token`);
    assert.equal(CYRILLIC.test(body), false, `en ${stage} prompt unexpectedly contains Cyrillic`);
  }
});

test('T2b-int-neutral-all7: NONE of the 7 RU prompt bodies carry VP-semantic tokens', () => {
  const bodies = buildAllSevenBodies(ruPack);
  for (const [stage, lines] of Object.entries(bodies)) {
    const body = lines.join('\n');
    assert.equal(VP_SEMANTIC.test(body), false, `ru ${stage} prompt leaked a VP-semantic token`);
  }
});

// The five AUTHOR-facing prompts (plan/run/fix/revise/replan) are localized to
// Russian in the ru pack. The two REVIEWER-facing prompts (plan-review/review)
// are deliberately English in BOTH packs — review.md / plan.md artefacts are an
// English-only contract in this project, and those bodies even instruct "Write
// review.md in English". So Russian-ness is asserted only for the author set,
// and English-ness (no Cyrillic) is asserted for the reviewer set in both packs.
const RU_LOCALIZED_STAGES = ['plan', 'run', 'fix', 'revise', 'replan'];
const REVIEWER_STAGES = ['plan-review', 'review'];

test('T2b-int-neutral-all7: RU author-facing prompts are actually Russian (no silent en fallback)', () => {
  const bodies = buildAllSevenBodies(ruPack);
  for (const stage of RU_LOCALIZED_STAGES) {
    const body = bodies[stage].join('\n');
    assert.equal(CYRILLIC.test(body), true, `ru ${stage} prompt should be Russian (Cyrillic)`);
  }
});

test('T2b-int-neutral-all7: reviewer-facing prompts (plan-review/review) are English in BOTH packs (artefact-language contract)', () => {
  const en = buildAllSevenBodies(enPack);
  const ru = buildAllSevenBodies(ruPack);
  for (const stage of REVIEWER_STAGES) {
    assert.equal(CYRILLIC.test(en[stage].join('\n')), false, `en ${stage} should be English`);
    assert.equal(CYRILLIC.test(ru[stage].join('\n')), false, `ru ${stage} is English by policy (review.md is English-only)`);
    // And both instruct an English artefact, confirming the shared contract.
    assert.match(en[stage].join('\n'), /Write review\.md in English/);
    assert.match(ru[stage].join('\n'), /Write review\.md in English/);
  }
});
