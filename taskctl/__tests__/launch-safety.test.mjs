/**
 * launch-safety.test.mjs — P2 (issue #22): no configured value reaches argv
 * unvalidated.
 *
 * The suite is organised by what each group is EVIDENCE for, not by module:
 *
 *   1. the rule            — what the allow-list admits and refuses, and why the
 *                            refusal message is usable by the person it blocks.
 *   2. the eight members   — every configuration key the plan's enumeration found
 *                            reaching a destination site, set THE WAY IT IS
 *                            ACTUALLY SUPPLIED (seven in taskctl.config.json, one
 *                            in the environment), refuses the launch.
 *   3. resolution          — the check runs on the value AFTER composition, so a
 *                            metacharacter contributed by the config file's own
 *                            DIRECTORY is caught. A validator on the raw field
 *                            passes every test above this one and still leaks.
 *   4. the route classes   — argv under shell:true, execSync command strings,
 *                            printed engine launches, printed operator commands,
 *                            and the shell-less argv sinks. Each has a POSITIVE
 *                            CONTROL beside it, so a test cannot pass merely
 *                            because the command was broken for some other
 *                            reason. Round 2 added the converse for the routes it
 *                            converted: a path CONTAINING A SPACE has to work,
 *                            end to end, on each of them.
 *   5. no regression       — every value this repository, its example config, and
 *                            the rest of this suite actually use still passes.
 *   6. fail-closed         — a key added to the runtime config LATER is checked
 *                            with no edit to the checker. This is the test that
 *                            makes the containment a property of the surface
 *                            rather than a patch on the keys known today.
 *
 * ROUND 2 added group 4g, which is about a value from a task ARTIFACT rather than
 * from configuration — a different population, and one this file does not claim
 * to have closed. It is here because cli.mjs's Jira-summary call interpolated
 * artifact text into a `claude -p …` command string, and that one sink was fixed.
 * It comes with a SENSITIVITY test that asserts the payload really does execute
 * under the old form, because "no marker file appeared" is otherwise equally
 * consistent with a working fix and with a payload that was inert all along.
 *
 * What this file does NOT assert, because it is not true:
 *   · that `shell: true` is closed. Two routes still have it — the engine spawn
 *     and the printed operator commands — for the reasons recorded in
 *     launch-safety.mjs's DOUBLE_QUOTED_SHELL_ROUTES.
 *   · that artifact-sourced or CLI-sourced values are contained. One artifact
 *     sink was repaired; the population was not audited.
 * See docs/plans/design/p2-launch-safety.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertLaunchValue,
  assertLaunchConfig,
  LaunchValueError,
  NON_LAUNCH_KEYS,
} from '../launch-safety.mjs';
import { loadTaskctlConfig, normalizeRuntimeConfig } from '../config.mjs';
import { buildLaunchCommand } from '../cli.mjs';
import { runEngineStep } from '../automation.mjs';
import { runGraceGate } from '../grace.mjs';
import { readGitRemote } from '../harness.mjs';
import { registerEngine, _unregisterEngineForTest } from '../engines.mjs';
import { makeFakeEngine } from '../engines-fake.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

// ── helpers ─────────────────────────────────────────────────────────────────

const mkTmp = (prefix = 'taskctl-p2-') => fs.mkdtemp(path.join(os.tmpdir(), prefix));

async function writeConfig(dir, obj) {
  await fs.writeFile(path.join(dir, 'taskctl.config.json'), JSON.stringify(obj), 'utf8');
  return dir;
}

/** Resolve a planted config exactly as `main()` does, with the ambient .env off. */
async function resolveConfig(dir) {
  return normalizeRuntimeConfig(await loadTaskctlConfig({ configRoot: dir, loadEnv: false }));
}

/**
 * Assert a thunk refuses with a LaunchValueError, and hand the error back.
 * `assert.throws` does not return what it caught, and every refusal test here
 * needs to inspect the key/reason/character — asserting only "something threw"
 * would pass for a typo in the test's own fixture.
 */
function throwsLaunch(fn, label = '') {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, `expected a refusal ${label}, got none`);
  assert.equal(caught.name, 'LaunchValueError', `expected a LaunchValueError, got: ${caught.message}`);
  return caught;
}

/** The async form, additionally pinning the key (and optionally the reason). */
async function refuses(thunk, key, reason) {
  let caught = null;
  try { await thunk(); } catch (e) { caught = e; }
  assert.ok(caught, `expected a refusal for ${key}, got none`);
  assert.equal(caught.name, 'LaunchValueError', `expected a LaunchValueError, got: ${caught.message}`);
  assert.equal(caught.key, key, 'the refusal names the key the reader must edit');
  if (reason) assert.equal(caught.reason, reason);
  return caught;
}

/** Silence the engine raw-tee while a spawn-path test runs. */
async function quiet(fn) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return await fn(); } finally { process.stdout.write = write; }
}

