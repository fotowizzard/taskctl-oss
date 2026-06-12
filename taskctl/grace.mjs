/**
 * grace.mjs — GRACE governance logic for taskctl (WP2 Stage 2a).
 *
 * GRACE governance is OPT-IN, off by default (`grace.enabled:false` in
 * taskctl.config.json). This module holds ONLY the pure GRACE logic — the
 * lint/XML gate, the prompt-hint + context-block builders, and the
 * `sync-grace` rebase/conflict-classification pipeline. The command ADAPTERS
 * (`cmdGraceGate`, `cmdSyncGrace`) stay in cli.mjs: they touch CLI-local
 * infrastructure (parseRepoPath / readState / writeState / cmdHandoff /
 * ORCHESTRATION_ROOT) and delegate the pure work to the functions here.
 *
 * IMPORTANT — acyclic module graph:
 *   This module imports NOTHING from context-builder.mjs (and nothing from
 *   cli.mjs). Every cli/context dependency it needs — `runGit`, the
 *   governed-path helpers (`loadGovernedModules`, `isGovernedPath`),
 *   `detectRepoBranch`, and the branch names {pilotBranch, upstreamBranch} —
 *   arrives as an INJECTED argument from the cli.mjs adapters. The only edge
 *   between this module and context-builder is the reverse direction:
 *   `context-builder.buildContextMd` imports `buildGraceContextBlock` from
 *   HERE and passes it a `repoRoot` + already-computed `moduleIds`. Net:
 *   `context-builder → grace` and `cli → grace`, one-way.
 *
 * GRACE mode note (WP2 Stage 2a):
 *   The legacy full-vs-deferred mode split is COLLAPSED to the deferred
 *   (read-only / planning-acuity) behavior only. The prompt hint injects
 *   GRACE artefact pointers for planning/review acuity; it never asks the
 *   plan to include MODULE_CONTRACT/XML governance tasks (those are batched
 *   via `taskctl sync-grace` on the pilot branch). The former "full" mode and
 *   its `--full-grace`/`--deferred-grace` flags are removed.
 *
 * Upstream: GRACE methodology by Vladimir Ivanov (osovv) —
 * https://github.com/osovv/grace-marketplace
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default pilot branch on which GRACE governance is active. Kept as a default
 * so callers that don't pass an explicit `pilotBranch` (e.g. the legacy
 * single-arg `runGraceGate(repoRoot)` shape used by tests) still behave as
 * before. Production call-sites pass `rcfg.grace.pilotBranch`.
 */
export const GRACE_PILOT_BRANCH = 'experiment/grace-pilot';

/**
 * M-IDs that made up the original pilot scope (document-processing). Used as a
 * fallback when `buildGraceContextBlock` is called without an explicit
 * moduleIds collection.
 */
const PILOT_MODULE_IDS = new Set([
  'M-DOC-EXTRACTION',
  'M-PDF-EXTRACTOR',
  'M-EDGE-EXTRACT-PROPERTY',
  'M-EDGE-EXTRACT-BRANDING',
  'M-EDGE-EXTRACT-VISION',
  'M-EDGE-EXTRACT-INVENTORY',
  'M-EDGE-STORE-DOC',
  'M-DOC-PROCESSING-HOOK',
  'M-TYPES-EXTRACTION',
]);

// ---------------------------------------------------------------------------
// GRACE lint gate
// ---------------------------------------------------------------------------

/**
 * Default path to the `grace` CLI when it isn't already on the inherited
 * Node PATH. Bun installs the binary under `~/.bun/bin/grace.exe` on
 * Windows; gmMingw/bash sessions see it, but a plain `node` process
 * started from Explorer or VS Code may not. Augmenting PATH with this
 * directory lets `spawnSync('grace', …, { shell: true })` find it
 * without forcing every invocation to specify an absolute path.
 */
const GRACE_BUN_BIN =
  process.platform === 'win32'
    ? path.join(process.env.USERPROFILE ?? 'C:/Users/dp', '.bun', 'bin')
    : path.join(process.env.HOME ?? '/home/dp', '.bun', 'bin');

/**
 * Build a spawn env with `~/.bun/bin` prepended to PATH (and `Path` for
 * Windows case sensitivity). Returns `process.env` untouched when
 * augmentation isn't possible / not needed.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function buildGraceSpawnEnv() {
  const env = { ...process.env };
  const cur = env.PATH ?? env.Path ?? '';
  // Skip augmentation if the bun bin dir is already present.
  if (cur.split(path.delimiter).some((p) => path.resolve(p) === path.resolve(GRACE_BUN_BIN))) {
    return env;
  }
  let bunBinExists = false;
  try {
    bunBinExists = fsSync.existsSync(GRACE_BUN_BIN);
  } catch {
    /* ignore */
  }
  if (!bunBinExists) return env;
  const augmented = GRACE_BUN_BIN + path.delimiter + cur;
  env.PATH = augmented;
  if (process.platform === 'win32') env.Path = augmented;
  return env;
}

/**
 * Run a `grace lint` invocation for the given profile and return a
 * normalized `{ status, summary, output }` object.
 *
 * status = 'pass' | 'fail' | 'skipped' | 'error'
 *   - pass: exit 0 and JSON `issues` array is empty
 *   - fail: exit 0 but `issues` is non-empty, or non-zero exit with output
 *   - error: grace binary missing / spawn error / unparseable output
 *
 * @param {string} profile  'standard' | 'autonomous'
 * @param {string} repoRoot
 * @returns {{ status: string, summary: string, output: string }}
 */
function runGraceLintOnce(profile, repoRoot) {
  const env = buildGraceSpawnEnv();
  let proc;
  try {
    proc = spawnSync(
      'grace',
      ['lint', '--profile', profile, '--path', repoRoot, '--format', 'json'],
      {
        shell: true,
        encoding: 'utf8',
        env,
        // grace lint on a full repo runs in well under a minute; cap at
        // 2 min so a runaway invocation doesn't wedge the gate.
        timeout: 120_000,
      },
    );
  } catch (err) {
    return {
      status: 'error',
      summary: `spawn error: ${err.message}`,
      output: '',
    };
  }

  const out = (proc.stdout ?? '').toString();
  const errText = (proc.stderr ?? '').toString();
  const combined = out + (errText ? `\n[stderr]\n${errText}` : '');

  if (proc.error) {
    return {
      status: 'error',
      summary: `spawn error: ${proc.error.message}`,
      output: combined,
    };
  }

  // ENOENT via shell on Windows surfaces as "is not recognized" on stderr
  // with a non-zero exit; detect and report as skip-with-warning.
  if (/is not recognized as an internal or external command/i.test(errText) ||
      /command not found/i.test(errText)) {
    return {
      status: 'error',
      summary: 'grace CLI not found on PATH',
      output: combined,
    };
  }

  // Parse JSON — grace always prints a JSON object when --format json,
  // even on non-zero exit. Fall back to text parsing for defensiveness.
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    /* fall through */
  }

  if (parsed && Array.isArray(parsed.issues)) {
    const issues = parsed.issues;
    const errorCount = issues.filter((i) => (i.severity ?? i.level ?? '') === 'error').length;
    const warnCount = issues.filter((i) => (i.severity ?? i.level ?? '') === 'warning').length;
    const otherCount = issues.length - errorCount - warnCount;
    const totalErrors = errorCount + (otherCount > 0 && errorCount === 0 && warnCount === 0 ? otherCount : 0);
    const pass = proc.status === 0 && issues.length === 0;
    if (pass) {
      return {
        status: 'pass',
        summary: '0 errors / 0 warnings',
        output: combined,
      };
    }
    return {
      status: 'fail',
      summary: `${totalErrors} error(s) / ${warnCount} warning(s)`,
      output: combined,
    };
  }

  // JSON parse failed — fall back to heuristic text parsing.
  const textMatch = combined.match(/errors:\s*(\d+),\s*warnings:\s*(\d+)/i);
  if (textMatch) {
    const errors = parseInt(textMatch[1], 10);
    const warnings = parseInt(textMatch[2], 10);
    if (proc.status === 0 && errors === 0 && warnings === 0) {
      return {
        status: 'pass',
        summary: '0 errors / 0 warnings',
        output: combined,
      };
    }
    return {
      status: 'fail',
      summary: `${errors} error(s) / ${warnings} warning(s)`,
      output: combined,
    };
  }

  // Completely unparseable — treat as error (but distinct from hard skip).
  return {
    status: 'error',
    summary: `unparseable grace output (exit ${proc.status})`,
    output: combined,
  };
}

