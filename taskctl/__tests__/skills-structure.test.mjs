/**
 * WP4 — structural lint for the shipped skill files + methodology docs.
 *
 *   T4-lint-dirs   : exactly the 6 expected skill dirs (no missing / extra).
 *   T4-lint-front  : every SKILL.md has opening/closing frontmatter delimiters,
 *                    minimal YAML-lite validity, name (== dir) + description
 *                    (with a trigger phrase) + allowed-tools (labeled extension).
 *   T4-lint-body   : all five required body headings, in the schema.
 *   T4-lint-caps   : skill ≤120 lines; the 3 methodology docs ≤200 lines.
 *   T4-lint-links  : every relative link resolves to a real file — across ALL
 *                    shipped WP4 content (6 skills + 3 methodology docs +
 *                    skills/README.md), plus the README "Methodology & skills"
 *                    section. Each file resolves links from its own directory.
 *
 * Dependency-free: node:test + node:fs only. No YAML/glob library — the
 * frontmatter is parsed with a tiny line scanner (YAML-lite), which is also the
 * portability point (the common cross-loader core is name + description).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(ORCH_ROOT, 'skills');
const METHOD_DIR = path.join(ORCH_ROOT, 'docs', 'methodology');

const EXPECTED_SKILLS = [
  'branch-guard',
  'cross-model-review',
  'empirical-first',
  'orchestrator-verify',
  'review-loop-autopilot',
  'worktree-isolate',
];

const REQUIRED_HEADINGS = [
  '## Contract',
  '## When to trigger',
  '## Protocol',
  '## Anti-patterns',
  '## Worked micro-example',
];

const METHODOLOGY_DOCS = ['task-lifecycle.md', 'flipped-flow.md', 'cross-model-review.md'];

const SKILL_LINE_CAP = 120;
const DOC_LINE_CAP = 200;

function lineCount(file) {
  return fsSync.readFileSync(file, 'utf8').split(/\r?\n/).length;
}

/**
 * Parse a SKILL.md's YAML-lite frontmatter without any YAML dependency.
 * Returns { ok, keys } where keys is a flat string map of the `key: value`
 * lines between the opening and closing `---` delimiters.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return { ok: false, reason: 'no opening --- delimiter' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { ok: false, reason: 'no closing --- delimiter' };
  const keys = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
    if (!m) return { ok: false, reason: `non key:value frontmatter line: "${line}"` };
    keys[m[1]] = m[2];
  }
  return { ok: true, keys, bodyStart: end + 1 };
}

// ── T4-lint-dirs ────────────────────────────────────────────────────────────

test('T4-lint-dirs: exactly the 6 expected skill dirs, each with a SKILL.md', () => {
  assert.ok(fsSync.existsSync(SKILLS_DIR), 'skills/ directory must exist');
  const present = fsSync.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(present, [...EXPECTED_SKILLS].sort(),
    'skills/ must contain exactly the expected skill dirs (no missing / extra)');
  for (const name of EXPECTED_SKILLS) {
    assert.ok(fsSync.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')),
      `${name}/SKILL.md must exist`);
  }
});

// ── T4-lint-front ─────────────────────────────────────────────────────────

test('T4-lint-front: every SKILL.md has valid YAML-lite frontmatter (name==dir, description+trigger, allowed-tools)', () => {
  for (const name of EXPECTED_SKILLS) {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    const content = fsSync.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(content);
    assert.ok(fm.ok, `${name}: frontmatter must be valid (${fm.reason ?? ''})`);

    // Portable core: name + description.
    assert.equal(fm.keys.name, name, `${name}: frontmatter name must equal the dir name`);
    assert.ok(fm.keys.description && fm.keys.description.trim().length > 0,
      `${name}: description must be non-empty`);
    // Trigger phrase present in the description (the activation contract).
    // Triggers may be conditional ("when") or temporal ("before"/"after"/"on")
    // — all are valid activation phrasings.
    assert.match(fm.keys.description, /Activates (when|before|after|on)\b/i,
      `${name}: description must carry an "Activates when/before/after/on …" trigger phrase`);

    // Claude-compatible EXTENSION (labeled optional, but required for THESE skills).
    assert.ok(fm.keys['allowed-tools'] && fm.keys['allowed-tools'].trim().length > 0,
      `${name}: allowed-tools (Claude-compatible extension) must be present and non-empty`);
  }
});

// ── T4-lint-body ──────────────────────────────────────────────────────────

test('T4-lint-body: every SKILL.md has all five required body headings + an H1 title', () => {
  for (const name of EXPECTED_SKILLS) {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    const content = fsSync.readFileSync(file, 'utf8');
    assert.match(content, /^# .+/m, `${name}: must have an H1 title`);
    for (const heading of REQUIRED_HEADINGS) {
      const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
      assert.match(content, re, `${name}: missing required heading "${heading}"`);
    }
  }
});

// ── T4-lint-caps ──────────────────────────────────────────────────────────

test('T4-lint-caps: each SKILL.md is ≤120 lines', () => {
  for (const name of EXPECTED_SKILLS) {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    const n = lineCount(file);
    assert.ok(n <= SKILL_LINE_CAP, `${name}/SKILL.md is ${n} lines (> ${SKILL_LINE_CAP})`);
  }
});

test('T4-lint-caps: each methodology doc is ≤200 lines', () => {
  for (const doc of METHODOLOGY_DOCS) {
    const file = path.join(METHOD_DIR, doc);
    assert.ok(fsSync.existsSync(file), `docs/methodology/${doc} must exist`);
    const n = lineCount(file);
    assert.ok(n <= DOC_LINE_CAP, `${doc} is ${n} lines (> ${DOC_LINE_CAP})`);
  }
});

// ── T4-lint-links ─────────────────────────────────────────────────────────

// Pull every inline-Markdown relative link target from a region of text. Skips
// absolute URLs (http/https/mailto) and pure in-page anchors (#...).
function relativeLinkTargets(text) {
  const out = [];
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let target = m[1].trim();
    const hash = target.indexOf('#');
    if (hash >= 0) target = target.slice(0, hash);
    if (!target) continue;                               // pure anchor
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('mailto:')) continue;
    out.push(target);
  }
  return out;
}

test('T4-lint-links: every relative link in skills/README.md resolves', () => {
  const file = path.join(SKILLS_DIR, 'README.md');
  assert.ok(fsSync.existsSync(file), 'skills/README.md must exist (T4-wire)');
  const content = fsSync.readFileSync(file, 'utf8');
  const offenders = [];
  for (const target of relativeLinkTargets(content)) {
    const resolved = path.resolve(SKILLS_DIR, target);
    if (!fsSync.existsSync(resolved)) offenders.push(`${target} → ${path.relative(ORCH_ROOT, resolved)}`);
  }
  assert.deepEqual(offenders, [], `dangling links in skills/README.md:\n${offenders.join('\n')}`);
});

test('T4-lint-links: every relative link in ALL shipped WP4 content files resolves', () => {
  // Coverage = the 6 skills + the 3 methodology docs + skills/README.md. Each file
  // resolves its relative links from its OWN directory, so a broken companion link
  // (e.g. a skill pointing at a moved methodology doc) fails here, not just in the
  // two README regions above.
  const contentFiles = [
    ...EXPECTED_SKILLS.map((name) => path.join(SKILLS_DIR, name, 'SKILL.md')),
    ...METHODOLOGY_DOCS.map((doc) => path.join(METHOD_DIR, doc)),
    path.join(SKILLS_DIR, 'README.md'),
  ];
  const offenders = [];
  for (const file of contentFiles) {
    assert.ok(fsSync.existsSync(file), `content file must exist: ${path.relative(ORCH_ROOT, file)}`);
    const baseDir = path.dirname(file);
    const content = fsSync.readFileSync(file, 'utf8');
    for (const target of relativeLinkTargets(content)) {
      const resolved = path.resolve(baseDir, target);
      if (!fsSync.existsSync(resolved)) {
        offenders.push(`${path.relative(ORCH_ROOT, file)} :: ${target} → ${path.relative(ORCH_ROOT, resolved)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `dangling relative links in shipped WP4 content:\n${offenders.join('\n')}`);
});

test('T4-lint-links: every relative link in the README "Methodology & skills" section resolves', () => {
  const readme = path.join(ORCH_ROOT, 'README.md');
  const content = fsSync.readFileSync(readme, 'utf8');
  // Isolate the methodology section so the test guards the new links specifically.
  const headingRe = /^##\s+Methodology\s*&\s*skills\s*$/m;
  const hMatch = content.match(headingRe);
  assert.ok(hMatch, 'README.md must contain a "## Methodology & skills" section (T4-wire)');
  const start = content.indexOf(hMatch[0]);
  const rest = content.slice(start + hMatch[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;

  const targets = relativeLinkTargets(section);
  assert.ok(targets.length >= 4,
    'the methodology section should link the 3 methodology docs + the skills index');
  const offenders = [];
  for (const target of targets) {
    const resolved = path.resolve(ORCH_ROOT, target);
    if (!fsSync.existsSync(resolved)) offenders.push(`${target} → ${path.relative(ORCH_ROOT, resolved)}`);
  }
  assert.deepEqual(offenders, [], `dangling links in README "Methodology & skills":\n${offenders.join('\n')}`);
});
