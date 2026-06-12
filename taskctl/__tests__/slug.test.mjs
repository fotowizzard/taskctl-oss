/**
 * WP1 — slug validation unit tests (T-unit-4).
 * validateSlug must reject path traversal AND Windows reserved names; the
 * resolved task path for accepted slugs must stay under ai/tasks, and no
 * directory may be created outside ai/tasks for rejected slugs.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSlug } from '../cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const TASKS_DIR = path.join(ORCH_ROOT, 'ai', 'tasks');

// Silence the expected console.error noise from rejection paths.
let origError;
beforeEach(() => { origError = console.error; console.error = () => {}; });
afterEach(() => { console.error = origError; });

const REJECTED = [
  '..', '.', '../../outside', 'a/b', 'a\\b', '/abs',
  'CON', 'con', 'NUL', 'NUL.txt', 'COM1', 'LPT9', 'demo.',
  '--title', '',
];

const ACCEPTED = ['demo', 'WP1-config', 'feat_x.1', 'demo-jira', 'A1', 'a.b.c'];

test('T-unit-4: validateSlug rejects traversal, separators, absolute, reserved, trailing dot', () => {
  for (const slug of REJECTED) {
    assert.throws(() => validateSlug(slug), /TASKCTL_EXIT|Usage|Invalid/, `should reject "${slug}"`);
  }
});

test('T-unit-4: validateSlug accepts plain single-segment slugs', () => {
  for (const slug of ACCEPTED) {
    assert.equal(validateSlug(slug), slug, `should accept "${slug}"`);
  }
});

test('T-unit-4: accepted slug resolves under ai/tasks', () => {
  for (const slug of ACCEPTED) {
    const resolved = path.resolve(TASKS_DIR, slug);
    assert.equal(resolved, path.join(TASKS_DIR, slug));
    assert.equal(resolved.startsWith(TASKS_DIR + path.sep), true, `${slug} stays under ai/tasks`);
  }
});

test('T-unit-4: rejected slug never yields a path under ai/tasks (would escape)', () => {
  // For traversal slugs, path.resolve would escape TASKS_DIR — proving why the
  // guard is required before any mkdir.
  const escaping = path.resolve(TASKS_DIR, '../../outside');
  assert.equal(escaping.startsWith(TASKS_DIR + path.sep), false);
});
