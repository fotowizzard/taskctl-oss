/**
 * launch-safety.mjs — the one gate a configured value passes before it is
 * allowed to become part of a command line (plan deliverable P2, issue #22).
 *
 * THE INVARIANT, stated exactly: no CONFIGURED or PINNED value reaches argv
 * unvalidated. That is the claim, and the qualifier is load-bearing — a value
 * that arrives from a CLI argument or out of a task ARTIFACT is a different
 * population and is NOT covered by this gate. See "WHAT THIS DOES NOT CLOSE".
 *
 * The defect this closes is not hypothetical. `taskctl.config.json` is a
 * committed file, so "run this tool in a repository someone else wrote" — the
 * situation the onboarding flow exists to invite — is the whole precondition.
 * From there a configured string reaches a command line by three different
 * route classes, and a guard on any one of them leaves the other two open:
 *
 *   1. argv under `shell: true` — Node joins the argv array into ONE command
 *      string, so an element is not a quoted argument any more, it is syntax.
 *   2. command STRINGS built by concatenation and handed to execSync.
 *   3. commands PRINTED for an operator to paste. Those run in the operator's
 *      own shell with no wrapper at all, which is why a validator placed on the
 *      spawn path does not cover them — nothing of ours executes them.
 *
 * ROUND 2 NARROWED THE ROUTES THEMSELVES rather than only guarding them, because
 * the first version's blanket ban on the space refused `C:/Users/First Last/repo`
 * — an ordinary Windows path — and a tool that refuses to run is not safer than
 * one that runs. Converted to argument vectors with NO shell: `grace lint --path`
 * (grace.mjs, which was the unquoted worst case), `git worktree add|remove`
 * (cli.mjs, which was a concatenated string), cli.mjs's `runGit`, and the Jira
 * summary call. Still shell-parsed, with the reason and the containment argument
 * recorded in DOUBLE_QUOTED_SHELL_ROUTES below: the engine spawn (npm ships
 * claude/codex as Windows `.cmd` shims, which Node 22 refuses to spawn without a
 * shell) and the printed operator commands (nothing of ours runs them). The
 * space is admitted for the keys whose ENTIRE route set survived that pass, and
 * only those — see SPACE_PERMITTED_KEYS.
 *
 * Plus one argv-injection route at `shell: false` (harness.mjs's
 * `git remote get-url`, cli.mjs's `gh pr create --base <target>`), where no
 * shell is involved but a value beginning with `-` is read by the callee as a
 * flag rather than as data. That is why the check below is about argv
 * MEMBERSHIP and not only about shell syntax.
 *
 * WHY THROW RATHER THAN WARN. A warning here is a warning printed either just
 * before or just after the injected text executes. There is no state in which
 * continuing is the safe option, so `skipped` is not one of this check's
 * outcomes (plan principles 2 and 10).
 *
 * WHERE THE CHECK LIVES, AND WHY THERE. Provenance is knowable at config
 * resolution and lost by the time a value reaches a sink: at `spawn()` a
 * configured `repoPath` and the install's own `flowDir` are both just strings,
 * and a check placed there either refuses ordinary installs or waves the
 * configured value through. So the gate is at the boundary where configuration
 * ENTERS the process — `loadTaskctlConfig` and `normalizeRuntimeConfig` in
 * config.mjs — and the sink-side calls are a second layer over the values whose
 * provenance is still unambiguous at that point. `assertLaunchConfig` walks the
 * resolved runtime object rather than a list of key names, so a key added to
 * that object later is checked by default and EXCLUDING one takes a deliberate
 * edit to NON_LAUNCH_KEYS below. That inversion is the point: forgetting to do
 * anything leaves the new key validated.
 *
 * WHAT THIS DOES NOT CLOSE, stated here because describing it otherwise would
 * be false:
 *   - `shell: true` REMAINS on the two routes named in
 *     DOUBLE_QUOTED_SHELL_ROUTES. On those, a configured value is contained by
 *     an argument about an alphabet rather than by the operating system, and
 *     any OTHER string that reaches those command lines is not contained at all.
 *   - values from CLI arguments and from task artifacts are NOT this gate's
 *     population and are not covered by it. They travel some of the same
 *     strings (a `--repo-path` argument, a `state.json` worktree path). Some of
 *     the sink-side calls below happen to cover some of those; that is a side
 *     effect, not a claim. Round 2 fixed ONE artifact-sourced sink outright —
 *     cli.mjs's Jira summary interpolated review/plan/progress text into a
 *     `claude -p …` command STRING, so prose an engine wrote into an artifact
 *     executed — by moving that text to the child's STDIN, where no shell
 *     parses it. That is one sink repaired, not a claim about the population:
 *     "no artifact-sourced value reaches a shell unvalidated" is NOT true, and
 *     is not asserted anywhere.
 *   - a value read out of the raw parsed config by a COMPUTED key, or read from
 *     a file whose path came from configuration, is not seen by a walk over the
 *     resolved object. `raw` is excluded below and this is why.
 * See docs/plans/design/p2-launch-safety.md for the full accounting.
 *
 * No imports: this module must be safe to pull into config.mjs, which sits at
 * the bottom of the module graph.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  The rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The admitted set, one character class per reason:
 *   \p{L}\p{N}  letters and digits in ANY script. Every shell metacharacter is
 *               ASCII punctuation or whitespace, so admitting non-Latin letters
 *               refuses nothing dangerous, and refusing them would reject an
 *               install under a home directory named in Greek, Han or Cyrillic
 *               for no security benefit whatever.
 *   . _ -       identifiers, file names, branch names (`release-1.2`).
 *   / \         path separators, POSIX and Windows both. `path.resolve` on
 *               win32 emits backslashes, so a Windows repo path needs them.
 *   :           the Windows drive letter (`C:`), and ref syntax.
 *
 * This is the TOKEN rule, and it is the default. It refuses the space, which is
 * the right answer for a value whose destination is an UNQUOTED position in a
 * command line — there a space silently becomes an argument boundary, and the
 * command that runs is not the one anybody wrote.
 */
