/**
 * newproject.mjs — the `taskctl new-project "<idea>"` flow machinery (WP5 5b).
 *
 * The product is a SELF-CONTAINED orchestration workspace shaped like
 * taskctl-oss itself: idea → brainstorm → proposal → choose → scaffold (PRINT
 * ONLY) → await user scaffold → durable-phased backlog under the TARGET →
 * self-attach (TARGET gets its OWN taskctl.config.json, repoPath ".") → printed
 * next steps. Engine-driven steps go through the 5a adapter layer (injected
 * `runEngineStep`), so the whole state machine is testable under the fake
 * adapter with no live LLM.
 *
 * Confinement contract (New-I4): in THIS workspace, the flow writes ONLY to the
 * exclusively-owned `ai/newproject/<target-id>/` directory (the flow record +
 * transient artifacts). The PRODUCT (config, backlog, templates) lands wholly
 * under the TARGET. The TARGET's bytes are the USER's (print-only scaffold) plus
 * the backlog/config/templates the flow writes there.
 *
 * Locking + entry (plan v5): ONE stable per-flow lock `flow.lock` (NOT per-step)
 * is the unified mutex; the preflight is the UNIFIED ENTRY POINT for every
 * operation (normal step, --restart, archive recovery): acquire flow.lock FIRST
 * → read+validate the record → branch (a) resume / (b) no-record+strays recovery
 * sweep / (c) first-run. First-run emptiness validation NEVER precedes the
 * branch.
 *
 * This module imports nothing from cli.mjs/automation.mjs (they import THIS via a
 * deps bundle), so it is unit-testable in isolation.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RECORD_SCHEMA_VERSION = 1;
export const FLOW_STEPS = ['brainstorm', 'proposal', 'choose', 'scaffold_generate', 'await_scaffold', 'backlog', 'attach', 'done'];
const ENGINE_STEPS = new Set(['brainstorm', 'proposal', 'scaffold_generate', 'backlog']);
const OWNER_MARKER = '.taskctl-newproject-owner.json';
// A LIVE pid is authoritative regardless of age; age is consulted ONLY when the
// pid is dead/unverifiable. A generous threshold so a long engine step is safe.
const STALE_LOCK_AGE_MS = 6 * 60 * 60 * 1000; // 6h
// Bound on acquireFlowLock's re-derive recursion (see there): high enough that
// real contention resolves, low enough that a pathological flap reports instead
// of spinning forever.
const MAX_LOCK_ATTEMPTS = 25;
// DIAGNOSTIC ONLY — how long a takeover gate may exist before its holder is
// described as "interrupted" rather than "in flight". This threshold selects the
// wording of a refusal; it NEVER authorises removing anybody's gate. An age-based
// expiry that removes the gate cannot distinguish an abandoned holder from a SLOW
// one, and firing on a slow holder puts two takeovers in flight — a safety failure,
// which no liveness argument buys back (see acquireTakeoverGate).
const TAKEOVER_GATE_MAX_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Identity + namespace
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical resolved target path (realpath when the dir exists, else resolve). */
export function canonicalTargetPath(dir) {
  const resolved = path.resolve(dir);
  try { return fsSync.realpathSync(resolved); } catch { return resolved; }
}

/** Stable <target-id> = short hash of the canonical target path. Collision-free
 *  against real task slugs (which never start with this hex form). */
export function targetId(canonicalTarget) {
  return crypto.createHash('sha256').update(canonicalTarget).digest('hex').slice(0, 16);
}

