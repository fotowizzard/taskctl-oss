/**
 * Builds context.md from Jira issue data.
 * Pure data transformation — no LLM involved.
 *
 * Project-specific sections (Project Context, Constraints, Relevant Code Areas)
 * are driven by a `ctxOpts` bundle (WP2 Stage 2b) — `{projectContext,
 * constraints, codeAreas, grace}` — so this module carries NO origin-project
 * literals. When `ctxOpts` is empty (the default), those sections are omitted
 * or fall back to a neutral stub.
 *
 * GRACE context blocks are OPT-IN: they are injected only when `ctxOpts.grace`
 * is non-null (GRACE explicitly enabled), based on governed modules in the
 * repo's docs/development-plan.xml and only when the repo is on the configured
 * pilot branch. With GRACE off (the default), the context is GRACE-free. The
 * block-formatting helper (`buildGraceContextBlock`) lives in grace.mjs; this
 * module computes the governed module IDs and passes them in (one-way edge
 * context-builder → grace).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { buildGraceContextBlock } from './grace.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Optional default repo root for the governed-path helpers (loadGovernedModules)
 * when a caller omits an explicit `repoRoot`. With GRACE off by default, the
 * GRACE injection in buildContextMd never reaches this default — the repoRoot
 * for governed parsing arrives via `ctxOpts.grace.repoRoot` and is used only
 * when GRACE is explicitly enabled. No origin-project literal here (WP2 Stage
 * 2b): the default is null unless `GRACE_REPO_ROOT` (or the legacy `VP_REPO_ROOT`)
 * env var is set, in which case it is honored as a convenience override.
 */
export const DEFAULT_GOVERNED_REPO_ROOT =
  (process.env.GRACE_REPO_ROOT && process.env.GRACE_REPO_ROOT.trim()) ||
  (process.env.VP_REPO_ROOT && process.env.VP_REPO_ROOT.trim()) ||
  null;

// NOTE: `GRACE_PILOT_BRANCH`, `PILOT_MODULE_IDS`, `buildGraceContextBlock`, and
// the legacy pilot-only helpers (computePilotModulePaths / PILOT_MODULE_PATHS /
// isPilotPath / hasPilotPaths) moved to grace.mjs (WP2 Stage 2a). The only edge
// between the modules is the import above — context-builder → grace, one-way.
// The pilot branch name now flows through `ctxOpts.grace.pilotBranch`.

// ---------------------------------------------------------------------------
// Governed-module parsing (from docs/development-plan.xml)
// ---------------------------------------------------------------------------

/**
 * Module-level cache keyed by the resolved (absolute, forward-slash) repo
 * root. Each entry stores the parsed Map plus the XML file's mtimeMs so we
 * can transparently invalidate when the XML changes on disk.
 *
 * @type {Map<string, { mtimeMs: number, map: Map<string, string> }>}
 */
const _governedCache = new Map();

/**
 * Regex that matches module opening tags like `<M-DOC-EXTRACTION ...>`.
 * Captures the full M-ID as group 1. Anchored at word-start to avoid
 * matching things like `<export-M-...>`.
 */
const MODULE_OPEN_RE = /<(M-[A-Z][A-Z0-9-]*)\b[^>]*>/g;

/**
 * Regex that matches a <target> block's contents.
 */
const TARGET_BLOCK_RE = /<target\b[^>]*>([\s\S]*?)<\/target>/g;

/**
 * Regex that matches individual <source>PATH</source> entries inside a
 * <target> block. Captures the raw path string.
 */
const SOURCE_ENTRY_RE = /<source\b[^>]*>([\s\S]*?)<\/source>/g;

