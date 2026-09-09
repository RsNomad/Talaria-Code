/**
 * nextedit/nextEditEgress.ts — WS-F3 F3-4 (FI-06, FI-27): the diff-egress
 * predicate + the pure diff/content-change helpers, moved out of
 * `shell.vscode.ts` verbatim, except for two intended changes (below).
 *
 * REUSE MODULE, per `reuseLocks.test.ts`'s own named-list idiom (mirroring
 * `nextEditRoute.ts`'s header): a NEW leaf under `nextedit/` that is not
 * `*.vscode.ts` and not `*.test.ts`, so it is discovered by both
 * `reuseLocks.test.ts`'s network-call guard sweep and
 * `nextEditPurity.test.ts`'s pure/headless-boundary sweep. Named here — not
 * merely counted — for the same reason those locks name every file they
 * touch: it was looked at, and it is clean.
 *
 * VSCODE-FREE — NOT in `nextEditPurity.test.ts`'s `ADAPTER_ALLOW` (locked at
 * exactly 4 files: `config.ts`, `guard.ts`, `shell.vscode.ts`,
 * `nextEditNotice.vscode.ts`): this module never imports the `vscode`
 * package itself, in any form — not even `import type`.
 *
 * `diffMayEgress` is the SECURITY PREDICATE that keeps a secret-bearing diff
 * off the wire (it runs the same sentinel guard + `scanSnippetForSecrets`
 * check, fail-closed on throw, that `scan.ts`'s mint runs — see its own doc
 * comment below) — moved BYTE-IDENTICAL, body and doc comment both, with no
 * logic change of any kind. `diffEgressDrift.lock.test.ts` proves this
 * predicate agrees with the mint diff-for-diff; `shell.vscode.ts` re-exports
 * it so that lock's `import { diffMayEgress } from './shell.vscode'` keeps
 * resolving with zero edits (F3-9 later repoints the lock directly here).
 *
 * FI-27 — `partitionEgressableDiffs` (which returned `{ kept, dropped }`) is
 * RENAMED `filterEgressableDiffs` and now returns ONLY the kept list. Nothing
 * ever read `.dropped` (the sole call site destructured `.kept` alone), so
 * dropping the dead counter changes no observable behaviour; the retired
 * "`dropped` — WHAT IT IS AND IS NOT" prose that explained why the count was
 * kept-but-unread is absorbed into ADR-025-L, not carried forward here. The
 * kept-computation itself is unchanged: `kept` accumulates `diff` exactly
 * when `diffMayEgress(diff, sentinels)`.
 *
 * The structural re-type (critic I-1) — this is what lets THIS module go
 * vscode-free: `toContentChangeLites`'s parameter used to be
 * `readonly vscode.TextDocumentContentChangeEvent[]`; it is now the LOCAL
 * structural `ContentChangeLike[]` below, which names exactly the four
 * fields the body reads (`range.start.line`, `range.start.character` — the
 * sort tiebreaker — `range.end.line`, `text`) and nothing more.
 * `vscode.TextDocumentContentChangeEvent` is structurally assignable to it
 * (its `range.start` is a `Position`, carrying both `line` and `character`;
 * `range.end` carries `line`; `text` is a `string`), and readonly-array
 * covariance carries `readonly vscode.TextDocumentContentChangeEvent[]` into
 * `readonly ContentChangeLike[]` — so the shell's own call site
 * (`toContentChangeLites(e.contentChanges)`) still typechecks with no change
 * at all.
 *
 * This module makes no network call of any kind and never spells the banned
 * network-call token, not even in a comment — `reuseLocks.test.ts`'s raw-
 * content sanity scan confirms that byte-for-byte on every run.
 */
import { scanSnippetForSecrets } from '../context/secretScanner';
import type { ContentChangeLite } from './anchors';
import type { RecentDiff } from './types';

/**
 * A structural twin of the four `vscode.TextDocumentContentChangeEvent`
 * fields `toContentChangeLites` actually reads — kept LOCAL (never imported
 * from `vscode`) so this module stays vscode-free. `character` is REQUIRED:
 * the sort below breaks a same-line tie on it.
 */
export interface ContentChangeLike {
  range: { start: { line: number; character: number }; end: { line: number } };
  text: string;
}

/**
 * F-3 — would this ONE diff survive the mint's own per-field checks?
 *
 * Runs exactly what `scan.ts` runs for a `diffs[]` entry, in the same order
 * (sentinel guard, then `scanSnippetForSecrets`, throw-is-reject), against the
 * SAME `diff.filepath` string the mint will use. That identity is the whole
 * point: normalizing the path here — or checking a different predicate, e.g.
 * the active-file `isSecretForCompletion` gate — would let a diff pass this
 * filter and still abort the mint, which is the bug this closes.
 *
 * An EMPTY sentinel is deliberately not treated as a diff verdict: the mint
 * rejects the whole request for it (`ruleId=empty-sentinel`, a caller-contract
 * bug, not content), and quietly dropping every diff would hide that.
 *
 * FINAL REVIEW — FINDING 7. That identity used to be held by this comment
 * alone. Behavioural tests covered the FILTER, but nothing tied its verdict to
 * the MINT's, and the two are separate code paths that must agree exactly:
 * a diff that passes this filter while the mint still aborts fails CLOSED into
 * a silent kill — every next-edit request in every file dies at the mint with
 * the trigger's catch reporting nothing, which is the precise bug F-3 existed
 * to fix. Same shape the five duplicated line-splitters had before
 * `lineSplitDrift.lock.test.ts` tied them.
 *
 * EXPORTED ONLY for that lock (`diffEgressDrift.lock.test.ts`), mirroring
 * `scan.ts`'s own `contentChecksFor` — "Exported ONLY for the fail-closed
 * drift lock in scan.test.ts". Not part of the shell's API; no production
 * caller outside this module.
 */
