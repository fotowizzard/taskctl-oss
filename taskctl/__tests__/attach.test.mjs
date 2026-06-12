/**
 * WP3 — profiler + `taskctl attach` tests.
 *
 *  - Closed I/O boundary / GIT_QUERIES surface (C1, negative tests).
 *  - Per-ecosystem detector fixtures (literal inputs + readProfileInputs passes).
 *  - Branches/codeAreas/projectContext (incl. New-I1 non-origin remote, detached HEAD).
 *  - profileRepo / profileToConfig / renderUnderstanding + round-trip under env precedence.
 *  - Dogfood case asserting PINNED LITERALS (no equivalence claim).
 *  - attachToConfigRoot: clobber (wx) / intervening-create / force / atomic temp cleanup.
 *  - Non-invasive proof: worktree + .git byte-snapshot (lstat, no link-follow); aborted-attach
 *    zero-trace at BOTH failure points (pre-temp ENOTDIR, post-temp injected fault).
 *  - Recovery (subprocess): malformed config + `attach --force` succeeds; real tracked config untouched.
 *
 * ALL hermetic — temp dirs only; the real tracked taskctl.config.json is NEVER written.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIT_QUERIES,
  gitIsWorkTree,
  gitHeadRef,
  gitOriginHead,
  gitRemoteBranchNames,
  gitLocalBranchNames,
  parsePackageJsonSafe,
  parsePyprojectNarrow,
  parseRequirementsTxt,
  readProfileInputs,
  detectStack,
  detectPackageManager,
  detectCommands,
  detectBranches,
  detectCodeAreas,
  detectProjectContext,
  detectConventionFiles,
  detectTracker,
  detectPromptLanguage,
  profileRepo,
  profileToConfig,
  renderUnderstanding,
  attachToConfigRoot,
} from '../profiler.mjs';
import { loadTaskctlConfig, normalizeRuntimeConfig } from '../config.mjs';
import { guessCodeAreas } from '../context-builder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKCTL_DIR = path.join(ORCH_ROOT, 'taskctl');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');
const CLI = path.join(TASKCTL_DIR, 'cli.mjs');
const REAL_CONFIG_PATH = path.join(ORCH_ROOT, 'taskctl.config.json');
const DEFAULT_CONFIG_NAME = 'taskctl.config.json';

// ── temp-dir bookkeeping ────────────────────────────────────────────────────
const tmpDirs = new Set();
async function mkTmp(prefix = 'wp3-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.add(d);
  return d;
}
afterEach(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
  tmpDirs.clear();
});

// ── env snapshot/restore (Important-8: REPO_PATH precedence) ─────────────────
function snapshotEnv(keys) {
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── git fixture helper ──────────────────────────────────────────────────────
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo.replace(/\\/g, '/'), ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
async function initRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@test']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commitAll(dir, msg = 'init') {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

// ── recursive byte-snapshot using lstat (symlinks by metadata, NOT followed) ──
// I-5: each entry records lstat metadata (size, mtimeMs, mode) so a
// content-preserving metadata mutation does NOT pass unnoticed. Symlinks are
// recorded by their link target (NOT followed); dirs and files carry metadata,
// files additionally carry a content SHA-256.
function lstatMeta(st) {
  // mode includes the file-type bits + permission bits; mtimeMs catches touches.
  return `mode=${st.mode} size=${st.size} mtimeMs=${st.mtimeMs}`;
}
async function snapshotTree(root) {
  const out = {};
  async function walk(rel) {
    const abs = path.join(root, rel);
    const st = await fs.lstat(abs);
    const key = rel.replace(/\\/g, '/');
    if (st.isSymbolicLink()) {
      const target = (await fs.readlink(abs)).replace(/\\/g, '/');
      out[key] = `symlink:${target}:${lstatMeta(st)}`;
      return; // do NOT follow
    }
    if (st.isDirectory()) {
      out[key] = `dir:${lstatMeta(st)}`;
      const entries = (await fs.readdir(abs)).sort();
      for (const e of entries) await walk(path.join(rel, e));
      return;
    }
    const buf = await fs.readFile(abs);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    out[key] = `file:${lstatMeta(st)}:sha256=${sha}`;
  }
  await walk('.');
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// C1 — read-only git grammar (negative tests on the exported query surface)
// ════════════════════════════════════════════════════════════════════════════

test('C1: GIT_QUERIES has exactly the five expected keys with exact argv', () => {
  assert.deepEqual(
    Object.keys(GIT_QUERIES).sort(),
    ['headRef', 'isWorkTree', 'localBranches', 'originHead', 'remoteBranches'],
  );
  assert.deepEqual(GIT_QUERIES.isWorkTree, ['rev-parse', '--is-inside-work-tree']);
  assert.deepEqual(GIT_QUERIES.headRef, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.deepEqual(GIT_QUERIES.originHead, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  assert.deepEqual(GIT_QUERIES.remoteBranches, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  assert.deepEqual(GIT_QUERIES.localBranches, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
});

test('C1: GIT_QUERIES is DEEP-frozen (table + each inner argv array)', () => {
  assert.equal(Object.isFrozen(GIT_QUERIES), true);
  for (const v of Object.values(GIT_QUERIES)) assert.equal(Object.isFrozen(v), true);
  // mutating an inner element throws in strict mode (ESM is strict).
  assert.throws(() => { GIT_QUERIES.isWorkTree[0] = 'push'; }, TypeError);
  // pushing to an inner array throws.
  assert.throws(() => { GIT_QUERIES.headRef.push('--evil'); }, TypeError);
  // adding a new top-level key throws.
  assert.throws(() => { GIT_QUERIES.danger = ['push']; }, TypeError);
});

test('C1: only read-only verbs present; branch/remote/config ABSENT from the grammar', () => {
  const verbs = new Set(Object.values(GIT_QUERIES).map((argv) => argv[0]));
  assert.deepEqual([...verbs].sort(), ['for-each-ref', 'rev-parse', 'symbolic-ref']);
  const flat = Object.values(GIT_QUERIES).flat();
  for (const dangerous of ['branch', 'remote', 'config', 'push', 'commit', 'add', 'reset', 'checkout']) {
    assert.equal(flat.includes(dangerous), false, `'${dangerous}' must be absent from the grammar`);
  }
});

test('C1: gitRead is NOT exported (no arbitrary-argv entry point to git)', async () => {
  const mod = await import('../profiler.mjs');
  assert.equal('gitRead' in mod, false, 'gitRead must stay private');
  // Every exported git accessor takes only a repoPath (no caller argv parameter).
  for (const fn of [gitIsWorkTree, gitHeadRef, gitOriginHead, gitRemoteBranchNames, gitLocalBranchNames]) {
    assert.equal(fn.length, 1, `${fn.name} must take exactly one arg (repoPath)`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// T1 — git accessors write nothing; manifest parsers warn-and-continue
// ════════════════════════════════════════════════════════════════════════════

test('T1: git accessors return parsed values on a temp repo and WRITE NOTHING', async () => {
  const repo = await initRepo(path.join(await mkTmp(), 'repo'));
  await fs.writeFile(path.join(repo, 'a.txt'), 'hi', 'utf8');
  commitAll(repo);

  const before = await snapshotTree(repo);
  assert.equal(gitIsWorkTree(repo), true);
  const head = gitHeadRef(repo);
  assert.equal(typeof head, 'string'); // 'main' or 'master'
  assert.equal(gitOriginHead(repo), null); // no remote
  assert.deepEqual(gitRemoteBranchNames(repo), []);
  assert.ok(gitLocalBranchNames(repo).includes(head));
  const after = await snapshotTree(repo);
  assert.deepEqual(after, before, 'read-only git accessors changed the tree');
});

test('T1: gitIsWorkTree returns false (never throws) on a non-git dir', async () => {
  const dir = await mkTmp();
  assert.equal(gitIsWorkTree(dir), false);
  assert.equal(gitHeadRef(dir), null);
});

test('T1: parsePackageJsonSafe warns-and-continues on malformed/empty', () => {
  assert.deepEqual(parsePackageJsonSafe('{"name":"x"}'), { obj: { name: 'x' }, warning: null });
  assert.equal(parsePackageJsonSafe('{ not json').obj, null);
  assert.match(parsePackageJsonSafe('{ not json').warning, /not valid JSON/);
  assert.equal(parsePackageJsonSafe('').obj, null);
  assert.equal(parsePackageJsonSafe('[]').obj, null); // array is not an object manifest
});

test('T1: parsePyprojectNarrow extracts signals + names; never throws on garbage', () => {
  const text = [
    '[build-system]',
    'requires = ["setuptools"]',
    '[project]',
    'dependencies = ["fastapi>=0.1", "pydantic"]',
    '[project.optional-dependencies]',
    'dev = ["pytest", "ruff==0.1", "mypy"]',
    '[tool.pytest.ini_options]',
    '[tool.ruff]',
  ].join('\n');
  const p = parsePyprojectNarrow(text);
  assert.equal(p.buildSystem, true);
  assert.equal(p.tools.pytest, true);
  assert.equal(p.tools.ruff, true);
  assert.equal(p.tools.mypy, false);
  assert.ok(p.dependencies.includes('fastapi'));
  assert.ok(p.dependencies.includes('pytest'));
  assert.ok(p.dependencies.includes('ruff'));
  // garbage input → no throw, empty signals (no [project] section ⇒ no deps).
  const g = parsePyprojectNarrow('\x00\x01 not toml at all [[[');
  assert.equal(g.buildSystem, false);
  assert.deepEqual(g.dependencies, []);
});

test('I-2: parsePyprojectNarrow scopes deps to [project]/[project.optional-dependencies] ONLY', () => {
  // Reviewer repro: an array under an UNRELATED tool table must NOT become deps.
  const sneaky = [
    '[project]',
    'name = "svc"',
    'dependencies = ["fastapi>=0.1"]',
    '[tool.unrelated]',
    'commands = ["pytest", "ruff", "mypy"]', // MUST be ignored
    '[tool.other]',
    'requires = ["black", "isort"]',         // MUST be ignored
  ].join('\n');
  const p = parsePyprojectNarrow(sneaky);
  assert.deepEqual(p.dependencies, ['fastapi'], 'only [project] dependencies are extracted');
  for (const leaked of ['pytest', 'ruff', 'mypy', 'black', 'isort']) {
    assert.equal(p.dependencies.includes(leaked), false, `${leaked} must NOT leak from a tool table`);
  }
  // And detectCommands must therefore emit NO pytest/ruff/mypy from this file.
  const cmds = detectCommands(
    { manifests: { pyproject: p }, lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set() },
    null,
  );
  assert.equal(cmds.test, null, 'no pytest command from a tool-table array');
  assert.equal(cmds.lint, null, 'no ruff command from a tool-table array');
  assert.equal(cmds.typecheck, null, 'no mypy command from a tool-table array');

  // optional-dependencies groups DO count.
  const opt = parsePyprojectNarrow([
    '[project]', 'dependencies = ["fastapi"]',
    '[project.optional-dependencies]', 'dev = ["pytest", "mypy"]', 'lint = ["ruff"]',
  ].join('\n'));
  assert.deepEqual(opt.dependencies.sort(), ['fastapi', 'mypy', 'pytest', 'ruff'].sort());

  // MALFORMED/UNSUPPORTED structure → WARN + omit (warn-and-continue, not silent).
  const bad = parsePyprojectNarrow([
    '[project]', 'dependencies = "not-an-array"', // unsupported shape
  ].join('\n'));
  assert.match(bad.warning, /unsupported form/);
  assert.deepEqual(bad.dependencies, [], 'no signals inferred from an unsupported dependencies value');
});

test('T1: parseRequirementsTxt yields BARE names (exact, no substring false positives)', () => {
  const text = [
    '# comment',
    '-r base.txt',
    '--hash=sha256:abc',
    'pytest-cov==4.0',     // must NOT be reduced to "pytest"
    'requests >= 2.0',
    'Flask',
    'git+https://example.com/pkg.git',
    'ruff; python_version > "3.8"',
    '',
  ].join('\n');
  const names = parseRequirementsTxt(text);
  assert.deepEqual(names.sort(), ['Flask', 'pytest-cov', 'requests', 'ruff'].sort());
  assert.equal(names.includes('pytest'), false, 'must not match pytest inside pytest-cov');
});

// ════════════════════════════════════════════════════════════════════════════
// T2 — stack + package-manager + framework
// ════════════════════════════════════════════════════════════════════════════

function jsInputs({ pkg = {}, lockfiles = [], tsconfig = false } = {}) {
  return {
    manifests: { packageJson: pkg },
    lockfiles: new Set(lockfiles),
    tsconfigPresent: tsconfig,
    dirNames: new Set(),
    readme: null,
    conventionFiles: [],
  };
}

test('T2: packageManager FIELD beats a conflicting lockfile (+ warning)', () => {
  const inputs = jsInputs({
    pkg: { name: 'x', packageManager: 'pnpm@9.1.0' },
    lockfiles: ['yarn.lock'],
  });
  const { pm, warning } = detectPackageManager(inputs);
  assert.equal(pm, 'pnpm');
  assert.match(warning, /ambiguous/);
  assert.match(warning, /field says pnpm/);
});

test('T2: lockfile precedence pnpm > yarn > bun > npm; bun.lock AND bun.lockb', () => {
  assert.equal(detectPackageManager(jsInputs({ pkg: { name: 'x' }, lockfiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] })).pm, 'pnpm');
  assert.equal(detectPackageManager(jsInputs({ pkg: { name: 'x' }, lockfiles: ['bun.lock'] })).pm, 'bun');
  assert.equal(detectPackageManager(jsInputs({ pkg: { name: 'x' }, lockfiles: ['bun.lockb'] })).pm, 'bun');
  // ≥2 lockfiles → ambiguity warning even when field absent.
  assert.match(detectPackageManager(jsInputs({ pkg: { name: 'x' }, lockfiles: ['yarn.lock', 'package-lock.json'] })).warning, /multiple lockfiles/);
});

test('T2: npm default when package.json present and no lockfile/field', () => {
  assert.equal(detectPackageManager(jsInputs({ pkg: { name: 'x' } })).pm, 'npm');
});

test('T2: TS via declared typescript OR tsconfig; framework from declared deps only', () => {
  const tsByDep = detectStack(jsInputs({ pkg: { dependencies: { react: '^18' }, devDependencies: { typescript: '^5' } } }));
  assert.equal(tsByDep.language, 'typescript');
  assert.equal(tsByDep.framework, 'react');
  assert.equal(tsByDep.primary, 'node');

  const tsByConfig = detectStack(jsInputs({ pkg: { name: 'x' }, tsconfig: true }));
  assert.equal(tsByConfig.language, 'typescript');

  const jsPlain = detectStack(jsInputs({ pkg: { dependencies: { express: '^4' } } }));
  assert.equal(jsPlain.language, 'javascript');
  assert.equal(jsPlain.framework, 'express');
});

test('T2: Python via pyproject and via requirements.txt', () => {
  const pyProj = detectStack({
    manifests: { pyproject: parsePyprojectNarrow('[project]\ndependencies = ["fastapi"]') },
    lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set(),
  });
  assert.equal(pyProj.primary, 'python');
  assert.equal(pyProj.framework, 'fastapi');
  assert.equal(pyProj.language, 'python');

  const pyReq = detectStack({
    manifests: { requirements: parseRequirementsTxt('django\nrequests') },
    lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set(),
  });
  assert.equal(pyReq.primary, 'python');
  assert.equal(pyReq.framework, 'django');
});

test('T2: UNKNOWN ecosystem (no manifest) profiles cleanly with nulls', () => {
  const inputs = { manifests: {}, lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set() };
  const stack = detectStack(inputs);
  assert.deepEqual(stack, { primary: 'unknown', ecosystems: [], framework: null, language: 'unknown' });
  assert.deepEqual(detectPackageManager(inputs), { pm: null, warning: null });
  assert.deepEqual(detectCommands(inputs, null), { build: null, test: null, lint: null, typecheck: null });
});

// ════════════════════════════════════════════════════════════════════════════
// T3 — commands (declared-tool, never executed)
// ════════════════════════════════════════════════════════════════════════════

test('T3: JS script→command per package manager incl. `npm test` special-case', () => {
  const scripts = { build: 'vite build', test: 'vitest', lint: 'eslint .' };
  assert.deepEqual(detectCommands(jsInputs({ pkg: { scripts } }), 'npm'),
    { build: 'npm run build', test: 'npm test', lint: 'npm run lint', typecheck: null });
  assert.equal(detectCommands(jsInputs({ pkg: { scripts } }), 'pnpm').test, 'pnpm test');
  assert.equal(detectCommands(jsInputs({ pkg: { scripts } }), 'yarn').build, 'yarn build');
  assert.equal(detectCommands(jsInputs({ pkg: { scripts } }), 'bun').lint, 'bun run lint');
});

test('T3: typecheck = pm-local tsc --noEmit ONLY when typescript declared; null on tsconfig-only', () => {
  // typescript declared, no typecheck script → pm-local tsc.
  const tsDeclared = jsInputs({ pkg: { devDependencies: { typescript: '^5' }, scripts: {} } });
  assert.equal(detectCommands(tsDeclared, 'pnpm').typecheck, 'pnpm tsc --noEmit');
  // npm uses `npm exec -- tsc` (local binary, no network fetch), not `npx`.
  assert.equal(detectCommands(tsDeclared, 'npm').typecheck, 'npm exec -- tsc --noEmit');
  assert.equal(detectCommands(tsDeclared, 'bun').typecheck, 'bun run tsc --noEmit');
  // tsconfig present but typescript NOT declared → null (never a bare tsc guess).
  const tsconfigOnly = jsInputs({ pkg: { name: 'x', scripts: {} }, tsconfig: true });
  assert.equal(detectCommands(tsconfigOnly, 'npm').typecheck, null);
  // explicit typecheck script wins over the tsc fallback.
  const explicit = jsInputs({ pkg: { devDependencies: { typescript: '^5' }, scripts: { typecheck: 'tsc -p .' } } });
  assert.equal(detectCommands(explicit, 'npm').typecheck, 'npm run typecheck');
});

test('T3: Python pytest/ruff/mypy/build emitted ONLY when declared', () => {
  const py = parsePyprojectNarrow([
    '[build-system]', 'requires=["setuptools"]',
    '[project]', 'dependencies=["pytest","ruff","mypy"]',
  ].join('\n'));
  const cmds = detectCommands({ manifests: { pyproject: py }, lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set() }, null);
  assert.equal(cmds.test, 'pytest');
  assert.equal(cmds.lint, 'ruff check .');
  assert.equal(cmds.typecheck, 'mypy .');
  assert.equal(cmds.build, 'python -m build');

  // none declared → all null (build-system absent too).
  const bare = parsePyprojectNarrow('[project]\nname="x"');
  const cmds2 = detectCommands({ manifests: { pyproject: bare }, lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set() }, null);
  assert.deepEqual(cmds2, { build: null, test: null, lint: null, typecheck: null });

  // flake8 fallback when ruff absent.
  const flake = detectCommands({ manifests: { requirements: ['flake8'] }, lockfiles: new Set(), tsconfigPresent: false, dirNames: new Set() }, null);
  assert.equal(flake.lint, 'flake8 .');
});

test('T3: no child process is spawned for any discovered script (declared-tool rule)', async () => {
  // A "build" script that would create a sentinel file if executed; detectCommands
  // must only return the STRING, never run it.
  const repo = await initRepo(path.join(await mkTmp(), 'repo'));
  const sentinel = path.join(repo, 'SHOULD_NOT_EXIST');
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'x', scripts: { build: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, '/')}','x')"` },
  }), 'utf8');
  commitAll(repo);
  const inputs = await readProfileInputs(repo);
  const cmds = detectCommands(inputs, detectPackageManager(inputs).pm);
  assert.ok(cmds.build.includes('build') || cmds.build.includes('node'));
  assert.equal(fsSync.existsSync(sentinel), false, 'discovered script must NOT be executed');
});

// ════════════════════════════════════════════════════════════════════════════
// T4 — branches + codeAreas + projectContext + tracker/language + conventions
// ════════════════════════════════════════════════════════════════════════════

test('T4: branch fallback — origin/HEAD rung 1', () => {
  const b = detectBranches({ headRef: 'feature', originHead: 'main', remoteBranches: ['origin/main', 'origin/dev'], localBranches: ['feature'] });
  assert.equal(b.defaultBranch, 'main');
  assert.equal(b.source, 'origin/HEAD');
  assert.equal(b.integration, 'dev');
  assert.equal(b.prTarget, 'dev');
});

test('T4: branch fallback — default-name rung 2 (no origin/HEAD)', () => {
  const b = detectBranches({ headRef: 'main', originHead: null, remoteBranches: [], localBranches: ['main'] });
  assert.equal(b.defaultBranch, 'main');
  assert.equal(b.source, 'default-name');
  assert.equal(b.integration, 'main'); // no dev/develop → mirrors default
});

test('T4: branch fallback — detached HEAD (literal HEAD ⇒ skip) → rung 4 neutral + warning', () => {
  // headRef null models gitHeadRef returning null on detached HEAD.
  const b = detectBranches({ headRef: null, originHead: null, remoteBranches: [], localBranches: [] });
  assert.equal(b.defaultBranch, 'main');
  assert.equal(b.source, 'fallback');
  assert.match(b.warning, /detached HEAD or empty repo/);
});

test('T4: branch fallback — HEAD rung 3 when a real branch exists but no main/master', () => {
  const b = detectBranches({ headRef: 'work', originHead: null, remoteBranches: [], localBranches: ['work'] });
  assert.equal(b.defaultBranch, 'work');
  assert.equal(b.source, 'head');
});

test('T4: New-I1 — non-origin remote (upstream/develop) surfaces integration=develop', () => {
  const remotes = gitRemoteFromList(['upstream/develop', 'upstream/main', 'upstream/HEAD']);
  // gitRemoteBranchNames excludes the symbolic <remote>/HEAD entry.
  assert.deepEqual(remotes, ['upstream/develop', 'upstream/main']);
  const b = detectBranches({ headRef: 'develop', originHead: null, remoteBranches: remotes, localBranches: [] });
  assert.equal(b.integration, 'develop', 'bare develop from upstream/develop is in branchSet');
});

// helper mimicking gitRemoteBranchNames' HEAD-exclusion over a literal list
function gitRemoteFromList(list) {
  return list.map((s) => s.trim()).filter(Boolean).filter((n) => !/\/HEAD$/.test(n));
}

test('T4: gitOriginHead parses EXACT refs/remotes/origin/<name> suffix', async () => {
  // Build a repo with a fake origin remote + origin/HEAD symref.
  const tmp = await mkTmp();
  const origin = await initRepo(path.join(tmp, 'origin'));
  await fs.writeFile(path.join(origin, 'f.txt'), 'x', 'utf8');
  commitAll(origin);
  const def = gitHeadRef(origin); // 'main' or 'master'
  const clone = path.join(tmp, 'clone');
  const c = spawnSync('git', ['clone', '-q', origin.replace(/\\/g, '/'), clone.replace(/\\/g, '/')], { encoding: 'utf8' });
  assert.equal(c.status, 0, `clone: ${c.stderr}`);
  // origin/HEAD is set by clone; gitOriginHead must parse the <name> suffix.
  assert.equal(gitOriginHead(clone), def);
  // remote branch names carry the <remote>/ prefix and exclude origin/HEAD.
  const remotes = gitRemoteBranchNames(clone);
  assert.ok(remotes.includes(`origin/${def}`));
  assert.equal(remotes.some((r) => /\/HEAD$/.test(r)), false, 'origin/HEAD excluded');
});

test('T4: detectCodeAreas — unambiguous dirs map; ambiguous src qualified by framework', () => {
  // src/ with react framework → frontend; tests/docs/scripts unambiguous.
  const inputs = { dirNames: new Set(['src', 'tests', 'docs', 'scripts', 'supabase']) };
  const reactAreas = detectCodeAreas(inputs, 'react');
  assert.deepEqual(reactAreas.frontend, ['src/']);
  assert.deepEqual(reactAreas.tests, ['tests/']);
  assert.deepEqual(reactAreas.docs, ['docs/']);
  assert.deepEqual(reactAreas.scripts, ['scripts/']);
  assert.deepEqual(reactAreas.backend, ['supabase/']);

  // src/ with express → backend.
  assert.deepEqual(detectCodeAreas({ dirNames: new Set(['src']) }, 'express').backend, ['src/']);

  // src/ with NO framework → UNCLASSIFIED (no frontend/backend key forced).
  const noFw = detectCodeAreas({ dirNames: new Set(['src']) }, null);
  assert.equal('frontend' in noFw, false);
  assert.equal('backend' in noFw, false);
});

test('T4: codeAreas asserted THROUGH guessCodeAreas with representative task text', () => {
  const areas = detectCodeAreas({ dirNames: new Set(['src', 'docs']) }, 'react');
  // "fix the frontend button" → resolves the frontend dirs.
  assert.deepEqual(guessCodeAreas('fix the frontend button', [], areas), ['src/']);
  // "update the docs" → resolves docs.
  assert.deepEqual(guessCodeAreas('update the docs', [], areas), ['docs/']);
  // unrelated text → neutral stub (no weak keys leaked).
  assert.deepEqual(guessCodeAreas('do something else', [], areas), ['src/ (determine based on task description)']);
});

test('T4: detectProjectContext deterministic, OMIT-on-null lines 2-5', () => {
  const inputs = { readme: { name: 'README.md', text: '# My Project\n\nblah' } };
  // Full info: all lines present in fixed order.
  const full = detectProjectContext(
    inputs,
    { framework: 'react', language: 'typescript' },
    'pnpm',
    { build: 'pnpm build', test: 'pnpm test' },
  );
  assert.deepEqual(full, [
    'Project: My Project',
    'Stack: react',
    'Package manager: pnpm',
    'Build: pnpm build',
    'Tests: pnpm test',
    'See README.md for project overview.',
  ]);
  // No manifest info → lines 2-5 OMITTED; README lines (1 + 6) remain.
  const minimal = detectProjectContext(inputs, { framework: null, language: 'unknown' }, null, { build: null, test: null });
  assert.deepEqual(minimal, ['Project: My Project', 'See README.md for project overview.']);
  // README without an ATX H1 → line 1 omitted, line 6 (mandatory) remains.
  const noH1 = detectProjectContext({ readme: { name: 'README.rst', text: 'Title\n=====\n' } }, { framework: null, language: 'unknown' }, null, { build: null, test: null });
  assert.deepEqual(noH1, ['See README.rst for project overview.']);
  // No README at all → empty.
  assert.deepEqual(detectProjectContext({ readme: null }, { framework: null, language: 'unknown' }, null, { build: null, test: null }), []);
  // Stack from language when framework null.
  const langStack = detectProjectContext({ readme: null }, { framework: null, language: 'python' }, null, { build: null, test: null });
  assert.deepEqual(langStack, ['Stack: python']);
});

test('T4: tracker local, language en, convention files surfaced (not imported)', async () => {
  const repo = await initRepo(path.join(await mkTmp(), 'repo'));
  await fs.writeFile(path.join(repo, 'CLAUDE.md'), '# rules', 'utf8');
  await fs.writeFile(path.join(repo, 'CONTRIBUTING.md'), 'how', 'utf8');
  commitAll(repo);
  const inputs = await readProfileInputs(repo);
  assert.deepEqual(detectTracker(inputs), { type: 'local' });
  assert.equal(detectPromptLanguage(inputs), 'en');
  assert.deepEqual(detectConventionFiles(inputs).sort(), ['CLAUDE.md', 'CONTRIBUTING.md'].sort());
});

// ════════════════════════════════════════════════════════════════════════════
// T5 — profileRepo / profileToConfig / round-trip under env precedence + DOGFOOD
// ════════════════════════════════════════════════════════════════════════════

test('T5: round-trip under env precedence — REPO_PATH cleared/restored, EFFECTIVE values asserted', async () => {
  // Build a JS/TS fixture repo.
  const tmp = await mkTmp();
  const repo = await initRepo(path.join(tmp, 'app'));
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'app', dependencies: { react: '^18' }, devDependencies: { typescript: '^5' },
    scripts: { build: 'vite build', test: 'vitest', lint: 'eslint .' },
  }), 'utf8');
  await fs.writeFile(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf8');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(path.join(repo, 'tests'), { recursive: true });
  await fs.writeFile(path.join(repo, 'README.md'), '# App\n\nA test app.', 'utf8');
  commitAll(repo);

  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });

  const profile = await profileRepo(repo);
  const cfg = profileToConfig(profile, { configRoot });
  await fs.writeFile(path.join(configRoot, DEFAULT_CONFIG_NAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  // Round-trip: clear REPO_PATH so the file repoPath governs; restore after.
  const snap = snapshotEnv(['REPO_PATH']);
  delete process.env.REPO_PATH;
  try {
    const tcfg = await loadTaskctlConfig({ configRoot, loadEnv: false });
    const rcfg = normalizeRuntimeConfig(tcfg); // must NOT throw
    assert.equal(rcfg.repoPath, path.resolve(repo), 'effective repoPath = absolute target');
    assert.equal(rcfg.tracker.type, 'local');
    assert.equal(rcfg.branches.integration, profile.branches.integration);
    assert.equal(rcfg.branches.prTarget, profile.branches.prTarget);
    assert.deepEqual(rcfg.projectContext, profile.projectContext);
    assert.deepEqual(rcfg.constraints, []);
    assert.deepEqual(rcfg.codeAreas, profile.codeAreas);
    // sanity: detected facts landed.
    assert.equal(profile.packageManager, 'pnpm');
    assert.deepEqual(profile.codeAreas.frontend, ['src/']);
    assert.deepEqual(profile.codeAreas.tests, ['tests/']);
  } finally {
    restoreEnv(snap);
  }
});

test('T5: DOGFOOD — pinned literals on THIS repo (intentional EXPANSION, no equivalence claim)', async () => {
  // (a) Intentionally INVARIANT fields — equal to today's resolved values.
  const profile = await profileRepo(ORCH_ROOT);
  const cfg = profileToConfig(profile, { configRoot: ORCH_ROOT });

  assert.equal(cfg.repoPath, '.', 'configRoot === target ⇒ repoPath:"."');
  assert.equal(cfg.tracker.type, 'local');
  assert.equal(cfg.promptLanguage, 'en');
  assert.equal('engines' in cfg, false, 'engines OMITTED ⇒ neutral defaults');
  assert.equal('grace' in cfg, false, 'grace OMITTED ⇒ disabled, no throw');

  // The invariant fields resolve to today's values via normalize (env cleared).
  const snap = snapshotEnv(['REPO_PATH']);
  delete process.env.REPO_PATH;
  try {
    const tmpRoot = await mkTmp();
    await fs.writeFile(path.join(tmpRoot, DEFAULT_CONFIG_NAME), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    const tcfg = await loadTaskctlConfig({ configRoot: tmpRoot, loadEnv: false });
    const rcfg = normalizeRuntimeConfig(tcfg);
    // repoPath:"." resolves to the config's own dir (the sidecar tmpRoot here).
    assert.equal(rcfg.repoPath, path.resolve(tmpRoot));
    assert.equal(rcfg.tracker.type, 'local');
    assert.equal(rcfg.promptLanguage, 'en');
    assert.equal(rcfg.engines.planner, 'claude');
    assert.equal(rcfg.engines.reviewer, 'codex');
    assert.equal(rcfg.engines.reasoningEffort, 'high');
    assert.equal(rcfg.grace.enabled, false);
  } finally {
    restoreEnv(snap);
  }

  // (b) DETECTED fields — deepEqual against PINNED LITERALS (Design B(b)).
  assert.equal(cfg.branches.integration, 'main');
  assert.equal(cfg.branches.prTarget, 'main');
  assert.deepEqual(cfg.projectContext, [
    'Project: taskctl (working title — name TBD, folder renameable)',
    'See README.md for project overview.',
  ]);
  assert.deepEqual(cfg.codeAreas, { docs: ['docs/'] });
});

test('T5: renderUnderstanding includes warnings + convention files', async () => {
  const profile = await profileRepo(ORCH_ROOT);
  const text = renderUnderstanding(profile);
  assert.match(text, /Project Understanding/);
  assert.match(text, /Branches:.*integration=main/);
  // This repo has no manifest → stack-unknown warning is surfaced.
  assert.match(text, /Warnings:/);
  assert.match(text, /stack unknown/);
});

// ════════════════════════════════════════════════════════════════════════════
// T7 — isolation, clobber, atomicity, --deep, recovery
// ════════════════════════════════════════════════════════════════════════════

async function makeFixtureRepo(tmp, name = 'fixture') {
  const repo = await initRepo(path.join(tmp, name));
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name }), 'utf8');
  await fs.writeFile(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  commitAll(repo);
  return repo;
}

test('T7a: attach writes valid config; clobber refused without --force, overwritten with it', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  const outPath = path.join(configRoot, DEFAULT_CONFIG_NAME);

  const r1 = await attachToConfigRoot(repo, { configRoot, force: false });
  assert.equal(r1.outPath, outPath);
  assert.equal(fsSync.existsSync(outPath), true);
  JSON.parse(await fs.readFile(outPath, 'utf8')); // valid JSON

  // clobber without --force → TASKCTL_EXIT, file intact.
  const before = await fs.readFile(outPath, 'utf8');
  await assert.rejects(attachToConfigRoot(repo, { configRoot, force: false }), /TASKCTL_EXIT/);
  assert.equal(await fs.readFile(outPath, 'utf8'), before, 'refused attach left file intact');

  // with --force → overwrite ok, byte-identical (deterministic).
  await attachToConfigRoot(repo, { configRoot, force: true });
  assert.equal(await fs.readFile(outPath, 'utf8'), before, 'force re-attach is byte-identical');
});

test('T7a′: New-I2 intervening-create — wx open catches a file appearing at outPath', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  const outPath = path.join(configRoot, DEFAULT_CONFIG_NAME);
  // A config file already exists at outPath (the intervening create).
  await fs.writeFile(outPath, '{"pre":"existing"}', 'utf8');
  const before = await fs.readFile(outPath, 'utf8');

  await assert.rejects(attachToConfigRoot(repo, { configRoot, force: false }), /TASKCTL_EXIT/);
  assert.equal(await fs.readFile(outPath, 'utf8'), before, 'pre-existing file byte-unchanged (wx no-clobber)');
});

test('T7b: force re-attach leaves NO *.tmp sibling in configRoot', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  await attachToConfigRoot(repo, { configRoot, force: false });
  await attachToConfigRoot(repo, { configRoot, force: true });
  const leftovers = (await fs.readdir(configRoot)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no stray temp files');
});

test('T7c: attach refuses a non-existent / non-git target (via gitIsWorkTree)', async () => {
  const tmp = await mkTmp();
  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  // non-existent
  await assert.rejects(attachToConfigRoot(path.join(tmp, 'nope'), { configRoot, force: false }), /TASKCTL_EXIT/);
  // exists but not a git repo
  const plain = path.join(tmp, 'plain');
  await fs.mkdir(plain, { recursive: true });
  await assert.rejects(attachToConfigRoot(plain, { configRoot, force: false }), /TASKCTL_EXIT/);
  assert.equal(fsSync.existsSync(path.join(configRoot, DEFAULT_CONFIG_NAME)), false, 'no config written on refusal');
});

test('T7d: `attach --deep` is rejected with the reserved-flag error + non-zero exit', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  const r = spawnSync('node', [CLI, 'attach', repo.replace(/\\/g, '/'), '--deep'], {
    cwd: ORCH_ROOT, encoding: 'utf8', timeout: 30000, env: cleanEnvFor(),
  });
  assert.notEqual(r.status, 0);
  assert.match((r.stdout || '') + (r.stderr || ''), /--deep is reserved/);
});

test('T7e: C3 recovery — malformed config + `attach --force` succeeds (subprocess); real config untouched', async () => {
  const trackedBefore = await fs.readFile(REAL_CONFIG_PATH, 'utf8');

  // Build an isolated temp workspace (copy taskctl/ + ai/templates/) with a MALFORMED config.
  const ws = await mkTmp('wp3-recover-');
  await fs.cp(TASKCTL_DIR, path.join(ws, 'taskctl'), { recursive: true });
  await fs.cp(TEMPLATES_DIR, path.join(ws, 'ai', 'templates'), { recursive: true });
  await fs.writeFile(path.join(ws, DEFAULT_CONFIG_NAME), '{ this is not valid json', 'utf8');

  // A git fixture to attach to, inside the workspace.
  const fixture = await makeFixtureRepo(ws, 'recover-target');

  const wsCli = path.join(ws, 'taskctl', 'cli.mjs');
  const r = spawnSync('node', [wsCli, 'attach', fixture.replace(/\\/g, '/'), '--force'], {
    cwd: ws, encoding: 'utf8', timeout: 30000, env: cleanEnvFor(),
  });
  assert.equal(r.status, 0, `recovery attach should exit 0; stderr=${r.stderr}`);
  // The malformed file at the workspace root is replaced by a valid one.
  const replaced = await fs.readFile(path.join(ws, DEFAULT_CONFIG_NAME), 'utf8');
  JSON.parse(replaced); // must now parse

  // The REAL tracked config is byte-unchanged.
  assert.equal(await fs.readFile(REAL_CONFIG_PATH, 'utf8'), trackedBefore, 'real tracked config unchanged');
});

// Env helper for subprocess CLI runs: clear Jira + REPO_PATH + VIBE_ROOT so the
// loader cannot pull in the real repo's .env.
function cleanEnvFor(extra = {}) {
  const env = { ...process.env };
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'REPO_PATH', 'VIBE_ROOT']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

// ════════════════════════════════════════════════════════════════════════════
// T8 — non-invasive proof + per-ecosystem end-to-end
// ════════════════════════════════════════════════════════════════════════════

test('T8a: target worktree + .git are BYTE-UNCHANGED after attach', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  // Add a symlink (recorded by lstat metadata, not followed) when supported.
  try {
    await fs.symlink(path.join(repo, 'README.md'), path.join(repo, 'readme-link'));
    commitAll(repo, 'link');
  } catch { /* symlink may be unsupported; snapshot still covers the rest */ }

  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });

  const before = await snapshotTree(repo);
  await attachToConfigRoot(repo, { configRoot, force: false });
  const after = await snapshotTree(repo);
  assert.deepEqual(after, before, 'attach mutated the target tree');
});