const LAUNCH_TOKEN_CHAR = /^[\p{L}\p{N}._:/\\-]$/u;

/**
 * The PATH rule: the token rule plus the space.
 *
 * `C:/Users/First Last/repo` and `C:/Program Files/…` are ordinary Windows
 * repository paths, and round 1 refused them. That was a regression — "the tool
 * refuses to run" is not an improvement on "the tool runs" — and the fix is not
 * to widen the rule for every value. It is to make every route a PATH travels
 * carry it safely, and then admit the space for THOSE KEYS ONLY. The keys are
 * enumerated in SPACE_PERMITTED_KEYS below, each with the route accounting that
 * earns it; a key not in that table still gets the token rule.
 *
 * The space is admitted and NOTHING ELSE is. That matters for the one route
 * class that cannot be converted to an argument vector (see
 * DOUBLE_QUOTED_SHELL_ROUTES below): inside a double-quoted argument a space is
 * literal on cmd.exe AND on every POSIX shell, while every character that is
 * NOT literal inside double quotes on either of them — " $ ` % ! \ — is either
 * refused outright by the class above or refused by the trailing-backslash rule
 * further down. That is why the space can be admitted without admitting the
 * quoting problem along with it.
 */
const LAUNCH_PATH_CHAR = /^[\p{L}\p{N}._:/\\ -]$/u;

/**
 * The keys the space is admitted for, and the ROUTE ACCOUNTING that earns it.
 *
 * The rule for adding to this table is the whole point of it: a key belongs
 * here only when EVERY route that key's value travels has been shown to carry a
 * space without changing what runs. Not most routes. Not the routes that were
 * easy. A value that is safe on one route and refused on another is the same
 * rule failing twice, so the entry lists the routes rather than asserting a
 * conclusion — if a route is added later and is not in the entry, the entry is
 * wrong and reads as wrong.
 *
 * Three kinds of route can appear in an entry, and only these three:
 *   OUT-OF-BAND   the value is a `cwd:`/`env:` spawn OPTION. It is never parsed
 *                 by anything; the OS receives it as a string. Unconditionally
 *                 safe, at any length, with any character.
 *   ARGV          the value is one element of an argument array passed with
 *                 shell:false. No word-splitting exists on this route.
 *   DOUBLE-QUOTED the value is embedded inside a "…" argument in a string that
 *                 a shell will parse — either ours (shell:true) or the
 *                 operator's (a printed command). Safe for a SPACE specifically,
 *                 by the argument recorded in DOUBLE_QUOTED_SHELL_ROUTES.
 */
