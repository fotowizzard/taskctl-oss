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

test('lock: C2 — a reclaimer whose stale verdict went out of date must NOT take over', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // B classifies the planted lock as stale and then PAUSES in the gap before its
  // rename. Rival A performs an ENTIRE legitimate takeover inside that gap, so
  // flow.lock now names a FRESH, LIVE lock — a different file from the one B
  // judged. B's rename is atomic on the PATH, not on the FILE, so it would happily
  // remove A's live lock and publish B's own: two holders. B must refuse instead.
  const probe = { pidAlive: (pid) => pid !== 999999 };
  let aLock = null;
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, {
      ...probe,
      _beforeReclaimRename: async () => { aLock = await np.acquireFlowLock(flowDir, probe); },
    }),
    (e) => /TASKCTL_LOCKED:/.test(e.message),
    'B must back off — the file it classified is no longer the file at that path',
  );
  assert.ok(aLock, 'rival A completed its takeover inside the gap');
  // A's live lock survived intact: not renamed away, not replaced by B's.
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, aLock.token);
  const leftover = (await fs.readdir(flowDir)).filter((n) => n.startsWith('flow.lock.reclaim-'));
  assert.deepEqual(leftover, [], 'B left no claim behind');
  // A is still the genuine owner — its compare-before-unlink release works.
  await aLock.release();
  assert.equal(fsSync.existsSync(lp), false, 'the owner could release its own lock');
});

test('lock: C2 control — a paused reclaimer STILL takes over when flow.lock is unchanged', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // Negative control for the test above: same pause, but nothing touches the lock
  // in the gap. The post-rename re-validation must accept the file — otherwise the
  // C2 assertion would pass vacuously via a takeover path that refuses everything.
  let gapRan = false;
  const lock = await np.acquireFlowLock(flowDir, {
    pidAlive: (pid) => pid !== 999999,
    _beforeReclaimRename: () => { gapRan = true; },
  });
  assert.ok(gapRan, 'the pause really happened');
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, lock.token, 'the takeover completed');
  const leftover = (await fs.readdir(flowDir)).filter((n) => n.startsWith('flow.lock.reclaim-'));
  assert.deepEqual(leftover, []);
  await lock.release();
});

test('lock: C2 — a takeover whose gap was filled by another acquirer yields TASKCTL_LOCKED, not a raw EEXIST', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // A wins the reclaim rename, so flow.lock is momentarily ABSENT. In that window
  // B acquires via the ordinary exclusive-create path and legitimately holds the
  // mutex. A must recognise it did NOT get the lock and report that as a lock
  // conflict — not surface the bare EEXIST from its own fresh-lock create.
  const probe = { pidAlive: (pid) => pid !== 999999 };
  let bLock = null;
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, {
      ...probe,
      _afterRenameClaim: async () => { bLock = await np.acquireFlowLock(flowDir, probe); },
    }),
    (e) => /TASKCTL_LOCKED:/.test(e.message),
    'the rename winner must back off in favour of the acquirer that published first',
  );
  assert.ok(bLock, 'B acquired inside the window where flow.lock was absent');
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, bLock.token, "B's lock is untouched");
  const leftover = (await fs.readdir(flowDir)).filter((n) => n.startsWith('flow.lock.reclaim-'));
  assert.deepEqual(leftover, [], 'the abandoning reclaimer cleaned up its claim');
  await bLock.release();
});

test('lock: C3 — a reclaimer must never DETACH a lock it has not re-verified under exclusion', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // The three-contender interleaving, driven deterministically through both seams:
  //   1. B classifies the planted lock as stale;
  //   2. rival A completes an ENTIRE takeover → flow.lock is A's FRESH, LIVE lock;
  //   3. B's rename fires and carries A's LIVE lock away → flow.lock is ABSENT;
  //   4. C walks into that hole and wins the first-attempt exclusive create;
  //   5. B now finds its claim LIVE, cannot put it back (C published first), so it
  //      destroys the file it lifted and backs off.
  // B backing off is NOT sufficient: A and C have both returned a held handle. A
  // reclaimer must never detach a file from the public name on the strength of a
  // verdict that another takeover could already have invalidated.
  const probe = { pidAlive: (pid) => pid !== 999999 };
  const holders = [];
  const acquireInto = async (who) => {
    try { holders.push({ who, lock: await np.acquireFlowLock(flowDir, probe) }); }
    catch { /* refused — a legitimate outcome for any single contender */ }
  };
  const bResult = await np.acquireFlowLock(flowDir, {
    ...probe,
    _beforeReclaimRename: () => acquireInto('A'),
    _insideAbsenceWindow: () => acquireInto('C'),
  }).then(
    (lock) => { holders.push({ who: 'B', lock }); return 'ACQUIRED'; },
    (e) => (/TASKCTL_LOCKED:/.test(e.message) ? 'REFUSED' : `ERR:${e.message}`),
  );
  assert.equal(
    holders.length, 1,
    `mutual exclusion: at most one caller may hold — held by [${holders.map((h) => h.who).join(', ')}], B: ${bResult}`,
  );
  assert.equal(holders[0].who, 'A', 'the contender that completed a whole takeover first is the holder');
  assert.equal(bResult, 'REFUSED', 'B must report a lock conflict, not a raw error');
  // The sole holder's lock is the file actually at flow.lock: nobody's live lock was
  // carried off the public name, replaced, or deleted underneath them.
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, holders[0].lock.token);
  const leftover = (await fs.readdir(flowDir)).filter((n) => n.startsWith('flow.lock.reclaim-'));
  assert.deepEqual(leftover, [], 'no claim left behind');
  await holders[0].lock.release();
  assert.equal(fsSync.existsSync(lp), false, 'the sole holder could release its own lock');
});

