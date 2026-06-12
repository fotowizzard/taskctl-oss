/**
 * WP5 Stage 5b — T5b-1: new-project prompt-pack keys exist in BOTH packs, carry
 * the explicit English-output constraint (I-10), and instruct a structured JSON
 * envelope. The artifacts stay English regardless of pack language, so the
 * constraint must be present in the ru pack too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPromptPack } from '../prompts/index.mjs';

const PACKS = { en: loadPromptPack('en'), ru: loadPromptPack('ru') };
const BUILDER_KEYS = ['newProjectBrainstorm', 'newProjectProposal', 'newProjectScaffold', 'newProjectBacklog'];
const CONSOLE_KEYS = ['newProjectBrainstormConsole', 'newProjectProposalConsole', 'newProjectScaffoldConsole', 'newProjectBacklogConsole'];

const ctx = { flowDir: '/ws/ai/newproject/abc', idea: 'a todo app', slug: 'todo-app', chosenOption: 'spa-vite' };

for (const lang of ['en', 'ru']) {
  test(`T5b-1 (${lang}): all four new-project builders + consoles are present and callable`, () => {
    const pack = PACKS[lang];
    for (const k of BUILDER_KEYS) {
      assert.equal(typeof pack[k], 'function', `${lang}.${k} is a builder`);
      const lines = pack[k](ctx);
      assert.ok(Array.isArray(lines) && lines.length > 0, `${lang}.${k} returns lines`);
    }
    for (const k of CONSOLE_KEYS) {
      assert.equal(typeof pack[k], 'function', `${lang}.${k} is a console builder`);
    }
    assert.ok(pack.newProjectBacklogConsole({ count: 3 }).preparedLine.includes('3'));
  });

  test(`T5b-1 (${lang}): every builder carries the English-output constraint (I-10)`, () => {
    const pack = PACKS[lang];
    for (const k of BUILDER_KEYS) {
      const text = pack[k](ctx).join('\n');
      assert.match(text, /Write ALL output in English/i, `${lang}.${k} states the English constraint`);
    }
  });

  test(`T5b-1 (${lang}): every builder instructs a structured JSON envelope`, () => {
    const pack = PACKS[lang];
    for (const k of BUILDER_KEYS) {
      const text = pack[k](ctx).join('\n');
      assert.match(text, /```json/, `${lang}.${k} asks for a fenced json envelope`);
    }
  });

  test(`T5b-1 (${lang}): the idea + slug are interpolated, never the raw flowDir into argv`, () => {
    const pack = PACKS[lang];
    const bs = pack.newProjectBrainstorm(ctx).join('\n');
    assert.match(bs, /a todo app/);
    assert.match(bs, /todo-app/);
    assert.match(bs, /\/ws\/ai\/newproject\/abc\/brainstorm\.md/);
  });
}

test('T5b-1: scaffold prompt states PRINT-ONLY (taskctl never executes commands)', () => {
  for (const lang of ['en', 'ru']) {
    const text = PACKS[lang].newProjectScaffold(ctx).join('\n');
    assert.match(text, /NEVER executes|никогда их не выполняет/i);
  }
});
