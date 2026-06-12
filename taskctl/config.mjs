/**
 * Configuration for taskctl.
 * Reads from environment variables or .env file.
 *
 * Load order (generic chain — each layer fills only the vars not already set):
 *   1. taskctl/.env
 *   2. the workspace root .env  (optional REPO_PATH and other vars)
 *   3. Explicit envPath passed by caller
 *
 * Tracker credentials (e.g. JIRA_*) come from any of the above, the shell
 * environment, or the explicit envPath — there is no probing of sibling
 * project directories.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
// engines.mjs imports only node built-ins (no cli/automation/config), so this is
// a clean one-way edge — config can validate the resolved engines at load time
// (C2) without a cycle.
import { assertEngineRegistered } from './engines.mjs';

const __dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ORCH_ROOT = path.resolve(__dir, '..');

const REQUIRED_JIRA_VARS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'];

const DEFAULT_CONFIG_NAME = 'taskctl.config.json';
const KNOWN_TRACKER_TYPES = new Set(['local', 'jira']);

/**
 * Load all env files in order, then validate Jira vars.
 */
export async function loadConfig(envPath) {
  // Step 1: load taskctl/.env, then the workspace root .env (generic chain).
  await tryLoadEnv(path.join(__dir, '.env'));
  await tryLoadEnv(path.join(ORCH_ROOT, '.env'));

  // Step 2: explicit path from caller (if any).
  if (envPath) await tryLoadEnv(envPath);

  const missing = REQUIRED_JIRA_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}\nSet them in .env or shell environment.`);
  }

  return {
    baseUrl: process.env.JIRA_BASE_URL.replace(/\/$/, ''),
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN,
    projectKey: process.env.JIRA_PROJECT_KEY,
  };
}

/**
 * Exported helper: returns resolved paths from .env (VIBE_ROOT, REPO_PATH, ORCH_ROOT).
 * Can be called without Jira vars.
 */
export function getPaths() {
  return {
    vibeRoot: process.env.VIBE_ROOT ?? path.resolve(ORCH_ROOT, '..'),
    repoPath: process.env.REPO_PATH ?? null,
    orchRoot: ORCH_ROOT,
  };
}

// --- Additive: config layer + tracker selection (WP1) ---
//
// `loadConfig` above keeps its throw-on-missing-creds behavior (the Jira path +
// the lazy flow/autopilot callers depend on it). The helpers below are purely
// additive: `loadEnvOnly` is a SHARED .env-loading call (same generic chain
// loadConfig uses, factored so the new loader can reuse it without duplicating
// the sequence), and `loadTaskctlConfig` never throws on missing Jira creds —
// it only reports the resolved {repoPath, tracker} shape.

/**
 * Load the .env files in the standard order for their side effects only
 * (REPO_PATH / JIRA_* / other vars land in process.env). Never throws on a
 * missing Jira var — that validation lives in `loadConfig` alone.
 * Mirrors the generic load chain `loadConfig` uses (taskctl/.env → workspace
 * root .env → explicit envPath).
 *
 * @param {string} [envPath] explicit extra .env path (forwarded, loaded last)
 */
export async function loadEnvOnly(envPath) {
  // Step 1: load taskctl/.env, then the workspace root .env (generic chain).
  await tryLoadEnv(path.join(__dir, '.env'));
  await tryLoadEnv(path.join(ORCH_ROOT, '.env'));

  // Step 2: explicit path from caller (if any).
  if (envPath) await tryLoadEnv(envPath);
}

/**
 * Validate a tracker type string; throw on anything unknown (e.g. a "jria"
 * typo) so misconfiguration fails loudly rather than silently falling to local.
 * @param {unknown} type
 */
export function validateTrackerType(type) {
  if (typeof type !== 'string' || !KNOWN_TRACKER_TYPES.has(type)) {
    throw new Error(
      `Invalid tracker.type ${JSON.stringify(type)} — expected one of: ${[...KNOWN_TRACKER_TYPES].join(', ')}.`
    );
  }
}

// --- WP2 Stage 2a: GRACE config block + normalized runtime config ---
//
// GRACE governance is OPT-IN, off by default (`grace.enabled:false`). When
// disabled every GRACE branch is a no-op (writers AND readers) and the
// mandatory `--deferred-grace` footgun disappears. When explicitly enabled it
// works against `grace.{repoRoot,pilotBranch,upstreamBranch}`.

const GRACE_DEFAULT_PILOT_BRANCH = 'experiment/grace-pilot';
const GRACE_DEFAULT_UPSTREAM_BRANCH = 'dev';

// --- WP2 Stage 2b: project-neutral defaults for the externalized config ---
//
// All Stage-2b fields are OPTIONAL. When omitted they resolve to these
// PROJECT-NEUTRAL defaults (NOT the origin project's values) — that is the
// point of WP2. A concrete install ships a real taskctl.config.json.

const DEFAULT_INTEGRATION_BRANCH = 'dev';      // worktree base + review diff base
const DEFAULT_PLANNER_ENGINE = 'claude';
const DEFAULT_REVIEWER_ENGINE = 'codex';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_PROMPT_LANGUAGE = 'en';
const KNOWN_PROMPT_LANGUAGES = new Set(['en', 'ru']);

/**
 * Validate the optional Stage-2b config blocks (`branches`, `engines`,
 * `promptLanguage`, `projectContext`, `constraints`, `codeAreas`,
 * `previewUrlTemplate`, `tracker.assigneeEmail`). Loud failure on a wrong
 * shape/type — mirrors the `validateTrackerType` / `validateGraceConfig`
 * convention so misconfiguration is caught at load, not at use.
 *
 * @param {object} raw  the raw taskctl.config.json object (`tcfg.raw`)
 */
export function validateRuntimeConfigShape(raw) {
  if (raw == null) return;

  const assertObject = (val, label) => {
    if (val != null && (typeof val !== 'object' || Array.isArray(val))) {
      throw new Error(`Invalid ${label} ${JSON.stringify(val)} — expected an object.`);
    }
  };
  const assertStringArray = (val, label) => {
    if (val == null) return;
    if (!Array.isArray(val) || val.some((x) => typeof x !== 'string')) {
      throw new Error(`Invalid ${label} ${JSON.stringify(val)} — expected an array of strings.`);
    }
  };
  const assertOptString = (val, label) => {
    if (val != null && typeof val !== 'string') {
      throw new Error(`Invalid ${label} ${JSON.stringify(val)} — expected a string.`);
    }
  };

  assertObject(raw.branches, 'branches');
  if (raw.branches) {
    assertOptString(raw.branches.integration, 'branches.integration');
    assertOptString(raw.branches.prTarget, 'branches.prTarget');
  }

  assertObject(raw.engines, 'engines');
  if (raw.engines) {
    assertOptString(raw.engines.planner, 'engines.planner');
    assertOptString(raw.engines.reviewer, 'engines.reviewer');
    assertOptString(raw.engines.reasoningEffort, 'engines.reasoningEffort');
  }

  if (raw.promptLanguage != null) {
    if (typeof raw.promptLanguage !== 'string' || !KNOWN_PROMPT_LANGUAGES.has(raw.promptLanguage)) {
      throw new Error(
        `Invalid promptLanguage ${JSON.stringify(raw.promptLanguage)} — expected one of: ${[...KNOWN_PROMPT_LANGUAGES].join(', ')}.`
      );
    }
  }

  assertStringArray(raw.projectContext, 'projectContext');
  assertStringArray(raw.constraints, 'constraints');
  assertOptString(raw.previewUrlTemplate, 'previewUrlTemplate');

  // codeAreas: a map of keyword → string[] (representative paths).
  assertObject(raw.codeAreas, 'codeAreas');
  if (raw.codeAreas) {
    for (const [kw, paths] of Object.entries(raw.codeAreas)) {
      assertStringArray(paths, `codeAreas.${kw}`);
    }
  }

  assertObject(raw.tracker, 'tracker');
  if (raw.tracker) assertOptString(raw.tracker.assigneeEmail, 'tracker.assigneeEmail');
}

/**
 * Validate the raw `grace` block from taskctl.config.json. Loud failure on a
 * non-boolean `enabled` or a non-string branch override (mirrors
 * `validateTrackerType`'s convention) so misconfiguration is caught early
 * rather than silently mis-typing a branch.
 *
 * @param {unknown} graceFile  the raw `tcfg.raw.grace` object (or undefined)
 */
export function validateGraceConfig(graceFile) {
  if (graceFile == null) return; // absent → defaults apply
  if (typeof graceFile !== 'object' || Array.isArray(graceFile)) {
    throw new Error(`Invalid grace config ${JSON.stringify(graceFile)} — expected an object.`);
  }
  if ('enabled' in graceFile && typeof graceFile.enabled !== 'boolean') {
    throw new Error(
      `Invalid grace.enabled ${JSON.stringify(graceFile.enabled)} — expected a boolean (true enables governance).`
    );
  }
  for (const key of ['repoRoot', 'pilotBranch', 'upstreamBranch']) {
    if (key in graceFile && graceFile[key] != null && typeof graceFile[key] !== 'string') {
      throw new Error(`Invalid grace.${key} ${JSON.stringify(graceFile[key])} — expected a string.`);
    }
  }
}

/**
 * Resolve a possibly-relative path against the config file's directory.
 * Returns null for an empty/absent value.
 *
 * @param {string|undefined|null} maybePath
 * @param {string} configPath  absolute path to taskctl.config.json
 * @returns {string|null}
 */
function resolveMaybeRelative(maybePath, configPath) {
  if (!maybePath) return null;
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.resolve(path.dirname(configPath), maybePath);
}

/**
 * Build ONE normalized runtime config object from the resolved
 * `loadTaskctlConfig` result. Pure (no fs/env reads of its own) and
 * unit-testable. Fills GRACE defaults and resolves `grace.repoRoot` with the
 * `?? repoPath` fallback (C5), plus the Stage-2b project-externalization fields
 * (`branches`/`engines`/`promptLanguage`/`projectContext`/`constraints`/
 * `codeAreas`/`previewUrlTemplate`/`tracker.assigneeEmail`) with PROJECT-NEUTRAL
 * defaults (absence reproduces neutral behavior, never the origin project).
 *
 * @param {Awaited<ReturnType<typeof loadTaskctlConfig>>} tcfg
 * @returns {{
 *   repoPath: string|null,
 *   tracker: { type:'local'|'jira', assigneeEmail: string|null },
 *   grace: { enabled: boolean, repoRoot: string|null, pilotBranch: string, upstreamBranch: string },
 *   branches: { integration: string, prTarget: string },
 *   engines: { planner: string, reviewer: string, reasoningEffort: string },
 *   promptLanguage: 'en'|'ru',
 *   projectContext: string[],
 *   constraints: string[],
 *   codeAreas: Record<string,string[]>,
 *   previewUrlTemplate: string|null,
 *   configPath: string,
 *   raw: object,
 * }}
 */
export function normalizeRuntimeConfig(tcfg) {
  const raw = tcfg?.raw ?? {};

  const graceFile = raw.grace ?? null;
  validateGraceConfig(graceFile); // throws on non-boolean enabled / non-string branch
  validateRuntimeConfigShape(raw); // throws on bad branches/engines/language/arrays
  const gf = graceFile ?? {};

  const grace = {
    enabled: gf.enabled === true, // strict: only an explicit `true` enables
    repoRoot: resolveMaybeRelative(gf.repoRoot, tcfg.configPath) ?? tcfg.repoPath ?? null, // C5
    pilotBranch: gf.pilotBranch ?? GRACE_DEFAULT_PILOT_BRANCH,
    upstreamBranch: gf.upstreamBranch ?? GRACE_DEFAULT_UPSTREAM_BRANCH,
  };

  if (grace.enabled && !grace.repoRoot) {
    throw new Error(
      'grace.enabled is true but no repo root resolved — set grace.repoRoot or repoPath / REPO_PATH.'
    );
  }

  // branches: prTarget falls back to integration when unset.
  const integration = raw.branches?.integration ?? DEFAULT_INTEGRATION_BRANCH;
  const branches = {
    integration,
    prTarget: raw.branches?.prTarget ?? integration,
  };

  const engines = {
    planner: raw.engines?.planner ?? DEFAULT_PLANNER_ENGINE,
    reviewer: raw.engines?.reviewer ?? DEFAULT_REVIEWER_ENGINE,
    reasoningEffort: raw.engines?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  };
  // C2: validate the RESOLVED planner + reviewer against the engine registry at
  // config-resolution time — i.e. BEFORE any command writes a prompt or mutates
  // state.json. A bogus `engines.planner:"bogus"` previously slipped through
  // (only string-typed) and failed late at launch AFTER side effects. The throw
  // is an UnknownEngineError listing the registered names. normalizeRuntimeConfig
  // is pure (no fs/env of its own) so this stays a load-time check.
  assertEngineRegistered(engines.planner);
  assertEngineRegistered(engines.reviewer);

  return {
    repoPath: tcfg.repoPath ?? null,
    tracker: {
      type: tcfg.tracker.type,
      assigneeEmail: raw.tracker?.assigneeEmail ?? null,
    },
    grace,
    branches,
    engines,
    promptLanguage: raw.promptLanguage ?? DEFAULT_PROMPT_LANGUAGE,
    projectContext: Array.isArray(raw.projectContext) ? raw.projectContext : [],
    constraints: Array.isArray(raw.constraints) ? raw.constraints : [],
    codeAreas: (raw.codeAreas && typeof raw.codeAreas === 'object' && !Array.isArray(raw.codeAreas))
      ? raw.codeAreas
      : {},
    previewUrlTemplate: raw.previewUrlTemplate ?? null,
    configPath: tcfg.configPath,
    raw,
  };
}

/**
 * Load the taskctl.config.json layer (optional) plus .env side effects, and
 * resolve the effective {repoPath, tracker} for this invocation.
 *
 * NEVER throws on missing Jira creds — only reports the resolved shape. The
 * hard creds throw stays in `loadConfig` (reached via `loadJiraCreds`) and
 * fires only when the resolved tracker is `jira`.
 *
 * Back-compat tracker inference: with NO config file present, a COMPLETE
 * legacy `JIRA_*` env (all four vars) infers `tracker.type:'jira'` so existing
 * env-only Jira installs keep today's behavior; otherwise (config file present,
 * or incomplete/absent Jira env) it defaults to `'local'`.
 *
 * @param {object} [opts]
 * @param {string} [opts.configRoot] dir to look for taskctl.config.json (default ORCH_ROOT)
 * @param {string} [opts.configPath] explicit file path (overrides configRoot)
 * @param {string} [opts.envPath]    forwarded to .env loading
 * @param {boolean} [opts.loadEnv]   load ambient .env files (default true). Tests
 *                                   pass false to control process.env in isolation
 *                                   without the loader pulling in real .env files.
 * @returns {Promise<{repoPath:string|null, tracker:{type:'local'|'jira'}, fileFound:boolean, configPath:string, raw:object}>}
 */
export async function loadTaskctlConfig(opts = {}) {
  const configRoot = opts.configRoot ?? ORCH_ROOT;
  const configPath = opts.configPath ?? path.join(configRoot, DEFAULT_CONFIG_NAME);

  // 1. load .env files for side-effects (REPO_PATH / JIRA_* land in process.env)
  if (opts.loadEnv !== false) await loadEnvOnly(opts.envPath);

  // 2. read config file if present (tolerate ENOENT); remember whether it existed
  let file = null;
  let fileFound = false;
  try {
    file = JSON.parse(await fs.readFile(configPath, 'utf8'));
    fileFound = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // malformed JSON surfaces; missing file is fine
  }

  // 3. back-compat tracker.type inference (explicit config wins)
  const hasLegacyJira = REQUIRED_JIRA_VARS.every((v) => !!process.env[v]);
  const type = file?.tracker?.type ?? ((!fileFound && hasLegacyJira) ? 'jira' : 'local');
  validateTrackerType(type); // throw on unknown

  // 4. resolve repoPath: env > file(relative-to-config-dir) > null. There is no
  //    baked-in fallback (WP2 Stage 2b): a repo-needing command errors clearly
  //    via cli.resolveRepoPath() when this stays null.
  const configDir = path.dirname(configPath);
  const fileRepo = file?.repoPath
    ? (path.isAbsolute(file.repoPath) ? file.repoPath : path.resolve(configDir, file.repoPath))
    : null;

  return {
    repoPath: process.env.REPO_PATH ?? fileRepo ?? null,
    tracker: {
      type,
      // NOTE: Jira projectKey is ENV-ONLY (read by loadConfig at JIRA_PROJECT_KEY).
      // It is intentionally NOT part of the WP1 config contract — deferred to WP2.
    },
    fileFound,
    configPath,
    raw: file ?? {},
    // NOTE: branches/engines/promptLanguage/projectContext/constraints/codeAreas
    // live under `raw` and are resolved (with defaults) by normalizeRuntimeConfig
    // — this loader stays a thin reader and does not flatten them here.
  };
}

/**
 * Jira creds loader for the gate — a thin pass-through to the UNCHANGED
 * `loadConfig`. There is no JSON projectKey to thread, so no override logic
 * exists: `loadConfig` reads all four `JIRA_*` from env (incl. JIRA_PROJECT_KEY)
 * and throws if any are missing, exactly as today. Kept as a named seam so the
 * gate call-site reads intent-fully and WP2 can add a JSON-projectKey-aware
 * variant here without touching cmdSync/cmdRefresh.
 *
 * @param {object} [_tcfg] resolved taskctl config (reserved for WP2; unused now)
 * @param {object} [opts]
 * @param {string} [opts.envPath]
 */
export async function loadJiraCreds(_tcfg, opts = {}) {
  return loadConfig(opts.envPath); // UNCHANGED loadConfig: still throws if any JIRA_* missing
}

// --- internals ---

async function tryLoadEnv(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    parseEnvFile(content);
  } catch {
    // file not found — skip
  }
}

function parseEnvFile(content) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
