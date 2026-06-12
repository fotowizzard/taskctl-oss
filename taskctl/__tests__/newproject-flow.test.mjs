/**
 * WP5 Stage 5b — T5b-8: the hermetic end-to-end new-project flow under the FAKE
 * adapter. Drives cmdNewProject IN-PROCESS (a subprocess CLI run can never
 * resolve `fake` — registration is test-code only) inside a TEMP installation
 * copy, so the real workspace is never touched. Covers the full state machine,
 * resume at every checkpoint, the scaffold split, the unified-entry branches,
 * confinement, --restart + restart-crash recovery, and the TRUE e2e discovery
 * threading proof (a subprocess with cwd:<TARGET>, audit-iter3 I-3).
 *
 * All engine-driven steps go through the 5a adapter layer (the fake spawns a
 * canned replay script); zero live LLM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

const RCFG = { engines: { planner: 'fake', reviewer: 'fake', reasoningEffort: 'high' }, tracker: { type: 'local' } };

/**
 * Build a TEMP installation copy (taskctl/ + ai/templates/ + planted config) and
 * import its cli + engines from THAT copy, registering the fake adapter. Returns
 * a harness that runs cmdNewProject against a target under the temp root.
 */
async function makeHarness({ scriptDir } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'np-flow-')));
  const install = path.join(tmp, 'install');
  await fs.cp(TASKCTL_DIR, path.join(install, 'taskctl'), { recursive: true });
  await fs.cp(TEMPLATES_DIR, path.join(install, 'ai', 'templates'), { recursive: true });
  await fs.writeFile(path.join(install, 'taskctl.config.json'), JSON.stringify({ engines: { planner: 'fake', reviewer: 'fake' } }), 'utf8');

  const cli = await import(pathToFileURL(path.join(install, 'taskctl', 'cli.mjs')).href);
  const engines = await import(pathToFileURL(path.join(install, 'taskctl', 'engines.mjs')).href);
  const { makeFakeEngine } = await import(pathToFileURL(path.join(install, 'taskctl', 'engines-fake.mjs')).href);
  engines.registerEngine(makeFakeEngine({ scriptDir }));

  const deps = { workspaceRoot: install, installTemplatesDir: path.join(install, 'ai', 'templates') };

  return {
    tmp, install, cli, deps,
    cleanup: () => { try { engines._unregisterEngineForTest('fake'); } catch {} },
    run: (idea, args, extraDeps = {}) => cli.cmdNewProject(idea, args, RCFG, { ...deps, ...extraDeps }),
    flowDir: (target) => {
      const canon = canonical(target);
      const tid = crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
      return path.join(install, 'ai', 'newproject', tid);
    },
  };
}

function canonical(p) {
  const r = path.resolve(p);
  try { return fsSync.realpathSync(r); } catch { return r; }
}

/** git init a directory (the simulated user scaffold). */
function gitInit(dir) {
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
}

/** Simulate the user running the printed scaffold: a minimal tree + git init. */
async function simulateUserScaffold(target) {
  await fs.mkdir(path.join(target, 'src'), { recursive: true });
  await fs.writeFile(path.join(target, 'package.json'), '{}', 'utf8');
  gitInit(target);
}

/** Recursive lstat snapshot (mode/size/sha) for confinement. */
function snapshotTree(root) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fsSync.lstatSync(abs);
    const key = rel.replace(/\\/g, '/');
    if (st.isDirectory()) {
      out[key] = `dir`;
      for (const e of fsSync.readdirSync(abs).sort()) walk(path.join(rel, e));
      return;
    }
    const sha = crypto.createHash('sha256').update(fsSync.readFileSync(abs)).digest('hex');
    out[key] = `file:${st.size}:${sha}`;
  };
  walk('.');
  return out;
}

function step(flowDir) {
  return JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8')).step;
}

// Silence the flow's console output during tests.
function quiet(fn) {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.log = log; console.error = err; });
}