/**
 * Run the python `xml.etree.ElementTree` parse gate over the 4
 * governance XMLs. Grace lint is permissive on raw-token malformedness
 * (Wave-4 lesson), so this is a second line of defense.
 *
 * @param {string} repoRoot
 * @returns {{ status: string, summary: string, output: string }}
 */
function runPythonXmlGate(repoRoot) {
  const script =
    "import xml.etree.ElementTree as ET\n" +
    "files = ('docs/development-plan.xml', 'docs/knowledge-graph.xml', 'docs/verification-plan.xml', 'docs/operational-packets.xml')\n" +
    "for f in files:\n" +
    "    ET.parse(f)\n" +
    "print('OK')\n";

  // Write the script to a temp file and invoke `python <file>` rather
  // than `python -c "<script>"`. The `-c` form triggers a long-standing
  // Windows quoting bug whenever `shell: true` is used, and without
  // the shell some environments can't resolve `python` → `python.exe`.
  // File-based invocation works with or without the shell.
  let scriptPath;
  try {
    scriptPath = path.join(
      fsSync.mkdtempSync(path.join(os.tmpdir(), 'grace-gate-')),
      'xml-parse.py',
    );
    fsSync.writeFileSync(scriptPath, script, 'utf8');
  } catch (err) {
    return {
      status: 'error',
      summary: `temp file error: ${err.message}`,
      output: '',
    };
  }

  const tryRun = (useShell) => {
    try {
      return spawnSync('python', [scriptPath], {
        cwd: repoRoot,
        shell: useShell,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 60_000,
      });
    } catch (err) {
      return { error: err, stdout: '', stderr: '', status: null };
    }
  };

  let proc = tryRun(false);
  // If python wasn't found without the shell, retry with the shell so
  // PATHEXT / cmd.exe can resolve aliases on Windows.
  if ((proc.error && proc.error.code === 'ENOENT') || proc.status === null) {
    proc = tryRun(true);
  }

  // Clean up the temp dir and script file (best-effort).
  try {
    fsSync.unlinkSync(scriptPath);
    fsSync.rmdirSync(path.dirname(scriptPath));
  } catch { /* ignore */ }

  const out = (proc.stdout ?? '').toString();
  const errText = (proc.stderr ?? '').toString();
  const combined = out + (errText ? `\n[stderr]\n${errText}` : '');

  if (proc.error) {
    return {
      status: 'error',
      summary: `spawn error: ${proc.error.message}`,
      output: combined,
    };
  }

  if (/is not recognized as an internal or external command/i.test(errText) ||
      /command not found/i.test(errText)) {
    return {
      status: 'error',
      summary: 'python not found on PATH',
      output: combined,
    };
  }

  if (proc.status === 0 && /\bOK\b/.test(out)) {
    return {
      status: 'pass',
      summary: 'OK (4 XMLs well-formed)',
      output: combined,
    };
  }

  // Extract first ET.ParseError line from stderr if present.
  const parseErrMatch = errText.match(/ParseError:[^\n]+/);
  return {
    status: 'fail',
    summary: parseErrMatch ? parseErrMatch[0] : `python exit ${proc.status}`,
    output: combined,
  };
}

/**
 * Run the full GRACE gate suite against a repo root:
 *   1. grace lint --profile standard
 *   2. grace lint --profile autonomous
 *   3. python ET.parse over the 4 governance XMLs
 *
 * Branch-aware: if the repo is not on `pilotBranch`, all 3 gates are reported
 * as `skipped` and verdict = `skipped-non-pilot-branch`.
 *
 * Grace CLI unavailability is reported as `skipped` (graceful degrade), not a
 * hard failure.
 *
 * @param {string} repoRoot
 * @param {string} [pilotBranch]  branch GRACE considers active (default pilot)
 * @param {(repoRoot:string)=>(string|null)} [detectRepoBranch]  injected branch detector
 * @returns {Promise<{
 *   verdict: 'pass' | 'fail' | 'skipped-non-pilot-branch' | 'skipped-no-grace' | 'skipped-no-repo',
 *   branch: string | null,
 *   ranAt: string,
 *   checks: {
 *     standard: { status: string, summary: string, output: string },
 *     autonomous: { status: string, summary: string, output: string },
 *     pythonXml: { status: string, summary: string, output: string },
 *   },
 * }>}
 */
export async function runGraceGate(repoRoot, pilotBranch = GRACE_PILOT_BRANCH, detectRepoBranch = defaultDetectRepoBranch) {
  const ranAt = new Date().toISOString();

  // Repo presence check first — the rest of the gates don't make sense
  // if the repo directory isn't there.
  if (!repoRoot || !fsSync.existsSync(repoRoot)) {
    return {
      verdict: 'skipped-no-repo',
      branch: null,
      ranAt,
      checks: {
        standard: { status: 'skipped', summary: 'repo path not found', output: '' },
        autonomous: { status: 'skipped', summary: 'repo path not found', output: '' },
        pythonXml: { status: 'skipped', summary: 'repo path not found', output: '' },
      },
    };
  }

  const branch = detectRepoBranch(repoRoot);
  if (branch !== pilotBranch) {
    return {
      verdict: 'skipped-non-pilot-branch',
      branch,
      ranAt,
      checks: {
        standard: { status: 'skipped', summary: `branch is ${branch ?? 'unknown'}, no GRACE governance`, output: '' },
        autonomous: { status: 'skipped', summary: `branch is ${branch ?? 'unknown'}, no GRACE governance`, output: '' },
        pythonXml: { status: 'skipped', summary: `branch is ${branch ?? 'unknown'}, no GRACE governance`, output: '' },
      },
    };
  }

  const standard = runGraceLintOnce('standard', repoRoot);
  const autonomous = runGraceLintOnce('autonomous', repoRoot);
  const pythonXml = runPythonXmlGate(repoRoot);

  // Grace CLI missing → graceful degrade (skip, don't fail).
  const graceUnavailable =
    (standard.status === 'error' && /not found|spawn/i.test(standard.summary)) ||
    (autonomous.status === 'error' && /not found|spawn/i.test(autonomous.summary));

  if (graceUnavailable) {
    return {
      verdict: 'skipped-no-grace',
      branch,
      ranAt,
      checks: {
        standard: { ...standard, status: 'skipped', summary: 'grace CLI unavailable: ' + standard.summary },
        autonomous: { ...autonomous, status: 'skipped', summary: 'grace CLI unavailable: ' + autonomous.summary },
        pythonXml,
      },
    };
  }

  const allPass =
    standard.status === 'pass' &&
    autonomous.status === 'pass' &&
    pythonXml.status === 'pass';

  return {
    verdict: allPass ? 'pass' : 'fail',
    branch,
    ranAt,
    checks: { standard, autonomous, pythonXml },
  };
}

