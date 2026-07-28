/**
 * W3 (LIB) · T5 — `resultShaper`: the deterministic, headless rendering
 * layer that turns raw LSP provider results into the safe, framed, capped
 * text LIB returns to Hermes (research doc §5.1/§5.2/§5.3, brief
 * `w3-t5-brief.md`). This is a **structural-invariant task** (critic-pin C1)
 * enforcing two invariants:
 *
 * 1. **Never-read-unconfined.** This file imports NO `fs`/`node:fs`/`readFile`
 *    and never opens a file (the T4 invariant-lock static scan —
 *    `lspInvariant.test.ts` — covers `resultShaper*.ts` and goes RED on any
 *    fs import). For an out-of-root target it emits **no snippet, no file
 *    body, no relPath** — only an `external` marker + the sanitized uri +
 *    range. The in-root snippet TEXT is produced by T6 (`tools.ts`), which
 *    reads it via a confined `openTextDocument`; this module only renders
 *    that text — it never fetches anything itself.
 *
 * 2. **Confinement is pre-computed, never re-derived lexically.** T6's
 *    `resolveWithinWorkspaceReal` is async FS I/O (realpath) and lives
 *    entirely outside this file. Every shaper function that touches a result
 *    URI consumes a {@link ConfinementVerdict} T6 already computed — it does
 *    NOT run its own path/prefix check to decide in-root vs external. Doing
 *    so would reopen the symlink-escape (CWE-180) the realpath verdict
 *    exists to close. This is why the module is labeled **"deterministic
 *    over injected seams"**, not "pure/no-fs" — the honest distinction the
 *    architecture doc draws (§5.2): a lexical-only shaper would be able to
 *    fool itself with a uri that merely *looks* like it is under the
 *    workspace root.
 *
 * A third, cross-cutting rule (invariant 3) governs every LS-produced
 * string (symbol names, hover markdown, uris, diagnostic messages/source/
 * code): {@link sanitizeLsString} collapses CR/LF to single spaces, strips
 * remaining control characters, neutralizes the frame delimiter tokens
 * (`<lsp_result>` / `</lsp_result>`) so an injected closing tag can never
 * terminate the frame, then caps the field. The whole payload is wrapped by
 * {@link frameLspResult} as delimited untrusted data (see `frameSanitize.ts`'s
 * module doc for why this is NOT "mirroring Hermes's own `reporter.py`" — an
 * earlier version of this sentence claimed that, and it was false; Hermes has
 * no parser for our tag at all).
 *
 * ## Per-request nonce (Audit E-1)
 * Per-field neutralization plus a LATER join was a hole: a field ending `<`
 * and the next field starting `/lsp_result>` produced a live delimiter that
 * no per-field pass could ever see, because it did not exist until the join
 * (`shapeHover`'s `sanitized.join('\n\n')` is the exact reproduction). Every
 * exported `shape*` function below mints a fresh {@link mintFrameNonce} at
 * entry and threads it to every {@link frameLspResult} call it makes
 * (including its empty-input early return), and `frameLspResult` itself runs
 * {@link neutralizeFrameDelimiters} ONE MORE TIME over the already-assembled
 * body — closing the join-created gap per-field sanitization cannot see.
 *
 * ## The T5 ↔ T6 seam
 * {@link coalesceTarget} is the ONE place `Location`/`LocationLink`
 * normalization happens; it is exported so T6 can extract a result's `uri`
 * from either shape BEFORE computing that result's {@link ConfinementVerdict}
 * (the verdict computation needs the uri; extraction must not be duplicated
 * between T5 and T6). Once T6 has a verdict, it pairs it with the (already
 * coalesced) `range` and passes `{verdict, range}` into {@link shapeLocations}
 * — that function does NOT call `coalesceTarget` itself; it only ever
 * consumes the post-coalescing, post-confinement shape.
 *
 * Every position/range on the wire is 1-based (LSP/vscode `Position` is
 * 0-based internally); every `format*1Based` helper below does that
 * conversion, clamping non-finite/negative input to 0 rather than throwing
 * (totality — no shaper function in this file ever throws on malformed
 * input; it clamps or falls back instead).
 *
 * ## Frame-integrity sanitizer (invariant 3) — now shared, see `frameSanitize.ts`
 * The control-char strip / `</lsp_result>`-neutralization / total-cap
 * mechanics {@link sanitizeLsString} builds on used to be a private copy of
 * this file, duplicated (with a `_Local` suffix) in `codeActionSerialize.ts`
 * and kept in sync by a comment only — a review-freeze constraint ossified
 * that duplication into structure (3-way arch review finding I-8: a future
 * edit to one copy that missed the other would silently weaken the
 * anti-injection defense in half the LIB tools). Those pieces now live in
 * the pure, headless `frameSanitize.ts` and are imported by both this file
 * and `codeActionSerialize.ts`, so there is exactly one place the frame
 * delimiter tokens are ever neutralized.
 *
 * ## SymbolKind grounding
 * `SYMBOL_KIND_LABEL`'s ordinal→name mapping is grounded against
 * `vscode.SymbolKind` (the `/microsoft/vscode` `vscode.d.ts` enum;
 * Context7 confirmed indexing of `vscode/src/vscode-dts/vscode.d.ts` in that
 * repo, but repeated `query-docs` calls for the literal `SymbolKind` enum
 * body returned unrelated chunks (wiki guideline pages, the `l10n.t()` API)
 * rather than the enum text itself). The exact ordinal→name pairs below were
 * cross-verified against the installed `@types/vscode` package —
 * `node_modules/@types/vscode/index.d.ts:3411-3516` — which is npm's mirror
 * of that same upstream `vscode.d.ts` file (`SymbolKind.File = 0` through
 * `SymbolKind.TypeParameter = 25`, 26 members total). An unknown/out-of-range
 * ordinal falls back to `'symbol'` — see {@link symbolKindLabel} — never
 * throws.
 */

