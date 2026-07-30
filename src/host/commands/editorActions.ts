/**
 * W2 T3 — F-A code actions (§3.3, Candidate A "context-menu-first"): the
 * PURE seed-building units behind the `editor/context` "Hermes" submenu
 * (Add/Explain/Improve with Hermes) and the `talaria.fixCode` QuickFix
 * command. The impure command handlers (`window.activeTextEditor` snapshot,
 * the secret-floor notification, command registration) live in
 * `editorActions.vscode.ts` — split the same way `context/format.ts` +
 * `context/diagnosticsMapper.ts` (pure) sit apart from `context/ports.vscode.ts`
 * (the one `vscode` importer), so `buildSeed`/`flattenDiagnosticsForFix` stay
 * headlessly testable with zero `vscode` import in THIS file.
 *
 * SECURITY / HARD CONSTRAINT (doc §3.3, non-negotiable): every editor action
 * is a prompt SEEDER — it snapshots the editor, builds a plain
 * `composer.seed` payload (`buildSeed`, below), and hands it to the view
 * provider. NONE of them ever construct or apply a `vscode.WorkspaceEdit`; a
 * resulting agent edit hits the unchanged `handleRequestPermission` ->
 * `evaluateEditPolicy` gate, same as any other agent-proposed edit. There is
 * no mutation path anywhere in this feature.
 */
import type { ContextRef, LineRange } from '../../shared/protocol';
import { mapDiagnosticEntries, type DiagnosticEntryLike } from '../context/diagnosticsMapper';
import { formatDiagnostics } from '../context/format';

/* ------------------------------------------------------------------ *
 * PURE units (headlessly tested — editorActions.test.ts)
 * ------------------------------------------------------------------ */

/** Which "Hermes" editor action produced this seed. */
export type EditorActionIntent = 'add' | 'explain' | 'improve' | 'fix';

/** Already-snapshotted editor data `buildSeed` turns into a seed payload. */
export interface BuildSeedInput {
  intent: EditorActionIntent;
  /** POSIX-ish path of the document (mirrors `EditorPort.activeSelection()`'s shape, §2a). */
  path: string;
  languageId: string;
  code: string;
  range: LineRange;
  /**
   * Diagnostics already flattened to a plain string (§3.3: "diagnostics
   * flattened to a plain string" — see {@link flattenDiagnosticsForFix}).
   * Only ever rendered for `intent: 'fix'`; ignored (never leaked into the
   * seed text) for the other three intents even when non-empty.
   */
  problems: string;
}

/** The `composer.seed` payload (`src/shared/protocol.ts:772`), built server-side. */
export interface ComposerSeedPayload {
  text: string;
  mentions: ContextRef[];
}

const INTENT_LINES: Record<EditorActionIntent, string> = {
  add: 'Add this code for context.',
  explain: 'Explain this code.',
  improve: 'Improve this code.',
  fix: 'Fix the problem(s) below in this code.',
};

/**
 * Build the `composer.seed` payload for one editor action — PURE, no I/O.
 * `text` is intent line + `path:startLine-endLine` + a fenced code block
 * (labelled with `languageId`, unlabeled when empty); for `intent: 'fix'`
 * with a non-empty `problems`, a trailing "Problems:" section is appended.
 * `mentions` always carries exactly one `file` ref for the snapshotted range
 * — the SAME `id` shape (`file:<path>`) `parseMentions` derives from the
 * `@file:<path>` token the webview renders it as (T2e/§2b), so the ref stays
 * consistent even though (per the T2e invariant) the webview only ever keeps
 * the rendered TEXT, never this array, as the source of truth.
 */
export function buildSeed(input: BuildSeedInput): ComposerSeedPayload {
  const { intent, path, languageId, code, range, problems } = input;

  const fence = '```' + languageId;
  const parts = [INTENT_LINES[intent], '', `${path}:${range.startLine}-${range.endLine}`, `${fence}\n${code}\n\`\`\``];
  if (intent === 'fix' && problems) {
    parts.push('', `Problems:\n${problems}`);
  }

  return {
    text: parts.join('\n'),
    mentions: [{ id: `file:${path}`, kind: 'file', path, range }],
  };
}

/**
 * Flatten a single document's diagnostics into the plain "Problems:" string
 * `buildSeed` embeds for `intent: 'fix'` (§3.3/§5.7). PURE: takes the
 * severity ORDINALS as injected params (same posture as
 * `mapDiagnosticEntries`/`ports.vscode.ts`) and a duck-typed
 * {@link FlatDiagnostic} shape — no `vscode.Diagnostic` import needed, so
 * this is headlessly testable even though its only real caller
 * (`fixCode` in `editorActions.vscode.ts`) feeds it a mapped
 * `vscode.Diagnostic[]` (which structurally satisfies the shape). Reuses the
 * already-tested
 * `mapDiagnosticEntries`/`formatDiagnostics` (Error+Warning only, grouped —
 * `diagnosticsMapper.test.ts`/`format.test.ts`) rather than re-implementing
 * the same filtering/formatting a second time.
 */
export interface FlatDiagnostic {
  /** Raw severity ordinal (`vscode.Diagnostic.severity`). */
  severity: number;
  /** 0-based (`vscode.Range.start.line`). */
  line: number;
  message: string;
  source?: string;
}

export function flattenDiagnosticsForFix(
  path: string,
  diagnostics: readonly FlatDiagnostic[],
  errorSeverity: number,
  warningSeverity: number,
): string {
  const entries: DiagnosticEntryLike[] = diagnostics.map((d) => ({ path, ...d }));
  const rows = mapDiagnosticEntries(entries, errorSeverity, warningSeverity);
  return formatDiagnostics(rows);
}

/**
 * Structural seam over `TalariaViewProvider` (same reach-for-the-capability
 * posture `TalariaViewProvider.ts` applies to `AgentBackend`'s optional
 * members, P7-N12 · I-8) — the impure handlers in `editorActions.vscode.ts`
 * depend on this ONE method, not the concrete provider class.
 */
export interface SeedTarget {
  seedComposer(seed: ComposerSeedPayload): void;
}