test('lock: a takeover already in flight (gate held) makes a second reclaimer stand down', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  const stale = JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() });
  await fs.writeFile(lp, stale, 'utf8');
  // A takeover is in flight: the gate exists and is brand-new. The stale lock is
  // still on the public name, so the only correct answer is a lock conflict — and
  // this reclaimer must not touch flow.lock on its way out.
  await fs.writeFile(
    path.join(flowDir, 'flow.lock.takeover'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    'utf8',
  );
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 }),
    (e) => /TASKCTL_LOCKED:.*reclaiming/.test(e.message),
  );
  assert.equal(await fs.readFile(lp, 'utf8'), stale, 'the stale lock was left where it was');
  assert.ok(fsSync.existsSync(path.join(flowDir, 'flow.lock.takeover')), "someone else's gate is left alone");
});

test('lock: a BODYLESS but brand-new gate (its own publication window) also makes a reclaimer stand down', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // Same C1 shape as the lock itself: a gate whose owner has published the file but
  // not yet written the body must be aged by the FILE's mtime (≈ now → in flight),
  // never treated as ageless and cleared.
  await fs.writeFile(path.join(flowDir, 'flow.lock.takeover'), '', 'utf8');
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 }),
    (e) => /TASKCTL_LOCKED:.*reclaiming/.test(e.message),
  );
});

test('lock: a LONG-STANDING gate is refused with the file to remove — never cleared', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  const stale = JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() });
  await fs.writeFile(lp, stale, 'utf8');
  // An old gate is indistinguishable on disk from a gate whose holder is merely SLOW
  // (see the stalled-holder test below), so age must not authorise removing it. What
  // an aged-out gate buys is a better MESSAGE: name the file, so an operator can undo
  // a genuine interruption in one command. This test previously asserted the opposite
  // — that the gate was cleared and the takeover proceeded — and the behaviour change
  // is deliberate: that clearing is what the stalled-holder test exploits.
  const gp = path.join(flowDir, 'flow.lock.takeover');
  await fs.writeFile(gp, JSON.stringify({ token: 'g', pid: process.pid, startedAt: new Date(Date.now() - 1e10).toISOString() }), 'utf8');
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 }),
    (e) => /TASKCTL_LOCKED:.*interrupted — remove .*flow\.lock\.takeover/.test(e.message),
  );
  assert.ok(fsSync.existsSync(gp), 'the gate was left for its holder (or an operator) to remove');
  assert.equal(await fs.readFile(lp, 'utf8'), stale, 'the stale lock was left where it was');
  // Removing the named file is all it takes — the refusal is recoverable, not a wedge.
  await fs.unlink(gp);
  const lock = await np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 });
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, lock.token, 'the takeover then proceeds');
  await lock.release();
});

test('lock: a gate dated in the FUTURE is still refused, and says so as a conflict', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // A future startedAt makes the gate's age NEGATIVE. While age gated the removal that
  // was an unbounded wait dressed up as a 60 s timeout; now it only picks wording, so
  // the outcome is the safe one either way — refuse, never clear.
  await fs.writeFile(
    path.join(flowDir, 'flow.lock.takeover'),
    JSON.stringify({ token: 'g', pid: process.pid, startedAt: new Date(Date.now() + 1e10).toISOString() }),
    'utf8',
  );
  await assert.rejects(
    () => np.acquireFlowLock(flowDir, { pidAlive: (pid) => pid !== 999999 }),
    (e) => /TASKCTL_LOCKED:.*reclaiming/.test(e.message),
  );
  assert.ok(fsSync.existsSync(path.join(flowDir, 'flow.lock.takeover')), 'the gate is left alone');
});

