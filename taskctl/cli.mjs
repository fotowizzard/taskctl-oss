#!/usr/bin/env node

/**
 * taskctl — CLI orchestrator for AI-assisted development
 *
 * Usage:
 *   taskctl sync CP-133                     Fetch issue from Jira, create context.md + state.json
 *   taskctl status CP-133                   Show current task state
 *   taskctl plan CP-133 [--engine] [--cc-thingz]  Prepare planning prompt
 *   taskctl plan-review CP-133 [--engine]   Cross-model plan review
 *   taskctl run CP-133 [--engine]           Prepare execution prompt
 *   taskctl review CP-133 [--engine]        Final review prompt
 *   taskctl publish CP-133 --repo-path <p>  Commit, push, create PR
 *   taskctl list                            List all tasks
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { execSync as execSyncTop, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { JiraClient } from './jira-client.mjs';
import { loadConfig, getPaths, loadTaskctlConfig, loadJiraCreds, normalizeRuntimeConfig } from './config.mjs';
import {
  buildContextMd,
  detectRepoBranch,
  isGovernedPath,
  loadGovernedModules,
  getModuleIdsForPaths,
  guessCodeAreas,
  renderProjectContextBlock,
  renderConstraintsBlock,
  renderCodeAreasList,
} from './context-builder.mjs';
import * as grace from './grace.mjs';
import { makeJiraTracker, makeLocalTracker, buildSyncState } from './tracker.mjs';
import { renderTemplate, renderLocalState } from './templating.mjs';
import { loadPromptPack } from './prompts/index.mjs';
import { cmdDo, cmdFlow, cmdAutopilot, rolePair, runEngineStep } from './automation.mjs';
import * as np from './newproject.mjs';
import * as harness from './harness.mjs';
import { parseAndValidate } from './newproject-schema.mjs';
import { attachToConfigRoot, renderUnderstanding, gitIsWorkTree } from './profiler.mjs';
import { getEngine, assertEngineRegistered } from './engines.mjs';
import { resolveWorkspaceRoot, workspaceBundle, INSTALLATION_ROOT } from './workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── The INSTALLATION root (cli.mjs MODULE location) ─────────────────────────
// Used for exactly two things: the cmdInit / template-seed SOURCE (the bundled
// seed templates ship with the install and never move) and the discovery
// FALLBACK below. Everything else routes through the cwd-DISCOVERED workspace
// (New-C1).
const INSTALL_TEMPLATES_DIR = path.join(INSTALLATION_ROOT, 'ai', 'templates');

// ── Discovered workspace (New-C1) ───────────────────────────────────────────
// resolveWorkspaceRoot(process.cwd()) is called ONCE in main(), then the four
// derived values below are reassigned (exactly once, before any command
// dispatch) from the chosen root. They START at the install bundle so a unit
// import of cli.mjs (tests import parseEngine/buildLaunchCommand directly,
// without running main) sees the pre-5b values. Handlers read these four names
// exactly as before; discovery just changes WHICH workspace they point at —
// nearest-ancestor config when run inside a generated workspace, the install
// root otherwise (the exact pre-5b behavior, so the 222 baseline is unchanged).
let { root: ORCHESTRATION_ROOT, tasksDir: TASKS_DIR, templatesDir: TEMPLATES_DIR, O } =
  workspaceBundle(INSTALLATION_ROOT);

/** Resolve + bind the workspace bundle for this invocation (called once in main). */
function bindWorkspace(cwd) {
  const { root, source } = resolveWorkspaceRoot(cwd);
  ({ root: ORCHESTRATION_ROOT, tasksDir: TASKS_DIR, templatesDir: TEMPLATES_DIR, O } =
    workspaceBundle(root));
  return { root, source };
}

// No baked-in default repo path (WP2 Stage 2b). The repo path resolves from
// --repo-path flag > REPO_PATH env > config.repoPath; a repo-needing command
// errors clearly via resolveRepoPath() when none is set.

// ── Tracker dependency builders (WP1) ──────────────────────────────────────
// tracker.mjs imports nothing from this file; every cli-local helper it needs
// is handed in here. Keeps the extraction acyclic.

/**
 * Deps for the local adapter: template helpers + the project-section renderers
 * (injected from context-builder so the local render path and buildContextMd
 * share one source of truth) + the context-options bundle (WP2 Stage 2b).
 * No Jira machinery.
 */
function buildLocalTrackerDeps(rcfg = null) {
  return {
    renderTemplate,
    renderLocalState,
    ctxOpts: buildCtxOpts(rcfg),
    renderProjectContextBlock,
    renderConstraintsBlock,
    guessCodeAreas,
    renderCodeAreasList,
  };
}

/**
 * Compute the normalized GRACE options bundle folded into `ctxOpts.grace`.
 * Non-null `{repoRoot,pilotBranch}` only when GRACE is enabled; `null` when
 * disabled (default) so context.md stays GRACE-free.
 * @param {object|null} rcfg normalized runtime config (has `.grace`)
 * @returns {{repoRoot:string|null, pilotBranch:string}|null}
 */
function graceOptsFromConfig(rcfg) {
  return rcfg?.grace?.enabled
    ? { repoRoot: rcfg.grace.repoRoot, pilotBranch: rcfg.grace.pilotBranch }
    : null;
}

/**
 * Build the ONE context-options object threaded into BOTH context producers
 * (`buildContextMd` and the local `context.md.tmpl` render path) — WP2 Stage 2b
 * C4. Project-specific sections come from config; `grace` folds in the GRACE
 * opts. Absence reproduces project-neutral defaults.
 * @param {object|null} rcfg normalized runtime config
 * @returns {{projectContext:string[], constraints:string[], codeAreas:object, grace:object|null}}
 */
function buildCtxOpts(rcfg) {
  return {
    projectContext: rcfg?.projectContext ?? [],
    constraints: rcfg?.constraints ?? [],
    codeAreas: rcfg?.codeAreas ?? {},
    grace: graceOptsFromConfig(rcfg),
  };
}

/** Resolve the prompt pack for this invocation (default English). */
function promptPack(rcfg) {
  return loadPromptPack(rcfg?.promptLanguage ?? 'en');
}

/**
 * Resolve the repo path for a command that needs one (WP2 Stage 2b open-q b):
 * `--repo-path` flag > REPO_PATH env > config.repoPath. Throws TASKCTL_EXIT
 * with a clear message when none is set — no baked-in origin-project fallback.
 * @param {string[]} args
 * @param {object|null} rcfg
 * @returns {string}
 */
function resolveRepoPath(args, rcfg) {
  const resolved = parseRepoPath(args) ?? process.env.REPO_PATH ?? rcfg?.repoPath ?? null;
  if (!resolved) {
    console.error(
      'No repo path configured. Pass --repo-path <path>, set REPO_PATH, or add ' +
      '"repoPath" to taskctl.config.json.',
    );
    throw new Error('TASKCTL_EXIT');
  }
  return resolved;
}

/**
 * Deps for the jira adapter: validated Jira creds + the cli-local pipeline.
 * `ctxOpts` (default `{}`) is forwarded by seedContext as buildContextMd's
 * 3rd arg (`{projectContext, constraints, codeAreas, grace}`) so project
 * sections + enabled-GRACE block are injected consistently (WP2 Stage 2b).
 */
function buildJiraTrackerDeps(jiraCreds, ctxOpts = {}) {
  return {
    jiraCreds,
    JiraClient,
    fetchFullJiraContext,
    buildContextMd,
    buildSyncState,
    extractDependencies,
    ctxOpts,
  };
}

// ── Worktree helpers ────────────────────────────────────────────────────

/**
 * Ensure a git worktree exists for the given branch. Returns the worktree path.
 * Creates the branch (from the supplied `baseBranch`, default = the integration
 * branch) and worktree if they don't exist yet. Callers pass
 * `rcfg.branches.integration` (WP2 Stage 2b).
 */