test('T8b-pre: aborted attach BEFORE temp creation leaves zero trace (regular-file configRoot)', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  // configRoot is a REGULAR FILE → temp `wx` open under it fails with ENOTDIR
  // (reliable on Windows, unlike chmod). force:true so we reach the temp path.
  const configRoot = path.join(tmp, 'not-a-dir');
  await fs.writeFile(configRoot, 'x', 'utf8');

  const before = await snapshotTree(repo);
  await assert.rejects(attachToConfigRoot(repo, { configRoot, force: true }));
  const after = await snapshotTree(repo);
  assert.deepEqual(after, before, 'target unchanged after pre-temp failure');
  // No *.tmp sibling could have been created (configRoot is a file, not a dir).
  assert.equal(fsSync.statSync(configRoot).isFile(), true);
});

test('T8b-post: injected afterTempWrite fault exercises finally cleanup; outPath unchanged', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  const outPath = path.join(configRoot, DEFAULT_CONFIG_NAME);
  // Pre-existing outPath with KNOWN content.
  await fs.writeFile(outPath, '{"pre":"existing-known"}', 'utf8');
  const outBefore = await fs.readFile(outPath, 'utf8');

  const targetBefore = await snapshotTree(repo);
  await assert.rejects(
    attachToConfigRoot(repo, {
      configRoot, force: true,
      _faultHooks: { afterTempWrite: () => { throw new Error('injected writer/rename fault'); } },
    }),
    /injected writer\/rename fault/,
  );

  // finally removed the temp; none remain.
  const leftovers = (await fs.readdir(configRoot)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'finally cleanup removed the *.tmp sibling');
  // The pre-existing outPath is byte-UNCHANGED (the rename never ran).
  assert.equal(await fs.readFile(outPath, 'utf8'), outBefore, 'outPath untouched (rename did not run)');
  // Target still byte-identical.
  assert.deepEqual(await snapshotTree(repo), targetBefore, 'target unchanged after post-temp fault');
});