// ════════════════════════════════════════════════════════════════════════════
// Full end-to-end + resume at every checkpoint
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: full flow brainstorm→…→done under the fake adapter (resume at every checkpoint)', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);

    // INVOKE 1 → brainstorm runs, pauses at proposal.
    await quiet(() => h.run('a todo app', args));
    assert.ok(fsSync.existsSync(path.join(flowDir, 'brainstorm.md')), 'brainstorm.md written');
    assert.equal(step(flowDir), 'proposal');

    // INVOKE 2 → proposal + choose + scaffold_generate, pauses at await_scaffold.
    await quiet(() => h.run('a todo app', args));
    assert.ok(fsSync.existsSync(path.join(flowDir, 'proposal.md')), 'proposal.md written');
    assert.ok(fsSync.existsSync(path.join(flowDir, 'scaffold-plan.md')), 'scaffold-plan.md written');
    assert.equal(step(flowDir), 'await_scaffold');
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    assert.equal(rec.chosenOption, 'spa-vite');
    assert.equal(rec.scaffoldEmitted, true);

    // scaffold is PRINT-ONLY: target untouched (no node_modules, no tree yet).
    assert.equal(fsSync.existsSync(path.join(target, 'node_modules')), false);

    // INVOKE 3 while NOT a git work tree → stays at await_scaffold, no engine.
    await quiet(() => h.run('a todo app', args));
    assert.equal(step(flowDir), 'await_scaffold');

    // Simulate the user scaffold, then INVOKE 4 → backlog→attach→done.
    await simulateUserScaffold(target);
    await quiet(() => h.run('a todo app', args));
    assert.equal(step(flowDir), 'done');

    // Backlog tasks under TARGET with markers (project slug derives from the idea
    // "a todo app" → "a-todo-app"; the fake backlog slugs are setup-tooling/auth-flow).
    const tasksDir = path.join(target, 'ai', 'tasks');
    const taskDirs = fsSync.readdirSync(tasksDir).sort();
    assert.deepEqual(taskDirs, ['a-todo-app-01-setup-tooling', 'a-todo-app-02-auth-flow']);
    for (const t of taskDirs) {
      assert.deepEqual(
        fsSync.readdirSync(path.join(tasksDir, t)).sort(),
        ['.taskctl-newproject-owner.json', 'context.md', 'runs', 'state.json'],
      );
    }
    // Self-attached config with repoPath ".".
    const cfg = JSON.parse(fsSync.readFileSync(path.join(target, 'taskctl.config.json'), 'utf8'));
    assert.equal(cfg.repoPath, '.');
    // Templates seeded into the target.
    assert.ok(fsSync.readdirSync(path.join(target, 'ai', 'templates')).length > 0);

    // INVOKE 5 at 'done' → idempotent terminal (no throw, still done).
    await quiet(() => h.run('a todo app', args));
    assert.equal(step(flowDir), 'done');
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Unified entry point branches
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: no engine on first run (engine step) → fail BEFORE any record/target write', async () => {
  const h = await makeHarness();
  try {
    h.cleanup(); // unregister the fake → planner "fake" is no longer registered
    const target = path.join(h.tmp, 'tgt');
    const flowDir = h.flowDir(target);
    await assert.rejects(() => quiet(() => h.run('idea', ['--dir', target, '--yes'])), /TASKCTL_EXIT/);
    // No record, no target.
    assert.equal(fsSync.existsSync(path.join(flowDir, 'record.json')), false);
    assert.equal(fsSync.existsSync(target), false);
  } finally {
    h.cleanup();
  }
});

test('T5b-8: non-empty target on first run → refuse, nothing created', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'existing.txt'), 'x', 'utf8');
    const flowDir = h.flowDir(target);
    await assert.rejects(() => quiet(() => h.run('idea', ['--dir', target, '--yes'])), /TASKCTL_EXIT/);
    assert.equal(fsSync.existsSync(path.join(flowDir, 'record.json')), false);
  } finally {
    h.cleanup();
  }
});

