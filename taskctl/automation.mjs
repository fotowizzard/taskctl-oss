/**
 * automation.mjs — Automation layer for taskctl (Levels 1-3)
 *
 * Level 1: do <stage> CP-XXX     — single command: prepare + AI + finalize
 * Level 2: flow CP-XXX           — chain stages with feedback loops
 * Level 3: autopilot CP-XXX      — full cycle: sync → flow → publish
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getEngine, assertEngineRegistered } from './engines.mjs';

// ── Stage Configuration ──────────────────────────────────────────────────

const STAGE_CONFIG = {
  plan:          { defaultEngine: 'claude', promptFile: '.prompt-plan.md',         finalizeCmd: 'plan',        interactive: false },
  'plan-cc':     { defaultEngine: 'claude', promptFile: '.prompt-plan.md',         finalizeCmd: 'plan',        interactive: true  },
  'plan-cc-auto':{ defaultEngine: 'claude', promptFile: '.prompt-plan.md',         finalizeCmd: 'plan',        interactive: false },
  'plan-review': { defaultEngine: 'codex',  promptFile: '.prompt-review.md',       finalizeCmd: 'plan-review', interactive: false },
  run:           { defaultEngine: 'claude', promptFile: '.prompt-run.md',          finalizeCmd: 'run',         interactive: false },
  review:        { defaultEngine: 'codex',  promptFile: '.prompt-review-final.md', finalizeCmd: 'review',      interactive: false },
  revise:        { defaultEngine: 'claude', promptFile: '.prompt-revise.md',       finalizeCmd: 'revise',      interactive: false },
  fix:           { defaultEngine: 'claude', promptFile: '.prompt-fix.md',          finalizeCmd: 'fix',         interactive: false },
};

const FLOW_STAGES = ['plan', 'plan-review', 'run', 'review'];
const MAX_LOOP_ITERATIONS = 3;

// Which engine ROLE each stage launches under. plan-review/review are reviewer
// stages; everything else (plan, run, fix, revise) is an author/planner stage.
// WP2 Stage 2b (C2): automation derives the actual engine from runtimeConfig by
// role rather than from a hardcoded STAGE_CONFIG.defaultEngine.
const REVIEWER_STAGES = new Set(['plan-review', 'review']);

/**
 * Resolve the configured engine for a stage by its role.
 * reviewer stages → `rcfg.engines.reviewer` (default 'codex');
 * author stages   → `rcfg.engines.planner`  (default 'claude').
 * @param {string} stage  raw stage name (plan / plan-review / run / review / fix / revise / plan-cc...)
 * @param {object|null} rcfg  normalized runtime config
 */
export function engineForStage(stage, rcfg) {
  return REVIEWER_STAGES.has(stage)
    ? (rcfg?.engines?.reviewer ?? 'codex')
    : (rcfg?.engines?.planner ?? 'claude');
}

/**
 * The configured author (planner) and reviewer engines, with defaults. The
 * auto/flip loops and flow feedback loops pair these two roles; flip swaps which
 * role is author vs reviewer each iteration (semantics preserved from the prior
 * hardcoded claude/codex pairing — now sourced from config). WP2 Stage 2b (C2).
 * @param {object|null} rcfg  normalized runtime config
 * @returns {{ author: string, reviewer: string }}
 */
export function rolePair(rcfg) {
  return {
    author: rcfg?.engines?.planner ?? 'claude',
    reviewer: rcfg?.engines?.reviewer ?? 'codex',
  };
}

// ── Spawn AI Helper ──────────────────────────────────────────────────────

/**
 * Spawn an AI CLI tool and wait for it to finish.
 * @returns {Promise<number>} exit code
 */