// ════════════════════════════════════════════════════════════════════════════
// I-3 — no-force partial-write recovery (unlink on body-write failure)
// ════════════════════════════════════════════════════════════════════════════

test('I-3: no-force body-write fault UNLINKS the just-created dest (no partial blocks recovery)', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp);
  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  const outPath = path.join(configRoot, DEFAULT_CONFIG_NAME);

  const targetBefore = await snapshotTree(repo);
  // Inject a fault AFTER the wx dest is created/written but BEFORE return.
  await assert.rejects(
    attachToConfigRoot(repo, {
      configRoot, force: false,
      _faultHooks: { afterDestCreate: () => { throw new Error('injected body-write fault'); } },
    }),
    /injected body-write fault/,
  );
  // The just-created dest was unlinked → NO partial file blocks a retry.
  assert.equal(fsSync.existsSync(outPath), false, 'failed no-force attach left no partial config');
  // Target untouched.
  assert.deepEqual(await snapshotTree(repo), targetBefore, 'target unchanged after no-force fault');

  // Recovery: a plain (no --force) re-attach now SUCCEEDS — nothing to clobber.
  const r = await attachToConfigRoot(repo, { configRoot, force: false });
  assert.equal(r.outPath, outPath);
  JSON.parse(await fs.readFile(outPath, 'utf8')); // valid config after recovery
});