export const SPACE_PERMITTED_KEYS = new Map([
  ['repoPath', [
    'OUT-OF-BAND   every execSync/spawnSync in cli.mjs that runs "in the repo" passes it as `cwd:`, never in the command.',
    'ARGV          harness.mjs `git -C <v> remote get-url origin` (execFileSync, shell:false).',
    'ARGV          cli.mjs `git worktree add|remove <v>` — converted from an execSync command STRING to execFileSync argv in this round.',
    'DOUBLE-QUOTED engines.mjs codex `-C "<v>"` in the shell:true engine spawn, and the same flag in the printed launch command.',
    'DOUBLE-QUOTED the printed `taskctl publish … --repo-path "<v>"` operator hint — quoted in this round; it was bare before.',
  ].join('\n')],
  ['REPO_PATH', [
    'The environment spelling of repoPath. Identical route set — it is read into the same variable by loadTaskctlConfig.',
  ].join('\n')],
  ['grace.repoRoot', [
    'ARGV          grace.mjs `grace lint --path <v>` — converted from a shell:true spawn to shell:false argv in this round. This was the worst sink in the round-1 inventory (UNQUOTED under a shell); it is now an argument vector and the quoting question does not arise.',
    'OUT-OF-BAND   grace.mjs runPythonXmlGate and defaultDetectRepoBranch pass it as `cwd:`.',
    'OUT-OF-BAND   cli.mjs runGit passes it as `cwd:` (and that spawn dropped shell:true in this round).',
  ].join('\n')],
]);

/**
 * The routes that still hand a configured value to a SHELL, why each one does,
 * and what makes a space safe there anyway. This constant is documentation with
 * a name so that it can be cited from a refusal and from the design note, and so
 * that deleting a route from it is a deliberate edit rather than a silent drift.
 *
 * WHY THESE TWO REMAIN, when the rest of the round-2 work was removing
 * `shell: true`:
 *
 *   1. THE ENGINE SPAWN (automation.mjs). `claude` and `codex` are installed by
 *      npm, which on Windows writes a `.cmd` shim rather than an executable.
 *      Node 22 REFUSES to spawn a `.cmd` without a shell — it is EINVAL, not a
 *      fallback — because CreateProcess would hand the arguments back to cmd.exe
 *      for a second round of parsing (CVE-2024-27980). So "spawn the engine with
 *      shell:false" is not a thing that can be written on Windows. `git` and `gh`
 *      are real `.exe`s and DID convert; the engines cannot, and saying they
 *      could would be false.
 *   2. THE PRINTED OPERATOR COMMANDS. Nothing of ours executes these. They are
 *      composed and handed to a person, who pastes them into a shell we do not
 *      choose and cannot see. There is no argv API for a string somebody else
 *      will run.
 *
 * WHAT MAKES A SPACE SAFE ON BOTH ANYWAY. Every one of these embeds the value
 * inside a double-quoted argument. The two shell families disagree about a great
 * deal inside double quotes — cmd.exe expands %VAR% and does not honour \" as an
 * escape; POSIX shells expand $VAR and `cmd` and DO honour \" — but they agree
 * completely about the SPACE: it is literal inside "…" on both. So the
 * serialization does not have to be shell-specific, PROVIDED the alphabet never
 * contains a character the two disagree about. It does not:
 *
 *     "  $  `  %  !  ^  &  |  ;  <  >  (  )  '  ~  *  ?  newline  tab
 *
 * are every character either shell treats as other-than-literal inside "…", and
 * every one of them is outside LAUNCH_PATH_CHAR — refused before it can reach
 * any of this. The one admitted character that either shell can still read as an
 * escape is the backslash, and only in the final position, where it would eat
 * the closing quote on a POSIX shell; that is refused separately below.
 *
 * THIS IS A WEAKER GUARANTEE THAN ARGV, and it is worth saying which way. An
 * argument vector is safe because of the operating system. These two are safe
 * because of an argument about an alphabet — an argument that stops holding the
 * moment somebody widens LAUNCH_PATH_CHAR, or emits one of these values without
 * the surrounding quotes. Neither is visible from the call site. That is the
 * cost of the two routes that could not be converted, recorded here rather than
 * rounded off.
 */
