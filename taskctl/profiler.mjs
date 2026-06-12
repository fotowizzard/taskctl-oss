/**
 * taskctl/profiler.mjs — deterministic, strictly READ-ONLY repository profiler.
 *
 * WP3 deliverable: derive a valid `taskctl.config.json` (the WP2 schema) from a
 * target repo BY ANALYSIS — no network, no LLM, no mutation of the target.
 *
 * Two load-bearing guarantees are proven BY CONSTRUCTION (not just by snapshot):
 *
 *  1. NON-INVASIVE — the target worktree + `.git` are byte-unchanged after a
 *     profile/attach, and an aborted attach leaves zero trace in the target.
 *     This is enforced by a CLOSED I/O BOUNDARY:
 *       • a read-only fs surface (readdir/readFile/stat/lstat only — no write*,
 *         no mkdir, no rm, no open-for-write anywhere in this module's read path);
 *       • an EXACT-COMMAND-SHAPE git wrapper. The only git invocations the
 *         profiler can make are the fixed argv arrays in `GIT_QUERIES`. There is
 *         NO `argv` parameter on the public surface and `gitRead` is PRIVATE, so
 *         a mutating git invocation is simply not expressible.
 *  2. RECOVERABLE — `attachToConfigRoot` writes ONLY to the orchestration
 *     workspace (the sidecar `configRoot`), never the target; and `cli.mjs`
 *     dispatches `attach` BEFORE any runtime-config load so a broken config can
 *     be replaced with `--force`.
 *
 * Detectors are PURE functions over already-read inputs (file contents, git
 * output strings, a one-level directory listing). `readProfileInputs` is the
 * single auditable function that performs I/O.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG_NAME = 'taskctl.config.json';

// Cap on how much of a README we read (deterministic H1 extraction needs only
// the first heading; we never truncate the H1 itself, only how far we scan).
const README_READ_CAP_BYTES = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// A.1 — The exact-command-shape git wrapper (the core of the non-invasive guard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively freeze an object and every array/object value it holds.
 * Object.freeze is SHALLOW, so a "frozen" table whose inner argv arrays are
 * still mutable would be a lie — deep-freeze removes the overload surface.
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const value of Object.values(obj)) deepFreeze(value);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * The ONLY git invocations the profiler can make. Each is a fully-formed,
 * READ-ONLY command shape — a fixed argv array. No value interpolation, no
 * flags from caller input. DEEP-FROZEN (the table AND each inner array).
 *
 * The grammar is closed on two axes:
 *   (1) the only permitted top-level verbs are `rev-parse`, `symbolic-ref`, and
 *       `for-each-ref` — mutating verbs (`branch -D`, `remote add`, `config k v`)
 *       are simply ABSENT, not reachable;
 *   (2) for those three verbs there is no caller-supplied argv, so a mutating
 *       overload of the same verb is also not expressible.
 *
 * Exported as a read-only DATA constant for the negative tests (assert keys +
 * exact argv + frozen-ness). Exporting the data does NOT widen the execution
 * surface: `gitRead` (the only function that spawns argv) is PRIVATE.
 */
export const GIT_QUERIES = deepFreeze({
  isWorkTree:     ['rev-parse', '--is-inside-work-tree'],
  headRef:        ['rev-parse', '--abbrev-ref', 'HEAD'],            // 'HEAD' literal ⇒ detached
  originHead:     ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
  remoteBranches: ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], // ALL remotes (New-I1)
  localBranches:  ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
  // (remote get-url origin) is NOT needed by any detector and is NOT included.
});

/**
 * PRIVATE. Spawn `git -C <repoPath> <fixedArgv>` with shell:false. `fixedArgv`
 * comes ONLY from GIT_QUERIES — never from a caller string. Never throws:
 * catches a spawn error / non-zero exit and reports it via the return value.
 *
 * @param {string} repoPath
 * @param {readonly string[]} fixedArgv  one of the GIT_QUERIES values
 * @returns {{ ok: boolean, stdout: string, code: number|null }}
 */