// ════════════════════════════════════════════════════════════════════════════
// I-1 — read surface does NOT follow symlinks (outside content never read)
// ════════════════════════════════════════════════════════════════════════════

// Create a directory symlink, preferring a Windows JUNCTION (creatable without
// admin/Developer-Mode) and falling back to a 'dir' symlink. Returns false when
// neither is permitted, so the test can skip cleanly on a locked-down host.
function trySymlinkDir(target, linkPath) {
  for (const type of ['junction', 'dir']) {
    try { fsSync.symlinkSync(target, linkPath, type); return true; }
    catch { /* try next */ }
  }
  return false;
}

test('I-1: a top-level symlinked manifest is NOT read (content stays outside the profile)', async () => {
  const tmp = await mkTmp();
  // Outside dir holding a manifest whose content must NEVER reach the profile.
  const outside = path.join(tmp, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({
    name: 'STOLEN', dependencies: { 'leaked-secret-dep': '*' },
    scripts: { build: 'echo LEAKED' },
  }), 'utf8');

  const repo = await initRepo(path.join(tmp, 'repo'));
  await fs.writeFile(path.join(repo, 'README.md'), '# repo\n', 'utf8');
  // A directory symlink/junction named like a readable file? Junctions are
  // dir-only, so instead point a junction `docs` at outside and ALSO drop a
  // package.json symlink when file symlinks are permitted. The junction case
  // alone proves dir-symlink exclusion; the file-symlink case proves manifest
  // exclusion when the host allows it.
  const linkedDocs = path.join(repo, 'docs'); // would otherwise become a codeArea
  const dirLinked = trySymlinkDir(outside, linkedDocs);
  let fileLinked = false;
  try {
    fsSync.symlinkSync(path.join(outside, 'package.json'), path.join(repo, 'package.json'), 'file');
    fileLinked = true;
  } catch { /* file symlinks may be unprivileged-blocked on Windows */ }

  if (!dirLinked && !fileLinked) {
    // Neither symlink form permitted on this host → nothing to assert; skip.
    return;
  }
  commitAll(repo, 'with-symlinks');

  const inputs = await readProfileInputs(repo);
  const profile = await profileRepo(repo);

  // The symlinked package.json (if created) is excluded → no leaked manifest.
  assert.equal(inputs.manifests.packageJson, undefined, 'symlinked package.json must not be read');
  assert.equal('packageJson' in inputs.manifests, false);
  // No leaked build command from the outside manifest.
  assert.equal(profile.commands.build, null, 'no command derived from outside content');
  // The symlinked `docs` dir is NOT classified as a real code area (excluded).
  if (dirLinked) {
    assert.equal('docs' in profile.codeAreas, false, 'symlinked docs/ excluded from codeAreas');
  }
  // The exclusion is surfaced as a warning (observable, not silent).
  if (fileLinked) {
    assert.ok(
      profile.warnings.some((w) => /package\.json is a symlink; not followed/.test(w)),
      'symlinked manifest exclusion is warned',
    );
  }
  // Whatever happened, the outside content never appears in the profile output.
  const blob = JSON.stringify(profile);
  assert.equal(blob.includes('STOLEN'), false, 'outside manifest content must not leak');
  assert.equal(blob.includes('leaked-secret-dep'), false);
});