/**
 * Fallback branch detector used when the caller does not inject one. Mirrors
 * context-builder's `detectRepoBranch` (kept here so grace.mjs has ZERO
 * import from context-builder). Returns null on any failure.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
function defaultDetectRepoBranch(repoRoot) {
  if (!repoRoot) return null;
  try {
    const out = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (out.status !== 0) return null;
    const branch = String(out.stdout ?? '').trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Render a compact gate result into the markdown block used in
 * handoff.md. Keeps long output lines out — the full output is in
 * state.graceGate.checks.*.output for post-mortem inspection.
 *
 * @param {Awaited<ReturnType<typeof runGraceGate>>} gate
 * @returns {string}
 */
export function formatGraceGateMarkdown(gate) {
  if (!gate) return '';

  const statusLabel = (c) => {
    switch (c.status) {
      case 'pass': return c.summary;
      case 'fail': return `FAILED: ${c.summary}`;
      case 'skipped': return `SKIPPED (${c.summary})`;
      case 'error': return `ERROR: ${c.summary}`;
      default: return c.status;
    }
  };

  const verdictLabel = (() => {
    switch (gate.verdict) {
      case 'pass': return 'PASS';
      case 'fail': return 'FAIL';
      case 'skipped-non-pilot-branch': return 'SKIPPED (non-pilot branch)';
      case 'skipped-no-grace': return 'SKIPPED (grace CLI unavailable)';
      case 'skipped-no-repo': return 'SKIPPED (repo path not found)';
      default: return gate.verdict;
    }
  })();

  const lines = [
    '## GRACE Gates',
    '',
    `- grace lint --profile standard: ${statusLabel(gate.checks.standard)}`,
    `- grace lint --profile autonomous: ${statusLabel(gate.checks.autonomous)}`,
    `- python ET.parse (4 XMLs): ${statusLabel(gate.checks.pythonXml)}`,
    `- Branch at gate-time: ${gate.branch ?? 'unknown'}`,
    `- Gate verdict: ${verdictLabel}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Print the gate result to stdout/stderr in a human-readable form.
 * Used by `taskctl grace-gate` and as the stderr message when a gate
 * blocks stage advancement in `run --finalize`.
 */
export function printGraceGateReport(gate, { stream = 'stdout' } = {}) {
  const w = stream === 'stderr' ? process.stderr : process.stdout;
  const md = formatGraceGateMarkdown(gate);
  w.write(md + '\n');

  // If any check failed, print a tail of its raw output to help the user
  // debug without having to open state.json.
  if (gate.verdict === 'fail') {
    for (const [name, c] of Object.entries(gate.checks)) {
      if (c.status === 'fail' || c.status === 'error') {
        w.write(`--- ${name} output (tail) ---\n`);
        const tail = (c.output ?? '').split('\n').slice(-20).join('\n');
        w.write(tail + '\n');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GRACE context block (read-path) — formats a supplied repoRoot + moduleIds
// ---------------------------------------------------------------------------

/**
 * Builds the GRACE context block to inject into plan/run prompts when a task
 * touches governed-module paths on the pilot branch.
 *
 * Signature: `buildGraceContextBlock(repoRoot, moduleIds)` where `moduleIds`
 * is an iterable of M-IDs relevant to the task. The block lists each provided
 * M-ID and references the standard GRACE artifacts (development-plan,
 * knowledge-graph, verification-plan, operational-packets, GRACE-PILOT.md).
 *
 * This function only FORMATS the supplied `repoRoot` + `moduleIds`; it does
 * NOT call any governed-path parser (that work lives in
 * context-builder.buildContextMd, which computes the IDs and passes them in).
 * Hence grace.mjs imports nothing from context-builder.
 *
 * @param {string} repoRoot   Absolute path to the repo root (used in path hints).
 * @param {Iterable<string>} [moduleIds]  Collection of M-IDs to surface.
 *                              If omitted or empty, falls back to the pilot
 *                              M-ID set.
 * @returns {string}  Markdown string ready to append to a prompt.
 */
export function buildGraceContextBlock(repoRoot, moduleIds) {
  const base = repoRoot
    ? String(repoRoot).replace(/\\/g, '/').replace(/\/$/, '')
    : '.';

  const ids = Array.from(moduleIds ?? []).filter(Boolean);
  const effectiveIds = ids.length > 0 ? Array.from(new Set(ids)) : Array.from(PILOT_MODULE_IDS);
  effectiveIds.sort();

  const moduleBullets = effectiveIds.map((id) => `   - \`${id}\``);

  const lines = [
    '',
    '## GRACE Context (auto-injected — governed paths detected, Core-aware mode active)',
    '',
    `This task touches governed modules. Before planning or executing, consult the GRACE artifacts for each module listed below.`,
    '',
    '**Modules in scope for this task:**',
    ...moduleBullets,
    '',
    `1. **Module contract(s)** → \`${base}/docs/development-plan.xml\``,
    '   For each listed M-ID, find the matching `<M-...>` element and read its `<contract>`, `<dependencies>`, `<target>`, and `<observability>` sections.',
    '',
    `2. **Knowledge graph** → \`${base}/docs/knowledge-graph.xml\``,
    '   Find the matching `<module>` entries to understand relationships (CrossLinks, dependents) and current STATUS.',
    '',
    `3. **Verification entries** → \`${base}/docs/verification-plan.xml\``,
    '   Find the `<V-M-*>` entries for each listed module to know required log markers and test cases.',
    '',
    `4. **Execution packet templates** → \`${base}/docs/operational-packets.xml\``,
    '   Use `ExecutionPacketTemplate` for the `<write-scope>` (files you may modify) and checkpoint checklist.',
    '',
    `5. **GRACE rules reminder** → \`${base}/docs/GRACE-PILOT.md\``,
    '   Review the working conventions for Core-aware CP-tasks (write-scope discipline, markup expectations, lint gates).',
    '',
    '**Required before handoff**: run `grace lint --path .` from the repo root — standard profile must be 0 errors.',
    'Record the result in the handoff `grace lint status` field.',
    '',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GRACE prompt hint (write-path planning acuity) — deferred (read-only) style
// ---------------------------------------------------------------------------

/**
 * Build the GRACE-pilot hint appended to prompt preambles. Only produces
 * output when ALL of the following hold:
 *   1. the repo we detect from is on `pilotBranch`;
 *   2. a taskDir is provided and contains a readable context.md;
 *   3. that context.md contains the auto-injected `## GRACE Context` section
 *      (meaning the task touches at least one governed module).
 * Returns an empty string otherwise — which keeps non-pilot and non-governed
 * tasks silent.
 *
 * Mode (WP2 Stage 2a): collapsed to the DEFERRED (read-only) style. GRACE
 * context is injected for planning/review acuity (M-IDs, contract excerpts,
 * CrossLink awareness), but the plan is NOT asked to include GRACE governance
 * tasks. Markup + XML updates are batched during a later `taskctl sync-grace`
 * pass. The former 'full' mode and its mode argument are removed.
 *
 * @param {string} repoPath
 * @param {string} taskDir
 * @param {string} [pilotBranch]  branch GRACE considers active (default pilot)
 * @param {(repoRoot:string)=>(string|null)} [detectRepoBranch]  injected branch detector
 * @returns {string}
 */
export function buildGracePromptHint(repoPath, taskDir, pilotBranch = GRACE_PILOT_BRANCH, detectRepoBranch = defaultDetectRepoBranch) {
  let branch;
  try { branch = detectRepoBranch(repoPath); } catch { return ''; }
  if (branch !== pilotBranch) return '';

  let contextMd;
  try { contextMd = fsSync.readFileSync(path.join(taskDir, 'context.md'), 'utf8'); }
  catch { return ''; }

  // Extract the `## GRACE Context` section (runs to next `##` or EOF).
  const sectionMatch = contextMd.match(/##\s+GRACE Context[\s\S]*?(?=\n##\s|$)/);
  if (!sectionMatch) return '';

  // Pull the M-IDs already listed in that section (context-builder
  // formats them as backticked identifiers).
  const moduleIds = [...new Set(
    [...sectionMatch[0].matchAll(/`(M-[A-Z0-9-]+)`/g)].map((m) => m[1]),
  )];
  if (moduleIds.length === 0) return '';

  const R = repoPath.replace(/\\/g, '/');
  const idListMd = moduleIds.map((id) => `\`${id}\``).join(', ');

  return [
    '## 📖 GRACE Context (Deferred Mode — planning-only, no governance tasks in plan)',
    '',
    `Repo branch **\`${pilotBranch}\`** — Core-aware mode. This task touches governed modules: ${idListMd}.`,
    '',
    'This task will be implemented on a feature branch cut from the integration branch (no MODULE_CONTRACT headers exist there). Use GRACE artefacts for **planning acuity** — contract awareness, cross-module impact, dependency mapping — but do NOT include markup/XML tasks in the plan.',
    '',
    '**Read for context (not for markup updates):**',
    '',
    `1. \`${R}/docs/development-plan.xml\` → \`<M-...>\` → \`<contract>\`, \`<interface>\`, \`<depends>\`. Use to understand module boundaries and existing contracts.`,
    `2. \`${R}/docs/knowledge-graph.xml\` → \`<CrossLink>\` entries referencing the M-IDs. Use to understand blast radius.`,
    `3. \`${R}/docs/verification-plan.xml\` → \`<V-M-...>\` scenarios + required log markers. Use to plan tests that match existing observability style.`,
    `4. \`${R}/docs/GRACE-PILOT.md\` for working conventions.`,
    '',
    '**Planning rules (DEFERRED GRACE mode):**',
    '- The plan MUST NOT include these task types: XML artefact updates (`development-plan.xml`, `knowledge-graph.xml`, `verification-plan.xml`), `MODULE_CONTRACT` VERSION/DEPENDS/MAP/CHANGE_SUMMARY bumps, new `START_BLOCK_*` markers, `grace lint --profile autonomous` gate.',
    '- The plan MUST include: business/code tasks, tests, manual verification. Exactly as for a non-GRACE project.',
    '- Tests, log markers, and observability should follow the **style** established by M-ID modules referenced above (e.g., if a module uses `[ModuleName][funcName][BLOCK_*]` markers, new logs should match that format) — but the plan does not enumerate markers as explicit tasks.',
    '- If the change introduces **new modules** or **changes existing contracts** (new dependencies, new exports), add a plan section `## Proposed Contract Changes (deferred)` — human-readable description of what will be applied to XML during the next `taskctl sync-grace` batch. Do NOT apply to XML in this task.',
    '- Implementation will happen on a feature branch from the integration branch. `grace lint` is suppressed there (not on pilot). Batch markup/XML updates happen in the next `sync-grace` on the pilot branch.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// sync-grace pipeline (pure git/string logic; deps injected)
//
// The sync helpers receive a `deps` object carrying:
//   { runGit, loadGovernedModules, isGovernedPath, pilotBranch, upstreamBranch }
// so this module never imports `runGit` from cli.mjs nor the governed-path
// helpers from context-builder. `cmdSyncGrace` (the cli.mjs adapter) builds
// `deps` from `rcfg.grace.{pilotBranch,upstreamBranch,repoRoot}` and passes it
// down through the whole pipeline (C3 branch threading — no hardcoded
// origin/dev or experiment/grace-pilot remains).
// ---------------------------------------------------------------------------

/**
 * Hard cap on rebase-continue iterations. If an auto-resolve + continue loop
 * runs more than this many times without completing the rebase, we abort to
 * avoid a runaway pathological case.
 */
export const SYNC_GRACE_MAX_ITERATIONS = 5;

/**
 * Returns true if the repo has a rebase in progress.
 */
export function isRebaseInProgress(repoPath) {
  const gitDir = path.join(repoPath, '.git');
  try {
    if (fsSync.existsSync(path.join(gitDir, 'rebase-apply'))) return true;
    if (fsSync.existsSync(path.join(gitDir, 'rebase-merge'))) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * Parse conflicting paths from `git diff --name-only --diff-filter=U`.
 * Returns an array of forward-slash-normalized repo-relative paths.
 */
export function detectUnmergedPaths(repoPath, deps) {
  const res = deps.runGit(['diff', '--name-only', '--diff-filter=U'], repoPath);
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\\/g, '/'));
}

/**
 * Classify a list of conflicting paths into governed (with M-ID) and
 * non-governed buckets, using the XML-driven governed map.
 */
export function classifyConflictingPaths(paths, repoPath, deps) {
  const map = deps.loadGovernedModules(repoPath);
  const governed = [];
  const nongoverned = [];
  for (const p of paths) {
    const moduleId = deps.isGovernedPath(p, map);
    if (moduleId) governed.push({ path: p, moduleId });
    else nongoverned.push(p);
  }
  return { governed, nongoverned };
}

/**
 * Dry-run conflict prediction using `git merge-tree`.
 *
 * @returns {string[]}  List of repo-relative paths predicted to conflict.
 */
export function predictConflicts(repoPath, deps) {
  const upstream = `origin/${deps.upstreamBranch}`;
  // Try modern (git ≥2.38) form first: emits a NUL-separated conflict
  // report on stderr / stdout. When it succeeds with exit 0 and empty
  // output, the merge would be clean.
  const modern = deps.runGit(
    ['merge-tree', '--name-only', '-z', 'HEAD', upstream],
    repoPath,
  );
  if (modern.status === 0 && modern.stdout.trim()) {
    // First NUL-separated token is the tree OID; remaining are paths.
    const parts = modern.stdout.split('\0').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts.slice(1).map((p) => p.replace(/\\/g, '/'));
    }
    return [];
  }

  // Fallback: legacy `git merge-tree <base> <branch1> <branch2>` form.
  const base = deps.runGit(['merge-base', 'HEAD', upstream], repoPath);
  if (base.status !== 0) return [];
  const baseSha = base.stdout.trim();
  if (!baseSha) return [];

  const legacy = deps.runGit(
    ['merge-tree', baseSha, 'HEAD', upstream],
    repoPath,
  );
  if (!legacy.stdout) return [];

  const paths = new Set();
  for (const line of legacy.stdout.split(/\r?\n/)) {
    // Lines like: `changed in both` followed by `  our   100644 <sha> path/to/file`
    const m = line.match(/^\s+(?:our|their|base)\s+\d+\s+[0-9a-f]+\s+(.+)$/);
    if (m) paths.add(m[1].trim().replace(/\\/g, '/'));
  }
  return Array.from(paths);
}

/**
 * List the N new commits from `origin/<upstream>` that pilot does not yet
 * have. Returns an array of `{ sha, subject }` objects for reporting.
 */
export function listIncomingDevCommits(repoPath, deps) {
  const res = deps.runGit(
    ['log', '--pretty=format:%h\t%s', `${deps.pilotBranch}..origin/${deps.upstreamBranch}`],
    repoPath,
  );
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('\t');
      if (idx === -1) return { sha: line, subject: '' };
      return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
    });
}

/**
 * Print the human-readable conflict report.
 */
export function printConflictReport(classified) {
  const { governed, nongoverned } = classified;
  console.log('');
  console.log(`Rebase conflicts detected: ${governed.length + nongoverned.length} file(s).`);
  console.log(`  Governed (markup-aware): ${governed.length}`);
  console.log(`  Non-governed (standard): ${nongoverned.length}`);
  console.log('');

  if (governed.length > 0) {
    console.log('Governed files — preserve MODULE_CONTRACT + START_BLOCK_* markers,');
    console.log('apply dev-side logic changes (see ai/rules/auto-markup-workflow.md §Scenario F):');
    for (const { path: p, moduleId } of governed) {
      console.log(`  [${moduleId}] ${p}`);
    }
    console.log('');
  }

  if (nongoverned.length > 0) {
    console.log('Non-governed files — standard git conflict resolution:');
    for (const p of nongoverned) {
      console.log(`  ${p}`);
    }
    console.log('');
  }

  console.log('Next steps:');
  console.log('  1. Resolve conflicts manually in each file listed above.');
  console.log('     - Governed files: keep pilot markup (MODULE_CONTRACT, START_BLOCK_*) +');
  console.log('       apply dev logic changes on top. See auto-markup-workflow.md §Scenario F.');
  console.log('     - Non-governed files: standard 3-way merge.');
  console.log('  2. Stage resolutions:  git add <files>');
  console.log('  3. Continue:           taskctl sync-grace --continue');
  console.log('  4. Or abort entirely:  taskctl sync-grace --abort');
  console.log('');
}

// ── Layer 1: text-level auto-resolve ──────────────────────────────────────

/**
 * Regex fragments for markup markers — any one of these in a line means the
 * line participates in GRACE governance and must be preserved when merging
 * pilot (HEAD) content with dev-side code changes.
 */
const MARKUP_MARKER_SUBSTRINGS = [
  'MODULE_CONTRACT',
  'START_CONTRACT',
  'END_CONTRACT',
  'START_BLOCK_',
  'END_BLOCK_',
  'MODULE_MAP',
  'END_MODULE_MAP',
  'CHANGE_SUMMARY',
];

function lineHasMarkupMarker(line) {
  for (const s of MARKUP_MARKER_SUBSTRINGS) {
    if (line.includes(s)) return true;
  }
  return false;
}

/**
 * Split a file's text into an array of segments alternating between plain
 * content and conflict hunks.
 */
function parseConflictSegments(text) {
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfTotal = (text.match(/\n/g) ?? []).length;
  const eol = crlfCount > 0 && crlfCount / Math.max(lfTotal, 1) > 0.5 ? '\r\n' : '\n';

  const norm = text.replace(/\r\n/g, '\n');
  const lines = norm.split('\n');

  const segments = [];
  let plainBuf = [];
  let i = 0;

  const flushPlain = () => {
    if (plainBuf.length > 0) {
      segments.push({ kind: 'plain', text: plainBuf.join('\n') });
      plainBuf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      flushPlain();
      const headLabel = line.slice(7).trim();
      const headLines = [];
      const devLines = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('>>>>>>>')) {
        headLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith('=======')) {
        i += 1;
        while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
          devLines.push(lines[i]);
          i += 1;
        }
      }
      let devLabel = '';
      if (i < lines.length && lines[i].startsWith('>>>>>>>')) {
        devLabel = lines[i].slice(7).trim();
        i += 1;
      }
      segments.push({
        kind: 'conflict',
        headLabel,
        devLabel,
        head: headLines,
        dev: devLines,
      });
      continue;
    }
    plainBuf.push(line);
    i += 1;
  }
  flushPlain();

  return { eol, segments };
}