import {
  CONTROL_CHAR_PATTERN,
  neutralizeFrameDelimiters,
  capWithMarker,
  capTotalBody,
  clampNonNegativeInt,
  mintFrameNonce,
} from './frameSanitize';

// ---------------------------------------------------------------------------
// Seam types (plain mirrors of vscode.* — this file never imports `vscode`)
// ---------------------------------------------------------------------------

/** 0-based, mirrors `vscode.Position`. */
export interface PlainPosition {
  readonly line: number;
  readonly character: number;
}

/** Mirrors `vscode.Range`. */
export interface PlainRange {
  readonly start: PlainPosition;
  readonly end: PlainPosition;
}

/** Mirrors `vscode.Location`. */
export interface PlainLocation {
  readonly uri: string;
  readonly range: PlainRange;
}

/** Mirrors `vscode.LocationLink`. */
export interface PlainLocationLink {
  readonly targetUri: string;
  readonly targetRange: PlainRange;
  readonly targetSelectionRange?: PlainRange;
}

/** Mirrors `vscode.SymbolInformation`. `location.range` MAY be absent — the
 * workspace-symbols nuance (research doc §5.1): `provideWorkspaceSymbols`
 * legitimately returns partial locations (providers defer full resolution to
 * `resolveWorkspaceSymbol`, which LIB never calls). */
export interface PlainSymbolInformation {
  readonly name: string;
  readonly kind: number;
  readonly containerName?: string;
  readonly location: { readonly uri: string; readonly range?: PlainRange };
}

/** Mirrors `vscode.DocumentSymbol`. Single-file, always fully resolved (has
 * a `range`/`selectionRange`), always in-root by construction (T6
 * guarantees this — `lsp_document_symbols` takes a confined path arg). */
export interface PlainDocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: PlainRange;
  readonly selectionRange: PlainRange;
  readonly children: readonly PlainDocumentSymbol[];
}