function gitRead(repoPath, fixedArgv) {
  // git -C accepts native separators on Windows; forward-slash the path so the
  // call is identical across platforms.
  const cwdArg = String(repoPath).replace(/\\/g, '/');
  let r;
  try {
    r = spawnSync('git', ['-C', cwdArg, ...fixedArgv], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
  } catch {
    return { ok: false, stdout: '', code: null };
  }
  if (r.error || r.status !== 0) {
    return { ok: false, stdout: r.stdout ?? '', code: r.status ?? null };
  }
  return { ok: true, stdout: r.stdout ?? '', code: 0 };
}

/**
 * Is `repoPath` inside a git work tree? Read-only; never throws.
 * @param {string} repoPath
 * @returns {boolean}
 */
export function gitIsWorkTree(repoPath) {
  const r = gitRead(repoPath, GIT_QUERIES.isWorkTree);
  return r.ok && r.stdout.trim() === 'true';
}

/**
 * Current branch short name, or null when detached (literal `HEAD`) or git fails.
 * @param {string} repoPath
 * @returns {string|null}
 */
export function gitHeadRef(repoPath) {
  const r = gitRead(repoPath, GIT_QUERIES.headRef);
  if (!r.ok) return null;
  const ref = r.stdout.trim();
  if (!ref || ref === 'HEAD') return null; // detached HEAD ⇒ no branch
  return ref;
}

/**
 * Default branch parsed from `refs/remotes/origin/HEAD`, or null. EXACT suffix
 * parse of `refs/remotes/origin/<name>` (or the short form `origin/<name>`),
 * not a blind 'origin/' strip.
 * @param {string} repoPath
 * @returns {string|null}
 */
export function gitOriginHead(repoPath) {
  const r = gitRead(repoPath, GIT_QUERIES.originHead);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  if (!out) return null;
  // git symbolic-ref --quiet refs/remotes/origin/HEAD prints the full ref path,
  // e.g. "refs/remotes/origin/main". Some shells/versions print the short form.
  let m = out.match(/^refs\/remotes\/origin\/(.+)$/);
  if (m) return m[1];
  m = out.match(/^origin\/(.+)$/);
  if (m) return m[1];
  return null;
}

/**
 * Remote branch SHORT names across ALL remotes (New-I1): each entry is
 * `<remote>/<branch>` (e.g. 'origin/dev', 'upstream/develop'). Symbolic
 * `<remote>/HEAD` entries are EXCLUDED.
 * @param {string} repoPath
 * @returns {string[]}
 */
export function gitRemoteBranchNames(repoPath) {
  const r = gitRead(repoPath, GIT_QUERIES.remoteBranches);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    // Exclude the symbolic '<remote>/HEAD' pointer (e.g. 'origin/HEAD').
    .filter((name) => !/\/HEAD$/.test(name));
}

/**
 * Local branch short names (refs/heads/*).
 * @param {string} repoPath
 * @returns {string[]}
 */
export function gitLocalBranchNames(repoPath) {
  const r = gitRead(repoPath, GIT_QUERIES.localBranches);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// A.5 — Defensive manifest parsing (warn-and-continue, never throw)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} text  raw package.json text
 * @returns {{ obj: object|null, warning: string|null }}
 */
export function parsePackageJsonSafe(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { obj: null, warning: 'package.json present but empty/unreadable' };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { obj, warning: null };
    return { obj: null, warning: 'package.json is not a JSON object' };
  } catch {
    return { obj: null, warning: 'package.json present but not valid JSON (ignored)' };
  }
}

/**
 * Deliberately NARROW structured extraction of the small set of pyproject
 * signals we use — no TOML dependency added. Anything we cannot parse ⇒ that
 * signal is omitted; never throws.
 *
 * @param {string} text  raw pyproject.toml text
 * @returns {{
 *   buildSystem: boolean,
 *   tools: { pytest: boolean, ruff: boolean, mypy: boolean },
 *   dependencies: string[],
 *   warning: string|null,
 * }}
 */
export function parsePyprojectNarrow(text) {
  const empty = {
    buildSystem: false,
    tools: { pytest: false, ruff: false, mypy: false },
    dependencies: [],
    warning: null,
  };
  if (typeof text !== 'string' || text.trim() === '') {
    return { ...empty, warning: 'pyproject.toml present but empty/unreadable' };
  }

  const lines = text.split(/\r?\n/);
  const buildSystem = /^\s*\[build-system\]/m.test(text);
  const tools = {
    pytest: /^\s*\[tool\.pytest(\.[^\]]*)?\]/m.test(text),
    ruff: /^\s*\[tool\.ruff(\.[^\]]*)?\]/m.test(text),
    mypy: /^\s*\[tool\.mypy(\.[^\]]*)?\]/m.test(text),
  };

  // I-2: SECTION-SCOPED dependency extraction. Names are pulled ONLY from
  //   • `[project]`                      → the `dependencies = [...]` array, and
  //   • `[project.optional-dependencies]`→ each `<group> = [...]` array.
  // Any other section ([tool.*], [build-system], arbitrary tables) contributes
  // NOTHING — a `commands = ["pytest", ...]` under `[tool.unrelated]` must not be
  // read as dependencies. Malformed/unsupported structure (a `dependencies` key
  // that is not an inline array, or an array that never closes) → warn + omit.
  const deps = new Set();
  let section = null;      // current table name, e.g. 'project.optional-dependencies'
  let inDepArray = false;  // inside a multi-line dependency array we opened in-scope
  let malformed = false;
  // Section in which we ACCEPT array keys as dependency groups.
  const inProject = () => section === 'project';
  const inOptional = () => section === 'project.optional-dependencies';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      inDepArray = false; // any new table closes an in-scope array context
      continue;
    }

    // Continuation lines of an array we already opened (only ever set in-scope).
    if (inDepArray) {
      for (const name of extractRequirementNames(line)) deps.add(name);
      if (/\]/.test(line)) inDepArray = false;
      continue;
    }

    // Key lines only matter inside the two in-scope sections.
    if (inProject()) {
      const m = line.match(/^dependencies\s*=\s*(.*)$/);
      if (m) {
        const rhs = m[1].trim();
        if (!rhs.startsWith('[')) {
          // e.g. `dependencies = "oops"` or a form we do not parse → warn + omit.
          malformed = true;
          continue;
        }
        for (const name of extractRequirementNames(line)) deps.add(name);
        inDepArray = !/\]/.test(line); // stays open until the closing bracket
      }
      continue;
    }

    if (inOptional()) {
      // `<group> = [ ... ]` — any inline-array key is an optional-dependency group.
      const m = line.match(/^[\w.-]+\s*=\s*(.*)$/);
      if (m) {
        const rhs = m[1].trim();
        if (!rhs.startsWith('[')) {
          malformed = true;
          continue;
        }
        for (const name of extractRequirementNames(line)) deps.add(name);
        inDepArray = !/\]/.test(line);
      }
      continue;
    }
    // Any other section: ignore entirely (declared-tool-only invariant).
  }

  const warning = malformed
    ? 'pyproject.toml dependencies in an unsupported form; some signals omitted'
    : null;
  return { buildSystem, tools, dependencies: [...deps], warning };
}

/** Pull bare distribution names from any quoted requirement strings on a line. */
function extractRequirementNames(line) {
  const names = [];
  const re = /["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const bare = bareDistName(m[1]);
    if (bare) names.push(bare);
  }
  return names;
}

