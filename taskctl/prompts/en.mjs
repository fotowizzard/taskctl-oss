/**
 * English prompt pack (default) — WP2 Stage 2b.
 *
 * This pack carries PROJECT-NEUTRAL prompt semantics for every taskctl stage
 * (plan / plan-review / run / review / fix / revise / replan). It deliberately
 * does NOT assume any particular stack, names no origin project (it says "the
 * project"), and references no project-specific doc files. Project-specific
 * guidance, if any, flows in via `config.projectContext` / `config.constraints`
 * (already injected into context.md) — the prompts simply point the agent at
 * context.md to read it.
 *
 * Each builder returns an ARRAY OF LINES (joined by the caller) so the
 * per-command prompt structure is identical across language packs; only the
 * phrasing differs. `O` is the orchestration root (forward-slash form);
 * `issueKey` is the task id.
 *
 * The Russian pack (ru.mjs) mirrors this structure with the SAME neutral
 * semantics in Russian — selecting a language never selects project behavior.
 */

// Shared "reuse first" guidance, neutral.
function reuseFirst() {
  return [
    '**REUSE-FIRST:** Before proposing new code, study the existing components,',
    'hooks, services, and utilities in the repository. Reuse what already exists.',
    'Add new files/functions only when the existing ones do NOT cover the task.',
  ];
}