// ════════════════════════════════════════════════════════════════════════════
// C1 / I-4 — containment invariant: sidecar must not resolve inside the target
// ════════════════════════════════════════════════════════════════════════════

test('C1/I-4: equality (self-attach) is ALLOWED — config IS written at the shared root', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp, 'self'); // target === configRoot
  const outPath = path.join(repo, DEFAULT_CONFIG_NAME);
  assert.equal(fsSync.existsSync(outPath), false);

  const r = await attachToConfigRoot(repo, { configRoot: repo, force: false });
  assert.equal(r.outPath, outPath, 'self-attach writes config at the shared root');
  assert.equal(fsSync.existsSync(outPath), true, 'self-attach DID write (sanctioned dogfood alias)');
  JSON.parse(await fs.readFile(outPath, 'utf8')); // valid config
});

test('C1/I-4: descendant configRoot (inside target) is REJECTED before any write', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp, 'desc');
  const configRoot = path.join(repo, 'nested', 'sidecar'); // INSIDE the target
  await fs.mkdir(configRoot, { recursive: true });

  const before = await snapshotTree(repo);
  await assert.rejects(
    attachToConfigRoot(repo, { configRoot, force: false }),
    (e) => e.message === 'TASKCTL_EXIT',
  );
  assert.equal(
    fsSync.existsSync(path.join(configRoot, DEFAULT_CONFIG_NAME)), false,
    'no config written into a descendant configRoot',
  );
  assert.deepEqual(await snapshotTree(repo), before, 'target unchanged — rejected before write');
});