/**
 * `requirements.txt` → package NAMES only. Strips blank lines, `#` comments,
 * `-r/-c/--option` lines and URL/VCS specs; splits each remaining line on the
 * FIRST version/marker delimiter to get the bare distribution name (so we match
 * exact names, not substrings — 'pytest' must not match inside 'pytest-cov').
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseRequirementsTxt(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('-')) continue; // -r / -c / --hash / --option
    // strip an inline comment ( ` # ...` )
    const hashIdx = line.indexOf(' #');
    if (hashIdx !== -1) line = line.slice(0, hashIdx).trim();
    if (!line) continue;
    // URL / VCS / local path specs — no bare name to extract reliably.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(line) || line.includes('@ ') || line.includes(' @')) continue;
    const bare = bareDistName(line);
    if (bare) names.push(bare);
  }
  return names;
}

/** Reduce a requirement spec to its bare distribution name. */
function bareDistName(spec) {
  // split on the FIRST of < > = ! ~ ; space ( ) [ ] , to drop version/markers/extras
  const name = String(spec).split(/[<>=!~;,()\[\]\s]/)[0].trim();
  return name || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// A.2 — The read-only fs surface
// ─────────────────────────────────────────────────────────────────────────────

const README_RE = /^readme(\.[a-z0-9]+)?$/i;
const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'];
const KNOWN_LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
]);

/**
 * Gather raw inputs via the read-only fs surface (readdir/readFile/lstat ONLY)
 * + the A.1 git accessors. Scans ONE directory level (no recursion). Defensive:
 * manifest parse failures accrue to `warnings`, never throw.
 *
 * @param {string} repoPath
 * @returns {Promise<object>} the `inputs` bundle (see shape below)
 */
export async function readProfileInputs(repoPath) {
  const resolved = path.resolve(repoPath);
  const warnings = [];

  /** @type {Array<{name:string,isDir:boolean,isSymlink:boolean}>} */
  let topLevel = [];
  let exists = false;
  try {
    const ents = await fs.readdir(resolved, { withFileTypes: true });
    exists = true;
    topLevel = ents.map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  } catch {
    // Non-existent / unreadable target: return a minimal inputs object. Target
    // validation (gitIsWorkTree) in cmdAttach fails closed separately.
    return {
      repoPath: resolved,
      exists: false,
      isGit: false,
      topLevel: [],
      manifests: {},
      lockfiles: new Set(),
      readme: null,
      conventionFiles: [],
      tsconfigPresent: false,
      git: { headRef: null, originHead: null, remoteBranches: [], localBranches: [] },
      warnings,
    };
  }

  // I-1: NO symlink follow. Classify via the lstat-backed `isSymlink` flag and
  // read ONLY verified REGULAR files / traverse ONLY real dirs beneath the
  // canonical target. A symlink/junction (even one whose target happens to be a
  // regular file or dir) is excluded from BOTH readable sets, so a crafted repo
  // cannot make attach `readFile` content outside the target. On Windows a
  // directory junction reports isDirectory()=false AND isSymbolicLink()=true, so
  // the symlink exclusion (not the isDir test) is what keeps it out of fileNames.
  const symlinkNames = new Set(topLevel.filter((e) => e.isSymlink).map((e) => e.name));
  const fileNames = new Set(topLevel.filter((e) => !e.isDir && !e.isSymlink).map((e) => e.name));
  const dirNames = new Set(topLevel.filter((e) => e.isDir && !e.isSymlink).map((e) => e.name));

  // Surface (do not read) any top-level symlink that shadows a name we would
  // otherwise consume, so the no-follow exclusion is observable to the user.
  const READABLE_BY_NAME = (n) =>
    n === 'package.json' || n === 'pyproject.toml' || n === 'requirements.txt' ||
    n === 'tsconfig.json' || README_RE.test(n) || CONVENTION_FILES.includes(n) ||
    KNOWN_LOCKFILES.has(n);
  for (const n of symlinkNames) {
    if (READABLE_BY_NAME(n)) {
      warnings.push(`${n} is a symlink; not followed (read-only target boundary)`);
    }
  }

  // Manifests (parsed defensively).
  const manifests = {};
  if (fileNames.has('package.json')) {
    const text = await safeReadFile(path.join(resolved, 'package.json'));
    const { obj, warning } = parsePackageJsonSafe(text ?? '');
    if (warning) warnings.push(warning);
    if (obj) manifests.packageJson = obj;
  }
  if (fileNames.has('pyproject.toml')) {
    const text = await safeReadFile(path.join(resolved, 'pyproject.toml'));
    const parsed = parsePyprojectNarrow(text ?? '');
    if (parsed.warning) warnings.push(parsed.warning);
    manifests.pyproject = parsed;
  }
  if (fileNames.has('requirements.txt')) {
    const text = await safeReadFile(path.join(resolved, 'requirements.txt'));
    manifests.requirements = parseRequirementsTxt(text ?? '');
  }

  // Lockfiles present at top level.
  const lockfiles = new Set([...fileNames].filter((n) => KNOWN_LOCKFILES.has(n)));

  // tsconfig presence (a TS signal independent of a declared `typescript` dep).
  const tsconfigPresent = fileNames.has('tsconfig.json');

  // README (first README.* by sorted name, capped read).
  let readme = null;
  const readmeName = [...fileNames].filter((n) => README_RE.test(n)).sort()[0];
  if (readmeName) {
    const text = await safeReadFile(path.join(resolved, readmeName), README_READ_CAP_BYTES);
    if (text != null) readme = { name: readmeName, text };
    else warnings.push(`${readmeName} present but unreadable`);
  }

  // Convention files (exact names; surfaced in summary, not imported).
  const conventionFiles = CONVENTION_FILES.filter((n) => fileNames.has(n));

  // Git (via A.1 accessors — read-only, never throw).
  const isGit = gitIsWorkTree(resolved);
  const git = {
    headRef: gitHeadRef(resolved),
    originHead: gitOriginHead(resolved),
    remoteBranches: gitRemoteBranchNames(resolved),
    localBranches: gitLocalBranchNames(resolved),
  };

  return {
    repoPath: resolved,
    exists,
    isGit,
    topLevel,
    dirNames,
    fileNames,
    manifests,
    lockfiles,
    readme,
    conventionFiles,
    tsconfigPresent,
    git,
    warnings,
  };
}

