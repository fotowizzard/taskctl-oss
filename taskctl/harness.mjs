/**
 * harness.mjs — the `taskctl init-harness` materializer.
 *
 * Scaffolds the "harness layer" (operating contract, onboarding, session
 * monitor, GRACE skeleton, task playbook) INTO the current orchestration
 * workspace from `templates/harness/`. Two file kinds:
 *   - 'template' — rendered through templating.renderTemplate ({{KEY}} filled
 *     from config + env + the target's git remote; a leftover placeholder is a
 *     hard error).
 *   - 'verbatim' — generic, config-driven files copied byte-for-byte (they read
 *     taskctl.config.json / .env at RUNTIME, so they carry no per-project value).
 *
 * Safety (New-project's confinement discipline, simplified for a single pass):
 * init-harness NEVER overwrites. A dest that is byte-identical to what we would
 * write is skipped; a dest that DIFFERS is KEPT (left exactly as the user has
 * it) and reported — the run still materializes every ABSENT file. So a re-run
 * after you edit CLAUDE.md still scaffolds the files you don't yet have, and
 * your edits are never clobbered.
 *
 * Pure + injectable: resolveHarnessVars/planHarness take plain data (config,
 * env, gitRemote) so the whole module is unit-testable with no live git/LLM and
 * no writes outside a temp dir.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderTemplate } from './templating.mjs';
import { slugify } from './newproject.mjs';

// Windows-safe module dir (mirrors templating.mjs): strip the leading slash a
// file:// URL puts before a drive letter.
const __dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
export const HARNESS_TEMPLATES_DIR = path.resolve(__dir, '..', 'templates', 'harness');

/**
 * The harness manifest: each entry maps a source under templates/harness/ to a
 * dest under the workspace root. Extending the harness = add a file under
 * templates/harness/ + one line here (the mechanism handles the rest).
 */
export const HARNESS_MANIFEST = [
  // Template scaffolds — rendered ({{PLACEHOLDER}} filled, TODO: left for the human).
  { kind: 'template', src: 'CLAUDE.md.tmpl', dest: 'CLAUDE.md' },
  { kind: 'template', src: 'SETUP.md.tmpl', dest: 'SETUP.md' },
  { kind: 'template', src: 'onboarding/00-START-HERE.md.tmpl', dest: 'onboarding/00-START-HERE.md' },
  { kind: 'template', src: 'commands/bootstrap.md.tmpl', dest: '.claude/commands/bootstrap.md' },
  { kind: 'template', src: 'ai/rules/new-task-bootstrap.md.tmpl', dest: 'ai/rules/new-task-bootstrap.md' },
  // Generic (Class-A) — copied verbatim; they read taskctl.config.json + .env at RUNTIME.
  { kind: 'verbatim', src: 'ops/session-state.sh', dest: 'ops/session-state.sh' },
  { kind: 'verbatim', src: 'grace/check-freshness.sh', dest: 'grace/check-freshness.sh' },
];

/** Derive a short project name from the workspace dir (strip a trailing
 *  `-orchestration`/`-orchestartion`/`-sidecar` suffix); overridable via --name. */
export function deriveProjectName(workspaceRoot) {
  const base = path.basename(path.resolve(workspaceRoot || '.'));
  const stripped = base.replace(/[-_](orchest\w*|sidecar)$/i, '');
  return stripped || base;
}

/**
 * Best-effort read of the target repo's origin remote URL. Returns null on any
 * failure (no repo, no remote, git missing) so the caller falls back to a TODO.
 * Injectable in tests (callers pass `gitRemote` to resolveHarnessVars directly).
 */