test('C1/I-4: target as ANCESTOR of configRoot is REJECTED before any write', async () => {
  const tmp = await mkTmp();
  // Parent IS a git repo; configRoot is a child dir of the parent target.
  const parent = await makeFixtureRepo(tmp, 'anc');
  const childSidecar = path.join(parent, 'child');
  await fs.mkdir(childSidecar, { recursive: true });

  const before = await snapshotTree(parent);
  await assert.rejects(
    attachToConfigRoot(parent, { configRoot: childSidecar, force: false }),
    (e) => e.message === 'TASKCTL_EXIT',
  );
  assert.equal(fsSync.existsSync(path.join(childSidecar, DEFAULT_CONFIG_NAME)), false);
  assert.deepEqual(await snapshotTree(parent), before, 'ancestor target unchanged — rejected before write');
});

test('C1/I-4: configRoot SYMLINK resolving INTO the target is REJECTED (canonical containment)', async () => {
  const tmp = await mkTmp();
  const repo = await makeFixtureRepo(tmp, 'symt');
  const realInside = path.join(repo, 'real-sidecar'); // a real dir INSIDE the target
  await fs.mkdir(realInside, { recursive: true });
  // A symlink/junction OUTSIDE the target that resolves to realInside.
  const linkOutside = path.join(tmp, 'sidecar-link');
  if (!trySymlinkDir(realInside, linkOutside)) {
    return; // host forbids both junction and dir symlink → skip
  }

  const before = await snapshotTree(repo);
  await assert.rejects(
    attachToConfigRoot(repo, { configRoot: linkOutside, force: false }),
    (e) => e.message === 'TASKCTL_EXIT',
    'a configRoot symlink whose realpath is inside the target must be rejected',
  );
  // Nothing written through the link into the target's real-sidecar.
  assert.equal(fsSync.existsSync(path.join(realInside, DEFAULT_CONFIG_NAME)), false);
  assert.deepEqual(await snapshotTree(repo), before, 'target unchanged — symlink alias rejected before write');
});

