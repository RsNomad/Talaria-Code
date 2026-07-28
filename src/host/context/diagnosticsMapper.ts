/**
 * Pure `vscode.Diagnostic` → `DiagnosticsPort.all()` row mapper (§2a T2d
 * brief: "Extract the pure `vscode.Diagnostic`→row mapper for a headless
 * test"). Zero `vscode` import — `ports.vscode.ts` flattens
 * `vscode.languages.getDiagnostics(): [Uri, Diagnostic[]][]`
 * (Context7-grounded, microsoft/vscode `src/vscode-dts/vscode.d.ts`) into
 * {@link DiagnosticEntryLike} rows and feeds them here.
 *
 * Severity filtering (§3.1: "whole-workspace Error+Warning only") takes the
 * Error/Warning ORDINALS as injected parameters rather than hardcoding them,
 * so this file needs no `vscode.DiagnosticSeverity` import either — the
 * caller passes `vscode.DiagnosticSeverity.Error`/`.Warning` (Context7/write-time
 * grounded values: `Error = 0`, `Warning = 1`, `Information = 2`, `Hint = 3`).
 */
import type { DiagnosticRow } from './format';

/** One flattened `[uri, diagnostic]` pair, already `fsPath`-extracted by the
 * vscode shell — everything this pure mapper needs, and nothing `vscode`-typed. */
export interface DiagnosticEntryLike {
  path: string;
  /** The diagnostic's raw severity ordinal (`vscode.Diagnostic.severity`). */
  severity: number;
  /** 0-based (`vscode.Range.start.line`) — converted to 1-based below. */
  line: number;
  message: string;
  source?: string;
}

export type { DiagnosticRow };

/**
 * Filter to Error+Warning only and map to the port's row shape, converting
 * the 0-based line to the port's 1-based numbering. Input order is
 * preserved for the KEPT rows (no re-sorting/grouping here — `format.ts`
 * groups by file for display).
 */
export function mapDiagnosticEntries(
  entries: readonly DiagnosticEntryLike[],
  errorSeverity: number,
  warningSeverity: number,
): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [];
  for (const e of entries) {
    if (e.severity !== errorSeverity && e.severity !== warningSeverity) continue;
    rows.push({
      path: e.path,
      severity: e.severity === errorSeverity ? 'error' : 'warning',
      line: e.line + 1,
      message: e.message,
      source: e.source,
    });
  }
  return rows;
}