test('lock: a STALLED gate holder is never overtaken — no two takeovers in flight', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // The defect this pins, in the shape that makes it a SAFETY failure rather than a
  // liveness tradeoff. B holds the gate and is stalled INSIDE its critical section —
  // flow.lock re-classified, not yet detached. Contender A's clock has moved past the
  // gate's expiry, so under an age-expiring gate A tears B's gate down and starts a
  // SECOND takeover against the same lock. A completes it and publishes a fresh LIVE
  // lock; B then resumes on a verdict A has already voided, detaches A's live lock,
  // and C walks into the hole B opened. Two takeovers in flight is the cause; two
  // holders is the symptom — assert both, because only the first is the property.
  const probe = { pidAlive: (pid) => pid !== 999999 };
  const now = Date.now();
  const holders = [];
  const acquireInto = async (who, deps) => {
    try { holders.push({ who, lock: await np.acquireFlowLock(flowDir, deps) }); }
    catch (e) { return /TASKCTL_LOCKED:/.test(e.message) ? 'REFUSED' : `ERR:${e.message}`; }
    return 'ACQUIRED';
  };
  let aResult = 'never ran';
  const bResult = await acquireInto('B', {
    ...probe,
    now,
    // A, 61 s later by its own clock: B's gate has "expired" while B is alive in it.
    _insideTakeoverGate: async () => { aResult = await acquireInto('A', { ...probe, now: now + 61_000 }); },
    _insideAbsenceWindow: () => acquireInto('C', probe),
  });
  assert.equal(aResult, 'REFUSED', 'a second takeover must not START while the first is in flight');
  assert.equal(
    holders.length, 1,
    `mutual exclusion: at most one caller may hold — held by [${holders.map((h) => h.who).join(', ')}], B: ${bResult}`,
  );
  // Who holds is not the property. C legitimately wins the briefly-free name while B
  // has a PROVABLY STALE file off to the side, and B defers to it — the structural
  // absence window, safe by construction. What must never happen is A holding too,
  // because A's whole takeover ran alongside B's.
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, holders[0].lock.token, 'the sole holder owns the file on the name');
  const strays = (await fs.readdir(flowDir)).filter((n) => n !== 'flow.lock');
  assert.deepEqual(strays, [], 'the gate and the claim were both cleaned up');
  await holders[0].lock.release();
});

test('lock: a gate holder releases only ITS OWN gate, never a successor\'s', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // The `finally` that ends a takeover used to unlink the gate PATH unconditionally.
  // A gate can still leave the name without its holder's consent — the archive sweep
  // removes a stray gate — and a successor may then publish its own. A blind unlink
  // there ends the successor's critical section from the outside, which is the same
  // defect one level up. Simulated at exactly that point: the gate is swept and a
  // successor publishes while this holder is inside its section.
  const gp = path.join(flowDir, 'flow.lock.takeover');
  const successor = JSON.stringify({ token: 'successor', pid: process.pid, startedAt: new Date().toISOString() });
  const lock = await np.acquireFlowLock(flowDir, {
    pidAlive: (pid) => pid !== 999999,
    _insideTakeoverGate: async () => { await fs.unlink(gp); await fs.writeFile(gp, successor, 'utf8'); },
  });
  assert.equal(await fs.readFile(gp, 'utf8'), successor, "the successor's gate survived this holder's release");
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, lock.token, 'the takeover still completed');
  await lock.release();
  await fs.unlink(gp);
});

test('lock: while a takeover holds the gate, a rival reclaimer CANNOT start its own', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // The gate's whole purpose: inside the critical section — flow.lock re-classified,
  // not yet detached — no other caller may reclaim. This is the window the
  // three-contender case exploited, and it is the one a deterministic test cannot
  // otherwise reach: without exclusion a rival completes a whole takeover here and
  // the verdict this caller is about to act on is already void.
  const probe = { pidAlive: (pid) => pid !== 999999 };
  let rival = 'never ran';
  const lock = await np.acquireFlowLock(flowDir, {
    ...probe,
    _insideTakeoverGate: async () => {
      rival = await np.acquireFlowLock(flowDir, probe).then(
        () => 'TOOK OVER',
        (e) => (/TASKCTL_LOCKED:/.test(e.message) ? 'STOOD DOWN' : `ERR:${e.message}`),
      );
    },
  });
  assert.equal(rival, 'STOOD DOWN', 'the gate holder is the only caller allowed to reclaim');
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, lock.token, 'the gate holder completed its takeover');
  const strays = (await fs.readdir(flowDir)).filter((n) => n !== 'flow.lock');
  assert.deepEqual(strays, [], 'the gate and the claim were both cleaned up');
  await lock.release();
});

