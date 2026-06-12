/**
 * engines.mjs — Engine adapter abstraction + registry (WP5 Stage 5a).
 *
 * Every engine-specific decision that used to be duplicated across `cli.mjs`
 * (the human-runnable launch-string path: `buildLaunchCommand`) and
 * `automation.mjs` (the real spawn/parse path: `spawnAI`) lives here behind one
 * small adapter interface. `claude` + `codex` ship as the two reference
 * adapters; `opus` ships as an EXACT-LEGACY-PARITY compatibility alias. A
 * registry resolves `config.engines.{planner,reviewer}` and `--engine` to an
 * adapter; an unknown name fails loudly with the registered list.
 *
 * This module is a PURE REFACTOR of the per-engine ARGV and the printed launch
 * string: those are byte-identical to the pre-5a behavior at every call-site
 * (proven by __tests__/engines.test.mjs). No byte-parity is claimed for spawn
 * *options*, and there are exactly THREE deliberate BEHAVIOR exceptions — the
 * single-source-of-truth ledger (header here, mirrored by pinning tests):
 *
 *   DELIBERATE EXCEPTION 1 — codex spawn stdin `'inherit'` → `'ignore'`.
 *     A non-TTY inherited stdin is already EOF, so the codex-exec stdin hang was
 *     avoided INCIDENTALLY in CI; `'ignore'` makes the guarantee EXPLICIT (codex
 *     `exec` hangs forever on an open stdin). argv unchanged. See codexAdapter's
 *     `stdinPolicy` note; pinned by the stdio[0] tests.
 *
 *   DELIBERATE EXCEPTION 2 — claude final-`lineBuf` flush at close (PLAN-MANDATED,
 *     audit-iter1 I-2: "close-time handling of a final unterminated event"). The
 *     pre-5a code left a trailing unterminated stream-json event in lineBuf and
 *     never emitted it; makeClaudeSession.onClose() now flushes it (strictly
 *     safer). See makeClaudeSession; pinned by the claude output-session test.
 *
 *   DELIBERATE EXCEPTION 3 — role-based re-review hint (`otherRoleEngine` in
 *     cli.mjs). The pre-5a fix/revise console hint compared the engine NAME
 *     (`engine === 'claude'`); it is now resolved from the configured
 *     author/reviewer rolePair, so a swapped / single-vendor / planner=opus
 *     config suggests the correct opposite role. For the DEFAULT config
 *     (planner=claude, reviewer=codex) it is byte-identical. Pinned by the
 *     swapped / single-vendor / opus otherRoleEngine tests.
 *
 * Nothing here imports cli.mjs or automation.mjs (those import THIS), so the
 * module is side-effect-free and unit-testable in isolation.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Type contracts (JSDoc — strictNullChecks is OFF in this project, so these are
//  documentation, not enforced types). Signatures match the call-sites exactly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LaunchOpts
 * @property {string} [repoPath]          resolved repo path (forward-slashed here)
 * @property {string} [cwd]               working dir (defaults to repoPath)
 * @property {string} [reasoningEffort]   codex reasoning tier (resolved by caller)
 * @property {string} [prompt]            codex exec one-shot prompt (review form)
 * @property {boolean} [skipGitRepoCheck] codex: add --skip-git-repo-check
 * @property {string} [orchestrationDir]  orchestration root for claude --add-dir
 */

/**
 * @typedef {Object} SpawnOpts
 * @property {string} promptFile          path to the generated prompt file
 * @property {string} orchRoot            orchestration root (becomes O)
 * @property {string} [repoPath]          resolved repo path
 * @property {string} [cwd]               working dir (defaults to repoPath)
 * @property {string} [reasoningEffort]   codex reasoning tier
 * @property {string} [appendSystemPrompt] claude --append-system-prompt payload
 * @property {boolean} interactive        interactive (TTY) vs piped mode
 */

/**
 * @typedef {Object} OutputSession  per-SPAWN parser/accumulator (NOT a singleton)
 * @property {(chunk: string|Buffer) => void} onChunk  parse/tee one stdout chunk
 * @property {() => string} onClose                    flush + return accumulated text
 */

