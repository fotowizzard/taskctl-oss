/**
 * Template rendering helpers for taskctl (WP1).
 *
 * Used by the `local` tracker adapter to seed a task's context.md/state.json
 * from the shared templates plus a caller-supplied title/description — no Jira,
 * no network. Standalone so both cli.mjs and the unit tests can import it
 * without creating an import cycle with tracker.mjs/cli.mjs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const __dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ORCH_ROOT = path.resolve(__dir, '..');
const TEMPLATES_DIR = path.join(ORCH_ROOT, 'ai', 'templates');

/**
 * Read a `.tmpl` from the templates dir, substitute every `{{KEY}}` placeholder
 * from `vars`, and assert no `{{...}}` token remains (so a rendered file never
 * carries an unsubstituted placeholder).
 *
 * @param {string} name template filename, e.g. 'context.md.tmpl'
 * @param {Record<string,string>} vars KEY -> replacement value
 * @param {object} [opts]
 * @param {string} [opts.templatesDir] override templates dir (tests)
 * @returns {Promise<string>}
 */
export async function renderTemplate(name, vars, opts = {}) {
  const dir = opts.templatesDir ?? TEMPLATES_DIR;
  const raw = await fs.readFile(path.join(dir, name), 'utf8');

  const rendered = raw.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match; // leave unknown tokens so the assertion below catches them
  });

  const leftover = rendered.match(/\{\{\w+\}\}/g);
  if (leftover) {
    const unique = [...new Set(leftover)].join(', ');
    throw new Error(`renderTemplate("${name}"): unsubstituted placeholder(s): ${unique}`);
  }
  return rendered;
}

/**
 * Build the first-sync state object for a LOCAL task as an OBJECT (not by
 * string-substituting JSON then re-parsing) so a slug with JSON-significant
 * characters can never break quoting. Mirrors the fresh-branch shape of the
 * Jira sync state (minus link extraction) plus `issueType:'Task'`.
 *
 * @param {string} slug
 * @param {string} ts ISO timestamp
 * @returns {object}
 */
export function renderLocalState(slug, ts) {
  return {
    issueKey: slug,
    issueType: 'Task',
    stage: 'analysis',
    contextVersion: 1,
    planVersion: 0,
    branch: null,
    activePR: null,
    relatedPRs: [],
    merged: false,
    dependsOn: [],
    blocks: [],
    followups: [],
    derivedFrom: [],
    lastSyncedFromJira: ts, // field name kept for state-shape parity ("created at" for local)
    lastSyncedFromRepo: null,
    openQuestions: [],
    nextAction: 'build plan',
    execution: { engine: null, status: 'idle', lastRunAt: null },
  };
}