function spawnAI({ engine, interactive, promptFile, orchRoot, repoPath, cwd, captureTarget, appendSystemPrompt, logFile, reasoningEffort }) {
  const workDir = cwd || repoPath;
  // Resolve the engine adapter (hard-fails with the registered list if unknown).
  // ALL engine-specific argv/stdio/output-session/capture decisions now live in
  // the adapter (engines.mjs); spawnAI keeps only the generic session.log/raw-tee
  // plumbing. The codex reasoning-effort default ('high') is honored inside the
  // adapter's buildSpawn (the configured rcfg.engines.reasoningEffort flows in via
  // reasoningEffort; the old `xhigh` override note still applies).
  const adapter = getEngine(engine);
  const { cmd, args, spawnOptions } = adapter.buildSpawn({
    promptFile, orchRoot, repoPath, cwd: workDir, reasoningEffort, appendSystemPrompt, interactive,
  });

  return new Promise(async (resolve, reject) => {
    // Open session log file (append mode)
    let logStream = null;
    if (logFile) {
      try {
        const fh = await fs.open(logFile, 'a');
        logStream = fh.createWriteStream();
        logStream.write(`\n${'='.repeat(60)}\n`);
        logStream.write(`[${new Date().toISOString()}] Session: ${engine} | ${interactive ? 'interactive' : 'piped'}\n`);
        logStream.write(`Prompt: ${promptFile}\n`);
        logStream.write(`CWD: ${workDir}\n`);
        logStream.write(`${'='.repeat(60)}\n\n`);
      } catch { /* can't open log — continue without it */ }
    }

    const log = (text) => { if (logStream) logStream.write(text); };

    log(`$ ${cmd} ${args.join(' ')}\n\n`);
    console.log(`\n  $ ${cmd} ${args.join(' ')}\n`);

    const pipeStdout = !interactive;
    const child = spawn(cmd, args, {
      ...spawnOptions, // stdio (incl. the per-adapter stdin policy) from the adapter
      cwd: workDir,
      shell: true,
      // Preserve any adapter-provided env (C3) — the fake adapter's
      // TASKCTL_FAKE_SCRIPT_DIR seam lives in spawnOptions.env; the previous
      // unconditional `{ ...process.env }` discarded it, making the scripted-reply
      // path a dead end end-to-end. process.env first so the adapter overrides win.
      env: { ...process.env, ...(spawnOptions.env ?? {}) },
    });

    // Per-SPAWN output session: claude → stream-json line-buffer/formatter;
    // codex/opus → raw-tee accumulator. The session owns parsing/accumulation;
    // spawnAI owns the generic raw-to-log teeing + the [stderr] passthrough.
    const session = pipeStdout ? adapter.createOutputSession() : null;

    if (pipeStdout) {
      child.stdout.on('data', (chunk) => {
        log(chunk.toString()); // raw stdout to the session log (generic)
        session.onChunk(chunk);
      });
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        log(`[stderr] ${chunk.toString()}`);
      });
    }

    child.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
    child.on('close', async (code) => {
      log(`\n[exit] code=${code ?? 0} at ${new Date().toISOString()}\n`);
      if (logStream) { logStream.end(); }

      // Flush the session + let the adapter capture an artifact from the
      // accumulated stdout (codex → extractMarkdown→write; claude/opus → null).
      const captured = session ? session.onClose() : '';
      const written = await adapter.captureArtifact(captured, captureTarget);
      if (written) console.log(`\n  (captured output → ${written})`);
      resolve(code ?? 0);
    });
  });
}

/**
 * Run ONE non-interactive engine step and return its captured stdout. The thin
 * public seam the WP5 new-project flow uses: it writes the prompt FILE itself,
 * then this resolves the 5a adapter (via spawnAI), spawns it in `cwd`, captures
 * the accumulated stdout to a temp artifact, and returns that text. No Jira, no
 * stage machinery — just "run the engine on this prompt file and give me what it
 * printed". The captured artifact path doubles as the adapter's captureTarget so
 * a capturing engine (codex) and a raw-tee engine (claude/fake) both yield text.
 *
 * @param {object} p
 * @param {string} p.engine        resolved engine name (registry-validated by the caller)
 * @param {string} p.promptFile    absolute path to the already-written prompt file
 * @param {string} p.orchRoot      orchestration root (becomes O for the adapter)
 * @param {string} p.cwd           working dir for the spawn (the flow dir)
 * @param {string} p.captureTarget absolute path the captured envelope is written to
 * @param {string} [p.repoPath]    repo path (defaults to cwd)
 * @param {string} [p.reasoningEffort]
 * @param {string} [p.logFile]     optional session log
 * @returns {Promise<{ code:number, output:string }>}
 */