/**
 * @typedef {Object} EngineAdapter
 * @property {string} name
 * @property {'arg'|'file'} promptDelivery
 * @property {'inherit'|'ignore'} stdinPolicy
 * @property {(opts: LaunchOpts) => string} buildLaunchString
 * @property {(opts: SpawnOpts) => {cmd: string, args: string[], spawnOptions: object}} buildSpawn
 * @property {(promptFile: string) => string} deliverPrompt
 * @property {() => OutputSession} createOutputSession
 * @property {(captured: string, target: string|undefined) => Promise<string|null>} captureArtifact
 * @property {(stage: string) => {writesToCwd: boolean}} reviewPlacement
 * @property {() => Promise<{available: boolean, detail?: string}>} probeAvailability
 * @property {{ supportsCcThingz?: boolean, honorsReasoningEffort?: boolean }} capabilities
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Shared helpers moved out of automation.mjs (extractMarkdown / formatClaudeEvent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrape a Markdown review/plan body out of raw codex stdout. Moved verbatim
 * from automation.mjs (the "huge stdout → log, read the artifact" capture path).
 */
export function extractMarkdown(text) {
  const fenced = text.match(/```(?:md|markdown)\s*\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const headingMatch = text.match(/(# (?:Review|Plan Review|Final Review)[^\n]*\n[\s\S]*)/);
  if (headingMatch) {
    let md = headingMatch[1];
    md = md.replace(/\n\[20\d{2}-\d{2}-\d{2}T[\s\S]*/m, '').trim();
    return md;
  }

  return null;
}

/**
 * Pretty-print a Claude stream-json event to stdout. Moved verbatim from
 * automation.mjs (the claude piped-mode formatter).
 */
export function formatClaudeEvent(evt) {
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') {
        console.log(`  [claude] model: ${evt.model}, tools: ${evt.tools?.length ?? 0}`);
      }
      break;
    case 'assistant': {
      const content = evt.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const input = block.input || {};
          const detail = input.file_path || input.pattern || input.command || '';
          const short = typeof detail === 'string' ? detail.slice(0, 80) : '';
          console.log(`  [tool] ${block.name}${short ? ': ' + short : ''}`);
        } else if (block.type === 'text') {
          console.log(block.text);
        }
      }
      break;
    }
    case 'result':
      console.log(`  [done] ${evt.num_turns} turns, ${evt.duration_ms}ms, $${evt.total_cost_usd?.toFixed(4) ?? '?'}`);
      if (evt.is_error) console.error(`  [error] ${evt.result}`);
      break;
  }
}

// The single source of truth for the prompt arg both the launch path and the
// spawn path interpolate. Both reference adapters use it (no duplicated literal).
function readAndFollow(promptFile) {
  return `"Read ${promptFile} and follow the instructions"`;
}

// Spawn `<cmd> --version` ONCE with a short timeout and resolve a structured
// outcome. NO network, NO LLM, writes nothing. `useShell` routes through cmd.exe
// so a Windows `.cmd`/shim resolves (Node 22 refuses to spawn a `.cmd` with
// shell:false — EINVAL); the bare-name attempt keeps shell:false so the
// no-shell guarantee holds on POSIX where the binary is directly executable.
// Returns {ok:true} on exit 0, else {ok:false, code|errno|detail}.
async function tryVersion(cmd, { useShell }) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      // When useShell, quote the resolved path so a space in it survives cmd.exe.
      const launch = useShell ? `"${cmd}"` : cmd;
      child = spawn(launch, ['--version'], { stdio: 'ignore', shell: useShell });
    } catch (err) {
      return done({ ok: false, errno: err.code, detail: err.message });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ ok: false, detail: 'timeout' });
    }, 5000);
    child.on('error', (err) => { clearTimeout(timer); done({ ok: false, errno: err.code, detail: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true } : { ok: false, code, detail: `exit ${code}` });
    });
  });
}

// Resolve `<name>` to an executable path via `where.exe` (Windows only). Returns
// the FIRST result, preferring a PATHEXT-executable entry (.cmd/.exe/.bat) over a
// bare extensionless shim. NO network. Returns null when `where` finds nothing.
async function whereResolve(name) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    let settled = false;
    let out = '';
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn('where.exe', [name], { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    } catch { return done(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, 5000);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) return done(null);
      const exec = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) ?? lines[0];
      done(exec);
    });
  });
}

// Side-effect-free `<cmd> --version` availability probe shared by the real
// adapters. Resolution chain (C1 — a normal `npm i -g` install on Windows ships
// `.cmd` shims, so a bare shell:false spawn ENOENTs and the probe would wrongly
// report every installed engine unavailable, blocking 5b preflight):
//   1. bare `<name>` (shell:false)            — POSIX direct-exec, fast path
//   2. win32: `<name>.cmd` (shell:true)       — npm's generated shim
//   3. win32: `where.exe <name>` → spawn it   — PATHEXT/custom-install fallback
// Keeps the 5s timeout + the zero-network/zero-LLM guarantee on every attempt.
// A missing binary or non-zero exit on ALL applicable attempts → {available:false}.
// Used by 5b preflight BEFORE any target/sidecar write.
async function probeVersion(cmd) {
  // 1. Bare name, no shell. On POSIX this is the whole story; on win32 the npm
  //    shim is extensionless-unspawnable → ENOENT, so we fall through.
  const bare = await tryVersion(cmd, { useShell: false });
  if (bare.ok) return { available: true };
  if (process.platform !== 'win32') {
    return { available: false, detail: bare.detail };
  }

  // 2. win32: the `.cmd` shim npm writes next to the bare name (shell:true so
  //    Node 22's .cmd EINVAL guard is bypassed via cmd.exe).
  const cmdShim = await tryVersion(`${cmd}.cmd`, { useShell: true });
  if (cmdShim.ok) return { available: true };

  // 3. win32: resolve via `where.exe` (handles custom installs / PATHEXT) and
  //    spawn the resolved path through the shell.
  const resolved = await whereResolve(cmd);
  if (resolved) {
    const viaWhere = await tryVersion(resolved, { useShell: true });
    if (viaWhere.ok) return { available: true };
    return { available: false, detail: viaWhere.detail };
  }
  return { available: false, detail: cmdShim.detail ?? bare.detail };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reference adapters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the persistent line-buffered stream-json session used by the claude
 * family (claude + opus's launch/spawn argv are claude-shaped). NOTE: opus does
 * NOT use this session — it uses the raw-tee session below (exact legacy parity).
 */
function makeClaudeSession() {
  let lineBuf = '';
  return {
    onChunk(chunk) {
      const raw = chunk.toString();
      lineBuf += raw;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { formatClaudeEvent(JSON.parse(line)); }
        catch { process.stderr.write(line + '\n'); }
      }
    },
    onClose() {
      // Flush a final unterminated event (the pre-5a code left this trailing
      // partial in lineBuf and never flushed it; flushing is strictly safer and
      // is asserted by the output-session test). claude does not capture an
      // artifact, so the returned accumulator is unused (kept '' for the contract).
      const tail = lineBuf;
      lineBuf = '';
      if (tail.trim()) {
        try { formatClaudeEvent(JSON.parse(tail)); }
        catch { process.stderr.write(tail + '\n'); }
      }
      return '';
    },
  };
}

/**
 * The codex-style raw-tee accumulator: stream raw stdout straight to the user's
 * terminal and accumulate it for later `captureArtifact`. Also used by opus
 * (which falls into the non-claude stdout branch today — exact legacy parity).
 */
function makeRawTeeSession() {
  let captured = '';
  return {
    onChunk(chunk) {
      const text = chunk.toString();
      process.stdout.write(text);
      captured += text;
    },
    onClose() {
      return captured;
    },
  };
}

const isReviewStage = (stage) => stage === 'plan-review' || stage === 'review';

/** claude — the piped stream-json reference adapter. */
const claudeAdapter = {
  name: 'claude',
  promptDelivery: 'file',
  stdinPolicy: 'inherit',
  capabilities: { supportsCcThingz: true },

  deliverPrompt(promptFile) { return readAndFollow(promptFile); },

  buildLaunchString(opts = {}) {
    const orchDir = String(opts.orchestrationDir ?? '').replace(/\\/g, '/');
    return `claude --add-dir "${orchDir}"`;
  },

  buildSpawn(opts) {
    const O = String(opts.orchRoot ?? '').replace(/\\/g, '/');
    const prompt = this.deliverPrompt(opts.promptFile);
    const systemPromptArgs = opts.appendSystemPrompt
      ? ['--append-system-prompt', `"${opts.appendSystemPrompt.replace(/"/g, '\\"')}"`]
      : [];
    const args = opts.interactive
      ? [prompt, '--add-dir', `"${O}"`, ...systemPromptArgs]
      : ['-p', prompt, '--verbose', '--output-format', 'stream-json', '--add-dir', `"${O}"`, ...systemPromptArgs];
    return { cmd: 'claude', args, spawnOptions: spawnOptionsFor(this, opts) };
  },

  createOutputSession() { return makeClaudeSession(); },

  async captureArtifact() { return null; },

  reviewPlacement() { return { writesToCwd: false }; },

  async probeAvailability() { return probeVersion('claude'); },
};

