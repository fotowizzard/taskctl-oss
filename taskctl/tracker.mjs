/**
 * Task-source ("tracker") abstraction for taskctl (WP1).
 *
 * Two adapters:
 *   - `jira`  — wraps the existing JiraClient + fetchFullJiraContext +
 *               buildContextMd + the cmdSync state lifecycle. Zero rewrite of
 *               those internals: they arrive via DEPENDENCY INJECTION.
 *   - `local` — no network; seeds context.md/state.json from templates plus a
 *               caller-supplied title/description.
 *
 * IMPORTANT: this module imports NOTHING from cli.mjs. Every cli-local helper
 * (fetchFullJiraContext, extractDependencies, JiraClient, buildContextMd, the
 * template helpers) is passed in through `deps`, so there is no import cycle
 * (cli.mjs imports tracker.mjs, never the reverse).
 *
 * @typedef {{ type:'local'|'jira' }} TrackerConfig
 */

const KNOWN_TRACKER_TYPES = new Set(['local', 'jira']);

/**
 * Validate a tracker config shape; throw on unknown type / bad shape.
 * @param {TrackerConfig} cfg
 */
export function validateTrackerConfig(cfg) {
  if (!cfg || typeof cfg.type !== 'string' || !KNOWN_TRACKER_TYPES.has(cfg.type)) {
    throw new Error(
      `Invalid tracker.type ${JSON.stringify(cfg?.type)} — expected one of: ${[...KNOWN_TRACKER_TYPES].join(', ')}.`
    );
  }
  // No projectKey field in the WP1 contract — nothing else to validate here.
}

/**
 * Factory: build the adapter for the configured tracker type.
 *
 * @param {TrackerConfig} trackerCfg
 * @param {object} deps injected dependencies (see makeJiraTracker / makeLocalTracker)
 */
export function makeTracker(trackerCfg, deps) {
  validateTrackerConfig(trackerCfg);
  if (trackerCfg.type === 'jira') return makeJiraTracker(trackerCfg, deps);
  return makeLocalTracker(trackerCfg, deps);
}

/**
 * Jira adapter. Preserves first-sync vs. re-sync semantics via the injected
 * pure `buildSyncState`; wraps the existing context pipeline unchanged.
 *
 * deps: {
 *   jiraCreds,             // {baseUrl,email,token,projectKey} (projectKey ENV-ONLY)
 *   JiraClient,            // class, injected by caller
 *   fetchFullJiraContext,  // the cli.mjs-local helper, PASSED IN (never imported)
 *   buildContextMd,        // from context-builder.mjs, injected
 *   buildSyncState,        // pure state merge/fresh fn (below or injected)
 *   extractDependencies,   // injected (used by buildSyncState)
 *   ctxOpts,               // {projectContext,constraints,codeAreas,grace} —
 *                          // (WP2 Stage 2b): forwarded as buildContextMd's 3rd
 *                          // arg so project sections + the (opt-in) GRACE block
 *                          // are injected consistently; {} (default) → neutral,
 *                          // GRACE-free context.md.
 * }
 */
export function makeJiraTracker(cfg, deps) {
  const { jiraCreds, JiraClient, fetchFullJiraContext, buildContextMd, buildSyncState, extractDependencies, ctxOpts = {} } = deps;
  return {
    type: 'jira',
    requiresJiraCreds: true,
    /**
     * @param {string} issueKey
     * @param {string} taskDir
     * @param {object} _opts unused for jira
     * @param {object|null} existingState parsed state.json (re-sync) or null (first sync)
     * @returns {Promise<{contextMd:string, state:object, issue:object}>}
     */
    async seedContext(issueKey, taskDir, _opts, existingState) {
      const jira = new JiraClient(jiraCreds);
      const issue = await jira.fetchIssue(issueKey);
      if (!issue) throw new Error(`Issue ${issueKey} not found in Jira.`);
      const fetched = await fetchFullJiraContext(jira, issueKey, issue, taskDir);
      // WP2 Stage 2b atomic signature: (issue, ctx, ctxOpts). The fetched
      // attachments land in the `attachments` slot of the ctx bundle.
      const ctx = {
        comments: fetched.comments,
        links: fetched.links,
        linkedDetails: fetched.linkedDetails,
        attachments: fetched.downloadedAttachments,
        linkedComments: fetched.linkedComments,
      };
      const contextMd = buildContextMd(issue, ctx, ctxOpts);
      // SAME branch logic as the original cmdSync: merge if existingState, else fresh.
      const state = buildSyncState({ issueKey, issue, links: ctx.links, existingState, extractDependencies });
      return { contextMd, state, issue };
    },
  };
}

/**
 * Local adapter. No network. Renders templates (first-sync shape only).
 *
 * deps: {
 *   renderTemplate, renderLocalState,   // template helpers
 *   ctxOpts,                            // {projectContext,constraints,codeAreas} (WP2 2b)
 *   renderProjectContextBlock,          // from context-builder (injected) — single
 *   renderConstraintsBlock,             // source of truth shared with buildContextMd
 *   guessCodeAreas, renderCodeAreasList,
 * }
 * It holds NO JiraClient reference and constructs no Jira machinery. The
 * project-section renderers are injected (not imported) to keep the module
 * acyclic; cli.mjs passes context-builder's exported helpers.
 */