/**
 * Classify a single conflict hunk + suggest a resolution. Does NOT write
 * anything.
 */
function classifyConflictHunk(hunk) {
  const { head, dev } = hunk;
  const headHasMarkup = head.some(lineHasMarkupMarker);
  const devHasMarkup = dev.some(lineHasMarkupMarker);

  if (!headHasMarkup) {
    return {
      classification: 'non-markup',
      confidence: 'low',
      resolvedLines: null,
      note: 'no markup markers on HEAD side — fall back to standard merge',
    };
  }

  if (devHasMarkup) {
    return {
      classification: 'dev-also-marked',
      confidence: 'low',
      resolvedLines: null,
      note: 'both sides contain markup — requires human/agent judgement',
    };
  }

  // HEAD has markup, dev has none.
  const devCodeLines = dev.filter((l) => l.trim().length > 0);

  if (devCodeLines.length === 0) {
    return {
      classification: 'pure-header',
      confidence: 'high',
      resolvedLines: head.slice(),
      note: 'HEAD adds markup only; dev untouched — keep HEAD',
    };
  }

  const headBody = head.filter((l) => !lineHasMarkupMarker(l));
  const headBodyCode = headBody.filter((l) => l.trim().length > 0);

  const markerLines = head.filter(lineHasMarkupMarker);
  const multiBlockHead = markerLines.filter((l) => l.includes('START_BLOCK_') || l.includes('END_BLOCK_')).length > 4;

  if (headBodyCode.length === 0) {
    return {
      classification: 'new-function',
      confidence: 'low',
      resolvedLines: null,
      note: 'HEAD has only markers (no body) while dev has new code — agent required to re-anchor markers',
    };
  }

  if (multiBlockHead) {
    return {
      classification: 'new-function',
      confidence: 'low',
      resolvedLines: null,
      note: 'HEAD contains multiple START_BLOCK_*/END_BLOCK_* pairs — agent required to correctly place dev body within blocks',
    };
  }

  if (devCodeLines.length > 5 && devCodeLines.length > headBodyCode.length * 2) {
    return {
      classification: 'new-function',
      confidence: 'low',
      resolvedLines: null,
      note: 'dev added substantially more code than HEAD body — likely new function needing markup',
    };
  }

  const merged = [];
  let replaced = false;
  let inBody = false;
  for (const line of head) {
    if (lineHasMarkupMarker(line)) {
      if (inBody) inBody = false;
      merged.push(line);
      continue;
    }
    if (!replaced) {
      for (const devLine of dev) merged.push(devLine);
      replaced = true;
      inBody = true;
      continue;
    }
    if (inBody) continue;
    merged.push(line);
  }
  if (!replaced) {
    for (const devLine of dev) merged.push(devLine);
  }

  const sizeRatio = devCodeLines.length / Math.max(headBodyCode.length, 1);
  const confidence = sizeRatio >= 0.5 && sizeRatio <= 2 ? 'high' : 'medium';

  return {
    classification: 'body-with-markers',
    confidence,
    resolvedLines: merged,
    note: `merged HEAD markup (${markerLines.length} marker line(s)) with dev body (${devCodeLines.length} code line(s))`,
  };
}

