/**
 * W2-F1 · Zone A — the pure edit-policy engine.
 *
 * This module is a LITERAL transcription of the pinned cross-zone contract C2
 * (decision table + classifiers) from `docs/specs/wave-2-f1-v1-build-spec.md`.
 * It is the client-authoritative rule engine behind the four edit-approval
 * presets (Manual / Normal / Strict / Plan). Zone B (`AcpBackend`) builds a
 * {@link PolicySignal} from each `session/request_permission` and calls
 * {@link evaluateEditPolicy}; the resulting {@link PolicyDecision} maps to
 * auto-allow / auto-deny / surface-the-card. We are the out-of-process gate
 * for main-loop FILE EDITS (`write_file`/`patch`) — authoritative and
 * fail-closed for those, but NOT total (F3 honest scope): ordinary shell
 * commands are auto-approved Hermes-side, and subagent (`delegate_task`)
 * edits, `execute_code`/`terminal`, and MCP-tool writes bypass the seam
 * entirely. Recovery for those paths rests on the post-turn checkpoint
 * snapshot (Phase 0), not on this engine. Every branch here is still
 * fail-closed by construction.
 *
 * HARD CONSTRAINTS (spec Global Constraints):
 *  - Pure module: NO `vscode` / `node:fs` / anything but `../../../shared/protocol`
 *    TYPES and the pure `../../../shared/secretPaths` classifiers (W6-FC).
 *    Path classification is segment/basename matching (NOT a glob lib);
 *    command detection is a small hand-rolled splitter (NOT a shell parser).
 *  - Fail-closed A1: anything unmatched ⇒ `ask` (`fallback-ask`), never a silent
 *    `allow`. An edit under `plan` NEVER resolves to allow, even unparseable.
 *  - Total & synchronous: this function does not throw; the caller (Zone B)
 *    still wraps the interception so any upstream exception falls back to ask.
 *
 * Evaluation order (C2 + W4 §4.2): F1 → **F-M** (SF-2 mode floor) → F2 → F3 →
 * F4, then preset posture (P1, S1, S2, N1), first match wins, else
 * `fallback-ask`. F-M is a deny-only floor (SF-2 custom-mode file
 * restrictions) — it composes with C2 by narrowing only: it adds no `allow`
 * outcome, so N1 stays the only auto-allow and `pickStrictest` (Zone B's
 * multi-effect fold) needs no change.
 */
import type { EditPolicyPreset } from '../../../shared/protocol';
import { classifyPath, isSecretForCompletion, isSecretForEditFloor } from '../../../shared/secretPaths';

// W6-FC (final-3way-arch.md I-6): `classifyPath`/`isSecretForCompletion` now
// LIVE in the pure `shared/secretPaths.ts` (vscode-free/fs-free, no edit-
// approval review friction on routine egress-list edits). Re-exported here
// byte-identically so every existing importer of THIS module's `classifyPath`
// (the frozen edit-approval floor) is unaffected by the move — the frozen
// contract is untouched. `isSecretForCompletion` is re-exported too for
// existing host-side importers; new/autocomplete-side importers should
// prefer importing directly from `shared/secretPaths.ts`.
export { classifyPath, isSecretForCompletion };
// D4 (Decision 4, user sign-off 2026-07-16): `isSecretForEditFloor` is the
// NAME the F2 secret floor and N1 auto-allow below now consult for the
// `secret` half of their check — deliberately the egress SUPERSET, not
// `classifyPath`. `classifyPath` remains imported/used here ONLY for the
// `protected` class (N1) and its own frozen contract elsewhere in the repo;
// it is no longer consulted for `secret` in this file. Not re-exported: no
// external importer needs it (kept local to the two call sites below).

/** Terminal decision for a single permission request. */
export type PolicyOutcome = 'allow' | 'ask' | 'deny';

/** The engine's verdict. `ruleId`/`reason` feed the pinned `[policy] …` audit line. */
export interface PolicyDecision {
  outcome: PolicyOutcome;
  ruleId: string;
  reason: string;
}