export function diffMayEgress(diff: RecentDiff, sentinels: readonly string[]): boolean {
  for (const content of [diff.before, diff.after]) {
    for (const sentinel of sentinels) {
      if (sentinel.length > 0 && content.includes(sentinel)) return false;
    }
    let allowed: boolean;
    try {
      allowed = scanSnippetForSecrets({ path: diff.filepath, content }).allowed;
    } catch {
      allowed = false; // fail-closed, mirroring ringBuffer.ingest's throw-is-reject
    }
    if (!allowed) return false;
  }
  return true;
}

/**
 * F-3 — the caller-side filter that keeps ONE poisoned diff from killing the
 * whole feature.
 *
 * `getRecentDiffs()` is a CROSS-DOCUMENT ring (`editTrackerAdapter.ts`), so a
 * single edit in `.env` used to make every next-edit request in every file
 * abort at the mint (first reject aborts the whole mint) — silently, because
 * the trigger's catch reported nothing. `ringBuffer.ingest` already answers
 * this for the FIM side: DROP the offending entry, keep the feature alive
 * everywhere else.
 *
 * This does not weaken the mint and cannot: the mint still fail-closed-scans
 * everything it is handed, including these very diffs, and remains the
 * authority. This only stops the shell from handing it auxiliary context it
 * had no business collecting for egress in the first place.
 *
 * FI-27 (WS-F3 F3-4) — RENAMED from `partitionEgressableDiffs`, which
 * returned `{ kept, dropped }`. Nothing ever read `.dropped` (the sole call
 * site destructured `.kept` alone), so it — and the paragraph explaining why
 * that silence was deliberate-but-unread — is retired (ADR-025-L absorbs that
 * prose). This returns the kept list ONLY; the kept-computation itself is
 * unchanged.
 */
export function filterEgressableDiffs(
  diffs: readonly RecentDiff[],
  sentinels: readonly string[],
): readonly RecentDiff[] {
  const kept: RecentDiff[] = [];
  for (const diff of diffs) {
    if (diffMayEgress(diff, sentinels)) {
      kept.push(diff);
    }
  }
  return kept;
}

/**
 * `changesAboveCursor` — DOCUMENTED HEURISTIC, not vendor behaviour.
 * `compute_prefill` takes this flag as a caller-supplied parameter and the
 * vendor reference never shows how its own host derives it (**не нашёл
 * источник**). This implementation: true when the most recent tracked diff
 * for THIS document lies entirely above the cursor line. Being wrong is
 * cosmetic-to-mild — the flag only selects which of `compute_prefill`'s two
 * branches computes the prefill, and both branches produce a legal prefill.
 *
 * C-4 — MIXED COORDINATE SPACES, deliberately. `diff.endLine` is an OLD,
 * PRE-CHANGE document coordinate (see `RecentDiff` in `./types.ts`) while
 * `cursorLine` is a CURRENT one, so this comparison is approximate by
 * construction and drifts further the more edits land after the diff was
 * recorded. That is tolerable ONLY because of the paragraph above: both
 * answers produce a legal prefill, so the imprecision is cosmetic. Do not
 * copy this comparison into any site where being wrong is not cosmetic —
 * re-base the diff first, or use a different signal.
 */
export function computeChangesAboveCursor(
  diffs: readonly RecentDiff[],
  uri: string,
  cursorLine: number,
): boolean {
  const mostRecent = diffs.find((diff) => diff.uri === uri);
  return mostRecent !== undefined && mostRecent.endLine < cursorLine;
}

/**
 * Assembles `ContentChangeLite[]` from a raw change event.
 *
 * ORDERING CONTRACT (`anchors.ts`): `remapRange` does NOT re-sort — whoever
 * assembles its input must resolve delivery order FIRST. VS Code gives no
 * ordering guarantee for a multi-part `contentChanges` array
 * (microsoft/vscode#11487), and every `change.range` is expressed in the
 * OLD/pre-change document, so this mirrors `editTrackerAdapter.ts`'s
 * established descending sort (highest start position first): applying a
 * HIGHER change first never shifts the line numbers a LOWER, not-yet-applied
 * change still refers to. The source array is readonly — copy before sorting.
 *
 * WS-F3 F3-4 (critic I-1) — the parameter is now the LOCAL structural
 * `ContentChangeLike[]` (declared above) rather than
 * `readonly vscode.TextDocumentContentChangeEvent[]`, which is what lets this
 * module go vscode-free; see the module header for why the real vscode event
 * type is still assignable here with zero call-site change.
 */
export function toContentChangeLites(changes: readonly ContentChangeLike[]): ContentChangeLite[] {
  return [...changes]
    .sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    })
    .map((change) => ({
      startLine: change.range.start.line,
      endLine: change.range.end.line,
      // Replacing the inclusive span [start, end] with text carrying N
      // newlines yields N+1 lines.
      newLineCount: (change.text.match(/\n/g) ?? []).length + 1,
    }));
}