function ensureWorktree(repoPath, branchName, slug, baseBranch = 'dev') {
  const wtRoot = path.join(repoPath, '.worktrees');
  const wtDir = path.join(wtRoot, slug);
  const run = (cmd) => execSyncTop(cmd, { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  // Already exists — just return
  try {
    const stat = fsSync.statSync(wtDir);
    if (stat.isDirectory()) return wtDir;
  } catch { /* doesn't exist yet */ }

  // Ensure branch exists. Create it from origin/<base> (after fetching) so the
  // worktree is never cut from a STALE LOCAL <base> ref — local `dev` is
  // frequently behind `origin/dev`, which otherwise yields a wrong PR diff and a
  // stale Coolify preview. Falls back to the local ref when offline / no remote.
  let resolvedBase = baseBranch;
  try { run(`git rev-parse --verify ${branchName}`); }
  catch {
    try { run(`git fetch origin ${baseBranch}`); } catch { /* offline / no remote — fall back to local base */ }
    try { run(`git rev-parse --verify origin/${baseBranch}`); resolvedBase = `origin/${baseBranch}`; }
    catch { /* no remote-tracking ref — use local base */ }
    run(`git branch ${branchName} ${resolvedBase}`);
  }

  // Create worktree
  fsSync.mkdirSync(wtRoot, { recursive: true });
  run(`git worktree add "${wtDir.replace(/\\/g, '/')}" ${branchName}`);
  console.log(`  Created worktree: ${wtDir} (base: ${resolvedBase})`);
  return wtDir;
}

/**
 * Remove a git worktree after publish.
 */
function removeWorktree(repoPath, slug) {
  const wtDir = path.join(repoPath, '.worktrees', slug);
  try {
    execSyncTop(`git worktree remove "${wtDir.replace(/\\/g, '/')}" --force`, {
      cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  Removed worktree: ${wtDir}`);
  } catch (err) {
    console.warn(`  ⚠ Could not remove worktree: ${err.message}`);
  }
}

/**
 * Resolve working directory: use worktree if set, otherwise fallback to repoPath.
 */
function resolveWorkDir(state, repoPath) {
  return state.worktreePath ?? repoPath;
}

/**
 * Auto-resolve branch and activePR from the tracker PR-N label (stored in context.md).
 * Uses `gh pr view` to get the branch name and URL.
 * Mutates state in-place and persists to state.json if anything changed.
 */
async function resolveRepoPR(state, taskDir, repoPath) {
  if (state.branch && state.activePR) return; // already resolved

  try {
    const ctx = await fs.readFile(path.join(taskDir, 'context.md'), 'utf8');
    const labelMatch = ctx.match(/PR-(\d+)/);
    if (!labelMatch) return;

    const prNumber = labelMatch[1];
    const prJson = execSyncTop(`gh pr view ${prNumber} --json headRefName,url`, {
      cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!prJson) return;

    const pr = JSON.parse(prJson);
    let changed = false;
    if (pr.headRefName && !state.branch) { state.branch = pr.headRefName; changed = true; }
    if (pr.url && !state.activePR) { state.activePR = pr.url; changed = true; }
    if (changed) {
      await writeState(taskDir, state);
      console.log(`  Auto-resolved from PR-${prNumber}: branch=${state.branch}, PR=${state.activePR}`);
    }
  } catch { /* no context.md, no gh, or parse error — skip silently */ }
}

/**
 * Write prompt file with UTF-8 BOM so Windows tools (PowerShell, Codex sandbox) detect encoding correctly.
 */
const BOM = '\uFEFF';
async function writePrompt(filePath, content) {
  await fs.writeFile(filePath, BOM + content, 'utf8');
}

/**
 * Common preamble injected into every generated prompt.
 * Explains the two-directory architecture so the AI agent knows where to look.
 *
 * The GRACE prompt hint is appended ONLY when GRACE is explicitly enabled
 * (`rcfg.grace.enabled`); when disabled (the default) no hint is produced —
 * the prompt is GRACE-free. `rcfg` is threaded in from each cmd (I1).
 */
function promptPreamble(repoPath, taskDir = null, rcfg = null) {
  // If the task has a worktreePath in state.json (i.e. it lives on a feature
  // branch worktree, not the main repo HEAD), use that as the canonical
  // repository path in the prompt. Otherwise codex/claude reads paths from
  // the main repo's current branch (typically dev) where the feature files
  // don't yet exist, causing "Cannot find path" errors when reviewing/running.
  //
  // This mirrors the cwd resolution already done in automation.mjs:269-273,
  // which sets codex `-C` to the worktree. Without this preamble fix, the
  // cwd is correct but the prompt text tells the engine to look elsewhere.
  let effectiveRepo = repoPath;
  if (taskDir) {
    try {
      const stateData = JSON.parse(fsSync.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
      if (stateData?.worktreePath && typeof stateData.worktreePath === 'string') {
        effectiveRepo = stateData.worktreePath;
      }
    } catch { /* no state.json or invalid — fall back to repoPath */ }
  }

  const R = effectiveRepo.replace(/\\/g, '/');
  const lines = [
    '## Workspace layout',
    `- **Source code (repository):** ${R}`,
    `  All src/, supabase/, docs/ paths are relative to this directory.`,
    `- **Orchestration (plans, rules, prompts):** ${O}`,
    `  All ai/tasks/, ai/rules/, orchestration docs live here.`,
    '',
    'When looking for source files (components, hooks, services, types, utils) — look in the REPOSITORY.',
    'When looking for task artifacts (context.md, plan.md, rules) — look in ORCHESTRATION.',
    '',
  ];

  // GRACE prompt hint — only when GRACE is explicitly enabled. Disabled (the
  // default) → no hint. (Defense in depth: buildGracePromptHint also returns
  // '' off-pilot.)
  if (taskDir && rcfg?.grace?.enabled) {
    const graceHint = grace.buildGracePromptHint(
      rcfg.grace.repoRoot,
      taskDir,
      rcfg.grace.pilotBranch,
      detectRepoBranch,
    );
    if (graceHint) lines.push(graceHint);
  }

  return lines.join('\n');
}

/**
 * Bridge function: allows automation.mjs to call existing cmdXxx functions.
 * Maps command names to the internal functions.
 *
 * `rcfg` (the normalized runtime config) is threaded to EVERY cmd so the
 * automation-via-bridge path and the direct CLI switch cannot diverge (I1).
 * In main() this is wrapped in a closure that captures the loaded rcfg.
 */
async function bridgeCommand(command, issueKey, args, jiraConfig, rcfg) {
  switch (command) {
    case 'sync':        return cmdSync(jiraConfig, issueKey, rcfg);
    case 'plan':        return cmdPlan(issueKey, args, rcfg);
    case 'plan-review': return cmdPlanReview(issueKey, args, rcfg);
    case 'run':         return cmdRun(issueKey, args, rcfg);
    case 'review':      return cmdReview(issueKey, args, rcfg);
    case 'publish':     return cmdPublish(jiraConfig, issueKey, args, rcfg);
    case 'jira-sync':   return cmdJiraSync(jiraConfig, issueKey);
    case 'revise':      return cmdRevise(issueKey, args, rcfg);
    case 'fix':         return cmdFix(issueKey, args, rcfg);
    case 'refresh':     return cmdRefresh(jiraConfig, issueKey, rcfg);
    default: throw new Error(`bridgeCommand: unknown command "${command}"`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  // New-C1: resolve the workspace root from the user's CWD ONCE, before any
  // command runs, and bind ORCHESTRATION_ROOT/TASKS_DIR/TEMPLATES_DIR/O from it.
  // Inside taskctl-oss (or any planted-config workspace) this returns that dir =
  // the pre-5b behavior; inside a generated workspace it returns that workspace
  // so `taskctl plan <task>` drives the generated project; with no ancestor
  // config it falls back to the install root.
  bindWorkspace(process.cwd());

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  // EARLY DISPATCH (C3): `attach` runs as a TOLERANT BOOTSTRAP — before the
  // runtime config is loaded — so a malformed/invalid taskctl.config.json (the
  // exact file `--force` exists to replace) cannot block a recovery attach. Its
  // target is an argument, not the configured repo, so it needs no rcfg. It is
  // structurally outside the Jira/GRACE gates below (which are read AFTER this).
  if (command === 'attach') {
    await cmdAttach(args);
    return;
  }

  // Load the config layer (taskctl.config.json + .env side effects). Never
  // throws on missing Jira creds — only resolves {repoPath, tracker}.
  const tcfg = await loadTaskctlConfig({ configRoot: ORCHESTRATION_ROOT, envPath: path.join(__dirname, '.env') });

  // init-harness is a scaffolding BOOTSTRAP — dispatch it on the loaded config
  // BEFORE strict runtime normalization, so an unrelated misconfig (grace.enabled
  // without a repo root, a bogus engine name) can't block scaffolding. It reads
  // only tcfg (repoPath/tracker + the raw branches/grace, each with its own fallback).
  if (command === 'init-harness') {
    await cmdInitHarness(args, tcfg);
    return;
  }

  // Build ONE normalized runtime config object and thread it everywhere (I1).
  // Resolves the grace block (+ repoRoot fallback) and validates an
  // enabled-without-root misconfig loudly.
  const rcfg = normalizeRuntimeConfig(tcfg);

  // bridge: captures rcfg so the automation path (do/flow/autopilot) and the
  // direct CLI switch share identical config (I1, no per-command tcfg=null).
  const bridge = (command, issueKey, args, jiraConfig) =>
    bridgeCommand(command, issueKey, args, jiraConfig, rcfg);

  // Commands that require a Jira tracker.
  const jiraCommands = new Set(['sync', 'jira-sync', 'refresh', 'autopilot', 'publish']);

  // GRACE-only commands: rejected with a helpful message when GRACE is
  // disabled (the default) so no GRACE machinery runs for a standard project.
  const graceCommands = new Set(['sync-grace', 'grace-gate']);
  if (graceCommands.has(command) && !rcfg.grace.enabled) {
    console.error(
      `Command "${command}" requires GRACE governance, which is disabled.\n` +
      `Set grace.enabled:true in taskctl.config.json (opt-in tier for contract-governed repos).`,
    );
    throw new Error('TASKCTL_EXIT');
  }

  // Single pre-dispatch chokepoint: reject EVERY Jira-only command in local
  // mode before any JiraClient is constructed (no null ever reaches cmdSync/
  // cmdRefresh/cmdJiraSync/cmdPublish/cmdAutopilot).
  if (jiraCommands.has(command) && tcfg.tracker.type !== 'jira') {
    console.error(
      `Command "${command}" needs a Jira tracker, but the configured tracker is "${tcfg.tracker.type}".\n` +
      `This project is local; Jira is not configured. ` +
      (command === 'sync'
        ? 'Use `taskctl new <slug>` to create a task without Jira.'
        : `Configure tracker.type:"jira" (+ JIRA_* env) to use \`${command}\`.`)
    );
    throw new Error('TASKCTL_EXIT');
  }

  // Load Jira creds lazily, only for the commands that genuinely need them and
  // only when the tracker is jira. Same throw-on-missing-var behavior as today.
  let config = null;
  if (jiraCommands.has(command) && tcfg.tracker.type === 'jira') {
    config = await loadJiraCreds(tcfg, { envPath: path.join(__dirname, '.env') });
  }

  switch (command) {
    case 'sync':
      await cmdSync(config, args[0], rcfg);
      break;
    case 'status':
      await cmdStatus(args[0]);
      break;
    case 'list':
      await cmdList(args);
      break;
    case 'new':
      await cmdNew(args[0], args, rcfg);
      break;
    case 'new-project':
      await cmdNewProject(args[0], args, rcfg);
      break;
    case 'plan':
      await cmdPlan(args[0], args, rcfg);
      break;
    case 'plan-review':
      await cmdPlanReview(args[0], args, rcfg);
      break;
    case 'run':
      await cmdRun(args[0], args, rcfg);
      break;
    case 'review':
      await cmdReview(args[0], args, rcfg);
      break;
    case 'publish':
      await cmdPublish(config, args[0], args, rcfg);
      break;
    case 'jira-sync':
      await cmdJiraSync(config, args[0]);
      break;
    case 'refresh':
      await cmdRefresh(config, args[0], rcfg);
      break;
    case 'resume':
      await cmdResume(args[0]);
      break;
    case 'handoff':
      await cmdHandoff(args[0], rcfg);
      break;
    case 'grace-gate': {
      // Issue key is any positional arg matching the `CP-NNN` pattern;
      // otherwise undefined (print-only mode). This sidesteps any
      // confusion between flag values (e.g. `--repo-path <path>`) and
      // a real issue key.
      const issueKeyForGate = args.find((a) => /^CP-\d+$/i.test(String(a)));
      await cmdGraceGate(issueKeyForGate, args, rcfg);
      break;
    }
    case 'sync-grace':
      await cmdSyncGrace(args, rcfg);
      break;
    case 'fix':
      await cmdFix(args[0], args, rcfg);
      break;
    case 'revise':
      await cmdRevise(args[0], args, rcfg);
      break;
    case 'replan':
      await cmdReplan(args[0], args, rcfg);
      break;
    case 'create-followup':
      await cmdCreateFollowup(args[0], args);
      break;
    case 'deps':
      await cmdDeps(args[0]);
      break;
    case 'init':
      await cmdInit(args[0]);
      break;
    case 'do': {
      const doIssueKey = args[1]; // do <stage> CP-XXX
      await cmdDo({
        orchRoot: ORCHESTRATION_ROOT,
        tasksDir: TASKS_DIR,
        issueKey: doIssueKey,
        args: args,
        runCommand: bridge,
        runtimeConfig: rcfg,
      });
      break;
    }
    case 'flow': {
      const flowIssueKey = args[0];
      if (!flowIssueKey) { console.error('Usage: taskctl flow CP-XXX [--from stage] [--to stage] [--repo-path path]'); throw new Error('TASKCTL_EXIT'); }
      await cmdFlow({
        orchRoot: ORCHESTRATION_ROOT,
        tasksDir: TASKS_DIR,
        issueKey: flowIssueKey,
        args: args,
        runCommand: bridge,
        runtimeConfig: rcfg,
        loadJiraConfig: () => loadJiraCreds(tcfg, { envPath: path.join(__dirname, '.env') }),
      });
      break;
    }
    case 'autopilot': {
      const apIssueKey = args[0];
      if (!apIssueKey) { console.error('Usage: taskctl autopilot CP-XXX [--repo-path path] [--yes]'); throw new Error('TASKCTL_EXIT'); }
      await cmdAutopilot({
        orchRoot: ORCHESTRATION_ROOT,
        tasksDir: TASKS_DIR,
        issueKey: apIssueKey,
        args: args,
        runCommand: bridge,
        runtimeConfig: rcfg,
        loadJiraConfig: () => loadJiraCreds(tcfg, { envPath: path.join(__dirname, '.env') }),
      });
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      throw new Error('TASKCTL_EXIT');
  }
}

// --- Commands ---

// Fetch the full Jira context required by `buildContextMd`: direct comments,
// issue links, linked-issue details (description + status + priority), comments
// of linked issues, and downloaded attachments. Shared between `cmdSync` and
// `cmdRefresh` so context.md has the same shape regardless of entry point.
//
// Caller must pass the already-fetched `issue` (both cmds fetch + validate it
// before calling here) and an existing `taskDir` for attachment storage.
async function fetchFullJiraContext(jira, issueKey, issue, taskDir) {
  const comments = await jira.fetchComments(issueKey);
  const links = await jira.fetchLinks(issueKey);
  const linkedDetails = await jira.fetchLinkedIssueDetails(links);

  const linkedComments = {};
  for (const key of Object.keys(linkedDetails)) {
    try {
      const lc = await jira.fetchComments(key);
      if (lc.length > 0) linkedComments[key] = lc;
    } catch { /* skip */ }
  }

  const attachments = issue.fields?.attachment ?? [];
  const downloadedAttachments = [];
  if (attachments.length > 0) {
    const attachDir = path.join(taskDir, 'attachments');
    await fs.mkdir(attachDir, { recursive: true });
    for (const att of attachments) {
      try {
        const buf = await jira.downloadAttachment(att.content);
        const filePath = path.join(attachDir, att.filename);
        await fs.writeFile(filePath, buf);
        downloadedAttachments.push({ filename: att.filename, mimeType: att.mimeType, size: att.size });
        console.log(`  ↓ ${att.filename} (${(att.size / 1024).toFixed(0)} KB)`);
      } catch (err) {
        console.warn(`  ⚠ Failed to download ${att.filename}: ${err.message}`);
      }
    }
  }

  return { comments, links, linkedDetails, linkedComments, downloadedAttachments };
}

// Windows reserved device names (case-insensitive, with or without extension).
const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Validate a task slug as a single safe path segment. Rejects path traversal,
 * separators, absolute paths, and Windows reserved device names / trailing dot.
 * Throws TASKCTL_EXIT on a bad slug; returns the slug on success.
 */
function validateSlug(slug) {
  if (!slug || slug.startsWith('--')) {
    console.error('Usage: taskctl new <slug> [--title "..."] [--desc "..."]');
    throw new Error('TASKCTL_EXIT');
  }
  const base = slug.split('.')[0].toUpperCase(); // "NUL.txt" / "con" → reserved stem
  const bad =
    slug === '.' || slug === '..' ||
    slug.includes('/') || slug.includes('\\') ||
    path.isAbsolute(slug) ||
    path.basename(slug) !== slug ||   // catches any embedded separator/segment
    slug.endsWith('.') ||             // trailing dot — invalid on Windows (CON., demo.)
    WIN_RESERVED.has(base) ||         // CON / NUL / COM1 … reserved device names
    !/^[A-Za-z0-9._-]+$/.test(slug);  // allowlist
  if (bad) {
    console.error(`Invalid slug "${slug}". Use a single path segment: letters, digits, '.', '_', '-' (no '/', '\\', '..', trailing '.', Windows reserved names like CON/NUL, or absolute paths).`);
    throw new Error('TASKCTL_EXIT');
  }
  return slug;
}

/** Parse a `--flag value` pair from args (mirrors parseRepoPath idiom). */
function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return (idx !== -1 && args[idx + 1] !== undefined && !String(args[idx + 1]).startsWith('--'))
    ? args[idx + 1]
    : null;
}

/**
 * `taskctl new <slug> [--title …] [--desc …]` — create a LOCAL task with no
 * Jira. ALWAYS builds the local adapter directly (never makeTracker on the
 * configured tracker), so even in a jira-configured project `new` does no
 * network fetch and never constructs a JiraClient.
 */
async function cmdNew(slug, args, rcfg = null) {
  const safe = validateSlug(slug);
  const title = flagValue(args, '--title') ?? safe;
  const desc = flagValue(args, '--desc') ?? '';
  const taskDir = path.join(TASKS_DIR, safe);

  // Defense-in-depth: the resolved task dir must stay under TASKS_DIR.
  const resolved = path.resolve(taskDir);
  const tasksRoot = path.resolve(TASKS_DIR);
  if (resolved !== path.join(tasksRoot, safe)) {
    console.error(`Invalid slug "${slug}": resolved path escapes ${TASKS_DIR}.`);
    throw new Error('TASKCTL_EXIT');
  }

  // Refuse to clobber an existing task (sync re-syncs; new must not overwrite).
  if (fsSync.existsSync(path.join(taskDir, 'context.md'))) {
    console.error(`Task ${safe} already exists at ${taskDir}. Edit it or pick another slug.`);
    throw new Error('TASKCTL_EXIT');
  }

  await fs.mkdir(path.join(taskDir, 'runs'), { recursive: true });

  // ALWAYS local adapter — no creds, no network, regardless of tracker.type.
  const tracker = makeLocalTracker({ type: 'local' }, buildLocalTrackerDeps(rcfg));
  const { contextMd, state } = await tracker.seedContext(safe, taskDir, { title, desc }, null);

  await fs.writeFile(path.join(taskDir, 'context.md'), contextMd, 'utf8');
  await fs.writeFile(path.join(taskDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

  console.log(`✓ ${safe} created (tracker: local)  ->  context.md, state.json`);
  console.log(`  next: taskctl plan ${safe}`);
}

// ── new-project (WP5 Stage 5b) ──────────────────────────────────────────────

/** Render a brainstorm envelope into a human-readable brainstorm.md. */
function renderBrainstormMd(slug, idea, env) {
  const sec = (h, items) => [`## ${h}`, '', ...(items.length ? items.map((x) => `- ${x}`) : ['- (none)']), ''];
  return [
    `# Brainstorm — ${slug}`, '',
    `> Idea: ${idea}`, '',
    ...sec('Open questions (answer these, then re-invoke)', env.questions),
    ...sec('Assumptions', env.assumptions),
    ...sec('Candidate options', env.options),
  ].join('\n');
}

/** Render a proposal envelope into proposal.md. */
function renderProposalMd(slug, env) {
  const lines = [`# Proposal — ${slug}`, '', `Recommended option: **${env.recommended}**`, ''];
  for (const o of env.options) {
    lines.push(`## Option ${o.id}${o.id === env.recommended ? ' (recommended)' : ''}`, '', `- Stack: ${o.stack}`, `- Rationale: ${o.rationale}`, '');
  }
  return lines.join('\n');
}

/** Render a scaffold envelope into scaffold-plan.md (PRINT-ONLY commands). */
function renderScaffoldMd(slug, env) {
  return [
    `# Scaffold plan — ${slug}`, '',
    '> These commands are PRINTED for you to run. taskctl NEVER executes them.', '',
    '## Commands (run in the TARGET dir, then `git init`)', '',
    '```sh', ...env.commands, '```', '',
    '## Intended file tree', '',
    ...(env.fileTree.length ? env.fileTree.map((f) => `- ${f}`) : ['- (engine did not specify)']), '',
  ].join('\n');
}

/**
 * `taskctl new-project "<idea>" [--dir <path>] [--engine <name>] [--yes] [--restart]`
 *
 * The unified entry point + resumable state machine (plan v5). Produces a
 * SELF-CONTAINED orchestration workspace under <TARGET>; THIS workspace is
 * byte-unchanged except the exclusively-owned ai/newproject/<target-id>/ flow
 * dir. `deps` (test-only) overrides the engine runner / readline / liveness probe
 * / clock so the whole machine runs hermetically under the fake adapter.
 */
async function cmdNewProject(idea, args, rcfg = null, deps = {}) {
  if (!idea || String(idea).startsWith('--')) {
    console.error('Usage: taskctl new-project "<idea>" [--dir <path>] [--engine <name>] [--yes] [--restart]');
    throw new Error('TASKCTL_EXIT');
  }

  const yes = args.includes('--yes');
  const restart = args.includes('--restart');
  const slug = np.slugify(flagValue(args, '--slug') ?? idea);
  const dirArg = flagValue(args, '--dir') ?? path.join(process.cwd(), slug);
  const canonicalTarget = np.canonicalTargetPath(dirArg);

  // The workspace root the flow record lives under, and the install template
  // SOURCE. Default to the module values (the discovered root + the install);
  // the e2e test overrides them to run inside a temp installation copy without
  // touching the real workspace (confinement).
  const workspaceRoot = deps.workspaceRoot ?? ORCHESTRATION_ROOT;
  const installTemplatesDir = deps.installTemplatesDir ?? INSTALL_TEMPLATES_DIR;
  const tid = np.targetId(canonicalTarget);
  const flowDir = np.flowDirFor(workspaceRoot, tid);

  // Injected seams (production defaults; tests override).
  const runEngine = deps.runEngineStep ?? runEngineStep;
  const ask = deps.ask ?? defaultAsk;
  const lockDeps = deps.lockDeps ?? {};
  const now = deps.now ?? (() => Date.now());

  const pack = promptPack(rcfg);
  const planner = parseEngine(args, rcfg, 'planner');

  // ── STEP 0: containment guard (pure; precedes the lock) ───────────────────
  // Reject --dir equal to / containing / contained-by THIS workspace.
  const realWs = np.canonicalTargetPath(workspaceRoot);
  if (canonicalTarget === realWs || isInside(canonicalTarget, realWs) || isInside(realWs, canonicalTarget)) {
    console.error(`new-project: --dir "${dirArg}" must not be, contain, or be inside the orchestration workspace.`);
    throw new Error('TASKCTL_EXIT');
  }

  await fs.mkdir(flowDir, { recursive: true });

  // ── STEP 1: acquire the ONE stable flow.lock FIRST ────────────────────────
  let lock;
  try {
    lock = await np.acquireFlowLock(flowDir, { now: now(), ...lockDeps });
  } catch (e) {
    if (String(e.message).startsWith('TASKCTL_LOCKED:')) {
      console.error(`new-project: ${e.message.slice('TASKCTL_LOCKED:'.length)}`);
      throw new Error('TASKCTL_EXIT');
    }
    throw e;
  }

  try {
    // ── STEP 2: read + validate record → three-way branch ──────────────────
    let record = await np.readRecord(flowDir);

    if (record) {
      record._persisted = true; // came from disk — never re-create exclusively
      // (a) RESUME — validate identity.
      if (record.canonicalTarget !== canonicalTarget || record.idea !== idea || record.slug !== slug) {
        console.error(
          `new-project: this flow dir is bound to a different target/idea ` +
          `(${record.canonicalTarget}). Pass a different --dir or --restart.`,
        );
        throw new Error('TASKCTL_EXIT');
      }
      if (restart) {
        const ts = await np.archiveFlowDir(flowDir, { now: now() });
        record = freshRestartRecord(idea, slug, canonicalTarget, ts);
        await np.writeRecord(flowDir, stripTransient(record));
        console.log(`  ↻ --restart: archived prior flow content → archive-${ts}; starting fresh.`);
      }
    } else if (await np.hasStraysOrArchive(flowDir)) {
      // (b) RECOVERY — no record but strays/archive (crash mid-restart).
      const ts = await np.recoverInterruptedArchive(flowDir, { now: now() });
      record = freshRestartRecord(idea, slug, canonicalTarget, ts);
      await np.writeRecord(flowDir, stripTransient(record));
      console.log(`  ↻ recovered interrupted restart (swept strays → archive-${ts}); resuming.`);
    } else {
      // (c) FIRST-RUN — only NOW apply emptiness rules.
      if (await targetIsNonEmpty(canonicalTarget)) {
        console.error(`new-project: target "${dirArg}" is not empty. Pick an empty dir or a new path.`);
        throw new Error('TASKCTL_EXIT');
      }
      record = firstRunRecord(idea, slug, canonicalTarget);
    }

    // ── STEP 3: engine probe — ONLY if the current step is engine-driven ────
    if (np.ENGINE_STEPS.has(record.step)) {
      let adapter;
      try { adapter = getEngine(planner); } catch { adapter = null; }
      const probe = adapter ? await adapter.probeAvailability() : { available: false };
      if (!probe.available) {
        const why = adapter ? 'not runnable' : 'not registered';
        console.error(
          `new-project: no engine available (planner "${planner}" ${why}). ` +
          `Configure/install an engine before scaffolding.`,
        );
        throw new Error('TASKCTL_EXIT');
      }
    }

    // ── STEP 4: create the record on first run, then drive the machine ──────
    if (!record._persisted) {
      await np.createRecordExclusive(flowDir, stripTransient(record));
      record._persisted = true;
    }

    await runNewProjectMachine({
      record, flowDir, canonicalTarget, slug, idea, planner, pack, rcfg,
      runEngine, ask, yes, now, workspaceRoot, installTemplatesDir,
      flowToken: lock.token,
    });
  } catch (e) {
    // Normalize `TASKCTL_EXIT:<detail>` halts (corrupt/invalid record from
    // readRecord, backlog dir collision from publishBacklogItem) into a printed
    // message + the bare sentinel, so the top-level handler exits quietly (I-1/C2).
    if (String(e.message).startsWith('TASKCTL_EXIT:')) {
      console.error(`new-project: ${e.message.slice('TASKCTL_EXIT:'.length)}`);
      throw new Error('TASKCTL_EXIT');
    }
    throw e;
  } finally {
    await lock.release();
  }
}

/** Strip every transient `_`-prefixed runtime field before persisting. */
function stripTransient(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

/** A non-terminal step list helper. */
function firstRunRecord(idea, slug, canonicalTarget) {
  return {
    schemaVersion: np.RECORD_SCHEMA_VERSION, idea, slug, canonicalTarget,
    step: 'brainstorm', chosenOption: null, backlog: [], scaffoldEmitted: false,
  };
}
function freshRestartRecord(idea, slug, canonicalTarget, archiveTs) {
  return {
    schemaVersion: np.RECORD_SCHEMA_VERSION, idea, slug, canonicalTarget,
    step: 'brainstorm', chosenOption: null, backlog: [], scaffoldEmitted: false,
    restartedFrom: archiveTs, _persisted: true,
  };
}

/** Default readline confirm/choice prompt (production). */
async function defaultAsk(question) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

/** path.relative-based containment: is `child` strictly inside `parent`? */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !path.isAbsolute(rel) && !rel.startsWith('..' + path.sep) && rel !== '..';
}

/** Is `p` the canonical target itself, or strictly inside it? */
function isAtOrInside(p, parent) {
  return p === parent || isInside(p, parent);
}

/**
 * C4 — descendant link confinement. Canonicalizing only the TARGET ROOT does not
 * constrain its descendants: a scaffold could make `<TARGET>/ai/tasks` (or
 * `ai/templates`) a symlink/junction pointing OUTSIDE the target, and a naive
 * write would follow it. Before ANY product write under the target (task
 * publication, template seeding, config write), realpath-verify every EXISTING
 * ancestor segment of the destination resolves at-or-inside the canonical target;
 * reject with a clear error otherwise. Segments that do not yet exist are fine
 * (they'll be created inside). `canonicalTarget` is assumed already realpath'd.
 *
 * @param {string} canonicalTarget  realpath of the target root
 * @param {string} destPath         an absolute path under the target we are about to write
 */
async function assertConfinedToTarget(canonicalTarget, destPath) {
  const resolvedDest = path.resolve(destPath);
  if (!isAtOrInside(resolvedDest, canonicalTarget)) {
    console.error(
      `new-project: refusing to write outside the target — "${destPath}" is not inside ${canonicalTarget}.`,
    );
    throw new Error('TASKCTL_EXIT');
  }
  // Walk each ancestor segment from the target down to (and including) the dest.
  const rel = path.relative(canonicalTarget, resolvedDest);
  const segments = rel === '' ? [] : rel.split(path.sep);
  let prefix = canonicalTarget;
  for (const seg of segments) {
    prefix = path.join(prefix, seg);
    let real;
    try {
      real = await fs.realpath(prefix);
    } catch {
      break; // this segment (and anything below) does not exist yet → safe
    }
    if (!isAtOrInside(real, canonicalTarget)) {
      console.error(
        `new-project: refusing to follow a link that escapes the target — ` +
        `"${prefix}" resolves to "${real}", outside ${canonicalTarget}. ` +
        `Remove the link and re-invoke.`,
      );
      throw new Error('TASKCTL_EXIT');
    }
  }
}

/** A target dir is "non-empty" when it exists and has at least one entry. */
async function targetIsNonEmpty(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false; // absent → empty (a new dir)
  }
}

/**
 * Drive the resumable state machine from record.step to `done`. Each engine step
 * writes its prompt FILE into the flow dir, runs the engine via the injected
 * runner, validates the structured envelope, renders the artifact, checkpoints
 * the record, and advances. Non-engine steps (choose/await_scaffold/attach/done)
 * run deterministically.
 */
async function runNewProjectMachine(ctx) {
  const { record, flowDir, canonicalTarget, slug, idea, planner, pack, rcfg, runEngine, ask, yes, workspaceRoot, installTemplatesDir, flowToken } = ctx;
  const O = flowDir.replace(/\\/g, '/');

  // Persist the durable record, stripping every transient `_`-prefixed runtime
  // field (e.g. _persisted, _proposalOptions, _recommended) so they never land
  // on disk (the record on resume must validate cleanly).
  const persist = () => np.writeRecord(flowDir, stripTransient(record));
  const runStep = async (kind, promptLines) => {
    const promptFile = path.join(flowDir, `.prompt-newproject-${kind}.md`);
    await fs.writeFile(promptFile, promptLines.join('\n') + '\n', 'utf8');
    const captureTarget = path.join(flowDir, `.capture-${kind}.txt`);
    const { code, output } = await runEngine({
      engine: planner, promptFile, orchRoot: workspaceRoot, cwd: flowDir,
      captureTarget, reasoningEffort: rcfg?.engines?.reasoningEffort,
    });
    // I-3: a nonzero engine exit is a FAILURE even if stdout happens to parse —
    // do NOT advance the flow; the record stays at the current step.
    if (code !== 0) {
      console.error(`new-project: ${kind} engine exited with code ${code}. Flow stays at "${record.step}"; fix + re-invoke.`);
      throw new Error('TASKCTL_EXIT');
    }
    const res = parseAndValidate(kind, output);
    if (!res.ok) {
      console.error(`new-project: ${kind} step produced an invalid envelope — ${res.error}. Flow stays at "${record.step}"; fix + re-invoke.`);
      throw new Error('TASKCTL_EXIT');
    }
    return res.value;
  };

  // Loop until terminal; each case advances record.step + checkpoints.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    switch (record.step) {
      case 'brainstorm': {
        const env = await runStep('brainstorm', pack.newProjectBrainstorm({ flowDir: O, idea, slug }));
        await fs.writeFile(path.join(flowDir, 'brainstorm.md'), renderBrainstormMd(slug, idea, env), 'utf8');
        record.step = 'proposal';
        await persist();
        const hints = pack.newProjectBrainstormConsole({ flowDir: O });
        console.log(hints.preparedLine);
        console.log(hints.editHeader);
        console.log(hints.editLine);
        return; // PAUSE for user edit (C6) — re-invoke continues at proposal
      }
      case 'proposal': {
        const env = await runStep('proposal', pack.newProjectProposal({ flowDir: O, idea, slug }));
        await fs.writeFile(path.join(flowDir, 'proposal.md'), renderProposalMd(slug, env), 'utf8');
        // DURABLE (not transient): choose needs these even after a crash here.
        record.proposalOptions = env.options.map((o) => o.id);
        record.recommended = env.recommended;
        record.step = 'choose';
        await persist();
        console.log(pack.newProjectProposalConsole({ flowDir: O }).preparedLine);
        // fall through to choose in the same invocation (choose is deterministic)
        break;
      }
      case 'choose': {
        const options = record.proposalOptions ?? [];
        const recommended = record.recommended ?? options[0];
        let chosen = recommended;
        if (!yes) {
          const answer = (await ask(`\n  Choose an option [${options.join('/')}] (default ${recommended}): `)).trim();
          if (answer && options.includes(answer)) chosen = answer;
        }
        record.chosenOption = chosen;
        record.step = 'scaffold_generate';
        await persist();
        console.log(`  → chosen option: ${chosen}`);
        break;
      }
      case 'scaffold_generate': {
        const env = await runStep('scaffold', pack.newProjectScaffold({ flowDir: O, idea, slug, chosenOption: record.chosenOption }));
        await fs.writeFile(path.join(flowDir, 'scaffold-plan.md'), renderScaffoldMd(slug, env), 'utf8');
        record.scaffoldEmitted = true;
        record.step = 'await_scaffold';
        await persist();
        const sc = pack.newProjectScaffoldConsole({ flowDir: O });
        console.log(sc.preparedLine);
        console.log(sc.runHeader);
        for (const c of env.commands) console.log(`  ${c}`);
        console.log('  git init');
        console.log(`  (then re-invoke: taskctl new-project "${idea}" --dir ${canonicalTarget})`);
        return; // PAUSE — no engine; user runs the printed commands + git init
      }
      case 'await_scaffold': {
        // NO engine call. Deterministic predicate: target is a git work tree.
        if (!gitIsWorkTree(canonicalTarget)) {
          console.log(`\n  Waiting: run the scaffold commands in ${canonicalTarget}, then \`git init\`, then re-invoke.`);
          console.log(`  (scaffold plan: ${O}/scaffold-plan.md)`);
          return; // stay at await_scaffold; exit 0 (idempotent, no writes)
        }
        record.step = 'backlog';
        await persist();
        break;
      }
      case 'backlog': {
        await runBacklogStep({ record, flowDir, canonicalTarget, slug, idea, planner, pack, rcfg, runEngine, persist, O, workspaceRoot, installTemplatesDir, flowToken });
        record.step = 'attach';
        await persist();
        break;
      }
      case 'attach': {
        if (!gitIsWorkTree(canonicalTarget)) {
          console.error('new-project: target is not a git work tree. Run the printed scaffold + `git init` first.');
          record.step = 'await_scaffold';
          await persist();
          throw new Error('TASKCTL_EXIT');
        }
        const cfgPath = path.join(canonicalTarget, 'taskctl.config.json');
        // C4: the config destination must be inside the canonical target (a
        // taskctl.config.json symlink could redirect the write elsewhere).
        await assertConfinedToTarget(canonicalTarget, cfgPath);
        if (fsSync.existsSync(cfgPath)) {
          // I-2: an existing config is only a valid self-attach skip when it is
          // parseable JSON AND repoPath === "." (a self-contained root). A config
          // pointing at ANOTHER repo, or unparseable, must HALT — never silently
          // accept a workspace attached elsewhere, never clobber a real config.
          let existingCfg;
          try {
            existingCfg = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8'));
          } catch (e) {
            console.error(
              `new-project: ${cfgPath} exists but is not valid JSON (${e.message}). ` +
              `Fix or remove it, then re-invoke — taskctl will not overwrite it.`,
            );
            throw new Error('TASKCTL_EXIT');
          }
          if (existingCfg?.repoPath !== '.') {
            console.error(
              `new-project: ${cfgPath} already exists with repoPath ` +
              `${JSON.stringify(existingCfg?.repoPath)} (expected "." for a self-contained ` +
              `workspace). This target is attached elsewhere — resolve it manually ` +
              `(remove the config to self-attach), then re-invoke.`,
            );
            throw new Error('TASKCTL_EXIT');
          }
          // Idempotent: a valid self-attach already present (e.g. a --restart of a
          // completed flow). Don't clobber its config — just advance.
          console.log(`  ✓ self-attach already present: ${cfgPath}`);
        } else {
          const { outPath } = await attachToConfigRoot(canonicalTarget, { configRoot: canonicalTarget, force: false });
          console.log(`  ✓ self-attached: ${outPath} (repoPath ".")`);
        }
        record.step = 'done';
        await persist();
        break;
      }
      case 'done': {
        console.log('\n✓ new-project complete. Next steps:');
        console.log(`  cd ${canonicalTarget}`);
        const first = record.backlog[0]?.slug;
        if (first) console.log(`  taskctl plan ${first}`);
        console.log('  taskctl status');
        return; // terminal
      }
      default:
        throw new Error(`new-project: unknown step "${record.step}"`);
    }
  }
}

/**
 * The backlog step: run the engine → validate {tasks[]} → derive deterministic
 * slugs → durable-phased publish each under <TARGET>/ai/tasks (temp+marker+rename,
 * adoption on resume) → seed <TARGET>/ai/templates via the cmdInit copy loop.
 */
async function runBacklogStep({ record, flowDir, canonicalTarget, slug, idea, planner, pack, rcfg, runEngine, persist, O, workspaceRoot, installTemplatesDir, flowToken }) {
  const tasksDir = path.join(canonicalTarget, 'ai', 'tasks');
  // C4: verify ai + ai/tasks do not resolve outside the canonical target BEFORE
  // the first write (mkdir would otherwise follow an escaping junction).
  await assertConfinedToTarget(canonicalTarget, tasksDir);
  await fs.mkdir(tasksDir, { recursive: true });

  // Run the engine + derive the backlog ONCE (when not already recorded).
  if (!record.backlog || record.backlog.length === 0) {
    const promptFile = path.join(flowDir, '.prompt-newproject-backlog.md');
    await fs.writeFile(promptFile, pack.newProjectBacklog({ flowDir: O, idea, slug }).join('\n') + '\n', 'utf8');
    const captureTarget = path.join(flowDir, '.capture-backlog.txt');
    const { code, output } = await runEngine({ engine: planner, promptFile, orchRoot: workspaceRoot, cwd: flowDir, captureTarget, reasoningEffort: rcfg?.engines?.reasoningEffort });
    // I-3: nonzero engine exit → fail, record unchanged (stays at "backlog").
    if (code !== 0) {
      console.error(`new-project: backlog engine exited with code ${code}. Flow stays at "backlog"; fix + re-invoke.`);
      throw new Error('TASKCTL_EXIT');
    }
    const res = parseAndValidate('backlog', output);
    if (!res.ok) {
      console.error(`new-project: backlog step produced an invalid envelope — ${res.error}. Flow stays at "backlog"; fix + re-invoke.`);
      throw new Error('TASKCTL_EXIT');
    }
    record.backlog = res.value.tasks.map((t, i) => ({
      slug: np.backlogSlug(slug, i + 1, t.slug),
      title: t.title, desc: t.desc, phase: 'planned', manifestHash: null,
    }));
    await persist();
  }

  // Seed the target's ai/templates (the standalone workspace needs them). SOURCE
  // = the install's bundled templates (NOT the discovered root). C4: verify
  // ai/templates does not escape the target before copying into it.
  const templatesDest = path.join(canonicalTarget, 'ai', 'templates');
  await assertConfinedToTarget(canonicalTarget, templatesDest);
  await seedDirIfMissing(installTemplatesDir, templatesDest);

  // Publish each task durably. Content is produced LAZILY via the local
  // tracker's seedContext (the WP1 mechanism), written under TARGET — lazy so a
  // resume that ADOPTS does not regenerate freshly-timestamped bytes.
  const tracker = makeLocalTracker({ type: 'local' }, buildLocalTrackerDeps(rcfg));
  const tid = np.targetId(record.canonicalTarget);
  for (const item of record.backlog) {
    if (item.phase === 'published') continue;
    // C4: re-verify the per-task final dir path is confined before publishing it.
    await assertConfinedToTarget(canonicalTarget, path.join(tasksDir, item.slug));
    await np.publishBacklogItem({
      tasksDir, item, targetId: tid, flowToken, persistRecord: persist,
      makeContent: async () => {
        const { contextMd, state } = await tracker.seedContext(item.slug, path.join(tasksDir, item.slug), { title: item.title, desc: item.desc }, null);
        return { contextMd, stateJson: JSON.stringify(state, null, 2) };
      },
    });
  }
  console.log(pack.newProjectBacklogConsole({ count: record.backlog.length }).preparedLine);
}

/**
 * `taskctl attach <repo-path> [--force]` — STRICTLY READ-ONLY analysis of a
 * target repo that derives a valid taskctl.config.json (the WP2 schema) and
 * writes it to the ORCHESTRATION workspace (the sidecar), never the target.
 *
 * Thin production wrapper: it passes the DISCOVERED workspace root (New-C1) as
 * the configRoot — so `taskctl attach` run from inside an orchestration
 * workspace writes THAT workspace's sidecar config (not the install's) and the
 * next invocation from there picks it up — and prints the Project Understanding
 * summary BEFORE the success line so warnings precede the write confirmation.
 * The clobber-guard + atomic write live in `attachToConfigRoot`.
 *
 * `--deep` is REJECTED (no silent no-op): the LLM-enrichment tier lands in WP5.
 */
async function cmdAttach(args) {
  const targetPath = args[0];
  const force = args.includes('--force');

  if (args.includes('--deep')) {
    console.error(
      'attach: --deep is reserved for a future release (LLM enrichment, WP5) and is not yet supported.',
    );
    throw new Error('TASKCTL_EXIT');
  }

  const { outPath, profile } = await attachToConfigRoot(targetPath, {
    configRoot: ORCHESTRATION_ROOT,
    force,
  });

  console.log(renderUnderstanding(profile));
  console.log('');
  console.log(`✓ wrote ${outPath}`);
  console.log('  next: taskctl new <slug>  /  taskctl status');
}

// `rcfg` is threaded in so the context-options bundle (project sections +
// opt-in GRACE) can be forwarded to the jira tracker's seedContext →
// buildContextMd 3rd arg. When grace is disabled (default) and no project
// sections are configured, context.md is project-neutral and GRACE-free.
async function cmdSync(config, issueKey, rcfg = null) {
  if (!issueKey) {
    console.error('Usage: taskctl sync CP-XXX');
    throw new Error('TASKCTL_EXIT');
  }

  // Belt-and-suspenders: the main() chokepoint already rejects sync in local
  // mode before any creds are loaded, so `config` is non-null here on the jira
  // path. This guard stays as defense-in-depth for any direct caller.
  if (!config) {
    console.error('Cannot sync: tracker is local; Jira is not configured. Use `taskctl new <slug>` to create a task without Jira.');
    throw new Error('TASKCTL_EXIT');
  }

  console.log(`Syncing ${issueKey}...`);

  const taskDir = path.join(TASKS_DIR, issueKey);
  const statePath = path.join(taskDir, 'state.json');

  // Read existing state FIRST (preserving read-then-merge order), then thread
  // it into the tracker so the jira adapter's buildSyncState can merge re-syncs.
  // This is a read-only, ENOENT-tolerant probe — it creates no directory, so a
  // first sync against a missing issue still leaves no empty task dir (below).
  let existingState = null;
  try {
    existingState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    existingState = null; // first sync
  }

  // Restore the original ordering (old cli.mjs:901-908): fetch + validate the
  // issue BEFORE creating any task directory, so a missing issue never leaves an
  // empty task dir. seedContext throws "not found in Jira" right after fetchIssue
  // — before fetchFullJiraContext could lazily create taskDir/attachments.
  const tracker = makeJiraTracker({ type: 'jira' }, buildJiraTrackerDeps(config, buildCtxOpts(rcfg)));
  let result;
  try {
    result = await tracker.seedContext(issueKey, taskDir, {}, existingState);
  } catch (err) {
    // Preserve the original "issue not found" UX as a clean exit.
    if (/not found in Jira/i.test(err.message)) {
      console.error(err.message);
      throw new Error('TASKCTL_EXIT');
    }
    throw err;
  }
  const { contextMd, state } = result;

  // Issue validated → now create the task dirs and write artifacts. (taskDir may
  // already exist if fetchFullJiraContext downloaded attachments; both mkdirs are
  // recursive and idempotent.)
  await fs.mkdir(taskDir, { recursive: true });
  await fs.mkdir(path.join(taskDir, 'runs'), { recursive: true });

  await fs.writeFile(path.join(taskDir, 'context.md'), contextMd, 'utf8');
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  console.log(`✓ ${issueKey} synced`);
  console.log(`  context.md v${state.contextVersion}`);
  console.log(`  stage: ${state.stage}`);
  console.log(`  depends on: ${state.dependsOn.length ? state.dependsOn.join(', ') : 'none'}`);
  console.log(`  blocks: ${state.blocks.length ? state.blocks.join(', ') : 'none'}`);
  console.log(`  path: ${taskDir}`);
}

async function cmdStatus(issueKey) {
  if (issueKey) {
    const taskDir = path.join(TASKS_DIR, issueKey);
    try {
      const state = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
      printTaskStatus(state);
    } catch {
      console.error(`Task ${issueKey} not found. Run: taskctl sync ${issueKey}`);
    }
  } else {
    await cmdList();
  }
}

async function cmdList(args = []) {
  const sprintIdx = args.indexOf('--sprint');
  const sprintFilter = sprintIdx !== -1 ? args[sprintIdx + 1] : null;

  try {
    const entries = await fs.readdir(TASKS_DIR);
    if (entries.length === 0) {
      console.log('No tasks. Run: taskctl sync CP-XXX');
      return;
    }
    let count = 0;
    for (const entry of entries.sort()) {
      try {
        const state = JSON.parse(await fs.readFile(path.join(TASKS_DIR, entry, 'state.json'), 'utf8'));

        // Filter by sprint if requested
        if (sprintFilter) {
          try {
            const ctx = await fs.readFile(path.join(TASKS_DIR, entry, 'context.md'), 'utf8');
            const sprintMatch = ctx.match(/\*\*Sprint:\*\*\s*(.+)/);
            const taskSprint = sprintMatch ? sprintMatch[1].trim() : '';
            if (!taskSprint.toLowerCase().includes(sprintFilter.toLowerCase())) continue;
          } catch {
            continue; // No context.md, skip when filtering by sprint
          }
        }

        const marker = state.stage === 'done' ? '✓' : state.stage === 'blocked' ? '✗' : state.stage === 'running' ? '▶' : '○';
        console.log(`  ${marker} ${state.issueKey.padEnd(10)} ${state.stage.padEnd(14)} next: ${state.nextAction ?? '—'}`);
        count++;
      } catch {
        // skip invalid entries
      }
    }
    if (count === 0 && sprintFilter) {
      console.log(`No tasks found for sprint "${sprintFilter}".`);
    }
  } catch {
    console.log('No tasks directory. Run: taskctl sync CP-XXX');
  }
}

async function cmdPlan(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl plan CP-XXX [--engine claude|codex] [--cc-thingz]'); process.exit(1); }

  const finalize = args.includes('--finalize');
  const useCcThingz = args.includes('--cc-thingz');
  const noBrainstorm = args.includes('--no-brainstorm');
  const engine = parseEngine(args, rcfg);
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);
  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  if (finalize) {
    // Check plan.md exists and update state
    try {
      await fs.access(path.join(taskDir, 'plan.md'));
      const planContent = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8');
      const verdict = parseVerdict(planContent);
      state.stage = 'planned';
      state.planVersion = (state.planVersion ?? 0) + 1;
      state.nextAction = 'plan review';
      await writeState(taskDir, state);
      console.log(`✓ ${issueKey} plan finalized (v${state.planVersion}, verdict: ${verdict ?? 'not set'})`);
      if (verdict !== 'APPROVE') {
        console.log(`  ⚠ Note: verdict is "${verdict ?? 'not found'}". Self-review may be needed before plan-review.`);
      }
    } catch {
      console.error(`No plan.md found in ${taskDir}. Create it first.`);
    }
    return;
  }

  // Validate context exists
  try {
    await fs.access(path.join(taskDir, 'context.md'));
  } catch {
    console.error(`No context.md found. Run: taskctl sync ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }

  // WP5 Stage 5a: cc-thingz availability is an adapter CAPABILITY, not the engine
  // name — claude/opus support it, codex does not. Queried via capabilities so a
  // future cc-thingz-capable adapter works with no edit here.
  if (useCcThingz && getEngine(engine).capabilities?.supportsCcThingz) {
    // --- cc-thingz path ---
    const prompt = [
      `# Planning: ${issueKey} (cc-thingz flow${noBrainstorm ? ', no brainstorm' : ''})`,
      '',
      promptPreamble(repoPath, taskDir, rcfg),
      ...L.planCc({ O, issueKey, noBrainstorm }),
    ].join('\n');

    await writePrompt(path.join(taskDir, '.prompt-plan.md'), prompt);
    state.nextAction = `run planning with cc-thingz in ${engine}`;
    await writeState(taskDir, state);

    // Resolved engine (claude/opus — both supportsCcThingz, both claude-shaped
    // launch) rather than a hardcoded 'claude'; preserves the exact claude launch
    // string while being correct for any cc-thingz-capable adapter (5a).
    const c = L.planCcConsole({ O, issueKey, engine, launch: launchCmd(engine, { repoPath }, rcfg) });
    console.log(c.preparedLine);
    if (!noBrainstorm) {
      console.log(c.runHeader);
      console.log(c.launchLine);
      console.log(c.readLine);
      console.log(c.skillsHeader);
      console.log(c.skill1);
      console.log(c.skill2);
      console.log(c.skill3);
    }
    console.log(c.afterHeader);
    console.log(c.finalizeLine);
  } else {
    // --- Direct prompt path (fallback without cc-thingz) ---
    const prompt = [
      `# Planning task: ${issueKey}`,
      '',
      promptPreamble(repoPath, taskDir, rcfg),
      ...L.planDirect({ O, issueKey }),
    ].join('\n');

    await writePrompt(path.join(taskDir, '.prompt-plan.md'), prompt);
    state.nextAction = `run planning in ${engine}`;
    await writeState(taskDir, state);

    const c = L.planDirectConsole({ O, issueKey, engine, launch: launchCmd(engine, { repoPath }, rcfg) });
    console.log(c.preparedLine);
    console.log(c.runHeader);
    console.log(c.launchLine);
    console.log(c.readLine);
    console.log(c.ccHeader);
    console.log(c.ccLine);
    console.log(c.afterHeader);
    console.log(c.finalizeLine);
  }
}