test('C1/I-4: a genuinely-OUTSIDE sibling configRoot still WRITES (no false-positive containment)', async () => {
  const tmp = await mkTmp();
  // `repo` and `repo-sidecar` share a path PREFIX but neither contains the other;
  // a string-prefix check would wrongly reject — path-segment containment must not.
  const repo = await makeFixtureRepo(tmp, 'repo');
  const sibling = path.join(tmp, 'repo-sidecar');
  await fs.mkdir(sibling, { recursive: true });
  const r = await attachToConfigRoot(repo, { configRoot: sibling, force: false });
  assert.equal(r.outPath, path.join(sibling, DEFAULT_CONFIG_NAME));
  assert.equal(fsSync.existsSync(r.outPath), true, 'prefix-sharing sibling is OUTSIDE → write allowed');
});

test('T8c: JS/TS fixture end-to-end — valid config, expected branches/codeAreas/projectContext, round-tripped', async () => {
  const tmp = await mkTmp();
  const repo = await initRepo(path.join(tmp, 'web'));
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'web', dependencies: { next: '^14' }, devDependencies: { typescript: '^5' },
    scripts: { build: 'next build', test: 'vitest', lint: 'eslint .' },
  }), 'utf8');
  await fs.writeFile(path.join(repo, 'yarn.lock'), '# yarn', 'utf8');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
  await fs.writeFile(path.join(repo, 'README.md'), '# Web App\n', 'utf8');
  commitAll(repo);
  // create a dev branch so integration resolves to it.
  git(repo, ['branch', 'dev']);

  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  const { cfg, profile } = await attachToConfigRoot(repo, { configRoot, force: false });

  assert.equal(profile.stack.framework, 'next');
  assert.equal(profile.packageManager, 'yarn');
  assert.equal(cfg.branches.integration, 'dev');
  assert.deepEqual(cfg.codeAreas.frontend, ['src/']);
  assert.deepEqual(cfg.codeAreas.docs, ['docs/']);
  // codeAreas verified through guessCodeAreas.
  assert.deepEqual(guessCodeAreas('fix the frontend layout', [], cfg.codeAreas), ['src/']);
  assert.equal(cfg.tracker.type, 'local');
  assert.equal(cfg.promptLanguage, 'en');
  assert.ok(cfg.projectContext.includes('Project: Web App'));
  assert.ok(cfg.projectContext.includes('Stack: next'));

  // round-trip.
  const snap = snapshotEnv(['REPO_PATH']);
  delete process.env.REPO_PATH;
  try {
    const tcfg = await loadTaskctlConfig({ configRoot, loadEnv: false });
    assert.doesNotThrow(() => normalizeRuntimeConfig(tcfg));
  } finally {
    restoreEnv(snap);
  }
});