/**
 * Pre-computed by T6's `resolveWithinWorkspaceReal` (async realpath FS I/O,
 * entirely outside this file). This is the shaper's ONLY authoritative
 * in/out-of-root signal for a result URI — every shaper function below
 * consumes it as-is and never re-derives it lexically.
 */
export type ConfinementVerdict =
  | { readonly inRoot: true; readonly relPath: string; readonly snippet?: string }
  | { readonly inRoot: false; readonly externalUri: string };

// ---------------------------------------------------------------------------
// coalesceTarget — the ONE place Location/LocationLink normalization lives
// ---------------------------------------------------------------------------

/**
 * `lsp_definition` may return `Location[]` or `LocationLink[]` (research doc
 * §5.1's table). This is the single normalization point for both shapes,
 * exported so T6 can extract a target's `uri` before computing its
 * {@link ConfinementVerdict} — no duplicated extraction logic between T5 and
 * T6. Discriminated by the presence of `targetUri` (only `LocationLink` has
 * it). Total: both branches are direct field reads, never throws.
 */
export function coalesceTarget(t: PlainLocation | PlainLocationLink): {
  uri: string;
  range: PlainRange;
} {
  if ('targetUri' in t) {
    return { uri: t.targetUri, range: t.targetRange };
  }
  return { uri: t.uri, range: t.range };
}

// ---------------------------------------------------------------------------
// Sanitizer — invariant 3 (control-char/frame-tag/cap mechanics live in the
// shared, pure `frameSanitize.ts` — see the module doc above, I-8)
// ---------------------------------------------------------------------------

/** CR/LF (any form) collapse to a single space — prevents an injected
 * newline from placing attacker text on its own "line" inside the frame. */
const CR_LF_PATTERN = /\r\n|\r|\n/g;

/** Per-field truncation marker (sanitizeLsString). ASCII-only by design —
 * avoids any encoding ambiguity across platforms/terminals. */
const PER_FIELD_TRUNCATION_MARKER = '...[truncated]';

/**
 * The shared sanitizer (invariant 3): collapse CR/LF → strip other control
 * chars → neutralize the frame delimiter tokens → per-field cap. Order is
 * deliberate: neutralization runs on already-control-char-clean text, and
 * capping runs LAST so the returned string's length is always bounded by
 * `cap` regardless of how much the neutralization step grew the string
 * (`<` → `&lt;` is a 1-to-4 char expansion). Deterministic and total — never
 * throws for any string (including `''`) or any `cap` value. The
 * control-char strip and frame-tag neutralization steps are
 * {@link CONTROL_CHAR_PATTERN}/{@link neutralizeFrameDelimiters} — the
 * shared, canonical implementation imported from `frameSanitize.ts` (I-8).
 */