async function cmdPlanReview(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl plan-review CP-XXX [--engine claude|codex]'); process.exit(1); }

  const finalize = args.includes('--finalize');
  const engine = parseEngine(args, rcfg, 'reviewer');
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);
  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  if (finalize) {
    const reviewContent = await readReviewFile(taskDir);
    if (!reviewContent) {
      console.error(`No review.md found in ${taskDir}`);
      return;
    }
    const verdict = parseVerdict(reviewContent);
    if (verdict === 'APPROVE') {
      state.stage = 'plan_reviewed';
      state.nextAction = 'execute plan';
      console.log(`✓ ${issueKey} plan review: APPROVE — ready to run`);
    } else {
      state.stage = 'analysis';
      state.nextAction = 'revise plan based on review feedback';
      console.log(`⚠ ${issueKey} plan review: NEEDS REVISION — returned to analysis`);
      console.log(`  Next: taskctl revise ${issueKey} --engine ${rcfg?.engines?.planner ?? 'claude'}`);
    }
    await writeState(taskDir, state);
    return;
  }

  // Validate: must have plan.md
  try {
    await fs.access(path.join(taskDir, 'plan.md'));
  } catch {
    console.error(`No plan.md found. Run: taskctl plan ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }

  // Validate: must be in planned stage
  if (state.stage !== 'planned' && state.stage !== 'analysis') {
    console.error(`⚠ Stage is "${state.stage}". Expected "planned" for plan-review.`);
    throw new Error('TASKCTL_EXIT');
  }

  const prompt = [
    `# Plan Review: ${issueKey}`,
    '',
    promptPreamble(repoPath, taskDir, rcfg),
    ...L.planReview({ O, issueKey, issueType: state.issueType ?? 'Task' }),
  ].join('\n');

  await writePrompt(path.join(taskDir, '.prompt-review.md'), prompt);
  const reviewPromptCmd = `Read ${O}/ai/tasks/${issueKey}/.prompt-review.md and follow the instructions`;

  // WP5 Stage 5a: review-stage cwd/capture + the "auto-save vs paste-the-prompt"
  // console branch are driven by adapter capabilities, not `engine === 'codex'`.
  // writesToCwd (codex) → run in taskDir, pass the one-shot prompt, print the
  // auto-save note. Others → run in repoPath, print the prompt to paste.
  const reviewPlacement = getEngine(engine).reviewPlacement('plan-review');
  const launch = launchCmd(engine, {
    repoPath,
    cwd: reviewPlacement.writesToCwd ? taskDir : repoPath,
    skipGitRepoCheck: reviewPlacement.writesToCwd,
    reasoningEffort: rcfg?.engines?.reasoningEffort,
    prompt: reviewPlacement.writesToCwd ? reviewPromptCmd : undefined,
  });
  const c = L.planReviewConsole({ O, issueKey, engine, launch });
  console.log(c.preparedLine);
  console.log(c.runHeader);
  console.log(c.launchLine);
  if (!reviewPlacement.writesToCwd) {
    console.log(`  > ${reviewPromptCmd}`);
  }
  if (reviewPlacement.writesToCwd) {
    console.log(L.codexAutoSaveNote(`plan-review ${issueKey}`));
  }
  console.log(c.afterHeader);
  console.log(c.finalizeLine);
}

