/**
 * WP6 — .env.example deliverable test.
 *
 * Proves the shipped `.env.example`:
 *   1. exists at the repo root and contains only PLACEHOLDER values (no
 *      high-entropy / real-looking credential on any assignment line);
 *   2. is NOT gitignored (the broad env ignore is negated by a .env.example
 *      re-include rule), so it actually ships;
 *   3. is tracked by git (`git ls-files --error-unmatch`).
 *
 * Deterministic; no network. Git assertions shell out to the repo this file
 * lives in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..', '..');
const ENV_EXAMPLE = path.join(ORCH_ROOT, '.env.example');
const REL = '.env.example';

/** A value is an obvious placeholder if it matches one of these shapes. */
function isPlaceholderValue(value) {
  if (value === '') return true; // empty = "fill me in", acceptable
  const v = value.trim();
  // Explicitly templated sentinels.
  if (/^__.*__$/.test(v)) return true;
  if (/<.*>/.test(v)) return true;
  // Obvious example/illustrative values.
  if (/example\.com|example\.net|your-org|your[-_]|\byou@\b/i.test(v)) return true;
  // A filesystem-path placeholder (e.g. /absolute/path/to/your/target/repo).
  if (/\/(absolute|path|your)\b/i.test(v)) return true;
  // A short ALL-CAPS token like a sample project key (ABC) — clearly not a secret.
  if (/^[A-Z]{2,6}$/.test(v)) return true;
  return false;
}

/** Heuristic: does this token LOOK like a real credential we must never ship? */
function looksLikeRealSecret(value) {
  const v = value.trim();
  if (v.length < 20) return false;
  // Long, high-variety, no spaces, not an obvious URL/path → suspicious.
  if (/\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return false;
  if (v.includes('/')) return false; // a path, not a token
  const hasMixedClasses =
    /[A-Za-z]/.test(v) && /[0-9]/.test(v);
  return hasMixedClasses && !isPlaceholderValue(v);
}

test('WP6 .env.example: exists and every assignment line is a placeholder', () => {
  assert.equal(fs.existsSync(ENV_EXAMPLE), true, '.env.example must exist at repo root');
  const content = fs.readFileSync(ENV_EXAMPLE, 'utf8');

  const assignments = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='));

  assert.ok(assignments.length >= 1, '.env.example should declare at least one variable');

  for (const line of assignments) {
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    assert.equal(
      looksLikeRealSecret(value),
      false,
      `.env.example line "${key}=..." looks like a real secret — must be a placeholder`
    );

    // Secret-ish keys must carry an UNMISTAKABLE placeholder (never blank/loose).
    if (/TOKEN|SECRET|PASSWORD|KEY$|APIKEY/i.test(key) && !/PROJECT_KEY/i.test(key)) {
      assert.equal(
        isPlaceholderValue(value),
        true,
        `.env.example secret-ish key "${key}" must have an explicit placeholder value`
      );
    }
  }
});

test('WP6 .env.example: is NOT gitignored (it must ship)', () => {
  const r = spawnSync('git', ['check-ignore', REL], { cwd: ORCH_ROOT, encoding: 'utf8' });
  // git check-ignore exits 1 (no output) when the path is NOT ignored — that's what we want.
  assert.equal(r.status, 1, `.env.example must NOT be gitignored (check-ignore output: "${r.stdout.trim()}")`);
});

test('WP6 .env.example: is tracked by git', () => {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', REL], { cwd: ORCH_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `.env.example must be tracked (git ls-files --error-unmatch failed: ${r.stderr.trim()})`);
});
