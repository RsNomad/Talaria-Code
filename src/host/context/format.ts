/**
 * Pure per-kind context formatters (§2a `format.ts`): already-resolved
 * structured input → display text. No `vscode`, no I/O. Input shapes match
 * the port return types in `./types.ts` (`DiagnosticsPort.all()` row shape,
 * `EditorPort.activeSelection()`, `GitPort.workingDiff()`/`changedPaths()`)
 * so T2b's resolver can feed them directly.
 */

import { CONTEXT_BUDGET } from './sanitize';
import type { LineRange } from './types';

/** One diagnostics row, matching `DiagnosticsPort.all()`'s element shape. */
export interface DiagnosticRow {
  path: string;
  severity: 'error' | 'warning';
  line: number;
  message: string;
  source?: string;
}

/**
 * Format diagnostics grouped by file, one `path:line severity message` row
 * per diagnostic (source appended in parentheses when present), capped at
 * `max` rows with an "N more…" tail (Roo's cap, §3.1). Empty input ⇒ `''`.
 */
export function formatDiagnostics(rows: DiagnosticRow[], max: number = CONTEXT_BUDGET.diagnosticsMax): string {
  if (rows.length === 0) return '';

  const byFile = new Map<string, DiagnosticRow[]>();
  for (const row of rows) {
    const group = byFile.get(row.path);
    if (group) group.push(row);
    else byFile.set(row.path, [row]);
  }

  const lines: string[] = [];
  let shown = 0;
  for (const group of byFile.values()) {
    for (const row of group) {
      if (shown >= max) break;
      const suffix = row.source ? ` (${row.source})` : '';
      lines.push(`${row.path}:${row.line} ${row.severity} ${row.message}${suffix}`);
      shown++;
    }
  }

  const remaining = rows.length - shown;
  if (remaining > 0) lines.push(`${remaining} more…`);

  return lines.join('\n');
}

/** An already-resolved selection, matching `EditorPort.activeSelection()`'s (non-undefined) shape. */
export interface ResolvedSelection {
  path: string;
  text: string;
  range: LineRange;
}

/** Format a selection as a fenced code block labelled `path:startLine-endLine`. */
export function formatSelection(selection: ResolvedSelection): string {
  return `\`\`\`${selection.path}:${selection.range.startLine}-${selection.range.endLine}\n${selection.text}\n\`\`\``;
}

/** An already-captured terminal tail, matching `TerminalPort.capturedTail()`'s (non-undefined) shape. */
export interface CapturedTerminal {
  name: string;
  text: string;
}

/**
 * Format a captured terminal tail. Honest-empty (§3.1): no capture yet
 * (`text === ''`) renders the same notice the resolver falls back to when
 * `TerminalPort.capturedTail()` returns `undefined`.
 */
export function formatTerminal(terminal: CapturedTerminal): string {
  if (!terminal.text) {
    return '(no terminal output captured — shell integration inactive or nothing run since activation)';
  }
  return `Terminal: ${terminal.name}\n${terminal.text}`;
}

/** One changed path row, matching `GitPort.changedPaths()`'s resolved element shape. */
export interface ChangedPath {
  path: string;
  staged: boolean;
}

/** Already-resolved git working-tree state, matching `GitPort.workingDiff()`/`changedPaths()`'s resolved shapes. */
export interface ResolvedGitState {
  diff: string;
  changedPaths: ChangedPath[];
}

/**
 * Format the working-tree diff + short status (§3.1's `@git` v1 scope).
 * Honest-empty when there is neither a diff nor any changed path.
 */
export function formatGit(git: ResolvedGitState): string {
  if (!git.diff && git.changedPaths.length === 0) return '(no working-tree changes)';

  const statusLines = git.changedPaths.map((p) => `${p.staged ? 'staged' : 'unstaged'}  ${p.path}`);
  const parts: string[] = [];
  if (statusLines.length > 0) parts.push(statusLines.join('\n'));
  if (git.diff) parts.push(git.diff);

  return parts.join('\n\n');
}