/**
 * SF-2 (W4 §4.1) custom-mode floor snapshot — pure DATA, no behavior. T4b
 * builds this (settings read + snapshot-on-activate); the engine only reads
 * it. `deny`/`allowOnly` entries use the restricted rule grammar matched by
 * {@link violatesModeFloor}: exact workspace-relative path | directory prefix
 * ending `/` | basename suffix `*.ext`. No glob lib, no `**`/braces/negation.
 */
export interface ModeFloor {
  deny: readonly string[];
  /** Presence ⇒ everything NOT matching one of these rules is denied. */
  allowOnly?: readonly string[];
}

/** A proposed file edit, reduced by Zone B to POSIX paths + precomputed signals. */
export interface EditSignal {
  kind: 'edit';
  /**
   * POSIX-normalized paths of the proposed edit (workspace-relative when inside;
   * absolute otherwise). Empty ⇒ unparseable ⇒ engine returns `ask` (fail-closed,
   * F1) — or `deny` under `plan` (never allows an edit).
   */
  paths: string[];
  /** True only when EVERY path is confined to the workspace roots. */
  insideWorkspace: boolean;
  /** True when the current turn has a before-checkpoint (F2 Phase 0 signal). */
  turnProtected: boolean;
  /** SF-2: the active custom mode's snapshot, or undefined when no mode is active. */
  modeFloor?: ModeFloor;
}

/** A proposed command execution. */
export interface CommandSignal {
  kind: 'command';
  /** Raw command text; `''` ⇒ unparseable ⇒ `ask` (F1). */
  command: string;
}

/** Discriminated union of everything the engine gates. */
export type PolicySignal = EditSignal | CommandSignal;

/**
 * Rule-naming `reason` strings (C2 note: the reason must name the rule for the
 * audit line). Frozen so no importer can mutate the shared table.
 */
const REASON = Object.freeze({
  emptySignal: 'empty-signal floor (F1): unparseable edit/command — ask (fail-closed)',
  planReadonly: 'plan preset is read-only (P1): edits are never permitted',
  modeRestriction:
    'mode-restriction floor (F-M): edit path is outside the active custom mode scope — deny under every preset (narrows only, never widens)',
  secretPath: 'secret-path floor (F2): an edit path matches a secret pattern',
  substitution: 'dangerous-substitution floor (F3): command contains a shell substitution',
  dangerousCommand: 'dangerous-command floor (F4): command matches a destructive pattern',
  strictNoCheckpoint: 'strict floor (S1): edit on an unprotected turn (no before-checkpoint)',
  strictOutside: 'strict floor (S2): edit targets a path outside the workspace',
  normalSafeEdit:
    'normal auto-allow (N1): in-workspace, checkpoint-protected, non-secret, non-protected edit',
  fallbackAsk: 'no rule matched — ask (fail-closed A1)',
} as const);

/**
 * Evaluate the pinned C2 decision table for one (preset, signal) pair.
 *
 * The body is the table read top-to-bottom: each `if` is one row, and where a
 * floor's outcome differs by preset the branch resolves the correct cell
 * (`strict`/`plan` deny; others ask). No cleverness — this is a transcription.
 */
