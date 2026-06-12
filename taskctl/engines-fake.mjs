/**
 * engines-fake.mjs — the hermetic TEST SEAM for the engine adapter layer.
 *
 * IMPORTANT: this module is imported ONLY from test files. Production modules
 * (cli.mjs / automation.mjs) NEVER import it, and there is NO env-var or other
 * code path that registers it at runtime. Tests opt in explicitly:
 *
 *     import { makeFakeEngine } from '../engines-fake.mjs';
 *     import { registerEngine, _unregisterEngineForTest } from '../engines.mjs';
 *     registerEngine(makeFakeEngine({ scriptDir }));   // 'fake' is a NEW name → allowed
 *     // ... run the flow under the fake adapter ...
 *     _unregisterEngineForTest('fake');                 // clean up so other tests are isolated
 *
 * Because registration is test-code-only and registerEngine refuses to replace a
 * built-in (claude/codex/opus), a production run can NEVER resolve `fake`.
 *
 * The fake lets the 5b new-project flow (and any other engine-driven command)
 * run end-to-end with deterministic, on-disk "engine output" and ZERO network /
 * ZERO live LLM: buildSpawn launches `node <replayScript> <promptFile>`; the
 * replay script emits a VALID structured envelope on stdout (so spawnAI's
 * raw-tee session accumulates it) AND, when the flow expects a captured
 * artifact, writes it to the capture target. It exits 0.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The canned replay script that the fake spawns. It is a real, standalone node
// script (engines-fake-replay.mjs) so the spawn path is exercised exactly like a
// real engine (argv → child_process → stdout → session → capture).
const DEFAULT_REPLAY_SCRIPT = path.join(__dirname, 'engines-fake-replay.mjs');

/**
 * Build a `fake` engine adapter.
 * @param {Object} [opts]
 * @param {string} [opts.scriptDir]    dir holding per-prompt canned replies
 *                                     (keyed by prompt-file basename); forwarded
 *                                     to the replay script via env.
 * @param {string} [opts.replayScript] override the replay script path (tests).
 * @param {Array}  [opts.record]       if provided, every buildSpawn() pushes the
 *                                     RESOLVED {cmd,args,spawnOptions,opts} onto
 *                                     it — lets an integration test assert the
 *                                     REAL spawn argv the automation path used
 *                                     (I-1) without intercepting child_process.
 * @returns {import('./engines.mjs').EngineAdapter}
 */
export function makeFakeEngine({ scriptDir, replayScript, record } = {}) {
  const script = replayScript ?? DEFAULT_REPLAY_SCRIPT;
  return {
    name: 'fake',
    promptDelivery: 'file',
    stdinPolicy: 'ignore',
    capabilities: {},

    deliverPrompt(promptFile) { return `"Read ${promptFile}"`; },

    // Inert, printable, human-runnable — never actually executed by tests that
    // only assert on the printed launch string.
    buildLaunchString(opts = {}) {
      return `fake-engine ${opts.prompt ?? ''}`.trim();
    },

    // Spawn the canned replay script (a real node subprocess). scriptDir is
    // passed via env so the script can pick the right canned reply.
    buildSpawn(opts) {
      const args = [script, opts.promptFile];
      const stdio = opts.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'];
      const built = {
        cmd: 'node',
        args,
        spawnOptions: {
          stdio,
          env: { ...process.env, ...(scriptDir ? { TASKCTL_FAKE_SCRIPT_DIR: scriptDir } : {}) },
        },
      };
      if (Array.isArray(record)) record.push({ ...built, opts });
      return built;
    },

    // Raw-tee accumulator (no parsing) — same shape the codex adapter uses.
    createOutputSession() {
      let captured = '';
      return {
        onChunk(chunk) { const t = chunk.toString(); process.stdout.write(t); captured += t; },
        onClose() { return captured; },
      };
    },

    // When the flow expects a captured artifact, persist the accumulated stdout
    // (the replay script already emits a valid envelope). null when no target.
    async captureArtifact(captured, target) {
      if (!target || !captured || captured.length === 0) return null;
      const fsP = await import('node:fs/promises');
      await fsP.writeFile(target, captured, 'utf8');
      return target;
    },

    // Mirror the codex capturing-engine policy: writesToCwd on review stages so
    // the REAL automation path (cmdDo) hands the fake a cwd=taskDir + a
    // captureTarget, exercising the env→scripted-reply→captured-artifact chain
    // end-to-end (C3/I-1). Non-review stages keep cwd=repo, no capture.
    reviewPlacement(stage) {
      return { writesToCwd: stage === 'plan-review' || stage === 'review' };
    },

    // The fake is ALWAYS "available" (no binary to probe).
    async probeAvailability() { return { available: true }; },
  };
}
