/**
 * workspace.mjs — workspace-root DISCOVERY (WP5 Stage 5b, New-C1 keystone).
 *
 * The product of `taskctl new-project` is a SELF-CONTAINED orchestration
 * workspace (its own `taskctl.config.json` + `ai/tasks` + `ai/templates`). But
 * that is INERT until the CLI resolves its root from the user's cwd instead of
 * the install location: every root in cli.mjs used to derive from the cli.mjs
 * MODULE location (`__dirname`), so `cd <generated>; taskctl plan <task>` read
 * THIS install, not the generated workspace.
 *
 * `resolveWorkspaceRoot(cwd)` walks parents of `cwd` looking for the nearest
 * ancestor that contains `taskctl.config.json` and returns it. When none is
 * found it falls back to the INSTALLATION ROOT — i.e. the EXACT pre-5b behavior
 * (running from anywhere with no config above still uses the install root), so
 * the existing test suite (which runs the CLI from a temp dir that DOES plant a
 * config at its root) is byte-unchanged by construction.
 *
 * This is the MINIMAL primitive — explicitly NOT a multi-project registry (that
 * stays deferred): one root per cwd, the nearest-ancestor config wins.
 */

import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_NAME = 'taskctl.config.json';

// The installation root = the parent of taskctl/ (where cli.mjs lives). This is
// the fallback when no ancestor config is found — the exact pre-5b root.
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Find the nearest ancestor of `cwd` (inclusive) that contains a
 * `taskctl.config.json`. Falls back to the installation root when none is found.
 *
 * @param {string} [cwd]                 starting directory (default process.cwd())
 * @param {object} [opts]
 * @param {string} [opts.installRoot]    override the fallback install root (tests)
 * @param {(p:string)=>boolean} [opts._statHooks.exists]  override the existence
 *        probe so a test can assert the walk stops at the FIRST ancestor config
 *        without planting real files (and prove it does not over-walk).
 * @returns {{ root: string, source: 'discovered'|'install' }}
 */
export function resolveWorkspaceRoot(cwd = process.cwd(), { installRoot, _statHooks } = {}) {
  const fallbackRoot = installRoot ?? INSTALL_ROOT;
  const exists = _statHooks?.exists
    ?? ((p) => fsSync.existsSync(p));

  let dir = path.resolve(cwd);
  // Walk up to the filesystem root. path.dirname('/') === '/' (and 'C:\\' on
  // win32 is its own parent) so the loop terminates at the volume root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (exists(path.join(dir, DEFAULT_CONFIG_NAME))) {
      return { root: dir, source: 'discovered' };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the volume root, no config above
    dir = parent;
  }
  return { root: fallbackRoot, source: 'install' };
}

/**
 * Derive the FOUR workspace-derived values cli.mjs threads everywhere from a
 * chosen root. `O` is the forward-slashed form used in generated prompts.
 * @param {string} root
 * @returns {{ root:string, tasksDir:string, templatesDir:string, O:string }}
 */
export function workspaceBundle(root) {
  return Object.freeze({
    root,
    tasksDir: path.join(root, 'ai', 'tasks'),
    templatesDir: path.join(root, 'ai', 'templates'),
    O: root.replace(/\\/g, '/'),
  });
}

export const INSTALLATION_ROOT = INSTALL_ROOT;