export async function runEngineStep({ engine, promptFile, orchRoot, cwd, captureTarget, repoPath, reasoningEffort, logFile }) {
  const code = await spawnAI({
    engine,
    interactive: false,
    promptFile,
    orchRoot,
    repoPath: repoPath ?? cwd,
    cwd,
    captureTarget,
    logFile,
    reasoningEffort,
  });
  let output = '';
  if (captureTarget) {
    try { output = await fs.readFile(captureTarget, 'utf8'); } catch { /* no artifact written */ }
  }
  return { code, output };
}

// ── Level 1: do ──────────────────────────────────────────────────────────

/**
 * @param {object} ctx - { orchRoot, tasksDir, issueKey, args, runCommand, runtimeConfig }
 * runCommand(cmd, issueKey, args) calls the existing cmdXxx functions.
 * runtimeConfig is the normalized rcfg (carries grace.enabled etc.) threaded
 * via the options payload (2a.0) so automation never imports config/grace.
 */
export async function cmdDo(ctx) {
  const { orchRoot, tasksDir, issueKey, args, runCommand, runtimeConfig } = ctx;
  const O = orchRoot.replace(/\\/g, '/');

  // Parse stage
  const rawStage = args[0];
  if (!rawStage || !issueKey) {
    console.error('Usage: taskctl do <stage> CP-XXX [flags]');
    console.error('Stages: plan, plan-review, run, review, revise, fix');
    process.exit(1);
  }

  const useCcThingz = args.includes('--cc-thingz');
  const noBrainstorm = args.includes('--no-brainstorm');
  const stageKey = (rawStage === 'plan' && useCcThingz)
    ? (noBrainstorm ? 'plan-cc-auto' : 'plan-cc')
    : rawStage;
  const config = STAGE_CONFIG[stageKey];
  if (!config) {
    console.error(`Unknown stage: ${rawStage}`);
    console.error('Available: plan, plan-review, run, review, revise, fix');
    process.exit(1);
  }

  // Determine engine: explicit --engine wins; otherwise the configured engine
  // for this stage's role (reviewer for plan-review/review, planner otherwise) —
  // WP2 Stage 2b (C2). Falls back to STAGE_CONFIG.defaultEngine when no config.
  // WP5 Stage 5a: a raw `--engine` here previously reached spawnAI UNVALIDATED.
  // assertEngineRegistered fails fast (clear "Unknown engine" + registered list)
  // BEFORE any prompt/state write when the value is not a registered adapter.
  const engineIdx = args.indexOf('--engine');
  const engine = assertEngineRegistered(
    (engineIdx !== -1 && args[engineIdx + 1])
      ? args[engineIdx + 1]
      : engineForStage(rawStage, runtimeConfig),
  );

  // Determine repo path: --repo-path > REPO_PATH env > config repoPath (WP2 2b).
  const repoIdx = args.indexOf('--repo-path');
  const repoPath = (repoIdx !== -1 && args[repoIdx + 1])
    ? args[repoIdx + 1]
    : (process.env.REPO_PATH ?? runtimeConfig?.repoPath ?? null);

  // Auto-loop and iteration limit
  const autoLoop = args.includes('--auto');
  const flipMode = args.includes('--flip');
  const maxIterIdx = args.indexOf('--max-iterations');
  const maxIter = (maxIterIdx !== -1 && args[maxIterIdx + 1]) ? parseInt(args[maxIterIdx + 1]) : MAX_LOOP_ITERATIONS;

  const taskDir = path.join(tasksDir, issueKey);

  // Step 1: Prepare (call existing command to generate prompt)
  console.log(`\n══════════════════════════════════════════`);
  console.log(`  do ${rawStage} ${issueKey} (engine: ${engine})`);
  console.log(`══════════════════════════════════════════`);

  const prepareArgs = [issueKey, '--engine', engine];
  if (useCcThingz) prepareArgs.push('--cc-thingz');
  if (repoPath) prepareArgs.push('--repo-path', repoPath);
  if (args.includes('--external')) prepareArgs.push('--external');

  await runCommand(rawStage, issueKey, prepareArgs);

  // Step 2: Spawn AI
  const promptFile = `${O}/ai/tasks/${issueKey}/${config.promptFile}`;

  // Verify prompt file exists
  try {
    await fs.access(path.join(taskDir, config.promptFile));
  } catch {
    console.error(`\n  ✗ Prompt file not generated: ${config.promptFile}`);
    process.exit(1);
  }

  const startTime = new Date();
  console.log(`\n  ▶ Launching ${engine} (${config.interactive ? 'interactive' : 'automatic'}) at ${startTime.toLocaleTimeString()}...`);
  console.log(`  ── ${engine} output ─────────────────────────────────`);

  // Resolve worktree path from state if available
  let resolvedRepoPath = repoPath;
  try {
    const stateData = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
    if (stateData.worktreePath) resolvedRepoPath = stateData.worktreePath;
  } catch { /* state not found, use repoPath */ }

  // Review-stage cwd/capture is now a FIRST-CLASS adapter policy (WP5 5a I-1):
  // an adapter that writesToCwd on a review stage (codex) gets cwd=taskDir so it
  // can write review.md directly + a captureTarget; every other adapter keeps
  // cwd=resolved repo and no capture. Replaces the `engine==='codex' &&
  // isReviewStage` conditional — no engine-name compare at the call-site.
  const placement = getEngine(engine).reviewPlacement(rawStage);
  const codexCwd = placement.writesToCwd ? taskDir : resolvedRepoPath;
  const captureTarget = placement.writesToCwd ? path.join(taskDir, 'review.md') : undefined;

  // Block brainstorm skill when --no-brainstorm
  const appendSystemPrompt = noBrainstorm
    ? 'CRITICAL RULE: NEVER use the brainstorm skill. NEVER call /brainstorm:do or trigger the brainstorm tool. Skip brainstorm entirely. Go straight to /plan-make:do and create plan.md. You are in autonomous piped mode — do not ask questions, do not propose options, just create the plan file.'
    : undefined;

  // Session log: all AI output saved for debugging and optimization
  const logFile = path.join(taskDir, 'session.log');

  const exitCode = await spawnAI({
    engine,
    interactive: config.interactive,
    promptFile,
    orchRoot,
    repoPath: resolvedRepoPath,
    cwd: codexCwd,
    captureTarget,
    appendSystemPrompt,
    logFile,
    reasoningEffort: runtimeConfig?.engines?.reasoningEffort,
  });

  const elapsed = ((Date.now() - startTime.getTime()) / 1000).toFixed(0);
  console.log(`  ── end ${engine} (${elapsed}s) ───────────────────────────`);

  if (exitCode !== 0) {
    console.error(`\n  ✗ ${engine} exited with code ${exitCode}`);
    process.exit(1);
  }

  // Step 3: Auto-finalize
  // NOTE: for `run`, this is where the GRACE lint gate fires inside
  // cmdRun. On gate FAIL, runCommand throws TASKCTL_EXIT — we surface
  // a clear message and stop the automation chain (no autoLoop).
  console.log(`\n  ▶ Auto-finalizing ${config.finalizeCmd}...`);
  try {
    await runCommand(config.finalizeCmd, issueKey, [issueKey, '--finalize']);
  } catch (err) {
    // GRACE stale-gate inspection is gated on grace.enabled (C2): when GRACE
    // is disabled (default), the gate never ran, so a TASKCTL_EXIT from `run`
    // can't have come from it — don't read/render any legacy state.graceGate.
    if (runtimeConfig?.grace?.enabled && rawStage === 'run' && err.message === 'TASKCTL_EXIT') {
      // Load whatever was persisted (gate result lives in state.graceGate)
      // and surface it in the final error message so the user doesn't
      // have to scroll back.
      try {
        const s = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
        if (s.graceGate?.verdict === 'fail') {
          console.error(
            `\n  ✗ do run aborted: GRACE lint gate FAILED. Fix and re-run:\n` +
            `    taskctl run ${issueKey} --finalize   (or taskctl do run ${issueKey})\n`,
          );
        }
      } catch { /* ignore */ }
    }
    throw err;
  }

  // Step 4: Print result
  let state = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
  console.log(`\n  ✓ ${issueKey} → stage: ${state.stage}, next: ${state.nextAction ?? '—'}`);

  // Step 5: Auto-loop (--auto flag)
  if (autoLoop && rawStage === 'plan' && state.stage === 'planned') {
    console.log(`\n  ▶ --auto: starting plan-review loop${flipMode ? ' (flipped flow)' : ''}...`);

    // Engines come from config (planner=author, reviewer=reviewer; defaults
    // claude/codex). Classic: planner revises, reviewer reviews. Flipped: the
    // two roles start swapped and alternate each iteration (C2 — flip semantics
    // preserved, just sourced from runtimeConfig.engines).
    const { author, reviewer } = rolePair(runtimeConfig);
    let reviseEngine = flipMode ? reviewer : author;
    let reviewEngine = flipMode ? author : reviewer;

    for (let iter = 0; iter <= maxIter; iter++) {
      const reviewArgs = ['plan-review', issueKey, '--engine', reviewEngine, '--repo-path', repoPath];
      const reviewState = await cmdDo({ ...ctx, args: reviewArgs });

      if (reviewState.stage === 'plan_reviewed') {
        console.log(`\n  ✓ Plan approved after ${iter} revision(s)`);
        return reviewState;
      }

      if (iter < maxIter) {
        console.log(`\n  ↻ Revise iteration ${iter + 1}/${maxIter}${flipMode ? ` (reviser: ${reviseEngine})` : ''}`);
        const reviseArgs = ['revise', issueKey, '--engine', reviseEngine, '--repo-path', repoPath];
        await cmdDo({ ...ctx, args: reviseArgs });
        if (flipMode) {
          [reviseEngine, reviewEngine] = [reviewEngine, reviseEngine];
        }
      }
    }
    console.error(`\n  ✗ Plan not approved after ${maxIter} revisions`);
    process.exit(1);
  }

  if (autoLoop && rawStage === 'revise' && state.stage === 'planned') {
    // Revise done → run plan-review + revise loop until approved
    console.log(`\n  ▶ --auto: starting plan-review loop${flipMode ? ' (flipped flow)' : ''}...`);

    const { author, reviewer } = rolePair(runtimeConfig);
    let reviseEngine = flipMode ? reviewer : author;
    let reviewEngine = flipMode ? author : reviewer;

    for (let iter = 0; iter <= maxIter; iter++) {
      const reviewArgs = ['plan-review', issueKey, '--engine', reviewEngine, '--repo-path', repoPath];
      const reviewState = await cmdDo({ ...ctx, args: reviewArgs });

      if (reviewState.stage === 'plan_reviewed') {
        console.log(`\n  ✓ Plan approved after ${iter + 1} review(s)`);
        return reviewState;
      }

      if (iter < maxIter) {
        console.log(`\n  ↻ Revise iteration ${iter + 1}/${maxIter}${flipMode ? ` (reviser: ${reviseEngine})` : ''}`);
        const reviseArgs = ['revise', issueKey, '--engine', reviseEngine, '--repo-path', repoPath];
        await cmdDo({ ...ctx, args: reviseArgs });
        if (flipMode) {
          [reviseEngine, reviewEngine] = [reviewEngine, reviseEngine];
        }
      }
    }
    console.error(`\n  ✗ Plan not approved after ${maxIter} revisions`);
    process.exit(1);
  }

  if (autoLoop && rawStage === 'fix' && state.stage === 'running') {
    // Fix done → run review + fix loop until approved
    console.log(`\n  ▶ --auto: starting review loop${flipMode ? ' (flipped flow)' : ''}...`);

    const { author, reviewer } = rolePair(runtimeConfig);
    let fixEngine = flipMode ? reviewer : author;
    let reviewEngine = flipMode ? author : reviewer;

    for (let iter = 0; iter <= maxIter; iter++) {
      const reviewArgs = ['review', issueKey, '--engine', reviewEngine, '--repo-path', repoPath];
      const reviewState = await cmdDo({ ...ctx, args: reviewArgs });

      if (reviewState.stage === 'done') {
        console.log(`\n  ✓ Review approved after ${iter + 1} review(s)`);
        return reviewState;
      }

      if (iter < maxIter) {
        console.log(`\n  ↻ Fix iteration ${iter + 1}/${maxIter}${flipMode ? ` (fixer: ${fixEngine})` : ''}`);
        const fixArgs = ['fix', issueKey, '--engine', fixEngine, '--repo-path', repoPath];
        await cmdDo({ ...ctx, args: fixArgs });
        if (flipMode) {
          [fixEngine, reviewEngine] = [reviewEngine, fixEngine];
        }
      }
    }
    console.error(`\n  ✗ Review not approved after ${maxIter} fixes`);
    process.exit(1);
  }

  if (autoLoop && rawStage === 'run' && state.stage === 'running') {
    console.log(`\n  ▶ --auto: starting review loop${flipMode ? ' (flipped flow)' : ''}...`);

    const { author, reviewer } = rolePair(runtimeConfig);
    let fixEngine = flipMode ? reviewer : author;
    let reviewEngine = flipMode ? author : reviewer;

    for (let iter = 0; iter <= maxIter; iter++) {
      const reviewArgs = ['review', issueKey, '--engine', reviewEngine, '--repo-path', repoPath];
      const reviewState = await cmdDo({ ...ctx, args: reviewArgs });

      if (reviewState.stage === 'done') {
        console.log(`\n  ✓ Review approved after ${iter} fix(es)`);
        return reviewState;
      }

      if (iter < maxIter) {
        console.log(`\n  ↻ Fix iteration ${iter + 1}/${maxIter}${flipMode ? ` (fixer: ${fixEngine})` : ''}`);
        const fixArgs = ['fix', issueKey, '--engine', fixEngine, '--repo-path', repoPath];
        await cmdDo({ ...ctx, args: fixArgs });
        if (flipMode) {
          [fixEngine, reviewEngine] = [reviewEngine, fixEngine];
        }
      }
    }
    console.error(`\n  ✗ Review not approved after ${maxIter} fixes`);
    process.exit(1);
  }

  return state;
}