/**
 * Read a conflicted file, parse its hunks, apply the keep-both heuristic on
 * each, and write back when ALL hunks resolve at 'high' or 'medium'
 * confidence.
 */
export async function autoResolveTextMarkupConflict(absPath) {
  let text;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    return {
      resolved: false,
      confidence: 'low',
      hunks: [],
      note: `read failed: ${err.message}`,
    };
  }

  const { eol, segments } = parseConflictSegments(text);
  const conflictHunks = segments.filter((s) => s.kind === 'conflict');

  if (conflictHunks.length === 0) {
    return {
      resolved: false,
      confidence: 'low',
      hunks: [],
      note: 'no conflict markers found in file',
    };
  }

  const classified = conflictHunks.map((h) => ({
    ...classifyConflictHunk(h),
    headLabel: h.headLabel,
    devLabel: h.devLabel,
  }));

  const worst = classified.reduce((acc, c) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[c.confidence] > rank[acc] ? c.confidence : acc;
  }, 'high');

  if (worst === 'low') {
    return {
      resolved: false,
      confidence: 'low',
      hunks: classified,
      note: `at least one hunk is low-confidence (${classified.filter((c) => c.confidence === 'low').length} of ${classified.length})`,
    };
  }

  const out = [];
  let hunkIdx = 0;
  for (const seg of segments) {
    if (seg.kind === 'plain') {
      out.push(seg.text);
      continue;
    }
    const resolved = classified[hunkIdx];
    hunkIdx += 1;
    if (!resolved || !resolved.resolvedLines) {
      out.push(
        [
          `<<<<<<< ${seg.headLabel}`,
          ...seg.head,
          '=======',
          ...seg.dev,
          `>>>>>>> ${seg.devLabel}`,
        ].join('\n'),
      );
      continue;
    }
    out.push(resolved.resolvedLines.join('\n'));
  }

  const merged = out.join('\n');
  const finalText = eol === '\r\n' ? merged.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : merged;

  await fs.writeFile(absPath, finalText, 'utf8');

  return {
    resolved: true,
    confidence: worst,
    hunks: classified,
    note: `resolved ${classified.length} hunk(s); confidence=${worst}`,
  };
}