export function evaluateEditPolicy(preset: EditPolicyPreset, signal: PolicySignal): PolicyDecision {
  // ── F1 `floor-empty-signal` ── unparseable edit (no paths) or command (''). ──
  // Plan never permits an edit, even an unparseable one ⇒ deny (`plan-readonly`).
  // A command is not an edit, so plan's carve-out does not apply to F1 commands.
  const emptySignal = signal.kind === 'edit' ? signal.paths.length === 0 : signal.command === '';
  if (emptySignal) {
    if (preset === 'plan' && signal.kind === 'edit') {
      return { outcome: 'deny', ruleId: 'plan-readonly', reason: REASON.planReadonly };
    }
    // SF-2 second F1 carve-out (B4, mirrors the plan carve-out above): an
    // `allowOnly` mode is a POSITIVE-PROOF requirement — an edit whose target
    // cannot be determined is NOT provably in-scope, so it is out-of-scope ⇒
    // deny (mirrors plan's "never permits even an unparseable edit"). A
    // `deny`-only mode has nothing to negatively match on an empty path, so it
    // falls through to F1's ordinary `ask` (the A1 fail-closed default; the
    // human card is the backstop).
    if (signal.kind === 'edit' && signal.modeFloor?.allowOnly) {
      return { outcome: 'deny', ruleId: 'mode-restriction', reason: REASON.modeRestriction };
    }
    return { outcome: 'ask', ruleId: 'floor-empty-signal', reason: REASON.emptySignal };
  }

  // ── F-M `mode-restriction` (SF-2, immediately after F1, BEFORE F2 — critic
  // pin B3) ── path outside the active custom mode's scope. deny-wins, ALL
  // presets. An in-scope path FALLS THROUGH to F2/F3/F4 + preset posture.
  // Narrows, never widens: adds no `allow` outcome, so N1 stays the ONLY
  // auto-allow and `findAllowOptionId` (Zone B) is untouched. Placement is
  // BEFORE F2 so a path that is BOTH secret and mode-denied resolves via F-M
  // (deny under every preset), not F2's `ask` under manual/normal — "deny
  // everything not listed" must not be preempted by the secret-path floor.
  if (signal.kind === 'edit' && signal.modeFloor && signal.paths.length > 0) {
    const modeFloor = signal.modeFloor;
    if (signal.paths.some((p) => violatesModeFloor(p, modeFloor))) {
      return { outcome: 'deny', ruleId: 'mode-restriction', reason: REASON.modeRestriction };
    }
  }

  // ── F2 `floor-secret-path` ── edit touching any secret path. ──
  // strict/plan hard-deny; manual/normal ask. (Secret is the ONLY class that is
  // hard-denied — `protected` never is; see N1 / the protected-path row.)
  // D4 (user sign-off 2026-07-16): consults `isSecretForEditFloor` (the
  // egress superset), not `classifyPath` — so credential-class files
  // `classifyPath` doesn't know (credentials.json, .aws/, keystores, …) are
  // now gated here too. `classifyPath` stays byte-frozen; see secretPaths.ts.
  if (signal.kind === 'edit' && signal.paths.some((p) => isSecretForEditFloor(p))) {
    const deny = preset === 'strict' || preset === 'plan';
    return { outcome: deny ? 'deny' : 'ask', ruleId: 'floor-secret-path', reason: REASON.secretPath };
  }

  // ── F3 `floor-substitution` ── command with a shell substitution. ──
  if (signal.kind === 'command' && detectDangerousSubstitution(signal.command)) {
    const deny = preset === 'strict' || preset === 'plan';
    return { outcome: deny ? 'deny' : 'ask', ruleId: 'floor-substitution', reason: REASON.substitution };
  }

  // ── F4 `floor-dangerous-command` ── command matching a destructive pattern. ──
  if (signal.kind === 'command' && isDangerousCommand(signal.command)) {
    const deny = preset === 'strict' || preset === 'plan';
    return {
      outcome: deny ? 'deny' : 'ask',
      ruleId: 'floor-dangerous-command',
      reason: REASON.dangerousCommand,
    };
  }

  // ── P1 `plan-readonly` ── plan preset denies every (surviving) edit. ──
  if (preset === 'plan' && signal.kind === 'edit') {
    return { outcome: 'deny', ruleId: 'plan-readonly', reason: REASON.planReadonly };
  }

  // ── S1 `strict-no-checkpoint` ── strict denies edits on an unprotected turn. ──
  if (preset === 'strict' && signal.kind === 'edit' && !signal.turnProtected) {
    return { outcome: 'deny', ruleId: 'strict-no-checkpoint', reason: REASON.strictNoCheckpoint };
  }

  // ── S2 `strict-outside-workspace` ── strict denies edits outside the workspace. ──
  if (preset === 'strict' && signal.kind === 'edit' && !signal.insideWorkspace) {
    return { outcome: 'deny', ruleId: 'strict-outside-workspace', reason: REASON.strictOutside };
  }

  // ── N1 `normal-safe-edit` ── the ONLY auto-allow: normal + the quadruple-safe
  // edit (in-workspace ∧ protected-turn ∧ non-secret ∧ non-protected). ──
  // D4 (user sign-off 2026-07-16): the `secret` half now goes through
  // `isSecretForEditFloor` (the egress superset) instead of `classifyPath`,
  // so a credential-class file `classifyPath` doesn't know never reaches
  // auto-allow (F2 above already asks/denies it first in practice — this is
  // belt-and-suspenders for any future reordering). `protected` is UNCHANGED:
  // still sourced from `classifyPath` only (self-protection class, not part
  // of the egress superset).
  if (
    preset === 'normal' &&
    signal.kind === 'edit' &&
    signal.insideWorkspace &&
    signal.turnProtected &&
    !signal.paths.some((p) => {
      const cls = classifyPath(p);
      return isSecretForEditFloor(p) || cls.protected;
    })
  ) {
    return { outcome: 'allow', ruleId: 'normal-safe-edit', reason: REASON.normalSafeEdit };
  }

  // ── fallback ── everything else asks (fail-closed A1): ALL edits under manual,
  // ALL commands under every preset, protected-path edits under normal, and
  // every non-floored edit/command under strict (strict never auto-allows).
  return { outcome: 'ask', ruleId: 'fallback-ask', reason: REASON.fallbackAsk };
}

