/**
 * WP1 — templating helpers unit tests (T-unit-2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, renderLocalState } from '../templating.mjs';

test('T-unit-2: renderTemplate(context.md.tmpl) leaves no {{...}} token', async () => {
  const vars = {
    ISSUE_KEY: 'demo', SUMMARY: 'x', STATUS: 'local', PRIORITY: 'None',
    ASSIGNEE: 'Unassigned', SPRINT: 'None', PARENT: 'None', LABELS: 'None',
    DESCRIPTION: 'hello', ACCEPTANCE_CRITERIA: '(none)', BLOCKS: 'None',
    BLOCKED_BY: 'None', RELATED: 'None', COMMENTS: '(none)', CODE_AREAS: '- (none)',
    PROJECT_CONTEXT: '', CONSTRAINTS: '',
  };
  const out = await renderTemplate('context.md.tmpl', vars);
  assert.equal(/\{\{\w+\}\}/.test(out), false, 'no unsubstituted placeholder');
  assert.match(out, /# demo: x/);
  assert.match(out, /hello/);
});

test('T-unit-2: renderTemplate throws when a required var is missing', async () => {
  // Only supply ISSUE_KEY → many tokens remain → must throw.
  await assert.rejects(
    () => renderTemplate('context.md.tmpl', { ISSUE_KEY: 'demo' }),
    /unsubstituted placeholder/
  );
});

test('T-unit-2: renderLocalState returns an object (not parsed-from-string) with expected fields', () => {
  const ts = '2026-06-09T00:00:00.000Z';
  const st = renderLocalState('demo', ts);
  assert.equal(typeof st, 'object');
  assert.equal(st.issueKey, 'demo');
  assert.equal(st.issueType, 'Task');
  assert.equal(st.stage, 'analysis');
  assert.equal(st.contextVersion, 1);
  assert.equal(st.planVersion, 0);
  assert.equal(st.nextAction, 'build plan');
  assert.equal(st.lastSyncedFromJira, ts);
  assert.deepEqual(st.dependsOn, []);
  assert.deepEqual(st.execution, { engine: null, status: 'idle', lastRunAt: null });
});

test('T-unit-2: renderLocalState handles a slug with JSON-significant chars safely', () => {
  // Object-builder (not string-substitution) means quoting can never break.
  const st = renderLocalState('weird"slug', '2026-01-01T00:00:00.000Z');
  assert.equal(st.issueKey, 'weird"slug');
  // round-trips through JSON cleanly
  assert.equal(JSON.parse(JSON.stringify(st)).issueKey, 'weird"slug');
});