test('T5b-8: await_scaffold/attach/done resume with the ENGINE removed (no probe)', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm
    await quiet(() => h.run('idea', args)); // → await_scaffold
    assert.equal(step(flowDir), 'await_scaffold');

    // Remove the engine. A resume at await_scaffold must NOT probe/fail.
    h.cleanup();
    await quiet(() => h.run('idea', args)); // still await_scaffold, no engine needed
    assert.equal(step(flowDir), 'await_scaffold');

    // Scaffold + git init, then resume at await_scaffold→backlog. backlog IS an
    // engine step, so re-register the fake for the backlog→done leg.
    await simulateUserScaffold(target);
    const engines = await import(pathToFileURL(path.join(h.install, 'taskctl', 'engines.mjs')).href);
    const { makeFakeEngine } = await import(pathToFileURL(path.join(h.install, 'taskctl', 'engines-fake.mjs')).href);
    engines.registerEngine(makeFakeEngine({}));
    await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'done');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: a non-empty target is ACCEPTED on resume at await_scaffold', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm
    await quiet(() => h.run('idea', args)); // → await_scaffold
    // Populate the target (the user scaffold) — resume must NOT reject it.
    await simulateUserScaffold(target);
    await quiet(() => h.run('idea', args)); // await_scaffold → backlog → done
    assert.equal(step(flowDir), 'done');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: identity mismatch on resume (different idea) → clear error', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    await quiet(() => h.run('first idea', args)); // creates record bound to "first idea"
    // Re-invoke with a DIFFERENT idea for the SAME dir → mismatch.
    await assert.rejects(() => quiet(() => h.run('different idea', args)), /TASKCTL_EXIT/);
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Scaffold split — await_scaffold never calls the engine / regenerates the plan
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: re-invoking at await_scaffold NEVER calls the engine nor regenerates scaffold-plan.md', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm
    await quiet(() => h.run('idea', args)); // → await_scaffold (scaffold-plan emitted ONCE)
    const planPath = path.join(flowDir, 'scaffold-plan.md');
    const mtime1 = fsSync.statSync(planPath).mtimeMs;

    // Inject a runEngineStep that THROWS if called — proves await_scaffold makes
    // no engine call.
    const noEngine = { runEngineStep: async () => { throw new Error('engine must NOT be called at await_scaffold'); } };
    await quiet(() => h.run('idea', args, noEngine)); // not a work tree → stay, no engine
    assert.equal(step(flowDir), 'await_scaffold');
    const mtime2 = fsSync.statSync(planPath).mtimeMs;
    assert.equal(mtime2, mtime1, 'scaffold-plan.md NOT regenerated');
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Structured-output validation
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: a malformed brainstorm envelope → flow stops at brainstorm, no further writes', async () => {
  // Point the fake at a scriptDir with a MALFORMED canned brainstorm reply.
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bad-'));
  await fs.writeFile(path.join(scriptDir, '.prompt-newproject-brainstorm.md.json'), '{ this is not valid json', 'utf8');
  const h = await makeHarness({ scriptDir });
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await assert.rejects(() => quiet(() => h.run('idea', args)), /TASKCTL_EXIT/);
    // record exists at brainstorm (created first-run), but NO brainstorm.md.
    assert.equal(step(flowDir), 'brainstorm');
    assert.equal(fsSync.existsSync(path.join(flowDir, 'brainstorm.md')), false);
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// --restart + restart-crash recovery
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: --restart from a pre-scaffold flow archives content + writes a fresh record; target untouched', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm → proposal
    await quiet(() => h.run('idea', args)); // → await_scaffold
    assert.equal(step(flowDir), 'await_scaffold');

    // --restart: archive + fresh brainstorm record, then the SAME invocation
    // re-runs brainstorm and pauses at proposal (the fresh flow restarts cleanly).
    await quiet(() => h.run('idea', [...args, '--restart']));
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    assert.equal(rec.step, 'proposal', 'after restart the re-run re-ran brainstorm then advanced to proposal');
    assert.ok(typeof rec.restartedFrom === 'string');
    // The prior content sits in an archive-*/ subdir.
    const archives = fsSync.readdirSync(flowDir).filter((n) => n.startsWith('archive-'));
    assert.equal(archives.length, 1);
    assert.ok(fsSync.existsSync(path.join(flowDir, archives[0], 'scaffold-plan.md')), 'prior scaffold archived');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: C2 — --restart of a COMPLETED flow HALTS at backlog (existing backlog dirs preserved, never overwritten)', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    // Drive to done.
    await quiet(() => h.run('idea', args));
    await quiet(() => h.run('idea', args));
    await simulateUserScaffold(target);
    await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'done');
    const targetSnapBefore = snapshotTree(target);

    // --restart: archives the flow, writes a fresh brainstorm record (the TARGET's
    // bytes are untouched — the prior backlog dirs remain). Re-running the fresh
    // flow regenerates backlog content with a NEW timestamp → a different hash than
    // the on-disk task dirs from the first run. Per C2 that is a collision: the flow
    // HALTS at backlog rather than deleting/overwriting the existing dirs.
    await quiet(() => h.run('idea', [...args, '--restart']));
    let halted = false;
    for (let guard = 0; guard < 8 && step(flowDir) !== 'done'; guard++) {
      try { await quiet(() => h.run('idea', args)); }
      catch (e) { if (/TASKCTL_EXIT/.test(e.message)) { halted = true; break; } throw e; }
    }
    assert.equal(halted, true, 'restart-of-completed re-publish collides with the existing backlog → HALT');
    assert.equal(step(flowDir), 'backlog', 'flow record stays at backlog (not advanced past the collision)');
    // The TARGET's own bytes (src/package.json AND the prior backlog dirs) are
    // entirely preserved — nothing was deleted or overwritten.
    const after = snapshotTree(target);
    assert.equal(after['src'], targetSnapBefore['src']);
    assert.equal(after['package.json'], targetSnapBefore['package.json']);
    assert.equal(after['ai/tasks'], targetSnapBefore['ai/tasks'], 'existing backlog tasks untouched');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: C2 — editing a generated context.md then re-running HALTS, the edit INTACT', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    // Drive to done so the backlog tasks are published under the target.
    await quiet(() => h.run('idea', args));
    await quiet(() => h.run('idea', args));
    await simulateUserScaffold(target);
    await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'done');

    // Edit a generated context.md (no extra file — exact tree preserved).
    const tasksDir = path.join(target, 'ai', 'tasks');
    const firstTask = fsSync.readdirSync(tasksDir).sort()[0];
    const ctxPath = path.join(tasksDir, firstTask, 'context.md');
    const editedBody = '# EDITED BY THE USER — must not be clobbered\n';
    fsSync.writeFileSync(ctxPath, editedBody, 'utf8');

    // --restart → the fresh flow reaches backlog and tries to re-publish; the
    // edited dir no longer hashes to its marker → collision HALT. The edit is INTACT.
    await quiet(() => h.run('idea', [...args, '--restart']));
    let err = null;
    for (let guard = 0; guard < 8 && step(flowDir) !== 'done'; guard++) {
      try { await quiet(() => h.run('idea', args)); }
      catch (e) { err = e; break; }
    }
    assert.ok(err && /TASKCTL_EXIT/.test(err.message), 'edited content → flow halts');
    assert.equal(fsSync.readFileSync(ctxPath, 'utf8'), editedBody, 'the user edit survived (not overwritten/deleted)');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: restart-crash recovery (no record + strays/archive) → branch (b) sweep, NO first-run rejection', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm → proposal
    await quiet(() => h.run('idea', args)); // → await_scaffold
    // Populate the target (so a wrong first-run branch WOULD reject it).
    await simulateUserScaffold(target);

    // Simulate a crash mid-restart: archive the content + DELETE the record (the
    // archive ran but the fresh-record write never happened).
    const archiveDir = path.join(flowDir, 'archive-2026-01-01');
    await fs.mkdir(archiveDir, { recursive: true });
    for (const child of fsSync.readdirSync(flowDir)) {
      if (child.startsWith('archive-') || child === 'flow.lock') continue;
      await fs.rename(path.join(flowDir, child), path.join(archiveDir, child));
    }
    assert.equal(fsSync.existsSync(path.join(flowDir, 'record.json')), false, 'no record (crash)');

    // Re-invoke: branch (b) recovers (sweeps strays → newest archive → fresh
    // restart record) and resumes — NOT the first-run non-empty rejection. The
    // FIRST run here performs the recovery + writes the record, so run once
    // before reading `step` (no record exists yet at this point).
    await quiet(() => h.run('idea', args));
    for (let guard = 0; guard < 8 && step(flowDir) !== 'done'; guard++) await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'done');
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    assert.ok(typeof rec.restartedFrom === 'string');
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Confinement + containment guard
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: confinement — THIS workspace byte-unchanged EXCEPT ai/newproject/<target-id>/', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const before = snapshotTree(h.install);

    // Full flow.
    await quiet(() => h.run('idea', args));
    await quiet(() => h.run('idea', args));
    await simulateUserScaffold(target);
    await quiet(() => h.run('idea', args));

    const after = snapshotTree(h.install);
    const tid = path.basename(h.flowDir(target));
    const allowPrefix = `ai/newproject/${tid}`;
    const changed = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[k] === after[k]) continue;
      // The only permitted new/changed keys are the flow dir + its ancestors.
      if (k === 'ai' || k === 'ai/newproject' || k === allowPrefix || k.startsWith(allowPrefix + '/')) continue;
      changed.push(k);
    }
    assert.deepEqual(changed, [], `only ai/newproject/${tid}/ may change in THIS workspace`);
  } finally {
    h.cleanup();
  }
});