export function makeLocalTracker(cfg, deps) {
  const {
    renderTemplate,
    renderLocalState,
    ctxOpts = {},
    renderProjectContextBlock,
    renderConstraintsBlock,
    guessCodeAreas,
    renderCodeAreasList,
  } = deps;
  return {
    type: 'local',
    requiresJiraCreds: false,
    /**
     * @param {string} slug
     * @param {string} taskDir
     * @param {{title?:string, desc?:string}} opts
     * @param {object|null} _existingState unused: `new` refuses to clobber
     * @returns {Promise<{contextMd:string, state:object}>}
     */
    async seedContext(slug, taskDir, opts = {}, _existingState) {
      const title = opts.title ?? slug;
      const description = opts.desc ?? '(no description provided)';
      const now = new Date().toISOString();

      // Project sections come from config via the SAME renderers buildContextMd
      // uses (single source of truth). Tokens expand to project-neutral output:
      // omitted when unset; never an origin-project literal.
      const projectContext = ctxOpts?.projectContext ?? [];
      const constraints = ctxOpts?.constraints ?? [];
      const codeAreas = ctxOpts?.codeAreas ?? {};

      // PROJECT_CONTEXT: block + a trailing blank line so the next heading
      // stands alone; empty → '' (the heading follows the existing blank line).
      const pcBlock = renderProjectContextBlock ? renderProjectContextBlock(projectContext) : '';
      const PROJECT_CONTEXT = pcBlock ? `${pcBlock}\n\n` : '';

      // CODE_AREAS: bullet list derived from the title/labels (local: no labels).
      const areas = guessCodeAreas ? guessCodeAreas(title, [], codeAreas) : [];
      const CODE_AREAS = (renderCodeAreasList ? renderCodeAreasList(areas) : '') || '- (none)';

      // CONSTRAINTS: leading on its own line after CODE_AREAS; empty → ''.
      const cBlock = renderConstraintsBlock ? renderConstraintsBlock(constraints) : '';
      const CONSTRAINTS = cBlock ? cBlock : '';

      const contextMd = await renderTemplate('context.md.tmpl', {
        ISSUE_KEY: slug,
        SUMMARY: title,
        STATUS: 'local',
        PRIORITY: 'None',
        ASSIGNEE: 'Unassigned',
        SPRINT: 'None',
        PARENT: 'None',
        LABELS: 'None',
        DESCRIPTION: description,
        ACCEPTANCE_CRITERIA: '(none)',
        BLOCKS: 'None',
        BLOCKED_BY: 'None',
        RELATED: 'None',
        COMMENTS: '(none)',
        PROJECT_CONTEXT,
        CODE_AREAS,
        CONSTRAINTS,
      });
      const state = renderLocalState(slug, now);
      return { contextMd, state };
    },
  };
}

/**
 * Pure state builder — a semantic extraction of the original cmdSync state
 * lifecycle. The filesystem read/parse of state.json lives in the CALLER; this
 * helper receives `existingState` (parsed object or null) and decides
 * merge-vs-fresh. No fs, no Jira client — directly unit-testable.
 *
 * RE-SYNC (existingState present): bump contextVersion, refresh issueType +
 * lastSyncedFromJira, PRESERVE every lifecycle field via spread
 * (stage/planVersion/branch/activePR/relatedPRs/merged/dependsOn/blocks/
 * followups/derivedFrom/openQuestions/nextAction/execution).
 *
 * FIRST SYNC (existingState null): fresh object with dependsOn/blocks derived
 * from the issue links via the injected `extractDependencies`.
 *
 * @param {object} p
 * @param {string} p.issueKey
 * @param {object} p.issue Jira issue object
 * @param {Array} p.links Jira issue links
 * @param {object|null} p.existingState
 * @param {(links:Array, type:string)=>string[]} p.extractDependencies
 * @returns {object}
 */
export function buildSyncState({ issueKey, issue, links, existingState, extractDependencies }) {
  if (existingState) {
    return {
      ...existingState,
      contextVersion: (existingState.contextVersion ?? 0) + 1,
      issueType: issue.fields?.issuetype?.name ?? existingState.issueType ?? 'Task',
      lastSyncedFromJira: new Date().toISOString(),
    };
  }
  return {
    issueKey,
    issueType: issue.fields?.issuetype?.name ?? 'Task',
    stage: 'analysis',
    contextVersion: 1,
    planVersion: 0,
    branch: null,
    activePR: null,
    relatedPRs: [],
    merged: false,
    dependsOn: extractDependencies(links, 'blockedBy'),
    blocks: extractDependencies(links, 'blocks'),
    followups: [],
    derivedFrom: [],
    lastSyncedFromJira: new Date().toISOString(),
    lastSyncedFromRepo: null,
    openQuestions: [],
    nextAction: 'build plan',
    execution: { engine: null, status: 'idle', lastRunAt: null },
  };
}