test('T8c: Python fixture end-to-end — valid config, python stack, round-tripped', async () => {
  const tmp = await mkTmp();
  const repo = await initRepo(path.join(tmp, 'svc'));
  await fs.writeFile(path.join(repo, 'pyproject.toml'), [
    '[build-system]', 'requires = ["setuptools"]',
    '[project]', 'name = "svc"', 'dependencies = ["fastapi"]',
    '[project.optional-dependencies]', 'dev = ["pytest", "ruff", "mypy"]',
    '[tool.pytest.ini_options]',
  ].join('\n'), 'utf8');
  await fs.mkdir(path.join(repo, 'tests'), { recursive: true });
  await fs.mkdir(path.join(repo, 'api'), { recursive: true });
  await fs.writeFile(path.join(repo, 'README.md'), '# Service\n', 'utf8');
  commitAll(repo);

  const configRoot = path.join(tmp, 'sidecar');
  await fs.mkdir(configRoot, { recursive: true });
  const { cfg, profile } = await attachToConfigRoot(repo, { configRoot, force: false });

  assert.equal(profile.stack.primary, 'python');
  assert.equal(profile.stack.framework, 'fastapi');
  assert.equal(profile.commands.test, 'pytest');
  assert.equal(profile.commands.lint, 'ruff check .');
  assert.equal(profile.commands.typecheck, 'mypy .');
  assert.equal(profile.commands.build, 'python -m build');
  assert.deepEqual(cfg.codeAreas.tests, ['tests/']);
  assert.deepEqual(cfg.codeAreas.api, ['api/']);
  assert.ok(cfg.projectContext.includes('Project: Service'));
  assert.ok(cfg.projectContext.includes('Stack: fastapi'));

  const snap = snapshotEnv(['REPO_PATH']);
  delete process.env.REPO_PATH;
  try {
    const tcfg = await loadTaskctlConfig({ configRoot, loadEnv: false });
    assert.doesNotThrow(() => normalizeRuntimeConfig(tcfg));
  } finally {
    restoreEnv(snap);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Live CLI smoke (in-test): attach via the real cli.mjs against a copied workspace
// ════════════════════════════════════════════════════════════════════════════

test('CLI: `attach <repo>` prints Project Understanding + writes config in the workspace', async () => {
  // Isolated workspace copy so the CLI's ORCHESTRATION_ROOT-derived config path
  // points at the COPY (never the real tracked config).
  const ws = await mkTmp('wp3-cli-');
  await fs.cp(TASKCTL_DIR, path.join(ws, 'taskctl'), { recursive: true });
  await fs.cp(TEMPLATES_DIR, path.join(ws, 'ai', 'templates'), { recursive: true });
  // No config in the copy yet.
  const fixture = await makeFixtureRepo(ws, 'cli-target');

  const trackedBefore = await fs.readFile(REAL_CONFIG_PATH, 'utf8');
  const wsCli = path.join(ws, 'taskctl', 'cli.mjs');
  const r = spawnSync('node', [wsCli, 'attach', fixture.replace(/\\/g, '/')], {
    cwd: ws, encoding: 'utf8', timeout: 30000, env: cleanEnvFor(),
  });
  assert.equal(r.status, 0, `attach exit 0; stderr=${r.stderr}`);
  assert.match(r.stdout, /Project Understanding/);
  assert.match(r.stdout, /wrote .*taskctl\.config\.json/);
  // Config landed in the COPY's root.
  const written = path.join(ws, DEFAULT_CONFIG_NAME);
  assert.equal(fsSync.existsSync(written), true);
  JSON.parse(await fs.readFile(written, 'utf8'));

  // Real tracked config untouched.
  assert.equal(await fs.readFile(REAL_CONFIG_PATH, 'utf8'), trackedBefore, 'real config unchanged');

  // Re-attach without --force → clobber refusal, non-zero.
  const r2 = spawnSync('node', [wsCli, 'attach', fixture.replace(/\\/g, '/')], {
    cwd: ws, encoding: 'utf8', timeout: 30000, env: cleanEnvFor(),
  });
  assert.notEqual(r2.status, 0);
  assert.match((r2.stdout || '') + (r2.stderr || ''), /already exists/);

  // --force → overwrite ok.
  const r3 = spawnSync('node', [wsCli, 'attach', fixture.replace(/\\/g, '/'), '--force'], {
    cwd: ws, encoding: 'utf8', timeout: 30000, env: cleanEnvFor(),
  });
  assert.equal(r3.status, 0, `force attach exit 0; stderr=${r3.stderr}`);
});