/**
 * Normalize a path-prefix string for consistent comparison.
 * Trims whitespace, replaces backslashes with forward-slashes, lowercases.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizePath(raw) {
  return String(raw).replace(/\\/g, '/').trim().toLowerCase();
}

/**
 * Returns true if the given raw <source> value looks like a real source
 * path rather than a placeholder like `(none — ...)`. The XML is allowed
 * to carry explanatory text instead of a path for declared-empty modules.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isPlausiblePath(raw) {
  const s = String(raw).trim();
  if (!s) return false;
  if (s.startsWith('(')) return false;
  // Must contain a path separator or a file-extension-like suffix.
  if (/[\/\\]/.test(s)) return true;
  if (/\.[a-z0-9]+$/i.test(s)) return true;
  return false;
}

/**
 * Detect the current git branch of a repository by running
 * `git rev-parse --abbrev-ref HEAD`. Returns `null` on any failure
 * (path doesn't exist, not a git repo, git not on PATH, etc.).
 *
 * @param {string} repoRoot  Absolute path to the repo root.
 * @returns {string | null}
 */
export function detectRepoBranch(repoRoot) {
  if (!repoRoot) return null;
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branch = String(out).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Parse docs/development-plan.xml and return a Map from governed
 * path-prefix to the M-ID of the module that owns it.
 *
 * Uses regex-based parsing (no npm dependency). The XML structure is
 * stable from Wave 4 onwards: each module is a direct child element of
 * <Modules> whose tag name starts with `M-`, containing one or more
 * <target> blocks with one or more <source>PATH</source> entries.
 *
 * Entries are cached per-repoRoot and invalidated when the XML's mtime
 * changes on disk.
 *
 * If the file is missing or unparseable, returns an empty Map and logs
 * a single warning to stderr — callers gracefully degrade to "no GRACE
 * injection".
 *
 * @param {string} [repoRoot]  Absolute path to the governed repo root (defaults
 *                             to DEFAULT_GOVERNED_REPO_ROOT, which is null
 *                             unless GRACE_REPO_ROOT/VP_REPO_ROOT env is set).
 * @returns {Map<string, string>}  key = normalized path prefix, value = M-ID.
 */
export function loadGovernedModules(repoRoot = DEFAULT_GOVERNED_REPO_ROOT) {
  if (!repoRoot) return new Map();

  const normalizedRoot = String(repoRoot).replace(/\\/g, '/').replace(/\/$/, '');
  const xmlPath = path.join(normalizedRoot, 'docs', 'development-plan.xml');

  let stat;
  try {
    stat = fs.statSync(xmlPath);
  } catch {
    process.stderr.write(
      `[context-builder] warning: development-plan.xml not found at ${xmlPath} — GRACE context disabled.\n`,
    );
    return new Map();
  }

  const cached = _governedCache.get(normalizedRoot);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.map;
  }

  let xml;
  try {
    xml = fs.readFileSync(xmlPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[context-builder] warning: failed to read development-plan.xml (${err.message}) — GRACE context disabled.\n`,
    );
    return new Map();
  }

  const result = new Map();

  // Find each module opening tag, then slice up to its matching </M-...>
  // closing tag so we only look at that module's sources.
  MODULE_OPEN_RE.lastIndex = 0;
  let moduleMatch;
  while ((moduleMatch = MODULE_OPEN_RE.exec(xml)) !== null) {
    const moduleId = moduleMatch[1];
    const moduleStart = MODULE_OPEN_RE.lastIndex; // after the opening tag
    const closeTag = `</${moduleId}>`;
    const moduleEnd = xml.indexOf(closeTag, moduleStart);
    if (moduleEnd === -1) continue;
    const moduleBody = xml.slice(moduleStart, moduleEnd);

    // Enumerate <target> ... </target> blocks inside this module.
    TARGET_BLOCK_RE.lastIndex = 0;
    let targetMatch;
    while ((targetMatch = TARGET_BLOCK_RE.exec(moduleBody)) !== null) {
      const targetBody = targetMatch[1];
      SOURCE_ENTRY_RE.lastIndex = 0;
      let sourceMatch;
      while ((sourceMatch = SOURCE_ENTRY_RE.exec(targetBody)) !== null) {
        const raw = sourceMatch[1];
        if (!isPlausiblePath(raw)) continue;
        const key = normalizePath(raw);
        // Do not overwrite an existing mapping — first module to claim a
        // path wins, which mirrors the authoring order in the XML.
        if (!result.has(key)) {
          result.set(key, moduleId);
        }
      }
    }
  }

  _governedCache.set(normalizedRoot, { mtimeMs: stat.mtimeMs, map: result });
  return result;
}

/**
 * Returns the M-ID of the governed module that owns the given filepath,
 * or `null` if the path is not under any governed prefix.
 *
 * Matching is prefix-based after normalization (forward-slashes,
 * lowercase) and handles both directions:
 *
 *   - filepath is a specific file under a governed directory-prefix
 *     (e.g. `src/services/document-extraction/index.ts` vs governed
 *     prefix `src/services/document-extraction/`): filepath contains
 *     the governed prefix → match.
 *   - filepath is itself a directory-prefix and at least one governed
 *     entry lives under it (e.g. `src/services/document-extraction/`
 *     vs governed entry `src/services/document-extraction/index.ts`):
 *     the governed entry contains the filepath → match.
 *
 * Longest-match wins across both directions so a nested governed entry
 * always beats a shallower one.
 *
 * @param {string} filepath
 * @param {Map<string, string>} [governedMap]  Optional pre-loaded map.
 * @returns {string | null}
 */
export function isGovernedPath(filepath, governedMap) {
  if (!filepath) return null;
  const map = governedMap ?? loadGovernedModules();
  if (!map || map.size === 0) return null;

  const norm = normalizePath(filepath);
  // Ensure directory-prefix filepaths end with a trailing slash so the
  // prefix-under-filepath direction of the match is unambiguous.
  const normDir = norm.endsWith('/') ? norm : norm + '/';

  let best = null;
  let bestLen = -1;
  for (const [prefix, moduleId] of map.entries()) {
    // Direction A: filepath is specific, prefix is a directory the
    // filepath lives under. Governed directory prefixes in the map
    // always end in '/' by authoring convention.
    // Direction B: filepath is itself a directory prefix and the
    // governed entry is a file underneath it.
    const matches = norm.includes(prefix) || prefix.startsWith(normDir);
    if (!matches) continue;
    if (prefix.length > bestLen) {
      best = moduleId;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Returns a deduped Set of M-IDs that cover any of the given filepaths.
 *
 * @param {string[]} filepaths
 * @param {Map<string, string>} [governedMap]
 * @returns {Set<string>}
 */
export function getModuleIdsForPaths(filepaths, governedMap) {
  const set = new Set();
  if (!filepaths || filepaths.length === 0) return set;
  const map = governedMap ?? loadGovernedModules();
  if (!map || map.size === 0) return set;
  for (const fp of filepaths) {
    const id = isGovernedPath(fp, map);
    if (id) set.add(id);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Project-section renderers (single source of truth shared by both producers:
// buildContextMd [Jira] and the local context.md.tmpl render path) — WP2 2b C4.
// ---------------------------------------------------------------------------

/**
 * Render the "## Project Context" block from config lines, or '' when empty.
 * @param {string[]} [projectContext]
 * @returns {string} block text (no trailing newline) or '' when omitted
 */
export function renderProjectContextBlock(projectContext = []) {
  if (!Array.isArray(projectContext) || projectContext.length === 0) return '';
  return ['## Project Context', ...projectContext].join('\n');
}

/**
 * Render the "## Constraints" block from config lines, or '' when empty.
 * @param {string[]} [constraints]
 * @returns {string} block text (no trailing newline) or '' when omitted
 */
export function renderConstraintsBlock(constraints = []) {
  if (!Array.isArray(constraints) || constraints.length === 0) return '';
  return ['## Constraints', ...constraints].join('\n');
}

/**
 * Render the bullet list under "## Relevant Code Areas".
 * @param {string[]} areas
 * @returns {string}
 */
export function renderCodeAreasList(areas) {
  return (areas ?? []).map((a) => `- ${a}`).join('\n');
}

// ---------------------------------------------------------------------------
// context.md builder
// ---------------------------------------------------------------------------

/**
 * Build context.md from a Jira issue + its related data.
 *
 * WP2 Stage 2b — atomic signature: `(issue, ctx, ctxOpts)`. The former trailing
 * positional args are bundled into `ctx`; the project-specific sections are
 * driven by `ctxOpts` so this module carries no origin-project literals.
 *
 * @param {object} issue
 * @param {object} [ctx]  Jira-derived context bundle.
 * @param {Array}  [ctx.comments]
 * @param {Array}  [ctx.links]
 * @param {object} [ctx.linkedDetails]
 * @param {Array}  [ctx.attachments]
 * @param {object} [ctx.linkedComments]
 * @param {object} [ctxOpts]  Project-neutral context options (all optional).
 * @param {string[]} [ctxOpts.projectContext]  verbatim "## Project Context" lines; omitted when empty.
 * @param {string[]} [ctxOpts.constraints]     verbatim "## Constraints" lines; omitted when empty.
 * @param {Record<string,string[]>} [ctxOpts.codeAreas]  keyword→paths map for guessCodeAreas; stub fallback when empty.
 * @param {{repoRoot:string, pilotBranch:string}|null} [ctxOpts.grace]
 *        When `null`/absent (the default = GRACE disabled), NO governed-module
 *        probe, branch detection, block, or note is emitted — context.md is
 *        GRACE-free. When non-null (GRACE explicitly enabled), the governed-path
 *        parsing runs against `grace.repoRoot` and the GRACE block is injected
 *        when the repo is on `grace.pilotBranch`.
 */
export function buildContextMd(issue, ctx = {}, ctxOpts = {}) {
  const {
    comments = [],
    links = [],
    linkedDetails = {},
    attachments = [],
    linkedComments = {},
  } = ctx ?? {};
  const projectContext = ctxOpts?.projectContext ?? [];
  const constraints = ctxOpts?.constraints ?? [];
  const codeAreas = ctxOpts?.codeAreas ?? {};
  const graceOpts = ctxOpts?.grace ?? null;

  const f = issue.fields;
  const lines = [];

  lines.push(`# ${issue.key}: ${f.summary ?? 'No summary'}`);
  lines.push('');

  // Jira data
  lines.push('## Jira Data');
  lines.push(`- **Type:** ${f.issuetype?.name ?? 'Unknown'}`);
  lines.push(`- **Status:** ${f.status?.name ?? 'Unknown'}`);
  lines.push(`- **Priority:** ${f.priority?.name ?? 'Unknown'}`);
  lines.push(`- **Assignee:** ${f.assignee?.displayName ?? 'Unassigned'}`);
  lines.push(`- **Sprint:** ${extractSprintName(f.customfield_10020) ?? 'None'}`);
  lines.push(`- **Epic/Parent:** ${f.parent?.key ?? 'None'}`);
  lines.push(`- **Labels:** ${(f.labels ?? []).join(', ') || 'None'}`);
  lines.push('');

  // Description and Acceptance Criteria
  const descriptionText = adfToPlainText(f.description);
  const { body: descBody, ac } = splitDescriptionAndAC(descriptionText);

  lines.push('## Description');
  lines.push(descBody);
  lines.push('');

  if (ac) {
    lines.push('## Acceptance Criteria');
    lines.push(ac);
    lines.push('');
  }

  // Linked issues
  lines.push('## Linked Issues');
  const grouped = groupLinks(links);
  if (grouped.blocks.length) lines.push(`- Blocks: ${grouped.blocks.join(', ')}`);
  if (grouped.blockedBy.length) lines.push(`- Blocked by: ${grouped.blockedBy.join(', ')}`);
  if (grouped.related.length) lines.push(`- Related: ${grouped.related.join(', ')}`);
  if (!grouped.blocks.length && !grouped.blockedBy.length && !grouped.related.length) {
    lines.push('- None');
  }
  lines.push('');

  // Linked issue details
  const linkedKeys = Object.keys(linkedDetails);
  if (linkedKeys.length > 0) {
    lines.push('## Linked Issue Details');
    for (const key of linkedKeys) {
      const li = linkedDetails[key];
      const lf = li?.fields;
      if (!lf) continue;
      lines.push(`### ${key}: ${lf.summary ?? 'No summary'}`);
      lines.push(`- **Type:** ${lf.issuetype?.name ?? 'Unknown'} | **Status:** ${lf.status?.name ?? 'Unknown'}`);
      const desc = adfToPlainText(lf.description);
      if (desc && desc !== '(empty)') {
        // Truncate long descriptions to keep context manageable
        const truncated = desc.length > 500 ? desc.slice(0, 500) + '...' : desc;
        lines.push(truncated);
      }
      lines.push('');
    }
  }

  // Attachments
  if (attachments.length > 0) {
    lines.push('## Attachments');
    for (const att of attachments) {
      const sizeKb = ((att.size ?? 0) / 1024).toFixed(0);
      const isImage = (att.mimeType ?? '').startsWith('image/');
      lines.push(`- **${att.filename}** (${sizeKb} KB${isImage ? ', image' : ''}) → \`attachments/${att.filename}\``);
    }
    lines.push('');
  }

  // Comments (this ticket)
  if (comments.length > 0) {
    lines.push(`## Comments (${issue.key})`);
    for (const c of comments) {
      const author = c.author?.displayName ?? 'Unknown';
      const date = c.created ? new Date(c.created).toISOString().split('T')[0] : '';
      lines.push(`### ${author} (${date})`);
      lines.push(adfToPlainText(c.body));
      lines.push('');
    }
  }

  // Comments from linked issues
  const linkedCommentKeys = Object.keys(linkedComments);
  if (linkedCommentKeys.length > 0) {
    for (const key of linkedCommentKeys) {
      const lComments = linkedComments[key];
      if (!lComments?.length) continue;
      lines.push(`## Comments (${key})`);
      for (const c of lComments) {
        const author = c.author?.displayName ?? 'Unknown';
        const date = c.created ? new Date(c.created).toISOString().split('T')[0] : '';
        lines.push(`### ${author} (${date})`);
        lines.push(adfToPlainText(c.body));
        lines.push('');
      }
    }
  }

  // Project context — verbatim from config (WP2 Stage 2b). Omitted when empty
  // so a project that supplies none gets a clean, project-neutral context.md.
  const projectContextBlock = renderProjectContextBlock(projectContext);
  if (projectContextBlock) {
    lines.push(projectContextBlock);
    lines.push('');
  }

  // Relevant code areas (heuristic based on labels and summary)
  lines.push('## Relevant Code Areas');
  const areas = guessCodeAreas(f.summary ?? '', f.labels ?? [], codeAreas);
  for (const area of areas) {
    lines.push(`- ${area}`);
  }
  lines.push('');

  // ---------------------------------------------------------------------
  // GRACE Core-aware injection (WP2 Stage 2a: gated on graceOpts)
  //
  // Only runs when `graceOpts` is non-null (GRACE explicitly enabled).
  // Default `null` → no governed-module probe, no branch detection, no
  // block, no note: context.md is GRACE-free.
  //
  // The governed-path parser helpers (loadGovernedModules /
  // getModuleIdsForPaths) STAY here and run HERE; only the resulting
  // moduleIds are handed to grace.buildGraceContextBlock (one-way edge
  // context-builder → grace — grace.mjs imports nothing back).
  //
  // Inject the block when (a) ≥1 governed path is detected among `areas`
  // AND (b) the repo is on graceOpts.pilotBranch. When governed paths exist
  // but the branch is not pilot, emit a brief note instead.
  // ---------------------------------------------------------------------
  if (graceOpts) {
    const repoRoot = graceOpts.repoRoot;
    const pilotBranch = graceOpts.pilotBranch;
    const governedMap = loadGovernedModules(repoRoot);
    const moduleIds = getModuleIdsForPaths(areas, governedMap);

    if (moduleIds.size > 0) {
      const branch = detectRepoBranch(repoRoot);
      if (branch === pilotBranch) {
        lines.push(buildGraceContextBlock(repoRoot, moduleIds));
      } else {
        lines.push('');
        lines.push(
          `> Note: task touches governed-module paths but repo branch is \`${branch ?? 'unknown'}\` — GRACE governance not active on this branch. Switch to \`${pilotBranch}\` to engage Core-aware mode.`,
        );
        lines.push('');
      }
    }
  }

  // Constraints — verbatim from config (WP2 Stage 2b). Omitted when empty.
  const constraintsBlock = renderConstraintsBlock(constraints);
  if (constraintsBlock) {
    lines.push(constraintsBlock);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSprintName(sprintField) {
  if (!sprintField) return null;
  if (Array.isArray(sprintField)) {
    const active = sprintField.find((s) => s.state === 'active');
    return (active ?? sprintField[0])?.name ?? null;
  }
  return sprintField.name ?? null;
}

function adfToPlainText(adfNode) {
  if (!adfNode) return '(empty)';
  if (typeof adfNode === 'string') return adfNode;
  if (adfNode.type === 'text') return adfNode.text ?? '';
  if (adfNode.content && Array.isArray(adfNode.content)) {
    const separator =
      adfNode.type === 'doc' ? '\n\n' :
      adfNode.type === 'paragraph' || adfNode.type === 'heading' ? '' :
      adfNode.type === 'listItem' ? '' :
      adfNode.type === 'bulletList' || adfNode.type === 'orderedList' ? '\n' :
      '';
    const parts = adfNode.content.map((child) => {
      if (child.type === 'paragraph' || child.type === 'heading') {
        return adfToPlainText(child);
      }
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        return child.content.map((li) => `- ${adfToPlainText(li)}`).join('\n');
      }
      return adfToPlainText(child);
    });
    return parts.join(separator);
  }
  return '';
}

/**
 * Split description text into body (before AC) and acceptance criteria.
 * AC section ends at the next heading-like line or known section marker.
 */
function splitDescriptionAndAC(text) {
  const markers = ['acceptance criteria', 'ac:', 'definition of done', 'done when'];
  const lower = text.toLowerCase();

  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx === -1) continue;

    const body = text.slice(0, idx).trim();
    const acStart = text.slice(idx);

    // Find end of AC section: next heading-like pattern or known section
    const endMarkers = ['\nreferences', '\nlinks', '\nnotes', '\nimplementation', '\ntechnical'];
    let acEnd = acStart.length;
    const acLower = acStart.toLowerCase();
    for (const end of endMarkers) {
      const endIdx = acLower.indexOf(end, marker.length);
      if (endIdx !== -1 && endIdx < acEnd) acEnd = endIdx;
    }

    const ac = acStart.slice(0, acEnd).trim();
    return { body, ac };
  }

  return { body: text, ac: null };
}

function groupLinks(links) {
  const blocks = [];
  const blockedBy = [];
  const related = [];

  for (const link of links) {
    const type = link.type?.name?.toLowerCase() ?? '';
    if (type === 'blocks' && link.outwardIssue) {
      blocks.push(link.outwardIssue.key);
    } else if (type === 'blocks' && link.inwardIssue) {
      blockedBy.push(link.inwardIssue.key);
    } else if (link.outwardIssue) {
      related.push(link.outwardIssue.key);
    } else if (link.inwardIssue) {
      related.push(link.inwardIssue.key);
    }
  }

  return { blocks, blockedBy, related };
}

/**
 * Heuristic keyword → representative paths for the "Relevant Code Areas"
 * section of context.md (and the initial governed-path sniff that determines
 * whether the GRACE block is injected).
 *
 * WP2 Stage 2b: this is a GENERIC stub. The origin-project's 39-entry keyword
 * map was removed; a per-project map is supplied via `config.codeAreas`
 * (keyword → string[]). When no map is provided (or no keyword matches), it
 * falls back to a single neutral entry. The real per-project derivation is the
 * WP3 profiler.
 *
 * @param {string} summary
 * @param {string[]} labels
 * @param {Record<string,string[]>} [codeAreas]  config-supplied keyword→paths map
 * @returns {string[]}
 */
export function guessCodeAreas(summary, labels, codeAreas = {}) {
  const areas = [];
  const text = `${summary} ${(labels ?? []).join(' ')}`.toLowerCase();

  const mapping = (codeAreas && typeof codeAreas === 'object' && !Array.isArray(codeAreas))
    ? codeAreas
    : {};

  for (const [keyword, paths] of Object.entries(mapping)) {
    if (Array.isArray(paths) && text.includes(String(keyword).toLowerCase())) {
      areas.push(...paths);
    }
  }

  if (areas.length === 0) {
    areas.push('src/ (determine based on task description)');
  }

  return [...new Set(areas)];
}