/* ------------------------------------------------------------------ *
 * Mode-floor matcher (C2/SF-2 pinned): segment = split on `/`; basename =
 * last segment; case-sensitive. Pure — no fs, no realpath. Exported for
 * tests + reuse by Zone B. NB: containment/normalization is Zone B's job;
 * here we only pattern-match the already-POSIX path string. `classifyPath`
 * itself now lives in `shared/secretPaths.ts` (W6-FC, re-exported above).
 * ------------------------------------------------------------------ */

/**
 * SF-2 (W4 §4.1) restricted rule grammar — matches ONE mode rule against an
 * already-canonical POSIX path. Deliberately restricted (no glob lib, no
 * `**`/braces/negation, mirroring the v1 no-glob decision above): a rule is
 * one of
 *  - **directory prefix** when it ends `/` (`src/` matches any path whose
 *    leading segments are `src/…`, e.g. `src/a.ts`, `src/nested/b.ts` — but
 *    NOT `srcfoo/a.ts`, because the trailing `/` is part of the match);
 *  - **basename suffix** when it starts `*` (`*.ext` matches any path whose
 *    BASENAME ends `.ext`, e.g. `a.ext` and `src/a.ext`, but not `a.extra`);
 *  - **exact workspace-relative path** otherwise (`src/a.ts` matches only
 *    `src/a.ts`, not `src/a.ts.bak` or `src/b.ts`).
 * Case-sensitive throughout; `../` is a non-issue since paths reaching the
 * engine are already canonical (Zone B's job, not ours).
 */
function matchesModeRule(path: string, rule: string): boolean {
  if (rule.endsWith('/')) return path.startsWith(rule);
  if (rule.startsWith('*')) {
    const segments = path.split('/');
    const basename = segments.at(-1) ?? '';
    return basename.endsWith(rule.slice(1));
  }
  return path === rule;
}

/**
 * SF-2 (W4 §4.2) the pure matcher behind floor F-M. A path VIOLATES the floor
 * when `allowOnly` is present and the path matches NONE of its rules
 * (positive-proof required — "deny everything not listed"); OR the path
 * matches ANY `deny` rule. `deny` always wins, even over an `allowOnly` match
 * — there is no case where a mode floor produces an `allow`; it only narrows.
 */
export function violatesModeFloor(path: string, modeFloor: ModeFloor): boolean {
  if (modeFloor.allowOnly && !modeFloor.allowOnly.some((rule) => matchesModeRule(path, rule))) {
    return true;
  }
  return modeFloor.deny.some((rule) => matchesModeRule(path, rule));
}

/* ------------------------------------------------------------------ *
 * Command detectors (C2 pinned, v1). Hand-rolled — NO shell parser: v1 does not
 * honor quoting/escapes (a `|` inside quotes still splits). That is deliberate
 * per the spec (fail-closed toward flagging) and out of scope to fix here.
 * ------------------------------------------------------------------ */

/** Shell-substitution triggers (C2): `$(`, a backtick, `<(`, `>(`, `=(`. */
export function detectDangerousSubstitution(command: string): boolean {
  return (
    command.includes('$(') ||
    command.includes('`') ||
    command.includes('<(') ||
    command.includes('>(') ||
    command.includes('=(')
  );
}

