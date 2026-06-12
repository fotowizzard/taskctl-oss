# Scrub checklist — the MANUAL tier (companion to the mechanical gate)

The mechanical tier lives in `taskctl/__tests__/config-2b.test.mjs` (`collectShippedDocs()` +
the FORBIDDEN-literal / regex / Cyrillic assertions over **all `**/*.md` repo-wide, minus
`ai/tasks/**`**). It proves the absence of a fixed set of literals/patterns. It does **NOT** prove the
classes below — regex cannot, or (item 7) the orchestrator deliberately keeps them out of the
mechanical tier. Walk this list by hand over `skills/`, `docs/methodology/`, and the README
methodology section before marking any content task done. **State per class whether it is mechanical
or manual** — these are the manual ones.

> The mechanical test does **not** prove these classes absent. Do not claim it does.

1. **Person names** — no proper personal names anywhere in a shipped file. (An email-fragment literal
   is already mechanical; a bare name is not.) Manual proper-name pass over every shipped file.

2. **Origin file/line citations** — no `path:line` reference to an origin file (e.g.
   `automation.mjs:348`, a template path, a settings file, a backup-and-protection doc, a markup
   playbook). Shipped docs cite **this** repo's paths or nothing.

3. **Engine-role hardcoding** — protocols use **author / reviewer** (or **A / B**), never a hardcoded
   vendor name (or model name) in role logic. A concrete vendor pair may appear **once** per doc as a
   clearly-framed non-normative illustration, never as the rule.

4. **Origin-domain residue** — DB/infra/stack terms that betray the origin domain (a specific managed
   Postgres/JSONB/RPC/RLS/migrations/edge-functions/auth-role taxonomy, named hosting/runtime/build
   stacks) appear **only** as clearly-neutral generic examples, never as the assumed environment.

5. **Origin incident / narrative refs** — no private incident labels; no "PR → integration",
   pilot/upstream-rebase, preview-pipeline, or repo-guide-as-cross-reference narratives copied from
   the origin.

6. **Configurable-default vs copied-policy distinction** — the default integration branch name as a
   *documented configurable default* is allowed; the same name (and other protected names, the origin
   worktree layout, feature-branch naming) as *copied origin workflow policy* is not. Tell them apart
   (this is why the default branch name is **not** in the mechanical list).

7. **GRACE artifact XML filenames** — origin-workflow residue (`development-plan.xml`,
   `knowledge-graph.xml`, `verification-plan.xml`, `operational-packets.xml`): reviewed in context.
   The word `GRACE` / `grace` itself is **allowed** (it is the public upstream methodology name, the
   shipped code carries `grace.mjs` / `grace.enabled`, and attribution must name it); only an XML
   artifact filename appearing as *copied origin workflow* is a flag.

## Walk record

- `skills/*/SKILL.md` (×6) — walked: yes. No person names; no origin file:line citations (the
  `newproject.mjs:282` / `cli.mjs:1027` refs in cross-model-review are THIS repo's WP5 files, the
  allowed case study); engine roles are author/reviewer (no vendor in role logic); no origin-domain
  stack residue; `dev` appears only as the documented configurable integration-branch default.
- `docs/methodology/task-lifecycle.md` — walked: yes. `dev` = documented configurable default only; the
  shipped-honesty notes describe this tool's behavior, no origin narrative; no GRACE XML filenames.
- `docs/methodology/flipped-flow.md` — walked: yes. English throughout; engine A/B in role logic; the
  WP5 example replaces any private incident; "production audit hook" is the deferred-feature phrasing.
- `docs/methodology/cross-model-review.md` — walked: yes. Evidence is sanitized (WP5 numbers + neutral
  patterns); reviewer-as-input framing; no origin-domain stack residue.
- `skills/README.md` + README methodology section — walked: yes. Portable-core vs Claude-extension
  framing; links resolve; no origin literals.
