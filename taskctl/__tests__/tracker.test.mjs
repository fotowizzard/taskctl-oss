/**
 * WP1 — tracker abstraction unit + integration tests.
 *   T-unit-3  : local adapter
 *   T-unit-5  : buildSyncState (first sync AND re-sync)
 *   T-int-2   : jira parity (stubbed JiraClient, attachments, state merge, deps)
 *   T-int-4   : buildContextMd composition only (byte-stable output) + a
 *               refresh-style re-derivation model — NO cmdRefresh stub. The REAL
 *               fetchFullJiraContext + cmdRefresh wiring are inspection-verified
 *               (audit-iter3), NOT runtime-covered here (see F2 note at T-int-4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  makeLocalTracker,
  makeJiraTracker,
  makeTracker,
  validateTrackerConfig,
  buildSyncState,
} from '../tracker.mjs';
import { renderTemplate, renderLocalState } from '../templating.mjs';
import { buildContextMd } from '../context-builder.mjs';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-trk-'));
}

// --- fixtures: minimal Jira issue + links shapes ---

function makeIssue(overrides = {}) {
  return {
    key: 'CP-1',
    fields: {
      summary: 'Fix the thing',
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      assignee: { displayName: 'Dev One' },
      issuetype: { name: 'Bug' },
      labels: [],
      description: { type: 'doc', version: 1, content: [] },
      issuelinks: [],
      attachment: [],
      ...overrides,
    },
  };
}

// links shaped for the real extractDependencies (link.type.name + inward/outward).
const FIXTURE_LINKS = [
  { type: { name: 'Blocks' }, inwardIssue: { key: 'CP-2' } },  // CP-2 blocks us → dependsOn
  { type: { name: 'Blocks' }, outwardIssue: { key: 'CP-3' } }, // we block CP-3 → blocks
];

// A faithful stand-in for the cli-local extractDependencies.
function extractDependencies(links, type) {
  const result = [];
  for (const link of links) {
    const linkType = link.type?.name?.toLowerCase() ?? '';
    if (type === 'blockedBy' && linkType === 'blocks' && link.inwardIssue) result.push(link.inwardIssue.key);
    if (type === 'blocks' && linkType === 'blocks' && link.outwardIssue) result.push(link.outwardIssue.key);
  }
  return result;
}

// A stand-in for the cli-local fetchFullJiraContext that exercises attachments.
function makeFetchFullJiraContext() {
  return async function fetchFullJiraContext(jira, issueKey, issue, taskDir) {
    const comments = await jira.fetchComments(issueKey);
    const links = await jira.fetchLinks(issueKey);
    const linkedDetails = await jira.fetchLinkedIssueDetails(links);
    const linkedComments = {};
    const attachments = issue.fields?.attachment ?? [];
    const downloadedAttachments = [];
    if (attachments.length > 0) {
      const attachDir = path.join(taskDir, 'attachments');
      await fs.mkdir(attachDir, { recursive: true });
      for (const att of attachments) {
        const buf = await jira.downloadAttachment(att.content);
        await fs.writeFile(path.join(attachDir, att.filename), buf);
        downloadedAttachments.push({ filename: att.filename, mimeType: att.mimeType, size: att.size });
      }
    }
    return { comments, links, linkedDetails, linkedComments, downloadedAttachments };
  };
}

// Stub JiraClient: records constructed creds + attachment downloads; no network.
function makeStubJiraClient(issue, { links = [], comments = [] } = {}) {
  const calls = { downloads: [], constructedWith: null };
  class StubJiraClient {
    constructor(creds) { calls.constructedWith = creds; }
    async fetchIssue() { return issue; }
    async fetchComments() { return comments; }
    async fetchLinks() { return links; }
    async fetchLinkedIssueDetails() { return {}; }
    async downloadAttachment(url) { calls.downloads.push(url); return Buffer.from(`bytes:${url}`); }
  }
  return { StubJiraClient, calls };
}

// ── T-unit-3: local adapter ──────────────────────────────────────────────

test('T-unit-3: local adapter seeds context + state, requiresJiraCreds false, no JiraClient', async () => {
  const tmp = await tmpDir();
  const tracker = makeLocalTracker({ type: 'local' }, { renderTemplate, renderLocalState });
  assert.equal(tracker.type, 'local');
  assert.equal(tracker.requiresJiraCreds, false);

  const { contextMd, state } = await tracker.seedContext('demo', tmp, { title: 'x', desc: 'y' }, null);
  assert.match(contextMd, /# demo: x/);
  assert.match(contextMd, /\by\b/);
  assert.equal(/\{\{\w+\}\}/.test(contextMd), false);
  assert.equal(state.stage, 'analysis');
  assert.equal(state.issueType, 'Task');
  assert.equal(state.issueKey, 'demo');

  // The adapter object exposes no JiraClient/jiraCreds reference (no network).
  assert.equal('JiraClient' in tracker, false);
  assert.equal('jiraCreds' in tracker, false);
});

test('makeTracker dispatches to local for type local; validateTrackerConfig rejects unknown', () => {
  const t = makeTracker({ type: 'local' }, { renderTemplate, renderLocalState });
  assert.equal(t.type, 'local');
  assert.throws(() => validateTrackerConfig({ type: 'jria' }), /Invalid tracker\.type/);
  assert.throws(() => validateTrackerConfig(null), /Invalid tracker\.type/);
});

// ── T-unit-5: buildSyncState first sync AND re-sync ───────────────────────

test('T-unit-5: buildSyncState first sync → fresh object from links', () => {
  const issue = makeIssue();
  const state = buildSyncState({
    issueKey: 'CP-1', issue, links: FIXTURE_LINKS, existingState: null, extractDependencies,
  });
  assert.equal(state.contextVersion, 1);
  assert.equal(state.stage, 'analysis');
  assert.equal(state.issueType, 'Bug'); // from issue.fields.issuetype.name
  assert.deepEqual(state.dependsOn, ['CP-2']);
  assert.deepEqual(state.blocks, ['CP-3']);
  assert.equal(state.planVersion, 0);
});

test('T-unit-5: buildSyncState re-sync → preserves lifecycle fields, bumps version', () => {
  const issue = makeIssue();
  const existingState = {
    issueKey: 'CP-1', issueType: 'Bug', stage: 'review', contextVersion: 4, planVersion: 3,
    branch: 'feature/x', activePR: 'PR-9', relatedPRs: ['PR-8'], merged: false,
    dependsOn: ['CP-99'], blocks: ['CP-88'], followups: ['CP-7'], derivedFrom: [],
    openQuestions: ['q1'], nextAction: 'final review',
    execution: { engine: 'codex', status: 'done', lastRunAt: '2026-01-01' },
  };
  const state = buildSyncState({
    issueKey: 'CP-1', issue, links: FIXTURE_LINKS, existingState, extractDependencies,
  });
  assert.equal(state.contextVersion, 5);            // bumped
  assert.equal(state.stage, 'review');              // preserved
  assert.equal(state.planVersion, 3);               // preserved
  assert.equal(state.branch, 'feature/x');          // preserved
  assert.equal(state.activePR, 'PR-9');             // preserved
  assert.deepEqual(state.execution, { engine: 'codex', status: 'done', lastRunAt: '2026-01-01' });
  assert.deepEqual(state.dependsOn, ['CP-99']);     // preserved (NOT re-derived) — cmdSync semantics
  assert.deepEqual(state.followups, ['CP-7']);      // preserved
  assert.equal(typeof state.lastSyncedFromJira, 'string'); // refreshed
});

// ── T-int-2: jira parity ─────────────────────────────────────────────────

test('T-int-2: jira adapter — contextMd byte-identical to buildContextMd, attachments downloaded', async () => {
  const tmp = await tmpDir();
  const issue = makeIssue({
    attachment: [{ filename: 'spec.pdf', mimeType: 'application/pdf', size: 2048, content: 'https://jira/att/1' }],
  });
  const { StubJiraClient, calls } = makeStubJiraClient(issue, { links: FIXTURE_LINKS });
  const fetchFullJiraContext = makeFetchFullJiraContext();

  const tracker = makeJiraTracker({ type: 'jira' }, {
    jiraCreds: { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' },
    JiraClient: StubJiraClient,
    fetchFullJiraContext,
    buildContextMd,
    buildSyncState,
    extractDependencies,
  });

  const { contextMd, state } = await tracker.seedContext('CP-1', tmp, {}, null);

  // 1. contextMd identical to a direct buildContextMd call on the same fixture.
  // WP2 Stage 2b atomic signature: (issue, ctx, ctxOpts).
  const direct = buildContextMd(issue, {
    comments: [],
    links: FIXTURE_LINKS,
    linkedDetails: {},
    attachments: [{ filename: 'spec.pdf', mimeType: 'application/pdf', size: 2048 }],
    linkedComments: {},
  });
  assert.equal(contextMd, direct);

  // 2. attachment handling: stub download invoked, file landed under tmp/attachments.
  assert.deepEqual(calls.downloads, ['https://jira/att/1']);
  assert.equal(fsSync.existsSync(path.join(tmp, 'attachments', 'spec.pdf')), true);

  // 3a. first-sync state.
  assert.equal(state.contextVersion, 1);

  // 4. dependency extraction matches.
  assert.deepEqual(state.dependsOn, extractDependencies(FIXTURE_LINKS, 'blockedBy'));
  assert.deepEqual(state.blocks, extractDependencies(FIXTURE_LINKS, 'blocks'));

  // creds threaded into the (stub) client.
  assert.deepEqual(calls.constructedWith, { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' });

  // NOTE (code inspection, not run here): cmdSync passes exactly {contextMd,state}
  // to its two fs.writeFile calls at cli.mjs — verified by reading cmdSync, not executed.
});

test('T-int-2: jira adapter — re-sync branch merges (contextVersion incremented, fields preserved)', async () => {
  const tmp = await tmpDir();
  const issue = makeIssue();
  const { StubJiraClient } = makeStubJiraClient(issue, { links: FIXTURE_LINKS });
  const tracker = makeJiraTracker({ type: 'jira' }, {
    jiraCreds: { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' },
    JiraClient: StubJiraClient,
    fetchFullJiraContext: makeFetchFullJiraContext(),
    buildContextMd,
    buildSyncState,
    extractDependencies,
  });
  const existingState = { contextVersion: 2, stage: 'running', planVersion: 1, branch: 'feature/y' };
  const { state } = await tracker.seedContext('CP-1', tmp, {}, existingState);
  assert.equal(state.contextVersion, 3);
  assert.equal(state.stage, 'running');
  assert.equal(state.branch, 'feature/y');
});

test('T-int-2: jira adapter throws on missing issue', async () => {
  const tmp = await tmpDir();
  class NotFoundClient { constructor() {} async fetchIssue() { return null; } }
  const tracker = makeJiraTracker({ type: 'jira' }, {
    jiraCreds: {}, JiraClient: NotFoundClient,
    fetchFullJiraContext: makeFetchFullJiraContext(), buildContextMd, buildSyncState, extractDependencies,
  });
  await assert.rejects(() => tracker.seedContext('CP-404', tmp, {}, null), /not found in Jira/);
});

// ── T-int-4: buildContextMd composition only (NOT runtime fetch coverage) ──
//
// SCOPE / LIMITATION (made explicit per code-review F2):
//   This test verifies the COMPOSITION of `buildContextMd` only — that the same
//   issue + links fixtures yield byte-stable context.md output. It does NOT
//   exercise the REAL `fetchFullJiraContext` helper (cli.mjs:902): the jira
//   adapter path injects a test-local reimplementation (see makeFetchFullJiraContext
//   at the top of this file, used by T-int-2), so a regression in the real helper
//   or in cmdRefresh's use of it would NOT be caught here.
//   The real `fetchFullJiraContext` wiring and `cmdRefresh`'s call into it are
//   INSPECTION-VERIFIED (per audit-iter3), NOT runtime-covered. audit-iter3 also
//   established that cmdRefresh keeps its OWN inline state-update logic and
//   RE-DERIVES dependsOn/blocks from links — it does NOT call buildSyncState; the
//   companion test below models that re-derivation independently.

test('T-int-4: buildContextMd composition is byte-stable (real fetchFullJiraContext is inspection-verified, NOT run here)', async () => {
  const issue = makeIssue();
  const ctxA = buildContextMd(issue, { comments: [], links: FIXTURE_LINKS });
  const ctxB = buildContextMd(issue, { comments: [], links: FIXTURE_LINKS });
  assert.equal(ctxA, ctxB);
  assert.match(ctxA, /Fix the thing/);
});

// ── T2b-int-refresh: New-C2 second caller — refresh == first-sync context.md ──
//
// cmdRefresh (the SECOND production buildContextMd caller) and the jira tracker
// (first-sync) must build the SAME (issue, ctx, ctxOpts) from the same fetched
// data. The critical mapping: fetchFullJiraContext returns `downloadedAttachments`,
// which BOTH producers place in the ctx `attachments` slot. This test reproduces
// both producers' ctx/ctxOpts construction and asserts byte-identical output
// (would have caught a wrong slot mapping in the cmdRefresh migration).
test('T2b-int-refresh: refresh-producer ctx mapping == first-sync ctx mapping (byte-identical context.md)', () => {
  const issue = makeIssue({
    attachment: [{ filename: 'spec.pdf', mimeType: 'application/pdf', size: 2048, content: 'u' }],
  });
  // What fetchFullJiraContext returns (shape shared by tracker + cmdRefresh).
  const fetched = {
    comments: [],
    links: FIXTURE_LINKS,
    linkedDetails: {},
    linkedComments: {},
    downloadedAttachments: [{ filename: 'spec.pdf', mimeType: 'application/pdf', size: 2048 }],
  };
  const ctxOpts = { projectContext: ['- Tech: Go'], constraints: ['- PRs only'], codeAreas: {}, grace: null };

  // First-sync producer (tracker.mjs seedContext) ctx build:
  const firstSyncCtx = {
    comments: fetched.comments,
    links: fetched.links,
    linkedDetails: fetched.linkedDetails,
    attachments: fetched.downloadedAttachments,
    linkedComments: fetched.linkedComments,
  };
  // Refresh producer (cmdRefresh) ctx build — must be the SAME mapping:
  const refreshCtx = {
    comments: fetched.comments,
    links: fetched.links,
    linkedDetails: fetched.linkedDetails,
    attachments: fetched.downloadedAttachments,
    linkedComments: fetched.linkedComments,
  };

  const firstSyncMd = buildContextMd(issue, firstSyncCtx, ctxOpts);
  const refreshMd = buildContextMd(issue, refreshCtx, ctxOpts);
  assert.equal(refreshMd, firstSyncMd, 'refresh and first-sync produce identical context.md');
  // The attachment landed via the `attachments` slot (not dropped).
  assert.match(refreshMd, /## Attachments[\s\S]*spec\.pdf/);
  // Project sections from ctxOpts present.
  assert.match(refreshMd, /## Project Context\n- Tech: Go/);
});

test('T-int-4: refresh-style state mutation RE-DERIVES deps from links (its own behavior, not buildSyncState)', () => {
  // Models cmdRefresh:2120-2124 inline merge: bump version, refresh sync ts,
  // RE-DERIVE dependsOn/blocks from CURRENT links, preserve stage.
  const state = { contextVersion: 4, stage: 'running', planVersion: 2, dependsOn: ['STALE'], blocks: ['STALE'] };
  state.contextVersion = (state.contextVersion ?? 0) + 1;
  state.lastSyncedFromJira = new Date().toISOString();
  state.dependsOn = extractDependencies(FIXTURE_LINKS, 'blockedBy');
  state.blocks = extractDependencies(FIXTURE_LINKS, 'blocks');
  assert.equal(state.contextVersion, 5);
  assert.equal(state.stage, 'running');                 // preserved
  assert.deepEqual(state.dependsOn, ['CP-2']);          // RE-DERIVED (differs from buildSyncState re-sync)
  assert.deepEqual(state.blocks, ['CP-3']);
  // Contrast with buildSyncState re-sync, which would PRESERVE ['STALE'].
  // This documents the deliberate semantic difference flagged in audit-iter3.
});

// ── T2a-int-grace: enabled-GRACE production-path regression (C-2a-1) ────────
//
// Code-review C-2a-1: buildContextMd gained an additive 7th `graceOpts` arg
// (default null) so the ## GRACE Context block injects only when non-null, but
// the two PRODUCTION callers (jira tracker seedContext + cmdRefresh) were left
// at 6 args → with grace.enabled:true the Jira context.md never got the block.
//
// These tests lock the fix at the production seam:
//   1. jira tracker seedContext forwards deps.graceOpts as the 7th arg →
//      enabled (governed pilot repo) yields ## GRACE Context; disabled (null)
//      omits it.
//   2. an adapter-level spy proves an ENABLED seedContext passes NON-NULL grace
//      options into buildContextMd (cheaper/deterministic, per the suggestion).
//   3. the cmdRefresh seam is modeled the same way the file already models
//      cmdRefresh (it is not exported): the EXACT graceOptsFromConfig(rcfg)
//      computation feeds the REAL buildContextMd against the governed repo →
//      enabled block present, disabled absent.
//
// Hermetic: a throwaway git repo + governed XML under fs.mkdtemp; no tracked
// file is mutated.

// Mirror of cli.mjs graceOptsFromConfig (the helper is not exported): non-null
// {repoRoot,pilotBranch} only when grace.enabled, else null.
function graceOptsFromConfig(rcfg) {
  return rcfg?.grace?.enabled
    ? { repoRoot: rcfg.grace.repoRoot, pilotBranch: rcfg.grace.pilotBranch }
    : null;
}

// Build a minimal governed repo on a CUSTOM pilot branch: docs/development-plan.xml
// maps src/services/document-extraction/ → M-DOC-EXTRACTION. A Jira summary about
// "document extraction" + a `document` label maps (via guessCodeAreas) to that
// governed path, so buildContextMd injects the block when on the pilot branch.
async function makeGovernedPilotRepo(pilotBranch = 'pilot-x') {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskctl-trk-grace-'));
  await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(repo, 'docs', 'development-plan.xml'),
    `<Modules>
      <M-DOC-EXTRACTION>
        <target><source>src/services/document-extraction/</source></target>
      </M-DOC-EXTRACTION>
    </Modules>`,
    'utf8',
  );
  const run = (cmd) => execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  run(`git init -b ${pilotBranch}`);
  run('git config user.email t@t');
  run('git config user.name t');
  run('git add -A');
  run('git commit -m init --no-gpg-sign');
  return repo;
}

const GRACE_ISSUE = makeIssue({ summary: 'Fix document extraction bug', labels: ['document'] });

test('T2a-int-grace: jira tracker seedContext INJECTS ## GRACE Context when grace enabled (governed pilot repo)', async () => {
  const repo = await makeGovernedPilotRepo('pilot-x');
  const tmp = await tmpDir();
  try {
    const { StubJiraClient } = makeStubJiraClient(GRACE_ISSUE, { links: [] });
    const tracker = makeJiraTracker({ type: 'jira' }, {
      jiraCreds: { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' },
      JiraClient: StubJiraClient,
      fetchFullJiraContext: makeFetchFullJiraContext(),
      buildContextMd, buildSyncState, extractDependencies,
      // What cmdSync threads via buildJiraTrackerDeps(config, buildCtxOpts(rcfg)).
      // codeAreas supplies the governed-path keyword so the sniff fires (Stage 2b
      // removed the built-in VP keyword map).
      ctxOpts: {
        codeAreas: { document: ['src/services/document-extraction/'] },
        grace: graceOptsFromConfig({ grace: { enabled: true, repoRoot: repo, pilotBranch: 'pilot-x' } }),
      },
    });
    const { contextMd } = await tracker.seedContext('CP-1', tmp, {}, null);
    assert.match(contextMd, /## GRACE Context/, 'enabled GRACE injects the block through seedContext');
    assert.match(contextMd, /M-DOC-EXTRACTION/, 'governed M-ID surfaced via the production seam');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('T2a-int-grace: jira tracker seedContext OMITS ## GRACE Context when grace disabled (graceOpts null)', async () => {
  const repo = await makeGovernedPilotRepo('pilot-x');
  const tmp = await tmpDir();
  try {
    const { StubJiraClient } = makeStubJiraClient(GRACE_ISSUE, { links: [] });
    const tracker = makeJiraTracker({ type: 'jira' }, {
      jiraCreds: { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' },
      JiraClient: StubJiraClient,
      fetchFullJiraContext: makeFetchFullJiraContext(),
      buildContextMd, buildSyncState, extractDependencies,
      // Disabled config → graceOptsFromConfig returns null (folded into ctxOpts.grace).
      ctxOpts: { grace: graceOptsFromConfig({ grace: { enabled: false, repoRoot: repo, pilotBranch: 'pilot-x' } }) },
    });
    const { contextMd } = await tracker.seedContext('CP-1', tmp, {}, null);
    assert.equal(/## GRACE Context/.test(contextMd), false, 'disabled GRACE omits the block');
    assert.equal(/governed-module/.test(contextMd), false, 'no governed-module note when disabled');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('T2a-int-grace: adapter-level — ENABLED seedContext passes NON-NULL grace options into buildContextMd', async () => {
  const tmp = await tmpDir();
  try {
    // Spy buildContextMd: capture the ctxOpts (3rd positional) the adapter forwards.
    // WP2 Stage 2b: grace opts are folded into ctxOpts.grace (was the 7th arg in 2a).
    let ctxOptsArg = 'UNSET';
    const spyBuildContextMd = (...args) => { ctxOptsArg = args[2]; return '## GRACE Context\n(stub)'; };
    const { StubJiraClient } = makeStubJiraClient(GRACE_ISSUE, { links: [] });
    const grace = { enabled: true, repoRoot: 'S:/some/repo', pilotBranch: 'pilot-x' };
    const tracker = makeJiraTracker({ type: 'jira' }, {
      jiraCreds: { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' },
      JiraClient: StubJiraClient,
      fetchFullJiraContext: makeFetchFullJiraContext(),
      buildContextMd: spyBuildContextMd, buildSyncState, extractDependencies,
      ctxOpts: { grace: graceOptsFromConfig({ grace }) },
    });
    await tracker.seedContext('CP-1', tmp, {}, null);
    assert.notEqual(ctxOptsArg, 'UNSET', 'buildContextMd received a ctxOpts (3rd positional) arg');
    assert.notEqual(ctxOptsArg?.grace, null, 'enabled production seedContext must pass NON-NULL grace options');
    assert.deepEqual(ctxOptsArg.grace, { repoRoot: 'S:/some/repo', pilotBranch: 'pilot-x' });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('T2a-int-grace: adapter-level — DISABLED seedContext passes NULL grace options into buildContextMd', async () => {
  const tmp = await tmpDir();
  try {
    let ctxOptsArg = 'UNSET';
    const spyBuildContextMd = (...args) => { ctxOptsArg = args[2]; return 'ctx'; };
    const { StubJiraClient } = makeStubJiraClient(GRACE_ISSUE, { links: [] });
    const tracker = makeJiraTracker({ type: 'jira' }, {
      jiraCreds: { baseUrl: 'b', email: 'e', token: 't', projectKey: 'CP' },
      JiraClient: StubJiraClient,
      fetchFullJiraContext: makeFetchFullJiraContext(),
      buildContextMd: spyBuildContextMd, buildSyncState, extractDependencies,
      ctxOpts: { grace: graceOptsFromConfig({ grace: { enabled: false } }) },
    });
    await tracker.seedContext('CP-1', tmp, {}, null);
    assert.equal(ctxOptsArg?.grace, null, 'disabled production seedContext must pass null grace (no behavior change)');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('T2a-int-grace: cmdRefresh seam — graceOptsFromConfig(rcfg) feeds REAL buildContextMd → enabled block, disabled absent', async () => {
  // cmdRefresh is not exported; the file already models its inline logic (see
  // T-int-4 above). WP2 Stage 2b: cmdRefresh now calls
  //   buildContextMd(issue, ctx, ctxOpts)
  // with grace folded into ctxOpts.grace. Reproduce that EXACT wiring.
  const repo = await makeGovernedPilotRepo('pilot-x');
  try {
    const enabledMd = buildContextMd(
      GRACE_ISSUE,
      { comments: [], links: [] },
      {
        codeAreas: { document: ['src/services/document-extraction/'] },
        grace: graceOptsFromConfig({ grace: { enabled: true, repoRoot: repo, pilotBranch: 'pilot-x' } }),
      },
    );
    assert.match(enabledMd, /## GRACE Context/, 'refresh seam injects the block when grace enabled');
    assert.match(enabledMd, /M-DOC-EXTRACTION/, 'governed M-ID surfaced on refresh');

    const disabledMd = buildContextMd(
      GRACE_ISSUE,
      { comments: [], links: [] },
      { grace: graceOptsFromConfig({ grace: { enabled: false, repoRoot: repo, pilotBranch: 'pilot-x' } }) },
    );
    assert.equal(/## GRACE Context/.test(disabledMd), false, 'refresh seam omits the block when grace disabled');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
