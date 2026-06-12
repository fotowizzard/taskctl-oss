# Coupling map — origin-specific hardcodes and what they became

> The decoupling spec produced by mining the origin CLI, recorded here as executed history:
> WP1/WP2/WP3/WP5 each consumed a slice. Sanitized: concrete identifiers from the origin project
> are described by KIND, not value. Useful as a checklist for anyone extracting an internal tool
> into a generic one.

## The taxonomy

Every coupling point fell into one of four buckets:

- **ENV** — already overridable by an environment variable; keep, but stop being the only path.
- **CFG** — must become a `taskctl.config.json` field.
- **PROFILE** — must be DERIVED by analyzing the target repo (the WP3 profiler), not configured.
- **ADAPTER** — must become a pluggable interface (tracker, engine, VCS host).

## The map (origin value kind → resolution → where it shipped)

| Coupling point | Kind | Resolution | Shipped |
|---|---|---|---|
| Default repo path (3 copies across modules) | absolute local path | `config.repoPath`; later nulled — explicit error when unset | WP1 → WP2 |
| Branch model (`dev`/`main`, worktree base, PR base, diff base) | branch-name literals | `config.branches{integration,prTarget}` | WP2 (2b) |
| Tracker requirement (sync/refresh/publish hard-required credentials) | vendor coupling | tracker ADAPTER: `local` default + reference vendor adapter; commands gate on tracker type | WP1 |
| Tracker field IDs, ADF parsing, key regex, browse URL, assignee | vendor specifics | adapter-owned; assignee → config; key pattern generalized | WP1/WP2 |
| Governance layer (markup/lint/sync machinery, ~40% of the CLI) | project methodology | optional module, `grace.enabled=false` default; read-path preserved; pilot/upstream branches configurable | WP2 (2a) |
| Keyword→path "code areas" table | project layout knowledge | PROFILE: derived by the read-only profiler; config override allowed | WP2 stub → WP3 |
| "Project Context" / "Constraints" prompt blocks (stack, infra IDs, policy text) | project facts incl. backend project IDs | `config.projectContext[]` / `constraints[]`; profiler seeds context; templates tokenized | WP2 (2b) + WP3 |
| Prompt language (author prompts in the operator's language) | locale | `config.promptLanguage`, packs `en`/`ru`, project-neutral semantics both | WP2 (2b) |
| Engine binaries + flags + reasoning effort + output parsing (duplicated in two modules) | vendor CLI shapes | engine ADAPTERS + registry + capabilities + availability probes; roles (`planner`/`reviewer`) from config | WP2 (names) → WP5a (full) |
| Preview-URL template, PR-body footer, publish narrative | deploy-stack specifics | config fields / dropped from generic prompts | WP2 (2b) |
| Workspace root = CLI installation dir (single-workspace assumption) | architectural assumption | `resolveWorkspaceRoot(cwd)` nearest-ancestor discovery; per-workspace config/tasks/templates | WP5b |
| One-off epic script in the repo | dead code | deleted | WP2 (2b) |

## Lessons that generalize

1. **The deepest coupling was an assumption, not a literal** — "one installation = one project"
   survived three work packages unnoticed and only surfaced when `new-project` tried to produce a
   workspace the CLI couldn't operate on. Greps find literals; only adversarial design review
   found this.
2. **Bucket first, then schedule.** CFG items are cheap and batchable; ADAPTER items dictate
   architecture and deserve their own stage; PROFILE items are a product feature in disguise.
3. **Make the gate executable.** The literal scrub became a repo-level grep-clean TEST (forbidden
   identifier list), not a one-time cleanup — regressions fail CI, not an audit.
4. **Optional ≠ deleted.** The governance layer moved behind a flag with its behavior intact;
   "off by default" preserved the methodology investment without taxing every user.
