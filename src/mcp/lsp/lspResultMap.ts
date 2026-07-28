/**
 * W3 (LIB) · T7a — the pure, headless `vscode.* → plain` result mapper
 * (research doc §5.1/§5.2, brief `w3-t7a-brief.md`). This is the **I-1 carry
 * from the T6b review**: the uri-extraction / `Location`|`LocationLink`
 * coalescing / `SymbolInformation`|`DocumentSymbol` discrimination that
 * `classifyUri`/`readSnippet` (T7b's confinement layer) then CONFINE now
 * lives here, in a pure, unit-tested module, so a uri-mis-extraction can
 * never silently ship to Fedora.
 *
 * ## Why pure + headless (and why the T4 lock scans it)
 * Every input below is a **duck-typed structural interface** — a real
 * `vscode.Location`/`vscode.Uri`/`vscode.Diagnostic`/etc. satisfies each one
 * at runtime with zero adaptation, so this file needs NO `vscode` import and
 * is unit-testable with plain object fixtures. It lives in `src/mcp/lsp/`,
 * which `lspInvariant.test.ts` (T4) scans for a `vscode`/`fs` import on every
 * non-test, non-`lspGateway.ts`/non-`*.vscode.ts` file — an import here goes
 * RED. T7b's `.vscode.ts` adapter (exempt from the ban) is the ONLY place
 * that constructs real `vscode.Uri`/`vscode.Position` values and passes them
 * in; this module only ever consumes the structural shape.
 *
 * ## Totality (hard constraint)
 * Every mapper below is TOTAL: it never throws on partial/empty/malformed
 * input. Coordinates are clamped to a non-negative integer (NaN/Infinity/
 * negative ⇒ 0) rather than propagating a bad value or throwing; missing
 * optionals (`targetSelectionRange`, `location.range`, `detail`,
 * `containerName`, diagnostic `source`/`code`) default to `undefined` rather
 * than being assumed present.
 *
 * ## The two confinement-critical discriminants (preserved exactly)
 * 1. **`Location` vs `LocationLink`** ({@link mapDefinitionTargets}) —
 *    discriminated by `'targetUri' in t` (only `LocationLink` has it). The
 *    uri this module extracts for a `LocationLink` is ALWAYS the
 *    **target**'s `.toString()`, never a source/origin uri — T6b's
 *    `coalesceTarget` (imported from `resultShaper.ts`, re-exercised in this
 *    module's tests) then reads that same `targetUri` field to compute the
 *    result's {@link import('./resultShaper').ConfinementVerdict}, so an
 *    error here would silently confine the WRONG file.
 * 2. **`DocumentSymbol` vs `SymbolInformation`** ({@link mapDocumentSymbols})
 *    — discriminated by `'children' in entry` (only `DocumentSymbol` has
 *    it; mirrors the same discriminant `tools.ts`'s
 *    `normalizeDocumentSymbol` already uses on the OUTPUT-side union).
 *    `DocumentSymbol` recurses into `children`; `SymbolInformation` extracts
 *    `location.uri` — which MAY be missing `range` (the workspace-symbols
 *    nuance, research doc §5.1: `provideWorkspaceSymbols` legitimately
 *    returns partial locations) — never assumed present.
 *
 * ## Output types
 * Every mapper's return type EXACTLY satisfies the `LspToolGateway` seam
 * (`tools.ts`, T6b) so T7b's adapter type-checks its `LspToolGateway`
 * implementation against these functions with zero extra glue: the plain
 * mirror types (`PlainPosition`/`PlainRange`/`PlainLocation`/
 * `PlainLocationLink`/`PlainSymbolInformation`/`PlainDocumentSymbol`) come
 * from `resultShaper.ts` (T5); `RawDiagnostic`/`RawDiagnosticsGroup`/
 * `RawDocumentSymbolEntry` come from the pure-leaf `lspToolContract.ts`
 * (P7-N12 · I-7 — originally declared in `tools.ts` (T6b), moved out to
 * reverse this exact backward edge) — both imported with `import type` only
 * (erased at build time; this file never depends on `tools.ts` at runtime).
 */

import type {
  PlainPosition,
  PlainRange,
  PlainLocation,
  PlainLocationLink,
  PlainSymbolInformation,
  PlainDocumentSymbol,
} from './resultShaper';
import type { RawDiagnostic, RawDiagnosticsGroup, RawDocumentSymbolEntry } from './lspToolContract';