/** The flow dir for a target id under THIS workspace's ai/newproject/. */
export function flowDirFor(workspaceRoot, tid) {
  return path.join(workspaceRoot, 'ai', 'newproject', tid);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Atomic record I/O
// ─────────────────────────────────────────────────────────────────────────────

function recordPath(flowDir) { return path.join(flowDir, 'record.json'); }
function lockPath(flowDir) { return path.join(flowDir, 'flow.lock'); }
/** The gate that serializes stale-lock takeovers (see acquireTakeoverGate). */
function takeoverGatePath(flowDir) { return path.join(flowDir, 'flow.lock.takeover'); }

/**
 * Read + JSON.parse + schema-validate the record (I-1). Distinguishes the three
 * outcomes the unified entry point depends on:
 *   - truly MISSING (ENOENT) → returns `null` (the only case that proceeds to the
 *     no-record recovery / first-run branches).
 *   - present but UNREADABLE (permission/IO error), UNPARSEABLE JSON, or
 *     SCHEMA/VERSION/STEP-invalid → throws a `TASKCTL_EXIT:`-prefixed Error so the
 *     caller HALTS with state intact (NEVER reclassified as a "stray" → archived).
 */
export async function readRecord(flowDir) {
  let raw;
  try {
    raw = await fs.readFile(recordPath(flowDir), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null; // truly missing → branch (b)/(c)
    throw new Error(`TASKCTL_EXIT:flow record ${recordPath(flowDir)} is unreadable (${e.code ?? e.message}); resolve it manually, then re-invoke.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`TASKCTL_EXIT:flow record ${recordPath(flowDir)} is corrupt (invalid JSON: ${e.message}); resolve it manually, then re-invoke.`);
  }
  const err = validateRecordShape(parsed);
  if (err) {
    throw new Error(`TASKCTL_EXIT:flow record ${recordPath(flowDir)} is invalid (${err}); resolve it manually, then re-invoke.`);
  }
  return parsed;
}

/**
 * Validate the persisted record's shape/version/step. Returns a human-readable
 * error string when invalid, or null when the record is structurally sound. Kept
 * intentionally small (strictNullChecks is OFF project-wide): it checks the fields
 * the entry-point dispatch relies on (I-1).
 */
export function validateRecordShape(rec) {
  if (rec == null || typeof rec !== 'object' || Array.isArray(rec)) return 'not a JSON object';
  if (rec.schemaVersion !== RECORD_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${JSON.stringify(rec.schemaVersion)} (expected ${RECORD_SCHEMA_VERSION})`;
  }
  if (typeof rec.canonicalTarget !== 'string' || rec.canonicalTarget === '') return 'missing canonicalTarget';
  if (typeof rec.idea !== 'string' || rec.idea === '') return 'missing idea';
  if (typeof rec.slug !== 'string' || rec.slug === '') return 'missing slug';
  if (!FLOW_STEPS.includes(rec.step)) return `unknown step ${JSON.stringify(rec.step)}`;
  if (rec.backlog != null && !Array.isArray(rec.backlog)) return 'backlog must be an array when present';
  return null;
}

/** Atomically (temp-sibling + rename) write the record. Durable enough for the
 *  flow: a crash leaves only the PRIOR valid record (rename is atomic). */
export async function writeRecord(flowDir, record) {
  const tmp = path.join(flowDir, `record.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const body = JSON.stringify(record, null, 2) + '\n';
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(body, 'utf8');
    try { await fh.sync(); } catch { /* fsync best-effort */ }
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, recordPath(flowDir));
}

/** First-run record creation with EXCLUSIVE wx (so two first-runs can't both
 *  create). Throws if the record already exists. */
export async function createRecordExclusive(flowDir, record) {
  const body = JSON.stringify(record, null, 2) + '\n';
  const fh = await fs.open(recordPath(flowDir), 'wx');
  try {
    await fh.writeFile(body, 'utf8');
    try { await fh.sync(); } catch { /* best-effort */ }
  } finally {
    await fh.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Flow lock — ONE stable per-flow lock (plan v5)
// ─────────────────────────────────────────────────────────────────────────────

/** Default liveness probe: process.kill(pid, 0) — true when the pid is alive
 *  (or alive-but-no-permission: EPERM still means it exists). */
function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/**
 * Classify the lock file at `p` for takeover purposes:
 *   'absent' — it vanished while we looked at it;
 *   'live'   — its pid is alive (authoritative at ANY age → never reclaimable);
 *   'young'  — dead/unverifiable pid but not yet aged out → do NOT reclaim;
 *   'stale'  — dead/unverifiable pid AND aged out → reclaimable.
 * Used BOTH for the initial verdict on flow.lock and for the re-verdict on the
 * file a takeover actually removed, so the two can never drift apart — a takeover
 * is only as safe as the weaker of those two checks.
 */
async function classifyLockFile(p, { pidAlive, now, staleMs }) {
  let body;
  try { body = JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { body = null; } // unreadable/corrupt/EMPTY → NEVER immediately stale (C1).
  if (body && pidAlive(body.pid)) return { state: 'live', body };
  // C1 — age the lock. A readable body's startedAt is authoritative; an
  // unreadable/corrupt/EMPTY body (e.g. a lock just published by open('wx') whose
  // owner has not yet written the body) is aged by the lock FILE's lstat mtime,
  // NEVER by Infinity. That way a contender in the publication window measures the
  // file as brand-new (mtime ≈ now) → below the stale threshold → backs off, so the
  // in-flight owner is never reclaimed and both processes cannot proceed.
  let ageMs;
  if (body?.startedAt) {
    ageMs = now - Date.parse(body.startedAt);
  } else {
    let mtimeMs;
    try { mtimeMs = (await fs.lstat(p)).mtimeMs; }
    catch { return { state: 'absent', body: null }; }
    ageMs = now - mtimeMs;
  }
  // Dead/unverifiable pid: eligible only if also aged-out. (NaN age — e.g. an
  // unparseable startedAt — is treated conservatively as not-yet-stale.)
  return Number.isFinite(ageMs) && ageMs >= staleMs ? { state: 'stale', body } : { state: 'young', body };
}

/**
 * Read the takeover gate for the REFUSAL MESSAGE only — its age and the pid that
 * wrote it. Nothing here authorises an action; see acquireTakeoverGate.
 * Same C1 shape as the lock itself: a gate published by open('wx') whose body is not
 * written yet has no startedAt, so it is aged by the FILE's mtime rather than being
 * reported as ageless. An age we cannot compute at all (missing/unparseable
 * startedAt AND no mtime) is reported as null so the caller says "in flight" rather
 * than inventing a number — including a startedAt in the FUTURE, which is finite but
 * negative and would otherwise read as "brand new" forever.
 * Returns null when the gate is no longer there.
 */
async function readTakeoverGate(gp, now) {
  let body = null;
  try { body = JSON.parse(await fs.readFile(gp, 'utf8')); } catch { /* absent, partial or corrupt */ }
  const startedAt = body?.startedAt ? Date.parse(body.startedAt) : NaN;
  if (Number.isFinite(startedAt)) return { ageMs: now - startedAt, pid: body.pid };
  let mtimeMs;
  try { mtimeMs = (await fs.lstat(gp)).mtimeMs; }
  catch { return null; }
  return { ageMs: now - mtimeMs, pid: body?.pid };
}

/**
 * Become the ONE caller allowed to reclaim this flow's stale lock — or discover that
 * someone else already is. Exclusion comes from `open('wx')` on a single fixed name.
 * Returns:
 *   'acquired'  — the gate is ours; `.token` identifies it, and the caller MUST pass
 *                 that token to releaseTakeoverGate when done;
 *   'in-flight' — another invocation holds the gate (.pid/.ageMs for the message);
 *   'retry'     — the gate was released between our EEXIST and our read; re-derive.
 *
 * A gate is created ONLY into a free name and removed ONLY by its own holder
 * (token-compared — see releaseTakeoverGate). Nothing here ever takes a gate away
 * from another caller, and that is the whole of the exclusion argument: from the
 * instant this `open('wx')` succeeds until this holder releases, no other `open('wx')`
 * can succeed (the name is occupied) and no other release can remove the file (the
 * token will not match). So at most one caller ever believes it holds the gate.
 *
 * Deliberately NOT age-expiring. A gate old enough to look abandoned is
 * indistinguishable on disk from one whose holder is merely SLOW, so removing it can
 * put a second takeover in flight alongside a live one — the exact double-acquire the
 * gate exists to prevent, re-entered through the gate rather than around it. There is
 * also no way to remove it safely even when the holder IS gone: removal frees the
 * name, and an entrant that wins the freed name races the remover's own successor.
 * A pid check does not rescue the expiry either — it swaps a slow-holder race for a
 * pid-REUSE wedge, and neither failure is one this can detect.
 *
 * The cost is stated rather than hidden: a holder killed between the `open('wx')` here
 * and its release leaks the gate, and every later takeover of THIS flow refuses until
 * the file is removed. That refusal names the file, an ordinary acquire against a free
 * or live lock never consults the gate at all, and the archive/recovery sweep clears
 * it. A refusal that says what to delete is recoverable; two takeovers in flight are
 * not.
 */
async function acquireTakeoverGate(flowDir, now) {
  const gp = takeoverGatePath(flowDir);
  const token = crypto.randomUUID();
  try {
    const fh = await fs.open(gp, 'wx');
    try {
      const gateBody = JSON.stringify({ token, pid: process.pid, startedAt: new Date(now).toISOString() }) + '\n';
      await fh.writeFile(gateBody, 'utf8');
    } finally { await fh.close(); }
    return { state: 'acquired', token };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const gate = await readTakeoverGate(gp, now);
  if (gate == null) return { state: 'retry' }; // it vanished while we looked — race again
  return { state: 'in-flight', pid: gate.pid, ageMs: gate.ageMs };
}

/**
 * Release the takeover gate — ONLY when the gate on disk is still the one we
 * published. Same compare-before-unlink rule as the lock's own release(): a blind
 * unlink here deletes whoever's gate happens to occupy the name, which would hand a
 * successor's critical section to a third caller.
 */
async function releaseTakeoverGate(flowDir, token) {
  try {
    const cur = JSON.parse(await fs.readFile(takeoverGatePath(flowDir), 'utf8'));
    if (cur && cur.token === token) await fs.unlink(takeoverGatePath(flowDir));
  } catch { /* gone, unreadable, or not ours — nothing safe to do */ }
}

/**
 * Put a lock file back on the public name, after lifting it off `flow.lock` and then
 * finding we must not keep it. Publishes ONLY into a FREE name — never over an
 * occupant:
 *   - `fs.link` re-publishes the very same inode and fails EEXIST when `flow.lock` is
 *     occupied again;
 *   - on a filesystem without hard links, re-publish the BYTES through `open('wx')`,
 *     which is exactly as conditional. A byte copy is the SAME lock to its owner:
 *     release() compares the token in the body, not the inode.
 * NEVER `fs.rename`: rename replaces unconditionally, so it would silently evict a
 * live lock published in the meantime. Losing a file we should not be holding is
 * cheap; evicting a live lock breaks the mutex — that is the side to fail on.
 * Returns 'linked' | 'copied' | 'occupied' | 'lost', for diagnosis only: the caller
 * re-derives from the filesystem either way.
 *
 * @param {object} [deps]
 * @param {(a:string,b:string)=>Promise<void>} [deps._link] test seam: stand in for
 *        fs.link to simulate a filesystem that has no hard links.
 */
export async function republishLiftedLock(claim, lp, deps = {}) {
  const link = deps._link ?? ((a, b) => fs.link(a, b));
  try {
    await link(claim, lp);
    return 'linked';
  } catch (e) {
    // EEXIST says only that SOMEBODY published — never that what we lifted was
    // stale. Either way the occupant stays: we do not get to evict it.
    if (e.code === 'EEXIST') return 'occupied';
  }
  let bytes;
  try { bytes = await fs.readFile(claim); }
  catch { return 'lost'; }
  let fh;
  try { fh = await fs.open(lp, 'wx'); }
  catch (e) { return e.code === 'EEXIST' ? 'occupied' : 'lost'; }
  try { await fh.writeFile(bytes); } finally { await fh.close(); }
  return 'copied';
}

/**
 * Acquire the single stable flow.lock. Body = { token, pid, startedAt }. Token
 * is the mutex authority; pid/startedAt are liveness diagnostics. On contention:
 *   - a LIVE-pid lock → throw "already running" (NEVER reclaimed, any age);
 *   - a stale lock (dead pid AND aged-out) → takeover, SERIALIZED behind the
 *     `flow.lock.takeover` gate: re-classify flow.lock under the gate, and only
 *     then rename it to `flow.lock.reclaim-<token>` → create the fresh lock →
 *     remove the claim file. A contender that finds the gate held stands down.
 * Returns the held lock handle { token, release() }.
 *
 * The invariant that makes this a mutex: `flow.lock` is never free while a LIVE lock
 * sits detached off to the side. The only step that detaches anything runs under the
 * gate and only after re-reading flow.lock there, so what it detaches is provably
 * stale — an entrant that wins the briefly-free name is then the sole legitimate
 * holder, and the reclaimer defers to it. (Given the takeover policy's own premise:
 * that a lock with a dead pid, aged past staleMs, has no live owner.)
 *
 * @param {string} flowDir
 * @param {object} [deps]
 * @param {(pid:number)=>boolean} [deps.pidAlive]  liveness probe (test seam)
 * @param {number} [deps.now]                       current time (test seam)
 * @param {number} [deps.staleMs]                   stale-age threshold
 * @param {()=>any} [deps._beforeBodyWrite]         test hook: run AFTER the
 *        exclusive open('wx') + BEFORE the body write, so a contender observes a
 *        zero-byte lock in the publication window (C1 race repro).
 * @param {()=>any} [deps._afterRenameClaim]        test hook: throw AFTER the
 *        reclaim rename + BEFORE the fresh-lock create, to leak a reclaim claim.
 * @param {()=>any} [deps._beforeReclaimRename]     test hook: run AFTER this
 *        caller has classified flow.lock as stale + BEFORE it renames it away, so
 *        a test can let a rival complete a whole takeover inside that gap (C2
 *        race repro — the classification is about a PATH another contender may
 *        have re-pointed at a fresh, live lock in the meantime).
 * @param {()=>any} [deps._insideAbsenceWindow]     test hook: run IMMEDIATELY after
 *        this caller's reclaim rename, i.e. while flow.lock is ABSENT because this
 *        caller lifted it — so a test can schedule a third contender inside that
 *        hole (C3 race repro).
 * @param {()=>any} [deps._insideTakeoverGate]      test hook: run INSIDE the takeover
 *        gate's critical section — after flow.lock has been re-classified there and
 *        BEFORE it is detached. Lets a test prove no rival can reclaim in that window,
 *        and drive the one interleaving that still reaches the restore path.
 * @param {(a:string,b:string)=>Promise<void>} [deps._link] test seam, forwarded to
 *        republishLiftedLock: stand in for fs.link to simulate a filesystem that has
 *        no hard links.
 */
export async function acquireFlowLock(flowDir, deps = {}, _attempt = 0) {
  // Every "the world moved under us" branch below re-derives by recursing. Each
  // recursion is a response to someone else making progress, so it terminates in
  // practice — but nothing structurally BOUNDS it, and an unbounded retry would
  // hang the CLI rather than report a problem. Cap it and surface a lock conflict.
  if (_attempt >= MAX_LOCK_ATTEMPTS) {
    throw new Error(`TASKCTL_LOCKED:could not settle the flow lock after ${MAX_LOCK_ATTEMPTS} attempts (sustained contention on ${lockPath(flowDir)})`);
  }
  const probe = {
    pidAlive: deps.pidAlive ?? defaultPidAlive,
    now: deps.now ?? Date.now(),
    staleMs: deps.staleMs ?? STALE_LOCK_AGE_MS,
  };
  const { now } = probe;
  const lp = lockPath(flowDir);
  const token = crypto.randomUUID();
  const body = JSON.stringify({ token, pid: process.pid, startedAt: new Date(now).toISOString() }, null, 2) + '\n';

  // First attempt: exclusive create. The open('wx') publishes the file; the body
  // write happens immediately after. A contender that reads in this window sees a
  // zero-byte file — C1: that is NOT treated as immediately stale (see below).
  try {
    const fh = await fs.open(lp, 'wx');
    try {
      if (deps._beforeBodyWrite) await deps._beforeBodyWrite(); // C1 repro seam
      await fh.writeFile(body, 'utf8');
    } finally { await fh.close(); }
    return makeHeldLock(flowDir, token);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  // The lock exists. Read it and decide live vs stale.
  const found = await classifyLockFile(lp, probe);
  if (found.state === 'absent') return acquireFlowLock(flowDir, deps, _attempt + 1); // lock vanished — retry from scratch
  if (found.state === 'live') {
    const since = found.body.startedAt ?? 'unknown';
    throw new Error(`TASKCTL_LOCKED:a flow for this target is already running (pid ${found.body.pid}, since ${since})`);
  }
  if (found.state !== 'stale') {
    // Not yet old enough to reclaim — conservative: surface "already running".
    throw new Error(`TASKCTL_LOCKED:a flow for this target appears to be running (pid ${found.body?.pid ?? '?'}, since ${found.body?.startedAt ?? '?'})`);
  }

  // ── Stale takeover: decide FIRST, detach after, under exclusion ─────────────
  // A filesystem gives exactly two ways to publish a name: `rename`, which replaces
  // whatever is there UNCONDITIONALLY, and `open('wx')`/`link`, which publish only
  // into a FREE name. Neither is conditional on WHICH file currently occupies the
  // name, so the identity question a takeover turns on — "is flow.lock still the
  // stale file I judged?" — cannot be fused into the act that acts on it. It has to
  // be protected by mutual exclusion instead. Hence a gate: one takeover in flight
  // per flow dir, so the verdict cannot go out of date before it is used.
  if (deps._beforeReclaimRename) await deps._beforeReclaimRename(); // C2 repro seam
  const gate = await acquireTakeoverGate(flowDir, now);
  if (gate.state === 'retry') return acquireFlowLock(flowDir, deps, _attempt + 1);
  if (gate.state === 'in-flight') {
    // Someone else is already reclaiming this exact lock, and TASKCTL_LOCKED is the
    // right answer whichever way their reclaim ends: they either publish a live lock,
    // or stand down precisely BECAUSE flow.lock turned out live/young. Report rather
    // than retry into them. Age only picks the WORDING (see TAKEOVER_GATE_MAX_MS): a
    // gate older than the gated section could ever run was probably left by a killed
    // reclaimer, and since nothing removes a gate but its own holder, say which file
    // to delete instead of stalling on a timer that could fire on a live holder.
    throw new Error(gate.ageMs >= TAKEOVER_GATE_MAX_MS
      ? `TASKCTL_LOCKED:a takeover of the stale flow lock ${lp} has been in flight since ${new Date(now - gate.ageMs).toISOString()} (pid ${gate.pid ?? '?'}); if no taskctl is running for this flow it was interrupted — remove ${takeoverGatePath(flowDir)} to continue`
      : `TASKCTL_LOCKED:another invocation (pid ${gate.pid ?? '?'}) is reclaiming the stale flow lock ${lp}; re-run in a moment`);
  }
  let outcome;
  try {
    outcome = await reclaimUnderGate(flowDir, deps, probe, token, body);
  } finally {
    // Always before re-deriving: the recursion contends for this very gate. Identity-
    // compared, never blind: if ours was swept and a successor published theirs, the
    // gate on the name is the successor's critical section, not ours to end.
    await releaseTakeoverGate(flowDir, gate.token);
  }
  if (outcome === 'held') return makeHeldLock(flowDir, token);
  return acquireFlowLock(flowDir, deps, _attempt + 1); // re-derive against what is ACTUALLY there
}

/**
 * The reclaim itself, running under the takeover gate. Returns 'held' when this
 * caller published the fresh lock, or 'redo' when it must re-derive from scratch.
 *
 * The ORDERING is the whole point. flow.lock is re-classified here, under exclusion,
 * BEFORE anything is detached from it. The previous protocol renamed first and
 * re-classified afterwards, which cannot be repaired by any later decision: once the
 * victim is off the public name that name is free, and new entrants consult only that
 * name, so a lock removed and then found live is already racing entrants no matter
 * what its remover concludes privately.
 */
async function reclaimUnderGate(flowDir, deps, probe, token, body) {
  const lp = lockPath(flowDir);
  const still = await classifyLockFile(lp, probe);
  // live / young / absent: nothing was detached, so there is nothing to put back and
  // nothing for an entrant to walk into. Re-derive.
  if (still.state !== 'stale') return 'redo';
  if (deps._insideTakeoverGate) await deps._insideTakeoverGate(); // test hook: inside the critical section
  // This verdict cannot go stale before the rename below uses it. The only writers of
  // flow.lock are (a) entrants, whose open('wx') fails while the file exists, (b)
  // other takeovers, excluded by the gate, and (c) the holder's own token-guarded
  // release() — and the file just classified has, by that verdict, no live owner left
  // to call it. So the file the rename detaches IS the file classified above.
  const claim = path.join(flowDir, `flow.lock.reclaim-${token}`);
  try {
    await fs.rename(lp, claim);
  } catch (e) {
    if (e.code === 'ENOENT') return 'redo'; // vanished under us after all
    throw e;
  }
  if (deps._insideAbsenceWindow) await deps._insideAbsenceWindow(); // C3 repro seam
  // Belt and braces on the file we now exclusively possess. Under the gate this can
  // only disagree with the verdict above if the liveness probe LIED about the previous
  // holder — it was alive, released, and an entrant published into the freed name
  // before our rename ran. That is the takeover POLICY's premise failing, not a race
  // in the protocol; one extra read is cheap insurance against it.
  const taken = await classifyLockFile(claim, probe);
  if (taken.state !== 'stale') {
    // We detached a lock we had no right to detach. Put it back where it can be put
    // back safely — never over an occupant (see republishLiftedLock).
    await republishLiftedLock(claim, lp, deps);
    // Drops OUR name for it: after 'linked' the inode lives on at flow.lock, after
    // 'copied' an identical body does. After 'occupied'/'lost' this destroys a file
    // whose owner may still believe it holds — nothing safe can be done about that
    // here, and its release() is token-guarded so it cannot damage the occupant.
    try { await fs.unlink(claim); } catch { /* already gone */ }
    return 'redo';
  }

  // Won the gate AND verified what we are replacing. Publish the fresh lock, then
  // remove the claim file.
  if (deps._afterRenameClaim) await deps._afterRenameClaim(); // test: leak the claim
  let fh;
  try {
    fh = await fs.open(lp, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Our own rename left flow.lock free for an instant and an ordinary acquirer
    // walked in on the first-attempt wx path. IT holds the mutex; we do not. Drop the
    // (verified stale) claim and re-derive, rather than throwing a raw EEXIST at a
    // caller who is entitled to an "already running" answer.
    try { await fs.unlink(claim); } catch { /* claim already gone */ }
    return 'redo';
  }
  try { await fh.writeFile(body, 'utf8'); } finally { await fh.close(); }
  try { await fs.unlink(claim); } catch { /* claim already gone */ }
  return 'held';
}

function makeHeldLock(flowDir, token) {
  return {
    token,
    /** Release ONLY when the on-disk lock still carries OUR token (compare-before
     *  -unlink — never blind-unlink a lock we may no longer own). */
    async release() {
      const lp = lockPath(flowDir);
      try {
        const cur = JSON.parse(await fs.readFile(lp, 'utf8'));
        if (cur && cur.token === token) await fs.unlink(lp);
      } catch { /* lock gone or unreadable — nothing safe to do */ }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Archive protocol + crash recovery (under the held lock)
// ─────────────────────────────────────────────────────────────────────────────

const isArchiveDir = (name) => /^archive-/.test(name);
const isLockFile = (name) => name === 'flow.lock';

/** List direct children of the flow dir eligible to be archived/swept: every
 *  entry EXCEPT existing `archive-` dirs and the live flow.lock. (A stray
 *  flow.lock.reclaim-* IS swept, and so is a stray flow.lock.takeover gate: a sweep
 *  runs under a LIVE held lock, under which no takeover can be in flight — any
 *  contender re-classifying flow.lock finds it live and stands down before detaching
 *  anything — so yanking a gate here cannot break exclusion.) */
async function sweepableChildren(flowDir) {
  let entries;
  try { entries = await fs.readdir(flowDir); } catch { return []; }
  return entries.filter((n) => !isArchiveDir(n) && !isLockFile(n));
}

/**
 * Reserve a UNIQUE, never-pre-existing archive dir via EXCLUSIVE mkdir (no
 * `recursive` — so an existing same-ms name does NOT silently reuse it). The base
 * tag is the ISO timestamp; on collision (two --restarts within the same ms, or a
 * leftover archive) a `-NN` counter is appended until an exclusive create wins.
 * Returns the full unique tag (so `archive-<tag>` names the dir on disk).
 * @returns {Promise<{ tag: string, archiveDir: string }>}
 */
async function reserveArchiveDir(flowDir, now) {
  const base = new Date(now).toISOString().replace(/[:.]/g, '-');
  for (let n = 0; n < 10000; n++) {
    const tag = n === 0 ? base : `${base}-${n}`;
    const archiveDir = path.join(flowDir, `archive-${tag}`);
    try {
      await fs.mkdir(archiveDir); // EXCLUSIVE: throws EEXIST if it already exists
      return { tag, archiveDir };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // a real error (perms, missing parent) → surface
      // else: name taken → try the next counter (fail-safe, never reuse)
    }
  }
  throw new Error(`archiveFlowDir: could not reserve a unique archive dir under ${flowDir}`);
}

/**
 * Archive the flow dir CONTENT into a fresh, UNIQUE `archive-<tag>/` (the
 * --restart path). Multi-step + recoverable: reserve a unique archive (exclusive
 * mkdir + counter) → move each child (atomic rename) excluding `archive-` dirs and
 * flow.lock → caller writes the fresh record LAST. Returns the unique archive tag.
 */
export async function archiveFlowDir(flowDir, { now = Date.now() } = {}) {
  const { tag: ts, archiveDir } = await reserveArchiveDir(flowDir, now);
  for (const child of await sweepableChildren(flowDir)) {
    await fs.rename(path.join(flowDir, child), path.join(archiveDir, child));
  }
  return ts;
}

/**
 * Idempotent crash-recovery sweep (branch (b)): NO record but strays/archive
 * present. Move remaining strays into the NEWEST existing archive-<ts>/ (the one
 * the interrupted restart created), creating one if somehow none exists. Safe to
 * re-run (already-moved children are simply absent).
 * @returns {Promise<string>} the archive ts the sweep targeted.
 */
export async function recoverInterruptedArchive(flowDir, { now = Date.now() } = {}) {
  let entries;
  try { entries = await fs.readdir(flowDir); } catch { entries = []; }
  const archives = entries.filter(isArchiveDir).sort();
  const targetArchive = archives.length ? archives[archives.length - 1] : `archive-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  const archiveDir = path.join(flowDir, targetArchive);
  await fs.mkdir(archiveDir, { recursive: true });
  for (const child of await sweepableChildren(flowDir)) {
    await fs.rename(path.join(flowDir, child), path.join(archiveDir, child));
  }
  return targetArchive.replace(/^archive-/, '');
}

/** Are there any strays or archive dirs in the flow dir (besides the lock)? */
async function hasStraysOrArchive(flowDir) {
  let entries;
  try { entries = await fs.readdir(flowDir); } catch { return false; }
  return entries.some((n) => !isLockFile(n));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Backlog publish — durable per-item phases + in-dir ownership marker
// ─────────────────────────────────────────────────────────────────────────────

/** Stable manifest hash over the to-be-written task content (context.md +
 *  state.json bytes) — does NOT include the marker (avoids self-reference). */
export function manifestHash(contextMd, stateJson) {
  return crypto.createHash('sha256').update(contextMd, 'utf8').update('\0').update(stateJson, 'utf8').digest('hex');
}

/**
 * Classify the FINAL task dir against the expected ownership. ONLY three classes —
 * adoption is the sole non-error outcome; ANYTHING that is not a byte-exact, fully
 * marker-and-content-matched copy of THIS flow's output HALTS (never overwrites,
 * never deletes). (C2: the data-loss `ours-stale` class was removed — inferring
 * "safe to replace" from filename shape destroyed user edits to a generated
 * context.md on --restart.)
 *   'absent'  — no dir.
 *   'adopt'   — marker match (targetId+item+manifestHash) AND exact tree (exactly
 *               context.md, state.json, empty runs/, marker) AND on-disk
 *               content-hash match → the crash-between-rename-and-record case. The
 *               only outcome the caller treats as "already published".
 *   'foreign' — EVERYTHING else: a different/absent marker, an unexpected tree
 *               (extra/missing file, non-empty runs/), OR a hash difference (the
 *               marker's hash ≠ expected, or the on-disk bytes no longer hash to
 *               the marker — i.e. a user edited a generated file). The caller
 *               HALTS with a collision/user-modification error naming the dir.
 */
async function classifyExistingTaskDir(finalDir, expect) {
  let entries;
  try { entries = (await fs.readdir(finalDir)).sort(); } catch { return 'absent'; }
  // Exact tree first: exactly context.md, state.json, runs/ (empty), marker. A
  // non-exact tree is ALWAYS foreign (we never delete a dir a user may have added
  // files to), regardless of the marker.
  const expectedNames = ['context.md', 'runs', 'state.json', OWNER_MARKER].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedNames)) return 'foreign';
  try {
    const runsStat = await fs.stat(path.join(finalDir, 'runs'));
    const runsEntries = await fs.readdir(path.join(finalDir, 'runs'));
    if (!runsStat.isDirectory() || runsEntries.length !== 0) return 'foreign';
  } catch { return 'foreign'; }
  // Marker match: targetId+item identify OUR flow's output for this item.
  let marker;
  try { marker = JSON.parse(await fs.readFile(path.join(finalDir, OWNER_MARKER), 'utf8')); } catch { return 'foreign'; }
  if (marker.targetId !== expect.targetId || marker.item !== expect.item) return 'foreign';
  // Our marker + exact tree. ADOPT ONLY on a full marker + content match: the
  // marker's hash must equal the expected hash AND the on-disk bytes must still
  // hash to it. ANY difference (a regenerated hash from before a --restart, or a
  // user edit to context.md/state.json that no longer matches) is FOREIGN → halt,
  // never delete.
  if (marker.manifestHash !== expect.manifestHash) return 'foreign';
  let ctx, st;
  try {
    ctx = await fs.readFile(path.join(finalDir, 'context.md'), 'utf8');
    st = await fs.readFile(path.join(finalDir, 'state.json'), 'utf8');
  } catch { return 'foreign'; }
  if (manifestHash(ctx, st) !== expect.manifestHash) return 'foreign';
  return 'adopt';
}

/** The single HALT error for a final task dir that is not a byte-exact adoption of
 *  this flow's output — a collision or a user modification. Names the dir and
 *  states the manual resolution; NEVER deleted (C2). Keeps the legacy
 *  "not owned by this flow" phrase so callers/tests can match it. */
function collisionError(finalDir) {
  return new Error(
    `TASKCTL_EXIT:backlog task dir ${finalDir} exists and is not owned by this flow ` +
    `(a name collision, or you edited a generated context.md/state.json). ` +
    `taskctl will NOT overwrite or delete it — move or remove the directory deliberately, then re-invoke.`,
  );
}

/** Build the flow/item-qualified temp dir name `.tmp-<targetId8>-<flowToken8>-<slug>`
 *  (C3): provably flow-owned, so cleanup never touches an unrelated user `.tmp-*`
 *  dir. `flowToken` falls back to a stable per-target token when no lock token is
 *  threaded (still target-qualified). */
function tempDirName(tid, flowToken, slug) {
  const t8 = String(tid).replace(/[^0-9a-z]/gi, '').slice(0, 8) || '00000000';
  const k8 = String(flowToken ?? 'noLockTok').replace(/[^0-9a-z]/gi, '').slice(0, 8) || '00000000';
  return `.tmp-${t8}-${k8}-${slug}`;
}

/**
 * Publish ONE backlog task durably (planned → publishing → published).
 *
 * Content is produced LAZILY via `makeContent()` (returns `{contextMd,
 * stateJson}`) so the recorded `manifestHash` is ALWAYS the hash of the bytes
 * actually written — even though seedContext embeds a timestamp (so the bytes
 * differ run-to-run). On a resume that ADOPTS, content is NOT regenerated: the
 * already-recorded hash governs (the freshly-timestamped content would not match
 * the on-disk dir). Steps:
 *   1. produce content → record INTENT (phase 'publishing' + manifestHash of
 *      THOSE bytes) BEFORE the rename.
 *   2. build in a flow-qualified TEMP sibling (.tmp-<targetId8>-<flowToken8>-<slug>),
 *      write the in-dir marker BEFORE the rename so it travels with the dir, then
 *      atomic-rename into the FINAL dir.
 *   3. record 'published'.
 * On resume: a published item is skipped; a 'publishing' item with a recorded
 * hash adopts a matching final dir (marker+exact-tree+content) or re-publishes
 * when absent; a non-matching final dir → HALT (collision/user-modification —
 * never deleted; C2).
 *
 * @param {object} p
 * @param {string} p.tasksDir       <TARGET>/ai/tasks
 * @param {object} p.item           record.backlog[i] = { slug, phase, manifestHash }
 * @param {string} p.targetId
 * @param {string} [p.flowToken]    the held flow.lock token — qualifies the temp
 *                                  dir name so it is provably flow-owned (C3).
 * @param {() => Promise<{contextMd:string, stateJson:string}>|{contextMd,stateJson}} p.makeContent
 * @param {() => Promise<void>} p.persistRecord  atomically persist record.json
 * @param {() => any} [p._afterRename]  test hook: throw AFTER rename + BEFORE 'published'
 */
export async function publishBacklogItem({ tasksDir, item, targetId: tid, flowToken, makeContent, persistRecord, _afterRename }) {
  const finalDir = path.join(tasksDir, item.slug);

  if (item.phase === 'published') return; // idempotent skip

  // Resume adoption: a 'publishing' item with an already-recorded hash → try to
  // adopt the on-disk dir WITHOUT regenerating content (fresh timestamp ≠ disk).
  // ANY non-adopt, non-absent classification HALTS — we NEVER delete (C2).
  if (item.phase === 'publishing' && item.manifestHash) {
    const klass = await classifyExistingTaskDir(finalDir, { targetId: tid, item: item.slug, manifestHash: item.manifestHash });
    if (klass === 'adopt') { item.phase = 'published'; await persistRecord(); return; }
    if (klass === 'foreign') throw collisionError(finalDir);
    // absent → fall through to (re)publish with fresh content
  }

  // Produce the content NOW; the hash is computed over exactly these bytes.
  const { contextMd, stateJson } = await makeContent();
  const hash = manifestHash(contextMd, stateJson);

  // A FINAL dir that exists but is not a byte-exact adoption of OUR output is a
  // collision or a user modification → HALT, naming the dir. We never overwrite
  // and never delete (C2: the old `ours-stale` replace path destroyed user edits).
  const klass = await classifyExistingTaskDir(finalDir, { targetId: tid, item: item.slug, manifestHash: hash });
  if (klass === 'foreign') throw collisionError(finalDir);
  if (klass === 'adopt') { item.phase = 'published'; item.manifestHash = hash; await persistRecord(); return; }

  // Record intent (phase 'publishing' + the hash of the bytes we will write).
  item.phase = 'publishing';
  item.manifestHash = hash;
  await persistRecord();

  // C3: the temp sibling is FLOW-QUALIFIED. Clean only abandoned temps whose
  // in-dir ownership marker matches THIS flow+item (an unrelated user `.tmp-*`
  // dir — even `.tmp-<slug>` — is never touched), then build a fresh one.
  await cleanOwnedTempDirs(tasksDir, tid, item.slug);
  const tmpDir = path.join(tasksDir, tempDirName(tid, flowToken, item.slug));
  await fs.rm(tmpDir, { recursive: true, force: true }); // our own exact-named leftover (marker-owned)
  await fs.mkdir(path.join(tmpDir, 'runs'), { recursive: true });
  // Marker FIRST so even a partially-built temp is identifiable as flow-owned
  // (so cleanup/adoption can reason about it), and it travels with the rename.
  await fs.writeFile(
    path.join(tmpDir, OWNER_MARKER),
    JSON.stringify({ targetId: tid, item: item.slug, manifestHash: hash }, null, 2) + '\n',
    'utf8',
  );
  await fs.writeFile(path.join(tmpDir, 'context.md'), contextMd, 'utf8');
  await fs.writeFile(path.join(tmpDir, 'state.json'), stateJson, 'utf8');

  if (_afterRename) {
    await fs.rename(tmpDir, finalDir); // rename FIRST, then throw before 'published'
    await _afterRename();
    return;
  }
  await fs.rename(tmpDir, finalDir);
  item.phase = 'published';
  await persistRecord();
}

/**
 * Remove abandoned `.tmp-*` temp dirs in `tasksDir` that are OWNED by THIS
 * flow+item — identified by the in-dir OWNER_MARKER ({targetId, item}), NOT by
 * the name alone (C3: an unrelated user `.tmp-<slug>` dir, or another flow's
 * temp, is PRESERVED). A dir without a matching marker is left untouched.
 */
async function cleanOwnedTempDirs(tasksDir, tid, slug) {
  let entries;
  try { entries = await fs.readdir(tasksDir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith('.tmp-')) continue;
    const dir = path.join(tasksDir, name);
    let marker;
    try {
      const st = await fs.lstat(dir);
      if (!st.isDirectory()) continue; // not a temp dir (e.g. a stray file)
      marker = JSON.parse(await fs.readFile(path.join(dir, OWNER_MARKER), 'utf8'));
    } catch {
      continue; // no readable ownership marker → NOT ours → preserve (C3)
    }
    if (marker && marker.targetId === tid && marker.item === slug) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Slug helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic kebab slugify → a single safe path segment (lowercase). */
export function slugify(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'project';
}

/** Deterministic backlog slug: <project>-NN-<short> (NN zero-padded ordinal). */
export function backlogSlug(projectSlug, ordinal, short) {
  const nn = String(ordinal).padStart(2, '0');
  return `${projectSlug}-${nn}-${slugify(short)}`;
}

export { ENGINE_STEPS, OWNER_MARKER, classifyExistingTaskDir, hasStraysOrArchive };