// ── Level 2: flow ────────────────────────────────────────────────────────

export async function cmdFlow(ctx) {
  const { orchRoot, tasksDir, issueKey, args, runCommand, loadJiraConfig, runtimeConfig } = ctx;

  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  const fromStage = (fromIdx !== -1 && args[fromIdx + 1]) ? args[fromIdx + 1] : null;
  const toStage = (toIdx !== -1 && args[toIdx + 1]) ? args[toIdx + 1] : 'review';
  const maxIter = parseInt(args[args.indexOf('--max-iterations') + 1]) || MAX_LOOP_ITERATIONS;

  // repoPath: --repo-path > REPO_PATH env > config repoPath (WP2 Stage 2b).
  const repoIdx = args.indexOf('--repo-path');
  const repoPath = (repoIdx !== -1 && args[repoIdx + 1])
    ? args[repoIdx + 1]
    : (process.env.REPO_PATH ?? runtimeConfig?.repoPath ?? null);

  const useCcThingz = args.includes('--cc-thingz');
  const taskDir = path.join(tasksDir, issueKey);

  // Author/reviewer engines for the feedback loops (config-derived; defaults
  // claude/codex). Flow loops are NOT flipped — author always revises/fixes,
  // reviewer always re-reviews (C2).
  const { author: flowAuthor, reviewer: flowReviewer } = rolePair(runtimeConfig);

  // Determine starting point
  let state;
  try {
    state = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));
  } catch {
    console.error(`Task ${issueKey} not found. Run: taskctl sync ${issueKey}`);
    process.exit(1);
  }

  const startStage = fromStage ?? inferNextStage(state);
  const startIdx = FLOW_STAGES.indexOf(startStage);
  const endIdx = FLOW_STAGES.indexOf(toStage);

  if (startIdx === -1) {
    console.error(`Unknown --from stage: ${startStage}. Available: ${FLOW_STAGES.join(', ')}`);
    process.exit(1);
  }

  const stages = FLOW_STAGES.slice(startIdx, endIdx + 1);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  flow ${issueKey}: ${stages.join(' → ')}  `);
  console.log(`╚══════════════════════════════════════════╝`);

  const startTime = Date.now();

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    console.log(`\n  [${i + 1}/${stages.length}] ${stage}`);

    // Build args for do. Engine = configured engine for this stage's role
    // (reviewer for plan-review/review, planner otherwise) — C2.
    const doArgs = [stage, issueKey, '--engine', engineForStage(stage, runtimeConfig), '--repo-path', repoPath];
    if (stage === 'plan' && useCcThingz) {
      doArgs.push('--cc-thingz');
      if (args.includes('--no-brainstorm')) doArgs.push('--no-brainstorm');
    }

    const doCtx = { ...ctx, args: doArgs };
    const resultState = await cmdDo(doCtx);

    // Handle feedback loops
    if (stage === 'plan-review' && resultState.stage === 'analysis') {
      // NEEDS REVISION loop
      let resolved = false;
      for (let iter = 1; iter <= maxIter; iter++) {
        console.log(`\n  ↻ Revise iteration ${iter}/${maxIter}`);

        // Revise (interactive)
        const reviseArgs = ['revise', issueKey, '--engine', flowAuthor, '--repo-path', repoPath];
        await cmdDo({ ...ctx, args: reviseArgs });

        // Re-review
        const reReviewArgs = ['plan-review', issueKey, '--engine', flowReviewer, '--repo-path', repoPath];
        const reState = await cmdDo({ ...ctx, args: reReviewArgs });

        if (reState.stage === 'plan_reviewed') {
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        console.error(`\n  ✗ Plan not approved after ${maxIter} revision iterations. Stopping.`);
        process.exit(1);
      }
    }

    if (stage === 'review' && resultState.stage === 'running') {
      // NEEDS WORK loop
      let resolved = false;
      for (let iter = 1; iter <= maxIter; iter++) {
        console.log(`\n  ↻ Fix iteration ${iter}/${maxIter}`);

        // Fix (interactive)
        const fixArgs = ['fix', issueKey, '--engine', flowAuthor, '--repo-path', repoPath];
        await cmdDo({ ...ctx, args: fixArgs });

        // Re-review
        const reReviewArgs = ['review', issueKey, '--engine', flowReviewer, '--repo-path', repoPath];
        const reState = await cmdDo({ ...ctx, args: reReviewArgs });

        if (reState.stage === 'done') {
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        console.error(`\n  ✗ Review not approved after ${maxIter} fix iterations. Stopping.`);
        process.exit(1);
      }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  state = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  flow complete: ${issueKey}  `);
  console.log(`║  Stage: ${state.stage}`);
  console.log(`║  Duration: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  console.log(`║  Next: ${state.nextAction ?? '—'}`);
  console.log(`╚══════════════════════════════════════════╝`);

  return state;
}

// ── Level 3: autopilot ───────────────────────────────────────────────────

export async function cmdAutopilot(ctx) {
  const { orchRoot, tasksDir, issueKey, args, runCommand, loadJiraConfig, runtimeConfig } = ctx;

  // repoPath: --repo-path > REPO_PATH env > config repoPath (WP2 Stage 2b).
  const repoIdx = args.indexOf('--repo-path');
  const repoPath = (repoIdx !== -1 && args[repoIdx + 1])
    ? args[repoIdx + 1]
    : (process.env.REPO_PATH ?? runtimeConfig?.repoPath ?? null);

  const skipConfirm = args.includes('--yes');
  const taskDir = path.join(tasksDir, issueKey);
  await fs.mkdir(taskDir, { recursive: true });
  const logPath = path.join(taskDir, 'autopilot.log');

  // Logger
  const logStream = (await fs.open(logPath, 'a')).createWriteStream();
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logStream.write(line + '\n');
  };

  const startTime = Date.now();
  log(`autopilot started: ${issueKey}`);
  log(`repo: ${repoPath}`);

  try {
    // Step 1: Sync
    log('── sync ──');
    const config = await loadJiraConfig();
    await runCommand('sync', issueKey, [issueKey], config);
    log('sync complete');

    // Step 2: Flow (plan → review)
    log('── flow: plan → review ──');
    const flowArgs = [issueKey, '--from', 'plan', '--to', 'review', '--repo-path', repoPath];
    if (args.includes('--cc-thingz')) flowArgs.push('--cc-thingz');
    if (args.includes('--no-brainstorm')) flowArgs.push('--no-brainstorm');

    const flowCtx = { ...ctx, args: flowArgs };
    await cmdFlow(flowCtx);
    log('flow complete');

    // Step 3: Confirmation gate
    if (!skipConfirm) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => {
        rl.question('\n  Publish PR? (y/N) ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        log('publish cancelled by user');
        console.log('\n  Cancelled. Task is ready for manual publish:');
        console.log(`  taskctl publish ${issueKey} --repo-path ${repoPath}`);
        return;
      }
    }

    // Step 4: Publish
    log('── publish ──');
    const publishArgs = [issueKey, '--repo-path', repoPath];
    if (args.includes('--jira')) publishArgs.push('--jira');
    await runCommand('publish', issueKey, publishArgs);
    log('publish complete');

    // Step 5: Jira sync
    log('── jira-sync ──');
    await runCommand('jira-sync', issueKey, [issueKey], config);
    log('jira-sync complete');

    // Final report
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const state = JSON.parse(await fs.readFile(path.join(taskDir, 'state.json'), 'utf8'));

    log(`\nautopilot finished`);
    log(`  duration: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    log(`  stage: ${state.stage}`);
    log(`  PR: ${state.activePR ?? '—'}`);

    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  ✓ autopilot complete: ${issueKey}`);
    console.log(`║  Duration: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(`║  PR: ${state.activePR ?? '—'}`);
    console.log(`╚══════════════════════════════════════════╝`);

  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(`\n  ✗ autopilot failed: ${err.message}`);
    console.error(`  Resume with: taskctl resume ${issueKey}`);
    throw err;
  } finally {
    logStream.end();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function inferNextStage(state) {
  const map = {
    analysis: 'plan',
    planned: 'plan-review',
    plan_reviewed: 'run',
    running: 'review',
    review: 'review',
    done: 'review', // already done, flow will be a no-op
  };
  // Special case: if running but execution needs fix
  if (state.stage === 'running' && state.execution?.status === 'needs_fix') {
    return 'review'; // will trigger fix loop
  }
  return map[state.stage] ?? 'plan';
}