// ---------------------------------------------------------------------------
// Duck-typed input interfaces — a real vscode.* object satisfies each
// structurally; this file never imports `vscode`.
// ---------------------------------------------------------------------------

/** Mirrors `vscode.Uri`: we take only the canonical `.toString()` — the
 * adapter (T7b) re-parses it for confinement, this module never guesses or
 * rebuilds a uri from parts. */
export interface UriLike {
  toString(): string;
}

/** Mirrors `vscode.Position` (0-based). */
export interface PositionLike {
  readonly line: number;
  readonly character: number;
}

/** Mirrors `vscode.Range`. */
export interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

/** Mirrors `vscode.Location`. */
export interface LocationLike {
  readonly uri: UriLike;
  readonly range: RangeLike;
}

/** Mirrors `vscode.LocationLink`. Discriminated from {@link LocationLike} by
 * the presence of `targetUri` (see {@link mapDefinitionTargets}). */
export interface LocationLinkLike {
  readonly targetUri: UriLike;
  readonly targetRange: RangeLike;
  readonly targetSelectionRange?: RangeLike;
}

/** Mirrors `vscode.SymbolInformation`. `location.range` MAY be absent — the
 * workspace-symbols nuance (research doc §5.1). */
export interface SymbolInformationLike {
  readonly name: string;
  readonly kind: number;
  readonly containerName?: string;
  readonly location: { readonly uri: UriLike; readonly range?: RangeLike };
}

/** Mirrors `vscode.DocumentSymbol`. Discriminated from
 * {@link SymbolInformationLike} by the presence of `children` (always an
 * array, possibly empty — see {@link mapDocumentSymbols}). */
export interface DocumentSymbolLike {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: RangeLike;
  readonly selectionRange: RangeLike;
  readonly children: readonly DocumentSymbolLike[];
}

/** Mirrors `vscode.Diagnostic`. `code` mirrors VS Code's own union: a bare
 * primitive or an object carrying `{value, target?}` (only `.value` is
 * consumed here — see {@link mapDiagnostic}). */
export interface DiagnosticLike {
  readonly range: RangeLike;
  readonly message: string;
  readonly severity: number;
  readonly source?: string;
  readonly code?: string | number | { readonly value: string | number };
}

/** Mirrors `vscode.Hover`. `contents` is `vscode.Hover`'s own
 * `MarkedString | MarkupContent` union, already narrowed to the three shapes
 * this module flattens (see {@link mapHover}). */
export interface HoverLike {
  readonly contents: ReadonlyArray<
    string | { readonly value: string } | { readonly language?: string; readonly value: string }
  >;
}

// ---------------------------------------------------------------------------
// Position/Range — total coordinate clamping
// ---------------------------------------------------------------------------

/** Clamps a coordinate to a non-negative integer; NaN/Infinity/negative
 * default to 0 rather than propagating or throwing (totality). */
