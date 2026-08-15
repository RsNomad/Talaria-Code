/**
 * P7-N12 · I-7 — the LIB tool contract, extracted from `tools.ts` into its
 * own pure leaf (arch review `final-3way-2-arch.md` I-7: "`tools.ts` types-
 * hub role deepened — extract the contract before the 8th tool"). Every
 * declaration here is TYPE-ONLY (`interface`/`type`) — this file has no
 * runtime exports and no side effects; it is a pure leaf in the same sense
 * `resultShaper.ts`'s plain mirror types are (headless — no `vscode`, no
 * `fs`, scanned by `lspInvariant.test.ts` like every other file in this
 * directory).
 *
 * Behavior-preserving move: every type below is copied verbatim from
 * `tools.ts` (T6b), with its original doc comment intact. `tools.ts` itself,
 * plus the three consumers that previously imported these types BACK from
 * the handler module (`lspResultMap.ts`, `host/lib/libToolDeps.vscode.ts`,
 * `host/lib/libToolDepsPure.ts` — the exact backwards edges I-7 names), now
 * import from this leaf instead — reversing all three. `tools.ts` keeps
 * every runtime declaration (constants, handlers, `createSharedLspToolState`,
 * `buildLibMcpServer`) unchanged; only the type/contract surface moved.
 */
import type { IndexingTracker, createConcurrencyPool, LruCache } from './toolPipeline';
import type {
  ConfinementVerdict,
  PlainDocumentSymbol,
  PlainLocation,
  PlainLocationLink,
  PlainPosition,
  PlainRange,
  PlainSymbolInformation,
} from './resultShaper';
import type { PlainTextEdit } from './codeActionSerialize';

// ---------------------------------------------------------------------------
// The injected seam
// ---------------------------------------------------------------------------

/** Result of resolving+confining a workspace-relative path argument, plus
 * the warm-up facts (`languageId`/`version`) the retry/cache policies need.
 * `version` is the live `TextDocument.version` at resolution time. */
export interface ResolvedPathArg {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
}

/** One raw diagnostic row, exactly as the adapter reads it off
 * `vscode.Diagnostic` (severity kept as the vscode ordinal: 0 Error, 1
 * Warning, 2 Information, 3 Hint — mapped to a label in `tools.ts`, not the
 * adapter, so the mapping is unit-testable headlessly). */
export interface RawDiagnostic {
  readonly range: PlainRange;
  readonly message: string;
  readonly severity: number;
  readonly source?: string;
  readonly code?: string;
}

/** One uri's diagnostics, as `vscode.languages.getDiagnostics()` groups
 * them. Used for BOTH the single-path call (adapter returns a single group,
 * or none) and the workspace dump (adapter returns one group per resource
 * VS Code currently knows about, in or out of the workspace — R2.4). */
export interface RawDiagnosticsGroup {
  readonly uri: string;
  readonly diagnostics: readonly RawDiagnostic[];
}

/** `lsp_document_symbols`' raw gateway result: VS Code's own return type is
 * `(SymbolInformation | DocumentSymbol)[]` (research doc §5.1) — this union
 * reuses the T5 plain mirrors directly (`PlainDocumentSymbol` already has
 * every field the "already hierarchical" branch needs; `PlainSymbolInformation`
 * is the flat, legacy-provider fallback shape). */
export type RawDocumentSymbolEntry = PlainDocumentSymbol | PlainSymbolInformation;

/**
 * L4 fix — the doc-symbols LRU's stored value: the RESOLVED VERSION the
 * entries were fetched at, alongside the entries themselves. Keyed by `uri`
 * ALONE (one slot per uri, not the old `${uri}@${version}` composite key —
 * `tools.ts`'s `handleDocumentSymbols`) so a version RESET (e.g. the
 * document is closed then reopened — `TextDocument.version` legitimately
 * restarts, per `@types/vscode`'s own doc comment: "A closed document isn't
 * synchronized anymore and won't be re-used when the same resource is
 * opened again") can never leave a STALE entry from a prior generation
 * lingering under a still-resident old composite key: any version mismatch
 * (higher OR lower than what is currently cached) is a plain miss, which
 * OVERWRITES this single slot rather than accumulating a second one.
 */
export interface CachedDocumentSymbols {
  readonly version: number;
  readonly entries: readonly RawDocumentSymbolEntry[];
}

/**
 * W3 (LIB) · T8b — one file's raw text edits within a `RawCodeAction`'s
 * `WorkspaceEdit`, exactly as the adapter's `_allEntries` feature-detect
 * extracted them (grouped by uri, adapter's job — see
 * `libToolDeps.vscode.ts`). This is T8a's `TextEditFile` MINUS the
 * `verdict`/`docText` fields — those require confinement (`classifyUri`) and
 * a doc read (`readFullText`), which the TESTABLE handler (`tools.ts`) adds
 * per file (the T6b I-1 lesson: keep confinement out of the build-blind
 * adapter).
 */
export interface RawCodeActionFile {
  readonly uri: string;
  readonly edits: readonly PlainTextEdit[];
}

/** The raw, unconfined edit descriptor of one `RawCodeAction` — T8a's
 * `ResolvedCodeAction['edit']` minus per-file `verdict`/`docText`. */
