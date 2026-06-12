#!/usr/bin/env node
/**
 * engines-fake-replay.mjs — the canned "engine" the fake adapter spawns.
 *
 * TEST-ONLY. Spawned as `node engines-fake-replay.mjs <promptFile>` by
 * engines-fake.mjs. It emits a VALID structured envelope (a fenced ```json
 * block) on stdout keyed by the prompt-file basename, then exits 0 — so the
 * 5b new-project flow can run hermetically with deterministic on-disk output
 * and no live LLM.
 *
 * Envelope shapes (the 5b schemas validate these):
 *   brainstorm → { questions[], assumptions[], options[] }
 *   proposal   → { recommended, options:[{id,stack,rationale}] }
 *   scaffold   → { commands[], fileTree[] }
 *   backlog    → { tasks:[{slug,title,desc}] }
 *
 * If TASKCTL_FAKE_SCRIPT_DIR holds a file matching the prompt basename (e.g.
 * `<scriptDir>/<basename>.json`), that file's contents are emitted verbatim,
 * letting a test inject a specific (or deliberately MALFORMED) reply. Otherwise
 * a built-in valid envelope is chosen by matching keywords in the basename.
 *
 * If TASKCTL_FAKE_EXIT_CODE is set to a nonzero integer, the script emits a VALID
 * envelope (so stdout parses) but then exits with that code — the seam the I-3
 * engine-exit-code test uses to prove a call-site rejects a nonzero exit even when
 * the output looks good.
 */

import fs from 'node:fs';
import path from 'node:path';

const promptFile = process.argv[2] || '';
const base = path.basename(promptFile).toLowerCase();
const forcedExit = Number.parseInt(process.env.TASKCTL_FAKE_EXIT_CODE ?? '', 10);
const exitCode = Number.isInteger(forcedExit) ? forcedExit : 0;

function pickBuiltin(name) {
  if (name.includes('brainstorm')) {
    return { questions: ['Who is the user?'], assumptions: ['Single-tenant'], options: ['SPA', 'SSR'] };
  }
  if (name.includes('proposal')) {
    return {
      recommended: 'spa-vite',
      options: [
        { id: 'spa-vite', stack: 'React + Vite', rationale: 'Fast dev loop' },
        { id: 'ssr-next', stack: 'Next.js', rationale: 'SEO + SSR' },
      ],
    };
  }
  if (name.includes('scaffold')) {
    return { commands: ['npm create vite@latest app -- --template react'], fileTree: ['app/package.json', 'app/src/main.tsx'] };
  }
  if (name.includes('backlog')) {
    return {
      tasks: [
        { slug: 'setup-tooling', title: 'Set up tooling', desc: 'ESLint, Prettier, Vitest' },
        { slug: 'auth-flow', title: 'Auth flow', desc: 'Login + session' },
      ],
    };
  }
  // Generic fallback envelope so the script is always valid JSON.
  return { ok: true, prompt: base };
}

let payload = null;

const scriptDir = process.env.TASKCTL_FAKE_SCRIPT_DIR;
if (scriptDir) {
  // Try `<basename>.json` and the basename verbatim.
  const candidates = [path.join(scriptDir, base + '.json'), path.join(scriptDir, base)];
  for (const c of candidates) {
    try {
      const raw = fs.readFileSync(c, 'utf8');
      // Emit the canned file VERBATIM (it may be intentionally malformed for a
      // schema-violation test) and exit (honoring a forced exit code).
      process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n');
      process.exit(exitCode);
    } catch { /* not found — try next / fall through to built-in */ }
  }
}

payload = pickBuiltin(base);
// Valid envelope on stdout, then exit (nonzero only when TASKCTL_FAKE_EXIT_CODE is
// set — the I-3 seam: parseable output + a failing process).
process.stdout.write('```json\n' + JSON.stringify(payload, null, 2) + '\n```\n');
process.exit(exitCode);