export function sanitizeLsString(s: string, cap: number): string {
  const collapsed = s.replace(CR_LF_PATTERN, ' ');
  const stripped = collapsed.replace(CONTROL_CHAR_PATTERN, '');
  const neutralized = neutralizeFrameDelimiters(stripped);
  return capWithMarker(neutralized, cap, PER_FIELD_TRUNCATION_MARKER);
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Wraps an already-sanitized body as delimited untrusted data.
 *
 * Audit E-1: the frame carries a PER-REQUEST nonce, and the body gets ONE MORE
 * neutralization pass here — after assembly. Per-field neutralization plus a
 * later join was the hole: a field ending in `<` and the next field starting
 * with `/lsp_result>` produced a live delimiter that no per-field pass could
 * ever see, because it did not exist until the join.
 *
 * NOTE we do NOT copy Hermes's `reporter.py` approach of html-escaping every
 * `<`/`>`/`&` in every field. The old comment in `frameSanitize.ts` claimed we
 * were "mirroring" it; we never did (fabrication G-3), and escaping everything
 * would mangle `Vec<T>`, `a < b` and JSX in exactly the hover and diagnostic
 * text this tool exists to show the model.
 */
export function frameLspResult(body: string, nonce: string): string {
  const safeBody = neutralizeFrameDelimiters(body);
  return `<lsp_result id="${nonce}">\n${safeBody}\n</lsp_result id="${nonce}">`;
}

// ---------------------------------------------------------------------------
// Caps (injected seam — never a magic number baked into shaping logic)
// ---------------------------------------------------------------------------

export interface ShaperCaps {
  readonly perField: number;
  readonly total: number;
}

/** perField 300 mirrors Hermes's `reporter.py` per-field cap; total 8000 is
 * the injected middle default of the doc's stated 4000-20000 "tuned on box"
 * range (research doc §5.1). Both are overridable — T6 injects its own
 * tuned `ShaperCaps` at the call site; nothing below hard-codes these
 * numbers into shaping logic. */
export const DEFAULT_SHAPER_CAPS: ShaperCaps = Object.freeze({ perField: 300, total: 8000 });

/** `lsp_references`' ~200 item cap (research doc §5.2). Injected as the
 * DEFAULT for `shapeLocations`'s `opts.cap` — callers (T6) may override per
 * tool (`lsp_definition` wants "however many", `lsp_references` wants this
 * default). */
export const DEFAULT_LOCATIONS_CAP = 200;

/** `lsp_workspace_symbols`' ~100 item cap (research doc §5.2, "highest-
 * disclosure tool"). Injected as the DEFAULT for `shapeWorkspaceSymbols`'s
 * `opts.cap`. */
export const DEFAULT_WORKSPACE_SYMBOLS_CAP = 100;

/** Shared item-cap override shape for `shapeLocations`/`shapeWorkspaceSymbols`. */
export interface ItemCapOptions {
  readonly cap?: number;
}

/** Falls back to `fallback` for undefined/non-finite/non-positive `cap` —
 * total, never throws, so a caller-supplied malformed cap degrades to the
 * safe default rather than crashing the shaper. */
function normalizeCap(cap: number | undefined, fallback: number): number {
  if (cap === undefined) {
    return fallback;
  }
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : fallback;
}

/** Rendered when a shaper's input list is empty — still a clean, framed,
 * non-throwing result (totality). */
const EMPTY_BODY = '(none)';

// ---------------------------------------------------------------------------
// 1-based wire formatting
// ---------------------------------------------------------------------------

function formatLineChar1Based(line: number, character: number): string {
  return `${clampNonNegativeInt(line) + 1}:${clampNonNegativeInt(character) + 1}`;
}

function formatPosition1Based(p: PlainPosition): string {
  return formatLineChar1Based(p.line, p.character);
}

function formatRangeStart1Based(r: PlainRange): string {
  return formatPosition1Based(r.start);
}

// ---------------------------------------------------------------------------
// SymbolKind labels (Context7/`@types/vscode`-grounded — see file header)
// ---------------------------------------------------------------------------

export const SYMBOL_KIND_LABEL: Readonly<Record<number, string>> = Object.freeze({
  0: 'File',
  1: 'Module',
  2: 'Namespace',
  3: 'Package',
  4: 'Class',
  5: 'Method',
  6: 'Property',
  7: 'Field',
  8: 'Constructor',
  9: 'Enum',
  10: 'Interface',
  11: 'Function',
  12: 'Variable',
  13: 'Constant',
  14: 'String',
  15: 'Number',
  16: 'Boolean',
  17: 'Array',
  18: 'Object',
  19: 'Key',
  20: 'Null',
  21: 'EnumMember',
  22: 'Struct',
  23: 'Event',
  24: 'Operator',
  25: 'TypeParameter',
});

/** Runtime-safe lookup (never trusts the type-level `Record<number,string>`
 * to actually hold a value for an arbitrary numeric key — an out-of-range
 * ordinal returns `undefined` at runtime in plain JS regardless of what the
 * static type claims). Unknown ordinal ⇒ `'symbol'`. Never throws. */
function symbolKindLabel(kind: number): string {
  const label = SYMBOL_KIND_LABEL[kind];
  return typeof label === 'string' ? label : 'symbol';
}

// ---------------------------------------------------------------------------
// shapeDiagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverityLabel = 'error' | 'warning' | 'information' | 'hint';

export interface PlainDiagnosticEntry {
  // host-computed (T6), not LS text — but frame integrity depends on
  // whether a string CAN contain the delimiter, not its provenance: on
  // Linux a filename may legally contain `<`, `>`, spaces, or newlines, so
  // relPath is still sanitized (control/CR-LF strip + delimiter
  // neutralization) at its render site below.
  readonly relPath: string;
  readonly severity: DiagnosticSeverityLabel;
  readonly line: number; // 0-based
  readonly character: number; // 0-based
  readonly message: string; // LS-produced — sanitized
  readonly source?: string; // LS-produced — sanitized
  readonly code?: string; // LS-produced — sanitized
}

/**
 * `lsp_diagnostics` (research doc §5.2): the workspace dump is already
 * realpath-filtered to in-root entries by T6 BEFORE shaping — this function
 * does NOT filter, it renders exactly the entries it is given, in order.
 */
export function shapeDiagnostics(entries: readonly PlainDiagnosticEntry[], caps: ShaperCaps): string {
  const nonce = mintFrameNonce();
  if (entries.length === 0) {
    return frameLspResult(EMPTY_BODY, nonce);
  }
  const lines = entries.map((entry) => renderDiagnosticLine(entry, caps));
  return frameLspResult(capTotalBody(lines.join('\n'), caps), nonce);
}

function renderDiagnosticLine(entry: PlainDiagnosticEntry, caps: ShaperCaps): string {
  const relPath = sanitizeLsString(entry.relPath, caps.perField);
  const severity = sanitizeLsString(entry.severity, caps.perField);
  const position = formatLineChar1Based(entry.line, entry.character);
  const message = sanitizeLsString(entry.message, caps.perField);
  const sourceSuffix =
    entry.source !== undefined && entry.source !== ''
      ? ` (${sanitizeLsString(entry.source, caps.perField)})`
      : '';
  const codeSuffix =
    entry.code !== undefined && entry.code !== '' ? ` [${sanitizeLsString(entry.code, caps.perField)}]` : '';
  return `${relPath}:${position} [${severity}] ${message}${sourceSuffix}${codeSuffix}`;
}

// ---------------------------------------------------------------------------
// shapeLocations — lsp_definition / lsp_references
// ---------------------------------------------------------------------------

/** Already-coalesced (via {@link coalesceTarget}, upstream in T6) and
 * already-confined (via T6's realpath verdict) target. */
export interface LocationTarget {
  readonly verdict: ConfinementVerdict;
  readonly range: PlainRange;
}

/**
 * Renders `lsp_definition`/`lsp_references` results. In-root targets render
 * `relPath:line:char` plus the verdict's snippet (if T6 attached one),
 * sanitized/capped. Out-of-root targets render ONLY
 * `{external:true, uri:<sanitized>, range:<pos>}` — no snippet, no relPath,
 * no file body (invariant 1, R2.1). External entries are counted but never
 * expanded; the item list itself is capped at `opts.cap ??
 * DEFAULT_LOCATIONS_CAP`, and the dropped count is reported in a trailing
 * summary line.
 */
export function shapeLocations(
  targets: readonly LocationTarget[],
  caps: ShaperCaps,
  opts?: ItemCapOptions,
): string {
  const nonce = mintFrameNonce();
  const total = targets.length;
  if (total === 0) {
    return frameLspResult(EMPTY_BODY, nonce);
  }
  const capLimit = normalizeCap(opts?.cap, DEFAULT_LOCATIONS_CAP);
  const shown = targets.slice(0, capLimit);
  const externalCount = targets.filter((t) => t.verdict.inRoot === false).length;
  const droppedCount = Math.max(0, total - shown.length);
  const lines = shown.map((t) => renderLocationLine(t, caps));
  const summary = `(${shown.length} of ${total} shown; ${externalCount} external; ${droppedCount} more not shown)`;
  const assembled = [...lines, summary].join('\n');
  return frameLspResult(capTotalBody(assembled, caps), nonce);
}

function renderLocationLine(target: LocationTarget, caps: ShaperCaps): string {
  const position = formatRangeStart1Based(target.range);
  const { verdict } = target;
  if (verdict.inRoot) {
    const relPath = sanitizeLsString(verdict.relPath, caps.perField);
    const base = `${relPath}:${position}`;
    if (verdict.snippet === undefined) {
      return base;
    }
    const snippet = sanitizeLsString(verdict.snippet, caps.perField);
    return `${base}\n    ${snippet}`;
  }
  const uri = sanitizeLsString(verdict.externalUri, caps.perField);
  return `{external:true, uri:${uri}, range:${position}}`;
}

// ---------------------------------------------------------------------------
// shapeDocumentSymbols — lsp_document_symbols
// ---------------------------------------------------------------------------

/**
 * Single-file, in-root by construction (T6 guarantees this — the tool takes
 * a confined path arg and VS Code's `DocumentSymbol` provider always
 * resolves fully). Renders the nested tree, indented by depth, each line
 * `name [KindLabel] line:char` (+ ` — detail` when present).
 */
export function shapeDocumentSymbols(
  symbols: readonly PlainDocumentSymbol[],
  relPath: string,
  caps: ShaperCaps,
): string {
  const nonce = mintFrameNonce();
  if (symbols.length === 0) {
    return frameLspResult(EMPTY_BODY, nonce);
  }
  const sanitizedRelPath = sanitizeLsString(relPath, caps.perField);
  const lines: string[] = [`${sanitizedRelPath}:`];
  for (const symbol of symbols) {
    renderDocumentSymbolInto(symbol, 0, caps, lines);
  }
  return frameLspResult(capTotalBody(lines.join('\n'), caps), nonce);
}

/**
 * MINOR-3 (totality): caps how deep {@link renderDocumentSymbolInto} will
 * recurse. A pathologically deep `DocumentSymbol` tree (e.g. ~10k levels —
 * not something any real language server emits, but this module's totality
 * invariant is "no shaper function ever throws on malformed/adversarial
 * input") would otherwise blow the call stack (`RangeError: Maximum call
 * stack size exceeded`). 64 is far deeper than any real source file's
 * nesting (module > namespace > class > method > block...); past it we stop
 * descending and render a marker instead of recursing further.
 */
const MAX_SYMBOL_TREE_DEPTH = 64;

function renderDocumentSymbolInto(
  symbol: PlainDocumentSymbol,
  depth: number,
  caps: ShaperCaps,
  lines: string[],
): void {
  const indent = '  '.repeat(depth + 1);
  const name = sanitizeLsString(symbol.name, caps.perField);
  const label = symbolKindLabel(symbol.kind);
  const position = formatRangeStart1Based(symbol.range);
  const detailSuffix =
    symbol.detail !== undefined && symbol.detail !== ''
      ? ` — ${sanitizeLsString(symbol.detail, caps.perField)}`
      : '';
  lines.push(`${indent}${name} [${label}] ${position}${detailSuffix}`);
  if (depth >= MAX_SYMBOL_TREE_DEPTH) {
    if (symbol.children.length > 0) {
      lines.push(`${'  '.repeat(depth + 2)}…(depth capped)`);
    }
    return;
  }
  for (const child of symbol.children) {
    renderDocumentSymbolInto(child, depth + 1, caps, lines);
  }
}

// ---------------------------------------------------------------------------
// shapeWorkspaceSymbols — lsp_workspace_symbols (highest-disclosure tool)
// ---------------------------------------------------------------------------

export interface WorkspaceSymbolTarget {
  readonly sym: PlainSymbolInformation;
  readonly verdict: ConfinementVerdict;
}

/**
 * `lsp_workspace_symbols` is the highest-disclosure tool (research doc
 * §5.2): a broad name-search across the whole workspace could otherwise be
 * used to probe for arbitrary external paths. External entries therefore
 * render name+kind ONLY — no uri, no path, nothing beyond the (sanitized)
 * LS-produced name/kind/containerName. In-root entries render
 * name+kind+relPath, with a 1-based line ONLY when `sym.location.range` is
 * present (the workspace-symbols nuance — a provider may legitimately
 * return a partial location with no range; this must render cleanly, never
 * assume the range exists). Hard-capped at `opts.cap ??
 * DEFAULT_WORKSPACE_SYMBOLS_CAP`, dropped count reported in a trailing
 * summary line.
 */
export function shapeWorkspaceSymbols(
  symbols: readonly WorkspaceSymbolTarget[],
  caps: ShaperCaps,
  opts?: ItemCapOptions,
): string {
  const nonce = mintFrameNonce();
  const total = symbols.length;
  if (total === 0) {
    return frameLspResult(EMPTY_BODY, nonce);
  }
  const capLimit = normalizeCap(opts?.cap, DEFAULT_WORKSPACE_SYMBOLS_CAP);
  const shown = symbols.slice(0, capLimit);
  const droppedCount = Math.max(0, total - shown.length);
  const lines = shown.map((entry) => renderWorkspaceSymbolLine(entry, caps));
  const summary = `(${shown.length} of ${total} shown; ${droppedCount} more not shown)`;
  const assembled = [...lines, summary].join('\n');
  return frameLspResult(capTotalBody(assembled, caps), nonce);
}

function renderWorkspaceSymbolLine(entry: WorkspaceSymbolTarget, caps: ShaperCaps): string {
  const name = sanitizeLsString(entry.sym.name, caps.perField);
  const label = symbolKindLabel(entry.sym.kind);
  const containerSuffix =
    entry.sym.containerName !== undefined && entry.sym.containerName !== ''
      ? ` in ${sanitizeLsString(entry.sym.containerName, caps.perField)}`
      : '';

  if (entry.verdict.inRoot === false) {
    // Highest-disclosure tool: external ⇒ name+kind ONLY. No uri, no path —
    // not even the verdict's own `externalUri` — beyond this sanitized
    // LS-produced text.
    return `${name} [${label}]${containerSuffix} (external)`;
  }

  const relPath = sanitizeLsString(entry.verdict.relPath, caps.perField);
  const range = entry.sym.location.range;
  if (range === undefined) {
    // The workspace-symbols nuance: no range ⇒ render name+kind+path, no
    // line — never assume `location.range` exists.
    return `${name} [${label}]${containerSuffix} ${relPath}`;
  }
  return `${name} [${label}]${containerSuffix} ${relPath}:${formatRangeStart1Based(range)}`;
}

// ---------------------------------------------------------------------------
// shapeHover — lsp_hover
// ---------------------------------------------------------------------------

/**
 * Hover text is entirely LS-produced markdown; there is no file read here
 * at all. Each content string is sanitized/capped independently, then
 * joined with a blank line between entries (vscode.Hover.contents is
 * itself an array — MarkedString | MarkupContent, already normalized to
 * plain strings upstream in T6).
 */
export function shapeHover(contents: readonly string[], caps: ShaperCaps): string {
  const nonce = mintFrameNonce();
  if (contents.length === 0) {
    return frameLspResult(EMPTY_BODY, nonce);
  }
  const sanitized = contents.map((c) => sanitizeLsString(c, caps.perField));
  return frameLspResult(capTotalBody(sanitized.join('\n\n'), caps), nonce);
}
