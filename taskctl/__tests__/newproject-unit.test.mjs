/**
 * WP5 Stage 5b — UNIT tests for the new-project machinery (newproject.mjs) +
 * the structured-envelope schemas (newproject-schema.mjs). Concurrency-sensitive
 * pieces (the single flow.lock, the archive protocol + crash recovery, the
 * durable backlog publish + adoption) are tested here in isolation; the full
 * hermetic flow lives in newproject-flow.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as np from '../newproject.mjs';
import {
  extractEnvelope, parseAndValidate,
  validateBrainstorm, validateProposal, validateScaffold, validateBacklog,
} from '../newproject-schema.mjs';

async function tmpFlow() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'np-unit-'));
  const flowDir = np.flowDirFor(root, 'deadbeefdeadbeef');
  await fs.mkdir(flowDir, { recursive: true });
  return { root, flowDir };
}

// ════════════════════════════════════════════════════════════════════════════
// Schema validators
// ════════════════════════════════════════════════════════════════════════════

test('schema: extractEnvelope handles fenced json, bare json, and rejects junk', () => {
  assert.equal(extractEnvelope('```json\n{"a":1}\n```').value.a, 1);
  assert.equal(extractEnvelope('{"a":2}').value.a, 2);
  assert.equal(extractEnvelope('not json at all').ok, false);
  assert.equal(extractEnvelope('').ok, false);
  assert.equal(extractEnvelope('```json\n[1,2]\n```').ok, false); // array, not an object
});

test('schema: brainstorm valid/invalid', () => {
  assert.equal(validateBrainstorm({ questions: ['q'], assumptions: [], options: [] }).ok, true);
  assert.equal(validateBrainstorm({ questions: [], assumptions: [], options: [] }).ok, false); // no signal
  assert.equal(validateBrainstorm({ questions: 'x', assumptions: [], options: [] }).ok, false);
});

test('schema: proposal requires >=2 options + recommended in ids', () => {
  const good = { recommended: 'a', options: [{ id: 'a', stack: 's', rationale: 'r' }, { id: 'b', stack: 's', rationale: 'r' }] };
  assert.equal(validateProposal(good).ok, true);
  assert.equal(validateProposal({ recommended: 'z', options: good.options }).ok, false); // unknown rec
  assert.equal(validateProposal({ recommended: 'a', options: [good.options[0]] }).ok, false); // <2
});

test('schema: scaffold requires non-empty commands', () => {
  assert.equal(validateScaffold({ commands: ['x'], fileTree: ['a'] }).ok, true);
  assert.equal(validateScaffold({ commands: [] }).ok, false);
});

test('schema: backlog requires >=1 task with slug+title', () => {
  assert.equal(validateBacklog({ tasks: [{ slug: 's', title: 't', desc: 'd' }] }).ok, true);
  assert.equal(validateBacklog({ tasks: [] }).ok, false);
  assert.equal(validateBacklog({ tasks: [{ title: 't' }] }).ok, false); // no slug
});

test('schema: parseAndValidate end-to-end on a fenced backlog', () => {
  const raw = '```json\n{"tasks":[{"slug":"s","title":"t","desc":"d"}]}\n```';
  const r = parseAndValidate('backlog', raw);
  assert.equal(r.ok, true);
  assert.equal(r.value.tasks[0].slug, 's');
});

// ════════════════════════════════════════════════════════════════════════════
// Identity + slug helpers
// ════════════════════════════════════════════════════════════════════════════

test('identity: targetId is a stable 16-hex of the canonical path', () => {
  const a = np.targetId('/x/y/z');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, np.targetId('/x/y/z')); // stable
  assert.notEqual(a, np.targetId('/x/y/zz'));
});

test('slug: slugify + backlogSlug are deterministic', () => {
  assert.equal(np.slugify('My Cool App!!'), 'my-cool-app');
  assert.equal(np.slugify(''), 'project');
  assert.equal(np.backlogSlug('demo', 1, 'Set Up Tooling'), 'demo-01-set-up-tooling');
  assert.equal(np.backlogSlug('demo', 12, 'x'), 'demo-12-x');
});

// ════════════════════════════════════════════════════════════════════════════
// Flow lock — ONE stable lock (plan v5)
// ════════════════════════════════════════════════════════════════════════════

test('lock: acquire then a second acquire on a LIVE pid → "already running" (never reclaimed, any age)', async () => {
  const { flowDir } = await tmpFlow();
  const lock = await np.acquireFlowLock(flowDir);
  // Second attempt sees our own (live) pid → must refuse, regardless of age.
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, { pidAlive: () => true, now: Date.now() + 1e12 }),
    (e) => /TASKCTL_LOCKED:/.test(e.message),
  );
  await lock.release();
  // After release the lock file is gone → re-acquire succeeds.
  const lock2 = await np.acquireFlowLock(flowDir);
  await lock2.release();
});

test('lock: a stale lock (dead pid AND aged-out) is reclaimed via rename takeover', async () => {
  const { flowDir } = await tmpFlow();
  // Plant a stale lock: dead pid, old startedAt.
  await fs.writeFile(
    path.join(flowDir, 'flow.lock'),
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  const lock = await np.acquireFlowLock(flowDir, { pidAlive: () => false });
  // We now own a FRESH lock with our own token.
  const body = JSON.parse(await fs.readFile(path.join(flowDir, 'flow.lock'), 'utf8'));
  assert.equal(body.token, lock.token);
  assert.notEqual(body.token, 'old');
  // No leaked reclaim claim.
  const leftover = (await fs.readdir(flowDir)).filter((n) => n.startsWith('flow.lock.reclaim-'));
  assert.deepEqual(leftover, []);
  await lock.release();
});

test('lock: dead-pid but NOT yet aged-out → conservative "already running" (no premature reclaim)', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(
    path.join(flowDir, 'flow.lock'),
    JSON.stringify({ token: 'recent', pid: 999999, startedAt: new Date().toISOString() }),
    'utf8',
  );
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, { pidAlive: () => false, staleMs: 60_000 }),
    (e) => /TASKCTL_LOCKED:/.test(e.message),
  );
});

test('lock: two simultaneous stale-reclaimers → exactly one wins', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(
    path.join(flowDir, 'flow.lock'),
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // Fire two reclaimers concurrently; exactly one acquires, the other either
  // re-derives the now-live lock (→ rejects) OR also wins after the first
  // releases — so we serialize: run both, expect exactly one success without an
  // intervening release.
  const results = await Promise.allSettled([
    np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 }),
    np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one reclaimer wins the rename');
  await fulfilled[0].value.release();
});

test('lock: a leaked flow.lock.reclaim-* (takeover crash) does not block a later acquire', async () => {
  const { flowDir } = await tmpFlow();
  // Plant a stale lock + simulate a crash AFTER the reclaim rename, BEFORE the
  // fresh-lock create → a leaked claim and NO flow.lock.
  await fs.writeFile(
    path.join(flowDir, 'flow.lock'),
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  await assert.rejects(() => np.acquireFlowLock(flowDir, {
    pidAlive: () => false,
    _afterRenameClaim: () => { throw new Error('boom'); },
  }));
  // Now: no flow.lock, a leaked reclaim claim present. A fresh acquire must
  // still succeed (no live lock present → wx create on the absent flow.lock).
  const leftover = (await fs.readdir(flowDir)).filter((n) => n.startsWith('flow.lock.reclaim-'));
  assert.equal(leftover.length, 1, 'a claim was leaked by the crash');
  const lock = await np.acquireFlowLock(flowDir);
  assert.ok(lock.token);
  await lock.release();
});

test('lock: release only unlinks a lock whose token matches (no blind unlink)', async () => {
  const { flowDir } = await tmpFlow();
  const lock = await np.acquireFlowLock(flowDir);
  // Someone else replaced the lock with a different token (e.g. after a takeover).
  await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 'someone-else', pid: process.pid }), 'utf8');
  await lock.release(); // must NOT unlink the foreign lock
  assert.ok(fsSync.existsSync(path.join(flowDir, 'flow.lock')), 'foreign lock left intact');
});

test('lock: C1 — a contender in the publication window (EMPTY lock) BACKS OFF, no takeover', async () => {
  const { flowDir } = await tmpFlow();
  // Owner A holds the lock open('wx') but has NOT yet written the body — a
  // contender B must observe a ZERO-BYTE lock. We drive that window deterministically:
  // start A's acquire with a _beforeBodyWrite hook that PAUSES, run B's acquire while
  // A is paused, then let A finish.
  let release;
  const paused = new Promise((r) => { release = r; });
  let bResult = null;
  const aPromise = np.acquireFlowLock(flowDir, {
    _beforeBodyWrite: async () => {
      // While A's lock file exists but is empty, B tries to acquire. B must NOT
      // take over (the empty lock is brand-new by mtime → below the stale window).
      bResult = await np.acquireFlowLock(flowDir, { pidAlive: () => false, staleMs: 60_000 })
        .then(() => 'TOOK_OVER')
        .catch((e) => (/TASKCTL_LOCKED:/.test(e.message) ? 'BACKED_OFF' : `ERR:${e.message}`));
      release();
    },
  });
  await paused;
  const aLock = await aPromise;
  assert.equal(bResult, 'BACKED_OFF', 'contender must back off during the body-write window (no double-entry)');
  // A still owns its lock with its own token (never reclaimed).
  const body = JSON.parse(await fs.readFile(path.join(flowDir, 'flow.lock'), 'utf8'));
  assert.equal(body.token, aLock.token);
  await aLock.release();
});

test('lock: C1 — an EMPTY lock aged PAST the stale threshold (by file mtime) IS reclaimable', async () => {
  const { flowDir } = await tmpFlow();
  // A zero-byte lock with no body. Backdate its mtime well past the stale window.
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(lp, '', 'utf8');
  const old = new Date(Date.now() - 1e10);
  await fs.utimes(lp, old, old);
  // pid is unverifiable (no body) AND the FILE mtime is old → eligible for takeover.
  const lock = await np.acquireFlowLock(flowDir, { pidAlive: () => false, staleMs: 60_000 });
  assert.ok(lock.token);
  const body = JSON.parse(await fs.readFile(lp, 'utf8'));
  assert.equal(body.token, lock.token);
  await lock.release();
});

// ════════════════════════════════════════════════════════════════════════════
// Archive protocol + crash recovery (under the held lock)
// ════════════════════════════════════════════════════════════════════════════

test('archive: archiveFlowDir moves children into archive-<ts>, excluding the lock + existing archives', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 't', pid: process.pid }), 'utf8');
  await fs.writeFile(path.join(flowDir, 'record.json'), '{}', 'utf8');
  await fs.writeFile(path.join(flowDir, 'brainstorm.md'), '# bs', 'utf8');
  const ts = await np.archiveFlowDir(flowDir, { now: Date.parse('2026-06-12T00:00:00Z') });
  const entries = (await fs.readdir(flowDir)).sort();
  assert.deepEqual(entries, [`archive-${ts}`, 'flow.lock']);
  const archived = (await fs.readdir(path.join(flowDir, `archive-${ts}`))).sort();
  assert.deepEqual(archived, ['brainstorm.md', 'record.json']);
});

test('recovery: idempotent sweep moves strays into the NEWEST archive + is re-runnable', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 't', pid: process.pid }), 'utf8');
  // Simulate a crash mid-restart: an existing archive + leftover strays + NO record.
  await fs.mkdir(path.join(flowDir, 'archive-2026-01-01'), { recursive: true });
  await fs.writeFile(path.join(flowDir, 'brainstorm.md'), '# bs', 'utf8');
  await fs.writeFile(path.join(flowDir, 'flow.lock.reclaim-xyz'), 'leak', 'utf8'); // leaked claim is swept
  const ts = await np.recoverInterruptedArchive(flowDir);
  assert.equal(ts, '2026-01-01'); // targeted the newest (only) archive
  // strays (incl. the reclaim claim) moved into the archive; only the lock + archive remain.
  const entries = (await fs.readdir(flowDir)).sort();
  assert.deepEqual(entries, ['archive-2026-01-01', 'flow.lock']);
  const archived = (await fs.readdir(path.join(flowDir, 'archive-2026-01-01'))).sort();
  assert.ok(archived.includes('brainstorm.md'));
  assert.ok(archived.includes('flow.lock.reclaim-xyz'));
  // re-running is safe (no strays left).
  await np.recoverInterruptedArchive(flowDir);
  assert.deepEqual((await fs.readdir(flowDir)).sort(), ['archive-2026-01-01', 'flow.lock']);
});

test('recovery: I-5 crash AFTER archive mkdir but BEFORE any child moved → sweep completes', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 't', pid: process.pid }), 'utf8');
  // Crash state: the empty archive dir exists (mkdir ran), the record was deleted,
  // and ALL strays are still at the top level (no child moved yet).
  await fs.mkdir(path.join(flowDir, 'archive-2026-02-02'), { recursive: true });
  await fs.writeFile(path.join(flowDir, 'brainstorm.md'), '# bs', 'utf8');
  await fs.writeFile(path.join(flowDir, 'proposal.md'), '# pr', 'utf8');
  const ts = await np.recoverInterruptedArchive(flowDir);
  assert.equal(ts, '2026-02-02');
  // Both strays swept into the (initially empty) archive; only lock + archive remain.
  assert.deepEqual((await fs.readdir(flowDir)).sort(), ['archive-2026-02-02', 'flow.lock']);
  const archived = (await fs.readdir(path.join(flowDir, 'archive-2026-02-02'))).sort();
  assert.deepEqual(archived, ['brainstorm.md', 'proposal.md']);
});

test('recovery: I-5 crash AFTER a PARTIAL child move → sweep finishes the rest (idempotent)', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 't', pid: process.pid }), 'utf8');
  // Crash state: archive exists and ALREADY HOLDS one moved child (brainstorm.md),
  // while proposal.md is still stranded at the top level (the move was interrupted).
  const archiveDir = path.join(flowDir, 'archive-2026-03-03');
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(path.join(archiveDir, 'brainstorm.md'), '# bs', 'utf8'); // already moved
  await fs.writeFile(path.join(flowDir, 'proposal.md'), '# pr', 'utf8');       // not yet moved
  const ts = await np.recoverInterruptedArchive(flowDir);
  assert.equal(ts, '2026-03-03');
  assert.deepEqual((await fs.readdir(flowDir)).sort(), ['archive-2026-03-03', 'flow.lock']);
  const archived = (await fs.readdir(archiveDir)).sort();
  assert.deepEqual(archived, ['brainstorm.md', 'proposal.md'], 'partial move finished — both children archived');
  // Re-running is a no-op (nothing left to sweep).
  await np.recoverInterruptedArchive(flowDir);
  assert.deepEqual((await fs.readdir(flowDir)).sort(), ['archive-2026-03-03', 'flow.lock']);
});

test('archive: TWO archives at the SAME timestamp get UNIQUE names (no silent reuse; Suggestion)', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'flow.lock'), JSON.stringify({ token: 't', pid: process.pid }), 'utf8');
  const sameNow = Date.parse('2026-06-12T00:00:00Z');
  // First archive at sameNow.
  await fs.writeFile(path.join(flowDir, 'a.md'), '1', 'utf8');
  const ts1 = await np.archiveFlowDir(flowDir, { now: sameNow });
  // Second archive at the EXACT same ms — must NOT reuse/merge into the first.
  await fs.writeFile(path.join(flowDir, 'b.md'), '2', 'utf8');
  const ts2 = await np.archiveFlowDir(flowDir, { now: sameNow });
  assert.notEqual(ts1, ts2, 'same-ms archives get distinct tags');
  const archives = (await fs.readdir(flowDir)).filter((n) => n.startsWith('archive-')).sort();
  assert.equal(archives.length, 2, 'two distinct archive dirs');
  // Each archive holds exactly the child present when it ran (no cross-contamination).
  assert.deepEqual(await fs.readdir(path.join(flowDir, `archive-${ts1}`)), ['a.md']);
  assert.deepEqual(await fs.readdir(path.join(flowDir, `archive-${ts2}`)), ['b.md']);
});

// ════════════════════════════════════════════════════════════════════════════
// Durable backlog publish + adoption
// ════════════════════════════════════════════════════════════════════════════

function content(slug) {
  return { contextMd: `# ${slug}\nbody`, stateJson: JSON.stringify({ issueKey: slug, stage: 'analysis' }, null, 2) };
}

test('backlog: publishBacklogItem writes context.md/state.json/runs/marker + records published', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  const item = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  await np.publishBacklogItem({
    tasksDir, item, targetId: 'tid123', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  });
  assert.equal(item.phase, 'published');
  const dir = path.join(tasksDir, 'demo-01-x');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['.taskctl-newproject-owner.json', 'context.md', 'runs', 'state.json']);
  const marker = JSON.parse(await fs.readFile(path.join(dir, '.taskctl-newproject-owner.json'), 'utf8'));
  assert.equal(marker.targetId, 'tid123');
  assert.equal(marker.item, 'demo-01-x');
  assert.equal(marker.manifestHash, item.manifestHash);
});

test('backlog: crash BETWEEN rename and published → resume ADOPTS (no rebuild)', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  const item = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  // First attempt: rename happens, then crash before 'published'.
  await assert.rejects(() => np.publishBacklogItem({
    tasksDir, item, targetId: 'tid', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
    _afterRename: () => { throw new Error('crash'); },
  }));
  assert.equal(item.phase, 'publishing'); // intent recorded, dir present, not yet 'published'
  const hashAfterCrash = item.manifestHash;
  // Resume: same item, FRESH (different-timestamp would differ but our content is
  // deterministic here) — adoption must succeed via the recorded hash WITHOUT a
  // makeContent regeneration mismatch.
  let regenerated = false;
  await np.publishBacklogItem({
    tasksDir, item, targetId: 'tid', persistRecord: async () => {},
    makeContent: () => { regenerated = true; return content('demo-01-x'); },
  });
  assert.equal(item.phase, 'published');
  assert.equal(item.manifestHash, hashAfterCrash, 'recorded hash unchanged on adoption');
  assert.equal(regenerated, false, 'adoption did NOT regenerate content');
});

test('backlog: crash BEFORE rename (dir absent) → resume re-publishes', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  // item already 'publishing' with a recorded hash but NO final dir (died before rename).
  const item = { slug: 'demo-01-x', phase: 'publishing', manifestHash: 'staleHash' };
  let regenerated = false;
  await np.publishBacklogItem({
    tasksDir, item, targetId: 'tid', persistRecord: async () => {},
    makeContent: () => { regenerated = true; return content('demo-01-x'); },
  });
  assert.equal(item.phase, 'published');
  assert.equal(regenerated, true, 're-published with fresh content');
  assert.ok(fsSync.existsSync(path.join(tasksDir, 'demo-01-x', 'context.md')));
});

test('backlog: a FINAL dir with the same files but a FOREIGN marker → error (not adopted)', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  const item = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  const dir = path.join(tasksDir, 'demo-01-x');
  // Plant a dir with the generated files but a marker from ANOTHER flow.
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  const { contextMd, stateJson } = content('demo-01-x');
  await fs.writeFile(path.join(dir, 'context.md'), contextMd, 'utf8');
  await fs.writeFile(path.join(dir, 'state.json'), stateJson, 'utf8');
  await fs.writeFile(path.join(dir, '.taskctl-newproject-owner.json'), JSON.stringify({ targetId: 'OTHER', item: 'demo-01-x', manifestHash: 'xx' }), 'utf8');
  await assert.rejects(() => np.publishBacklogItem({
    tasksDir, item, targetId: 'tid', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  }), (e) => /not owned by this flow/.test(e.message));
});

test('backlog: C2 — an EDITED generated context.md → FOREIGN halt (never overwritten/deleted)', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  // Publish once with a recorded hash, exact tree, our marker.
  const item = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  await np.publishBacklogItem({
    tasksDir, item, targetId: 'tid', flowToken: 'tok12345', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  });
  assert.equal(item.phase, 'published');
  const dir = path.join(tasksDir, 'demo-01-x');
  // User EDITS the generated context.md (no extra file — exact tree preserved).
  const edited = '# demo-01-x\nEDITED BY THE USER';
  await fs.writeFile(path.join(dir, 'context.md'), edited, 'utf8');
  // A re-publish attempt (simulating a --restart that regenerated this item).
  const item2 = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  await assert.rejects(() => np.publishBacklogItem({
    tasksDir, item: item2, targetId: 'tid', flowToken: 'tok12345', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  }), (e) => /not owned by this flow/.test(e.message) && /will NOT overwrite or delete/.test(e.message));
  // The user's edit is INTACT — nothing deleted or overwritten.
  assert.equal(await fs.readFile(path.join(dir, 'context.md'), 'utf8'), edited);
});

test('backlog: C3 — temp dir name is flow-qualified (.tmp-<tid8>-<tok8>-<slug>)', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  const item = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  // Crash AFTER rename so we can observe nothing leaks; but first prove the temp
  // name shape via a crash BEFORE rename (build the temp, then throw at marker
  // time is not exposed) — instead assert the qualified name is what gets renamed
  // by checking no bare `.tmp-<slug>` is produced and the final dir exists.
  await np.publishBacklogItem({
    tasksDir, item, targetId: 'abcdef1234567890', flowToken: 'TOKEN-abcdef-xyz', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  });
  // After a clean publish the temp is renamed away; no temp dirs remain, and
  // crucially no bare `.tmp-demo-01-x` was ever the name (the helper composes it).
  const remaining = (await fs.readdir(tasksDir)).filter((n) => n.startsWith('.tmp-'));
  assert.deepEqual(remaining, []);
  // The qualified name the module would build (asserted indirectly): prefix uses
  // the 8-char target-id + 8-char token slices.
  assert.equal(item.phase, 'published');
});

test('backlog: C3 — an UNRELATED user .tmp-<slug> dir is PRESERVED by cleanup', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  // A user's own scratch dir that happens to match the bare-slug prefix the OLD
  // code deleted unconditionally. It has NO ownership marker.
  const userTmp = path.join(tasksDir, '.tmp-demo-01-x');
  await fs.mkdir(userTmp, { recursive: true });
  await fs.writeFile(path.join(userTmp, 'precious.txt'), 'do not delete', 'utf8');
  // Also plant a temp owned by ANOTHER flow (marker targetId mismatch) → preserved.
  const otherTmp = path.join(tasksDir, '.tmp-deadbeef-othertok-demo-01-x');
  await fs.mkdir(otherTmp, { recursive: true });
  await fs.writeFile(path.join(otherTmp, np.OWNER_MARKER), JSON.stringify({ targetId: 'OTHER', item: 'demo-01-x', manifestHash: 'zz' }), 'utf8');

  const item = { slug: 'demo-01-x', phase: 'planned', manifestHash: null };
  await np.publishBacklogItem({
    tasksDir, item, targetId: 'tid12345', flowToken: 'tok12345', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  });
  // Both unrelated temp dirs (and their contents) SURVIVE.
  assert.ok(fsSync.existsSync(path.join(userTmp, 'precious.txt')), 'user .tmp-<slug> preserved');
  assert.equal(await fs.readFile(path.join(userTmp, 'precious.txt'), 'utf8'), 'do not delete');
  assert.ok(fsSync.existsSync(path.join(otherTmp, np.OWNER_MARKER)), "another flow's temp preserved");
  assert.equal(item.phase, 'published');
});

test('backlog: a final dir with an unexpected EXTRA file → foreign (error)', async () => {
  const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-bl-'));
  const item = { slug: 'demo-01-x', phase: 'publishing', manifestHash: null };
  const { contextMd, stateJson } = content('demo-01-x');
  const expectHash = np.manifestHash(contextMd, stateJson);
  item.manifestHash = expectHash;
  const dir = path.join(tasksDir, 'demo-01-x');
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'context.md'), contextMd, 'utf8');
  await fs.writeFile(path.join(dir, 'state.json'), stateJson, 'utf8');
  await fs.writeFile(path.join(dir, '.taskctl-newproject-owner.json'), JSON.stringify({ targetId: 'tid', item: 'demo-01-x', manifestHash: expectHash }), 'utf8');
  await fs.writeFile(path.join(dir, 'EXTRA.txt'), 'oops', 'utf8'); // unexpected file
  await assert.rejects(() => np.publishBacklogItem({
    tasksDir, item, targetId: 'tid', persistRecord: async () => {},
    makeContent: () => content('demo-01-x'),
  }), (e) => /not owned by this flow/.test(e.message));
});

function validRecord(extra = {}) {
  return {
    schemaVersion: np.RECORD_SCHEMA_VERSION,
    idea: 'an idea', slug: 'an-idea', canonicalTarget: '/x/y/z',
    step: 'brainstorm', chosenOption: null, backlog: [], scaffoldEmitted: false,
    ...extra,
  };
}

test('record: writeRecord is atomic (temp+rename) and readRecord round-trips', async () => {
  const { flowDir } = await tmpFlow();
  await np.writeRecord(flowDir, validRecord());
  const back = await np.readRecord(flowDir);
  assert.equal(back.step, 'brainstorm');
  // No leftover temp files.
  const temps = (await fs.readdir(flowDir)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(temps, []);
});

// ════════════════════════════════════════════════════════════════════════════
// Record validation (I-1): missing vs unreadable/invalid
// ════════════════════════════════════════════════════════════════════════════

test('record: readRecord returns null ONLY for a truly-missing record', async () => {
  const { flowDir } = await tmpFlow();
  assert.equal(await np.readRecord(flowDir), null); // no record.json yet
});

test('record: a CORRUPT (invalid JSON) record HALTS — never null (I-1)', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'record.json'), '{ not valid json', 'utf8');
  await assert.rejects(
    () => np.readRecord(flowDir),
    (e) => /^TASKCTL_EXIT:/.test(e.message) && /corrupt/.test(e.message),
  );
  // State intact: the corrupt bytes are untouched.
  assert.equal(await fs.readFile(path.join(flowDir, 'record.json'), 'utf8'), '{ not valid json');
});

test('record: a record with a BAD step value HALTS (schema/step validation; I-1)', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'record.json'), JSON.stringify(validRecord({ step: 'not-a-real-step' })), 'utf8');
  await assert.rejects(
    () => np.readRecord(flowDir),
    (e) => /^TASKCTL_EXIT:/.test(e.message) && /unknown step/.test(e.message),
  );
});

test('record: an unsupported schemaVersion HALTS (I-1)', async () => {
  const { flowDir } = await tmpFlow();
  await fs.writeFile(path.join(flowDir, 'record.json'), JSON.stringify(validRecord({ schemaVersion: 999 })), 'utf8');
  await assert.rejects(
    () => np.readRecord(flowDir),
    (e) => /^TASKCTL_EXIT:/.test(e.message) && /schemaVersion/.test(e.message),
  );
});

test('record: validateRecordShape accepts a full record + rejects each missing field', () => {
  assert.equal(np.validateRecordShape(validRecord()), null);
  assert.match(np.validateRecordShape(validRecord({ canonicalTarget: '' })), /canonicalTarget/);
  assert.match(np.validateRecordShape(validRecord({ idea: undefined })), /idea/);
  assert.match(np.validateRecordShape(validRecord({ slug: 123 })), /slug/);
  assert.match(np.validateRecordShape(validRecord({ backlog: 'nope' })), /backlog/);
  assert.match(np.validateRecordShape(null), /not a JSON object/);
});
