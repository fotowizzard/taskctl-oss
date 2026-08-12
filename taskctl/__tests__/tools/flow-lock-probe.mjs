/**
 * flow-lock-probe.mjs — a SMOKE DIAGNOSTIC for the flow lock, and the origin of every
 * probe figure quoted below.
 *
 * ── READ THIS BEFORE QUOTING A GREEN RUN ─────────────────────────────────────────
 *
 * A green run does NOT show that the lock is correct. With the default settings below
 * this probe reports `ok`, one holder in every trial, at 3 and 5 contenders, 200 trials
 * each, against `newproject.mjs` at commit 68a8eae — a build on which THREE of this
 * module's own unit tests fail. That pairing needs nobody's word for it: check out that
 * commit, run this probe (green), then run `node --test __tests__/newproject-unit.test.mjs`
 * (three failures). The probe was blind to a defect those deterministic tests catch on
 * every single run.
 *
 * So a green run establishes exactly one thing: THIS contention shape produced one
 * holder per trial on THIS build. It is not evidence that a defect is closed, absent,
 * or even rare. A defect this probe's SHAPE cannot express reports green at any trial
 * count, so no number of iterations converts a clean sweep into a safety claim.
 *
 * What demonstrates the mutual-exclusion defects are closed is the deterministic,
 * seam-driven tests in __tests__/newproject-unit.test.mjs. They schedule the exact
 * interleaving through the `_beforeReclaimRename` / `_insideAbsenceWindow` /
 * `_insideTakeoverGate` hooks and fail against the broken builds every time. This probe
 * corroborates those tests; it does not carry them and cannot stand in for them.
 *
 * What a run that could speak to SAFETY would need: the failing condition SET UP
 * explicitly rather than waited for — a contender pinned inside the takeover gate's
 * critical section while a rival tries to overtake it (a stalled-holder mode), or a
 * clock arrangement that makes such a stall visible to the rivals. NO SUCH MODE IS
 * CONFIGURED HERE. Nothing in this file stalls a holder, and the default sweep runs at
 * skew 0. `--skew` is not a substitute: on the current protocol no clock authorises
 * anything — gate age only selects the wording of a refusal, and a live pid is
 * authoritative at any age — so skewing a contender changes which message it may
 * receive, not what any caller is permitted to do. Even against 68a8eae, where gate age
 * DID authorise removing a gate, `--skew 61000` surfaced the defect in only 4 of 400
 * trials at 5 contenders, and 0 of 400 at both 2 and 3 contenders.
 *
 * Where it does earn its place: POSITIVE signals and regression smoke. A probe of this
 * shape reported 931/1000 double-acquires at 3 contenders against 2c2ed12, and 475/1000
 * against a gateless mutant — findings a red run genuinely carries. Believe this probe
 * when it goes red; conclude nothing from green.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * NOT a test: it is probabilistic, so it is deliberately outside the
 * `__tests__/*.test.mjs` glob that `npm test` runs. It is committed so its numbers can
 * be re-run by someone else — a measurement nobody else can reproduce is not evidence,
 * and one nobody else can re-aim cannot be checked for the blindness described above.
 *
 * What it does, per trial: plant a STALE flow.lock (dead pid, aged out) in a fresh
 * temp flow dir, fire N genuinely concurrent `acquireFlowLock` calls at it, and count
 * how many of them returned a held handle. The mutex says that count is always 1.
 *
 * Why in-process concurrency is the right instrument here. The interleavings that
 * break this lock are orderings of filesystem syscalls, and `Promise.all` over N
 * acquires interleaves them at every `await` — which is every syscall. Separate OS
 * processes would interleave too, but coarsely and unrepeatably, and they cannot
 * inject the `pidAlive` seam the stale planting needs. The trade is that all N
 * contenders share one pid, so `pidAlive` is stubbed to call ONLY the planted
 * sentinel pid dead; every lock any contender publishes carries this live process's
 * pid and is therefore genuinely live to the others, which is the property the
 * takeover path turns on.
 *
 * Why `--contenders` is a first-class knob. A probe is evidence only about the
 * interleavings its SHAPE permits. This has already been got wrong once here: a
 * 2-contender run of this probe was reported as excluding a defect that in fact needs 3
 * distinct roles — a publisher, a lifter and an entrant — and two contenders cannot
 * supply three roles, so that clean result was a property of the shape and never said
 * anything about the lock. So run 3+ at minimum. That is a necessary condition for the
 * shape to be able to fail, not a sufficient one: see the top block, where 3 and 5
 * contenders were still clean against a build known to be broken.
 *
 * Usage:
 *   node __tests__/tools/flow-lock-probe.mjs                     # default sweep
 *   node __tests__/tools/flow-lock-probe.mjs --contenders 3 --trials 1000
 *   node __tests__/tools/flow-lock-probe.mjs --contenders 2,3,5,8 --trials 600
 *   node __tests__/tools/flow-lock-probe.mjs --skew 61000         # see below
 *
 * `--skew <ms>` gives contender #1 a clock that many ms ahead of the others. It is a
 * knob aimed at the PREDECESSOR builds rather than at HEAD: while the gate age-expired,
 * a gate younger than the skew looked abandoned to the skewed contender, which let it
 * tear the gate down and start a second takeover — that is how a stalled gate holder
 * looked to a rival. The gate no longer expires, so on HEAD the skew authorises nothing,
 * and a clean skewed run says no more than a clean unskewed one.
 *
 * Exit code is 1 if any trial produced more than one holder, so it can be dropped into
 * a script. Exit 0 means only "no trial in the shape just run produced two holders" —
 * it is not a pass, and per the top block it is not evidence of correctness. Note that
 * the exit code keys on holder count ALONE, so a run can print PROBLEM for strays, a
 * disowned token, an ATTEMPT CAP rejection or a raw error and still exit 0; read the
 * output, do not just check the status.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as np from '../../newproject.mjs';

const DEAD_PID = 999999; // never a real pid on any platform we run on
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
};

const trials = Number(arg('trials', 1000));
const contenderSet = String(arg('contenders', '2,3,4,5,8')).split(',').map(Number);
const skewMs = Number(arg('skew', 0));

/**
 * One trial: N concurrent acquires against a freshly planted stale lock.
 * Returns { holders, rejections, strays, tokenOwned } — `tokenOwned` is whether the
 * token sitting at flow.lock afterwards belongs to a contender that actually
 * returned a handle (a holder whose file was destroyed underneath it fails this).
 */