// ── Layer 2: markup-agent prompt generator ────────────────────────────────

/**
 * Build a per-file section describing the conflict hunks, classifications,
 * and suggested resolutions for the markup-agent to consume.
 */
function buildMarkupAgentFileSection(entry, analysis, absPath) {
  const lines = [];
  const label = entry.moduleId ? `[${entry.moduleId}] ${entry.path}` : entry.path;
  lines.push(`### ${label}`);
  lines.push('');
  lines.push(`- Absolute path: \`${absPath.replace(/\\/g, '/')}\``);
  lines.push(`- Module: ${entry.moduleId ?? '(non-governed — probably no markup needed)'}`);
  if (analysis) {
    lines.push(`- Overall confidence: **${analysis.confidence}**`);
    lines.push(`- Hunks parsed: ${analysis.hunks.length}`);
    lines.push(`- Analysis note: ${analysis.note}`);
  } else {
    lines.push('- (file not yet analysed — dev-added new file in governed directory)');
  }
  lines.push('');
  if (analysis && analysis.hunks.length > 0) {
    analysis.hunks.forEach((h, idx) => {
      lines.push(`#### Hunk ${idx + 1}`);
      lines.push('');
      lines.push(`- Classification: \`${h.classification}\``);
      lines.push(`- Confidence: \`${h.confidence}\``);
      lines.push(`- Suggestion: ${h.note}`);
      lines.push('');
    });
  }
  return lines.join('\n');
}

/**
 * Write a markup-agent dispatch prompt file listing all conflicts that
 * couldn't be auto-resolved plus any new dev-added governed files.
 *
 * @param {object} params
 * @param {Array<{path:string, moduleId:string|null, analysis?:any}>} params.conflictsForAgent
 * @param {Array<{path:string, moduleId:string|null, reason:string}>} params.newGovernedFiles
 * @param {string} params.repoPath
 * @param {string} params.promptPath  absolute path to write the prompt to (injected by adapter)
 * @returns {Promise<string>}  Absolute path to the prompt file.
 */
export async function writeMarkupAgentPrompt({ conflictsForAgent, newGovernedFiles, repoPath, promptPath }) {
  const dir = path.dirname(promptPath);
  await fs.mkdir(dir, { recursive: true });

  const repo = repoPath.replace(/\\/g, '/');
  const ts = new Date().toISOString();

  const lines = [];
  lines.push('# Markup-agent dispatch prompt — sync-grace auto-resolve');
  lines.push('');
  lines.push(`Generated: ${ts}`);
  lines.push(`Repo: \`${repo}\``);
  lines.push('');
  lines.push('## Mission');
  lines.push('');
  lines.push('`taskctl sync-grace` attempted automatic markup-conflict resolution but some files need human-level judgement. You (opus agent) will:');
  lines.push('');
  lines.push('1. Read `ai/rules/auto-markup-workflow.md` §Scenario F (post-merge sync).');
  lines.push('2. For each file below, open it in the repo and either:');
  lines.push('   - Resolve the remaining git conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) preserving MODULE_CONTRACT + START_BLOCK_* markers and merging dev logic underneath, OR');
  lines.push('   - Add initial MODULE_CONTRACT / MODULE_MAP / START_CONTRACT / START_BLOCK_* markup following `ai/proposals/grace-pilot/markup-playbook.md` for new governed files dev added.');
  lines.push('3. After each file, verify `grace lint --profile autonomous --path ' + repo + '` passes.');
  lines.push('4. Update `docs/development-plan.xml`, `docs/knowledge-graph.xml`, `docs/verification-plan.xml` for any new exports / blocks / markers added (cascade per workflow).');
  lines.push('5. Do NOT `git add` or `git commit`. Leave staging to `taskctl sync-grace --continue`.');
  lines.push('');
  lines.push('## Files with unresolved conflicts');
  lines.push('');
  if (conflictsForAgent.length === 0) {
    lines.push('_(none — all conflicts resolved automatically)_');
    lines.push('');
  } else {
    for (const c of conflictsForAgent) {
      const abs = path.join(repoPath, c.path).replace(/\\/g, '/');
      lines.push(buildMarkupAgentFileSection(c, c.analysis ?? null, abs));
      lines.push('');
    }
  }

  lines.push('## Dev-added files in governed directories');
  lines.push('');
  if (newGovernedFiles.length === 0) {
    lines.push('_(none detected)_');
    lines.push('');
  } else {
    lines.push('These files arrived from the integration branch without MODULE_CONTRACT. Use the Scenario B classifier in `auto-markup-workflow.md` to decide governed vs skip; for governed files add full markup + XML cascade.');
    lines.push('');
    for (const f of newGovernedFiles) {
      const abs = path.join(repoPath, f.path).replace(/\\/g, '/');
      lines.push(`- **${f.path}** — ${f.moduleId ? `likely ${f.moduleId}` : '(no matching M-*)'} — ${f.reason}`);
      lines.push(`  - Absolute path: \`${abs}\``);
    }
    lines.push('');
  }

  lines.push('## After you finish');
  lines.push('');
  lines.push('1. Verify locally:');
  lines.push('   ```');
  lines.push(`   grace lint --profile standard --path ${repo}`);
  lines.push(`   grace lint --profile autonomous --path ${repo}`);
  lines.push('   ```');
  lines.push('2. Resume the rebase:');
  lines.push('   ```');
  lines.push('   taskctl sync-grace --continue');
  lines.push('   ```');
  lines.push('3. If `--continue` surfaces fresh conflicts, re-run the above loop.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_This file is auto-generated by `taskctl sync-grace`. Safe to delete after `--continue` succeeds._');
  lines.push('');

  await fs.writeFile(promptPath, lines.join('\n'), 'utf8');
  return promptPath;
}

// ── Layer 3: new-file detection in governed directories ───────────────────