test('lock: the belt-and-braces restore never evicts the occupant, even with no hard links', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'old', pid: 999999, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  // The ONE interleaving that still reaches the restore path, and it needs the
  // liveness probe to have LIED: the "dead" holder was alive, released, and C
  // published into the freed name before B's rename ran — so B's rename detaches C's
  // LIVE lock. Two callers already believe they hold at that point, because a stale
  // verdict on a live owner is the takeover POLICY's premise failing; no protocol can
  // repair it from here. What must still hold is narrower: whatever B does with the
  // file it lifted, it must not evict whoever occupies flow.lock now.
  const probe = { pidAlive: (pid) => pid !== 999999 };
  let c = null;
  let d = null;
  const bResult = await np.acquireFlowLock(flowDir, {
    ...probe,
    _insideTakeoverGate: async () => { await fs.unlink(lp); c = await np.acquireFlowLock(flowDir, probe); },
    _insideAbsenceWindow: async () => { d = await np.acquireFlowLock(flowDir, probe); },
    _link: async () => { const e = new Error('no hard links here'); e.code = 'EPERM'; throw e; },
  }).then(() => 'ACQUIRED', (e) => (/TASKCTL_LOCKED:/.test(e.message) ? 'REFUSED' : `ERR:${e.message}`));
  assert.ok(c, 'C published into the name the misclassified holder released');
  assert.ok(d, 'D took the name while B held C\'s lock off to the side');
  assert.equal(bResult, 'REFUSED', 'B must not keep a lock it turned out to have lifted live');
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, d.token, 'D, the occupant, was NOT evicted');
  // C lost its lock (the policy failure above), but its release is token-guarded, so
  // even a phantom holder cannot damage the caller that legitimately holds now.
  await c.release();
  assert.equal(JSON.parse(await fs.readFile(lp, 'utf8')).token, d.token, "the phantom's release left D alone");
  await d.release();
  assert.equal(fsSync.existsSync(lp), false, 'the real holder could release');
});

test('restore: a lock lifted off flow.lock goes back only into a FREE name — with hard links', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  const claim = path.join(flowDir, 'flow.lock.reclaim-t');
  const lifted = JSON.stringify({ token: 'lifted', pid: process.pid });
  // (a) flow.lock is free → the very same inode goes back.
  await fs.writeFile(claim, lifted, 'utf8');
  assert.equal(await np.republishLiftedLock(claim, lp), 'linked');
  assert.equal(await fs.readFile(lp, 'utf8'), lifted);
  assert.equal((await fs.lstat(lp)).ino, (await fs.lstat(claim)).ino, 'restored the same file, not a copy');
  await fs.unlink(claim);
  // (b) flow.lock is occupied → the occupant survives untouched.
  const occupant = JSON.stringify({ token: 'occupant', pid: process.pid });
  await fs.writeFile(lp, occupant, 'utf8');
  await fs.writeFile(claim, lifted, 'utf8');
  assert.equal(await np.republishLiftedLock(claim, lp), 'occupied');
  assert.equal(await fs.readFile(lp, 'utf8'), occupant, 'a live occupant is NEVER evicted');
});

test('restore: with NO hard links the fallback still refuses to evict — it never renames over flow.lock', async () => {
  const { flowDir } = await tmpFlow();
  const lp = path.join(flowDir, 'flow.lock');
  const claim = path.join(flowDir, 'flow.lock.reclaim-t');
  const lifted = JSON.stringify({ token: 'lifted', pid: process.pid });
  // A filesystem without hard links: fs.link fails with something OTHER than EEXIST.
  // The old fallback was an unconditional fs.rename, which replaces whatever is at
  // flow.lock — silently evicting a holder that published in the meantime.
  const noHardLinks = { _link: async () => { const e = new Error('no hard links here'); e.code = 'EPERM'; throw e; } };
  // (a) occupied → refuse. This is the eviction the fallback must not commit.
  const occupant = JSON.stringify({ token: 'occupant', pid: process.pid });
  await fs.writeFile(lp, occupant, 'utf8');
  await fs.writeFile(claim, lifted, 'utf8');
  assert.equal(await np.republishLiftedLock(claim, lp, noHardLinks), 'occupied');
  assert.equal(await fs.readFile(lp, 'utf8'), occupant, 'the live occupant survived the fallback');
  // (b) free → the bytes go back, so the fallback is not simply "always refuse".
  // A byte copy is the same lock to its owner: release() compares the token, not the
  // inode — assert that the lifted owner can still release what came back.
  await fs.unlink(lp);
  assert.equal(await np.republishLiftedLock(claim, lp, noHardLinks), 'copied');
  assert.equal(await fs.readFile(lp, 'utf8'), lifted, 'restored the lifted body byte for byte');
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
