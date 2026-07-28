import type { EditSignal, CommandSignal, ModeFloor } from '../policy/editPolicy';
import type { AcpToolCallFields } from './types';
import { extractDiffs, extractToolCallOutputText } from './contentBlocks';

/**
 * W2-F1 (Zone B) + Bucket 1 F1/F2: the PURE policy-signal helpers that turn a
 * raw ACP `session/request_permission` tool call into the {@link EditSignal} /
 * {@link CommandSignal} the client policy engine ({@link ../policy/editPolicy},
 * contract C2) evaluates.
 *
 * Bucket 1 F1 (CWE-22/59/180) split the responsibilities: path RESOLUTION
 * (realpath, `~` expansion, symlink-leaf refusal, root containment) is IMPURE
 * and lives in the fs layer (`pathConfine.canonicalizeEditPath`), orchestrated
 * by `AcpBackend.handleRequestPermission`. This module only (a) extracts the
 * raw path/command strings from the request and (b) packages ALREADY-RESOLVED
 * values into signals — so it stays fs-free and vscode-free (the headless-test
 * invariant behind the pure engine suite).
 */

/**
 * One already-canonicalized edit path, as resolved by the fs layer
 * (`pathConfine.canonicalizeEditPath` returns a superset of this shape).
 */
export interface ResolvedEditPath {
  /** Canonical absolute path (native separators tolerated; normalized here). */
  canonicalPath: string;
  /** POSIX workspace-relative path when contained, else `null`. */
  relPath: string | null;
  /** "Safe to treat as an in-workspace edit" (containment AND no symlink leaf AND no unresolved `~user`). */
  insideWorkspace: boolean;
}

/**
 * Package already-canonical resolved paths into the C2 {@link EditSignal}:
 * workspace-relative POSIX when inside, canonical-absolute POSIX otherwise.
 * `insideWorkspace` is true only when EVERY path resolved inside (no paths ⇒
 * false ⇒ the engine fails closed on the empty signal).
 *
 * W4-T4b (SF-2): `modeFloor`, when provided, is threaded onto the returned
 * signal unchanged — this is the enforcement wire `SessionController` feeds
 * from its `activeCustomMode` snapshot at BOTH call sites in
 * `buildPresentEffectSignals`, INCLUDING the empty-path call (`resolved=[]`)
 * the F1 allowOnly carve-out (`editPolicy.ts`) depends on. Omitted (no key
 * on the returned object) when not provided, so every existing two-arg
 * caller/assertion is unaffected.
 */
export function buildEditSignalFromResolved(
  resolved: readonly ResolvedEditPath[],
  turnProtected: boolean,
  modeFloor?: ModeFloor,
): EditSignal {
  const paths = resolved.map((entry) =>
    toPosix(entry.insideWorkspace && entry.relPath !== null ? entry.relPath : entry.canonicalPath),
  );
  return {
    kind: 'edit',
    paths,
    insideWorkspace: resolved.length > 0 && resolved.every((entry) => entry.insideWorkspace),
    turnProtected,
    ...(modeFloor !== undefined ? { modeFloor } : {}),
  };
}

/**
 * Command text, in the pinned priority order (C3): `rawInput.command` → else the
 * mapped `detail` text with a leading `"$ "` stripped → else `''` (unparseable ⇒
 * the engine fails closed).
 */
export function buildCommandSignal(toolCall: AcpToolCallFields): CommandSignal {
  const rawInput = asRecord(toolCall.rawInput);
  const rawCommand = rawInput && typeof rawInput.command === 'string' ? rawInput.command : '';
  if (rawCommand.length > 0) return { kind: 'command', command: rawCommand };

  const detail = extractToolCallOutputText(toolCall.content);
  return { kind: 'command', command: stripLeadingDollar(detail) };
}

/**
 * Raw edit-path strings: the UNION of `rawInput.arguments.path` (`write_file` /
 * `patch` mode `replace`; a V4A comma-joined value is split) and EVERY
 * diff-content path (also comma-split), deduplicated in first-seen order.
 *
 * Bucket 1 F2 (CWE-807 / LLM06 complete mediation): `arguments.path` must
 * NEVER short-circuit the diff paths — a decoy `arguments.path='src/app.ts'`
 * hiding a diff that touches `.git/hooks` would otherwise be classified from
 * the decoy alone and auto-allowed under `normal`.
 *
 * Exported for the resolver (the fs layer canonicalizes each raw string).
 */
export function extractEditPathStrings(toolCall: AcpToolCallFields): string[] {
  const rawInput = asRecord(toolCall.rawInput);
  const args = rawInput ? asRecord(rawInput.arguments) : undefined;
  const argPath = args && typeof args.path === 'string' ? args.path : undefined;

  const union: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    if (!seen.has(raw)) {
      seen.add(raw);
      union.push(raw);
    }
  };

  if (argPath && argPath.length > 0) for (const p of splitJoinedPaths(argPath)) add(p);
  // Audit C-2: the V4A patch BODY is the authoritative statement of what will
  // be written — `arguments.path` is a summary Hermes derives with a STRICTER
  // regex than the one its writer uses, and `content` is only what the agent
  // chose to SHOW. Parse the body ourselves with the lenient grammar. This
  // union is what `permission.ts:applyResolvedPresentation` turns into the
  // card's "Edit: …" title, so widening it here is what makes that title
  // stop being confidently incomplete.
  const patchBody = args && typeof args.patch === 'string' ? args.patch : undefined;
  if (patchBody !== undefined) for (const p of extractV4aPatchPaths(patchBody)) add(p);
  for (const diff of extractDiffs(toolCall.content)) {
    for (const p of splitJoinedPaths(diff.path)) add(p);
  }
  return union;
}