/**
 * Detect files added by origin/<upstream> (absent before rebase) that land in
 * GRACE-governed directories.
 *
 * @param {string} repoPath
 * @param {string|null} fromCommit  Pre-rebase HEAD on pilot.
 * @param {object} deps  { runGit, loadGovernedModules, isGovernedPath, upstreamBranch }
 * @returns {Array<{path:string, moduleId:string|null, reason:string}>}
 */
export function detectNewGovernedFiles(repoPath, fromCommit, deps) {
  if (!fromCommit) return [];
  const res = deps.runGit(
    ['diff', '--name-status', '--diff-filter=A', `${fromCommit}..origin/${deps.upstreamBranch}`],
    repoPath,
  );
  if (res.status !== 0 || !res.stdout.trim()) return [];

  const map = deps.loadGovernedModules(repoPath);
  const out = [];
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^A\s+(.+)$/);
    if (!m) continue;
    const p = m[1].trim().replace(/\\/g, '/');

    let moduleId = deps.isGovernedPath(p, map);
    let reason = 'file path matches governed prefix';

    if (!moduleId) {
      const parent = p.split('/').slice(0, -1).join('/') + '/';
      const parentModule = deps.isGovernedPath(parent + 'any.ts', map);
      if (parentModule) {
        moduleId = parentModule;
        reason = `parent directory is governed by ${parentModule}`;
      }
    }

    if (moduleId) {
      out.push({ path: p, moduleId, reason });
    }
  }
  return out;
}

// ── Layer 4: XML cascade detection (report-only) ──────────────────────────

/**
 * Best-effort detection of governed modules that exist in source markup but
 * are absent from the shared XML docs.
 */
export function detectXmlCascadeNeeds(gate) {
  const needs = [];
  if (!gate?.checks?.standard?.output) return needs;
  const raw = gate.checks.standard.output;

  try {
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      const candidate = raw.slice(jsonStart);
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed.issues)) {
        for (const issue of parsed.issues) {
          const msg = String(issue.message ?? issue.msg ?? '');
          if (/missing from (shared )?docs|not in development-plan|module.*not declared/i.test(msg)) {
            const mMatch = msg.match(/(M-[A-Z0-9_-]+)/);
            needs.push({
              moduleId: mMatch ? mMatch[1] : '(unknown)',
              hint: msg,
            });
          }
        }
      }
    }
  } catch {
    /* fall through to text scan */
  }

  for (const line of raw.split(/\r?\n/)) {
    if (/missing from (shared )?docs|not in development-plan/i.test(line)) {
      const mMatch = line.match(/(M-[A-Z0-9_-]+)/);
      const id = mMatch ? mMatch[1] : '(unknown)';
      if (!needs.some((n) => n.moduleId === id)) {
        needs.push({ moduleId: id, hint: line.trim() });
      }
    }
  }

  return needs;
}

// ── Layer 5: auto-resolve + continue orchestration ────────────────────────

/**
 * Attempt to auto-resolve every currently unmerged path using Layer 1.
 */
async function attemptLayer1ResolveAll(unmerged, repoPath, deps) {
  const { governed, nongoverned } = classifyConflictingPaths(unmerged, repoPath, deps);
  const all = [
    ...governed.map((g) => ({ path: g.path, moduleId: g.moduleId })),
    ...nongoverned.map((p) => ({ path: p, moduleId: null })),
  ];

  const resolvedPaths = [];
  const unresolved = [];
  const details = [];
  for (const entry of all) {
    const absPath = path.join(repoPath, entry.path);
    const analysis = await autoResolveTextMarkupConflict(absPath);
    details.push({ ...entry, analysis });
    if (analysis.resolved) {
      resolvedPaths.push(entry.path);
    } else {
      unresolved.push({ ...entry, analysis });
    }
  }
  return { resolvedPaths, unresolved, details };
}

/**
 * Stage the given files and invoke `git rebase --continue`.
 */
function gitAddAndContinue(resolvedPaths, repoPath, deps) {
  if (resolvedPaths.length > 0) {
    const addRes = deps.runGit(['add', '--', ...resolvedPaths], repoPath);
    if (addRes.status !== 0) {
      return {
        status: addRes.status ?? 1,
        stdout: addRes.stdout,
        stderr: addRes.stderr || 'git add failed',
      };
    }
  }
  return deps.runGit(['rebase', '--continue'], repoPath);
}

/**
 * Handle the "no divergence" / clean-rebase finalize path — run the gate,
 * persist state, exit 0 on PASS / SKIP-but-healthy, 1 on FAIL. Also runs
 * Layer 3 + Layer 4 detection.
 *
 * The state-persistence side effects are injected via `deps.writeSyncGraceState`
 * + `deps.stateRelPath` so this module never touches ORCHESTRATION_ROOT.
 *
 * @returns {Promise<number>}  Exit code.
 */
export async function finalizeAfterCleanRebase({
  repoPath,
  fromCommit,
  toCommit,
  divergence,
  verdict,
  resolutionAttempts = null,
  deps,
}) {
  console.log('Running GRACE gate to verify pilot health post-rebase...');
  const gate = await runGraceGate(repoPath, deps.pilotBranch, deps.detectRepoBranch);
  printGraceGateReport(gate, { stream: 'stdout' });

  const gateOk = gate.verdict === 'pass' || String(gate.verdict).startsWith('skipped-');
  const finalVerdict = gateOk ? verdict : 'gate-failed';

  let newGovernedFiles = [];
  try {
    newGovernedFiles = detectNewGovernedFiles(repoPath, fromCommit, deps);
  } catch (err) {
    console.warn(`  ⚠ new-governed-files detection failed: ${err.message}`);
  }
  if (newGovernedFiles.length > 0) {
    console.log('');
    console.log(`Dev-added files in governed directories (${newGovernedFiles.length}):`);
    for (const f of newGovernedFiles) {
      console.log(`  [${f.moduleId}] ${f.path} — ${f.reason}`);
    }
    console.log('  These files need markup — dispatch markup-agent (see ai/rules/auto-markup-workflow.md §Scenario B).');
    console.log('');
  }

  const xmlCascadeNeeds = detectXmlCascadeNeeds(gate);
  if (xmlCascadeNeeds.length > 0) {
    console.log('');
    console.log(`XML cascade needed (${xmlCascadeNeeds.length} module(s) missing from shared docs):`);
    for (const n of xmlCascadeNeeds) {
      console.log(`  - ${n.moduleId}: ${n.hint}`);
    }
    console.log('  Dispatch markup-agent to add missing <M-*> entries in docs/development-plan.xml etc.');
    console.log('');
  }

  await deps.writeSyncGraceState({
    lastRun: new Date().toISOString(),
    fromCommit,
    toCommit,
    verdict: finalVerdict,
    divergenceAtSyncStart: divergence,
    pendingConflicts: [],
    graceGate: gate,
    newGovernedFiles,
    xmlCascadeNeeds,
    ...(resolutionAttempts ? { resolutionAttempts } : {}),
  });

  console.log(`  → persisted to ${deps.stateRelPath}`);
  return gateOk ? 0 : 1;
}

/**
 * Shared handler for "conflicts detected" situations.
 *
 * @returns {Promise<{
 *   outcome: 'needs-agent' | 'resolved-continuing' | 'resolved-done' | 'needs-manual',
 *   promptPath?: string,
 *   nextUnmerged?: string[],
 *   details?: any,
 *   iteration?: number,
 * }>}
 */