/** codex — the exec/full-auto reference adapter. */
const codexAdapter = {
  name: 'codex',
  promptDelivery: 'file',
  // DELIBERATE EXCEPTION 1 (see the module-header ledger): codex spawn stdin
  // moves from 'inherit' to 'ignore'. The pre-5a code inherited stdin; a non-TTY
  // inherited stdin is already EOF, so the codex-exec stdin-hang was avoided
  // INCIDENTALLY in CI. 'ignore' makes that guarantee EXPLICIT and robust (codex
  // `exec` hangs forever on an open stdin). This is one of THREE deliberate
  // spawn-OPTIONS / behavior exceptions; argv is still byte-identical. A targeted
  // regression test pins stdio[0]==='ignore' here and 'inherit' for claude.
  stdinPolicy: 'ignore',
  capabilities: { honorsReasoningEffort: true },

  deliverPrompt(promptFile) { return readAndFollow(promptFile); },

  buildLaunchString(opts = {}) {
    const repoPath = String(opts.repoPath ?? '').replace(/\\/g, '/');
    const cwd = String(opts.cwd ?? repoPath).replace(/\\/g, '/');
    const skipGitRepoCheck = opts.skipGitRepoCheck ? ' --skip-git-repo-check' : '';
    const effort = opts.reasoningEffort ?? 'high';
    const effortFlag = ` -c model_reasoning_effort=${effort}`;
    if (opts.prompt) {
      const prompt = String(opts.prompt).replace(/"/g, '\\"');
      return `codex exec -s danger-full-access${skipGitRepoCheck}${effortFlag} -C "${cwd}" "${prompt}"`;
    }
    return `codex --full-auto -s danger-full-access${effortFlag} -C "${cwd}"`;
  },

  buildSpawn(opts) {
    const workDir = opts.cwd || opts.repoPath;
    const effort = opts.reasoningEffort || 'high';
    const prompt = this.deliverPrompt(opts.promptFile);
    // -C sets the codex write dir; danger-full-access grants read everywhere.
    const needsRepoCheckBypass = workDir !== opts.repoPath;
    const codexArgs = ['-s', 'danger-full-access', '-c', `model_reasoning_effort=${effort}`];
    if (needsRepoCheckBypass) codexArgs.push('--skip-git-repo-check');
    codexArgs.push('-C', `"${workDir}"`);
    const args = opts.interactive
      ? ['--full-auto', ...codexArgs]
      : ['exec', ...codexArgs, prompt];
    return { cmd: 'codex', args, spawnOptions: spawnOptionsFor(this, opts) };
  },

  createOutputSession() { return makeRawTeeSession(); },

  async captureArtifact(captured, target) {
    if (!target || !captured || captured.length === 0) return null;
    const md = extractMarkdown(captured);
    if (!md) return null;
    const fsP = await import('node:fs/promises');
    await fsP.writeFile(target, md, 'utf8');
    return target;
  },

  reviewPlacement(stage) { return { writesToCwd: isReviewStage(stage) }; },

  async probeAvailability() { return probeVersion('codex'); },
};

/**
 * opus — EXACT-LEGACY-PARITY compatibility alias (NOT a Claude-alias bug-fix).
 *
 * Today `opus` is accepted by parseEngine but has no dedicated branch anywhere,
 * so it inherits FIVE concrete behaviors by falling through the non-codex paths.
 * 5a is a pure refactor, so the adapter reproduces all five EXACTLY (pinned by
 * the five-fact tests + a planner:"opus" migration test):
 *
 *   1. launch/spawn argv → CLAUDE-shaped, with NO `--model` flag (it falls into
 *      the `else` branch of buildLaunchCommand / spawnAI argv).
 *   2. createOutputSession → the codex-style RAW-TEE accumulator, NOT claude's
 *      stream-json parser (the old stdout branch was `if (engine === 'claude')`,
 *      so opus hit the `else` = raw tee).
 *   3. captureArtifact → NULL (artifact capture was `engine === 'codex'` only;
 *      opus captured nothing).
 *   4. stdinPolicy:'inherit' (claude-shaped; opus is NOT codex, so it does NOT
 *      get the new 'ignore').
 *   5. supportsCcThingz:false — the pre-5a cc-thingz gate was `engine ===
 *      'claude'`, so `opus --cc-thingz` took the DIRECT plan path. (C4)
 *
 * Documented legacy alias — prefer `engines.planner:"claude"` in new configs.
 */
const opusAdapter = {
  name: 'opus',
  promptDelivery: 'file',
  stdinPolicy: 'inherit',            // fact 4 — claude-shaped, not codex's 'ignore'
  // fact 5 — supportsCcThingz:false. Pre-5a the cc-thingz branch was literally
  // `useCcThingz && engine === 'claude'`, so `opus --cc-thingz` took the DIRECT
  // plan path (different prompt bytes / nextAction / console). Advertising true
  // here would silently route opus into the cc-thingz path = a behavior change,
  // so opus keeps it false for exact legacy parity (pinned by a cc-thingz test).
  capabilities: { supportsCcThingz: false },

  deliverPrompt(promptFile) { return readAndFollow(promptFile); },

  // facts 1 — claude-shaped argv, NO --model flag (delegates to the claude shape).
  buildLaunchString(opts = {}) { return claudeAdapter.buildLaunchString(opts); },
  buildSpawn(opts) {
    const { cmd, args } = claudeAdapter.buildSpawn(opts);
    return { cmd, args, spawnOptions: spawnOptionsFor(this, opts) };
  },

  // fact 2 — codex-style raw-tee session (NOT claude's stream-json parser).
  createOutputSession() { return makeRawTeeSession(); },

  // fact 3 — null capture (opus never captured an artifact).
  async captureArtifact() { return null; },

  reviewPlacement() { return { writesToCwd: false }; },

  async probeAvailability() { return probeVersion('claude'); }, // opus runs the claude binary
};

/**
 * Derive child_process spawn options from the adapter's stdinPolicy + the spawn
 * mode. Generic across adapters: piped mode gets [stdinPolicy,'pipe','pipe'];
 * interactive inherits all three streams. (cwd/shell/env are set by spawnAI.)
 */
function spawnOptionsFor(adapter, opts) {
  const stdio = opts.interactive
    ? 'inherit'
    : [adapter.stdinPolicy, 'pipe', 'pipe'];
  return { stdio };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Registry + resolution
// ─────────────────────────────────────────────────────────────────────────────

export class UnknownEngineError extends Error {
  constructor(name, registered) {
    super(`Unknown engine "${name}". Registered: ${registered.join(', ')}.`);
    this.name = 'UnknownEngineError';
    this.engine = name;
  }
}

const REGISTRY = new Map();

// The built-in names that registerEngine refuses to replace (prevents a silent
// Map.set from clobbering a reference adapter; a NEW name like 'fake' is fine).
const BUILTIN_NAMES = new Set(['claude', 'codex', 'opus']);

const REQUIRED_METHODS = [
  'buildLaunchString', 'buildSpawn', 'deliverPrompt', 'createOutputSession',
  'captureArtifact', 'reviewPlacement', 'probeAvailability',
];

// Known capability flags (the EngineAdapter typedef). When present they MUST be
// booleans — a `supportsCcThingz:"yes"` would otherwise sail through as truthy
// and silently route the adapter into the cc-thingz path (I-4).
const BOOLEAN_CAPABILITY_FIELDS = ['supportsCcThingz', 'honorsReasoningEffort'];

/**
 * The ONE validated-registration path (I-4): asserts the adapter SHAPE (required
 * methods present + props correctly typed + known capability fields boolean) and
 * inserts it. Both the public `registerEngine` AND the built-in bootstrap go
 * through this — built-ins are validated by the SAME checks, not inserted raw.
 * The built-in REPLACE-guard lives in `registerEngine` (callers), not here, so
 * the bootstrap can seed claude/codex/opus without tripping it.
 * @param {EngineAdapter} adapter
 */
function registerValidated(adapter) {
  if (adapter == null || typeof adapter !== 'object') {
    throw new Error('registerEngine: adapter must be an object.');
  }
  if (typeof adapter.name !== 'string' || adapter.name.length === 0) {
    throw new Error('registerEngine: adapter.name must be a non-empty string.');
  }
  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== 'function') {
      throw new Error(`registerEngine: adapter "${adapter.name}" is missing method ${m}().`);
    }
  }
  if (adapter.stdinPolicy !== 'inherit' && adapter.stdinPolicy !== 'ignore') {
    throw new Error(`registerEngine: adapter "${adapter.name}" has invalid stdinPolicy ${JSON.stringify(adapter.stdinPolicy)} (expected 'inherit' | 'ignore').`);
  }
  if (adapter.promptDelivery !== 'arg' && adapter.promptDelivery !== 'file') {
    throw new Error(`registerEngine: adapter "${adapter.name}" has invalid promptDelivery ${JSON.stringify(adapter.promptDelivery)} (expected 'arg' | 'file').`);
  }
  if (adapter.capabilities != null) {
    if (typeof adapter.capabilities !== 'object' || Array.isArray(adapter.capabilities)) {
      throw new Error(`registerEngine: adapter "${adapter.name}" has invalid capabilities (expected an object).`);
    }
    for (const field of BOOLEAN_CAPABILITY_FIELDS) {
      const v = adapter.capabilities[field];
      if (v != null && typeof v !== 'boolean') {
        throw new Error(`registerEngine: adapter "${adapter.name}" capability ${field} must be a boolean, got ${JSON.stringify(v)}.`);
      }
    }
  }
  REGISTRY.set(adapter.name, adapter);
  return adapter;
}