async function cmdRun(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl run CP-XXX [--engine claude|codex] [--repo-path <path>]'); process.exit(1); }

  const finalize = args.includes('--finalize');
  const skipGraceGate = args.includes('--skip-grace-gate');
  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  if (finalize) {
    // ── GRACE gate ────────────────────────────────────────────────────
    // Only runs when GRACE is explicitly enabled. When disabled (default),
    // the gate never runs, state.graceGate is never written, and the stage
    // advances as a normal project. When enabled it fires before the stage
    // is advanced from `running` to `review`; on FAIL the stage stays at
    // `running`. Branch-aware: skipped silently on non-pilot branches.
    if (rcfg?.grace?.enabled && !skipGraceGate) {
      const vpRepoRoot = parseRepoPath(args) ?? state.worktreePath ?? rcfg.grace.repoRoot;
      const gate = await grace.runGraceGate(vpRepoRoot, rcfg.grace.pilotBranch, detectRepoBranch);
      state.graceGate = gate;

      if (gate.verdict === 'fail') {
        // Persist gate result (and keep stage at `running`) so the next
        // run/finalize retry sees the prior failure.
        await writeState(taskDir, state);
        process.stderr.write(
          `\n✗ GRACE gate FAILED for ${issueKey} — stage stays at "running".\n` +
          `  Fix the issues below and re-run: taskctl run ${issueKey} --finalize\n\n`,
        );
        grace.printGraceGateReport(gate, { stream: 'stderr' });
        throw new Error('TASKCTL_EXIT');
      }

      // Non-fail verdicts (pass / any skipped-*) are fine — continue.
      if (gate.verdict === 'pass') {
        console.log(`  GRACE gate: PASS (${gate.branch})`);
      } else if (gate.verdict === 'skipped-non-pilot-branch') {
        console.log(`  GRACE gate: skipped (branch is ${gate.branch ?? 'unknown'}, no GRACE governance)`);
      } else if (gate.verdict === 'skipped-no-grace') {
        console.log(`  GRACE gate: skipped (grace CLI unavailable — install bun + grace to enable)`);
      } else if (gate.verdict === 'skipped-no-repo') {
        console.log(`  GRACE gate: skipped (repo path not found: ${vpRepoRoot})`);
      }
    } else if (rcfg?.grace?.enabled && skipGraceGate) {
      const vpRepoRoot = parseRepoPath(args) ?? state.worktreePath ?? rcfg.grace.repoRoot;
      console.log(`  GRACE gate: skipped (--skip-grace-gate flag)`);
      state.graceGate = {
        verdict: 'skipped-explicit-flag',
        branch: detectRepoBranch(vpRepoRoot),
        ranAt: new Date().toISOString(),
        checks: {
          standard: { status: 'skipped', summary: '--skip-grace-gate', output: '' },
          autonomous: { status: 'skipped', summary: '--skip-grace-gate', output: '' },
          pythonXml: { status: 'skipped', summary: '--skip-grace-gate', output: '' },
        },
      };
    }
    // GRACE disabled → no gate runs; state.graceGate is left untouched and the
    // stage advances as a normal project.

    state.stage = 'review';
    state.execution.status = 'completed';
    state.execution.lastRunAt = new Date().toISOString();
    state.nextAction = 'final review';
    await writeState(taskDir, state);
    console.log(`✓ ${issueKey} execution completed, ready for review`);
    return;
  }

  // Validate: must have plan.md with APPROVE verdict
  let planContent;
  try {
    planContent = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8');
  } catch {
    console.error(`No plan.md found. Run: taskctl plan ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }

  const planVerdict = parseVerdict(planContent);
  if (planVerdict !== 'APPROVE') {
    console.error(`⚠ plan.md verdict is "${planVerdict ?? 'not found'}". Plan must be APPROVE to run.`);
    throw new Error('TASKCTL_EXIT');
  }

  // Validate: must have passed plan-review
  if (!['plan_reviewed', 'running'].includes(state.stage)) {
    console.error(`⚠ Stage is "${state.stage}". Run plan-review first (required stage: plan_reviewed).`);
    throw new Error('TASKCTL_EXIT');
  }

  const engine = parseEngine(args, rcfg);
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);

  // Auto-create branch + worktree
  const slug = issueKey.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (repoPath && !state.branch) {
    const isBug = (state.issueType ?? '').toLowerCase() === 'bug';
    state.branch = `${isBug ? 'bugfix' : 'feature'}/${slug}`;
  }

  // Resolve worktree base branch:
  //   1. Explicit CLI: `--branch-from <name>` always wins
  //   2. Persisted `state.baseBranch` (from a previous run)
  //   3. Configured integration branch (rcfg.branches.integration, default 'dev')
  //      — WP2 Stage 2b. With the GRACE full-mode collapse there is no longer a
  //      pilot-vs-integration worktree split.
  const baseBranchOverride = parseBranchFrom(args);
  const baseBranch =
    baseBranchOverride ??
    state.baseBranch ??
    rcfg?.branches?.integration ??
    'dev';
  if (baseBranchOverride && state.baseBranch !== baseBranch) {
    state.baseBranch = baseBranch;
  }

  if (repoPath && state.branch) {
    try {
      const wtDir = ensureWorktree(repoPath, state.branch, slug, baseBranch);
      state.worktreePath = wtDir;
      console.log(`  Branch: ${state.branch}`);
      console.log(`  Worktree: ${wtDir}`);
    } catch (err) {
      console.warn(`  ⚠ Could not create worktree: ${err.message}`);
      console.warn(`  Falling back to main repo directory`);
    }
  }

  const workDir = resolveWorkDir(state, repoPath);

  const prompt = [
    `# Execution: ${issueKey}`,
    '',
    promptPreamble(workDir, taskDir, rcfg),
    ...L.run({ O, issueKey }),
  ].join('\n');

  await writePrompt(path.join(taskDir, '.prompt-run.md'), prompt);
  state.stage = 'running';
  state.execution.engine = engine;
  state.execution.status = 'active';
  state.nextAction = `executing plan in ${engine}`;
  await writeState(taskDir, state);

  const c = L.runConsole({ O, issueKey, engine, launch: launchCmd(engine, { repoPath }, rcfg), branch: state.branch });
  console.log(c.preparedLine);
  if (c.branchLine) console.log(c.branchLine);
  console.log(c.runHeader);
  console.log(c.launchLine);
  console.log(c.readLine);
  console.log(c.afterHeader);
  console.log(c.finalizeLine);
}

async function cmdReview(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl review CP-XXX'); process.exit(1); }

  const finalize = args.includes('--finalize');
  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  if (finalize) {
    const reviewContent = await readReviewFile(taskDir);
    if (!reviewContent) {
      console.error(`No review.md found in ${taskDir}. Complete the review first.`);
      throw new Error('TASKCTL_EXIT');
    }
    const verdict = parseVerdict(reviewContent);
    if (verdict === 'APPROVE') {
      state.stage = 'done';
      state.nextAction = 'publish and jira-sync';
      await writeState(taskDir, state);
      console.log(`✓ ${issueKey} review: APPROVE — ready to publish`);
      console.log(`  Next: taskctl publish ${issueKey} --repo-path <path>`);
    } else {
      state.stage = 'running';
      state.execution.status = 'needs_fix';
      state.nextAction = 'fix issues found in review';
      await writeState(taskDir, state);
      console.log(`⚠ ${issueKey} review: ${verdict ?? 'NEEDS WORK'} — returned to running`);
      console.log(`  Next: taskctl fix ${issueKey} --engine ${rcfg?.engines?.planner ?? 'claude'}`);
    }
    return;
  }

  const external = args.includes('--external');
  const engine = parseEngine(args, rcfg, 'reviewer');
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);
  const integrationBranch = rcfg?.branches?.integration ?? 'dev';

  // Auto-resolve branch & PR from the tracker PR-N label
  await resolveRepoPR(state, taskDir, repoPath);

  // Validate: execution must be completed (skip for external PRs)
  if (!external && state.stage !== 'review' && state.execution?.status !== 'completed') {
    console.error(`⚠ Stage is "${state.stage}". Execution must be completed first (taskctl run ${issueKey} --finalize).`);
    console.error(`  Tip: reviewing another developer's PR? Use: taskctl review ${issueKey} --external`);
    throw new Error('TASKCTL_EXIT');
  }

  const workDir = resolveWorkDir(state, repoPath);

  // Collect git diff if repo path provided. Diff base = configured integration
  // branch (WP2 Stage 2b). Fallback strings come from the prompt pack (neutral).
  let diffInfo = L.reviewDiffHint(integrationBranch);
  if (workDir && state.branch) {
    try {
      const run = (cmd) => execSyncTop(cmd, { cwd: workDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      // Ensure remote branch is available locally
      try { run(`git fetch origin ${state.branch}:refs/remotes/origin/${state.branch}`); } catch { /* already fetched or no remote */ }
      // Use origin/ prefix if local branch doesn't exist
      let diffRef = state.branch;
      try { run(`git rev-parse --verify ${state.branch}`); } catch { diffRef = `origin/${state.branch}`; }
      const diff = run(`git diff ${integrationBranch}...${diffRef}`);
      if (diff) {
        const diffPath = path.join(taskDir, '.diff-for-review.patch');
        await fs.writeFile(diffPath, diff, 'utf8');
        const stats = run(`git diff --stat ${integrationBranch}...${diffRef}`);
        diffInfo = `- Diff saved: ${O}/ai/tasks/${issueKey}/.diff-for-review.patch\n- Stats:\n\`\`\`\n${stats}\n\`\`\``;
        console.log(`  Diff collected: ${diff.split('\n').length} lines`);
      } else {
        diffInfo = L.reviewDiffEmpty(integrationBranch);
      }
    } catch (err) {
      console.warn(`  ⚠ Could not collect diff: ${err.message}`);
    }
  }

  const prompt = [
    `# Final Review: ${issueKey}`,
    '',
    promptPreamble(workDir, taskDir, rcfg),
    ...L.review({ O, issueKey, issueType: state.issueType ?? 'Task', diffInfo }),
  ].join('\n');

  await writePrompt(path.join(taskDir, '.prompt-review-final.md'), prompt);
  const finalReviewPromptCmd = `Read ${O}/ai/tasks/${issueKey}/.prompt-review-final.md and execute the review`;

  // WP5 Stage 5a: same adapter-driven review placement as plan-review (no
  // `engine === 'codex'` compare; capability decides cwd/capture + console form).
  const reviewPlacement = getEngine(engine).reviewPlacement('review');
  const launch = launchCmd(engine, {
    repoPath,
    cwd: reviewPlacement.writesToCwd ? taskDir : repoPath,
    skipGitRepoCheck: reviewPlacement.writesToCwd,
    reasoningEffort: rcfg?.engines?.reasoningEffort,
    prompt: reviewPlacement.writesToCwd ? finalReviewPromptCmd : undefined,
  });
  const c = L.reviewConsole({ O, issueKey, engine, launch, repoPath });
  console.log(c.preparedLine);
  console.log(c.runHeader);
  console.log(c.launchLine);
  if (!reviewPlacement.writesToCwd) {
    console.log(`  > ${finalReviewPromptCmd}`);
  }
  if (reviewPlacement.writesToCwd) {
    console.log(L.codexAutoSaveNote(`review ${issueKey} --repo-path ${repoPath}`));
  }
  console.log(c.afterHeader);
  console.log(c.finalizeLine);
}

/**
 * Sanitize free-form text for safe use as a single-line git commit subject / PR title.
 *
 * Strips backticks (shell command-substitution), control chars, collapses whitespace,
 * replaces double quotes with single quotes (so embedding in `... -m "..."` is safe even
 * without further escaping), truncates at word boundary near `maxLen`.
 */
function sanitizeForTitle(text, maxLen = 65) {
  let s = String(text ?? '')
    .replace(/`/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .trim();
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > Math.min(30, Math.floor(maxLen * 0.5)) ? cut.slice(0, lastSpace) : cut).trim();
    if (!/[.!?…]$/.test(s)) s += '…';
  }
  return s;
}

/**
 * Extract a one-line PR/commit summary from plan.md's `## Goal` section.
 *
 * Reads the first 1-3 sentences after `## Goal`, joins to one line, sanitizes,
 * truncates at word boundary. Returns null if no Goal section found.
 */
async function extractGoalSummary(taskDir, maxLen = 65) {
  try {
    const planContent = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8');
    // Match Goal section body (greedy until next ## heading or end of file)
    const m = planContent.match(/^##\s+Goal\s*\n+([\s\S]*?)(?=\n##\s|$)/im);
    if (!m) return null;
    // Take first paragraph (up to blank line or end), then first 1-2 sentences.
    // \p{Lu} (Unicode uppercase) keeps sentence splitting language-neutral.
    const para = m[1].split(/\n\s*\n/)[0] || '';
    const firstSentence = para.split(/(?<=[.!?])\s+(?=\p{Lu})/u)[0] || para;
    return sanitizeForTitle(firstSentence, maxLen);
  } catch {
    return null;
  }
}

/**
 * Build a full PR body from plan.md (Goal + Acceptance Criteria + Validation Plan)
 * plus linked-artifact references. Falls back to a minimal stub if plan.md isn't present.
 *
 * Returns markdown string. Caller writes to temp file and passes via `--body-file` to gh.
 *
 * `jiraBaseUrl` (optional, from the resolved Jira config) is used to build the
 * Jira browse link; when absent the Jira line is omitted (WP2 Stage 2b — no
 * hardcoded tracker host).
 */
async function buildPrBody(taskDir, issueKey, jiraBaseUrl = null) {
  const lines = [];
  let plan = '';
  try { plan = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8'); } catch { /* no plan.md */ }

  const sectionGrab = (heading) => {
    const re = new RegExp(`^##\\s+${heading}[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`, 'im');
    const m = plan.match(re);
    return m ? m[1].trim() : null;
  };

  const goal = sectionGrab('Goal');
  if (goal) {
    lines.push('## Summary', '', goal, '');
  } else {
    lines.push('## Summary', '', `Task: ${issueKey}`, '');
  }

  const ac = sectionGrab('Acceptance Criteria Mapping') || sectionGrab('Acceptance Criteria');
  if (ac) {
    lines.push('## Acceptance criteria', '', ac, '');
  }

  const validation = sectionGrab('Validation Plan') || sectionGrab('Done Criteria');
  if (validation) {
    lines.push('## Test plan', '', validation, '');
  } else {
    lines.push('## Test plan', '', '- [ ] Manual verification', '- [ ] CI checks pass', '');
  }

  lines.push('## Linked artifacts', '');
  lines.push(`- Plan: \`ai/tasks/${issueKey}/plan.md\``);
  lines.push(`- Context: \`ai/tasks/${issueKey}/context.md\``);
  lines.push(`- Review: \`ai/tasks/${issueKey}/review.md\``);
  // Jira browse link only when a tracker base URL is configured + the key is a
  // real (non-TBD) tracker key. No hardcoded host (WP2 Stage 2b).
  if (jiraBaseUrl && /^[A-Z]+-\d+$/.test(issueKey) && !issueKey.startsWith('CP-TBD')) {
    const base = String(jiraBaseUrl).replace(/\/$/, '');
    lines.push(`- Jira: ${base}/browse/${issueKey}`);
  }
  lines.push('');

  lines.push('🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n');
}

async function cmdPublish(config, issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl publish CP-XXX [--repo-path <path>]'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  // PR target branch from config (WP2 Stage 2b), default integration branch.
  const prTarget = rcfg?.branches?.prTarget ?? rcfg?.branches?.integration ?? 'dev';

  // Validate: must be done (review passed)
  if (state.stage !== 'done') {
    console.error(`⚠ Stage is "${state.stage}". Review must be completed first (taskctl review ${issueKey} --finalize).`);
    throw new Error('TASKCTL_EXIT');
  }

  // Determine repo path: --repo-path flag > REPO_PATH env > config repoPath.
  const repoPath = parseRepoPath(args) ?? process.env.REPO_PATH ?? rcfg?.repoPath ?? null;

  if (!repoPath) {
    console.error('Usage: taskctl publish CP-XXX --repo-path <path-to-repo>');
    console.error('  Pass --repo-path <path>, set REPO_PATH, or add "repoPath" to taskctl.config.json.');
    throw new Error('TASKCTL_EXIT');
  }

  const dryRun = args.includes('--dry-run');
  const slug = issueKey.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const isBug = (state.issueType ?? '').toLowerCase() === 'bug';
  const branchName = state.branch ?? `${isBug ? 'bugfix' : 'feature'}/${slug}`;
  const workDir = resolveWorkDir(state, repoPath);

  console.log(`\n--- Publish ${issueKey} ---`);
  console.log(`  Repo: ${repoPath}`);
  console.log(`  Worktree: ${state.worktreePath ?? '(none, using main repo)'}`);
  console.log(`  Branch: ${branchName}`);
  console.log('');

  const run = (cmd) => {
    console.log(`  $ ${cmd}`);
    return execSyncTop(cmd, { cwd: workDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  };

  try {
    // Ensure branch exists and is checked out
    try {
      run(`git checkout ${branchName}`);
    } catch {
      run(`git checkout -b ${branchName}`);
      console.log(`  Created new branch: ${branchName}`);
    }

    // Build informative commit-subject + PR title from plan.md Goal section.
    // Sanitized to be safe inside `git commit -m "..."` and `gh pr create --title "..."`
    // — strips backticks (shell substitution risk), normalizes quotes, truncates at word
    // boundary. Falls back to a generic phrase if no Goal section is found.
    const commitSummary = (await extractGoalSummary(taskDir, 65)) ?? 'implementation per approved plan';

    // Stage and commit (excluding local-only files)
    const status = run('git status --porcelain');
    if (!status) {
      console.log('\n  No changes to commit.');
    } else {
      console.log(`\n  Changes detected:\n${status.split('\n').map(l => `    ${l}`).join('\n')}`);

      if (dryRun) {
        console.log('\n  [DRY RUN] Skipping commit, push, and PR creation.');
      } else {
        // Stage all except local-only files
        run('git add -A');
        // Un-stage files that should never be committed
        try { run('git reset HEAD -- .claude/settings.local.json'); } catch { /* not staged */ }
        try { run('git reset HEAD -- .claude/'); } catch { /* not staged */ }

        // commitSummary is already sanitized (no backticks, no double quotes) so wrapping
        // in shell-quoted "..." with the issueKey prefix is safe.
        run(`git commit -m "${issueKey}: ${commitSummary}"`);
        console.log('  Committed.');
      }
    }

    // Push
    if (!dryRun) {
      try {
        run(`git push -u origin ${branchName}`);
        console.log('  Pushed to remote.');
      } catch (pushErr) {
        console.error(`  ⚠ Push failed: ${pushErr.message}`);
        console.log('  You can push manually: git push -u origin ' + branchName);
      }
    }

    // Create PR via gh (if available), skip if PR already exists
    if (!dryRun && !state.activePR) {
      // Build PR title (sanitized) + body (via temp file, bypasses shell quoting entirely)
      const prTitle = `${issueKey}: ${commitSummary}`;
      const prBody = await buildPrBody(taskDir, issueKey, config?.baseUrl ?? null);
      const bodyFile = path.join(os.tmpdir(), `taskctl-pr-body-${issueKey}-${Date.now()}.md`);
      await fs.writeFile(bodyFile, prBody, 'utf8');

      let prUrl = null;
      let ghError = null;
      try {
        // Use --body-file to bypass all shell-quoting issues with multi-line markdown.
        // Capture both stdout + stderr so we can show real failure cause instead of swallowing it.
        const ghResult = spawnSync('gh', [
          'pr', 'create',
          '--title', prTitle,
          '--body-file', bodyFile,
          '--base', prTarget,
          '--head', branchName,
        ], { cwd: workDir, encoding: 'utf8', shell: false });

        if (ghResult.error) {
          // gh binary not on PATH or unable to spawn
          ghError = ghResult.error.code === 'ENOENT'
            ? 'gh CLI not installed or not on PATH'
            : `spawn error: ${ghResult.error.message}`;
        } else if (ghResult.status !== 0) {
          ghError = `gh pr create exit ${ghResult.status}: ${(ghResult.stderr || '').trim() || (ghResult.stdout || '').trim() || 'no output'}`;
        } else {
          const out = (ghResult.stdout || '').trim();
          if (out.startsWith('http')) {
            prUrl = out;
            console.log(`  $ gh pr create --title "${prTitle}" --body-file <tmp> --base ${prTarget} --head ${branchName}`);
          } else {
            ghError = `gh pr create returned non-URL output: ${out || '(empty)'}`;
          }
        }
      } catch (spawnErr) {
        ghError = `unexpected error invoking gh: ${spawnErr.message}`;
      }
      // Only clean up temp body file if PR creation succeeded — on failure leave it
      // so the user can rerun gh pr create with --body-file <path> manually.

      if (prUrl) {
        state.activePR = prUrl;
        console.log(`  PR created: ${prUrl}`);
        try { await fs.unlink(bodyFile); } catch { /* best-effort cleanup */ }

        // gh CLI has a known failure mode where --base is silently ignored and
        // the PR is opened against repo.default_branch (usually main) instead
        // of the requested base. Verify and auto-correct against the configured
        // PR target (WP2 Stage 2b). Opening against the wrong base can bypass a
        // preview/CI pipeline — this must never happen for workstream PRs.
        try {
          const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
          if (prNumber) {
            const baseRef = run(`gh pr view ${prNumber} --json baseRefName --jq .baseRefName 2>&1 || echo ""`).trim();
            if (baseRef && baseRef !== prTarget) {
              console.log(`  ⚠ PR base was '${baseRef}' instead of '${prTarget}'; correcting via gh pr edit.`);
              run(`gh pr edit ${prNumber} --base ${prTarget}`);
              const corrected = run(`gh pr view ${prNumber} --json baseRefName --jq .baseRefName 2>&1 || echo ""`).trim();
              if (corrected === prTarget) {
                console.log(`  ✓ PR #${prNumber} base corrected to ${prTarget}.`);
              } else {
                console.error(`  ⚠ PR #${prNumber} base is still '${corrected}' after edit. Verify manually: ${prUrl}`);
              }
            } else if (baseRef === prTarget) {
              console.log(`  ✓ PR base verified: ${prTarget}.`);
            }
          }
        } catch (verifyErr) {
          console.error(`  ⚠ Could not verify PR base: ${verifyErr.message}. Verify manually: ${prUrl}`);
        }
      } else {
        // gh failed. Common cause: PR already exists for this branch. Detect and link instead of erroring.
        const existingPrCheck = spawnSync('gh', ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], {
          cwd: workDir, encoding: 'utf8', shell: false,
        });
        const existingUrl = (existingPrCheck.stdout || '').trim();
        if (existingPrCheck.status === 0 && existingUrl.startsWith('http')) {
          state.activePR = existingUrl;
          console.log(`  Existing PR found: ${existingUrl}`);
        } else {
          console.log(`  ⚠ gh pr create failed: ${ghError ?? 'unknown error'}`);
          console.log(`    Body draft preserved at: ${bodyFile}`);
          console.log(`    Manual fallback:`);
          console.log(`      gh pr create --title "${prTitle}" --body-file "${bodyFile}" --base ${prTarget} --head ${branchName}`);
        }
      }
    }

    // Generate jira-comment.md — human-like summary of what was done
    if (state.activePR && !dryRun) {
      const prNumber = state.activePR.match(/\/pull\/(\d+)/)?.[1];
      // Preview URL from config template ({pr} substitution); omitted when unset
      // (WP2 Stage 2b — no hardcoded preview host).
      const previewUrl = (prNumber && rcfg?.previewUrlTemplate)
        ? rcfg.previewUrlTemplate.replace(/\{pr\}/g, prNumber)
        : null;

      // Collect context for AI summary
      let progressContent = '';
      let planContent = '';
      let reviewContent = '';
      try { progressContent = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf8'); } catch {}
      try { planContent = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8'); } catch {}
      try { reviewContent = await fs.readFile(path.join(taskDir, 'review.md'), 'utf8'); } catch {}

      // Generate summary via Claude in piped mode
      const summaryPrompt = [
        'Write a brief Jira comment in English with two parts:',
        '1. Summary (2-3 sentences): what was actually changed in the code and why. Write as a developer — casual, to the point, no fluff. Do NOT repeat the ticket title.',
        '2. QA section: a short "QA:" paragraph with concrete steps to verify the fix (what to open, what to click, what should/shouldn\'t happen). Keep it practical — 2-4 steps max.',
        'Output ONLY the comment text (summary + QA), nothing else. No markdown headers.',
        '',
        `Task: ${issueKey}`,
        planContent ? `\n--- Plan (goal + steps) ---\n${planContent.slice(0, 2000)}` : '',
        progressContent ? `\n--- Progress ---\n${progressContent.slice(0, 2000)}` : '',
        reviewContent ? `\n--- Review notes ---\n${reviewContent.slice(0, 1000)}` : '',
      ].filter(Boolean).join('\n');

      let summaryText = commitSummary; // fallback
      try {
        const summaryResult = execSyncTop(
          `claude -p ${JSON.stringify(summaryPrompt)} --verbose`,
          { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (summaryResult && summaryResult.length > 10) summaryText = summaryResult;
      } catch {
        // Fallback: extract from progress.md manually
        if (progressContent) {
          const doneSteps = progressContent.match(/^## Step \d+.*/gm);
          if (doneSteps?.length) {
            summaryText = doneSteps.map(s => s.replace(/^## /, '')).join('. ') + '.';
          }
        }
      }

      const commentLines = [
        summaryText,
        '',
        previewUrl ? `Preview: ${previewUrl}` : null,
        `PR: ${state.activePR}`,
        `Branch: \`${branchName}\``,
      ].filter(Boolean);

      const commentPath = path.join(taskDir, 'jira-comment.md');
      await fs.writeFile(commentPath, commentLines.join('\n'), 'utf8');
      console.log(`\n  ✓ Jira comment: ${commentPath}`);
      if (previewUrl) console.log(`  Preview: ${previewUrl}`);
    }

    // Cleanup worktree after successful push
    if (state.worktreePath && !dryRun) {
      console.log('\n  ── Worktree cleanup ──');
      removeWorktree(repoPath, slug);
      state.worktreePath = null;
    }

    // Update state
    state.branch = branchName;
    state.nextAction = 'jira-sync (when enabled)';
    await writeState(taskDir, state);

    // --jira: update Jira (assign + label with PR number)
    if (args.includes('--jira') && !dryRun) {
      console.log('\n  ── Jira update ──');
      try {
        const jira = new JiraClient(config);
        // Assignee email from config (WP2 Stage 2b); when unset, auto-assign is
        // skipped (no hardcoded assignee).
        const ASSIGNEE_EMAIL = rcfg?.tracker?.assigneeEmail ?? null;

        // Assign if not already assigned AND an assignee is configured
        const issue = await jira.fetchIssue(issueKey);
        if (!ASSIGNEE_EMAIL) {
          console.log('  No tracker.assigneeEmail configured; skipping auto-assign.');
        } else if (!issue.fields?.assignee) {
          const user = await jira.findUser(ASSIGNEE_EMAIL);
          if (user?.accountId) {
            await jira.assignIssue(issueKey, user.accountId);
            console.log(`  ✓ Assigned to ${user.displayName ?? ASSIGNEE_EMAIL}`);
          } else {
            console.warn(`  ⚠ User not found: ${ASSIGNEE_EMAIL}`);
          }
        } else {
          console.log(`  Assignee already set: ${issue.fields.assignee.displayName}`);
        }

        // Add PR label (e.g. "PR-106")
        if (state.activePR) {
          const prNumber = state.activePR.match(/\/pull\/(\d+)/)?.[1];
          if (prNumber) {
            const prLabel = `PR-${prNumber}`;
            const existingLabels = issue.fields?.labels ?? [];
            if (!existingLabels.includes(prLabel)) {
              await jira.addLabels(issueKey, [prLabel]);
              console.log(`  ✓ Label added: ${prLabel}`);
            } else {
              console.log(`  Label already exists: ${prLabel}`);
            }
          }
        } else {
          console.log('  ⚠ No PR URL — skipping label');
        }
      } catch (err) {
        console.error(`  ⚠ Jira update failed: ${err.message}`);
      }
    }

    console.log(`\n✓ ${issueKey} published on branch ${branchName}`);
  } catch (err) {
    console.error(`\nPublish failed: ${err.message}`);
    throw new Error('TASKCTL_EXIT');
  }
}

async function cmdJiraSync(config, issueKey) {
  if (!issueKey) { console.error('Usage: taskctl jira-sync CP-XXX'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  // Phase 0: Jira write is disabled
  console.log(`\n--- Jira Sync: ${issueKey} (DRY RUN — write disabled in Phase 0) ---`);
  console.log(`  Stage: ${state.stage}`);
  console.log(`  Branch: ${state.branch ?? '—'}`);
  console.log(`  PR: ${state.activePR ?? '—'}`);

  // Show what WOULD be synced
  const comment = [
    `[Orchestration Update] ${issueKey}`,
    `Stage: ${state.stage}`,
    state.branch ? `Branch: ${state.branch}` : null,
    state.activePR ? `PR: ${state.activePR}` : null,
    `Plan version: v${state.planVersion}`,
    `Context version: v${state.contextVersion}`,
  ].filter(Boolean).join('\n');

  console.log(`\n  Would add Jira comment:`);
  console.log(comment.split('\n').map(l => `    ${l}`).join('\n'));
  console.log(`\n  To enable Jira write: remove Phase 0 restriction and uncomment write methods in jira-client.mjs`);
  console.log(`\n✓ ${issueKey} jira-sync (dry run)`);
}

// rcfg is threaded in so the SAME context-options bundle (project sections +
// opt-in GRACE) the jira tracker builds is used on refresh — refresh and
// first-sync produce identical context.md for the same fixture (WP2 Stage 2b
// atomic buildContextMd reshape).
async function cmdRefresh(config, issueKey, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl refresh CP-XXX'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  console.log(`Refreshing ${issueKey}...`);

  // Re-sync from Jira (get latest comments, status, links)
  const jira = new JiraClient(config);
  const issue = await jira.fetchIssue(issueKey);
  if (!issue) {
    console.error(`Issue ${issueKey} not found in Jira.`);
    throw new Error('TASKCTL_EXIT');
  }

  const { comments, links, linkedDetails, linkedComments, downloadedAttachments } =
    await fetchFullJiraContext(jira, issueKey, issue, taskDir);

  // Rebuild context.md with fresh data, using the SAME (issue, ctx, ctxOpts)
  // mapping the jira tracker uses on first-sync (downloadedAttachments fill the
  // `attachments` slot; ctxOpts carries project sections + opt-in GRACE).
  const ctx = {
    comments,
    links,
    linkedDetails,
    attachments: downloadedAttachments,
    linkedComments,
  };
  const contextMd = buildContextMd(issue, ctx, buildCtxOpts(rcfg));
  await fs.writeFile(path.join(taskDir, 'context.md'), contextMd, 'utf8');

  // Update state (preserve stage and plan, update Jira data)
  state.contextVersion = (state.contextVersion ?? 0) + 1;
  state.lastSyncedFromJira = new Date().toISOString();
  state.dependsOn = extractDependencies(links, 'blockedBy');
  state.blocks = extractDependencies(links, 'blocks');
  await writeState(taskDir, state);

  console.log(`✓ ${issueKey} refreshed`);
  console.log(`  context.md v${state.contextVersion} (updated from Jira)`);
  console.log(`  stage preserved: ${state.stage}`);
  console.log(`  depends on: ${state.dependsOn.length ? state.dependsOn.join(', ') : 'none'}`);
}

async function cmdResume(issueKey) {
  if (!issueKey) { console.error('Usage: taskctl resume CP-XXX'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  // Gather info for resume.md
  const lines = [];
  lines.push(`# Resume: ${issueKey}`);
  lines.push('');
  lines.push(`## Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('## Task Summary');
  lines.push(`- **Issue:** ${issueKey}`);
  lines.push(`- **Stage:** ${state.stage}`);
  lines.push(`- **Plan Version:** v${state.planVersion}`);
  lines.push(`- **Context Version:** v${state.contextVersion}`);
  lines.push(`- **Branch:** ${state.branch ?? '—'}`);
  lines.push(`- **Active PR:** ${state.activePR ?? '—'}`);
  lines.push(`- **Execution:** ${state.execution?.status ?? 'idle'} (engine: ${state.execution?.engine ?? '—'})`);
  lines.push(`- **Last Jira sync:** ${state.lastSyncedFromJira ?? '—'}`);
  lines.push('');

  // Check for progress.md
  lines.push('## What has been done');
  try {
    const progress = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf8');
    const completedMatch = progress.match(/## Completed Steps[\s\S]*?(?=\n## |$)/);
    lines.push(completedMatch ? completedMatch[0].replace('## Completed Steps', '').trim() : '(see progress.md)');
  } catch {
    lines.push('(no progress.md found)');
  }
  lines.push('');

  // Check for open questions / blockers
  lines.push('## Open questions');
  if (state.openQuestions?.length) {
    for (const q of state.openQuestions) lines.push(`- ${q}`);
  } else {
    lines.push('- None recorded');
  }
  lines.push('');

  // Next action
  lines.push('## Next action');
  lines.push(state.nextAction ?? '(not set)');
  lines.push('');

  // Stage-specific guidance
  lines.push('## Recommended command');
  const runningCmd = state.execution?.status === 'needs_fix'
    ? `taskctl fix ${issueKey} --engine claude`
    : `taskctl run ${issueKey} --finalize  (if execution is done)`;
  const stageCommands = {
    analysis: `taskctl plan ${issueKey} --engine claude`,
    planned: `taskctl plan-review ${issueKey} --engine codex`,
    plan_reviewed: `taskctl run ${issueKey} --engine claude`,
    running: runningCmd,
    review: `taskctl review ${issueKey} --engine codex`,
    done: `taskctl publish ${issueKey} --repo-path <path>`,
  };
  lines.push(stageCommands[state.stage] ?? `taskctl status ${issueKey}`);

  const resumeMd = lines.join('\n');
  await fs.writeFile(path.join(taskDir, 'resume.md'), resumeMd, 'utf8');

  console.log(resumeMd);
  console.log(`\n(saved to ai/tasks/${issueKey}/resume.md)`);
}

async function cmdHandoff(issueKey, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl handoff CP-XXX'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  const lines = [];
  lines.push(`# Handoff: ${issueKey}`);
  lines.push('');
  lines.push(`## Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`## Stage: ${state.stage}`);
  lines.push(`## Branch: ${state.branch ?? '—'}`);
  lines.push(`## Execution: ${state.execution?.status ?? 'idle'}`);
  lines.push('');

  // Include progress if exists
  lines.push('## What was done');
  try {
    const progress = await fs.readFile(path.join(taskDir, 'progress.md'), 'utf8');
    lines.push(progress.substring(0, 2000));
  } catch {
    lines.push('(no progress.md)');
  }
  lines.push('');

  // Include plan summary if exists
  lines.push('## Plan summary');
  try {
    const plan = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8');
    const goalMatch = plan.match(/## Goal[\s\S]*?(?=\n## )/);
    lines.push(goalMatch ? goalMatch[0].trim() : '(see plan.md)');
  } catch {
    lines.push('(no plan.md)');
  }
  lines.push('');

  lines.push('## Open questions');
  if (state.openQuestions?.length) {
    for (const q of state.openQuestions) lines.push(`- ${q}`);
  } else {
    lines.push('- None');
  }
  lines.push('');

  // GRACE Gates — populated by `taskctl run --finalize` or
  // `taskctl grace-gate`. Rendered ONLY when GRACE is explicitly enabled;
  // a legacy/stale `state.graceGate` from a prior GRACE run is ignored when
  // GRACE is disabled (C2 reader gating).
  if (rcfg?.grace?.enabled && state.graceGate) {
    lines.push(grace.formatGraceGateMarkdown(state.graceGate));
  }

  lines.push('## Next action');
  lines.push(state.nextAction ?? '(not set)');

  const handoffMd = lines.join('\n');
  await fs.writeFile(path.join(taskDir, 'handoff.md'), handoffMd, 'utf8');

  console.log(`✓ ${issueKey} handoff saved to ai/tasks/${issueKey}/handoff.md`);
  console.log(`  Stage: ${state.stage}`);
  console.log(`  Next action: ${state.nextAction ?? '—'}`);
}

/**
 * taskctl grace-gate [CP-XXX] [--repo-path <path>]
 *
 * Manual invocation of the GRACE gate. Prints the 3-check report and
 * exits 0 on pass (or skipped verdicts) or 1 on FAIL. When CP-XXX is
 * provided, persists the result to that task's state.graceGate and
 * re-renders handoff.md; when omitted, only prints to stdout.
 *
 * Useful for:
 *   - Verifying gate status mid-task
 *   - Debugging lint failures
 *   - Pre-flight before `taskctl run --finalize`
 */
// Thin adapter: resolves repoPath/state from cli-local infra, delegates the
// gate itself to grace.runGraceGate / grace.printGraceGateReport. (Reachable
// only when grace.enabled — main() rejects grace-gate otherwise.)
async function cmdGraceGate(issueKey, args, rcfg = null) {
  const repoPath = parseRepoPath(args) ?? rcfg?.grace?.repoRoot;
  const pilotBranch = rcfg?.grace?.pilotBranch;

  console.log(`Running GRACE gate against: ${repoPath}`);
  const gate = await grace.runGraceGate(repoPath, pilotBranch, detectRepoBranch);
  grace.printGraceGateReport(gate, { stream: 'stdout' });

  if (issueKey) {
    try {
      const taskDir = path.join(TASKS_DIR, issueKey);
      const state = await readState(taskDir, issueKey);
      state.graceGate = gate;
      await writeState(taskDir, state);
      // Re-render handoff.md if one already exists so the gate block
      // is visible without requiring a separate `taskctl handoff` run.
      const handoffPath = path.join(taskDir, 'handoff.md');
      try {
        await fs.access(handoffPath);
        await cmdHandoff(issueKey, rcfg);
      } catch { /* no existing handoff — skip re-render */ }
      console.log(`  → persisted to ai/tasks/${issueKey}/state.json (graceGate)`);
    } catch (err) {
      if (err.message !== 'TASKCTL_EXIT') {
        console.warn(`  ⚠ Could not persist gate result for ${issueKey}: ${err.message}`);
      }
    }
  }

  if (gate.verdict === 'fail') {
    throw new Error('TASKCTL_EXIT');
  }
}

// ── sync-grace (T5a: detect + report; T5b: auto-resolve) ────────────────

/**
 * Absolute path to the orchestration-level state file that tracks the
 * most recent `taskctl sync-grace` invocation. We chose a top-level file
 * under `ai/state/` instead of burying it inside a per-task `state.json`
 * because sync-grace is a branch-level operation, not a CP-scoped one —
 * no single task "owns" the rebase of experiment/grace-pilot.
 */
// Resolved as FUNCTIONS (not load-time consts) because ORCHESTRATION_ROOT is now
// bound to the cwd-discovered workspace in main() AFTER this module loads (New-C1).
// sync-grace operates on the orchestration workspace's own state, so these anchor
// at the discovered root at USE time. (GRACE is opt-in/off by default; in the
// planted-config workspaces the tests run from, the discovered root === install.)
const syncGraceStatePath = () => path.join(ORCHESTRATION_ROOT, 'ai', 'state', 'sync-grace-state.json');

/**
 * Absolute path to the markup-agent dispatch prompt written by sync-grace
 * when conflicts need human/agent resolution. Cli-local (under
 * ORCHESTRATION_ROOT); injected into grace.writeMarkupAgentPrompt by the
 * cmdSyncGrace adapter so grace.mjs never references ORCHESTRATION_ROOT.
 */
const markupAgentPromptPath = () => path.join(ORCHESTRATION_ROOT, 'ai', 'state', 'markup-agent-prompt.md');

/**
 * Build the dependency bundle threaded through the moved grace.mjs sync
 * helpers (C3 branch threading + acyclic deps). Carries the cli-local
 * `runGit`, the governed-path helpers from context-builder, the injected
 * branch detector, the state-persistence sink, and the configured
 * {pilotBranch, upstreamBranch}. No branch literal remains hardcoded in the
 * sync path.
 */
function buildSyncGraceDeps(rcfg) {
  return {
    runGit,
    loadGovernedModules,
    isGovernedPath,
    detectRepoBranch,
    pilotBranch: rcfg.grace.pilotBranch,
    upstreamBranch: rcfg.grace.upstreamBranch,
    writeSyncGraceState,
    markupAgentPromptPath: markupAgentPromptPath(),
    stateRelPath: path.relative(ORCHESTRATION_ROOT, syncGraceStatePath()).replace(/\\/g, '/'),
  };
}

/**
 * Read the existing orchestration sync-grace state, returning an empty
 * wrapper if the file does not yet exist. Never throws on missing file.
 *
 * @returns {Promise<{ syncGrace?: object }>}
 */
async function readSyncGraceState() {
  try {
    const raw = await fs.readFile(syncGraceStatePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Persist the sync-grace state block. Creates the parent directory on
 * first write. Merges the incoming `syncGrace` payload into whatever
 * top-level state already exists (defensive against future sibling
 * fields).
 *
 * @param {object} syncGrace  The syncGrace payload to write.
 */
async function writeSyncGraceState(syncGrace) {
  const statePath = syncGraceStatePath();
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });
  const existing = await readSyncGraceState();
  existing.syncGrace = syncGrace;
  await fs.writeFile(
    statePath,
    JSON.stringify(existing, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Shell out to git and return { status, stdout, stderr } without
 * throwing. `shell: true` keeps behavior consistent with the rest of
 * this module on Windows.
 */
function runGit(args, cwd) {
  const proc = spawnSync('git', args, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: proc.status,
    stdout: (proc.stdout ?? '').toString(),
    stderr: (proc.stderr ?? '').toString(),
    error: proc.error,
  };
}

/**
 * `taskctl sync-grace` — THIN ADAPTER. Rebases the configured pilot branch
 * (`rcfg.grace.pilotBranch`) onto `origin/<rcfg.grace.upstreamBranch>`,
 * detects + classifies conflicts, and delegates all pure git/string logic to
 * grace.mjs via an injected `deps` bundle (C3 branch threading). Reachable
 * only when grace.enabled — main() rejects sync-grace otherwise.
 *
 * Scope:
 *   - Detect divergence, attempt rebase (or just report on --dry-run).
 *   - On conflict: classify governed vs non-governed, print report,
 *     persist state, exit 1 for the user.
 *   - On clean rebase: run the gate, persist state, exit 0/1 on gate.
 *   - Support --abort / --continue / --auto-resolve / --force-agent-prompt.
 *
 * Exit codes:
 *   0 — clean (no divergence, or rebase + gate passed)
 *   1 — conflicts detected, or gate failed (user action required)
 *   2 — environment error (missing repo, wrong branch, no origin)
 */
async function cmdSyncGrace(args, rcfg = null) {
  const dryRun = args.includes('--dry-run');
  const doAbort = args.includes('--abort');
  const doContinue = args.includes('--continue');
  const autoResolve = args.includes('--auto-resolve');
  const forceAgent = args.includes('--force-agent-prompt');

  // --force-agent-prompt implies we intend to engage the Layer 2 flow
  // even if --auto-resolve isn't passed. They can co-exist, but
  // force-agent wins (skips Layer 1 entirely).

  // Thin adapter: resolve repoPath + branches from rcfg, build the deps bundle
  // for the moved grace.mjs sync helpers (C3: pilotBranch + upstreamBranch
  // threaded everywhere — no hardcoded origin/dev or experiment/grace-pilot).
  const repoPath = parseRepoPath(args) ?? rcfg.grace.repoRoot;
  const { pilotBranch, upstreamBranch } = rcfg.grace;
  const upstream = `origin/${upstreamBranch}`;
  const deps = buildSyncGraceDeps(rcfg);

  // ── Env sanity: repo exists? ──────────────────────────────────────
  if (!repoPath || !fsSync.existsSync(repoPath)) {
    console.error(`sync-grace: repo path not found: ${repoPath}`);
    console.error('  Pass --repo-path <path> or set grace.repoRoot / repoPath.');
    process.exit(2);
  }
  const gitDir = path.join(repoPath, '.git');
  if (!fsSync.existsSync(gitDir)) {
    console.error(`sync-grace: not a git repository: ${repoPath}`);
    process.exit(2);
  }

  // ── Env sanity: on the pilot branch? ──────────────────────────────
  // --abort and --continue operate on an in-progress rebase, which
  // means git's HEAD is detached / on a transient rebase state. We
  // relax the branch-check for --abort (you might need to abort from
  // that detached state) but still require the pilot branch name to
  // exist somewhere. For the default + --dry-run + --continue paths
  // we enforce HEAD == pilot.
  const currentBranch = detectRepoBranch(repoPath);
  const rebaseActive = grace.isRebaseInProgress(repoPath);

  if (!doAbort) {
    // Allow --continue when a rebase is mid-flight (HEAD will show
    // something like `HEAD` / rebase head-name); otherwise demand pilot.
    const allowed =
      currentBranch === pilotBranch ||
      (doContinue && rebaseActive);
    if (!allowed) {
      console.error(
        `sync-grace: current branch is "${currentBranch ?? 'unknown'}", expected "${pilotBranch}".`,
      );
      console.error(`  Checkout ${pilotBranch} in ${repoPath} and retry.`);
      process.exit(2);
    }
  }

  // ── --abort path ──────────────────────────────────────────────────
  if (doAbort) {
    if (!rebaseActive) {
      console.log('sync-grace --abort: no rebase in progress, nothing to abort.');
      // Still clear any stale pendingConflicts from state for hygiene.
      const prior = await readSyncGraceState();
      if (prior.syncGrace?.pendingConflicts?.length) {
        await writeSyncGraceState({
          ...prior.syncGrace,
          lastRun: new Date().toISOString(),
          verdict: 'aborted',
          pendingConflicts: [],
        });
        console.log('  Cleared stale pendingConflicts from state.');
      }
      process.exit(0);
    }
    const abortRes = runGit(['rebase', '--abort'], repoPath);
    if (abortRes.status !== 0) {
      console.error('sync-grace --abort: git rebase --abort failed.');
      if (abortRes.stderr) console.error(abortRes.stderr.trim());
      process.exit(1);
    }
    const prior = await readSyncGraceState();
    await writeSyncGraceState({
      ...(prior.syncGrace ?? {}),
      lastRun: new Date().toISOString(),
      verdict: 'aborted',
      pendingConflicts: [],
    });
    console.log('sync-grace: rebase aborted. Pilot is back to pre-rebase state.');
    process.exit(0);
  }

  // ── --continue path ───────────────────────────────────────────────
  if (doContinue) {
    if (!rebaseActive) {
      console.error('sync-grace --continue: no rebase in progress.');
      console.error('  Start one first: taskctl sync-grace');
      process.exit(2);
    }
    console.log('Continuing rebase...');
    const contRes = runGit(['rebase', '--continue'], repoPath);
    // `git rebase --continue` exits 0 on success. On further conflict it
    // exits non-zero and leaves unmerged files behind.
    if (contRes.status === 0) {
      const branchAfter = detectRepoBranch(repoPath);
      const headAfter = runGit(['rev-parse', 'HEAD'], repoPath).stdout.trim();
      console.log(`Rebase completed. HEAD = ${headAfter.slice(0, 7)} on ${branchAfter}.`);

      // Pre-rebase fromCommit isn't available at this point without
      // state; fall back to what's saved or 'unknown'.
      const prior = await readSyncGraceState();
      const fromCommit = prior.syncGrace?.fromCommit ?? null;
      const divergence = prior.syncGrace?.divergenceAtSyncStart ?? null;
      const exitCode = await grace.finalizeAfterCleanRebase({
        repoPath,
        fromCommit,
        toCommit: headAfter,
        divergence,
        verdict: 'clean',
        deps,
      });
      process.exit(exitCode);
    }

    // More conflicts hit during --continue → repeat detection flow.
    const unmerged = grace.detectUnmergedPaths(repoPath, deps);
    if (unmerged.length === 0) {
      // Rebase reported failure but no unmerged files — probably an
      // editor/signoff situation. Surface git stderr and bail.
      console.error('sync-grace --continue: git rebase --continue failed without unmerged paths.');
      if (contRes.stderr) console.error(contRes.stderr.trim());
      process.exit(1);
    }

    // If auto-resolve or force-agent-prompt was requested, funnel through
    // the Layer 5 loop — it will either finish the rebase, dispatch an
    // agent, or stop at max iterations. Otherwise preserve T5a behavior.
    const prior = await readSyncGraceState();
    const priorFromCommit = prior.syncGrace?.fromCommit ?? null;
    const priorDivergence = prior.syncGrace?.divergenceAtSyncStart ?? null;

    if (autoResolve || forceAgent) {
      const exitCode = await grace.runAutoResolveLoop({
        repoPath,
        initialUnmerged: unmerged,
        fromCommit: priorFromCommit,
        divergence: priorDivergence,
        autoResolve,
        forceAgent,
        deps,
      });
      process.exit(exitCode);
    }

    const classified = grace.classifyConflictingPaths(unmerged, repoPath, deps);
    grace.printConflictReport(classified);
    await writeSyncGraceState({
      ...(prior.syncGrace ?? {}),
      lastRun: new Date().toISOString(),
      verdict: 'conflicts',
      pendingConflicts: [
        ...classified.governed.map(({ path: p, moduleId }) => ({ path: p, moduleId })),
        ...classified.nongoverned.map((p) => ({ path: p, moduleId: null })),
      ],
    });
    process.exit(1);
  }

  // ── Main path (no abort / continue) ───────────────────────────────

  // Refuse if a rebase is already mid-flight — user must --continue or --abort.
  if (rebaseActive) {
    console.error('sync-grace: a rebase is already in progress on this repo.');
    console.error('  Resume with:  taskctl sync-grace --continue');
    console.error('  Or abort:     taskctl sync-grace --abort');
    process.exit(2);
  }

  console.log(`sync-grace: ${repoPath}`);
  console.log(`  Branch:   ${currentBranch}`);
  console.log(`  Dry run:  ${dryRun ? 'yes' : 'no'}`);

  // Capture pre-rebase HEAD for state persistence.
  const fromCommit = runGit(['rev-parse', 'HEAD'], repoPath).stdout.trim() || null;

  // ── Fetch origin upstream (non-fatal on network failure) ──────────
  console.log(`Fetching origin ${upstreamBranch}...`);
  const fetchRes = runGit(['fetch', 'origin', upstreamBranch], repoPath);
  if (fetchRes.status !== 0) {
    const msg = (fetchRes.stderr || fetchRes.stdout).trim();
    // Distinguish "no origin" (hard env error) from network blips
    // (soft warn + proceed with whatever origin/<upstream> we already have).
    if (/does not appear to be a git repository|no such remote|'origin'/i.test(msg)) {
      console.error(`sync-grace: git fetch failed — no usable origin remote.`);
      if (msg) console.error(`  ${msg}`);
      process.exit(2);
    }
    console.warn(`  ⚠ git fetch origin ${upstreamBranch} failed (network?); continuing with cached refs.`);
    if (msg) console.warn(`    ${msg.split('\n').slice(0, 3).join(' | ')}`);
  }

  // ── Compute divergence ────────────────────────────────────────────
  const devAheadRes = runGit(
    ['rev-list', '--count', `${pilotBranch}..${upstream}`],
    repoPath,
  );
  const pilotAheadRes = runGit(
    ['rev-list', '--count', `${upstream}..${pilotBranch}`],
    repoPath,
  );
  if (devAheadRes.status !== 0 || pilotAheadRes.status !== 0) {
    console.error(`sync-grace: could not compute divergence vs ${upstream}.`);
    const msg = (devAheadRes.stderr || pilotAheadRes.stderr).trim();
    if (msg) console.error(`  ${msg}`);
    process.exit(2);
  }
  const devAhead = parseInt(devAheadRes.stdout.trim(), 10) || 0;
  const pilotAhead = parseInt(pilotAheadRes.stdout.trim(), 10) || 0;
  const divergence = { devAheadOfPilot: devAhead, pilotAheadOfDev: pilotAhead };

  console.log(`  Divergence: ${upstream} is ${devAhead} ahead of pilot; pilot is ${pilotAhead} ahead of ${upstream}.`);

  // ── Up-to-date fast path ──────────────────────────────────────────
  if (devAhead === 0) {
    console.log(`Pilot is up to date with ${upstream} — nothing to rebase.`);
    const exitCode = await grace.finalizeAfterCleanRebase({
      repoPath,
      fromCommit,
      toCommit: fromCommit,
      divergence,
      verdict: 'up-to-date',
      deps,
    });
    process.exit(exitCode);
  }

  // ── List the incoming commits for context ────────────────────────
  const incoming = grace.listIncomingDevCommits(repoPath, deps);
  if (incoming.length > 0) {
    console.log('');
    console.log(`New commits on ${upstream} (${incoming.length}):`);
    for (const c of incoming.slice(0, 20)) {
      console.log(`  ${c.sha}  ${c.subject}`);
    }
    if (incoming.length > 20) {
      console.log(`  ... and ${incoming.length - 20} more`);
    }
    console.log('');
  }

  // ── Dry run: predict conflicts and exit ──────────────────────────
  if (dryRun) {
    console.log('Predicting likely conflicts (git merge-tree)...');
    const predicted = grace.predictConflicts(repoPath, deps);
    if (predicted.length === 0) {
      console.log('  No conflicts predicted. A real rebase would likely apply cleanly.');
    } else {
      const classified = grace.classifyConflictingPaths(predicted, repoPath, deps);
      console.log('');
      console.log(`  Predicted ${predicted.length} conflicting file(s):`);
      console.log(`    Governed: ${classified.governed.length} | Non-governed: ${classified.nongoverned.length}`);
      for (const { path: p, moduleId } of classified.governed) {
        console.log(`    [${moduleId}] ${p}`);
      }
      for (const p of classified.nongoverned) {
        console.log(`    (standard) ${p}`);
      }
      console.log('');
      console.log('  Re-run without --dry-run to attempt the rebase.');
    }
    // Dry run intentionally does NOT mutate state (it's a preview).
    process.exit(0);
  }

  // ── Attempt rebase ────────────────────────────────────────────────
  console.log(`Rebasing ${pilotBranch} onto ${upstream}...`);
  const rebaseRes = runGit(['rebase', upstream], repoPath);

  if (rebaseRes.status === 0) {
    // Clean rebase.
    const headAfter = runGit(['rev-parse', 'HEAD'], repoPath).stdout.trim();
    console.log(`Rebase clean. HEAD = ${headAfter.slice(0, 7)}.`);
    const exitCode = await grace.finalizeAfterCleanRebase({
      repoPath,
      fromCommit,
      toCommit: headAfter,
      divergence,
      verdict: 'clean',
      deps,
    });
    process.exit(exitCode);
  }

  // Non-zero exit → either conflicts or a real error. Distinguish.
  const unmerged = grace.detectUnmergedPaths(repoPath, deps);
  if (unmerged.length === 0) {
    console.error('sync-grace: git rebase failed without conflicts — unexpected.');
    const msg = (rebaseRes.stderr || rebaseRes.stdout).trim();
    if (msg) console.error(msg.split('\n').slice(0, 20).join('\n'));
    // Leave state recording the attempt for post-mortem.
    await writeSyncGraceState({
      lastRun: new Date().toISOString(),
      fromCommit,
      toCommit: null,
      verdict: 'gate-failed',
      divergenceAtSyncStart: divergence,
      pendingConflicts: [],
      graceGate: null,
    });
    process.exit(1);
  }

  // Real conflicts.
  // If auto-resolve or force-agent-prompt flags were passed, feed into
  // the Layer 5 loop. Otherwise preserve T5a behavior: classify + report
  // + persist + exit 1 for manual resolution.
  if (autoResolve || forceAgent) {
    const exitCode = await grace.runAutoResolveLoop({
      repoPath,
      initialUnmerged: unmerged,
      fromCommit,
      divergence,
      autoResolve,
      forceAgent,
      deps,
    });
    process.exit(exitCode);
  }

  const classified = grace.classifyConflictingPaths(unmerged, repoPath, deps);
  grace.printConflictReport(classified);
  await writeSyncGraceState({
    lastRun: new Date().toISOString(),
    fromCommit,
    toCommit: null,
    verdict: 'conflicts',
    divergenceAtSyncStart: divergence,
    pendingConflicts: [
      ...classified.governed.map(({ path: p, moduleId }) => ({ path: p, moduleId })),
      ...classified.nongoverned.map((p) => ({ path: p, moduleId: null })),
    ],
    graceGate: null,
  });
  process.exit(1);
}

async function cmdFix(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl fix CP-XXX [--engine claude|codex]'); process.exit(1); }

  const finalize = args.includes('--finalize');
  const engine = parseEngine(args, rcfg);
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);
  const otherEngine = otherRoleEngine(engine, rcfg);
  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);
  const workDir = resolveWorkDir(state, repoPath);

  if (finalize) {
    state.execution.status = 'completed';
    state.execution.lastRunAt = new Date().toISOString();
    state.stage = 'review';
    state.nextAction = 'final review (re-review after fix)';
    await writeState(taskDir, state);
    console.log(`✓ ${issueKey} fix completed, ready for re-review`);
    console.log(`  Next: taskctl review ${issueKey} --engine ${otherEngine}`);
    return;
  }

  // Validate: must have review.md with findings
  const reviewContent = await readReviewFile(taskDir);
  if (!reviewContent) {
    console.error(`No review.md found. Run review first: taskctl review ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }

  // Validate: must be in running/needs_fix state
  if (state.stage !== 'running') {
    console.error(`⚠ Stage is "${state.stage}". Expected "running" for fix.`);
    throw new Error('TASKCTL_EXIT');
  }

  const prompt = [
    `# Fix: ${issueKey}`,
    '',
    promptPreamble(workDir, taskDir, rcfg),
    ...L.fix({ O, issueKey }),
  ].join('\n');

  await writePrompt(path.join(taskDir, '.prompt-fix.md'), prompt);
  state.execution.status = 'fixing';
  state.nextAction = `fix issues in ${engine} based on review`;
  await writeState(taskDir, state);

  const c = L.fixConsole({ O, issueKey, engine, launch: launchCmd(engine, { repoPath }, rcfg), branch: state.branch, otherEngine });
  console.log(c.preparedLine);
  if (c.branchLine) console.log(c.branchLine);
  console.log(c.runHeader);
  console.log(c.launchLine);
  console.log(c.readLine);
  console.log(c.afterHeader);
  console.log(c.finalizeLine);
  console.log(c.reReviewLine);
}

async function cmdRevise(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl revise CP-XXX [--engine claude|codex]'); process.exit(1); }

  const finalize = args.includes('--finalize');
  const engine = parseEngine(args, rcfg);
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);
  const otherEngine = otherRoleEngine(engine, rcfg);
  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  if (finalize) {
    // Same as plan --finalize
    try {
      await fs.access(path.join(taskDir, 'plan.md'));
      const planContent = await fs.readFile(path.join(taskDir, 'plan.md'), 'utf8');
      const verdict = parseVerdict(planContent);
      state.stage = 'planned';
      state.planVersion = (state.planVersion ?? 0) + 1;
      state.nextAction = 'plan review';
      await writeState(taskDir, state);
      console.log(`✓ ${issueKey} revised plan finalized (v${state.planVersion}, verdict: ${verdict ?? 'not set'})`);
    } catch {
      console.error(`No plan.md found in ${taskDir}.`);
    }
    return;
  }

  // Validate: must have review.md with feedback
  const reviewContent = await readReviewFile(taskDir);
  if (!reviewContent) {
    console.error(`No review.md found. Run plan-review first: taskctl plan-review ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }

  // Validate: must have plan.md to revise
  try {
    await fs.access(path.join(taskDir, 'plan.md'));
  } catch {
    console.error(`No plan.md found. Run planning first: taskctl plan ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }

  const prompt = [
    `# Revise Plan: ${issueKey}`,
    '',
    promptPreamble(repoPath, taskDir, rcfg),
    ...L.revise({ O, issueKey }),
  ].join('\n');

  await writePrompt(path.join(taskDir, '.prompt-revise.md'), prompt);
  state.nextAction = `revise plan in ${engine} based on review feedback`;
  await writeState(taskDir, state);

  const c = L.reviseConsole({ O, issueKey, engine, launch: launchCmd(engine, { repoPath }, rcfg), otherEngine });
  console.log(c.preparedLine);
  console.log(c.runHeader);
  console.log(c.launchLine);
  console.log(c.readLine);
  console.log(c.afterHeader);
  console.log(c.finalizeLine);
  console.log(c.reReviewLine);
}

async function cmdReplan(issueKey, args, rcfg = null) {
  if (!issueKey) { console.error('Usage: taskctl replan CP-XXX [--engine claude|codex]'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);
  const engine = parseEngine(args, rcfg);
  const repoPath = resolveRepoPath(args, rcfg);
  const L = promptPack(rcfg);
  const planVersionForPrompt = state.planVersion;

  // Archive current plan
  const planPath = path.join(taskDir, 'plan.md');
  try {
    const currentPlan = await fs.readFile(planPath, 'utf8');
    const runsDir = path.join(taskDir, 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const timestamp = new Date().toISOString().split('T')[0];
    await fs.writeFile(
      path.join(runsDir, `${timestamp}-plan-v${state.planVersion}.md`),
      currentPlan,
      'utf8'
    );
    console.log(`  Archived plan v${state.planVersion} to runs/`);
  } catch {
    // No existing plan — that's fine
  }

  // Reset to analysis stage and generate new planning prompt
  state.stage = 'analysis';
  state.nextAction = `replan in ${engine}`;
  await writeState(taskDir, state);

  // Generate prompt with replan context
  const prompt = [
    `# Replan: ${issueKey}`,
    '',
    promptPreamble(repoPath, taskDir, rcfg),
    ...L.replan({ O, issueKey, planVersion: planVersionForPrompt }),
  ].join('\n');

  await writePrompt(path.join(taskDir, '.prompt-plan.md'), prompt);

  const c = L.replanConsole({ O, issueKey, engine, launch: launchCmd(engine, { repoPath }, rcfg) });
  console.log(c.returnedLine);
  console.log(c.promptLine);
  console.log(c.runHeader);
  console.log(c.launchLine);
  console.log(c.readLine);
  console.log(c.afterHeader);
  console.log(c.finalizeLine);
}

async function cmdCreateFollowup(issueKey, args) {
  if (!issueKey) { console.error('Usage: taskctl create-followup CP-YYY --from CP-XXX'); process.exit(1); }

  const fromIdx = args.indexOf('--from');
  const fromKey = fromIdx !== -1 ? args[fromIdx + 1] : null;

  if (!fromKey) {
    console.error('Usage: taskctl create-followup CP-YYY --from CP-XXX');
    throw new Error('TASKCTL_EXIT');
  }

  const fromDir = path.join(TASKS_DIR, fromKey);
  const fromState = await readState(fromDir, fromKey);

  const newDir = path.join(TASKS_DIR, issueKey);
  await fs.mkdir(newDir, { recursive: true });
  await fs.mkdir(path.join(newDir, 'runs'), { recursive: true });

  // Create new state with lineage
  const newState = {
    issueKey,
    stage: 'analysis',
    contextVersion: 0,
    planVersion: 0,
    branch: null,
    activePR: null,
    relatedPRs: [],
    merged: false,
    dependsOn: [],
    blocks: [],
    followups: [],
    derivedFrom: [fromKey],
    lastSyncedFromJira: null,
    lastSyncedFromRepo: null,
    openQuestions: [],
    nextAction: 'sync from Jira, then build plan',
    execution: { engine: null, status: 'idle', lastRunAt: null },
  };

  await writeState(newDir, newState);

  // Link back from parent
  if (!fromState.followups) fromState.followups = [];
  if (!fromState.followups.includes(issueKey)) {
    fromState.followups.push(issueKey);
    await writeState(fromDir, fromState);
  }

  // Copy relevant context from parent
  const contextLines = [
    `# ${issueKey}: Follow-up from ${fromKey}`,
    '',
    '## Lineage',
    `- Derived from: ${fromKey}`,
    `- Parent stage: ${fromState.stage}`,
    `- Parent branch: ${fromState.branch ?? '—'}`,
    `- Parent PR: ${fromState.activePR ?? '—'}`,
    '',
    '## Context from parent',
  ];

  try {
    const parentReview = await fs.readFile(path.join(fromDir, 'review.md'), 'utf8');
    contextLines.push('### Review findings');
    contextLines.push(parentReview.substring(0, 2000));
  } catch {
    contextLines.push('(no review from parent)');
  }

  contextLines.push('');
  contextLines.push('## Next steps');
  contextLines.push('Run `taskctl sync ' + issueKey + '` to pull Jira data, then plan.');

  await fs.writeFile(path.join(newDir, 'context.md'), contextLines.join('\n'), 'utf8');

  console.log(`✓ ${issueKey} created as follow-up from ${fromKey}`);
  console.log(`  Derived from: ${fromKey}`);
  console.log(`  Next: taskctl sync ${issueKey}`);
}

async function cmdDeps(issueKey) {
  if (!issueKey) { console.error('Usage: taskctl deps CP-XXX'); process.exit(1); }

  const taskDir = path.join(TASKS_DIR, issueKey);
  const state = await readState(taskDir, issueKey);

  console.log(`\n  ${issueKey} (${state.stage})`);

  // Show what this task depends on
  if (state.dependsOn?.length) {
    for (const dep of state.dependsOn) {
      let depStage = '?';
      try {
        const depState = JSON.parse(await fs.readFile(path.join(TASKS_DIR, dep, 'state.json'), 'utf8'));
        depStage = depState.stage;
      } catch { /* not synced locally */ }
      const warn = !['done', 'review'].includes(depStage) ? ' ⚠️' : '';
      console.log(`    ← blocked by: ${dep} (${depStage})${warn}`);
    }
  }

  // Show what this task blocks
  if (state.blocks?.length) {
    for (const blk of state.blocks) {
      let blkStage = '?';
      try {
        const blkState = JSON.parse(await fs.readFile(path.join(TASKS_DIR, blk, 'state.json'), 'utf8'));
        blkStage = blkState.stage;
      } catch { /* not synced locally */ }
      console.log(`    → blocks: ${blk} (${blkStage})`);
    }
  }

  // Show follow-ups
  if (state.followups?.length) {
    for (const fu of state.followups) {
      console.log(`    ↳ follow-up: ${fu}`);
    }
  }

  // Show derived-from
  if (state.derivedFrom?.length) {
    for (const df of state.derivedFrom) {
      console.log(`    ↰ derived from: ${df}`);
    }
  }

  if (!state.dependsOn?.length && !state.blocks?.length && !state.followups?.length && !state.derivedFrom?.length) {
    console.log('    (no dependencies)');
  }
  console.log('');
}

/**
 * Copy every file from `sourceDir` into `destDir`, skipping files that already
 * exist (the cmdInit seed mechanism — reused by the new-project backlog step to
 * seed a generated workspace's `ai/templates`). Creates `destDir`. Returns the
 * list of basenames actually copied. Silent no-op when `sourceDir` is absent.
 *
 * NOTE: the SOURCE is always an INSTALL dir (the bundled seed files), never the
 * discovered workspace — a generated workspace needs the install's seed copies.
 * @param {string} sourceDir
 * @param {string} destDir
 * @returns {Promise<string[]>}
 */
async function seedDirIfMissing(sourceDir, destDir) {
  const copied = [];
  await fs.mkdir(destDir, { recursive: true });
  let files;
  try {
    files = await fs.readdir(sourceDir);
  } catch {
    return copied; // source dir absent — nothing to seed
  }
  for (const file of files) {
    const dest = path.join(destDir, file);
    try {
      await fs.access(dest); // already exists → skip
    } catch {
      await fs.copyFile(path.join(sourceDir, file), dest);
      copied.push(file);
    }
  }
  return copied;
}

async function cmdInit(repoPath) {
  // cmdInit's target defaults to the discovered workspace root (so `taskctl init`
  // from inside a workspace seeds THAT workspace); the SOURCE is always the
  // install dir (bundled seed files).
  const targetDir = repoPath ?? ORCHESTRATION_ROOT;

  await fs.mkdir(path.join(targetDir, 'ai', 'tasks'), { recursive: true });

  // Copy rules + templates if they don't exist in target. SOURCE = the install.
  for (const sub of ['rules', 'templates']) {
    const copied = await seedDirIfMissing(
      path.join(INSTALLATION_ROOT, 'ai', sub),
      path.join(targetDir, 'ai', sub),
    );
    for (const file of copied) console.log(`  Created: ai/${sub}/${file}`);
  }

  console.log(`✓ ai/ structure initialized in ${targetDir}`);
}

// --- Helpers ---

/**
 * Read review.md — checks the orchestration task dir first, then falls back
 * to .tmp-review-{issueKey}.md in the repo (for Codex sandbox limitations).
 * If found in repo fallback, copies it to the canonical location.
 */
async function readReviewFile(taskDir) {
  try {
    return await fs.readFile(path.join(taskDir, 'review.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse verdict from plan.md or review.md content.
 * Looks for "## Verdict: APPROVE" or "Verdict: NEEDS REVISION" pattern.
 * Returns the first verdict found (APPROVE, NEEDS REVISION, NEEDS WORK, REJECT) or null.
 */
function parseVerdict(content) {
  // Pattern 1: "## Verdict: APPROVE" or "Verdict: APPROVE" on one line
  const inline = content.match(/(?:^|\n)\s*(?:##\s*)?Verdict:\s*(APPROVE|NEEDS REVISION|NEEDS WORK|REJECT)/i);
  if (inline) return inline[1].toUpperCase();

  // Pattern 2: "## Verdict\n\nAPPROVE" (heading + value on next non-empty line)
  const heading = content.match(/(?:^|\n)\s*#{1,3}\s*Verdict\s*\n+\s*(APPROVE|NEEDS REVISION|NEEDS WORK|REJECT)/i);
  if (heading) return heading[1].toUpperCase();

  // Pattern 3: "<!-- verdict: APPROVE -->" (HTML comment)
  const comment = content.match(/<!--\s*verdict:\s*(APPROVE|NEEDS REVISION|NEEDS WORK|REJECT)\b/i);
  if (comment) return comment[1].toUpperCase();

  // Pattern 4: standalone keyword on its own line (last resort)
  const standalone = content.match(/(?:^|\n)\s*(APPROVE|NEEDS REVISION|NEEDS WORK|REJECT)\s*(?:\n|$)/i);
  if (standalone) return standalone[1].toUpperCase();

  return null;
}

/**
 * PURE command-builder (WP2 Stage 2b / I4): given an engine and a FULLY-RESOLVED
 * `options`, return the launch command string. Reads NO env / config — every
 * input arrives via `options`, so it is directly unit-testable without a private
 * seam. `launchCmd` (below) is the thin wrapper that resolves repoPath/cwd/effort.
 *
 * NOTE: this is NOT an engine ADAPTER abstraction (that is WP5) — it is a
 * same-shape extraction of the existing claude/codex string logic.
 *
 * @param {'claude'|'codex'|'opus'} engine
 * @param {object} [options]
 * @param {string} [options.repoPath]        resolved repo path (forward-slashed by caller or here)
 * @param {string} [options.cwd]             working dir (defaults to repoPath)
 * @param {string} [options.reasoningEffort] codex reasoning tier (resolved by caller)
 * @param {string} [options.prompt]          codex exec one-shot prompt
 * @param {boolean} [options.skipGitRepoCheck]
 * @param {string} [options.orchestrationDir] orchestration root for claude --add-dir (defaults to O)
 * @returns {string}
 */
export function buildLaunchCommand(engine, options = {}) {
  // WP5 Stage 5a: the per-engine launch-string branches moved into the engine
  // adapters (engines.mjs). This stays a pure, exported helper with the same
  // signature (WP2 I4 + the config-2b/engine-wiring-2b printed-launch parity
  // assertions depend on it) — it now resolves the adapter and delegates to its
  // buildLaunchString. `orchestrationDir` still defaults to the install's O.
  const orchestrationDir = options.orchestrationDir ?? O;
  return getEngine(engine).buildLaunchString({ ...options, orchestrationDir });
}

/**
 * Build the CLI launch command string for the given engine — thin wrapper that
 * resolves repoPath/cwd/effort from options + env + config, then delegates to
 * the pure `buildLaunchCommand`.
 *
 * Reasoning effort (codex) resolves as: `options.reasoningEffort` (explicit) >
 * `rcfg.engines.reasoningEffort` (config) > 'high' (fallback). This guarantees a
 * configured effort reaches EVERY launch — plan/run/fix/revise/replan included —
 * not just plan-review/review (WP2 Stage 2b C3). Pass `rcfg` so the second arg
 * needs no per-call-site effort plumbing.
 *
 * Claude Code: --add-dir for orchestration access.
 * Codex: permissions configured in ~/.codex/config.toml (auto-edit + disk-full-read-access).
 *
 * @param {'claude'|'codex'|'opus'} engine
 * @param {object} [options] same shape as buildLaunchCommand options
 * @param {object|null} [rcfg] normalized runtime config (for engines.reasoningEffort)
 */
function launchCmd(engine, options = {}, rcfg = null) {
  const repoPath = options.repoPath ?? process.env.REPO_PATH ?? null;
  const reasoningEffort = options.reasoningEffort ?? rcfg?.engines?.reasoningEffort;
  return buildLaunchCommand(engine, { ...options, repoPath, reasoningEffort });
}

/**
 * The engine of the OPPOSITE role, used by fix/revise console hints to suggest
 * the re-review command (`taskctl review … --engine <otherEngine>`). WP5 Stage
 * 5a: resolved via the configured author/reviewer pairing (rolePair) rather than
 * a hardcoded `engine === 'claude'` name compare — so a swapped or single-vendor
 * config pairs correctly. If the current engine is the author (planner), the
 * other role is the reviewer; otherwise the author. For the default config
 * (planner=claude, reviewer=codex) this matches the prior behavior exactly.
 * @param {string} engine  the currently-resolved engine
 * @param {object|null} rcfg  normalized runtime config
 */
function otherRoleEngine(engine, rcfg) {
  const { author, reviewer } = rolePair(rcfg);
  return engine === author ? reviewer : author;
}

/**
 * Parse --repo-path flag from args array.
 */
function parseRepoPath(args) {
  const idx = args.indexOf('--repo-path');
  return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : null;
}

/**
 * Parse --engine flag from args array.
 * Returns the explicit `--engine` value when valid; otherwise the configured
 * engine for the given role — reviewer (`rcfg.engines.reviewer`, default
 * 'codex') for plan-review/review, planner (`rcfg.engines.planner`, default
 * 'claude') for plan/run/fix/revise/replan — WP2 Stage 2b (C1). An explicit
 * `--engine` flag always wins over the configured default.
 * @param {string[]} args
 * @param {object|null} [rcfg]
 * @param {'planner'|'reviewer'} [role] which configured engine to default to
 */
function parseEngine(args, rcfg = null, role = 'planner') {
  const fallback = role === 'reviewer'
    ? (rcfg?.engines?.reviewer ?? 'codex')
    : (rcfg?.engines?.planner ?? 'claude');
  const idx = args.indexOf('--engine');
  if (idx !== -1 && args[idx + 1]) {
    const engine = args[idx + 1].toLowerCase();
    // WP5 Stage 5a (I-3): an explicit `--engine` is HARD-validated against the
    // live registry. assertEngineRegistered throws UnknownEngineError (listing
    // the registered names) on an unknown value. Because every cmdXxx resolves
    // the engine via parseEngine BEFORE writing the prompt / mutating state, an
    // unknown `--engine` fails CLEARLY and fails BEFORE any side effect —
    // consistent with the config-time check (C2). The allow-list is the registry,
    // so a newly-registered adapter is accepted with no edit here.
    return assertEngineRegistered(engine);
  }
  return fallback;
}

/**
 * Parse --branch-from <name> flag. Returns the base-branch name or null (caller
 * falls back to the configured integration branch). Used by `taskctl run` to
 * cut a worktree from a specific base branch.
 */
function parseBranchFrom(args) {
  const idx = args.indexOf('--branch-from');
  return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : null;
}

function extractDependencies(links, type) {
  const result = [];
  for (const link of links) {
    const linkType = link.type?.name?.toLowerCase() ?? '';
    if (type === 'blockedBy' && linkType === 'blocks' && link.inwardIssue) {
      result.push(link.inwardIssue.key);
    }
    if (type === 'blocks' && linkType === 'blocks' && link.outwardIssue) {
      result.push(link.outwardIssue.key);
    }
  }
  return result;
}

async function readState(taskDir, issueKey) {
  try {
    return JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
  } catch {
    console.error(`Task ${issueKey} not found. Run: taskctl sync ${issueKey}`);
    throw new Error('TASKCTL_EXIT');
  }
}

async function writeState(taskDir, state) {
  await fs.writeFile(path.join(taskDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

function printTaskStatus(state) {
  console.log(`\n  ${state.issueKey}`);
  console.log(`  Stage:       ${state.stage}`);
  console.log(`  Context:     v${state.contextVersion}`);
  console.log(`  Plan:        v${state.planVersion}`);
  console.log(`  Branch:      ${state.branch ?? '—'}`);
  console.log(`  PR:          ${state.activePR ?? '—'}`);
  console.log(`  Depends on:  ${state.dependsOn?.length ? state.dependsOn.join(', ') : '—'}`);
  console.log(`  Blocks:      ${state.blocks?.length ? state.blocks.join(', ') : '—'}`);
  console.log(`  Next action: ${state.nextAction ?? '—'}`);
  console.log(`  Last sync:   ${state.lastSyncedFromJira ?? '—'}`);
  console.log(`  Execution:   ${state.execution?.status ?? 'idle'}`);
  console.log('');
}

/**
 * `taskctl init-harness [--name <project>] [--dry-run]`
 *
 * Materialize the harness layer (operating contract, onboarding, session
 * monitor, GRACE skeleton, task playbook) into THIS workspace from
 * templates/harness/. {{PLACEHOLDER}}s are filled from taskctl.config.json +
 * .env + the target's git remote; generic files (session monitor, freshness)
 * ship config-driven. NEVER overwrites: a file that already exists and DIFFERS
 * is KEPT (reported, untouched); absent files are written — idempotent + safe
 * to re-run. `deps` (test-only) overrides workspaceRoot / templatesDir / gitRemote.
 */
async function cmdInitHarness(args, tcfg, deps = {}) {
  const workspaceRoot = deps.workspaceRoot ?? ORCHESTRATION_ROOT;
  const dryRun = args.includes('--dry-run');
  const name = flagValue(args, '--name');

  // Read straight from the loaded (un-normalized) config: repoPath + tracker are
  // top-level; branches + grace come from the raw block. resolveHarnessVars fills
  // any missing/partial value with a safe default, so a rough config still scaffolds.
  const raw = tcfg?.raw ?? {};
  const cfg = {
    repoPath: tcfg?.repoPath ?? null,
    tracker: tcfg?.tracker ?? { type: 'local' },
    branches: raw.branches ?? {},
    grace: raw.grace ?? {},
  };
  const repoPath = cfg.repoPath ? path.resolve(workspaceRoot, cfg.repoPath) : null;
  const gitRemote = deps.gitRemote ?? harness.readGitRemote(repoPath);
  const vars = harness.resolveHarnessVars(cfg, process.env, { workspaceRoot, name, gitRemote });

  let summary;
  try {
    summary = await harness.materializeHarness({
      workspaceRoot, vars, dryRun,
      ...(deps.templatesDir ? { templatesDir: deps.templatesDir } : {}),
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.error(msg.startsWith('TASKCTL_EXIT:') ? `init-harness: ${msg.slice('TASKCTL_EXIT:'.length)}` : `init-harness: ${msg}`);
    throw new Error('TASKCTL_EXIT');
  }

  const verb = dryRun ? 'would write' : 'wrote';
  console.log(`\n✓ init-harness${dryRun ? ' (dry-run — nothing written)' : ''}`);
  if (summary.written.length) console.log(`  ${verb} (${summary.written.length}):\n` + summary.written.map((d) => `    + ${d}`).join('\n'));
  if (summary.keptExisting.length) console.log('  kept your existing (differs from template — untouched):\n' + summary.keptExisting.map((d) => `    ~ ${d}`).join('\n'));
  if (summary.skippedIdentical.length) console.log(`  already current: ${summary.skippedIdentical.length} file(s)`);
  if (!dryRun && summary.written.length) {
    console.log('\n  Next: fill the `TODO:` markers in the rendered files (CLAUDE.md, SETUP.md, onboarding/…),');
    console.log('  then restart your agent so CLAUDE.md + /bootstrap load automatically.');
  }
  console.log('');
  return summary;
}

function printUsage() {
  console.log(`
taskctl — AI-assisted development orchestrator

Main cycle:
  new <slug> [--title …] [--desc …]        Create a LOCAL task (no Jira) → context.md + state.json
  new-project "<idea>" [--dir <p>]         Start a project from a bare idea (brainstorm → proposal →
     [--engine] [--yes] [--restart]         print-only scaffold → backlog → self-attach). Resumable.
  sync CP-XXX                              Fetch from Jira, build context.md
  status [CP-XXX]                          Show task state (or all tasks)
  list [--sprint <name>]                   List all tasks (optionally filter by sprint)
  plan CP-XXX [--engine] [--cc-thingz]     Prepare planning prompt (--no-brainstorm for auto mode)
  plan CP-XXX --finalize                   Finalize plan after CLI session
  plan-review CP-XXX [--engine]            Cross-model plan review
  plan-review CP-XXX --finalize            Finalize plan review
  run CP-XXX [--engine] [--repo-path <p>]  Prepare execution (auto-creates branch)
  run CP-XXX --finalize                    Finalize execution (fires GRACE lint gate only when grace.enabled)
  run CP-XXX --finalize --skip-grace-gate  Bypass GRACE gate (emergency escape hatch; only relevant when grace.enabled)
  review CP-XXX [--engine] [--repo-path]   Final review (auto-resolves branch from the tracker PR label)
  review CP-XXX --external                 Review another developer's PR (skips stage check)
  review CP-XXX --finalize                 Finalize review
  publish CP-XXX --repo-path <path>        Commit, push, and create PR (--dry-run to preview)
     --jira                                 Assign ticket + add PR-N label in Jira
  jira-sync CP-XXX                         Sync state to Jira (dry run in Phase 0)

Lifecycle:
  refresh CP-XXX                           Re-sync context from Jira (preserve stage)
  resume CP-XXX                            Generate resume summary for re-entry
  revise CP-XXX [--engine]                 Fix plan based on plan-review feedback
  revise CP-XXX --finalize                 Finalize revised plan
  fix CP-XXX [--engine]                    Fix code based on final review feedback
  fix CP-XXX --finalize                    Finalize fix, go to re-review
  replan CP-XXX [--engine]                 Archive plan, start from scratch
  handoff CP-XXX                           Save handoff snapshot before pausing
  create-followup CP-YYY --from CP-XXX     Create follow-up task record

Automation:
  do <stage> CP-XXX [flags]                One command: prepare + AI + finalize
     Stages: plan, plan-review, run, review, revise, fix
     --auto                                Auto-loop: plan→review→revise or run→review→fix until approved
     --flip                                 Flipped flow — reviser/reviewer alternate each iter
                                            (see docs/methodology/flipped-flow.md)
     --max-iterations N                    Max revision/fix attempts (default: 3)
     --cc-thingz, --no-brainstorm, --engine, --repo-path, --external
  flow CP-XXX [--from] [--to] [--repo-path]  Chain stages with feedback loops
     --cc-thingz [--no-brainstorm]          Planning mode
  autopilot CP-XXX [--repo-path] [--yes]   Full cycle: sync → flow → publish
     --cc-thingz [--no-brainstorm]          Planning mode
     --jira                                 Update Jira on publish

Onboarding:
  attach <repo> [--force]                  Analyze a repo (READ-ONLY) → write taskctl.config.json (sidecar)
                                           Refuses to clobber an existing config without --force
  init-harness [--name <p>] [--dry-run]    Scaffold the harness layer (CLAUDE.md, SETUP.md, onboarding,
                                           session monitor, GRACE skeleton, playbook) into this workspace.
                                           Fills placeholders from config/.env; NEVER overwrites your edits.

Utilities:
  deps CP-XXX                              Show dependency graph
  init [<path>]                            Create ai/ structure in target dir

GRACE governance (opt-in — requires grace.enabled:true in taskctl.config.json):
  grace-gate [CP-XXX] [--repo-path <p>]    Run GRACE lint + XML parse gates (pass/fail)
                                           If CP-XXX given, persist result to state.graceGate
  sync-grace [--repo-path <p>]             Rebase the pilot branch onto its configured upstream
     --dry-run                              Preview divergence + likely conflicts, no rebase
     --abort                                Abort an in-progress rebase
     --continue                             Continue an in-progress rebase after resolving conflicts
     --auto-resolve                         Attempt Layer 1 text-merge of markup conflicts,
                                           then stage + --continue automatically (max 5 iterations).
                                           Falls through to markup-agent prompt on low confidence.
     --force-agent-prompt                   Skip Layer 1; write ai/state/markup-agent-prompt.md
                                           directly for every conflict (user dispatches opus 4.7,
                                           then runs taskctl sync-grace --continue).
                                           Detects governed-file conflicts for markup-aware
                                           resolution; stops for user action (T5a default).
                                           State: ai/state/sync-grace-state.json.

Stage flow:
  sync → plan → plan-review → run → review → publish
  (analysis → planned → plan_reviewed → running → review → done)

Phase constraints:
  Jira: READ ONLY
  Git: PRs only (no direct commits to dev/main)
  Models: CLI only (no API access)
`);
}

// Only run main() when this file is executed directly, not when it's
// imported as a module (e.g. for tests or `node -e "import(...)"`
// inspection of exported helpers like `runGraceGate`).
const __argv1 = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1].replace(/\\/g, '/')}`)).replace(/\\/g, '/') : '';
const __self  = fileURLToPath(import.meta.url).replace(/\\/g, '/');
if (__argv1 && __self && path.resolve(__argv1) === path.resolve(__self)) {
  main().catch((err) => {
    // TASKCTL_EXIT is a sentinel: the command already printed a detailed
    // error to stderr and just wants a non-zero exit. Don't add noise.
    if (err.message !== 'TASKCTL_EXIT') {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  });
}

// Test-only exports of pure, side-effect-free helpers. Importing this module
// does NOT run main() (guarded above), so these are safe to unit-test directly.
// otherRoleEngine is exported so the deliberate-exception-3 (role-based re-review
// hint) parity tests can assert it directly under swapped/single-vendor/opus rcfg.
export { validateSlug, flagValue, extractDependencies, parseEngine, otherRoleEngine };

// WP5 Stage 5b: the new-project flow is exported so the hermetic end-to-end test
// can drive it IN-PROCESS with the fake adapter registered (a subprocess CLI run
// can never resolve `fake` — registration is test-code only). `deps` overrides
// the engine runner / readline / lock liveness / clock for determinism.
export { cmdNewProject };