async function trial(flowDir, contenders) {
  const lp = path.join(flowDir, 'flow.lock');
  await fs.writeFile(
    lp,
    JSON.stringify({ token: 'planted', pid: DEAD_PID, startedAt: new Date(Date.now() - 1e10).toISOString() }),
    'utf8',
  );
  const probe = { pidAlive: (pid) => pid !== DEAD_PID };
  const now = Date.now();
  const results = await Promise.all(
    Array.from({ length: contenders }, (_, i) =>
      np.acquireFlowLock(flowDir, { ...probe, now: now + (i === 0 ? skewMs : 0) }).then(
        (lock) => ({ ok: true, lock }),
        (e) => ({ ok: false, why: /^TASKCTL_LOCKED:/.test(e.message) ? classifyRejection(e.message) : `RAW:${e.message}` }),
      )),
  );
  const holders = results.filter((r) => r.ok);
  let onDisk = null;
  try { onDisk = JSON.parse(await fs.readFile(lp, 'utf8')).token; } catch { /* gone */ }
  for (const h of holders) await h.lock.release();
  const strays = (await fs.readdir(flowDir)).filter((n) => n !== 'flow.lock');
  for (const s of strays) await fs.rm(path.join(flowDir, s), { recursive: true, force: true });
  await fs.rm(lp, { force: true });
  return {
    holders: holders.length,
    rejections: results.filter((r) => !r.ok).map((r) => r.why),
    strays,
    tokenOwned: holders.length === 0 ? null : holders.some((h) => h.lock.token === onDisk),
  };
}

/** Bucket a TASKCTL_LOCKED message by which refusal it is — the buckets are the
 *  interesting part: "reclaiming" means the gate turned a contender away, whereas
 *  "ATTEMPT CAP" would mean the retry cap fired, which no healthy run should reach.
 *  Read the ATTEMPT CAP bucket in one direction only: this probe has never been shown
 *  able to DRIVE it (no configuration here sustains retry pressure), so an empty bucket
 *  says nothing about behaviour at the cap. A non-empty one would be a real finding. */
function classifyRejection(msg) {
  if (/is reclaiming the stale flow lock/.test(msg)) return 'gate in flight';
  if (/has been in flight since/.test(msg)) return 'gate interrupted';
  if (/could not settle the flow lock after/.test(msg)) return 'ATTEMPT CAP';
  if (/already running/.test(msg)) return 'lock live';
  if (/appears to be running/.test(msg)) return 'lock young';
  return `other: ${msg.replace(/^TASKCTL_LOCKED:/, '').slice(0, 60)}`;
}

let anyBad = false;
console.log(`flow-lock probe — trials=${trials} per contender count, skew=${skewMs}ms\n`);
for (const contenders of contenderSet) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-lock-probe-'));
  const flowDir = path.join(root, 'flow');
  await fs.mkdir(flowDir, { recursive: true });
  const byHolders = new Map();
  const byRejection = new Map();
  let strayTrials = 0;
  let disownedTrials = 0;
  for (let i = 0; i < trials; i++) {
    const r = await trial(flowDir, contenders);
    byHolders.set(r.holders, (byHolders.get(r.holders) ?? 0) + 1);
    for (const why of r.rejections) byRejection.set(why, (byRejection.get(why) ?? 0) + 1);
    if (r.strays.length) strayTrials++;
    if (r.tokenOwned === false) disownedTrials++;
  }
  await fs.rm(root, { recursive: true, force: true });
  const max = Math.max(...byHolders.keys());
  const bad = max > 1 || strayTrials > 0 || disownedTrials > 0 || byRejection.has('ATTEMPT CAP')
    || [...byRejection.keys()].some((k) => k.startsWith('other') || k.startsWith('RAW'));
  anyBad ||= max > 1;
  console.log(`${contenders} contenders — ${bad ? 'PROBLEM' : 'ok'}`);
  for (const [n, c] of [...byHolders].sort((a, b) => a[0] - b[0])) {
    console.log(`   ${String(c).padStart(6)} trials × ${n} holder${n === 1 ? '' : 's'}${n > 1 ? '   <<< MUTUAL EXCLUSION BROKEN' : ''}`);
  }
  for (const [why, c] of [...byRejection].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(c).padStart(6)} rejections: ${why}`);
  }
  if (strayTrials) console.log(`   ${String(strayTrials).padStart(6)} trials left stray files behind`);
  if (disownedTrials) console.log(`   ${String(disownedTrials).padStart(6)} trials where the on-disk lock belonged to NO holder`);
  console.log('');
}
process.exit(anyBad ? 1 : 0);