/**
 * Register an engine adapter. Runs the shared shape validation
 * (`registerValidated`) and REFUSES to replace a built-in (claude/codex/opus).
 * Registering a NEW name is allowed (the fake-adapter seam).
 * @param {EngineAdapter} adapter
 */
export function registerEngine(adapter) {
  if (adapter != null && typeof adapter === 'object' && BUILTIN_NAMES.has(adapter.name)) {
    throw new Error(`registerEngine: cannot replace built-in engine "${adapter.name}".`);
  }
  return registerValidated(adapter);
}

/**
 * Resolve a registered adapter by name. Throws UnknownEngineError (listing the
 * registered names) if absent — the HARD-FAIL path on a resolved launch.
 * @param {string} name
 * @returns {EngineAdapter}
 */
export function getEngine(name) {
  const adapter = REGISTRY.get(name);
  if (!adapter) throw new UnknownEngineError(name, registeredEngineNames());
  return adapter;
}

/** All registered engine names — the parseEngine allow-list + the error list. */
export function registeredEngineNames() {
  return [...REGISTRY.keys()];
}

/**
 * Validation helper for config-resolution / preflight: throws UnknownEngineError
 * if `name` is not registered, otherwise returns it. Used by the raw-`--engine`
 * picks in cmdDo/cmdFlow/autopilot so a bad engine fails BEFORE any prompt/state
 * write — not after.
 * @param {string} name
 * @returns {string}
 */
export function assertEngineRegistered(name) {
  if (!REGISTRY.has(name)) throw new UnknownEngineError(name, registeredEngineNames());
  return name;
}

/** Test-only: remove a non-built-in adapter (so test files don't leak the fake). */
export function _unregisterEngineForTest(name) {
  if (BUILTIN_NAMES.has(name)) {
    throw new Error(`_unregisterEngineForTest: refusing to remove built-in "${name}".`);
  }
  return REGISTRY.delete(name);
}

// Register the three built-in adapters at module load through the SAME validated
// path as third-party adapters (I-4) — they skip only the built-in replace-guard
// (which lives in registerEngine), not the shape/capability checks. The `fake`
// adapter is NEVER registered here — only test code imports engines-fake.mjs and
// calls registerEngine(makeFakeEngine(...)), so a production run can never
// resolve it.
for (const builtin of [claudeAdapter, codexAdapter, opusAdapter]) {
  registerValidated(builtin);
}

// Exported for direct unit tests of adapter behavior.
export const _adaptersForTest = { claudeAdapter, codexAdapter, opusAdapter };