/** Read a file as utf8, optionally capping length; null on any read error. */
async function safeReadFile(filePath, capBytes) {
  try {
    if (capBytes) {
      const buf = await fs.readFile(filePath);
      return buf.subarray(0, capBytes).toString('utf8');
    }
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A.3 — Stack / package-manager / framework (registry-driven)
// ─────────────────────────────────────────────────────────────────────────────

/** All declared dependency names (deps + devDeps + peer) from package.json. */
function jsDeclaredDeps(pkg) {
  const out = {};
  for (const block of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const d = pkg?.[block];
    if (d && typeof d === 'object') Object.assign(out, d);
  }
  return out;
}

const JS_FRAMEWORK_ORDER = [
  ['next', 'next'],
  ['react', 'react'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['@angular/core', 'angular'],
  ['@nestjs/core', 'nest'],
  ['express', 'express'],
  ['fastify', 'fastify'],
];

const PY_FRAMEWORK_ORDER = [
  ['fastapi', 'fastapi'],
  ['django', 'django'],
  ['flask', 'flask'],
];

const jsEcosystem = {
  id: 'node',
  detect: (inputs) => !!inputs.manifests.packageJson,
  profile: (inputs) => {
    const pkg = inputs.manifests.packageJson;
    const deps = jsDeclaredDeps(pkg);
    const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
    let framework = null;
    for (const [dep, name] of JS_FRAMEWORK_ORDER) {
      if (has(dep)) { framework = name; break; }
    }
    const isTs = has('typescript') || inputs.tsconfigPresent;
    return {
      stack: 'node',
      framework,
      language: isTs ? 'typescript' : 'javascript',
    };
  },
};

const pythonEcosystem = {
  id: 'python',
  detect: (inputs) => !!inputs.manifests.pyproject || Array.isArray(inputs.manifests.requirements),
  profile: (inputs) => {
    const names = pythonDeclaredNames(inputs);
    let framework = null;
    for (const [dep, name] of PY_FRAMEWORK_ORDER) {
      if (names.has(dep)) { framework = name; break; }
    }
    return { stack: 'python', framework, language: 'python' };
  },
};

/** Lower-cased set of declared Python distribution names (pyproject + requirements). */
function pythonDeclaredNames(inputs) {
  const names = new Set();
  const py = inputs.manifests.pyproject;
  if (py) for (const d of py.dependencies) names.add(String(d).toLowerCase());
  const req = inputs.manifests.requirements;
  if (Array.isArray(req)) for (const d of req) names.add(String(d).toLowerCase());
  return names;
}

/** Ordered registry — first match wins for `primary`. Adding Go/Rust = one row. */
export const ECOSYSTEMS = [jsEcosystem, pythonEcosystem];

/**
 * @param {object} inputs
 * @returns {{ primary:'node'|'python'|'unknown', ecosystems:string[], framework:string|null, language:'typescript'|'javascript'|'python'|'unknown' }}
 */
export function detectStack(inputs) {
  const matched = ECOSYSTEMS.filter((e) => e.detect(inputs));
  if (matched.length === 0) {
    return { primary: 'unknown', ecosystems: [], framework: null, language: 'unknown' };
  }
  const profiles = matched.map((e) => ({ id: e.id, ...e.profile(inputs) }));
  const primaryProfile = profiles[0];
  // framework: first non-null across matched ecosystems (primary first).
  const framework = profiles.find((p) => p.framework)?.framework ?? null;
  return {
    primary: primaryProfile.stack,
    ecosystems: profiles.map((p) => p.id),
    framework,
    language: primaryProfile.language,
  };
}

/**
 * Important-3: packageManager FIELD is authoritative; lockfiles are the
 * fallback; conflicts WARN (the field still wins).
 *
 * @param {object} inputs
 * @returns {{ pm: 'pnpm'|'yarn'|'bun'|'npm'|null, warning: string|null }}
 */
export function detectPackageManager(inputs) {
  const pkg = inputs.manifests.packageJson;
  const lockfiles = inputs.lockfiles ?? new Set();

  // Map a present lockfile → its pm, in documented precedence order.
  const lockPm =
    lockfiles.has('pnpm-lock.yaml') ? 'pnpm'
    : lockfiles.has('yarn.lock') ? 'yarn'
    : (lockfiles.has('bun.lock') || lockfiles.has('bun.lockb')) ? 'bun'
    : (lockfiles.has('package-lock.json') || lockfiles.has('npm-shrinkwrap.json')) ? 'npm'
    : null;

  // Count distinct pm families implied by present lockfiles (ambiguity signal).
  const lockFamilies = new Set();
  if (lockfiles.has('pnpm-lock.yaml')) lockFamilies.add('pnpm');
  if (lockfiles.has('yarn.lock')) lockFamilies.add('yarn');
  if (lockfiles.has('bun.lock') || lockfiles.has('bun.lockb')) lockFamilies.add('bun');
  if (lockfiles.has('package-lock.json') || lockfiles.has('npm-shrinkwrap.json')) lockFamilies.add('npm');

  let warning = null;

  // 1. valid packageJson.packageManager field wins.
  let fieldPm = null;
  if (pkg && typeof pkg.packageManager === 'string') {
    const m = pkg.packageManager.match(/^([a-z]+)@/i) || pkg.packageManager.match(/^([a-z]+)$/i);
    const cand = m ? m[1].toLowerCase() : null;
    if (cand && ['pnpm', 'yarn', 'bun', 'npm'].includes(cand)) fieldPm = cand;
  }

  if (fieldPm) {
    if (lockPm && lockPm !== fieldPm) {
      warning = `package manager ambiguous: field says ${fieldPm}, lockfile ${lockPm} present`;
    } else if (lockFamilies.size >= 2) {
      warning = `package manager ambiguous: multiple lockfiles present (${[...lockFamilies].sort().join(', ')})`;
    }
    return { pm: fieldPm, warning };
  }

  // 2. documented lockfile precedence.
  if (lockPm) {
    if (lockFamilies.size >= 2) {
      warning = `package manager ambiguous: multiple lockfiles present (${[...lockFamilies].sort().join(', ')}); using ${lockPm}`;
    }
    return { pm: lockPm, warning };
  }

  // 3. npm when a package.json exists; else null.
  if (pkg) return { pm: 'npm', warning };
  return { pm: null, warning };
}

// ─────────────────────────────────────────────────────────────────────────────
// A.4 — Commands (declared-tool rule; NEVER executed)
// ─────────────────────────────────────────────────────────────────────────────

/** Build the run-prefix for a JS script under a given package manager. */
function jsRunCommand(pm, script) {
  switch (pm) {
    case 'pnpm': return `pnpm ${script}`;
    case 'yarn': return `yarn ${script}`;
    case 'bun': return `bun run ${script}`;
    case 'npm':
    default:
      return script === 'test' ? 'npm test' : `npm run ${script}`;
  }
}

/**
 * Detect build/test/lint/typecheck COMMAND STRINGS. Detectors NEVER run a
 * discovered command — they only emit a string for the agent. Every value is
 * null when not confidently derivable from a manifest.
 *
 * @param {object} inputs
 * @param {string|null} pm  resolved package manager (for the JS run prefix)
 * @returns {{ build:string|null, test:string|null, lint:string|null, typecheck:string|null }}
 */
export function detectCommands(inputs, pm) {
  const out = { build: null, test: null, lint: null, typecheck: null };

  const pkg = inputs.manifests.packageJson;
  if (pkg) {
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
    const effPm = pm ?? 'npm';
    const has = (s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '';

    if (has('build')) out.build = jsRunCommand(effPm, 'build');
    if (has('test')) out.test = jsRunCommand(effPm, 'test');
    else if (has('test:unit')) out.test = jsRunCommand(effPm, 'test:unit');
    if (has('lint')) out.lint = jsRunCommand(effPm, 'lint');

    if (has('typecheck')) out.typecheck = jsRunCommand(effPm, 'typecheck');
    else if (has('type-check')) out.typecheck = jsRunCommand(effPm, 'type-check');
    else {
      const deps = jsDeclaredDeps(pkg);
      const tsDeclared = Object.prototype.hasOwnProperty.call(deps, 'typescript');
      // Important-5: pm-local tsc, ONLY when typescript is a declared dependency.
      // A bare `tsc --noEmit` is NEVER emitted on tsconfig presence alone.
      if (tsDeclared) {
        // Suggestion: prefer `npm exec -- tsc` over `npx tsc` — `npm exec` runs the
        // LOCAL binary and never silently fetches from the network, which matches
        // the declared-local-tool intent. pnpm/yarn/bun variants stay pm-local.
        out.typecheck =
          effPm === 'npm' ? 'npm exec -- tsc --noEmit'
          : effPm === 'bun' ? 'bun run tsc --noEmit'
          : `${effPm} tsc --noEmit`;
      }
    }
  }

  // Python (declared-tool only; Important-5 applied symmetrically).
  const names = pythonDeclaredNames(inputs);
  const py = inputs.manifests.pyproject;
  const pyDeclared = !!py || Array.isArray(inputs.manifests.requirements);
  if (pyDeclared) {
    const toolDeclared = (tool) => names.has(tool) || (py && py.tools && py.tools[tool]);
    if (toolDeclared('pytest')) out.test = out.test ?? 'pytest';
    if (names.has('ruff') || (py && py.tools.ruff)) out.lint = out.lint ?? 'ruff check .';
    else if (names.has('flake8')) out.lint = out.lint ?? 'flake8 .';
    if (names.has('mypy') || (py && py.tools.mypy)) out.typecheck = out.typecheck ?? 'mypy .';
    if (py && py.buildSystem) out.build = out.build ?? 'python -m build';
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// A.6 — Branches (graceful fallback; Important-2 detached-HEAD)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BRANCH_CANDIDATES = ['main', 'master', 'trunk'];
const INTEGRATION_CANDIDATES = ['dev', 'develop', 'integration', 'staging'];

/** Strip a leading `<remote>/` from a remote branch short name. */
function bareRemoteBranch(name) {
  const idx = name.indexOf('/');
  return idx === -1 ? name : name.slice(idx + 1);
}

/**
 * @param {{ headRef:string|null, originHead:string|null, remoteBranches:string[], localBranches:string[] }} git
 * @returns {{ integration:string, prTarget:string, defaultBranch:string, source:string, warning:string|null }}
 */
export function detectBranches(git) {
  const branchSet = new Set();
  for (const b of git.localBranches ?? []) branchSet.add(b);
  for (const r of git.remoteBranches ?? []) branchSet.add(bareRemoteBranch(r));

  let defaultBranch = null;
  let source = null;
  let warning = null;

  // Rung 1: origin/HEAD.
  if (git.originHead) {
    defaultBranch = git.originHead;
    source = 'origin/HEAD';
  }
  // Rung 2: first present of [main, master, trunk] in branchSet.
  if (!defaultBranch) {
    const found = DEFAULT_BRANCH_CANDIDATES.find((c) => branchSet.has(c));
    if (found) { defaultBranch = found; source = 'default-name'; }
  }
  // Rung 3: current HEAD IF it is a real branch (not detached literal 'HEAD').
  if (!defaultBranch && git.headRef) {
    defaultBranch = git.headRef;
    source = 'head';
  }
  // Rung 4: neutral default.
  if (!defaultBranch) {
    defaultBranch = 'main';
    source = 'fallback';
    warning = 'no branch detected (detached HEAD or empty repo); defaulting to "main"';
  }

  // integration: first present of [dev, develop, integration, staging], else default.
  const integration = INTEGRATION_CANDIDATES.find((c) => branchSet.has(c)) ?? defaultBranch;

  return {
    integration,
    prTarget: integration, // mirrors normalizeRuntimeConfig fallbacks
    defaultBranch,
    source,
    warning,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A.7 — Structure → codeAreas (evidence-qualified)
// ─────────────────────────────────────────────────────────────────────────────

const FRONTEND_FRAMEWORKS = new Set(['react', 'next', 'vue', 'svelte', 'angular']);
const BACKEND_FRAMEWORKS = new Set(['express', 'fastify', 'fastapi', 'django', 'flask', 'nest']);

/**
 * Map existing top-level dirs to human-meaningful, task-mentionable area keys.
 * Ambiguous generic dirs (src/, app/, lib/) are qualified by framework EVIDENCE
 * before assigning to a stack-specific area; otherwise left unclassified. Drops
 * empty/weak-routing groups.
 *
 * @param {object} inputs
 * @param {string|null} framework
 * @returns {Record<string,string[]>}
 */
export function detectCodeAreas(inputs, framework) {
  const dirs = inputs.dirNames ?? new Set();
  const areas = {};
  const add = (key, dir) => {
    if (!areas[key]) areas[key] = [];
    if (!areas[key].includes(dir)) areas[key].push(dir);
  };

  // Unambiguous dirs → direct mapping.
  for (const d of ['tests', 'test', '__tests__', 'e2e']) if (dirs.has(d)) add('tests', `${d}/`);
  if (dirs.has('docs')) add('docs', 'docs/');
  for (const d of ['scripts', 'tools']) if (dirs.has(d)) add('scripts', `${d}/`);

  // Backend dirs by name.
  for (const d of ['server', 'api', 'services', 'supabase', 'internal', 'cmd', 'pkg']) {
    if (dirs.has(d)) add(d === 'api' ? 'api' : 'backend', `${d}/`);
  }

  // Ambiguous generic dirs qualified by framework evidence.
  for (const d of ['src', 'app']) {
    if (!dirs.has(d)) continue;
    if (framework && FRONTEND_FRAMEWORKS.has(framework)) add('frontend', `${d}/`);
    else if (framework && BACKEND_FRAMEWORKS.has(framework)) add('backend', `${d}/`);
    // else: leave UNCLASSIFIED (do not force-fit).
  }

  // Drop any empty groups (defensive; add() never creates empties, but keep it
  // explicit so weak keys cannot leak).
  for (const k of Object.keys(areas)) if (areas[k].length === 0) delete areas[k];

  return areas;
}

// ─────────────────────────────────────────────────────────────────────────────
// A.8 — README → projectContext / conventions / tracker / language
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the FIRST ATX H1 (`# ...`) text from README text, or null. */
function extractReadmeH1(text) {
  if (typeof text !== 'string') return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#\s+/.test(line)) {
      // strip leading '# ' (one '#' + at least one space), then trailing ws.
      return line.replace(/^#\s+/, '').replace(/\s+$/, '');
    }
  }
  return null;
}

/**
 * DETERMINISTIC project-context lines. Every conforming implementation emits the
 * SAME array for the SAME inputs. Lines are appended in a FIXED order, each
 * included iff its precondition holds (see plan A.8).
 *
 * @param {object} inputs
 * @param {{ framework:string|null, language:string }} stack
 * @param {string|null} pm
 * @param {{ build:string|null, test:string|null }} commands
 * @returns {string[]}
 */
export function detectProjectContext(inputs, stack, pm, commands) {
  const lines = [];

  // (1) README H1 — MANDATORY when a README with an ATX H1 exists.
  if (inputs.readme) {
    const h1 = extractReadmeH1(inputs.readme.text);
    if (h1) lines.push(`Project: ${h1}`);
  }

  // (2) Stack — ONLY when known: framework ?? language; OMIT on unknown.
  const stackName =
    stack.framework ?? (stack.language && stack.language !== 'unknown' ? stack.language : null);
  if (stackName) lines.push(`Stack: ${stackName}`);

  // (3) Package manager — ONLY when non-null.
  if (pm) lines.push(`Package manager: ${pm}`);

  // (4) Build — ONLY when commands.build non-null.
  if (commands.build) lines.push(`Build: ${commands.build}`);

  // (5) Tests — ONLY when commands.test non-null.
  if (commands.test) lines.push(`Tests: ${commands.test}`);

  // (6) README pointer — MANDATORY when a README exists.
  if (inputs.readme) lines.push(`See ${inputs.readme.name} for project overview.`);

  return lines;
}

/** Convention files present (surfaced in summary only, never imported). */
export function detectConventionFiles(inputs) {
  return [...(inputs.conventionFiles ?? [])];
}

/** WP1 default tracker; '.github/' is noted in context, not a tracker type. */
export function detectTracker(_inputs) {
  return { type: 'local' };
}

/** Deterministic; a non-ASCII README does NOT flip it. */
export function detectPromptLanguage(_inputs) {
  return 'en';
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Orchestrators + the config emitter (C2 + C4 seam)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose detectors over a fresh `readProfileInputs` pass into a `profile`.
 * Pure-of-config-location (whether repoPath becomes "." is decided later in
 * profileToConfig against a configRoot).
 *
 * @param {string} repoPath
 * @returns {Promise<object>} profile
 */
export async function profileRepo(repoPath) {
  const inputs = await readProfileInputs(repoPath);
  const warnings = [...inputs.warnings];

  const stack = detectStack(inputs);
  const { pm, warning: pmWarning } = detectPackageManager(inputs);
  if (pmWarning) warnings.push(pmWarning);

  const commands = detectCommands(inputs, pm);
  const branches = detectBranches(inputs.git);
  if (branches.warning) warnings.push(branches.warning);

  const codeAreas = detectCodeAreas(inputs, stack.framework);
  const projectContext = detectProjectContext(inputs, stack, pm, commands);
  const tracker = detectTracker(inputs);
  const promptLanguage = detectPromptLanguage(inputs);
  const conventionFiles = detectConventionFiles(inputs);

  if (stack.primary === 'unknown') {
    warnings.push('stack unknown: no recognized manifest (package.json / pyproject.toml / requirements.txt)');
  }

  return {
    repoPath: inputs.repoPath,
    exists: inputs.exists,
    isGit: inputs.isGit,
    stack,
    packageManager: pm,
    commands,
    branches,
    codeAreas,
    projectContext,
    tracker,
    promptLanguage,
    conventionFiles,
    warnings,
  };
}

/**
 * Emit the WP2-schema config object. `configRoot` is INJECTED (C4): whether
 * repoPath becomes "." is a relationship between the TARGET and the config
 * LOCATION, not an intrinsic profile property. engines/grace/previewUrlTemplate
 * are intentionally OMITTED ⇒ normalizeRuntimeConfig fills neutral defaults.
 *
 * @param {object} profile
 * @param {{ configRoot: string }} opts
 * @returns {object} a raw taskctl.config.json object
 */
export function profileToConfig(profile, { configRoot }) {
  const resolvedTarget = path.resolve(profile.repoPath);
  const resolvedRoot = path.resolve(configRoot);
  const repoPath = resolvedTarget === resolvedRoot ? '.' : resolvedTarget;

  return {
    repoPath,
    tracker: profile.tracker, // { type: 'local' }
    branches: {
      integration: profile.branches.integration,
      prTarget: profile.branches.prTarget,
    },
    promptLanguage: profile.promptLanguage,
    projectContext: profile.projectContext,
    constraints: [], // RESOLVED: renderConstraintsBlock omits an empty block
    codeAreas: profile.codeAreas,
    // engines / grace / previewUrlTemplate OMITTED ⇒ neutral defaults on load.
  };
}

/**
 * The human-readable "Project Understanding" summary (pure; used by the test
 * AND the console). Includes a WARNINGS section and the detected convention
 * files (surfaced, not imported).
 *
 * @param {object} profile
 * @returns {string}
 */
export function renderUnderstanding(profile) {
  const L = [];
  L.push('Project Understanding');
  L.push('─────────────────────');
  L.push(`  Target:         ${profile.repoPath}`);
  L.push(`  Git repo:       ${profile.isGit ? 'yes' : 'no'}`);

  const stackBits = [];
  if (profile.stack.framework) stackBits.push(profile.stack.framework);
  if (profile.stack.language && profile.stack.language !== 'unknown') stackBits.push(profile.stack.language);
  L.push(`  Stack:          ${stackBits.length ? stackBits.join(' / ') : 'unknown'}`);
  if (profile.packageManager) L.push(`  Package mgr:    ${profile.packageManager}`);

  const cmds = profile.commands;
  const cmdBits = [];
  if (cmds.build) cmdBits.push(`build: ${cmds.build}`);
  if (cmds.test) cmdBits.push(`test: ${cmds.test}`);
  if (cmds.lint) cmdBits.push(`lint: ${cmds.lint}`);
  if (cmds.typecheck) cmdBits.push(`typecheck: ${cmds.typecheck}`);
  L.push(`  Commands:       ${cmdBits.length ? cmdBits.join('  |  ') : '(none detected)'}`);

  L.push(`  Branches:       integration=${profile.branches.integration}, prTarget=${profile.branches.prTarget} (default=${profile.branches.defaultBranch}, via ${profile.branches.source})`);

  const areaKeys = Object.keys(profile.codeAreas);
  if (areaKeys.length) {
    L.push('  Code areas:');
    for (const k of areaKeys) L.push(`    - ${k}: ${profile.codeAreas[k].join(', ')}`);
  } else {
    L.push('  Code areas:     (none classified)');
  }

  if (profile.projectContext.length) {
    L.push('  Project context:');
    for (const line of profile.projectContext) L.push(`    - ${line}`);
  }

  L.push(`  Tracker:        ${profile.tracker.type}`);
  L.push(`  Prompt lang:    ${profile.promptLanguage}`);

  if (profile.conventionFiles.length) {
    L.push(`  Convention files (noted, not imported): ${profile.conventionFiles.join(', ')}`);
  }

  if (profile.warnings.length) {
    L.push('');
    L.push('  Warnings:');
    for (const w of profile.warnings) L.push(`    ! ${w}`);
  }

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// C/D. attachToConfigRoot — the injectable helper (atomic write, no-clobber)
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel thrown by attach on a user-facing error (CLI maps it to exit 1). */
const TASKCTL_EXIT = 'TASKCTL_EXIT';

/**
 * Canonicalize a path with `fs.realpath` (resolving symlinks/junctions), falling
 * back to `path.resolve` when the path does not yet exist (so a not-yet-created
 * configRoot still gets a lexical canonical form for the containment check). The
 * fallback is a backstop only — the directory is created later, and the realpath
 * of an existing target/configRoot is what the containment rule actually relies
 * on to defeat symlink aliasing.
 *
 * @param {string} p
 * @returns {Promise<string>}
 */
async function canonicalize(p) {
  const resolved = path.resolve(p);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * C1 — path-separation invariant. Reject any target/config-root relationship
 * where the WRITE DESTINATION (the sidecar `configRoot`, where `taskctl.config.json`
 * lands) would resolve INSIDE the target being profiled. Both operands are
 * already CANONICAL (realpath'd) so a `configRoot` symlink/junction pointing into
 * the target is caught (its real target is what we compare), and so is the case
 * where the target is an ANCESTOR of the sidecar.
 *
 * The ONE sanctioned aliasing case is the dogfood SELF-ATTACH: when the target
 * IS the orchestration workspace (`realConfigRoot === realTarget`), writing
 * `taskctl.config.json` at that root is the intended behavior (see the dogfood
 * test). The caller handles equality before invoking this guard.
 *
 * Containment is decided by PATH SEGMENTS via `path.relative`, NOT a string
 * prefix: `relative(target, dest)` is "inside" iff it is neither absolute (a
 * different drive/root) nor `..`-prefixed (an ancestor/sibling). This avoids the
 * classic `/a/repo` vs `/a/repo-2` prefix false-positive.
 *
 * @param {string} realTarget     canonical target dir
 * @param {string} realConfigRoot canonical sidecar dir (write destination root)
 * @returns {boolean} true when the sidecar lies inside the target (REJECT)
 */
function configRootInsideTarget(realTarget, realConfigRoot) {
  const rel = path.relative(realTarget, realConfigRoot);
  // Empty rel === equality (handled by the caller as the sanctioned self-attach);
  // treat it as NOT-inside here so this helper only flags strict containment.
  if (rel === '') return false;
  return !path.isAbsolute(rel) && !rel.startsWith('..' + path.sep) && rel !== '..';
}

/**
 * Validate the target, profile it, render understanding, and atomically write
 * the derived config to the SIDECAR (`configRoot`) — never the target.
 *
 *  • C1 GUARD  → on CANONICAL (realpath'd) paths, reject any relationship where
 *                the sidecar resolves INSIDE the target (descendant configRoot,
 *                target-as-ancestor, or a configRoot symlink into the target);
 *                the sole sanctioned alias is the dogfood self-attach
 *                (configRoot === target). Enforced BEFORE profiling/write.
 *  • NO-FORCE  → exclusive `wx` create at outPath (race-free no-clobber); on a
 *                body write/close failure the just-created file is UNLINKED so a
 *                failed attach leaves no partial config blocking recovery.
 *  • FORCE     → write to a unique `wx` temp sibling, then `fs.rename`; a
 *                `finally` unlinks the temp on ANY failure.
 *
 * `_faultHooks` (test-only; undefined in production) inject faults at the two
 * publication seams to exercise cleanup:
 *   • `afterDestCreate` — awaited in the NO-FORCE path after the `wx` dest is
 *     written and BEFORE return, so a throw exercises the unlink-on-failure branch.
 *   • `afterTempWrite`  — awaited in the FORCE path after the temp body is
 *     written and BEFORE `fs.rename`, so a throw exercises the temp `finally` cleanup.
 *
 * @param {string} targetPath
 * @param {{ configRoot:string, force?:boolean, _faultHooks?:{ afterDestCreate?:()=>any, afterTempWrite?:()=>any } }} opts
 * @returns {Promise<{ outPath:string, cfg:object, profile:object }>}
 */
export async function attachToConfigRoot(targetPath, { configRoot, force = false, _faultHooks } = {}) {
  // 1. Validate target via the SAME read-only git wrapper (no second spawn path).
  if (!targetPath || typeof targetPath !== 'string') {
    console.error('attach: missing <repo-path>. Usage: taskctl attach <repo-path> [--force]');
    throw new Error(TASKCTL_EXIT);
  }
  const resolvedTarget = path.resolve(targetPath);
  let isDir = false;
  try {
    isDir = (await fs.stat(resolvedTarget)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    console.error(`attach: target "${targetPath}" is not an existing directory.`);
    throw new Error(TASKCTL_EXIT);
  }
  if (!gitIsWorkTree(resolvedTarget)) {
    console.error(`attach: target "${targetPath}" is not a git work tree. attach targets must be git repos.`);
    throw new Error(TASKCTL_EXIT);
  }

  // 1b. C1 — path-separation invariant, enforced on CANONICAL paths BEFORE any
  // profiling or write. Canonicalize both the (now-confirmed-existing) target and
  // the sidecar configRoot, resolving any symlink/junction first.
  const realTarget = await canonicalize(resolvedTarget);
  const realConfigRoot = await canonicalize(configRoot);
  if (realConfigRoot === realTarget) {
    // SANCTIONED SELF-ATTACH (dogfood): the target IS the orchestration workspace,
    // so writing taskctl.config.json at this root is the intended outcome. This is
    // the ONE permitted aliasing case; every other in-target destination is rejected.
  } else if (configRootInsideTarget(realTarget, realConfigRoot)) {
    console.error(
      `attach: refusing to write config inside the target being profiled.\n` +
      `        target:     ${realTarget}\n` +
      `        configRoot: ${realConfigRoot}\n` +
      `        The sidecar config must live OUTSIDE the target (the profiler is ` +
      `strictly read-only on the target). Point configRoot at a separate ` +
      `orchestration workspace, or attach the workspace itself (self-attach).`,
    );
    throw new Error(TASKCTL_EXIT);
  }

  // 2–4. Profile → config → outPath/body.
  const profile = await profileRepo(resolvedTarget);
  const cfg = profileToConfig(profile, { configRoot });
  const outPath = path.join(configRoot, DEFAULT_CONFIG_NAME);
  const body = JSON.stringify(cfg, null, 2) + '\n';

  if (!force) {
    // NO-FORCE: atomic no-clobber via exclusive `wx` open (closes existsSync TOCTOU).
    let handle;
    try {
      handle = await fs.open(outPath, 'wx');
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        console.error(
          `attach: ${DEFAULT_CONFIG_NAME} already exists at ${outPath}. ` +
          `Pass --force to overwrite (the existing file is left intact).`,
        );
        throw new Error(TASKCTL_EXIT);
      }
      throw e; // a non-EEXIST open error rethrows
    }
    // I-3: the `wx` open already published the destination; a write/close failure
    // would otherwise leave a PARTIAL config that then blocks no-force recovery.
    // On ANY failure, close the handle and UNLINK the just-created file so the
    // failed attach leaves zero trace at outPath.
    let wrote = false;
    try {
      await handle.writeFile(body, 'utf8');
      // test-only fault seam: throws AFTER the dest exists/written, exercising cleanup.
      if (_faultHooks && typeof _faultHooks.afterDestCreate === 'function') {
        await _faultHooks.afterDestCreate();
      }
      wrote = true;
    } finally {
      try { await handle.close(); } catch { /* ignore close error during cleanup */ }
      if (!wrote) {
        try { await fs.unlink(outPath); } catch { /* best-effort; nothing to recover */ }
      }
    }
    return { outPath, cfg, profile };
  }

  // FORCE: atomic replace via a unique `wx` temp sibling + rename.
  const tmpPath = path.join(
    configRoot,
    `${DEFAULT_CONFIG_NAME}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let renamed = false;
  try {
    const handle = await fs.open(tmpPath, 'wx');
    try {
      await handle.writeFile(body, 'utf8');
    } finally {
      await handle.close();
    }
    // test-only fault seam: throws AFTER temp exists, BEFORE rename.
    if (_faultHooks && typeof _faultHooks.afterTempWrite === 'function') {
      await _faultHooks.afterTempWrite();
    }
    await fs.rename(tmpPath, outPath);
    renamed = true;
  } finally {
    if (!renamed) {
      // best-effort cleanup of the stray temp (swallow ENOENT and the rest).
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    }
  }
  return { outPath, cfg, profile };
}
