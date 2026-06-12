/**
 * WP5 Stage 5a — engine adapter abstraction tests.
 *
 * Proves the adapter layer (engines.mjs) is a BYTE-FOR-BYTE refactor of the
 * pre-5a launch-string + spawn-argv behavior for claude/codex/opus at every
 * call-site, that the registry/validation/unknown-engine contract holds, that
 * the per-spawn output sessions behave correctly, and that the ONE deliberate
 * behavior change (codex spawn stdin 'inherit'→'ignore') is exactly as designed.
 *
 * The golden launch strings + argv below are the captured output of the
 * UNMODIFIED pre-5a code (buildLaunchCommand in cli.mjs + the spawnAI argv ladder
 * in automation.mjs). Asserting the adapters reproduce them is the parity proof
 * that complements the 161 baseline (config-2b/engine-wiring-2b printed-launch
 * assertions, which run THROUGH the new adapters and stay green).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getEngine,
  registerEngine,
  registeredEngineNames,
  assertEngineRegistered,
  UnknownEngineError,
  extractMarkdown,
  _unregisterEngineForTest,
} from '../engines.mjs';
import { makeFakeEngine } from '../engines-fake.mjs';
import { buildLaunchCommand, parseEngine, otherRoleEngine } from '../cli.mjs';
import { cmdDo } from '../automation.mjs';
import { normalizeRuntimeConfig } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Shared fixtures (match the pre-5a probe inputs exactly) ─────────────────
const O = 'S:/Vibe/taskctl-oss';
const REPO = '/repo';
const TASKDIR = '/repo/ai/tasks/CP-1';
const PLAN_PROMPT = `${O}/ai/tasks/CP-1/.prompt-plan.md`;
const REVIEW_PROMPT_FILE = `${O}/ai/tasks/CP-1/.prompt-review-final.md`;
const REVIEW_PROMPT_CMD = `Read ${O}/ai/tasks/CP-1/.prompt-review-final.md and execute the review`;

// Helper: build the spawn argv the way spawnAI / call-sites do.
function spawnFor(engine, { interactive = false, cwd = REPO, promptFile = PLAN_PROMPT, reasoningEffort = 'high', appendSystemPrompt } = {}) {
  return getEngine(engine).buildSpawn({ promptFile, orchRoot: O, repoPath: REPO, cwd, reasoningEffort, appendSystemPrompt, interactive });
}

// ───────────────────────────────────────────────────────────────────────────
//  1. ARGV-PARITY MATRIX — launch strings (buildLaunchCommand path)
// ───────────────────────────────────────────────────────────────────────────

test('parity launch: claude plan form === pre-5a literal', () => {
  const cmd = buildLaunchCommand('claude', { repoPath: REPO, reasoningEffort: 'high', orchestrationDir: O });
  assert.equal(cmd, `claude --add-dir "${O}"`);
});

test('parity launch: codex plan (full-auto) form === pre-5a literal', () => {
  const cmd = buildLaunchCommand('codex', { repoPath: REPO, cwd: REPO, reasoningEffort: 'high' });
  assert.equal(cmd, 'codex --full-auto -s danger-full-access -c model_reasoning_effort=high -C "/repo"');
});

test('parity launch: codex review one-shot form (skip-git-repo-check + quoted prompt) === pre-5a literal', () => {
  const cmd = buildLaunchCommand('codex', { repoPath: REPO, cwd: TASKDIR, skipGitRepoCheck: true, reasoningEffort: 'high', prompt: REVIEW_PROMPT_CMD });
  assert.equal(
    cmd,
    `codex exec -s danger-full-access --skip-git-repo-check -c model_reasoning_effort=high -C "${TASKDIR}" "${REVIEW_PROMPT_CMD}"`,
  );
});

test('parity launch: codex honors explicit reasoningEffort and defaults to high', () => {
  assert.match(buildLaunchCommand('codex', { repoPath: REPO, cwd: REPO, reasoningEffort: 'medium' }), /model_reasoning_effort=medium/);
  assert.match(buildLaunchCommand('codex', { repoPath: REPO, cwd: REPO }), /model_reasoning_effort=high/);
});

test('parity launch: opus launch is CLAUDE-shaped with NO --model flag (fact 1)', () => {
  const cmd = buildLaunchCommand('opus', { repoPath: REPO, reasoningEffort: 'high', orchestrationDir: O });
  assert.equal(cmd, `claude --add-dir "${O}"`);
  assert.equal(/--model/.test(cmd), false, 'opus must NOT emit a --model flag');
  assert.equal(/codex/.test(cmd), false);
});

// ───────────────────────────────────────────────────────────────────────────
//  1b. ARGV-PARITY MATRIX — spawn argv (automation.mjs spawnAI path)
// ───────────────────────────────────────────────────────────────────────────

test('parity spawn: claude piped argv === pre-5a argv', () => {
  const { cmd, args } = spawnFor('claude');
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, [
    '-p',
    `"Read ${PLAN_PROMPT} and follow the instructions"`,
    '--verbose', '--output-format', 'stream-json',
    '--add-dir', `"${O}"`,
  ]);
});

test('parity spawn: claude interactive (plan-cc) argv === pre-5a argv', () => {
  const { cmd, args } = spawnFor('claude', { interactive: true });
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, [
    `"Read ${PLAN_PROMPT} and follow the instructions"`,
    '--add-dir', `"${O}"`,
  ]);
});

test('parity spawn: claude --append-system-prompt (--no-brainstorm) escaping === pre-5a', () => {
  const { args } = spawnFor('claude', { appendSystemPrompt: 'CRITICAL "RULE": skip' });
  // the payload is double-quoted and inner quotes backslash-escaped.
  assert.deepEqual(args.slice(-2), ['--append-system-prompt', '"CRITICAL \\"RULE\\": skip"']);
});

test('parity spawn: codex plan piped argv === pre-5a argv (no skip-git-repo-check when cwd===repo)', () => {
  const { cmd, args } = spawnFor('codex', { cwd: REPO });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, [
    'exec',
    '-s', 'danger-full-access',
    '-c', 'model_reasoning_effort=high',
    '-C', '"/repo"',
    `"Read ${PLAN_PROMPT} and follow the instructions"`,
  ]);
});

test('parity spawn: codex review piped argv (cwd=taskDir → --skip-git-repo-check) === pre-5a argv', () => {
  const { cmd, args } = spawnFor('codex', { cwd: TASKDIR, promptFile: REVIEW_PROMPT_FILE });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, [
    'exec',
    '-s', 'danger-full-access',
    '-c', 'model_reasoning_effort=high',
    '--skip-git-repo-check',
    '-C', `"${TASKDIR}"`,
    `"Read ${REVIEW_PROMPT_FILE} and follow the instructions"`,
  ]);
});

test('parity spawn: opus piped argv is claude-shaped (fact 1) === pre-5a argv', () => {
  const { cmd, args } = spawnFor('opus');
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, [
    '-p',
    `"Read ${PLAN_PROMPT} and follow the instructions"`,
    '--verbose', '--output-format', 'stream-json',
    '--add-dir', `"${O}"`,
  ]);
  assert.equal(args.includes('--model'), false, 'opus spawn must NOT include --model');
});

// ───────────────────────────────────────────────────────────────────────────
//  2. SPAWN-OPTIONS FIX (documented; NOT byte-parity) — codex stdin 'ignore'
// ───────────────────────────────────────────────────────────────────────────

test('fix: codex buildSpawn stdio[0] === "ignore" (the deliberate stdin fix)', () => {
  const { spawnOptions } = spawnFor('codex', { cwd: REPO });
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
});

test('fix: claude buildSpawn stdio[0] stays "inherit" (unchanged)', () => {
  const { spawnOptions } = spawnFor('claude');
  assert.deepEqual(spawnOptions.stdio, ['inherit', 'pipe', 'pipe']);
});

test('fix: opus buildSpawn stdio[0] stays "inherit" (claude-shaped, fact 4)', () => {
  const { spawnOptions } = spawnFor('opus');
  assert.deepEqual(spawnOptions.stdio, ['inherit', 'pipe', 'pipe']);
});

test('fix: interactive mode inherits all three streams (both engines)', () => {
  assert.equal(spawnFor('claude', { interactive: true }).spawnOptions.stdio, 'inherit');
  assert.equal(spawnFor('codex', { interactive: true }).spawnOptions.stdio, 'inherit');
});

test('fix: a codex-shaped spawn (stdin ignored) does not hang on closed stdin', async () => {
  // Simulate the codex stdin policy on a tiny node program that would otherwise
  // hang reading stdin. With stdio[0]='ignore', stdin is /dev/null → immediate
  // EOF, so the process exits and we never time out.
  const prog = 'let n=0; process.stdin.on("data",()=>{n++}); process.stdin.on("end",()=>{process.exit(0)}); process.stdin.resume();';
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', prog], { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('hung on closed stdin')); }, 4000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', reject);
  });
  assert.equal(exit, 0);
});

// ───────────────────────────────────────────────────────────────────────────
//  3. PER-SPAWN OUTPUT SESSIONS
// ───────────────────────────────────────────────────────────────────────────

test('session: claude line-buffers across a chunk split mid-line + flushes a final unterminated event', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const s = getEngine('claude').createOutputSession();
    // One JSON event split across two chunks, then a SECOND event with NO
    // trailing newline (the unterminated final event the pre-5a code dropped).
    const evt1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'HELLO' }] } });
    const evt2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'TAIL' }] } });
    s.onChunk(evt1.slice(0, 10));         // first half of evt1, no newline
    s.onChunk(evt1.slice(10) + '\n');     // rest of evt1 + newline → flush evt1
    s.onChunk(evt2);                      // evt2, NO trailing newline (held in buffer)
    const acc = s.onClose();              // must flush the final unterminated evt2
    assert.equal(acc, '', 'claude session returns empty accumulator (no artifact capture)');
  } finally {
    console.log = orig;
  }
  const joined = logs.join('\n');
  assert.match(joined, /HELLO/, 'first event (split across chunks) formatted');
  assert.match(joined, /TAIL/, 'final UNTERMINATED event flushed on close');
});

test('session: codex accumulates raw text across chunks and onClose returns the full text', () => {
  const origWrite = process.stdout.write;
  process.stdout.write = () => true; // silence the raw tee for the test
  try {
    const s = getEngine('codex').createOutputSession();
    s.onChunk('# Review\n');
    s.onChunk('part-A ');
    s.onChunk('part-B');
    const acc = s.onClose();
    assert.equal(acc, '# Review\npart-A part-B');
  } finally {
    process.stdout.write = origWrite;
  }
});

test('session: opus uses the codex-style raw-tee accumulator, NOT the claude parser (fact 2)', () => {
  const origWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const s = getEngine('opus').createOutputSession();
    // Feed text that is NOT valid stream-json. A claude parser would route it to
    // stderr; the raw-tee accumulator just collects it.
    s.onChunk('plain text not json\n');
    const acc = s.onClose();
    assert.equal(acc, 'plain text not json\n', 'opus accumulates raw (codex-style), proving it is not the claude parser');
  } finally {
    process.stdout.write = origWrite;
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  4. ARTIFACT CAPTURE (capability-driven)
// ───────────────────────────────────────────────────────────────────────────

test('capture: codex captureArtifact extracts fenced markdown and writes it; returns the path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eng-cap-'));
  try {
    const target = path.join(dir, 'review.md');
    const captured = 'noise\n```md\n# Review\nLGTM\n```\nmore noise';
    const written = await getEngine('codex').captureArtifact(captured, target);
    assert.equal(written, target);
    assert.equal(await fs.readFile(target, 'utf8'), '# Review\nLGTM');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('capture: claude captureArtifact returns null and writes nothing', async () => {
  assert.equal(await getEngine('claude').captureArtifact('# Review\nx', '/tmp/should-not-exist-claude.md'), null);
});

test('capture: opus captureArtifact returns null (fact 3 — opus captures nothing)', async () => {
  assert.equal(await getEngine('opus').captureArtifact('# Review\nx', '/tmp/should-not-exist-opus.md'), null);
});

test('capture: codex captureArtifact with no target or empty capture returns null', async () => {
  assert.equal(await getEngine('codex').captureArtifact('# Review\nx', undefined), null);
  assert.equal(await getEngine('codex').captureArtifact('', '/tmp/x.md'), null);
});

test('extractMarkdown: heading scrape strips trailing [timestamp...]', () => {
  const md = extractMarkdown('# Final Review: CP-1\nbody here\n[2026-01-02T03:04:05.000Z extra]');
  assert.equal(md, '# Final Review: CP-1\nbody here');
});

// ───────────────────────────────────────────────────────────────────────────
//  5. reviewPlacement (the I-1 first-class policy)
// ───────────────────────────────────────────────────────────────────────────

test('reviewPlacement: codex writesToCwd on review stages only; claude/opus never', () => {
  assert.deepEqual(getEngine('codex').reviewPlacement('plan-review'), { writesToCwd: true });
  assert.deepEqual(getEngine('codex').reviewPlacement('review'), { writesToCwd: true });
  assert.deepEqual(getEngine('codex').reviewPlacement('run'), { writesToCwd: false });
  assert.deepEqual(getEngine('claude').reviewPlacement('review'), { writesToCwd: false });
  assert.deepEqual(getEngine('opus').reviewPlacement('review'), { writesToCwd: false });
});

// ───────────────────────────────────────────────────────────────────────────
//  6. CAPABILITIES + stdinPolicy + promptDelivery
// ───────────────────────────────────────────────────────────────────────────

test('capabilities: claude supportsCcThingz; codex honorsReasoningEffort; opus does NOT (C4)', () => {
  assert.equal(getEngine('claude').capabilities.supportsCcThingz, true);
  // C4: opus is the EXACT-LEGACY alias — the pre-5a cc-thingz gate was
  // `engine === 'claude'`, so `opus --cc-thingz` took the DIRECT plan path.
  // supportsCcThingz MUST be false so opus does not silently enter cc-thingz.
  assert.equal(getEngine('opus').capabilities.supportsCcThingz, false);
  assert.equal(getEngine('codex').capabilities.honorsReasoningEffort, true);
  assert.notEqual(getEngine('codex').capabilities.supportsCcThingz, true);
});

test('stdinPolicy + promptDelivery: codex ignore/file, claude+opus inherit/file', () => {
  assert.equal(getEngine('codex').stdinPolicy, 'ignore');
  assert.equal(getEngine('claude').stdinPolicy, 'inherit');
  assert.equal(getEngine('opus').stdinPolicy, 'inherit');
  for (const e of ['claude', 'codex', 'opus']) assert.equal(getEngine(e).promptDelivery, 'file');
});

test('deliverPrompt: single source of truth — both adapters produce the Read-and-follow arg', () => {
  assert.equal(getEngine('claude').deliverPrompt('/p/x.md'), '"Read /p/x.md and follow the instructions"');
  assert.equal(getEngine('codex').deliverPrompt('/p/x.md'), '"Read /p/x.md and follow the instructions"');
});

// ───────────────────────────────────────────────────────────────────────────
//  7. REGISTRY / UNKNOWN-ENGINE / SHAPE VALIDATION
// ───────────────────────────────────────────────────────────────────────────

test('registry: getEngine("nope") throws UnknownEngineError listing claude, codex, opus', () => {
  assert.throws(() => getEngine('nope'), (err) => {
    assert.ok(err instanceof UnknownEngineError);
    assert.match(err.message, /Unknown engine "nope"\. Registered: claude, codex, opus\./);
    return true;
  });
});

test('registry: registeredEngineNames() === [claude, codex, opus] by default', () => {
  assert.deepEqual(registeredEngineNames().sort(), ['claude', 'codex', 'opus']);
});

test('registry: assertEngineRegistered passes a known name, throws on unknown', () => {
  assert.equal(assertEngineRegistered('codex'), 'codex');
  assert.throws(() => assertEngineRegistered('bogus'), UnknownEngineError);
});

test('registry: parseEngine allow-list === registeredEngineNames(); unknown --engine HARD-throws (I-3)', () => {
  // A registered name is accepted.
  assert.equal(parseEngine(['--engine', 'opus'], null, 'planner'), 'opus');
  // I-3: an unknown --engine now HARD-fails with the registered list (no
  // soft-fallback) — consistent with the config-time check (C2). The throw
  // happens in parseEngine, which every cmdXxx calls BEFORE writing the prompt.
  assert.throws(() => parseEngine(['--engine', 'nope'], null, 'planner'), (err) => {
    assert.ok(err instanceof UnknownEngineError);
    assert.match(err.message, /Unknown engine "nope"\. Registered: claude, codex, opus\./);
    return true;
  });
  // No `--engine` flag → the configured/role fallback (unchanged).
  assert.equal(parseEngine([], null, 'planner'), 'claude');
  assert.equal(parseEngine([], null, 'reviewer'), 'codex');
  // Registering a new name makes parseEngine accept it with no code edit.
  registerEngine(makeFakeEngine());
  try {
    assert.ok(registeredEngineNames().includes('fake'));
    assert.equal(parseEngine(['--engine', 'fake'], null, 'planner'), 'fake');
  } finally {
    _unregisterEngineForTest('fake');
  }
});

test('registry: registerEngine REFUSES to replace a built-in (claude/codex/opus)', () => {
  for (const name of ['claude', 'codex', 'opus']) {
    const clone = { ...makeFakeEngine(), name };
    assert.throws(() => registerEngine(clone), /cannot replace built-in engine/);
  }
});

test('registry: registerEngine rejects a MALFORMED adapter (missing method, bad stdinPolicy)', () => {
  assert.throws(() => registerEngine({ name: 'broken' }), /missing method/);
  assert.throws(() => registerEngine(null), /must be an object/);
  assert.throws(() => registerEngine({ ...makeFakeEngine(), name: 'badstdin', stdinPolicy: 'weird' }), /invalid stdinPolicy/);
  assert.throws(() => registerEngine({ ...makeFakeEngine(), name: 'baddeliver', promptDelivery: 'nope' }), /invalid promptDelivery/);
  // Confirm none of the failed registrations leaked into the registry.
  assert.deepEqual(registeredEngineNames().sort(), ['claude', 'codex', 'opus']);
});

test('registry: a NEW name registers + can be unregistered (the fake-adapter seam)', () => {
  registerEngine(makeFakeEngine());
  assert.ok(registeredEngineNames().includes('fake'));
  assert.equal(getEngine('fake').name, 'fake');
  assert.equal(_unregisterEngineForTest('fake'), true);
  assert.equal(registeredEngineNames().includes('fake'), false);
});

test('registry: _unregisterEngineForTest refuses to remove a built-in', () => {
  assert.throws(() => _unregisterEngineForTest('claude'), /refusing to remove built-in/);
});

// ───────────────────────────────────────────────────────────────────────────
//  8. probeAvailability
// ───────────────────────────────────────────────────────────────────────────

test('probe: fake adapter probeAvailability returns {available:true}', async () => {
  const fake = makeFakeEngine();
  assert.deepEqual(await fake.probeAvailability(), { available: true });
});

test('probe: a registered adapter whose binary is absent probes available:false (no throw, no network)', async () => {
  // A fake-shaped adapter whose probe spawns a guaranteed-missing binary.
  const adapter = {
    ...makeFakeEngine(),
    name: 'ghost',
    async probeAvailability() {
      const { spawn } = await import('node:child_process');
      return await new Promise((resolve) => {
        const c = spawn('taskctl-no-such-binary-xyz', ['--version'], { stdio: 'ignore', shell: false });
        c.on('error', () => resolve({ available: false, detail: 'ENOENT' }));
        c.on('close', (code) => resolve(code === 0 ? { available: true } : { available: false }));
      });
    },
  };
  registerEngine(adapter);
  try {
    const r = await getEngine('ghost').probeAvailability();
    assert.equal(r.available, false);
  } finally {
    _unregisterEngineForTest('ghost');
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  9. FAKE ADAPTER — structured envelope + exit 0 (the 5b test seam)
// ───────────────────────────────────────────────────────────────────────────

test('fake: replay script emits a VALID structured envelope and exits 0', async () => {
  const replay = path.join(__dirname, '..', 'engines-fake-replay.mjs');
  const r = spawnSync(process.execPath, [replay, '/tmp/.prompt-newproject-brainstorm.md'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `replay exit 0; stderr=${r.stderr}`);
  const m = r.stdout.match(/```json\s*([\s\S]*?)```/);
  assert.ok(m, 'replay emitted a fenced json envelope');
  const env = JSON.parse(m[1]);
  assert.ok(Array.isArray(env.questions) && Array.isArray(env.options), 'brainstorm envelope shape');
});

test('fake: buildSpawn launches node <replayScript> <promptFile> with stdin ignored', () => {
  const fake = makeFakeEngine({ scriptDir: '/some/dir' });
  const { cmd, args, spawnOptions } = fake.buildSpawn({ promptFile: '/p/x.md', orchRoot: O, repoPath: REPO, cwd: REPO, interactive: false });
  assert.equal(cmd, 'node');
  assert.match(args[0], /engines-fake-replay\.mjs$/);
  assert.equal(args[1], '/p/x.md');
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spawnOptions.env.TASKCTL_FAKE_SCRIPT_DIR, '/some/dir');
});

test('fake: a captured run end-to-end writes the envelope to the capture target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eng-fake-'));
  try {
    const fake = makeFakeEngine();
    const { cmd, args } = fake.buildSpawn({ promptFile: '/tmp/.prompt-newproject-proposal.md', orchRoot: O, repoPath: REPO, cwd: REPO, interactive: false });
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const target = path.join(dir, 'out.md');
    const written = await fake.captureArtifact(r.stdout, target);
    assert.equal(written, target);
    const body = await fs.readFile(target, 'utf8');
    assert.match(body, /"recommended"/, 'proposal envelope captured to disk');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  10. session.log TEEING preserved (end-to-end through cmdDo would be heavy;
//      assert the generic log plumbing directly via a spawn that emits stdout)
// ───────────────────────────────────────────────────────────────────────────

test('session.log: the generic raw-stdout + [stderr] teeing format is preserved', async () => {
  // This asserts the documented log line shapes spawnAI writes (header/$ echo/
  // [stderr]/[exit] footer) are stable. We drive the fake adapter via a real
  // subprocess and a log sink, replicating spawnAI's generic teeing contract.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eng-log-'));
  try {
    const logFile = path.join(dir, 'session.log');
    // Minimal replica of spawnAI's generic logging around an adapter spawn.
    const adapter = getEngine('codex');
    const { cmd, args } = { cmd: process.execPath, args: ['-e', 'process.stdout.write("# Review\\nok\\n"); process.stderr.write("warn\\n")'] };
    const fh = await fs.open(logFile, 'a');
    const logStream = fh.createWriteStream();
    const log = (t) => logStream.write(t);
    log(`\n${'='.repeat(60)}\n[ts] Session: codex | piped\nPrompt: p\nCWD: ${dir}\n${'='.repeat(60)}\n\n`);
    log(`$ ${cmd} ${args.join(' ')}\n\n`);
    const session = adapter.createOutputSession();
    const origWrite = process.stdout.write; process.stdout.write = () => true;
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (c) => { log(c.toString()); session.onChunk(c); });
      child.stderr.on('data', (c) => { log(`[stderr] ${c.toString()}`); });
      child.on('error', reject);
      child.on('close', (code) => { log(`\n[exit] code=${code ?? 0} at ts\n`); logStream.end(); resolve(code); });
    });
    process.stdout.write = origWrite;
    const body = await fs.readFile(logFile, 'utf8');
    assert.match(body, /Session: codex \| piped/, 'header preserved');
    assert.match(body, /^\$ /m, '$ command echo preserved');
    assert.match(body, /# Review\nok/, 'raw stdout teed to log');
    assert.match(body, /\[stderr\] warn/, '[stderr] teeing preserved');
    assert.match(body, /\[exit\] code=0/, '[exit] footer preserved');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  11. OPUS four-fact summary + planner:"opus" config migration (subprocess)
// ───────────────────────────────────────────────────────────────────────────

const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VP_REPO_ROOT', 'GRACE_REPO_ROOT', 'VIBE_ROOT']) delete env[k];
  return { ...env, ...extra };
}
async function makeWorkspace(configObj) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-5a-'));
  await fs.cp(TASKCTL_DIR, path.join(root, 'taskctl'), { recursive: true });
  await fs.cp(TEMPLATES_DIR, path.join(root, 'ai', 'templates'), { recursive: true });
  await fs.writeFile(path.join(root, 'taskctl.config.json'), JSON.stringify(configObj), 'utf8');
  return root;
}
function runWs(ws, args, { env = cleanEnv(), timeout = 30000 } = {}) {
  const cli = path.join(ws, 'taskctl', 'cli.mjs');
  return spawnSync('node', [cli, ...args], { cwd: ws, encoding: 'utf8', env, timeout });
}

test('opus four-fact (1): an existing planner:"opus" config launches the CLAUDE form (migration test)', async () => {
  // A config with planner:"opus" must keep emitting today's claude-shaped launch
  // (no --model, no codex) for a planner command — exact legacy parity.
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'opus', reviewer: 'codex', reasoningEffort: 'high' } });
  try {
    const seed = runWs(ws, ['new', 'opus-demo', '--title', 'x']);
    assert.equal(seed.status, 0, `new exit 0; stderr=${seed.stderr}`);
    const r = runWs(ws, ['plan', 'opus-demo']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /claude --add-dir/, 'planner:"opus" emits the claude-shaped launch');
    assert.equal(/--model/.test(out), false, 'opus emits NO --model flag');
    assert.equal(/codex (exec|--full-auto)/.test(out), false, 'opus is NOT codex-shaped');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('preflight: `do plan --engine nope` fails with the registered list BEFORE writing a prompt', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'claude', reviewer: 'codex' } });
  try {
    const seed = runWs(ws, ['new', 'pf-demo', '--title', 'x']);
    assert.equal(seed.status, 0, `new exit 0; stderr=${seed.stderr}`);
    const r = runWs(ws, ['do', 'plan', 'pf-demo', '--engine', 'nope']);
    assert.notEqual(r.status, 0, 'do plan with a bad engine must fail');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /Unknown engine "nope"/, 'clear unknown-engine error');
    assert.match(out, /Registered: claude, codex, opus/, 'lists the registered adapters');
    // The prompt file must NOT have been generated (failed at preflight).
    const promptPath = path.join(ws, 'ai', 'tasks', 'pf-demo', '.prompt-plan.md');
    let exists = true;
    try { await fs.access(promptPath); } catch { exists = false; }
    assert.equal(exists, false, 'no prompt written when the engine is invalid (fail-fast preflight)');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('subprocess: `taskctl plan X --engine nope` HARD-fails with the registered list BEFORE writing (I-3)', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'claude', reviewer: 'codex' } });
  try {
    const seed = runWs(ws, ['new', 'warn-demo', '--title', 'x']);
    assert.equal(seed.status, 0);
    // I-3: an unknown `--engine` on a DIRECT command now fails clearly (non-zero
    // exit) with the registered list — no soft-warn-then-fallback. Because
    // parseEngine runs before any prompt/state write, the failure is pre-write.
    const r = runWs(ws, ['plan', 'warn-demo', '--engine', 'nope']);
    assert.notEqual(r.status, 0, 'plan with an unknown --engine must fail');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /Unknown engine "nope"/, 'clear unknown-engine error');
    assert.match(out, /Registered: claude, codex, opus/, 'lists the registered adapters');
    assert.equal(/claude --add-dir/.test(out), false, 'does NOT silently fall back to a launch line');
    // No prompt file written (failed at parseEngine, before the write).
    const promptPath = path.join(ws, 'ai', 'tasks', 'warn-demo', '.prompt-plan.md');
    let exists = true;
    try { await fs.access(promptPath); } catch { exists = false; }
    assert.equal(exists, false, 'no prompt written when --engine is unknown (fail-fast)');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  12. C4 — opus --cc-thingz takes the DIRECT plan branch (exact legacy parity)
// ───────────────────────────────────────────────────────────────────────────

test('C4: opus --cc-thingz takes the DIRECT plan path (NOT cc-thingz), claude-shaped launch', async () => {
  // Pre-5a the gate was `useCcThingz && engine === 'claude'`, so opus --cc-thingz
  // fell into the DIRECT plan branch. With supportsCcThingz:false, opus still
  // does — the console prints the direct-plan lines (the "After Claude finishes"
  // finalize line), NOT the cc-thingz skills block, and the launch stays claude.
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'opus', reviewer: 'codex', reasoningEffort: 'high' } });
  try {
    const seed = runWs(ws, ['new', 'opus-cc', '--title', 'x']);
    assert.equal(seed.status, 0, `new exit 0; stderr=${seed.stderr}`);
    const r = runWs(ws, ['plan', 'opus-cc', '--cc-thingz', '--engine', 'opus']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /claude --add-dir/, 'opus stays claude-shaped');
    // cc-thingz console emits "skills" + the /brainstorm:do + /plan-make:do skill
    // lines; the DIRECT path never does. Their ABSENCE proves opus took DIRECT.
    assert.equal(/\/brainstorm:do/.test(out), false, 'opus must NOT enter the cc-thingz skills flow');
    assert.equal(/\/plan-make:do/.test(out), false, 'opus must NOT print the cc-thingz plan-make skill');
    // And the direct path advances nextAction to "run planning in opus" (no
    // "with cc-thingz"). The state.json reflects the direct branch.
    const state = JSON.parse(await fs.readFile(path.join(ws, 'ai', 'tasks', 'opus-cc', 'state.json'), 'utf8'));
    assert.match(state.nextAction, /run planning in opus/, 'direct-path nextAction (no cc-thingz)');
    assert.equal(/cc-thingz/.test(state.nextAction), false, 'nextAction is the direct-path string');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('C4: claude --cc-thingz DOES enter the cc-thingz path (contrast — capability true)', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'claude', reviewer: 'codex' } });
  try {
    const seed = runWs(ws, ['new', 'cl-cc', '--title', 'x']);
    assert.equal(seed.status, 0);
    const r = runWs(ws, ['plan', 'cl-cc', '--cc-thingz']);
    assert.equal(r.status, 0, `plan exit 0; stderr=${r.stderr}`);
    const out = (r.stdout || '') + (r.stderr || '');
    // claude supportsCcThingz:true → the cc-thingz skills block IS printed.
    assert.match(out, /\/brainstorm:do/, 'claude enters cc-thingz (skills block printed)');
    const state = JSON.parse(await fs.readFile(path.join(ws, 'ai', 'tasks', 'cl-cc', 'state.json'), 'utf8'));
    assert.match(state.nextAction, /cc-thingz/, 'cc-thingz nextAction string');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  13. I-2 / DELIBERATE EXCEPTION 3 — role-based re-review hint (otherRoleEngine)
// ───────────────────────────────────────────────────────────────────────────

test('otherRoleEngine: DEFAULT config (planner=claude, reviewer=codex) === pre-5a name-based result', () => {
  const rcfg = { engines: { planner: 'claude', reviewer: 'codex' } };
  // Author (claude) → suggests the reviewer (codex); reviewer (codex) → author.
  assert.equal(otherRoleEngine('claude', rcfg), 'codex');
  assert.equal(otherRoleEngine('codex', rcfg), 'claude');
  // null rcfg → the same defaults (byte-identical to the old hardcoded pairing).
  assert.equal(otherRoleEngine('claude', null), 'codex');
  assert.equal(otherRoleEngine('codex', null), 'claude');
});

test('otherRoleEngine: SWAPPED config (planner=codex, reviewer=claude) pairs by role, not by name', () => {
  const rcfg = { engines: { planner: 'codex', reviewer: 'claude' } };
  // The old NAME-based rule (`engine === 'claude' ? 'codex' : 'claude'`) would
  // have returned 'codex' for claude here — WRONG, since claude is the reviewer.
  // Role-based: the author (codex) → reviewer (claude); reviewer (claude) → author (codex).
  assert.equal(otherRoleEngine('codex', rcfg), 'claude', 'author codex → reviewer claude');
  assert.equal(otherRoleEngine('claude', rcfg), 'codex', 'reviewer claude → author codex');
});

test('otherRoleEngine: SINGLE-VENDOR config (planner=claude, reviewer=claude) → claude both ways', () => {
  const rcfg = { engines: { planner: 'claude', reviewer: 'claude' } };
  // Both roles are claude; the opposite role is still claude (a single-vendor
  // setup re-reviews with the same engine — correct, and impossible to express
  // with the old name compare which would have flipped claude→codex).
  assert.equal(otherRoleEngine('claude', rcfg), 'claude');
});

test('otherRoleEngine: planner=opus config → opus is the author; reviewer is the other role', () => {
  const rcfg = { engines: { planner: 'opus', reviewer: 'codex' } };
  // opus is the author → other role is the reviewer (codex). The old name-based
  // rule returned 'claude' for any non-claude engine (so opus → codex by luck on
  // the author side, but it would mishandle the reverse). Role-based is exact:
  assert.equal(otherRoleEngine('opus', rcfg), 'codex', 'author opus → reviewer codex');
  assert.equal(otherRoleEngine('codex', rcfg), 'opus', 'reviewer codex → author opus');
});

// ───────────────────────────────────────────────────────────────────────────
//  14. I-4 — built-ins go through ONE validated path; capability fields boolean
// ───────────────────────────────────────────────────────────────────────────

test('I-4: registerEngine rejects a non-boolean known capability (supportsCcThingz:"yes")', () => {
  assert.throws(
    () => registerEngine({ ...makeFakeEngine(), name: 'badcap', capabilities: { supportsCcThingz: 'yes' } }),
    /capability supportsCcThingz must be a boolean/,
  );
  assert.throws(
    () => registerEngine({ ...makeFakeEngine(), name: 'badcap2', capabilities: { honorsReasoningEffort: 1 } }),
    /capability honorsReasoningEffort must be a boolean/,
  );
  // The failed registrations did not leak.
  assert.deepEqual(registeredEngineNames().sort(), ['claude', 'codex', 'opus']);
});

test('I-4: a boolean (or absent) capability is accepted; the validated path inserts it', () => {
  registerEngine({ ...makeFakeEngine(), name: 'okcap', capabilities: { supportsCcThingz: true, honorsReasoningEffort: false } });
  try {
    assert.equal(getEngine('okcap').capabilities.supportsCcThingz, true);
  } finally {
    _unregisterEngineForTest('okcap');
  }
  // Absent capabilities object is fine too.
  registerEngine({ ...makeFakeEngine(), name: 'nocap', capabilities: undefined });
  try {
    assert.ok(registeredEngineNames().includes('nocap'));
  } finally {
    _unregisterEngineForTest('nocap');
  }
});

test('I-4: the THREE built-ins all satisfy the validated shape (boolean caps, valid stdin/delivery)', () => {
  // Proves the built-in bootstrap ran THROUGH registerValidated (not a raw
  // Map.set): every known capability field is a boolean, stdin/delivery valid.
  for (const name of ['claude', 'codex', 'opus']) {
    const a = getEngine(name);
    assert.ok(['inherit', 'ignore'].includes(a.stdinPolicy), `${name} stdinPolicy valid`);
    assert.ok(['arg', 'file'].includes(a.promptDelivery), `${name} promptDelivery valid`);
    for (const f of ['supportsCcThingz', 'honorsReasoningEffort']) {
      const v = a.capabilities?.[f];
      assert.ok(v == null || typeof v === 'boolean', `${name}.${f} is boolean-or-absent`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  15. C1 — Windows probe resolution chain (temp .cmd shim fixture)
// ───────────────────────────────────────────────────────────────────────────

test('C1: probe resolves a win32 .cmd shim where a bare shell:false spawn ENOENTs', { skip: process.platform !== 'win32' ? 'win32-only (.cmd shim)' : false }, async () => {
  // Reproduce the real failure mode: a command that exists ONLY as a `name.cmd`
  // shim on PATH (exactly how `npm i -g claude` installs on Windows). A bare
  // shell:false spawn of the extensionless name ENOENTs; the probe's resolution
  // chain (bare → .cmd → where.exe) must still report it available.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-shim-'));
  const shimBase = 'taskctlprobeshim';
  try {
    // A .cmd that prints a version and exits 0 — no network, just an echo.
    await fs.writeFile(path.join(dir, `${shimBase}.cmd`), '@echo off\r\necho 9.9.9-shim\r\nexit /b 0\r\n', 'utf8');
    const pathWithShim = `${dir}${path.delimiter}${process.env.PATH}`;
    const childEnv = { ...process.env, PATH: pathWithShim, Path: pathWithShim };

    // (a) Prove the bare shell:false spawn ENOENTs (the C1 bug precondition).
    const bare = spawnSync(shimBase, ['--version'], { stdio: 'ignore', shell: false, env: childEnv });
    assert.ok(bare.error && bare.error.code === 'ENOENT', `bare shell:false must ENOENT; got ${bare.error?.code ?? `exit ${bare.status}`}`);

    // (b) Build a ghost adapter whose probe runs the SAME resolution chain as the
    //     real probeVersion (engines.mjs is not exported piecewise, so replicate
    //     the documented chain here) under the shim PATH, and assert available.
    const probeOut = spawnSync(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      function tryV(cmd, useShell){ return new Promise(res=>{ let s=false; const d=r=>{if(!s){s=true;res(r);}};
        let c; try{ c=spawn(useShell?('"'+cmd+'"'):cmd,['--version'],{stdio:'ignore',shell:useShell}); }catch(e){return d({ok:false});}
        const t=setTimeout(()=>{try{c.kill();}catch{}d({ok:false});},5000);
        c.on('error',()=>{clearTimeout(t);d({ok:false});}); c.on('close',code=>{clearTimeout(t);d({ok:code===0});}); }); }
      function whereR(name){ return new Promise(res=>{ let out=''; const c=spawn('where.exe',[name],{stdio:['ignore','pipe','ignore']});
        c.stdout.on('data',d=>out+=d); c.on('error',()=>res(null)); c.on('close',()=>{ const L=out.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);
          res(L.find(l=>/\\.(cmd|exe|bat)$/i.test(l))||L[0]||null); }); }); }
      (async()=>{ const name='${shimBase}';
        let r = await tryV(name,false); if(r.ok) return console.log('OK:bare');
        r = await tryV(name+'.cmd',true); if(r.ok) return console.log('OK:cmd');
        const res = await whereR(name); if(res){ r=await tryV(res,true); if(r.ok) return console.log('OK:where'); }
        console.log('FAIL'); })();
    `], { encoding: 'utf8', env: childEnv });
    const probeMsg = (probeOut.stdout || '').trim();
    assert.match(probeMsg, /^OK:(cmd|where|bare)$/, `probe chain must resolve the .cmd shim; got "${probeMsg}" stderr=${probeOut.stderr}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('C1: real probeAvailability for claude + codex is available on THIS machine (live)', { skip: process.platform !== 'win32' ? 'live probe asserted on the dev win32 box' : false }, async () => {
  // The live machine has claude.cmd + codex.cmd on PATH. After the C1 fix the
  // probe MUST report both available (pre-fix it returned false for both,
  // blocking 5b preflight). No network: only `<cmd> --version`.
  const claude = await getEngine('claude').probeAvailability();
  const codex = await getEngine('codex').probeAvailability();
  assert.equal(claude.available, true, `claude probe → ${JSON.stringify(claude)}`);
  assert.equal(codex.available, true, `codex probe → ${JSON.stringify(codex)}`);
});

// ───────────────────────────────────────────────────────────────────────────
//  16. C2 — bogus engine in CONFIG fails at normalizeRuntimeConfig (pre-write)
// ───────────────────────────────────────────────────────────────────────────

test('C2 (pure): normalizeRuntimeConfig throws UnknownEngineError on a bogus planner', () => {
  assert.throws(
    () => normalizeRuntimeConfig({ raw: { engines: { planner: 'bogus', reviewer: 'codex' } }, tracker: { type: 'local' }, configPath: '/x/taskctl.config.json', repoPath: '/x' }),
    (err) => {
      assert.ok(err instanceof UnknownEngineError);
      assert.match(err.message, /Unknown engine "bogus"\. Registered: claude, codex, opus\./);
      return true;
    },
  );
});

test('C2 (pure): normalizeRuntimeConfig also validates the reviewer', () => {
  assert.throws(
    () => normalizeRuntimeConfig({ raw: { engines: { planner: 'claude', reviewer: 'nope' } }, tracker: { type: 'local' }, configPath: '/x/taskctl.config.json', repoPath: '/x' }),
    /Unknown engine "nope"/,
  );
});

test('C2 (e2e): a bogus planner config exits with the listing AND makes ZERO writes (no prompt, state byte-unchanged)', async () => {
  const ws = await makeWorkspace({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'bogus', reviewer: 'codex' } });
  try {
    // Seed the task with a VALID config first (so state.json + context exist),
    // then swap in the bogus-planner config and capture the exact state bytes.
    // `new` itself loads config → would reject the bogus engine; so seed under a
    // good config, snapshot, then write the bogus config and run `plan`.
    const goodCfg = JSON.stringify({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'claude', reviewer: 'codex' } });
    await fs.writeFile(path.join(ws, 'taskctl.config.json'), goodCfg, 'utf8');
    const seed = runWs(ws, ['new', 'cfg-bogus', '--title', 'x']);
    assert.equal(seed.status, 0, `new exit 0; stderr=${seed.stderr}`);

    const statePath = path.join(ws, 'ai', 'tasks', 'cfg-bogus', 'state.json');
    const promptPath = path.join(ws, 'ai', 'tasks', 'cfg-bogus', '.prompt-plan.md');
    const stateBefore = await fs.readFile(statePath); // Buffer (exact bytes)

    // Now make the config bogus and run a write-capable command.
    await fs.writeFile(path.join(ws, 'taskctl.config.json'), JSON.stringify({ repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'bogus', reviewer: 'codex' } }), 'utf8');
    const r = runWs(ws, ['plan', 'cfg-bogus']);

    // (1) clear listing error
    assert.notEqual(r.status, 0, 'a bogus planner config must fail the command');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /Unknown engine "bogus"/, 'clear unknown-engine error from config resolution');
    assert.match(out, /Registered: claude, codex, opus/, 'lists the registered adapters');

    // (2) ZERO writes — no prompt file generated …
    let promptExists = true;
    try { await fs.access(promptPath); } catch { promptExists = false; }
    assert.equal(promptExists, false, 'no .prompt-plan.md written (failed at config resolution, pre-write)');

    // … and state.json is byte-for-byte unchanged.
    const stateAfter = await fs.readFile(statePath);
    assert.ok(stateBefore.equals(stateAfter), 'state.json must be byte-unchanged (no mutation before the failure)');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
//  17. C3 + I-1 — REAL automation path (cmdDo) with the fake adapter:
//      · env (TASKCTL_FAKE_SCRIPT_DIR) survives spawnAI → scripted reply lands
//        in the captured artifact end-to-end (C3)
//      · the REAL spawn argv is recorded via the fake; reviewPlacement cwd +
//        captureTarget wiring is exercised in the real path (I-1)
// ───────────────────────────────────────────────────────────────────────────

// Build a hermetic workspace + an in-process runCommand double that stands in
// for cli.mjs's prompt-generation / finalize bookkeeping (cli's responsibility,
// covered by the subprocess suites). cmdDo itself — argv resolution,
// engineForStage/rolePair, reviewPlacement cwd+captureTarget, and the REAL
// spawnAI spawn+env+capture — runs unmodified against the registered fake.
async function makeAutomationWs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-5a-'));
  const taskDir = path.join(root, 'ai', 'tasks', 'CP-AUTO');
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'context.md'), '# context', 'utf8');
  await fs.writeFile(path.join(taskDir, 'plan.md'), '# Plan\n## Verdict: APPROVE\n', 'utf8');
  await fs.writeFile(path.join(taskDir, 'state.json'), JSON.stringify({ key: 'CP-AUTO', stage: 'analysis', issueType: 'Task' }), 'utf8');
  return { root, taskDir };
}

// The runCommand double: writes the prompt file cmdDo verifies, and on
// `--finalize` performs the SAME minimal state transition the real cli does for
// these stages (plan→planned; plan-review reads review.md verdict→plan_reviewed
// on APPROVE). Records every call so the test can assert the chain.
function makeRunCommand(taskDir, calls) {
  const PROMPT = { plan: '.prompt-plan.md', 'plan-review': '.prompt-review.md', revise: '.prompt-revise.md' };
  return async function runCommand(cmd, issueKey, args) {
    calls.push({ cmd, args: [...args] });
    const finalize = args.includes('--finalize');
    if (!finalize) {
      const pf = PROMPT[cmd] ?? `.prompt-${cmd}.md`;
      await fs.writeFile(path.join(taskDir, pf), `# prompt for ${cmd}`, 'utf8');
      return;
    }
    const statePath = path.join(taskDir, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (cmd === 'plan') {
      state.stage = 'planned';
      state.nextAction = 'plan review';
    } else if (cmd === 'plan-review') {
      // Mirror cli.mjs cmdPlanReview --finalize: read review.md, parse the verdict.
      let verdict = null;
      try {
        const review = await fs.readFile(path.join(taskDir, 'review.md'), 'utf8');
        const m = review.match(/##\s*Verdict:\s*([A-Z ]+)/i) ?? review.match(/Verdict:\s*([A-Z ]+)/i);
        verdict = m ? m[1].trim().toUpperCase() : null;
      } catch { /* no review.md */ }
      if (verdict === 'APPROVE') { state.stage = 'plan_reviewed'; state.nextAction = 'execute plan'; }
      else { state.stage = 'analysis'; state.nextAction = 'revise'; }
    } else if (cmd === 'revise') {
      state.stage = 'planned';
    }
    await fs.writeFile(statePath, JSON.stringify(state), 'utf8');
  };
}