export const DOUBLE_QUOTED_SHELL_ROUTES = Object.freeze([
  'automation.mjs — the engine spawn (shell:true; npm ships claude/codex as .cmd shims and Node 22 will not spawn a .cmd without a shell)',
  'cli.mjs / engines.mjs — the launch and operator commands PRINTED for a person to paste (nothing of ours runs them)',
]);

/** Human-readable form of a rejected character, for the refusal message. */
function describeChar(ch) {
  const cp = ch.codePointAt(0);
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const NAMED = { ' ': 'space', '\t': 'tab', '\n': 'newline', '\r': 'carriage return' };
  return NAMED[ch] ? `${NAMED[ch]} (${hex})` : `${JSON.stringify(ch)} (${hex})`;
}

/**
 * Thrown instead of returning a verdict, because the caller has no safe
 * continuation. Carries the parts of the refusal as fields so a caller (or a
 * test) can assert on them without parsing the prose.
 */
export class LaunchValueError extends Error {
  constructor(message, { key, where, site, value, reason, character = null }) {
    super(message);
    this.name = 'LaunchValueError';
    this.key = key;
    this.where = where;
    this.site = site;
    this.value = value;
    // 'character' | 'edge-whitespace' | 'leading-dash' | 'trailing-backslash'
    this.reason = reason;
    this.character = character;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Destination sites
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where each key's value was travelling when it was refused. The refusal has to
 * name this: the escape route below is settled PER SITE (an executing sink can
 * be converted to an argument array one at a time; a printed command cannot be
 * converted at all), so a report that does not say which site it hit cannot be
 * acted on.
 *
 * A key with no entry gets the fallback, which says so rather than guessing —
 * that is the case for a key added to the runtime config after this table was
 * written, and the honest message is "new, unclassified, refused anyway".
 */
const SITE_BY_KEY = {
  repoPath: '`git worktree add/remove` and `git remote get-url` (argv, no shell), the engine spawn and the printed launch + operator commands (double-quoted, shell-parsed)',
  REPO_PATH: '`git worktree add/remove` and `git remote get-url` (argv, no shell), the engine spawn and the printed launch + operator commands (double-quoted, shell-parsed)',
  'engines.reasoningEffort': 'the engine spawn (shell:true, as `-c model_reasoning_effort=<value>` — UNQUOTED there) and the printed engine launch command',
  'engines.planner': 'the engine spawn (shell:true) and the printed engine launch command — it is the executable NAME, so it is the command, not an argument to it',
  'engines.reviewer': 'the engine spawn (shell:true) and the printed engine launch command — it is the executable NAME, so it is the command, not an argument to it',
  'grace.repoRoot': '`grace lint --path <value>` (argv, no shell) and `cwd:` on the python/git gates',
  'grace.pilotBranch': 'the `git rev-list`/`git rebase` argv composed for sync-grace (shell:true)',
  'grace.upstreamBranch': 'the `git fetch`/`git rev-list`/`git rebase` argv composed for sync-grace (shell:true)',
  'branches.integration': 'the `git diff <base>...<head>` and `git branch`/`git fetch` command strings (execSync)',
  'branches.prTarget': '`gh pr create --base <value>` (argv, no shell) and the two printed `gh pr create` fallback commands',
  'tracker.type': 'no command line today — refused because it is part of the launch surface and unclassified values are not waved through',
  promptLanguage: 'no command line today — refused because it is part of the launch surface and unclassified values are not waved through',
};

const UNCLASSIFIED_SITE =
  'an unclassified destination — this key is not in launch-safety.mjs\'s site table, ' +
  'which means it was added to the runtime config after the table was written. It is ' +
  'refused rather than waved through; see docs/plans/design/p2-launch-safety.md';

// ─────────────────────────────────────────────────────────────────────────────
//  The check
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_SUMMARY = 'letters, digits, and . _ - : / \\';

/**
 * The escape route, quoted verbatim into every refusal. It exists because a
 * conservative rule will eventually reject a provider identifier that is real,
 * and a contributor who meets that needs somewhere to go that is not "widen the
 * rule" — admitting a character the shell interprets removes the only
 * containment there is, globally, for every value, to admit one.
 */
const ESCAPE_ROUTE = [
  'There is no interim workaround, and inventing one would be worse than saying so:',
  '  · If the tool you are configuring offers an equivalent identifier this rule',
  '    accepts, use it. That is a substitution, not a bypass.',
  '  · Otherwise the capability is unavailable until the route named above stops',
  '    going through a shell. Open an issue on taskctl-oss AGAINST THIS CHECK (not',
  '    against the provider and not against your config), quoting the four lines',
  '    above. That report is the event that starts that work — it is how the space',
  '    came to be allowed in a path, which it was not in the first version of this',
  '    check.',
  'Widening the allow-list is refused, and so is a per-value opt-out from it. The way',
  'a character becomes admissible is the way the space did: convert every route the',
  'key travels, record the conversion in SPACE_PERMITTED_KEYS, and admit it there —',
  'for that key, not globally. Admitting it here instead would admit it on the routes',
  'that were never converted, where the allow-list is the only containment there is.',
].join('\n');

function refuse({ key, where, site, value, reason, character, headline, why }) {
  const lines = [
    `refusing to launch — ${headline}`,
    '',
    `  key:       ${key}`,
    `  set in:    ${where}`,
    `  value:     ${JSON.stringify(value)}`,
    `  rejected:  ${character === null ? reason : describeChar(character)}`,
    `  reaches:   ${site}`,
    '',
    why,
    '',
    ESCAPE_ROUTE,
  ];
  throw new LaunchValueError(lines.join('\n'), { key, where, site, value, reason, character });
}

/**
 * Clear ONE value for argv. Throws LaunchValueError; returns the value
 * unchanged when it passes, so a call site can be written as a pass-through.
 *
 * `null`/`undefined` pass: an absent value never becomes an argv element, and
 * the callers below rely on that to check optional config without a guard each
 * time. A non-string also passes — shape and type are already enforced by
 * config.mjs's validators, and a boolean or a number cannot carry syntax.
 *
 * @param {unknown} value
 * @param {object}  ctx
 * @param {string}  ctx.key    dotted config path, or the environment variable name
 * @param {string}  [ctx.where] where the reader must go to fix it (a file path, or
 *                              'the environment (REPO_PATH)'). Defaults to the
 *                              config file's name for sink-side calls that do not
 *                              know which layer supplied the value.
 * @param {string}  [ctx.site]  overrides the per-key site description, for a
 *                              sink-side call that knows exactly which sink it is
 * @returns {unknown} the value, unchanged
 */
export function assertLaunchValue(value, { key, where = 'taskctl.config.json', site } = {}) {
  if (value === null || value === undefined || typeof value !== 'string') return value;

  const destination = site ?? SITE_BY_KEY[key] ?? UNCLASSIFIED_SITE;
  const common = { key, where, site: destination, value };

  // Which of the two classes applies is decided by the KEY, from the table
  // above, and never by the value or by the call site. A sink-side call that
  // passed its own class could admit a space on one route for a key another
  // route still refuses, which is the failure mode this whole round exists to
  // remove.
  const spacesPermitted = SPACE_PERMITTED_KEYS.has(key);
  const admitted = spacesPermitted ? LAUNCH_PATH_CHAR : LAUNCH_TOKEN_CHAR;

  // 1. The allow-list, character by character. Iterating with for..of walks CODE
  //    POINTS, so an astral character is reported as itself and not as half of a
  //    surrogate pair.
  for (const ch of value) {
    if (admitted.test(ch)) continue;
    refuse({
      ...common,
      reason: 'character',
      character: ch,
      headline: `${key} contains a character that is not allowed in a launch value.`,
      why: spacesPermitted
        ? `${key} is a PATH, so it may contain ${ALLOWED_SUMMARY}, and a space.\n` +
          'It may not contain this character. Some of the commands it reaches are\n' +
          'assembled into a string that a shell parses — ours, or the one you paste a\n' +
          'printed command into — where this character is syntax rather than data.'
        : `A launch value may contain only ${ALLOWED_SUMMARY}. This value is concatenated\n` +
          'into a command line, where a space alone splits one argument into two and a\n' +
          '";" or "|" starts a second command.\n' +
          `(A SPACE is admitted for path-shaped keys — ${[...SPACE_PERMITTED_KEYS.keys()].join(', ')} —\n` +
          ' because every route those travel was made space-safe. This key is not one of\n' +
          ' them: see launch-safety.mjs SPACE_PERMITTED_KEYS for what that would require.)',
    });
  }

  // 1b. A space is admitted INSIDE a path, never at either end. A leading or
  //     trailing space is not a path anybody meant to write — it is a stray
  //     keystroke or a botched string concatenation in a generated config — and
  //     on Windows a trailing space is silently stripped by some APIs and kept by
  //     others, so the directory that is checked and the directory that is used
  //     can differ. Refusing it costs nothing real and closes that gap.
  if (spacesPermitted && value !== value.trim()) {
    refuse({
      ...common,
      reason: 'edge-whitespace',
      character: null,
      headline: `${key} begins or ends with whitespace.`,
      why:
        'A space is allowed inside a path, but not at either end. Windows strips a\n' +
        'trailing space in some path APIs and preserves it in others, so a value padded\n' +
        'this way can pass an existence check and then be used to address a different\n' +
        'directory. This is almost always a stray keystroke — remove it.',
    });
  }

  // 2. Argv injection, which needs no shell at all: `gh pr create --base <value>`
  //    and `git remote get-url` are spawned with shell:false, and a value starting
  //    with "-" is read there as a FLAG rather than as data. A rule about shell
  //    syntax alone would let that through, so this is a separate refusal with its
  //    own message.
  if (value.startsWith('-')) {
    refuse({
      ...common,
      reason: 'leading-dash',
      character: null,
      headline: `${key} begins with "-", which an argv position reads as a flag.`,
      why:
        'Two of the commands this value reaches are spawned WITHOUT a shell, so shell\n' +
        'syntax is not the exposure there — argument position is. A leading "-" makes\n' +
        'the value an option to the program being run instead of data for it.',
    });
  }

  // 3. A trailing backslash escapes the closing quote of a double-quoted argv
  //    element on a POSIX shell (`-C "…\"` swallows the quote and the rest of the
  //    line joins the argument). cmd.exe does not treat "\" as an escape, so this
  //    is a POSIX-only breakout — which is exactly why it must not be left to the
  //    platform the developer happens to be on.
  if (value.endsWith('\\')) {
    refuse({
      ...common,
      reason: 'trailing-backslash',
      character: null,
      headline: `${key} ends with a backslash, which escapes the quote that would contain it.`,
      why:
        'Several of these routes embed the value in a double-quoted argument. On a POSIX\n' +
        'shell a trailing backslash escapes the closing quote, so the rest of the command\n' +
        'line is swallowed into this argument.',
    });
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Printed operator commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a checked launch value for a command we PRINT for a person to paste.
 *
 * This is the one place the printed-command decision is implemented, so it is
 * the one place to argue with. The decision was between emitting a
 * shell-specific serialization (we would have to know which shell the operator
 * uses, and we do not) and restricting the alphabet until the two shell families
 * agree — and the second is what is done, because it is already true:
 *
 *   · a space is literal inside "…" on cmd.exe and on every POSIX shell, and
 *   · every character the two disagree about inside "…" — " $ ` % ! ^ & | ; and
 *     the rest — is refused by assertLaunchValue before it can get here.
 *
 * So `"<value>"` means the same thing in both, and no escaping is applied,
 * because escaping is exactly what the two shells disagree about: `\"` is an
 * escaped quote to a POSIX shell and a quote-terminator to cmd.exe, so anything
 * that emitted a `\"` would be emitting a different command to each. Nothing
 * needs escaping here because nothing that would need it can reach here.
 *
 * It asserts rather than trusts, and it asserts with the SAME function every
 * other site uses. A caller that reaches this with an unchecked value gets a
 * refusal instead of a command with a hostile fragment in it — which matters
 * because this is the route where the exposure is not ours to contain: we do not
 * run the result, the operator does, in a shell we never see.
 *
 * @param {string} value  a launch value (re-checked here, under `key`)
 * @param {object} ctx    forwarded to assertLaunchValue (key/where/site)
 * @returns {string} the value wrapped in double quotes, ready to paste
 */
export function quoteForPastedCommand(value, ctx) {
  assertLaunchValue(value, ctx);
  // A non-string is passed through untouched rather than stringified-and-quoted,
  // so a call site that reaches here with null renders exactly what it rendered
  // before this function existed. Both current callers resolve their path through
  // a helper that throws when it is unset, so this is belt-and-braces — but the
  // alternative is a printed `--repo-path "null"`, which reads like a real path.
  if (typeof value !== 'string') return value;
  return `"${value}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The runtime-config surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The keys of the resolved runtime config that are held OUT of the launch-value
 * check. Everything not listed here is checked, so this table is the whole of
 * what is trusted, and adding to it is the only way to widen that trust.
 *
 * Each entry states where the value goes instead of argv. A key whose
 * destination is not one of these is a launch value by default.
 */
export const NON_LAUNCH_KEYS = new Map([
  ['projectContext', 'free prose rendered into context.md. Prompt text never enters argv: the engine adapters put the prompt FILE PATH in argv, never the file\'s contents.'],
  ['constraints', 'free prose rendered into context.md — same route as projectContext.'],
  ['codeAreas', 'a keyword → paths map rendered into context.md prose — same route as projectContext.'],
  ['previewUrlTemplate', 'substituted into a URL and printed as a URL, not composed into a command.'],
  ['tracker.assigneeEmail', 'reaches an HTTP request body (the Jira client), not a process.'],
  ['configPath', 'the location of taskctl.config.json itself, which is install-derived rather than configured and reaches no command line on its own. Its ONE contribution to a command line is as the directory a relative grace.repoRoot resolves against — and that is covered, because grace.repoRoot is checked AFTER resolution, with the prefix already in it.'],
  ['raw', 'the parsed config file: the object every other key above is computed FROM. Checking it would check each value twice and would reject the free prose that legitimately lives there. A value read out of it by a COMPUTED key is therefore NOT covered — the one blind spot this gate keeps, recorded in the design note.'],
]);

/**
 * Clear the whole RESOLVED runtime config for argv, in one pass, at the moment
 * configuration becomes the object every launch path consumes.
 *
 * It walks the object rather than a list of names on purpose. The enumeration
 * that found these keys is a snapshot of one commit; a walk is not. A key added
 * to `normalizeRuntimeConfig`'s return later is checked with no edit here, and
 * the only way to have a new key skipped is to name it in NON_LAUNCH_KEYS above
 * and say why.
 *
 * It runs on the RESOLVED values, after composition, and not on the config
 * file's raw fields — `grace.repoRoot` arrives here with the config directory
 * already resolved into it, so a metacharacter in that directory is caught. A
 * check on the raw field would miss exactly that segment.
 *
 * @param {object} runtimeConfig  the object normalizeRuntimeConfig is about to return
 * @param {string} configPath     absolute path to taskctl.config.json (named in refusals)
 * @returns {object} runtimeConfig, unchanged
 */
export function assertLaunchConfig(runtimeConfig, configPath) {
  walk(runtimeConfig, '', configPath);
  return runtimeConfig;
}

function walk(node, prefix, where) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    assertLaunchValue(node, { key: prefix, where });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${prefix}[${i}]`, where));
    return;
  }
  if (typeof node !== 'object') return; // boolean / number — cannot carry syntax
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (NON_LAUNCH_KEYS.has(path)) continue;
    walk(value, path, where);
  }
}