/** Shell sub-command separators, longest-first so `&&`/`||` win over `|`. */
type SubCommandOp = 'start' | '&&' | '||' | ';' | '|';

interface SubCommand {
  /** The operator that PRECEDED this sub-command (`start` for the first). */
  op: SubCommandOp;
  /** Whitespace-split tokens of the sub-command (empties removed). */
  tokens: string[];
}

/**
 * Split a command on the shell separators `&&`, `||`, `;`, `|`, remembering the
 * operator before each piece (the pipe-into-shell rule needs to know the piece
 * was reached via a single `|`, not `||`/`;`). Two-char operators are matched
 * before the single-char `|` so `||` is never mistaken for a pipe.
 */
function splitIntoSubCommands(command: string): SubCommand[] {
  const pieces: { op: SubCommandOp; text: string }[] = [];
  let current = '';
  let op: SubCommandOp = 'start';

  for (let i = 0; i < command.length; i++) {
    const two = command.slice(i, i + 2);
    const ch = command[i];
    if (two === '&&' || two === '||') {
      pieces.push({ op, text: current });
      op = two;
      current = '';
      i++; // consume the second operator char
    } else if (ch === ';' || ch === '|') {
      pieces.push({ op, text: current });
      op = ch;
      current = '';
    } else {
      current += ch;
    }
  }
  pieces.push({ op, text: current });

  return pieces.map((piece) => ({
    op: piece.op,
    tokens: piece.text.trim().split(/\s+/).filter((t) => t.length > 0),
  }));
}

/** True if any token is a short-flag bundle (`-x`, not `--long`) containing `flag`. */
function hasShortFlag(tokens: string[], flag: string): boolean {
  return tokens.some((t) => t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes(flag));
}

/** Collect whether an `rm` invocation carries the recursive (r) AND force (f) flags. */
function rmHasRecursiveForce(tokens: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const t of tokens) {
    if (t === '--recursive') recursive = true;
    else if (t === '--force') force = true;
    else if (t.startsWith('-') && !t.startsWith('--')) {
      const chars = t.slice(1);
      if (chars.includes('r')) recursive = true;
      if (chars.includes('f')) force = true;
    }
  }
  return recursive && force;
}

/** First tokens that make a whole sub-command destructive regardless of args. */
const ALWAYS_DANGEROUS_HEADS = new Set(['sudo', 'mkfs', 'shutdown', 'reboot', 'dd']);
/** Shells that, when piped INTO, make a command a curl-pipe-to-shell vector. */
const SHELL_HEADS = new Set(['sh', 'bash', 'zsh']);

/**
 * Dangerous-command detection (C2). Splits into sub-commands on `&&`/`||`/`;`/`|`
 * and checks EACH — one dangerous sub-command taints the whole (Kilo parsed-
 * command rule). A sub-command is dangerous when its head is an always-dangerous
 * binary; OR `rm` with both recursive+force; OR `chmod -R … 777`; OR
 * `git push --force`/`-f`; OR it is a shell that a single `|` pipes INTO.
 */
export function isDangerousCommand(command: string): boolean {
  for (const sub of splitIntoSubCommands(command)) {
    const head = sub.tokens[0];
    if (head === undefined) continue; // empty piece (e.g. trailing `;`)

    // Pipe-into-shell: `… | sh|bash|zsh`. Only a single `|` counts (not `||`/`;`).
    if (sub.op === '|' && SHELL_HEADS.has(head)) return true;

    if (ALWAYS_DANGEROUS_HEADS.has(head)) return true;

    // `rm -rf` / `-fr` / `-r -f` / `--recursive --force`.
    if (head === 'rm' && rmHasRecursiveForce(sub.tokens)) return true;

    // `chmod -R … 777`.
    if (head === 'chmod' && hasShortFlag(sub.tokens, 'R') && sub.tokens.includes('777')) return true;

    // `git push --force` / `git push -f`.
    if (
      head === 'git' &&
      sub.tokens.includes('push') &&
      (sub.tokens.includes('--force') || hasShortFlag(sub.tokens, 'f'))
    ) {
      return true;
    }
  }
  return false;
}