test('T5b-8: containment guard — --dir inside the workspace is refused', async () => {
  const h = await makeHarness();
  try {
    const inside = path.join(h.install, 'some', 'sub');
    await assert.rejects(() => quiet(() => h.run('idea', ['--dir', inside, '--yes'])), /TASKCTL_EXIT/);
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// C4 — descendant link confinement (a junction works without admin on this box)
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: C4 — TARGET/ai/tasks junctioned OUTSIDE → flow REJECTS before any write; outside dir untouched', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    // Advance to await_scaffold, then simulate the user scaffold + git init.
    await quiet(() => h.run('idea', args)); // brainstorm
    await quiet(() => h.run('idea', args)); // → await_scaffold
    await simulateUserScaffold(target);

    // A scaffold maliciously/accidentally made <TARGET>/ai/tasks a junction that
    // escapes the target, pointing at an OUTSIDE sibling dir with a sentinel file.
    const outside = path.join(h.tmp, 'OUTSIDE');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'sentinel.txt'), 'do not touch', 'utf8');
    const outsideSnapBefore = snapshotTree(outside);

    await fs.mkdir(path.join(target, 'ai'), { recursive: true });
    const junctionPath = path.join(target, 'ai', 'tasks');
    try {
      await fs.symlink(outside, junctionPath, 'junction'); // win32 junction / posix dir symlink
    } catch {
      return; // link creation not permitted here — skip silently
    }

    // The backlog step (the next leg) must REJECT before writing anything into the
    // escaping ai/tasks. The flow record stays at backlog.
    await assert.rejects(() => quiet(() => h.run('idea', args)), /TASKCTL_EXIT/);
    assert.equal(step(flowDir), 'backlog', 'flow did not advance past the confinement rejection');

    // The OUTSIDE dir is byte-UNCHANGED — nothing was written through the junction.
    assert.deepEqual(snapshotTree(outside), outsideSnapBefore, 'outside dir untouched by the rejected flow');
    // No backlog task dirs were created via the junction either.
    const outsideEntries = fsSync.readdirSync(outside).sort();
    assert.deepEqual(outsideEntries, ['sentinel.txt'], 'no task dirs leaked into the outside dir');
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// I-2 — self-attach config validation
// ════════════════════════════════════════════════════════════════════════════

/** Drive a fresh flow up to (but not through) the attach step, with the target a
 *  git work tree and the backlog already published. Returns { h, target, flowDir }. */
async function driveToAttach(h) {
  const target = path.join(h.tmp, 'tgt');
  const args = ['--dir', target, '--yes'];
  const flowDir = h.flowDir(target);
  await quiet(() => h.run('idea', args)); // brainstorm
  await quiet(() => h.run('idea', args)); // → await_scaffold
  await simulateUserScaffold(target);
  // Run backlog→attach→done once; then we can force the record back to 'attach'
  // for the config-validation cases.
  await quiet(() => h.run('idea', args));
  return { target, args, flowDir };
}

test('T5b-8: I-2 — an existing config with a WRONG repoPath HALTS (attached elsewhere)', async () => {
  const h = await makeHarness();
  try {
    const { target, args, flowDir } = await driveToAttach(h);
    assert.equal(step(flowDir), 'done');
    // Replace the self-attached config with one pointing at ANOTHER repo, and rewind
    // the record to 'attach' (as if the flow paused there before writing).
    fsSync.writeFileSync(path.join(target, 'taskctl.config.json'), JSON.stringify({ repoPath: '/some/other/repo' }), 'utf8');
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    rec.step = 'attach';
    fsSync.writeFileSync(path.join(flowDir, 'record.json'), JSON.stringify(rec, null, 2), 'utf8');

    await assert.rejects(() => quiet(() => h.run('idea', args)), /TASKCTL_EXIT/);
    // The foreign config is NOT clobbered.
    const cfg = JSON.parse(fsSync.readFileSync(path.join(target, 'taskctl.config.json'), 'utf8'));
    assert.equal(cfg.repoPath, '/some/other/repo', 'wrong-repoPath config left intact (not overwritten)');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: I-2 — a VALID self config (repoPath ".") is skipped idempotently', async () => {
  const h = await makeHarness();
  try {
    const { target, args, flowDir } = await driveToAttach(h);
    assert.equal(step(flowDir), 'done');
    const cfgBefore = fsSync.readFileSync(path.join(target, 'taskctl.config.json'), 'utf8');
    assert.equal(JSON.parse(cfgBefore).repoPath, '.');
    // Rewind to 'attach' and re-run — a valid self config must be accepted (skip),
    // not clobbered, and the flow advances to done.
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    rec.step = 'attach';
    fsSync.writeFileSync(path.join(flowDir, 'record.json'), JSON.stringify(rec, null, 2), 'utf8');
    await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'done');
    assert.equal(fsSync.readFileSync(path.join(target, 'taskctl.config.json'), 'utf8'), cfgBefore, 'valid self config untouched');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: I-2 — an UNPARSEABLE existing config HALTS', async () => {
  const h = await makeHarness();
  try {
    const { target, args, flowDir } = await driveToAttach(h);
    fsSync.writeFileSync(path.join(target, 'taskctl.config.json'), '{ not json', 'utf8');
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    rec.step = 'attach';
    fsSync.writeFileSync(path.join(flowDir, 'record.json'), JSON.stringify(rec, null, 2), 'utf8');
    await assert.rejects(() => quiet(() => h.run('idea', args)), /TASKCTL_EXIT/);
    assert.equal(fsSync.readFileSync(path.join(target, 'taskctl.config.json'), 'utf8'), '{ not json', 'corrupt config left intact');
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// I-3 — engine exit code (nonzero exit with parseable output must NOT advance)
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: I-3 — a nonzero engine exit (valid envelope) does NOT advance; record unchanged', async () => {
  const h = await makeHarness();
  const prev = process.env.TASKCTL_FAKE_EXIT_CODE;
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    // The fake replay prints a VALID brainstorm envelope but exits 3.
    process.env.TASKCTL_FAKE_EXIT_CODE = '3';
    await assert.rejects(() => quiet(() => h.run('idea', args)), /TASKCTL_EXIT/);
    // Record was created first-run at 'brainstorm' but did NOT advance to 'proposal',
    // and no brainstorm.md was written.
    assert.equal(step(flowDir), 'brainstorm', 'flow stays at brainstorm after a nonzero engine exit');
    assert.equal(fsSync.existsSync(path.join(flowDir, 'brainstorm.md')), false, 'no artifact written on engine failure');

    // Recovery: clear the forced failure → the same invocation now advances.
    delete process.env.TASKCTL_FAKE_EXIT_CODE;
    await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'proposal', 'flow advances once the engine succeeds');
  } finally {
    if (prev === undefined) delete process.env.TASKCTL_FAKE_EXIT_CODE; else process.env.TASKCTL_FAKE_EXIT_CODE = prev;
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// TRUE e2e discovery threading (subprocess; audit-iter3 I-3)
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: I-4 — subprocess `plan <task>` with cwd:<TARGET> writes the prompt UNDER TARGET, prints TARGET paths, install byte-unchanged', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    await quiet(() => h.run('idea', args));
    await quiet(() => h.run('idea', args));
    await simulateUserScaffold(target);
    await quiet(() => h.run('idea', args)); // → done; backlog seeded under TARGET

    const cli = path.join(h.install, 'taskctl', 'cli.mjs');
    const env = { ...process.env };
    for (const k of ['REPO_PATH', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']) delete env[k];

    const tasksDir = path.join(target, 'ai', 'tasks');
    const firstTask = fsSync.readdirSync(tasksDir).sort()[0];
    const promptPath = path.join(tasksDir, firstTask, '.prompt-plan.md');
    // Pre-state: no plan prompt yet, and a clean install snapshot.
    assert.equal(fsSync.existsSync(promptPath), false, 'no .prompt-plan.md before plan runs');
    const installBefore = snapshotTree(h.install);

    // The spec's `plan <task>` (NOT status): exercises prompt generation, O,
    // launch placement, and write routing. --engine claude → a registered built-in
    // (the fake is test-code-only and unresolvable in a subprocess); plan only
    // PRINTS the launch string, never spawns. cwd:TARGET → discovery roots at the
    // TARGET workspace (its config has repoPath ".").
    const r = spawnSync('node', [cli, 'plan', firstTask, '--engine', 'claude'], { cwd: target, encoding: 'utf8', env });
    assert.equal(r.status, 0, `plan ${firstTask} from cwd:TARGET exits 0; stderr=${r.stderr}`);

    // The prompt file is WRITTEN under TARGET (write routing → discovered root).
    assert.ok(fsSync.existsSync(promptPath), `.prompt-plan.md written under TARGET (${promptPath})`);
    // The printed paths reference TARGET (the discovered O), not the install.
    const targetSlashed = target.replace(/\\/g, '/');
    assert.match(r.stdout.replace(/\\/g, '/'), new RegExp(targetSlashed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'printed paths reference the TARGET workspace root');
    assert.ok(!r.stdout.replace(/\\/g, '/').includes(h.install.replace(/\\/g, '/') + '/ai/tasks/' + firstTask),
      'printed task paths do NOT reference the install ai/tasks');

    // Negative control: same `plan` from the install does NOT find that task.
    const ctrl = spawnSync('node', [cli, 'plan', firstTask, '--engine', 'claude'], { cwd: h.install, encoding: 'utf8', env });
    assert.notEqual(ctrl.status, 0, 'install workspace has no such task to plan');

    // The installation root stays BYTE-UNCHANGED across the cwd:TARGET subprocess.
    const installAfter = snapshotTree(h.install);
    assert.deepEqual(installAfter, installBefore, 'install root byte-unchanged by the cwd:TARGET `plan` subprocess');
  } finally {
    h.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Concurrency — single fixed lock across a step transition
// ════════════════════════════════════════════════════════════════════════════

test('T5b-8: a symlinked target dir is canonicalized — flow id is stable across the symlink + the real path', async () => {
  const h = await makeHarness();
  try {
    const realTarget = path.join(h.tmp, 'real-tgt');
    await fs.mkdir(realTarget, { recursive: true });
    const linkTarget = path.join(h.tmp, 'link-tgt');
    try {
      await fs.symlink(realTarget, linkTarget, 'junction'); // win32 junction / posix dir symlink
    } catch {
      return; // symlink creation not permitted on this box — skip silently
    }
    // Run via the SYMLINK path → the flow id is derived from the canonical real
    // path, so the flow dir matches the real-path flow dir (no aliasing split).
    const viaLink = ['--dir', linkTarget, '--yes'];
    await quiet(() => h.run('idea', viaLink)); // brainstorm
    const realCanon = await fs.realpath(realTarget);
    const tid = crypto.createHash('sha256').update(realCanon).digest('hex').slice(0, 16);
    assert.ok(fsSync.existsSync(path.join(h.install, 'ai', 'newproject', tid, 'record.json')),
      'flow record is keyed by the canonical real path, not the symlink path');
    // A re-invoke via the REAL path resumes the SAME flow (same id).
    await quiet(() => h.run('idea', ['--dir', realTarget, '--yes']));
    assert.equal(step(path.join(h.install, 'ai', 'newproject', tid)), 'await_scaffold');
  } finally {
    h.cleanup();
  }
});

test('T5b-8: resume at attach with the engine removed → no probe, completes', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm
    await quiet(() => h.run('idea', args)); // → await_scaffold
    await simulateUserScaffold(target);

    // Manually advance the record to 'attach' (simulating a flow paused there),
    // then remove the engine. attach is NOT an engine step → no probe, completes.
    const rec = JSON.parse(fsSync.readFileSync(path.join(flowDir, 'record.json'), 'utf8'));
    rec.step = 'attach';
    fsSync.writeFileSync(path.join(flowDir, 'record.json'), JSON.stringify(rec, null, 2), 'utf8');
    h.cleanup(); // remove the fake engine

    await quiet(() => h.run('idea', args));
    assert.equal(step(flowDir), 'done');
    assert.ok(fsSync.existsSync(path.join(target, 'taskctl.config.json')));
  } finally {
    h.cleanup();
  }
});

test('T5b-8: a second invocation while a flow.lock is held (any step) → "already running"', async () => {
  const h = await makeHarness();
  try {
    const target = path.join(h.tmp, 'tgt');
    const args = ['--dir', target, '--yes'];
    const flowDir = h.flowDir(target);
    await quiet(() => h.run('idea', args)); // brainstorm → proposal; advance the step
    // Manually plant a LIVE-pid lock (this process) at the SAME fixed name, then a
    // second invocation must fail to acquire (the fixed lock holds across the step
    // transition — there is exactly ONE flow.lock name).
    await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 'held', pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    await assert.rejects(() => quiet(() => h.run('idea', args)), /TASKCTL_EXIT/);
    // exactly one flow.lock name (not per-step).
    const locks = fsSync.readdirSync(flowDir).filter((n) => n === 'flow.lock' || /\.lock$/.test(n));
    assert.deepEqual(locks, ['flow.lock']);
    await fs.unlink(path.join(flowDir, 'flow.lock'));
  } finally {
    h.cleanup();
  }
});