function clampCoordinate(n: number): number {
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

export function toPlainPosition(p: PositionLike): PlainPosition {
  return { line: clampCoordinate(p.line), character: clampCoordinate(p.character) };
}

export function toPlainRange(r: RangeLike): PlainRange {
  return { start: toPlainPosition(r.start), end: toPlainPosition(r.end) };
}

// ---------------------------------------------------------------------------
// mapDefinitionTargets — lsp_definition (Location | LocationLink discriminant)
// ---------------------------------------------------------------------------

/**
 * `lsp_definition` may return `Location[]` or `LocationLink[]` (research doc
 * §5.1's table). Discriminated by `'targetUri' in t` — only `LocationLink`
 * has it. This is the coalescing-critical extraction (I-1(b)): the uri
 * preserved for a `LocationLink` is ALWAYS `targetUri.toString()`, never a
 * source/origin uri, because `coalesceTarget` (`resultShaper.ts`) reads this
 * exact field downstream to compute confinement.
 */
export function mapDefinitionTargets(
  raw: readonly (LocationLike | LocationLinkLike)[],
): (PlainLocation | PlainLocationLink)[] {
  return raw.map(mapDefinitionTarget);
}

function mapDefinitionTarget(t: LocationLike | LocationLinkLike): PlainLocation | PlainLocationLink {
  if ('targetUri' in t) {
    return {
      targetUri: t.targetUri.toString(),
      targetRange: toPlainRange(t.targetRange),
      targetSelectionRange:
        t.targetSelectionRange !== undefined ? toPlainRange(t.targetSelectionRange) : undefined,
    };
  }
  return { uri: t.uri.toString(), range: toPlainRange(t.range) };
}

// ---------------------------------------------------------------------------
// mapReferences — lsp_references
// ---------------------------------------------------------------------------

export function mapReferences(raw: readonly LocationLike[]): PlainLocation[] {
  return raw.map((loc) => ({ uri: loc.uri.toString(), range: toPlainRange(loc.range) }));
}

// ---------------------------------------------------------------------------
// mapDocumentSymbols — lsp_document_symbols (DocumentSymbol | SymbolInformation)
// ---------------------------------------------------------------------------

/** Extracts a {@link SymbolInformationLike} to its plain mirror. `.location.uri`
 * is the confinement-critical extraction (I-1(c)) — always via `.toString()`
 * on the location's own uri, never guessed. `.location.range` is copied only
 * when present — a provider may legitimately return a partial location
 * (research doc §5.1), and this function never assumes it exists. Shared by
 * {@link mapDocumentSymbols}' flat branch and {@link mapWorkspaceSymbols}. */
function mapSymbolInformation(sym: SymbolInformationLike): PlainSymbolInformation {
  return {
    name: sym.name,
    kind: sym.kind,
    containerName: sym.containerName,
    location: {
      uri: sym.location.uri.toString(),
      range: sym.location.range !== undefined ? toPlainRange(sym.location.range) : undefined,
    },
  };
}

/**
 * I-1 (T7a review): caps how deep {@link mapDocumentSymbol} will recurse.
 * Mirrors `resultShaper.ts`'s `MAX_SYMBOL_TREE_DEPTH` (the render-side
 * guard on the sibling `renderDocumentSymbolInto` function) — a
 * pathologically deep (or cyclic) `DocumentSymbol` tree would otherwise blow
 * the call stack (`RangeError: Maximum call stack size exceeded`), violating
 * this module's totality contract (file header: "never throws on partial/
 * empty/malformed input"). 64 is far deeper than any real source file's
 * nesting and matches the shaper's own cap, so it is behavior-preserving on
 * all legitimate output.
 */
const MAX_SYMBOL_TREE_DEPTH = 64;

/** Recurses a {@link DocumentSymbolLike} tree into its plain mirror,
 * preserving nesting exactly (I-1(d)), up to {@link MAX_SYMBOL_TREE_DEPTH} —
 * at the cap, stop descending and return `children: []` instead of
 * recursing further (totality; also turns a reference-cycle in `children`
 * into truncation rather than an infinite loop). */
function mapDocumentSymbol(sym: DocumentSymbolLike, depth = 0): PlainDocumentSymbol {
  return {
    name: sym.name,
    detail: sym.detail,
    kind: sym.kind,
    range: toPlainRange(sym.range),
    selectionRange: toPlainRange(sym.selectionRange),
    children:
      depth >= MAX_SYMBOL_TREE_DEPTH ? [] : sym.children.map((child) => mapDocumentSymbol(child, depth + 1)),
  };
}

/**
 * `lsp_document_symbols`' raw provider result is `(SymbolInformation |
 * DocumentSymbol)[]` (research doc §5.1) — discriminated by `'children' in
 * entry` (only `DocumentSymbol` always carries it, mirroring the same
 * discriminant `tools.ts`'s `normalizeDocumentSymbol` uses on the
 * output-side union). `DocumentSymbol` ⇒ recurse `children`;
 * `SymbolInformation` ⇒ `{name, kind, containerName?, location:{uri, range?}}`.
 * A mixed array is discriminated item-by-item, in order.
 */
export function mapDocumentSymbols(
  raw: readonly (SymbolInformationLike | DocumentSymbolLike)[],
): RawDocumentSymbolEntry[] {
  return raw.map(mapDocumentSymbolEntry);
}

function mapDocumentSymbolEntry(
  entry: SymbolInformationLike | DocumentSymbolLike,
): RawDocumentSymbolEntry {
  if ('children' in entry) {
    return mapDocumentSymbol(entry);
  }
  return mapSymbolInformation(entry);
}

// ---------------------------------------------------------------------------
// mapWorkspaceSymbols — lsp_workspace_symbols (missing-range-safe)
// ---------------------------------------------------------------------------

/** `lsp_workspace_symbols` always returns the flat `SymbolInformation[]`
 * shape (never `DocumentSymbol`) — reuses {@link mapSymbolInformation}
 * directly, so the missing-range handling is identical to the
 * `mapDocumentSymbols` flat branch (one implementation, not duplicated). */
export function mapWorkspaceSymbols(raw: readonly SymbolInformationLike[]): PlainSymbolInformation[] {
  return raw.map(mapSymbolInformation);
}

// ---------------------------------------------------------------------------
// mapHover — lsp_hover (contents flatten)
// ---------------------------------------------------------------------------

/** Flattens one `Hover.contents` entry to its text, or `undefined` if it
 * carries no usable text. A bare string ⇒ itself; `{value}` (MarkupContent)
 * and `{language,value}` (MarkedString) ⇒ `.value`. Defensive `typeof`
 * guard on `.value` (not just the structural type) — totality never trusts
 * that adversarial/malformed runtime input actually matches the duck type it
 * was declared against. */
function flattenHoverContentItem(item: HoverLike['contents'][number]): string | undefined {
  if (typeof item === 'string') {
    return item;
  }
  return typeof item.value === 'string' ? item.value : undefined;
}

/**
 * Flattens every `HoverLike.contents` entry across every `HoverLike` in
 * `raw` into a single flat list of non-empty strings (I-1(f)) — one entry
 * per non-empty content item, in encounter order, across all hovers. Empty
 * strings are dropped. The shaper (`shapeHover`, `resultShaper.ts`)
 * sanitizes/caps each entry and joins them downstream; this function only
 * flattens the union shape to plain text.
 */
export function mapHover(raw: readonly HoverLike[]): string[] {
  const out: string[] = [];
  for (const hover of raw) {
    for (const item of hover.contents) {
      const text = flattenHoverContentItem(item);
      if (text !== undefined && text.length > 0) {
        out.push(text);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// mapDiagnosticsForUri / mapDiagnosticsDump — lsp_diagnostics
// ---------------------------------------------------------------------------

/** Normalizes `Diagnostic.code` to `string | undefined`: absent ⇒
 * `undefined`; a bare number/string ⇒ `String(code)`/itself; the
 * `{value, target?}` object form ⇒ `String(value)`. Never throws. */
function normalizeDiagnosticCode(code: DiagnosticLike['code']): string | undefined {
  if (code === undefined) {
    return undefined;
  }
  if (typeof code === 'string') {
    return code;
  }
  if (typeof code === 'number') {
    return String(code);
  }
  return String(code.value);
}

/** Maps one `DiagnosticLike` to its plain mirror. `severity` is kept as the
 * RAW vscode ordinal (0 Error…3 Hint) — the label mapping lives in
 * `tools.ts`, not here (I-1(e)). */
function mapDiagnostic(d: DiagnosticLike): RawDiagnostic {
  return {
    range: toPlainRange(d.range),
    message: d.message,
    severity: d.severity,
    source: d.source,
    code: normalizeDiagnosticCode(d.code),
  };
}

/** The single-path `lsp_diagnostics` call: one group for the given
 * `uri` (already a plain string — the tool's confined path argument), its
 * diagnostics mapped in order. */
export function mapDiagnosticsForUri(
  diags: readonly DiagnosticLike[],
  uri: string,
): RawDiagnosticsGroup {
  return { uri, diagnostics: diags.map(mapDiagnostic) };
}

/**
 * The workspace-dump `lsp_diagnostics` call: `vscode.languages.getDiagnostics()`
 * (no-arg) returns one `[Uri, Diagnostic[]]` pair per resource VS Code
 * currently knows about — this maps each pair to its own group, uri via
 * `.toString()` on THAT pair's own uri (I-1(e)). Per research doc R2.4, the
 * dump includes out-of-workspace resources (e.g. open tabs outside the
 * workspace root) — this function does NOT filter; that filtering is T6b's
 * `classifyUri`-driven realpath confinement, entirely outside this module.
 */
export function mapDiagnosticsDump(
  raw: readonly (readonly [UriLike, readonly DiagnosticLike[]])[],
): RawDiagnosticsGroup[] {
  return raw.map(([uri, diags]) => ({ uri: uri.toString(), diagnostics: diags.map(mapDiagnostic) }));
}