async function handleConflictSituation({
  repoPath,
  unmerged,
  fromCommit,
  divergence,
  autoResolve,
  forceAgent,
  iteration,
  attempts,
  deps,
}) {
  const classified = classifyConflictingPaths(unmerged, repoPath, deps);

  if (forceAgent) {
    const conflictsForAgent = [
      ...classified.governed.map((g) => ({ ...g, analysis: null })),
      ...classified.nongoverned.map((p) => ({ path: p, moduleId: null, analysis: null })),
    ];
    const newGovernedFiles = detectNewGovernedFiles(repoPath, fromCommit, deps);
    const promptPath = await writeMarkupAgentPrompt({
      conflictsForAgent,
      newGovernedFiles,
      repoPath,
      promptPath: deps.markupAgentPromptPath,
    });
    printConflictReport(classified);
    console.log(`Force-agent mode: Layer 1 skipped. Agent prompt written to:`);
    console.log(`  ${promptPath.replace(/\\/g, '/')}`);
    console.log('');
    console.log('Dispatch the markup agent with the prompt above, then run:');
    console.log('  taskctl sync-grace --continue');
    console.log('');
    await deps.writeSyncGraceState({
      lastRun: new Date().toISOString(),
      fromCommit,
      toCommit: null,
      verdict: 'needs-agent',
      divergenceAtSyncStart: divergence,
      pendingConflicts: [
        ...classified.governed.map(({ path: p, moduleId }) => ({ path: p, moduleId })),
        ...classified.nongoverned.map((p) => ({ path: p, moduleId: null })),
      ],
      markupAgentPromptPath: promptPath.replace(/\\/g, '/'),
      resolutionAttempts: attempts,
    });
    return { outcome: 'needs-agent', promptPath };
  }

  if (!autoResolve) {
    printConflictReport(classified);
    await deps.writeSyncGraceState({
      lastRun: new Date().toISOString(),
      fromCommit,
      toCommit: null,
      verdict: 'conflicts',
      divergenceAtSyncStart: divergence,
      pendingConflicts: [
        ...classified.governed.map(({ path: p, moduleId }) => ({ path: p, moduleId })),
        ...classified.nongoverned.map((p) => ({ path: p, moduleId: null })),
      ],
      resolutionAttempts: attempts,
    });
    return { outcome: 'needs-manual' };
  }

  console.log('');
  console.log(`Iteration ${iteration}: auto-resolving ${unmerged.length} conflict(s) via Layer 1...`);
  const { resolvedPaths, unresolved, details } = await attemptLayer1ResolveAll(unmerged, repoPath, deps);

  attempts.push({
    iteration,
    filesAttempted: unmerged.length,
    resolvedCount: resolvedPaths.length,
    failedCount: unresolved.length,
    resolvedPaths: resolvedPaths.slice(),
    unresolvedPaths: unresolved.map((u) => u.path),
  });

  for (const d of details) {
    const label = d.moduleId ? `[${d.moduleId}]` : '(non-governed)';
    const verdict = d.analysis.resolved
      ? `RESOLVED (${d.analysis.confidence})`
      : `SKIPPED (${d.analysis.confidence})`;
    console.log(`  ${verdict} ${label} ${d.path} — ${d.analysis.note}`);
  }

  if (unresolved.length > 0) {
    const newGovernedFiles = detectNewGovernedFiles(repoPath, fromCommit, deps);
    const promptPath = await writeMarkupAgentPrompt({
      conflictsForAgent: unresolved,
      newGovernedFiles,
      repoPath,
      promptPath: deps.markupAgentPromptPath,
    });
    console.log('');
    console.log(`Layer 1 resolved ${resolvedPaths.length}/${unmerged.length} file(s); ${unresolved.length} need the markup-agent.`);
    console.log(`Markup-agent prompt: ${promptPath.replace(/\\/g, '/')}`);
    console.log('');
    console.log('Next:');
    console.log('  1. Dispatch the markup agent with the prompt file above.');
    console.log('  2. After the agent finishes: taskctl sync-grace --continue');
    console.log('');
    await deps.writeSyncGraceState({
      lastRun: new Date().toISOString(),
      fromCommit,
      toCommit: null,
      verdict: 'needs-agent',
      divergenceAtSyncStart: divergence,
      pendingConflicts: unresolved.map(({ path: p, moduleId }) => ({ path: p, moduleId })),
      markupAgentPromptPath: promptPath.replace(/\\/g, '/'),
      resolutionAttempts: attempts,
    });
    return { outcome: 'needs-agent', promptPath, details };
  }

  console.log('');
  console.log(`Iteration ${iteration}: all ${resolvedPaths.length} conflict(s) resolved. Staging and continuing rebase...`);
  const contRes = gitAddAndContinue(resolvedPaths, repoPath, deps);

  if (contRes.status === 0) {
    return { outcome: 'resolved-done', details };
  }

  const nextUnmerged = detectUnmergedPaths(repoPath, deps);
  if (nextUnmerged.length === 0) {
    console.error('sync-grace: git rebase --continue failed without unmerged paths after auto-resolve.');
    if (contRes.stderr) console.error(contRes.stderr.trim());
    await deps.writeSyncGraceState({
      lastRun: new Date().toISOString(),
      fromCommit,
      toCommit: null,
      verdict: 'gate-failed',
      divergenceAtSyncStart: divergence,
      pendingConflicts: [],
      resolutionAttempts: attempts,
    });
    return { outcome: 'needs-manual' };
  }
  return { outcome: 'resolved-continuing', nextUnmerged, details };
}

/**
 * Run the Layer 5 loop: on each iteration, try to auto-resolve all
 * currently-unmerged files and continue the rebase.
 *
 * @returns {Promise<number>}  Exit code.
 */
export async function runAutoResolveLoop({
  repoPath,
  initialUnmerged,
  fromCommit,
  divergence,
  autoResolve,
  forceAgent,
  deps,
}) {
  const attempts = [];
  let unmerged = initialUnmerged;
  let iteration = 1;

  while (iteration <= SYNC_GRACE_MAX_ITERATIONS) {
    const result = await handleConflictSituation({
      repoPath,
      unmerged,
      fromCommit,
      divergence,
      autoResolve,
      forceAgent,
      iteration,
      attempts,
      deps,
    });

    if (result.outcome === 'needs-manual') return 1;
    if (result.outcome === 'needs-agent') return 1;
    if (result.outcome === 'resolved-done') {
      const headAfter = deps.runGit(['rev-parse', 'HEAD'], repoPath).stdout.trim();
      console.log('');
      console.log(`Rebase completed via auto-resolve. HEAD = ${headAfter.slice(0, 7)}.`);
      return await finalizeAfterCleanRebase({
        repoPath,
        fromCommit,
        toCommit: headAfter,
        divergence,
        verdict: 'clean',
        resolutionAttempts: attempts,
        deps,
      });
    }
    unmerged = result.nextUnmerged;
    iteration += 1;
  }

  console.error(`sync-grace: auto-resolve hit max iterations (${SYNC_GRACE_MAX_ITERATIONS}).`);
  console.error('  Aborting rebase to avoid runaway loop. Inspect the repo manually.');
  console.error('  Run: taskctl sync-grace --abort (to reset) or resolve remaining conflicts by hand.');
  await deps.writeSyncGraceState({
    lastRun: new Date().toISOString(),
    fromCommit,
    toCommit: null,
    verdict: 'max-iterations-exceeded',
    divergenceAtSyncStart: divergence,
    pendingConflicts: unmerged.map((p) => ({ path: p, moduleId: null })),
    resolutionAttempts: attempts,
  });
  return 1;
}