export interface RawCodeActionEdit {
  /** Did the adapter's `_allEntries` feature-detect find the method at all?
   * `false` ⇒ fail closed (T8a rule 1) — the adapter sets this `false`
   * whenever `_allEntries` is absent OR its result can't be trusted (see the
   * adapter's own doc comment for the consistency guard). */
  readonly allEntriesAvailable: boolean;
  readonly hasNonTextEntry: boolean;
  readonly nonTextKind?: 'file-operations' | 'snippet';
  readonly files: readonly RawCodeActionFile[];
}

/** One code action as the adapter (build-blind) extracted it from a real
 * `vscode.CodeAction`, before the handler's (`tools.ts`) confinement/docText
 * pass. */
export interface RawCodeAction {
  readonly title: string;
  readonly hasCommand: boolean;
  readonly edit?: RawCodeActionEdit;
}

/**
 * The plain-string/plain-position gateway seam `tools.ts` actually depends
 * on — see that file's header note on why this is NOT the literal T4
 * `LspGateway`. Structurally mirrors T4's 6 verb names/semantics exactly;
 * `getDiagnostics` stays synchronous (research doc §5.1: "none (sync)").
 * `getCodeActions` (T8b) is the 7th verb — RAW, unconfined (`tools.ts`'s
 * `handleCodeActions` adds confinement + docText per file before handing the
 * result to T8a's `classifyCodeAction`).
 */
export interface LspToolGateway {
  getDiagnostics(uri?: string): readonly RawDiagnosticsGroup[];
  getDefinition(
    uri: string,
    position: PlainPosition,
  ): Promise<readonly (PlainLocation | PlainLocationLink)[]>;
  getReferences(uri: string, position: PlainPosition): Promise<readonly PlainLocation[]>;
  getDocumentSymbols(uri: string): Promise<readonly RawDocumentSymbolEntry[]>;
  getWorkspaceSymbols(query: string): Promise<readonly PlainSymbolInformation[]>;
  /** Already flattened to plain strings by the adapter (`Hover.contents`,
   * `MarkedString | MarkupContent`, joined/stringified) — this file never
   * needs to know that union's shape. */
  getHover(uri: string, position: PlainPosition): Promise<readonly string[]>;
  /** `itemResolveCount` is `K` (clamped [1,16] by the handler) — resolves
   * `.edit` only (never runs `.command`; see `lspGateway.ts`'s own grounding
   * note). Raw, unconfined return — no shaping. */
  getCodeActions(
    uri: string,
    range: PlainRange,
    kind: string | undefined,
    itemResolveCount: number,
  ): Promise<readonly RawCodeAction[]>;
}

/** The bounded-concurrency task runner {@link createConcurrencyPool} returns
 * — pulled up here (ahead of {@link LspToolDeps}) so the shared-primitive
 * fields below can reference it; the concrete factory lives in
 * `./toolPipeline`. */
export type Pool = ReturnType<typeof createConcurrencyPool>;

export interface LspToolDeps {
  readonly gateway: LspToolGateway;
  /** Workspace-relative path → confined+opened doc (warm-up done), or
   * `null` ⇒ REFUSE (outside workspace / not found). Never called again for
   * an already-refused path within one handler invocation. */
  resolvePathArg(workspaceRelativePath: string): Promise<ResolvedPathArg | null>;
  /** Classify a RESULT uri as in/out-of-root. */
  classifyUri(uri: string): Promise<ConfinementVerdict>;
  /** In-root snippet (≤`maxLines`) for a target, or `undefined` if
   * unavailable. NEVER called for an out-of-root target. */
  readSnippet(uri: string, range: PlainRange, maxLines: number): Promise<string | undefined>;
  /** Full in-root document text, for `lsp_code_actions`' preview diff (T8b).
   * Called ONLY for a file `classifyUri` already confirmed in-root — NEVER
   * for an out-of-root uri (R2.1). `undefined` on any read failure — never
   * throws. */
  readFullText(uri: string): Promise<string | undefined>;
  /** Sleep for the maybe-indexing retry (injected so tests don't wait). */
  sleep(ms: number): Promise<void>;
  /** Optional structured logger for the fail-closed/degraded signals. */
  log?: (msg: string) => void;
  /**
   * The three S-1-hoisted shared runtime primitives (see `tools.ts`'s
   * file-header note and {@link SharedLspToolState}/`createSharedLspToolState`).
   * MUST be the SAME instances across every `LspToolDeps` built for this LIB
   * server's extension-host lifetime — never freshly constructed per
   * request. `buildLibMcpServer` reads these directly rather than creating
   * its own; a caller that constructs a fresh set per call silently
   * reintroduces S-1 (vacuous pool bound, dead LRU, over-eager
   * maybe-indexing).
   */
  readonly pool: Pool;
  readonly tracker: IndexingTracker;
  readonly docSymbolsCache: LruCache<CachedDocumentSymbols>;
}

/**
 * S-1 fix — the shape `createSharedLspToolState()` (`tools.ts`) returns: the
 * concurrency pool, the first-empty indexing tracker, and the doc-symbols
 * LRU, constructed ONCE per extension-host LIB lifetime and threaded into
 * every {@link LspToolDeps}.
 */
export interface SharedLspToolState {
  readonly pool: Pool;
  readonly tracker: IndexingTracker;
  readonly docSymbolsCache: LruCache<CachedDocumentSymbols>;
}
