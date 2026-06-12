/**
 * newproject-schema.mjs — structured-envelope schemas + validators for the four
 * engine outputs of `taskctl new-project` (WP5 Stage 5b, Suggestion 4).
 *
 * Each engine step instructs the engine to emit a small JSON envelope inside a
 * fenced ```json block. We EXTRACT that block from the (raw-tee-accumulated)
 * stdout / captured artifact, JSON.parse it, and VALIDATE it against the schema
 * BEFORE rendering Markdown or acting (deriving slugs, writing task dirs). The
 * human-readable artifact (brainstorm.md / proposal.md / scaffold-plan.md) is
 * RENDERED FROM the validated structure, never scraped. A schema violation →
 * the caller stops the flow at the current step (resumable) and writes nothing
 * further.
 *
 * The validators are intentionally small & dependency-free (strictNullChecks is
 * OFF project-wide): they check the SHAPE the downstream code relies on and
 * return `{ ok, value?, error? }` rather than throwing, so the caller controls
 * the stop-and-report.
 */

/**
 * Pull the FIRST fenced ```json (or ```jsonc) block out of raw text and parse
 * it. Falls back to parsing the whole trimmed text as JSON when there is no
 * fence (the fake replay script emits a bare envelope). Returns
 * `{ ok:true, value }` or `{ ok:false, error }`.
 * @param {string} text
 */
export function extractEnvelope(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'empty engine output (no JSON envelope found)' };
  }
  const fence = text.match(/```(?:json|jsonc)\s*\n([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  let parsed;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch (e) {
    return { ok: false, error: `engine output is not valid JSON: ${e.message}` };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'engine output JSON must be an object envelope.' };
  }
  return { ok: true, value: parsed };
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * brainstorm envelope: `{ questions: string[], assumptions: string[],
 * options: string[] }`. At least one question OR option keeps it useful; we
 * require all three keys to be string arrays (any may be empty except we want
 * SOME signal — so require at least one non-empty among questions/options).
 */
export function validateBrainstorm(env) {
  if (!isStringArray(env.questions)) return fail('brainstorm.questions must be an array of strings');
  if (!isStringArray(env.assumptions)) return fail('brainstorm.assumptions must be an array of strings');
  if (!isStringArray(env.options)) return fail('brainstorm.options must be an array of strings');
  if (env.questions.length === 0 && env.options.length === 0) {
    return fail('brainstorm envelope must contain at least one question or option');
  }
  return ok({ questions: env.questions, assumptions: env.assumptions, options: env.options });
}

/**
 * proposal envelope: `{ recommended: string, options: [{ id, stack, rationale }] }`
 * with ≥2 options and `recommended` matching one option `id`.
 */
export function validateProposal(env) {
  if (!Array.isArray(env.options) || env.options.length < 2) {
    return fail('proposal must offer at least 2 options');
  }
  const options = [];
  const ids = new Set();
  for (const [i, o] of env.options.entries()) {
    if (o == null || typeof o !== 'object' || Array.isArray(o)) return fail(`proposal.options[${i}] must be an object`);
    if (!isNonEmptyString(o.id)) return fail(`proposal.options[${i}].id must be a non-empty string`);
    if (!isNonEmptyString(o.stack)) return fail(`proposal.options[${i}].stack must be a non-empty string`);
    if (!isNonEmptyString(o.rationale)) return fail(`proposal.options[${i}].rationale must be a non-empty string`);
    if (ids.has(o.id)) return fail(`proposal.options has a duplicate id "${o.id}"`);
    ids.add(o.id);
    options.push({ id: o.id, stack: o.stack, rationale: o.rationale });
  }
  if (!isNonEmptyString(env.recommended)) return fail('proposal.recommended must be a non-empty string');
  if (!ids.has(env.recommended)) return fail(`proposal.recommended "${env.recommended}" is not one of the option ids`);
  return ok({ recommended: env.recommended, options });
}

/**
 * scaffold envelope: `{ commands: string[], fileTree: string[] }`. commands are
 * the native-generator command lines (PRINTED, never executed); fileTree is the
 * intended layout. At least one command is required (an empty scaffold is a
 * no-op that would strand await_scaffold).
 */
export function validateScaffold(env) {
  if (!isStringArray(env.commands) || env.commands.length === 0) {
    return fail('scaffold.commands must be a non-empty array of strings');
  }
  if (env.fileTree != null && !isStringArray(env.fileTree)) {
    return fail('scaffold.fileTree must be an array of strings when present');
  }
  return ok({ commands: env.commands, fileTree: env.fileTree ?? [] });
}

/**
 * backlog envelope: `{ tasks: [{ slug, title, desc }] }` with ≥1 task. `slug` is
 * the SHORT label (validated/normalized by the caller into
 * `<project>-NN-<short>`); title/desc are free text.
 */
export function validateBacklog(env) {
  if (!Array.isArray(env.tasks) || env.tasks.length === 0) {
    return fail('backlog.tasks must be a non-empty array');
  }
  const tasks = [];
  for (const [i, t] of env.tasks.entries()) {
    if (t == null || typeof t !== 'object' || Array.isArray(t)) return fail(`backlog.tasks[${i}] must be an object`);
    if (!isNonEmptyString(t.slug)) return fail(`backlog.tasks[${i}].slug must be a non-empty string`);
    if (!isNonEmptyString(t.title)) return fail(`backlog.tasks[${i}].title must be a non-empty string`);
    const desc = typeof t.desc === 'string' ? t.desc : '';
    tasks.push({ slug: t.slug, title: t.title, desc });
  }
  return ok({ tasks });
}

function ok(value) { return { ok: true, value }; }
function fail(error) { return { ok: false, error }; }

/**
 * Parse + validate in one step: extract the envelope from raw engine output and
 * run the named validator. Returns `{ ok, value?, error? }`.
 * @param {'brainstorm'|'proposal'|'scaffold'|'backlog'} kind
 * @param {string} raw
 */
export function parseAndValidate(kind, raw) {
  const extracted = extractEnvelope(raw);
  if (!extracted.ok) return extracted;
  switch (kind) {
    case 'brainstorm': return validateBrainstorm(extracted.value);
    case 'proposal': return validateProposal(extracted.value);
    case 'scaffold': return validateScaffold(extracted.value);
    case 'backlog': return validateBacklog(extracted.value);
    default: return fail(`unknown envelope kind "${kind}"`);
  }
}