test('C3+I-1: do plan-review with the fake — scriptDir reply lands in review.md; real argv recorded; cwd+capture wired', async () => {
  const { root, taskDir } = await makeAutomationWs();
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-script-'));
  const record = [];
  // Canned reply keyed by the review prompt-file basename. The fake's replay
  // emits this VERBATIM, proving TASKCTL_FAKE_SCRIPT_DIR survived spawnAI (C3).
  const cannedReview = '# Review\n## Verdict: APPROVE\nSCRIPTED-REPLY-MARKER-7\n';
  await fs.writeFile(path.join(scriptDir, '.prompt-review.md.json'), cannedReview, 'utf8');

  registerEngine(makeFakeEngine({ scriptDir, record }));
  // Pre-position the task in `planned` so plan-review is a valid stage.
  const state = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
  state.stage = 'planned';
  await fs.writeFile(path.join(taskDir, 'state.json'), JSON.stringify(state), 'utf8');

  // Silence the heavy console output of the real automation path for this test.
  const origLog = console.log; console.log = () => {};
  const origWrite = process.stdout.write; process.stdout.write = () => true;
  try {
    const calls = [];
    const ctx = {
      orchRoot: root,
      tasksDir: path.join(root, 'ai', 'tasks'),
      issueKey: 'CP-AUTO',
      args: ['plan-review', 'CP-AUTO', '--engine', 'fake', '--repo-path', root],
      runCommand: makeRunCommand(taskDir, calls),
      runtimeConfig: { engines: { planner: 'fake', reviewer: 'fake', reasoningEffort: 'high' }, grace: { enabled: false } },
    };
    const result = await cmdDo(ctx);

    // C3: the SCRIPTED reply (selected via TASKCTL_FAKE_SCRIPT_DIR) landed in the
    // captured artifact (review.md) end-to-end through the REAL spawnAI capture.
    const reviewMd = await fs.readFile(path.join(taskDir, 'review.md'), 'utf8');
    assert.match(reviewMd, /SCRIPTED-REPLY-MARKER-7/, 'scripted reply captured to review.md (env survived spawnAI)');

    // I-1: the REAL spawn argv was recorded via the fake — `node <replay> <prompt>`.
    assert.equal(record.length, 1, 'exactly one real spawn happened');
    assert.equal(record[0].cmd, 'node');
    assert.match(record[0].args[0], /engines-fake-replay\.mjs$/, 'spawned the replay script');
    assert.match(record[0].args[1], /\.prompt-review\.md$/, 'with the review prompt file');
    assert.equal(record[0].spawnOptions.env.TASKCTL_FAKE_SCRIPT_DIR, scriptDir, 'scriptDir went into spawnOptions.env');

    // I-1: review-stage capture wiring in the REAL path — the fake (a capturing
    // engine on review stages) was handed cwd=taskDir + captureTarget=review.md.
    assert.equal(record[0].opts.cwd, taskDir, 'reviewPlacement.writesToCwd → cwd=taskDir');

    // The plan-review finalize consumed the APPROVE verdict from the captured file.
    assert.equal(result.stage, 'plan_reviewed', 'finalize read the captured verdict → plan_reviewed');
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
    _unregisterEngineForTest('fake');
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

test('C3+I-1: do plan --auto runs one plan→plan-review loop iteration to APPROVE on the real automation path', async () => {
  const { root, taskDir } = await makeAutomationWs();
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-script2-'));
  const record = [];
  // plan stage → non-review → no capture; the plan-review stage captures the
  // APPROVE so the auto-loop terminates at iteration 0.
  await fs.writeFile(path.join(scriptDir, '.prompt-review.md.json'), '# Review\n## Verdict: APPROVE\nLOOP-OK\n', 'utf8');

  registerEngine(makeFakeEngine({ scriptDir, record }));
  const origLog = console.log; console.log = () => {};
  const origErr = console.error; console.error = () => {};
  const origWrite = process.stdout.write; process.stdout.write = () => true;
  try {
    const calls = [];
    const ctx = {
      orchRoot: root,
      tasksDir: path.join(root, 'ai', 'tasks'),
      issueKey: 'CP-AUTO',
      // --auto drives the plan→plan-review loop; rolePair reads planner/reviewer.
      args: ['plan', 'CP-AUTO', '--auto', '--engine', 'fake', '--repo-path', root],
      runCommand: makeRunCommand(taskDir, calls),
      runtimeConfig: { engines: { planner: 'fake', reviewer: 'fake', reasoningEffort: 'high' }, grace: { enabled: false } },
    };
    const result = await cmdDo(ctx);

    // The loop reached plan_reviewed (APPROVE on iter 0) — proving the real
    // automation loop drove plan THEN plan-review through the fake end-to-end.
    assert.equal(result.stage, 'plan_reviewed', 'auto-loop reached plan_reviewed');

    // Two real spawns happened: the plan stage + the plan-review stage.
    assert.equal(record.length, 2, 'plan + plan-review each spawned once');
    assert.match(record[0].args[1], /\.prompt-plan\.md$/, 'first spawn = plan prompt');
    assert.match(record[1].args[1], /\.prompt-review\.md$/, 'second spawn = plan-review prompt');

    // I-1 capture wiring across stages: plan (non-review) got cwd=repo, NO
    // capture; plan-review (review) got cwd=taskDir + the review.md captureTarget.
    assert.equal(record[0].opts.cwd, root, 'plan stage cwd = repo (no capture)');
    assert.equal(record[1].opts.cwd, taskDir, 'plan-review stage cwd = taskDir (capturing)');

    // The captured artifact from the review spawn carries the scripted reply.
    const reviewMd = await fs.readFile(path.join(taskDir, 'review.md'), 'utf8');
    assert.match(reviewMd, /LOOP-OK/, 'plan-review captured the scripted APPROVE');
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
    _unregisterEngineForTest('fake');
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});