export function readGitRemote(repoPath) {
  if (!repoPath) return null;
  try {
    const out = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the {{PLACEHOLDER}} value map from config + env + a resolved git
 * remote. Every key ALWAYS has a value (mechanical spots fall back to a visible
 * `TODO-...` sentinel) so a rendered file never carries an unfilled `{{...}}`.
 *
 * @param {object} config normalized runtime config (repoPath/tracker/branches/grace)
 * @param {object} env    process.env (only JIRA_PROJECT_KEY is read)
 * @param {object} [opts]
 * @param {string} [opts.workspaceRoot]
 * @param {string} [opts.name]      explicit project name (--name)
 * @param {string|null} [opts.gitRemote] pre-resolved target remote URL
 */
export function resolveHarnessVars(config = {}, env = {}, opts = {}) {
  const project = opts.name || deriveProjectName(opts.workspaceRoot);
  const branches = config.branches ?? {};
  const grace = config.grace ?? {};
  const integration = branches.integration ?? 'main';
  return {
    PROJECT: project,
    PROJECT_SLUG: slugify(project),
    TARGET_REPO: opts.gitRemote || 'TODO: target repo (set REPO_PATH; git remote URL)',
    TRACKER: config.tracker?.type ?? 'local',
    JIRA_KEY: env.JIRA_PROJECT_KEY || 'TODO-set-JIRA_PROJECT_KEY-in-.env',
    INTEGRATION_BRANCH: integration,
    PR_TARGET: branches.prTarget ?? integration,
    GRACE_ENABLED: String(grace.enabled === true),
    GRACE_PILOT: grace.pilotBranch ?? 'experiment/grace-pilot',
  };
}

/** The bytes a manifest entry would write: a rendered template or a verbatim file (both Buffers). */
async function contentFor(entry, vars, templatesDir) {
  if (entry.kind === 'template') {
    const rendered = await renderTemplate(entry.src, vars, { templatesDir });
    // renderTemplate only rejects `{{WORD}}` tokens. Guard here against ANY broader
    // leftover (`{{ spaced }}`, `{{hy-phen}}`) so a mistyped placeholder can never ship.
    const leftover = rendered.match(/\{\{[^}\n]+\}\}/g);
    if (leftover) {
      throw new Error(`TASKCTL_EXIT:template ${entry.src} has unsubstituted placeholder(s): ${[...new Set(leftover)].join(', ')}`);
    }
    return Buffer.from(rendered, 'utf8');
  }
  // Verbatim: copied byte-for-byte (Buffer — no encode/decode round-trip).
  return fs.readFile(path.join(templatesDir, entry.src));
}

/** Classify a dest against the bytes we would write: absent | identical | divergent. */
async function classifyDest(destPath, wouldWrite) {
  let current;
  try {
    current = await fs.readFile(destPath);
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw e;
  }
  return current.equals(wouldWrite) ? 'identical' : 'divergent';
}

/**
 * Resolve entry.dest under the workspace, REFUSING an absolute path, a `..`
 * segment, or anything that escapes the workspace root — the materializer must
 * only ever write inside the workspace, even if the manifest is later extended.
 */
export function confinedDestPath(workspaceRoot, dest) {
  const root = path.resolve(workspaceRoot);
  if (path.isAbsolute(dest) || dest.split(/[/\\]/).includes('..')) {
    throw new Error(`TASKCTL_EXIT:harness dest "${dest}" must be a relative path with no ".." segment.`);
  }
  const resolved = path.resolve(root, dest);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`TASKCTL_EXIT:harness dest "${dest}" escapes the workspace.`);
  }
  return resolved;
}

/**
 * Compute the materialization plan without writing anything. Each item:
 *   { dest, destPath, kind, content(Buffer), status: 'absent'|'identical'|'divergent' }
 */
export async function planHarness({ workspaceRoot, templatesDir = HARNESS_TEMPLATES_DIR, vars, manifest = HARNESS_MANIFEST }) {
  const plan = [];
  for (const entry of manifest) {
    const destPath = confinedDestPath(workspaceRoot, entry.dest);
    const content = await contentFor(entry, vars, templatesDir);
    const status = await classifyDest(destPath, content);
    plan.push({ dest: entry.dest, destPath, kind: entry.kind, content, status });
  }
  return plan;
}

/** Realpath of the nearest EXISTING ancestor of `p` (walking up past not-yet-created
 *  dirs). Lets us confinement-check BEFORE any mkdir, so a linked parent can't even
 *  leak a freshly-created directory outside the workspace. */
async function realNearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      return await fs.realpath(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return cur; // reached the filesystem root (always exists)
      cur = parent;
    }
  }
}

/**
 * Materialize the harness. NEVER overwrites: an ABSENT dest is written via an
 * EXCLUSIVE create ('wx') — the write IS the anti-clobber check, so nothing can be
 * overwritten even if a file appears between plan and write (no plan→write TOCTOU,
 * and no temp file to leave behind). 'identical' → skipped; 'divergent' → kept
 * (reported, untouched). `dryRun` reports without writing. Returns
 * { written, skippedIdentical, keptExisting, dryRun } (dest-path arrays).
 */
export async function materializeHarness({ workspaceRoot, templatesDir = HARNESS_TEMPLATES_DIR, vars, manifest = HARNESS_MANIFEST, dryRun = false }) {
  const plan = await planHarness({ workspaceRoot, templatesDir, vars, manifest });
  const summary = { written: [], skippedIdentical: [], keptExisting: [], dryRun };
  // Real (symlink-resolved) workspace root: the lexical confinement in planHarness
  // can't see a pre-existing symlink/junction in a dest's parent chain, so re-check
  // the REAL parent below — we must truly never write outside the workspace.
  const realRoot = dryRun ? null : await fs.realpath(workspaceRoot);
  for (const item of plan) {
    if (item.status === 'identical') { summary.skippedIdentical.push(item.dest); continue; }
    if (item.status === 'divergent') { summary.keptExisting.push(item.dest); continue; }
    // status === 'absent'
    if (dryRun) { summary.written.push(item.dest); continue; }
    // Symlink-escape guard — BEFORE any mkdir, so a linked parent can't even leak a
    // freshly-created directory outside: resolve the nearest EXISTING ancestor of the
    // dest and require it to stay inside the real workspace root.
    const realAncestor = await realNearestExisting(path.dirname(item.destPath));
    const relAncestor = path.relative(realRoot, realAncestor);
    if (relAncestor.startsWith('..') || path.isAbsolute(relAncestor)) {
      throw new Error(`TASKCTL_EXIT:refusing to write ${item.dest} — its path resolves OUTSIDE the workspace (symlink/junction escape).`);
    }
    await fs.mkdir(path.dirname(item.destPath), { recursive: true });
    try {
      await fs.writeFile(item.destPath, item.content, { flag: 'wx' }); // exclusive: never clobbers
      summary.written.push(item.dest);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Raced: the dest appeared between plan and write — re-classify, never overwrite.
      const current = await fs.readFile(item.destPath);
      (current.equals(item.content) ? summary.skippedIdentical : summary.keptExisting).push(item.dest);
    }
  }
  return summary;
}