/**
 * Every file path declared by a V4A patch BODY, using the **lenient** grammar
 * Hermes actually applies with.
 *
 * Audit C-2 (Critical). Hermes reads V4A headers with two different regexes:
 *  - `acp_adapter/edit_approval.py:131-138` — `^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$`
 *    — builds the list it ASKS US ABOUT. Requires whitespace after `***`.
 *  - `tools/patch_parser.py:111-114` — `re.match(r'\*\*\*\s*Update\s+File:\s*(.+)', line)`
 *    (and the matching Add/Delete/Move variants) — the parser that WRITES TO
 *    DISK. `\s*`: zero spaces is legal.
 * A header spelled `***Update File: x` is therefore invisible to the approval
 * list and fully applied by the writer.
 *
 * Hermes already fixed this in a THIRD copy and left the reasoning at
 * `tools/file_tools.py:1756-1760`: "``\s*`` (not ``\s+``) after ``***``
 * matches patch_parser leniency: it accepts ``***Update File:`` with no space
 * after the asterisks… Requiring a space here let a no-space header parse +
 * apply while skipping this check." `edit_approval.py:141-151` already
 * extracts BOTH endpoints of `*** Move File: src -> dst` — the actual Move
 * divergence there is the same zero-width-`***` case as Update/Add/Delete
 * (`edit_approval.py` requires `\s+` after `***`; the writer accepts `\s*`).
 * This function mirrors the FIXED copy's leniency for every header, Move
 * included.
 *
 * Deliberately more permissive than either: a path we surface but Hermes never
 * writes costs one extra approval card; a path we miss is a silent write. Egress
 * and mediation guards fail toward MORE mediation.
 *
 * Two care points baked into the character class below (both found in review
 * of this same function):
 *  - Whitespace here is HORIZONTAL-ONLY (`HWS`, never `\r`/`\n`). JS's `\s`
 *    metaclass includes `\n`; `patch_parser.py` is strictly line-by-line
 *    (`patch_content.split('\n')`), so its Python `\s*` can never cross a
 *    line boundary. Naively porting `\s*` to JS let an EMPTY-path header's
 *    trailing `\s*` swallow the newline and capture the *entire next line* as
 *    the "path" — the real header on that next line was then never matched
 *    on its own, and `classifyPath` on the bogus captured string silently
 *    auto-allowed the real write. Horizontal-only whitespace is therefore
 *    strictly MORE faithful to patch_parser.py, not a narrowing.
 *  - The class also includes `\x1c-\x1f` (the C0 "information separator"
 *    controls) and `\x85` (NEL) even though JS's `\s` excludes them: Python's
 *    `\s` on `str` patterns is a superset of JS's and matches these too, so
 *    `patch_parser.py` accepts e.g. `***\x1cUpdate File: x` and writes `x`.
 *    Omitting them here would silently reopen the exact hole this function
 *    exists to close.
 *
 * Known, deliberately UNFIXED divergences from patch_parser.py (both already
 * masked today by the diff-content channel — the raw patch body is shown to
 * the human verbatim regardless of what this function extracts):
 *  - A path containing a literal lone `\r` (no paired `\n`) is truncated at
 *    the `\r` here (JS's `.`/`$` treat lone `\r` as a line terminator even in
 *    a single Python "line"); Python's `.` does not treat `\r` specially, so
 *    `notes.txt\rsecret.env` writes to a single mangled path there but we
 *    only see `notes.txt`.
 *  - A path containing U+2028/U+2029 (Unicode LINE/PARAGRAPH SEPARATOR) is
 *    likewise truncated here (JS multiline `^`/`$` treat them as line
 *    terminators) but not by Python (its line splitting is `\n`-only).
 *
 * Pure and total: never throws, for any input including `''`.
 */
export function extractV4aPatchPaths(patch: string): string[] {
  // Horizontal whitespace only (`[^\S\r\n]`, i.e. JS `\s` minus `\r`/`\n`),
  // plus the Python-`\s`-only chars `patch_parser.py` also accepts on a
  // single line. See the two care-point bullets above.
  const HWS = String.raw`(?:[^\S\r\n]|[\x1c-\x1f\x85])`;
  const paths: string[] = [];
  const fileHeader = new RegExp(
    String.raw`^\*\*\*${HWS}*(?:Update|Add|Delete)${HWS}+File:${HWS}*(.+)$`,
    'gm',
  );
  for (const match of patch.matchAll(fileHeader)) {
    const p = (match[1] ?? '').trim();
    if (p.length > 0) paths.push(p);
  }
  const moveHeader = new RegExp(
    String.raw`^\*\*\*${HWS}*Move${HWS}+File:${HWS}*(.+?)${HWS}*->${HWS}*(.+)$`,
    'gm',
  );
  for (const match of patch.matchAll(moveHeader)) {
    for (const raw of [match[1], match[2]]) {
      const p = (raw ?? '').trim();
      if (p.length > 0) paths.push(p);
    }
  }
  return paths;
}

/** V4A multi-file proposals comma-join their paths (`edit_approval.py:131-152`); split them. */
function splitJoinedPaths(raw: string): string[] {
  return raw
    .split(', ')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function stripLeadingDollar(detail: string): string {
  return detail.startsWith('$ ') ? detail.slice(2) : detail;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Convert any backslash separators to POSIX so classification is `path.posix`-consistent (Fedora target). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