export const pack = {
  // ── plan (cc-thingz flow) ────────────────────────────────────────────────
  planCc({ O, issueKey, noBrainstorm }) {
    const brainstormSection = noBrainstorm ? [
      '## MODE: FULLY AUTONOMOUS',
      '',
      '**CRITICAL: you run in piped mode with NO user.**',
      '- Do NOT use the brainstorm skill (do NOT call /brainstorm:do)',
      '- Do NOT ask questions — there is no one to answer',
      '- Do NOT offer options to choose from — decide yourself',
      '- Make all decisions independently',
      '- You MUST create plan.md at the end',
      '',
      '## Step 1 — Analysis (no brainstorm skill)',
      '',
      `Read the task context: ${O}/ai/tasks/${issueKey}/context.md`,
      'Study the affected code in the repository. Determine the best approach yourself.',
      '',
      ...reuseFirst(),
      '',
      '## Step 2 — Create plan.md',
      '',
      'Run /plan-make:do describing the chosen approach.',
      '**If /plan-make:do is unavailable — create plan.md manually from the template.**',
      `Save the result to ${O}/ai/tasks/${issueKey}/plan.md.`,
      '',
      '**CHECK: plan.md MUST exist when you finish. Without it the task fails.**',
    ] : [
      '## Step 1 — Brainstorm',
      '',
      `Read the task context: ${O}/ai/tasks/${issueKey}/context.md`,
      '',
      'Run /brainstorm:do with the following task description:',
      `"${issueKey}: see ${O}/ai/tasks/${issueKey}/context.md"`,
      '',
      'The brainstorm should surface:',
      '- The core problem',
      '- Implementation options (at least 2)',
      '- Constraints and risks',
      '- Dependencies',
      '- A recommended approach',
      '',
      ...reuseFirst(),
      '',
      '## Step 2 — Plan',
      '',
      'Based on the brainstorm, run /plan-make:do describing the chosen approach.',
    ];

    return [
      '## Language',
      noBrainstorm
        ? 'Write plan.md in English ONLY.'
        : 'Communicate with the user in English (brainstorm, discussion, questions).\nWrite plan.md in English.',
      '',
      ...brainstormSection,
      '',
      'The plan must contain the sections: Goal, Inputs, Constraints, Assumptions,',
      'Acceptance Criteria Mapping, Implementation Steps (with complexity estimates),',
      'Affected Files (concrete repository paths, split into: existing to modify / new to create), Validation, Risks, Done Criteria.',
      '',
      '**IMPORTANT: plan.md is written in English.**',
      '',
      `Use the template: ${O}/ai/templates/plan.md.tmpl`,
      `Save the result to ${O}/ai/tasks/${issueKey}/plan.md.`,
      '',
      '**VERDICT FORMAT:** A line `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — must be on a SINGLE line.',
      '',
      '## Step 3 — Auto-review',
      '',
      'Run the plan-review agent for an automated completeness check of the plan.',
      'If verdict = NEEDS REVISION — revise the plan and re-run the review.',
      'If verdict = APPROVE — the plan is ready.',
      '',
      `Make sure the verdict is written at the top of ${O}/ai/tasks/${issueKey}/plan.md.`,
    ];
  },

  // console hints for the cc-thingz path
  planCcConsole({ O, issueKey, engine, launch }) {
    return {
      preparedLine: `\nPrompt prepared (cc-thingz flow): ${O}/ai/tasks/${issueKey}/.prompt-plan.md`,
      runHeader: '\nLaunch Claude Code (make sure cc-thingz is installed):',
      launchLine: `  ${launch}`,
      readLine: `  > Read ${O}/ai/tasks/${issueKey}/.prompt-plan.md and follow the instructions`,
      skillsHeader: '\nAvailable cc-thingz commands in the session:',
      skill1: '  /brainstorm:do  — brainstorm',
      skill2: '  /plan-make:do   — create the plan',
      skill3: '  plan-review     — agent for automated plan checking',
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl plan ${issueKey} --finalize`,
    };
  },

  // ── plan (direct prompt, no cc-thingz) ───────────────────────────────────
  planDirect({ O, issueKey }) {
    return [
      '## Language',
      'Communicate with the user in English (brainstorm, discussion, questions).',
      'Write plan.md in English.',
      '',
      '## Phase 1 — Brainstorm',
      '',
      `Read the file ${O}/ai/tasks/${issueKey}/context.md.`,
      '',
      'Answer the questions:',
      '1. What problem does this task solve?',
      '2. What implementation options are there (at least 2)?',
      '3. What are the constraints and risks?',
      '4. What are the dependencies?',
      '5. Which option do you recommend and why?',
      '',
      ...reuseFirst(),
      '',
      '## Phase 2 — Plan',
      '',
      `Based on the brainstorm, create the file ${O}/ai/tasks/${issueKey}/plan.md.`,
      '',
      'Required sections: Goal, Inputs, Constraints, Assumptions,',
      'Acceptance Criteria Mapping, Implementation Steps (with complexity estimates),',
      'Affected Files (concrete paths, split into: existing to modify / new to create), Validation, Risks, Done Criteria.',
      '',
      '**IMPORTANT: plan.md is written in English.**',
      '',
      `Use the template: ${O}/ai/templates/plan.md.tmpl`,
      '',
      '## Phase 3 — Self-review',
      '',
      'Check the plan: are all AC covered? no scope creep? is testing included?',
      '**VERDICT FORMAT:** A line `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — must be on a SINGLE line.',
      `Write the verdict at the top of ${O}/ai/tasks/${issueKey}/plan.md.`,
      'If NEEDS REVISION — revise and re-run the review.',
    ];
  },

  planDirectConsole({ O, issueKey, engine, launch }) {
    return {
      preparedLine: `\nPrompt prepared: ${O}/ai/tasks/${issueKey}/.prompt-plan.md`,
      runHeader: `\nLaunch ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Read ${O}/ai/tasks/${issueKey}/.prompt-plan.md and follow the instructions`,
      ccHeader: '\nTo use cc-thingz (if installed):',
      ccLine: `  taskctl plan ${issueKey} --engine claude --cc-thingz`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl plan ${issueKey} --finalize`,
    };
  },

  // ── plan-review ──────────────────────────────────────────────────────────
  planReview({ O, issueKey, issueType }) {
    return [
      '## Language',
      'Write review.md in English.',
      '',
      'You are a reviewer. Read:',
      `- ${O}/ai/tasks/${issueKey}/context.md`,
      `- ${O}/ai/tasks/${issueKey}/plan.md`,
      '',
      `## Issue type: ${issueType}`,
      '',
      'Review the plan against these criteria:',
      '1. Completeness: are all acceptance criteria covered?',
      '2. Scope creep: anything beyond the task scope?',
      '3. Over-engineering: is the solution unnecessarily complex?',
      '4. Testing: does the plan include a testing strategy?',
      '5. Dependencies: all accounted for?',
      '6. Risks: all covered?',
      '',
      '## Testing evaluation rules',
      issueType.toLowerCase() === 'bug'
        ? '- For bugfixes: unit/component tests for changed code are sufficient. Missing E2E/integration tests = Suggestion, NOT a blocker.'
        : '- For features: component-level tests are required (Important). Missing E2E tests = Suggestion.',
      '- No testing section at all = Important for any issue type.',
      '- Pre-existing test failures in unrelated modules are NOT a blocker.',
      '',
      `Use template: ${O}/ai/templates/review.md.tmpl`,
      '',
      'Do NOT write files yourself.',
      'Return the full review.md content as your final answer in a single ```md ... ``` block.',
      '',
      '**VERDICT FORMAT:** Line `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — must be on a SINGLE line, format `## Verdict: VALUE`.',
      '',
      '## Note on downstream verification',
      'Your findings are INPUT to the orchestrator (the agent running taskctl), not final authority.',
      'Per `ai/rules/engineering.md` § "Cross-Model Review: Orchestrator Verification", the orchestrator will independently verify each Critical / Important finding by reading the cited code before invoking the fix/revise loop.',
      'Cite exact file paths + line numbers so verification is straightforward. Avoid vague claims like "the logic is wrong somewhere" — name the location, name the bug, name the consequence.',
      'If a concern is theoretical (would never trigger given documented invariants), say so explicitly — the orchestrator may legitimately classify it as theoretical and defer.',
    ];
  },

  planReviewConsole({ O, issueKey, engine, launch }) {
    return {
      preparedLine: `\nPrompt prepared: ${O}/ai/tasks/${issueKey}/.prompt-review.md`,
      runHeader: `\nLaunch ${engine} (cross-model review):`,
      launchLine: `  ${launch}`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl plan-review ${issueKey} --finalize`,
    };
  },

  // ── run (execution) ──────────────────────────────────────────────────────
  run({ O, issueKey }) {
    return [
      '## Language',
      'Communicate with the user in English. Code, code comments, commits and progress.md — in English.',
      '',
      '## Rules',
      `- Read ${O}/ai/rules/engineering.md`,
      `- Work strictly per the plan in ${O}/ai/tasks/${issueKey}/plan.md`,
      `- After every step, update ${O}/ai/tasks/${issueKey}/progress.md`,
      '- Do not go beyond the plan scope',
      '- If you find a problem not covered by the plan — stop and report it',
      '- **Do NOT git commit, git push, or create a PR** — a separate command `taskctl publish` does that',
      '',
      '## Testing',
      '- After implementing, you MUST write tests for the changed code',
      "- Run the project's test suite and make sure the relevant tests pass",
      "- Run the project's type-check and build commands and make sure they pass",
      '',
      '## Begin',
      `Read ${O}/ai/tasks/${issueKey}/plan.md and execute the steps in order.`,
    ];
  },

  runConsole({ O, issueKey, engine, launch, branch }) {
    return {
      preparedLine: `\nPrompt prepared: ${O}/ai/tasks/${issueKey}/.prompt-run.md`,
      branchLine: branch ? `  Branch: ${branch}` : null,
      runHeader: `\nLaunch ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Read ${O}/ai/tasks/${issueKey}/.prompt-run.md and follow the instructions`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl run ${issueKey} --finalize`,
    };
  },

  // ── review (final) ───────────────────────────────────────────────────────
  // diffFallbackEmpty / diffFallbackHint are the neutral diff-status strings.
  reviewDiffEmpty(integrationBranch) {
    return `- Diff is empty (no changes relative to ${integrationBranch})`;
  },
  reviewDiffHint(integrationBranch) {
    return `- Check git diff of current branch vs ${integrationBranch}`;
  },

  review({ O, issueKey, issueType, diffInfo }) {
    return [
      '## Language',
      'Write review.md in English.',
      '',
      'You are a senior code reviewer for the project.',
      '',
      '## Files to review',
      `- Plan: ${O}/ai/tasks/${issueKey}/plan.md`,
      `- Progress: ${O}/ai/tasks/${issueKey}/progress.md`,
      diffInfo,
      '',
      `## Issue type: ${issueType}`,
      '',
      '## Criteria',
      '1. All acceptance criteria from plan.md are met?',
      '2. Code follows the project\'s established patterns?',
      '3. No hardcoded credentials or secrets?',
      '4. Types are correct (if a typed language)?',
      '5. Tests exist for changed code (unit and/or component-level)?',
      '',
      '## Missing Coverage evaluation rules',
      issueType.toLowerCase() === 'bug'
        ? '- For bugfixes: missing integration/e2e tests = **Suggestion**, NOT a blocker. Unit/component tests for changed code are sufficient.'
        : '- For features: missing component-level tests = **Important**. Missing e2e tests = **Suggestion**.',
      '- No tests AT ALL for changed code = **Important** for any issue type.',
      '- Pre-existing test failures in unrelated modules are NOT a blocker for this task.',
      '',
      '## Scope boundary (workstream / task scope)',
      'If the plan.md declares explicit scope boundaries (e.g. "Scope boundary" subsection in §Constraints, "out of scope" notes in §Acceptance Criteria, or references to a dependency/ownership matrix that assigns adjacent work to another workstream), respect them.',
      '',
      '- Missing functionality that the plan explicitly declares as belonging to a different workstream (linked by ID / matrix reference / AC note) is **NOT** a pre-publish blocker here. At most, log it under Missing Coverage with a pointer to the owning workstream — never as Critical or Important.',
      '- If you disagree with the boundary, raise it as a **Suggestion** with reasoning. Do not unilaterally escalate to NEEDS WORK — the master plan is authoritative; disputes go through plan revision, not review verdicts.',
      '- What DOES belong in this review regardless of scope: bugs in the code that IS present, broken static checks, security issues visible in the diff, violations of the pre-publish gate from §Done Criteria.',
      '- Per-workstream decomposition for an epic is a deliberate architecture choice. A foundation workstream delivering a primitive + bootstrap consumer, with surface-wide adoption in a downstream workstream, is a valid and common pattern — not a half-finished feature.',
      '',
      `Use template: ${O}/ai/templates/review.md.tmpl`,
      '',
      'Do NOT write files yourself.',
      'Return the full review.md content as your final answer in a single ```md ... ``` block.',
      '',
      '**VERDICT FORMAT:** Line `## Verdict: APPROVE` or `## Verdict: NEEDS WORK` or `## Verdict: REJECT` — must be on a SINGLE line, format `## Verdict: VALUE`.',
      '',
      '## Note on downstream verification',
      'Your findings are INPUT to the orchestrator (the agent running taskctl), not final authority.',
      'Per `ai/rules/engineering.md` § "Cross-Model Review: Orchestrator Verification", the orchestrator will independently verify each Critical / Important finding by reading the cited code before invoking the fix loop.',
      'Cite exact file paths + line numbers so verification is straightforward. Avoid vague claims like "the logic is wrong somewhere" — name the location, name the bug, name the consequence.',
      'If a concern is theoretical (would never trigger given documented invariants), say so explicitly — the orchestrator may legitimately classify it as theoretical and defer.',
      'False positives are costly: each fix iteration consumes ~5–15 min of agent compute. Anchor your claims in concrete evidence.',
    ];
  },

  reviewConsole({ O, issueKey, engine, launch, repoPath }) {
    return {
      preparedLine: `\nPrompt prepared: ${O}/ai/tasks/${issueKey}/.prompt-review-final.md`,
      runHeader: `\nLaunch ${engine} (cross-model review):`,
      launchLine: `  ${launch}`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl review ${issueKey} --finalize`,
    };
  },

  // ── fix ──────────────────────────────────────────────────────────────────
  fix({ O, issueKey }) {
    return [
      '## Language',
      'Communicate with the user in English. Code, comments, commits and progress.md — in English.',
      '',
      '## Context',
      'The code passed review and got findings. Your task is to fix the problems found.',
      '',
      '## Files to read',
      `1. Review with findings: ${O}/ai/tasks/${issueKey}/review.md`,
      `2. Orchestrator audit (if present): ${O}/ai/tasks/${issueKey}/audit-iter*.md — independent verification of findings + classification (real bug / theoretical / false positive)`,
      `3. Plan: ${O}/ai/tasks/${issueKey}/plan.md`,
      `4. Progress: ${O}/ai/tasks/${issueKey}/progress.md`,
      `5. Rules: ${O}/ai/rules/engineering.md`,
      '',
      '## Tasks',
      '1. Read review.md — understand ALL the reviewer findings (Critical, Important, Suggestions)',
      '2. **If audit-iter*.md exists** — read it. The orchestrator has already verified each finding and may have marked some as false-positive (do NOT fix those) or added bugs the reviewer missed (fix those too). The audit overrides review.md on scope.',
      '3. Fix EVERY confirmed-real Critical and Important finding. Skip findings marked false-positive in the audit.',
      '4. Suggestions — at your discretion (implement if reasonable)',
      '5. Do not break what already works',
      '6. Run the tests after fixing',
      `7. Update ${O}/ai/tasks/${issueKey}/progress.md — add a "## Fixes after review" section`,
      '',
      '**REUSE-FIRST:** Use existing components and utilities, do not create anything redundant.',
      '',
      '**Do NOT git commit, git push, or create a PR** — a separate command `taskctl publish` does that.',
    ];
  },

  fixConsole({ O, issueKey, engine, launch, branch, otherEngine }) {
    return {
      preparedLine: `\nPrompt prepared: ${O}/ai/tasks/${issueKey}/.prompt-fix.md`,
      branchLine: branch ? `  Branch: ${branch}` : null,
      runHeader: `\nLaunch ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Read ${O}/ai/tasks/${issueKey}/.prompt-fix.md and follow the instructions`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl fix ${issueKey} --finalize`,
      reReviewLine: `  taskctl review ${issueKey} --engine ${otherEngine}   # re-review`,
    };
  },

  // ── revise ───────────────────────────────────────────────────────────────
  revise({ O, issueKey }) {
    return [
      '## Language',
      'Communicate with the user in English. Write plan.md in English ONLY.',
      '',
      '## Context',
      'The plan passed review and got verdict: NEEDS REVISION.',
      'Your task is to read the reviewer findings and improve the plan.',
      '',
      '## Files to read',
      `1. Review with findings: ${O}/ai/tasks/${issueKey}/review.md`,
      `2. Orchestrator audit (if present): ${O}/ai/tasks/${issueKey}/audit-plan-iter*.md OR "## Orchestrator Audit Notes" in review.md — the orchestrator verified each finding and may have classified some as theoretical/false-positive or added missed ones`,
      `3. Current plan: ${O}/ai/tasks/${issueKey}/plan.md`,
      `4. Task context: ${O}/ai/tasks/${issueKey}/context.md`,
      '',
      ...reuseFirst(),
      '',
      '## Tasks',
      '1. Read review.md — understand ALL the reviewer findings',
      '2. Read the current plan.md',
      '3. Revise the plan, addressing EVERY finding from the review',
      '4. Do not delete what was approved — change only the problematic parts',
      '5. Self-review: are all findings closed? no new scope creep?',
      '6. Write the verdict at the top of plan.md. **Format strictly** `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — H2 heading, exactly two `#`. Not H1 (`#`), not **Verdict:** in a metadata bullet.',
      '',
      `Save the updated plan to ${O}/ai/tasks/${issueKey}/plan.md`,
    ];
  },

  reviseConsole({ O, issueKey, engine, launch, otherEngine }) {
    return {
      preparedLine: `\nPrompt prepared: ${O}/ai/tasks/${issueKey}/.prompt-revise.md`,
      runHeader: `\nLaunch ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Read ${O}/ai/tasks/${issueKey}/.prompt-revise.md and follow the instructions`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl revise ${issueKey} --finalize`,
      reReviewLine: `  taskctl plan-review ${issueKey} --engine ${otherEngine}`,
    };
  },

  // ── replan ───────────────────────────────────────────────────────────────
  replan({ O, issueKey, planVersion }) {
    return [
      '## Language',
      'Communicate with the user in English. Write plan.md in English ONLY.',
      '',
      '## Context',
      `This is a re-plan. The previous plan v${planVersion} has been archived.`,
      'Reason for replan: change of scope, dependencies, or context.',
      '',
      `Read: ${O}/ai/tasks/${issueKey}/context.md`,
      `Read the previous plan (if any): ${O}/ai/tasks/${issueKey}/plan.md`,
      `Read the progress (if any): ${O}/ai/tasks/${issueKey}/progress.md`,
      '',
      ...reuseFirst(),
      '',
      '## Tasks',
      '1. Analyze what changed since the previous plan',
      '2. Account for already-completed work from progress.md (if any)',
      '3. Create an updated plan with the same sections:',
      '   Goal, Inputs, Constraints, Assumptions, AC Mapping,',
      '   Implementation Steps, Affected Files (existing to modify / new to create), Validation, Risks, Done Criteria',
      '4. Self-review and write the verdict at the top of plan.md. **Format strictly** `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — H2 heading (exactly two `#`).',
      '',
      `Use the template: ${O}/ai/templates/plan.md.tmpl`,
      `Save the result to ${O}/ai/tasks/${issueKey}/plan.md`,
      '',
      '**VERDICT FORMAT:** A line `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — must be on a SINGLE line.',
    ];
  },

  replanConsole({ O, issueKey, engine, launch }) {
    return {
      returnedLine: `\n✓ ${issueKey} returned to analysis for replan`,
      promptLine: `  Prompt: ${O}/ai/tasks/${issueKey}/.prompt-plan.md`,
      runHeader: `\nLaunch ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Read ${O}/ai/tasks/${issueKey}/.prompt-plan.md and follow the instructions`,
      afterHeader: '\nAfter finishing:',
      finalizeLine: `  taskctl plan ${issueKey} --finalize`,
    };
  },

  // ── new-project (WP5 Stage 5b) ───────────────────────────────────────────
  // Engine-driven steps of `taskctl new-project`. Each emits a STRUCTURED JSON
  // envelope (validated against newproject-schema.mjs) AND writes in English
  // (I-10). `flowDir` is the absolute flow directory under THIS workspace
  // (ai/newproject/<target-id>); artifacts/prompt files live there.
  newProjectBrainstorm({ flowDir, idea, slug }) {
    return [
      '## Language',
      '**Write ALL output in English** (this artifact is reviewed in English).',
      '',
      '## Task — brainstorm a new project from an idea',
      '',
      `Project slug: ${slug}`,
      `Idea: "${idea}"`,
      '',
      'Run ONE structured brainstorm pass (no multi-turn dialog — the user will',
      'answer by editing the artifact and re-invoking). Surface:',
      '- Open questions that need a human decision (scope, audience, constraints).',
      '- The assumptions you are making.',
      '- Candidate implementation options (at least two distinct directions).',
      '',
      '## Output format — a single fenced JSON envelope',
      'Emit EXACTLY ONE fenced ```json block (and nothing else that looks like',
      'JSON) with this shape:',
      '```json',
      '{',
      '  "questions": ["...", "..."],',
      '  "assumptions": ["...", "..."],',
      '  "options": ["...", "..."]',
      '}',
      '```',
      'All strings MUST be in English. `questions` and `options` together must be',
      `non-empty. taskctl renders ${flowDir}/brainstorm.md FROM this envelope.`,
    ];
  },

  newProjectBrainstormConsole({ flowDir }) {
    return {
      preparedLine: `\nBrainstorm artifact: ${flowDir}/brainstorm.md`,
      editHeader: '\nReview + edit the brainstorm, then re-invoke to continue:',
      editLine: `  (edit ${flowDir}/brainstorm.md — answer the questions)`,
    };
  },

  newProjectProposal({ flowDir, idea, slug }) {
    return [
      '## Language',
      '**Write ALL output in English.**',
      '',
      '## Task — propose a stack / architecture',
      '',
      `Project slug: ${slug}`,
      `Idea: "${idea}"`,
      `Read the edited brainstorm at ${flowDir}/brainstorm.md and propose concrete`,
      'stack/architecture options. Offer AT LEAST TWO alternatives with trade-offs,',
      'and recommend one.',
      '',
      '## Output format — a single fenced JSON envelope',
      '```json',
      '{',
      '  "recommended": "<id of the recommended option>",',
      '  "options": [',
      '    { "id": "a", "stack": "...", "rationale": "..." },',
      '    { "id": "b", "stack": "...", "rationale": "..." }',
      '  ]',
      '}',
      '```',
      'All strings in English. `recommended` MUST equal one option `id`. taskctl',
      `renders ${flowDir}/proposal.md FROM this envelope.`,
    ];
  },

  newProjectProposalConsole({ flowDir }) {
    return {
      preparedLine: `\nProposal artifact: ${flowDir}/proposal.md`,
      chooseHeader: '\nPick an option (re-invoke; --yes auto-picks the recommended one).',
    };
  },

  newProjectScaffold({ flowDir, idea, slug, chosenOption }) {
    return [
      '## Language',
      '**Write ALL output in English.**',
      '',
      '## Task — produce a PRINT-ONLY scaffold plan',
      '',
      `Project slug: ${slug}`,
      `Idea: "${idea}"`,
      `Chosen option: ${chosenOption}`,
      `Read ${flowDir}/proposal.md. Emit the EXACT native-generator command(s) the`,
      'USER will run to scaffold this project (e.g. `npm create vite@latest <dir>`,',
      '`cargo new <dir>`, ...), plus the intended top-level file tree.',
      '',
      '**These commands are PRINTED for the user to run — taskctl NEVER executes',
      'them.** Do not assume anything has been created yet.',
      '',
      '## Output format — a single fenced JSON envelope',
      '```json',
      '{',
      '  "commands": ["npm create vite@latest . -- --template react-ts", "..."],',
      '  "fileTree": ["src/", "src/main.tsx", "package.json"]',
      '}',
      '```',
      'All strings in English. `commands` must be non-empty. taskctl renders',
      `${flowDir}/scaffold-plan.md FROM this envelope.`,
    ];
  },

  newProjectScaffoldConsole({ flowDir }) {
    return {
      preparedLine: `\nScaffold plan: ${flowDir}/scaffold-plan.md`,
      runHeader: '\nRun the printed commands yourself, then `git init`, then re-invoke:',
    };
  },

  newProjectBacklog({ flowDir, idea, slug }) {
    return [
      '## Language',
      '**Write ALL output in English** (task context.md files are English).',
      '',
      '## Task — decompose into an initial backlog',
      '',
      `Project slug: ${slug}`,
      `Idea: "${idea}"`,
      `Read ${flowDir}/proposal.md and ${flowDir}/scaffold-plan.md. Break the work`,
      'into a small ordered backlog of concrete first tasks (typically 3–6).',
      '',
      '## Output format — a single fenced JSON envelope',
      '```json',
      '{',
      '  "tasks": [',
      '    { "slug": "short-label", "title": "...", "desc": "..." }',
      '  ]',
      '}',
      '```',
      'All strings in English. Each `slug` is a SHORT kebab label (taskctl prefixes',
      `it as <project>-NN-<slug>). At least one task. taskctl seeds these under the`,
      'new project\'s ai/tasks/.',
    ];
  },

  newProjectBacklogConsole({ count }) {
    return {
      preparedLine: `\nBacklog: ${count} task(s) seeded under the project's ai/tasks/`,
    };
  },

  // ── shared console strings used by cmds regardless of stage ──────────────
  codexAutoSaveNote(cmd) {
    return `  Note: for auto-save into review.md, prefer: taskctl do ${cmd}`;
  },
};