// Subprocess harness — the same shape cli-2b/engines use: an isolated workspace
// with a planted config, driven through the real CLI entry point. The tracked
// taskctl.config.json is never touched.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VIBE_ROOT']) {
    delete env[k];
  }
  return { ...env, ...extra };
}
async function makeWorkspace(configObj) {
  const root = await mkTmp('taskctl-p2-ws-');
  await fs.cp(TASKCTL_DIR, path.join(root, 'taskctl'), { recursive: true });
  await fs.cp(TEMPLATES_DIR, path.join(root, 'ai', 'templates'), { recursive: true });
  await writeConfig(root, configObj);
  return root;
}
function runWs(ws, args, { env = cleanEnv(), timeout = 30000 } = {}) {
  const cli = path.join(ws, 'taskctl', 'cli.mjs');
  return spawnSync('node', [cli, ...args], { cwd: ws, encoding: 'utf8', env, timeout });
}
// A task must be seeded BEFORE the hostile config is planted: `taskctl new`
// resolves the config too, so a workspace born hostile cannot be seeded at all
// and the printed-command tests would pass for the wrong reason.
async function seedThenPoison(cleanConfig, slug, hostileConfig) {
  const ws = await makeWorkspace(cleanConfig);
  const seed = runWs(ws, ['new', slug, '--title', 'x']);
  assert.equal(seed.status, 0, `seeding ${slug} must succeed on the clean config; stderr=${seed.stderr}`);
  await writeConfig(ws, hostileConfig);
  return ws;
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. The rule
// ═══════════════════════════════════════════════════════════════════════════

test('rule: the characters a launch value legitimately needs are admitted', () => {
  const legitimate = [
    'high', 'medium', 'low', 'xhigh',            // reasoning tiers
    'claude', 'codex', 'opus', 'fake',           // engine names
    'en', 'ru', 'local', 'jira',                 // the validated enums
    'dev', 'main', 'trunk', 'develop', 'release', 'pilot-x', 'main-y',
    'experiment/grace-pilot', 'feature/CP-133_thing', 'release/1.2.3', 'origin/dev',
    '.', '/repo', 'S:/REPS/r', 'C:\\Users\\dp\\proj', '/tmp/taskctl-2b-abc123',
    'C:\\Users\\Jörg\\proj',                // a non-ASCII letter is inert to a shell
    `C:\\Users\\${String.fromCodePoint(0x5c71, 0x7530)}\\proj`, // ...in any script
    '',                                          // absent-ish: never becomes an argv element
  ];
  for (const v of legitimate) {
    assert.doesNotThrow(() => assertLaunchValue(v, { key: 'repoPath' }), `refused a legitimate value: ${JSON.stringify(v)}`);
  }
});

test('rule: every shell metacharacter class is refused, and the refusal names the character', () => {
  // One case per way a shell reads punctuation: command separators, pipes,
  // substitution, globbing, redirection, quoting, and whitespace.
  const hostile = {
    ';': 'high; id',
    '|': 'high|id',
    '&': 'high&id',
    '$': 'high$(id)',
    '`': 'high`id`',
    '*': 'high*',
    '>': 'high>out',
    '<': 'high<in',
    '(': 'high(x)',
    '"': 'high"x',
    "'": "high'x",
    '\n': 'high\nid',
    ' ': 'high id',
    '~': '~/repo',
    '%': '%PATH%',
    '^': 'high^id',
  };
  for (const [ch, value] of Object.entries(hostile)) {
    const e = throwsLaunch(() => assertLaunchValue(value, { key: 'engines.reasoningEffort' }), JSON.stringify(value));
    assert.equal(e.reason, 'character');
    assert.equal(e.character, ch, `refusal must name the offending character for ${JSON.stringify(value)}`);
  }
});

test('rule: a leading "-" is refused as ARGV injection, separately from shell syntax', () => {
  // `--repo` contains no shell metacharacter at all — every one of its characters
  // is on the allow-list — so a rule about shell syntax admits it. The two sinks
  // it reaches (gh pr create, git remote get-url) are spawned with shell:false,
  // where argument POSITION is the whole exposure. That is why this is a second
  // rule and not a wider character class, and why the fixture is deliberately
  // free of metacharacters: with one, the test would pass on the other rule.
  const e = throwsLaunch(() => assertLaunchValue('--repo', { key: 'branches.prTarget' }));
  assert.equal(e.reason, 'leading-dash');
  assert.match(e.message, /reads as a flag/);
  // A dash elsewhere in the value is fine — this is about position, not the char.
  assert.doesNotThrow(() => assertLaunchValue('release-1.2', { key: 'branches.prTarget' }));
});

test('rule: a trailing backslash is refused (it escapes the quote that would contain it)', () => {
  const e = throwsLaunch(() => assertLaunchValue('C:\\repo\\', { key: 'repoPath' }));
  assert.equal(e.reason, 'trailing-backslash');
  assert.doesNotThrow(() => assertLaunchValue('C:\\repo', { key: 'repoPath' }));
});

test('rule: absent and non-string values pass (they cannot become argv syntax)', () => {
  for (const v of [null, undefined, true, false, 42]) {
    assert.doesNotThrow(() => assertLaunchValue(v, { key: 'grace.enabled' }));
  }
});

test('refusal message: names the file, the key, the rejected character, and the destination site', () => {
  // The plan's escape route needs exactly these four to be actionable, because
  // the decision it feeds ("convert this sink to an argument array") is settled
  // per SITE. A refusal that omits the site cannot be acted on.
  const e = throwsLaunch(
    () => assertLaunchValue('high; id', { key: 'engines.reasoningEffort', where: 'S:/proj/taskctl.config.json' }),
  );
  assert.match(e.message, /engines\.reasoningEffort/, 'names the key');
  assert.match(e.message, /S:\/proj\/taskctl\.config\.json/, 'names the file to edit');
  assert.match(e.message, /";" \(U\+003B\)/, 'names the rejected character');
  assert.match(e.message, /reaches:.*shell:true/s, 'names the destination site');
});

test('refusal message: names the escape route, and the route it names is NOT "widen the rule"', () => {
  // A space under a TOKEN key: `engines.reasoningEffort` reaches
  // `-c model_reasoning_effort=<v>`, which is unquoted even inside the
  // double-quoted engine spawn, so the space is still refused there. (Under a
  // PATH key the same value is now admitted — that is the round-2 change, and it
  // is asserted separately below.)
  const e = throwsLaunch(() => assertLaunchValue('a b', { key: 'engines.reasoningEffort' }));
  assert.match(e.message, /Open an issue on taskctl-oss AGAINST THIS CHECK/,
    'the report goes against the containment, not the provider or the config');
  assert.match(e.message, /substitution, not a bypass/,
    'the one legitimate move — an equivalent identifier the rule accepts — is named');
  assert.match(e.message, /Widening the allow-list is refused/,
    'widening is explicitly refused rather than left as an implied option');
  assert.match(e.message, /no interim workaround/i,
    'the absence of an interim route is stated rather than implied');
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. The eight enumerated members, set the way each is actually supplied
// ═══════════════════════════════════════════════════════════════════════════
//
// The plan is explicit that a rule phrased over "all configured values", paired
// with tests that exercise only values invented for the test, is satisfied while
// every live route stays exactly as it is — that combination is how #22 shipped.
// So the enumeration is written into the tests, one case per member.

// The seven leaf paths, each planted in a real taskctl.config.json.
const LEAF_MEMBERS = [
  { key: 'engines.reasoningEffort', config: (v) => ({ repoPath: '.', tracker: { type: 'local' }, engines: { reasoningEffort: v } }) },
  { key: 'branches.integration', config: (v) => ({ repoPath: '.', tracker: { type: 'local' }, branches: { integration: v } }) },
  { key: 'branches.prTarget', config: (v) => ({ repoPath: '.', tracker: { type: 'local' }, branches: { integration: 'dev', prTarget: v } }) },
  { key: 'grace.repoRoot', config: (v) => ({ repoPath: '.', tracker: { type: 'local' }, grace: { enabled: true, repoRoot: v } }) },
  { key: 'grace.pilotBranch', config: (v) => ({ repoPath: '.', tracker: { type: 'local' }, grace: { enabled: true, pilotBranch: v } }) },
  { key: 'grace.upstreamBranch', config: (v) => ({ repoPath: '.', tracker: { type: 'local' }, grace: { enabled: true, upstreamBranch: v } }) },
  { key: 'repoPath', config: (v) => ({ repoPath: v, tracker: { type: 'local' } }) },
];

for (const member of LEAF_MEMBERS) {
  test(`member: a shell metacharacter in ${member.key} (project configuration) refuses the launch`, async () => {
    const dir = await mkTmp();
    try {
      // An absolute hostile value for the path-shaped members, so the refusal is
      // about the metacharacter and not about a relative path being resolved.
      const hostile = member.key.toLowerCase().includes('repo') ? '/srv/repo; id' : 'dev; id';
      await writeConfig(dir, member.config(hostile));
      const e = await refuses(() => resolveConfig(dir), member.key, 'character');
      assert.equal(e.character, ';');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('member: REPO_PATH is refused in the ENVIRONMENT, which outranks the config file', async () => {
  // A control that only writes the config file leaves this route untested:
  // config.mjs resolves `process.env.REPO_PATH ?? fileRepo`, so a hostile env
  // value wins over a clean file value and never touches the file at all.
  const dir = await mkTmp();
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REPO_PATH');
  const prev = process.env.REPO_PATH;
  try {
    await writeConfig(dir, { repoPath: '.', tracker: { type: 'local' } }); // the file is CLEAN
    process.env.REPO_PATH = '/srv/repo; id';
    const e = await refuses(() => resolveConfig(dir), 'REPO_PATH', 'character');
    assert.match(e.message, /the environment \(REPO_PATH\)/,
      'the refusal sends the reader to the environment, not to a file that does not contain the value');
  } finally {
    if (had) process.env.REPO_PATH = prev; else delete process.env.REPO_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('member: grace.repoRoot ACCEPTS a space now, and still refuses a metacharacter', async () => {
  // ROUND 2. This assertion is the inverse of the one it replaces. Round 1 refused
  // a space here because `grace lint --path <v>` was an UNQUOTED element of a
  // shell:true spawn; that spawn is now shell:false, so the element is an argument
  // and the space is just a character in a path. The metacharacter case is kept
  // beside it because the two are not the same question: shell:false removes
  // word-splitting, not the reasons the rest of the alphabet is refused.
  const dir = await mkTmp();
  try {
    await writeConfig(dir, { repoPath: '.', tracker: { type: 'local' }, grace: { enabled: true, repoRoot: '/srv/my repo' } });
    const rcfg = await resolveConfig(dir);
    assert.equal(rcfg.grace.repoRoot, '/srv/my repo', 'the space survives resolution unchanged');

    await writeConfig(dir, { repoPath: '.', tracker: { type: 'local' }, grace: { enabled: true, repoRoot: '/srv/repo; id' } });
    const e = await refuses(() => resolveConfig(dir), 'grace.repoRoot', 'character');
    assert.equal(e.character, ';');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('member: a space is admitted for PATH keys only — a token key still refuses it', async () => {
  // The rule this pins is the one the round-2 direction was explicit about: the
  // space is admitted per KEY, once every route that key travels is safe, and not
  // globally. `engines.reasoningEffort` reaches `-c model_reasoning_effort=<v>`
  // inside the engine spawn, which is the one place a configured value is still
  // joined into a command string WITHOUT surrounding quotes — so a space there
  // would still split an argument, and is still refused.
  assert.doesNotThrow(() => assertLaunchValue('C:/Users/First Last/repo', { key: 'repoPath' }));
  assert.doesNotThrow(() => assertLaunchValue('C:/Users/First Last/repo', { key: 'REPO_PATH' }));
  assert.doesNotThrow(() => assertLaunchValue('/srv/my repo', { key: 'grace.repoRoot' }));

  for (const key of ['engines.reasoningEffort', 'branches.integration', 'branches.prTarget',
                     'grace.pilotBranch', 'grace.upstreamBranch', 'engines.planner']) {
    const e = throwsLaunch(() => assertLaunchValue('a b', { key }), `space under token key ${key}`);
    assert.equal(e.character, ' ', `${key} must still refuse the space`);
  }

  // And the admission is INSIDE the path only: padding is a typo, and on Windows
  // a trailing space is honoured by some path APIs and stripped by others.
  for (const padded of [' C:/repo', 'C:/repo ']) {
    const e = throwsLaunch(() => assertLaunchValue(padded, { key: 'repoPath' }), JSON.stringify(padded));
    assert.equal(e.reason, 'edge-whitespace');
  }
});

test('member: a leading "-" in branches.prTarget is refused (sink 6 — gh pr create, shell:false)', async () => {
  const dir = await mkTmp();
  try {
    // Every character of `--repo` is on the allow-list, so only the position rule
    // can refuse it — which is the point: this is the sink where no shell runs.
    await writeConfig(dir, { repoPath: '.', tracker: { type: 'local' }, branches: { integration: 'dev', prTarget: '--repo' } });
    await refuses(() => resolveConfig(dir), 'branches.prTarget', 'leading-dash');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. The check runs on the RESOLVED value, not on the raw config field
// ═══════════════════════════════════════════════════════════════════════════

test('resolution: an install under a directory with a SPACE in it now resolves end to end', async () => {
  // ROUND 2, and this is the regression the space ban actually caused. Nothing
  // here is hostile: it is `C:/Users/First Last/…` — a taskctl installed under a
  // path with a space, which is the ordinary shape of a Windows home directory.
  // config.mjs resolves a relative grace.repoRoot against path.dirname(configPath),
  // so the directory's own space becomes part of the resolved value; round 1
  // refused that and the tool would not start at all.
  const dir = await mkTmp('taskctl p2 spaced-');   // <- the space is in the DIRECTORY
  assert.ok(dir.includes(' '), 'the fixture must actually contain a space to be evidence');
  try {
    await writeConfig(dir, {
      repoPath: path.join(dir, 'my repo'),          // a space in the configured value too
      tracker: { type: 'local' },
      grace: { enabled: true, repoRoot: 'governed' },
    });
    const rcfg = await resolveConfig(dir);
    assert.ok(rcfg.grace.repoRoot.includes(' '), 'the resolved repoRoot carries the directory prefix, space and all');
    assert.match(rcfg.grace.repoRoot, /governed$/, 'and it is the RESOLVED path, not the raw field');
    assert.ok(rcfg.repoPath.includes('my repo'), 'the configured repoPath keeps its space too');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolution: the check still runs on the RESOLVED value — a metacharacter in the config DIRECTORY is caught', async () => {
  // The evidence the test above used to carry, kept with a character that is
  // still refused. The raw field ("governed") is spotless: a validator placed on
  // it passes every other test in this file and still lets the prefix through.
  const dir = await mkTmp('taskctl-p2-semi;colon-');   // <- the ";" is in the DIRECTORY
  assert.ok(dir.includes(';'), 'the fixture must actually contain the metacharacter to be evidence');
  try {
    await writeConfig(dir, {
      repoPath: path.join(os.tmpdir(), 'taskctl-p2-clean-target'), // clean, so only the prefix can trip
      tracker: { type: 'local' },
      grace: { enabled: true, repoRoot: 'governed' },              // clean raw field
    });
    const e = await refuses(() => resolveConfig(dir), 'grace.repoRoot', 'character');
    assert.equal(e.character, ';');
    assert.match(e.value, /governed$/, 'the refused value is the RESOLVED path, prefix and all');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. The route classes
// ═══════════════════════════════════════════════════════════════════════════

// ── 4a. argv under shell:true (the engine spawn) ────────────────────────────

test('route (argv, shell:true): a hostile reasoningEffort refuses, and NO child process is created', async () => {
  // `record` is pushed by the fake adapter's buildSpawn, which spawnAI calls
  // immediately before child_process.spawn. An empty record is therefore proof
  // that no child was created, not merely that none succeeded — and the capture
  // target the replay script would have written is a second, independent witness.
  const dir = await mkTmp();
  const record = [];
  registerEngine(makeFakeEngine({ record }));
  try {
    const promptFile = path.join(dir, '.prompt-plan.md');
    await fs.writeFile(promptFile, 'x\n', 'utf8');
    const captureTarget = path.join(dir, '.capture.txt');

    await refuses(
      () => runEngineStep({ engine: 'fake', promptFile, orchRoot: dir, cwd: dir, captureTarget, reasoningEffort: 'high; id' }),
      'engines.reasoningEffort',
      'character',
    );
    assert.equal(record.length, 0, 'buildSpawn never ran ⇒ no child process was created');
    assert.equal(fsSync.existsSync(captureTarget), false, 'the replay script never ran');

    // POSITIVE CONTROL, in the same test so the two cannot drift apart: the very
    // same call with a legitimate effort DOES spawn. Without this, the assertion
    // above would also hold if the fake were simply broken.
    const ok = await quiet(() => runEngineStep({ engine: 'fake', promptFile, orchRoot: dir, cwd: dir, captureTarget, reasoningEffort: 'high' }));
    assert.equal(ok.code, 0);
    assert.equal(record.length, 1, 'the legitimate value reaches the spawn');
    assert.equal(fsSync.existsSync(captureTarget), true, 'and the child actually ran');
  } finally {
    _unregisterEngineForTest('fake');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── 4b. printed engine launch (the eight console.log(c.launchLine) sites) ───

test('route (printed engine launch): a hostile reasoningEffort prints NO launch command', async () => {
  // planner:"codex" is what puts the effort into the printed string
  // (`-c model_reasoning_effort=<value>`); the claude shape never carries it, so
  // a test run under the default planner would pass without exercising anything.
  const clean = { repoPath: '.', tracker: { type: 'local' }, engines: { planner: 'codex', reviewer: 'claude', reasoningEffort: 'medium' } };
  const ws = await seedThenPoison(clean, 'p2-print-launch', {
    ...clean, engines: { ...clean.engines, reasoningEffort: 'medium; touch /tmp/pwned' },
  });
  try {
    const r = runWs(ws, ['plan', 'p2-print-launch']);
    assert.notEqual(r.status, 0, 'the command must fail rather than print');
    assert.match(r.stderr, /engines\.reasoningEffort/, 'the refusal names the key');
    // stdout is the channel commands are printed on (console.log); the refusal
    // goes to stderr. Asserting over BOTH would be satisfied by the refusal's own
    // text, which quotes the rejected value and describes the destination site —
    // so the assertion has to be channel-specific to mean anything.
    assert.equal(r.stdout.trim(), '', 'nothing at all was printed on the command channel');
    assert.equal(/touch \/tmp\/pwned/.test(r.stdout), false, 'the injected fragment reached no printed command');

    // POSITIVE CONTROL: the same workspace with the legitimate value does print
    // the launch — so the absence above is the refusal, not a broken command.
    await writeConfig(ws, clean);
    const ok = runWs(ws, ['plan', 'p2-print-launch']);
    assert.equal(ok.status, 0, `clean plan must succeed; stderr=${ok.stderr}`);
    assert.match(ok.stdout, /codex --full-auto -s danger-full-access -c model_reasoning_effort=medium/,
      'the printed launch exists when the value is legitimate');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── 4c. printed OPERATOR command (a different code path from 4b) ────────────

test('route (printed operator command): a hostile repoPath prints NO paste-me command', async () => {
  // `taskctl review` prints an operator command carrying the repo path
  // (`review <key> --repo-path <repoPath>`) from a call-site that has nothing to
  // do with the engine-launch builder — an implementation that guards only the
  // launch builder passes 4b and fails here.
  const cleanRepo = await mkTmp('taskctl-p2-repo-');
  const clean = { repoPath: cleanRepo, tracker: { type: 'local' }, engines: { planner: 'claude', reviewer: 'codex' } };
  const ws = await seedThenPoison(clean, 'p2-print-op', { ...clean, repoPath: `${cleanRepo}; touch /tmp/pwned` });
  try {
    // Move the task to a reviewable state so cmdReview reaches its console block.
    const statePath = path.join(ws, 'ai', 'tasks', 'p2-print-op', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.stage = 'review';
    state.execution = { engine: 'claude', status: 'completed' };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['review', 'p2-print-op']);
    assert.notEqual(r.status, 0, 'the command must fail rather than print');
    assert.match(r.stderr, /repoPath/, 'the refusal names the key');
    assert.equal(r.stdout.trim(), '', 'nothing at all was printed on the command channel');
    assert.equal(/touch \/tmp\/pwned/.test(r.stdout), false, 'the injected fragment reached no printed command');

    // POSITIVE CONTROL: the clean value DOES print the operator command.
    await writeConfig(ws, clean);
    const ok = runWs(ws, ['review', 'p2-print-op']);
    assert.equal(ok.status, 0, `clean review must succeed; stderr=${ok.stderr}`);
    assert.match(ok.stdout, /review p2-print-op --repo-path/, 'the operator command exists when the value is legitimate');
  } finally {
    await fs.rm(cleanRepo, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('route (printed operator command): a repo path with a SPACE is printed QUOTED, and pastes correctly', async () => {
  // ROUND 2, the printed-command decision. These strings are not executed by us —
  // an operator pastes them into a shell we do not choose — so there is no argv
  // API to reach for. The decision taken was NOT to emit a shell-specific
  // serialization but to rely on the two shell families agreeing about the
  // restricted alphabet the check admits, and to double-quote. This test is what
  // makes that a claim rather than an assertion: it prints the command, and then
  // it actually runs the printed text through a real shell and checks that the
  // path arrived in one piece.
  const spaced = await mkTmp('taskctl p2 printed-');
  assert.ok(spaced.includes(' '), 'the fixture must actually contain a space to be evidence');
  const clean = { repoPath: spaced, tracker: { type: 'local' }, engines: { planner: 'claude', reviewer: 'codex' } };
  const ws = await seedThenPoison(clean, 'p2-print-space', clean);
  try {
    const statePath = path.join(ws, 'ai', 'tasks', 'p2-print-space', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.stage = 'review';
    state.execution = { engine: 'claude', status: 'completed' };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const r = runWs(ws, ['review', 'p2-print-space']);
    assert.equal(r.status, 0, `a spaced repo path must not refuse the launch; stderr=${r.stderr}`);

    const printed = r.stdout.match(/review p2-print-space --repo-path (\S.*)$/m);
    assert.ok(printed, `the operator command must be printed; stdout=${r.stdout}`);
    const argText = printed[1].trim();
    assert.equal(argText, `"${spaced}"`, 'the path is printed wrapped in double quotes, whole');

    // THE ACTUAL CLAIM: paste it. `node -p` prints argv[1] back, so if the shell
    // that parses this line splits the path at the space, argv[1] is a fragment
    // and the comparison fails. This is the assertion the bare form could not pass.
    const { execSync } = await import('node:child_process');
    const echoed = execSync(
      `"${process.execPath}" -p "process.argv[1]" ${argText}`,
      { encoding: 'utf8', timeout: 20000, stdio: 'pipe' },
    ).trim();
    assert.equal(echoed, spaced, 'a real shell parsed the printed argument back into the whole path');

    // SENSITIVITY: the same line WITHOUT the quotes — the form this replaced —
    // does not survive the round trip. Without this, the assertion above would
    // also pass for a path that happened to have no space in it.
    const bare = execSync(
      `"${process.execPath}" -p "process.argv[1]" ${spaced}`,
      { encoding: 'utf8', timeout: 20000, stdio: 'pipe' },
    ).trim();
    assert.notEqual(bare, spaced, 'the unquoted form really does lose part of the path');
  } finally {
    await fs.rm(spaced, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── 4d. command STRING through execSync ─────────────────────────────────────

test('route (execSync command string): a hostile branches.integration runs no git command', async () => {
  // branches.integration is concatenated into `git diff <base>...<ref>` and into
  // the worktree/fetch command strings, all of which go through execSync.
  const cleanRepo = await mkTmp('taskctl-p2-repo-');
  const clean = { repoPath: cleanRepo, tracker: { type: 'local' }, branches: { integration: 'trunk', prTarget: 'trunk' } };
  const ws = await seedThenPoison(clean, 'p2-execsync', {
    ...clean, branches: { integration: 'trunk; touch /tmp/pwned', prTarget: 'trunk' },
  });
  try {
    // Put the task in a reviewable state, or cmdReview refuses on the stage check
    // before it ever composes a diff — and then BOTH runs would print nothing and
    // the test would pass without exercising the route it names.
    const statePath = path.join(ws, 'ai', 'tasks', 'p2-execsync', 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.stage = 'review';
    state.branch = 'feature/p2-execsync';
    state.execution = { engine: 'claude', status: 'completed' };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const promptPath = path.join(ws, 'ai', 'tasks', 'p2-execsync', '.prompt-review-final.md');
    const r = runWs(ws, ['review', 'p2-execsync']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /branches\.integration/, 'the refusal names the key');
    assert.equal(r.stdout.trim(), '', 'nothing at all was printed on the command channel');
    assert.equal(/touch \/tmp\/pwned/.test(r.stdout), false, 'the injected fragment reached no command string');
    assert.equal(fsSync.existsSync(promptPath), false, 'the review never got as far as composing a diff');

    // POSITIVE CONTROL: with the legitimate branch name the same command runs the
    // diff block and writes the prompt — so the two absences above are the
    // refusal, not a command that was inert for some unrelated reason.
    await writeConfig(ws, clean);
    const ok = runWs(ws, ['review', 'p2-execsync']);
    assert.equal(ok.status, 0, `clean review must succeed; stderr=${ok.stderr}`);
    assert.equal(fsSync.existsSync(promptPath), true, 'the review reached the diff block when the value was legitimate');
  } finally {
    await fs.rm(cleanRepo, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
});

// ── 4e. the two shell-less argv sinks ───────────────────────────────────────

test('route (argv, shell:false — git remote get-url): a leading "-" repoPath is refused, not swallowed', async () => {
  // readGitRemote returns null on ANY failure by design. The check therefore has
  // to sit outside that catch, or the refusal would be reported as "no remote
  // found" and init-harness would scaffold on happily. This test is what
  // distinguishes those two outcomes.
  // `--git-dir` carries no metacharacter, so only the position rule can refuse it.
  const e = throwsLaunch(() => readGitRemote('--git-dir'));
  assert.equal(e.key, 'repoPath');
  assert.equal(e.reason, 'leading-dash');
  assert.match(e.message, /without a shell/, 'the site description says the exposure is argv position, not shell syntax');

  // POSITIVE CONTROL: a legitimate path returns normally (null or a URL — this
  // repo may or may not have an origin; either is a RETURN, not a throw).
  assert.doesNotThrow(() => readGitRemote(ORCH_ROOT));
});

test('route (grace lint): a repoRoot with a SPACE reaches the spawn as ONE argv element, with no shell', async () => {
  // ROUND 2, and this is the route the whole space ban was built around. It used
  // to be `shell: true` with `--path <repoRoot>` unquoted, so Node joined the argv
  // into one string and a space split the path in two — which is why the rule
  // refused the space rather than fixing the spawn. The spawn is fixed now, so the
  // evidence has to be about the CALL: the path is one element, unsplit, and the
  // options say shell:false. Recording the spawn is the only way to see that; a
  // test that only checked the verdict would pass with the old shell:true spawn
  // and the old ban both still in place.
  const dir = await mkTmp('taskctl p2 grace repo-');
  assert.ok(dir.includes(' '), 'the fixture must actually contain a space to be evidence');
  const calls = [];
  const recordingSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: JSON.stringify({ issues: [] }), stderr: '', error: null };
  };
  try {
    const gate = await runGraceGate(dir, 'pilot', () => 'pilot', { spawn: recordingSpawn });

    assert.equal(calls.length, 2, 'both lint profiles ran — the space did not short-circuit the gate');
    for (const call of calls) {
      assert.equal(call.cmd, 'grace');
      assert.equal(call.opts.shell, false, 'the lint spawn must not go through a shell');
      const pathIdx = call.args.indexOf('--path');
      assert.notEqual(pathIdx, -1, 'the call still passes --path');
      assert.equal(call.args[pathIdx + 1], dir,
        'the path is ONE argument, byte-identical to the configured value — not split at the space');
      // The corollary, stated as its own assertion because it is the actual claim:
      // no element is a fragment of the path.
      assert.equal(call.args.filter((a) => dir.startsWith(a) && a !== dir).length, 0,
        'no argv element is a prefix-fragment of the path');
    }
    // The LINT check is the one this test is about, and it reached a real verdict
    // rather than a skip — which is the outcome the old shell:true spawn plus the
    // old space ban could not produce for this path at all. (The gate's overall
    // verdict is not asserted: runPythonXmlGate is not stubbed here and fails on a
    // directory with no governance XMLs, which is correct and beside the point.)
    assert.equal(gate.checks.standard.status, 'pass', 'the standard lint ran and passed');
    assert.equal(gate.checks.autonomous.status, 'pass', 'the autonomous lint ran and passed');
    assert.notEqual(gate.verdict, 'skipped-no-repo', 'the spaced path was found on disk');
    assert.notEqual(gate.verdict, 'skipped-no-grace', 'and the lint spawn was not treated as unavailable');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('route (grace lint): a metacharacter in repoRoot still refuses BEFORE the not-found skip', async () => {
  // runGraceGate short-circuits to `skipped-no-repo` when the path does not
  // exist, and a path with an injected fragment almost never exists. If the check
  // sat only at the spawn, this call would return a benign skip verdict and the
  // injection attempt would be invisible. Unchanged by round 2 — shell:false
  // removes word-splitting, not the argv-position and alphabet rules.
  await refuses(() => runGraceGate('/srv/repo; id', 'pilot'), 'grace.repoRoot', 'character');
  await refuses(() => runGraceGate('/srv/repo`id`', 'pilot'), 'grace.repoRoot', 'character');

  // POSITIVE CONTROL: a legitimate but absent path still returns the skip verdict
  // it always did — the refusal has not replaced ordinary behaviour.
  const gate = await runGraceGate(path.join(os.tmpdir(), 'taskctl-p2-absent-repo'), 'pilot');
  assert.equal(gate.verdict, 'skipped-no-repo');
});

// ── 4d-bis. the routes that KEPT shell:true, and why a space is safe there ──

test('route (shell:true, double-quoted): a spaced path survives a REAL shell as one argument', async () => {
  // The engine spawn and the printed commands still go through a shell — npm ships
  // claude/codex as Windows .cmd shims, which Node 22 will not spawn without one,
  // and nothing of ours executes a printed command at all. So the space there is
  // safe by an ARGUMENT rather than by the operating system: the value sits inside
  // "…", and a space is literal inside double quotes on cmd.exe and on every POSIX
  // shell, while every character the two disagree about is refused by the
  // allow-list before it can reach this.
  //
  // An argument is worth exactly as much as its test. This runs the real thing: a
  // pre-quoted argv element, the shape engines.mjs emits, through a real
  // shell:true spawn, and asks the child what it actually received.
  const spaced = 'C:/Users/First Last/repo';
  // NOTE: process.execPath is itself quoted, and for exactly the reason under
  // test — node lives in "C:\Program Files\nodejs\" on a default Windows install,
  // so the command NAME needs the same treatment as the argument.
  const quoted = spawnSync(`"${process.execPath}"`, ['-p', 'process.argv[1]', `"${spaced}"`],
    { encoding: 'utf8', shell: true, timeout: 20000 });
  assert.equal((quoted.stdout ?? '').trim(), spaced,
    'the double-quoted element arrived whole — this is the containment the engine spawn relies on');

  // SENSITIVITY: the same value WITHOUT the quotes is truncated at the space. This
  // is what the round-1 site description meant by "UNQUOTED", and it is why the
  // assertion above is about the quoting and not about spaces being harmless.
  const bare = spawnSync(`"${process.execPath}"`, ['-p', 'process.argv[1]', spaced],
    { encoding: 'utf8', shell: true, timeout: 20000 });
  assert.notEqual((bare.stdout ?? '').trim(), spaced, 'bare really does lose the tail of the path');

  // AND THE COROLLARY the token rule exists for: `engines.reasoningEffort` is
  // interpolated as `-c model_reasoning_effort=<v>` with NO surrounding quotes, so
  // the argument above does not cover it — which is why a space is still refused
  // for that key, and why the space was admitted per-key rather than globally.
  const e = throwsLaunch(() => assertLaunchValue('a b', { key: 'engines.reasoningEffort' }));
  assert.equal(e.character, ' ');
});

test('route (printed engine launch): a spaced repoPath produces a launch string that pastes correctly', () => {
  // The other half of the same decision, on the builder rather than on the spawn.
  const spaced = 'C:/Users/First Last/repo';
  const cmd = buildLaunchCommand('codex', { repoPath: spaced, cwd: spaced, reasoningEffort: 'high' });
  assert.match(cmd, /-C "C:\/Users\/First Last\/repo"$/, 'the path is embedded quoted, whole');

  // Paste it: strip the command down to the -C argument and let a real shell parse
  // it back. The claim is about what the operator's shell does, so a string
  // comparison alone would not settle it.
  const arg = cmd.match(/-C (".*")$/)[1];
  const seen = spawnSync(`"${process.execPath}"`, ['-p', 'process.argv[1]', arg],
    { encoding: 'utf8', shell: true, timeout: 20000 });
  assert.equal((seen.stdout ?? '').trim(), spaced, 'a real shell parsed the printed argument back into the whole path');
});

// ── 4e-bis. the git worktree route (was a concatenated execSync string) ─────

test('route (git worktree): a repo path with a SPACE creates and removes a worktree for real', async () => {
  // ROUND 2, end to end and with no fakes: a real git repository under a real
  // directory whose name contains a space, driven through the real ensureWorktree
  // / removeWorktree. It is deliberately NOT a recorded-call test — the claim is
  // that git receives the path and does the thing, and the only witness that
  // cannot be faked is the worktree directory existing afterwards.
  //
  // WHAT THIS IS AND IS NOT EVIDENCE FOR, because the distinction was measured
  // rather than assumed. This test PASSES against the pre-conversion sink too:
  // the old form was `execSync(\`git worktree add "<dir>" <branch>\`)`, and the
  // quotes it already had were enough for a space. So it is NOT evidence that the
  // string→argv conversion fixed a space bug — it did not; nothing here was
  // broken by a space. What made a spaced repoPath fail END TO END was the round-1
  // rule refusing it at config resolution, and the test that is sensitive to that
  // is the resolution test above.
  //
  // This one is a REGRESSION GUARD on the converted form: it pins that the argv
  // version addresses the same path the string version did, so the conversion did
  // not quietly change which directory git operates on. The conversion's own
  // value is that correctness here no longer depends on someone remembering to
  // keep the quotes.
  const parent = await mkTmp('taskctl p2 worktree-');
  assert.ok(parent.includes(' '), 'the fixture must actually contain a space to be evidence');
  const repo = path.join(parent, 'my repo');
  try {
    await fs.mkdir(repo, { recursive: true });
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'dev');
    git('config', 'user.email', 'p2@example.invalid');
    git('config', 'user.name', 'P2');
    await fs.writeFile(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
    git('add', '-A');
    const committed = git('commit', '-q', '-m', 'seed');
    assert.equal(committed.status, 0, `the fixture repo must commit; stderr=${committed.stderr}`);

    const { _ensureWorktreeForTest, _removeWorktreeForTest } = await import('../cli.mjs');

    const wt = _ensureWorktreeForTest(repo, 'feature/spaced', 'spaced', 'dev');
    assert.ok(wt.includes(' '), 'the worktree path inherits the space');
    assert.ok(fsSync.existsSync(wt), 'the worktree directory exists — git got the whole path');
    assert.ok(fsSync.existsSync(path.join(wt, 'seed.txt')), 'and it is a real checkout, not an empty dir');

    // NEGATIVE CONTROL for the split that used to happen: the old command string
    // would have created `<parent>/taskctl` (the path truncated at the space).
    // Nothing of the sort exists.
    assert.equal(fsSync.existsSync(path.join(parent, 'taskctl')), false,
      'no directory was created from a truncated prefix of the path');

    _removeWorktreeForTest(repo, 'spaced');
    assert.equal(fsSync.existsSync(wt), false, 'and removal addressed the same path successfully');
  } finally {
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ── 4f. the shared launch-string builder ────────────────────────────────────

test('route (launch-string builder): buildLaunchCommand refuses before composing anything', () => {
  // The exported builder is reachable with an options bag that never passed
  // through normalizeRuntimeConfig — this is the second layer over that gap.
  assert.throws(() => buildLaunchCommand('codex', { repoPath: '/r', cwd: '/r', reasoningEffort: 'high; id' }), LaunchValueError);
  assert.throws(() => buildLaunchCommand('codex', { repoPath: '/r; id', cwd: '/r' }), LaunchValueError);
  // POSITIVE CONTROL: the legitimate call still produces today's exact string.
  assert.equal(
    buildLaunchCommand('codex', { repoPath: '/r', cwd: '/r', reasoningEffort: 'medium' }),
    'codex --full-auto -s danger-full-access -c model_reasoning_effort=medium -C "/r"',
  );
});

// ── 4g. artifact text (NOT the configured-value population) ─────────────────
//
// Everything above this point is about CONFIGURED values. The two tests below are
// about a value from a task ARTIFACT, which is a different population and one
// this deliverable does NOT claim to have closed. They are here because round 2
// repaired one specific artifact-sourced sink outright — cli.mjs's Jira summary,
// which interpolated plan/progress/review text into a `claude -p …` command
// string — and a repair with no test is a claim.

/**
 * Text shaped like a review note, carrying a payload that breaks out of
 * `execSync(\`claude -p ${JSON.stringify(text)}\`)` on BOTH shell families — so
 * the test means the same thing wherever it runs:
 *
 *   · cmd.exe does not honour `\"` as an escaped quote. JSON.stringify's own
 *     escaping therefore CLOSES the quoted section, and the `&` that follows is
 *     read as a command separator.
 *   · a POSIX shell does honour `\"`, so the quotes hold there — but a backtick
 *     inside double quotes is command substitution, which JSON escaping does not
 *     touch at all.
 *
 * Each half is inert on the other platform; together they cover both without the
 * test having to know which one it is on. MARKER_CMD contains no quotes and no
 * absolute path, deliberately: an injected fragment gets whatever quoting context
 * the breakout leaves behind, and one that needs its own quotes to work is a
 * payload that can fail for reasons unrelated to the vulnerability. It writes
 * relative to the child's cwd, which both callers below set to the temp dir.
 */
const MARKER_CMD = 'echo pwned > pwned.txt';
const MARKER_FILE = 'pwned.txt';

function injectionPayload() {
  return [
    'Task: CP-1',
    '--- Review notes ---',
    `Looks good overall. x" & ${MARKER_CMD} & "y`,   // cmd.exe breakout
    `Nothing else to add \`${MARKER_CMD}\``,          // POSIX breakout
  ].join('\n');
}

test('artifact injection (SENSITIVITY): the payload really does execute under the OLD command-string form', async () => {
  // This test asserts a VULNERABILITY, on purpose, and it is the reason the next
  // test is worth anything. Without it, "the marker file was not created" is
  // equally consistent with "the fix works" and with "the payload was inert on
  // this platform all along" — and the second is easy to write by accident, since
  // the two breakout mechanisms are platform-specific.
  //
  // It runs the payload through a shell the same way cli.mjs used to: a command
  // string with JSON.stringify around the interpolated text. `echo` stands in for
  // `claude` so the test needs nothing installed; the shell parsing under test is
  // identical either way — it happens before the command is ever resolved.
  const dir = await mkTmp('taskctl-p2-inject-');
  const marker = path.join(dir, MARKER_FILE);
  try {
    const payload = injectionPayload();
    try {
      const { execSync } = await import('node:child_process');
      execSync(`echo ${JSON.stringify(payload)}`, { cwd: dir, encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
    } catch { /* the breakout usually makes the whole line exit non-zero — irrelevant */ }

    assert.ok(fsSync.existsSync(marker),
      'the payload must actually execute under the old form, or the next test proves nothing. ' +
      'If this ever fails, the payload has gone stale for this platform — fix the payload, ' +
      'do not delete the test.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('artifact injection: the summary call puts artifact text on STDIN, so nothing of it is parsed', async () => {
  const { generateJiraSummary } = await import('../cli.mjs');
  const dir = await mkTmp('taskctl-p2-inject-');
  const marker = path.join(dir, MARKER_FILE);
  try {
    const payload = injectionPayload();

    // 1. THE SHAPE. Recorded, because "no marker file appeared" would also be
    //    true of a call that simply failed to run. argv must be constants only.
    const calls = [];
    generateJiraSummary(payload, {
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { status: 0, stdout: 'a generated summary, long enough to be used', stderr: '', error: null };
      },
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.cmd, 'claude');
    assert.deepEqual(call.args, ['-p', '--verbose'], 'argv is three constants — no artifact text in it');
    assert.equal(call.opts.input, payload, 'the artifact text travels on stdin instead');
    assert.equal(call.opts.shell, false, 'and the first attempt asks for no shell at all');
    for (const a of call.args) {
      assert.equal(a.includes('pwned'), false, 'no fragment of the payload reached argv');
    }

    // 2. THE OUTCOME, against a real child process. `node` is a genuine executable
    //    on every platform, so this exercises the real spawn path rather than the
    //    recorder: it reads stdin and prints it back. If any of that text were
    //    being parsed as command syntax, the marker would appear — the previous
    //    test proves this exact payload is capable of creating it.
    const echoStdin =
      'let b="";process.stdin.on("data",c=>b+=c)' +
      '.on("end",()=>process.stdout.write("received on stdin: "+b.length+" characters"))';
    const real = generateJiraSummary(payload, {
      spawn: (_cmd, _args, opts) => spawnSync(process.execPath, ['-e', echoStdin], { ...opts, cwd: dir }),
    });
    assert.match(String(real), /^received on stdin: \d+ characters$/,
      'the child received the prompt on stdin and answered');
    assert.equal(Number(String(real).match(/(\d+)/)[1]), payload.length,
      'and it received ALL of it — the whole artifact text, unsplit and unparsed');
    assert.equal(fsSync.existsSync(marker), false,
      'and NOTHING in the artifact text executed — the marker the sensitivity test just created is absent');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('artifact injection: the summary call degrades to null rather than throwing', async () => {
  // cmdPublish falls back to a progress.md extraction when this returns null, and
  // that fallback is only reachable if a failure is a RETURN. A publish must not
  // fail because a summary could not be generated.
  const { generateJiraSummary } = await import('../cli.mjs');
  const failures = [
    { status: 1, stdout: '', stderr: 'boom', error: null },
    { status: null, stdout: '', stderr: '', error: Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    { status: 0, stdout: 'short', stderr: '', error: null },   // below the length floor
  ];
  for (const outcome of failures) {
    assert.equal(generateJiraSummary('prompt', { spawn: () => outcome }), null);
  }
  assert.equal(generateJiraSummary('prompt', { spawn: () => { throw new Error('spawn exploded'); } }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. Every currently-legitimate value still passes
// ═══════════════════════════════════════════════════════════════════════════

test('no regression: this repository\'s own tracked taskctl.config.json resolves', async () => {
  const tcfg = await loadTaskctlConfig({ configRoot: ORCH_ROOT, loadEnv: false });
  assert.doesNotThrow(() => normalizeRuntimeConfig(tcfg));
});

test('no regression: the shipped example config\'s full example resolves', async () => {
  // The example file's real block is the "//--- Full example ---" object; it is
  // the closest thing this repository has to a documented maximal config, so it
  // is the right thing to hold the rule against.
  const example = JSON.parse(await fs.readFile(path.join(ORCH_ROOT, 'taskctl.config.example.json'), 'utf8'));
  const full = example['//--- Full example (Jira project; credentials + JIRA_PROJECT_KEY come from .env, never JSON) ---'];
  assert.ok(full && typeof full === 'object', 'the example must still carry a full-example block');
  const dir = await mkTmp();
  try {
    await writeConfig(dir, full);
    const rcfg = await resolveConfig(dir); // must not throw
    assert.equal(rcfg.branches.integration, 'dev');
    assert.equal(rcfg.branches.prTarget, 'dev');
    assert.equal(rcfg.engines.reasoningEffort, 'high');
    assert.equal(rcfg.tracker.assigneeEmail, 'you@example.com');
    assert.equal(rcfg.previewUrlTemplate, 'https://pr{pr}.example.com/');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('no regression: an empty config resolves to the neutral defaults', async () => {
  const dir = await mkTmp();
  try {
    await writeConfig(dir, {});
    const rcfg = await resolveConfig(dir);
    assert.equal(rcfg.branches.integration, 'dev');
    assert.equal(rcfg.engines.reasoningEffort, 'high');
    assert.equal(rcfg.grace.pilotBranch, 'experiment/grace-pilot');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('no regression: free-text config that never reaches argv keeps its punctuation', async () => {
  // The excluded keys are excluded because their values go to prompt text, an
  // HTTP body, or a URL — never to a command line. Prose there legitimately
  // contains spaces, quotes and metacharacters, and refusing it would be a
  // regression with no security benefit. Whether the exclusions are RIGHT is
  // argued in NON_LAUNCH_KEYS; this asserts they are in force.
  const dir = await mkTmp();
  try {
    await writeConfig(dir, {
      repoPath: '.',
      tracker: { type: 'local', assigneeEmail: 'someone@example.com' },
      projectContext: ['Tech stack: Node 22 & pnpm (see `README.md`)', 'Docs: https://example.com/?a=1&b=2'],
      constraints: ['PRs only — no direct commits; run `npm test` first'],
      codeAreas: { billing: ['src/billing/**/*.ts'] },
      previewUrlTemplate: 'https://pr{pr}.example.com/?ref=preview',
    });
    assert.doesNotThrow(async () => resolveConfig(dir));
    const rcfg = await resolveConfig(dir);
    assert.equal(rcfg.previewUrlTemplate, 'https://pr{pr}.example.com/?ref=preview');
    assert.equal(rcfg.tracker.assigneeEmail, 'someone@example.com');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. Fail-closed: a key added later is checked with no edit to the checker
// ═══════════════════════════════════════════════════════════════════════════

test('fail-closed: a key the site table has never heard of is CHECKED, not waved through', () => {
  // This is the property that makes the containment survive the enumeration's own
  // blind spot ("it sees one commit"). assertLaunchConfig walks the object; the
  // only way to have a key skipped is to name it in NON_LAUNCH_KEYS and say why.
  const e = throwsLaunch(() => assertLaunchConfig({ someKeyAddedNextYear: 'value; id' }, '/x/taskctl.config.json'));
  assert.equal(e.key, 'someKeyAddedNextYear');
  assert.match(e.message, /unclassified destination/,
    'and the message says the key is new rather than inventing a destination for it');
});

test('fail-closed: the walk reaches nested objects and array elements', () => {
  assert.throws(() => assertLaunchConfig({ a: { b: { c: 'x; id' } } }, '/x'), (e) => e.key === 'a.b.c');
  assert.throws(() => assertLaunchConfig({ list: ['ok', 'bad; id'] }, '/x'), (e) => e.key === 'list[1]');
});

test('fail-closed: the exclusion table is a declaration, and each entry states where the value goes instead', () => {
  // A skip list that can be extended silently is the fail-open this deliverable
  // exists to remove, so the list is pinned here: adding to it changes this test
  // and forces the reason to be written down.
  assert.deepEqual([...NON_LAUNCH_KEYS.keys()].sort(), [
    'codeAreas', 'configPath', 'constraints', 'previewUrlTemplate',
    'projectContext', 'raw', 'tracker.assigneeEmail',
  ]);
  for (const [key, reason] of NON_LAUNCH_KEYS) {
    assert.ok(reason.length > 40, `the exclusion of ${key} must state where the value goes instead`);
  }
});
