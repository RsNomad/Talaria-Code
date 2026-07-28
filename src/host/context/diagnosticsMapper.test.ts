import { describe, it, expect } from 'vitest';

import { mapDiagnosticEntries } from './diagnosticsMapper';
import type { DiagnosticEntryLike } from './diagnosticsMapper';

// Mirrors vscode.DiagnosticSeverity's real ordinals (Context7-grounded,
// microsoft/vscode `src/vscode-dts/vscode.d.ts`: Error=0, Warning=1,
// Information=2, Hint=3) — but the mapper takes them as INJECTED params
// (not hardcoded), so these tests also double as the "independent of a
// specific enum's numbering" contract check (arbitrary ordinals below).
const ERROR = 0;
const WARNING = 1;
const INFORMATION = 2;
const HINT = 3;

function entry(overrides: Partial<DiagnosticEntryLike> = {}): DiagnosticEntryLike {
  return { path: '/repo/a.ts', severity: ERROR, line: 0, message: 'boom', ...overrides };
}

describe('mapDiagnosticEntries — pure vscode.Diagnostic row mapper', () => {
  it('empty input maps to an empty array', () => {
    expect(mapDiagnosticEntries([], ERROR, WARNING)).toEqual([]);
  });

  it('maps Error severity to the "error" string row', () => {
    const rows = mapDiagnosticEntries([entry({ severity: ERROR })], ERROR, WARNING);
    expect(rows).toEqual([{ path: '/repo/a.ts', severity: 'error', line: 1, message: 'boom', source: undefined }]);
  });

  it('maps Warning severity to the "warning" string row', () => {
    const rows = mapDiagnosticEntries([entry({ severity: WARNING })], ERROR, WARNING);
    expect(rows[0]?.severity).toBe('warning');
  });

  it('drops Information severity (§3.1: Error+Warning only)', () => {
    const rows = mapDiagnosticEntries([entry({ severity: INFORMATION })], ERROR, WARNING);
    expect(rows).toEqual([]);
  });

  it('drops Hint severity', () => {
    const rows = mapDiagnosticEntries([entry({ severity: HINT })], ERROR, WARNING);
    expect(rows).toEqual([]);
  });

  it('converts a 0-based line to the port’s 1-based numbering', () => {
    const rows = mapDiagnosticEntries([entry({ line: 41 })], ERROR, WARNING);
    expect(rows[0]?.line).toBe(42);
  });

  it('passes `source` through when present', () => {
    const rows = mapDiagnosticEntries([entry({ source: 'tsc' })], ERROR, WARNING);
    expect(rows[0]?.source).toBe('tsc');
  });

  it('omits `source` (undefined) when the diagnostic has none', () => {
    const rows = mapDiagnosticEntries([entry({ source: undefined })], ERROR, WARNING);
    expect(rows[0]?.source).toBeUndefined();
  });

  it('filters a mixed-severity batch, preserving relative order of the kept rows', () => {
    const entries = [
      entry({ path: 'a', severity: ERROR, message: 'e1' }),
      entry({ path: 'b', severity: INFORMATION, message: 'i1' }),
      entry({ path: 'c', severity: WARNING, message: 'w1' }),
      entry({ path: 'd', severity: HINT, message: 'h1' }),
      entry({ path: 'e', severity: ERROR, message: 'e2' }),
    ];
    const rows = mapDiagnosticEntries(entries, ERROR, WARNING);
    expect(rows.map((r) => r.message)).toEqual(['e1', 'w1', 'e2']);
  });

  it('honors caller-injected severity ordinals independent of the real enum numbering', () => {
    // Swap what counts as "error"/"warning" entirely — proves no hardcoded 0/1.
    const rows = mapDiagnosticEntries([entry({ severity: 99 })], 99, 100);
    expect(rows).toEqual([{ path: '/repo/a.ts', severity: 'error', line: 1, message: 'boom', source: undefined }]);
  });

  it('multiple diagnostics across multiple files all map, flat, in input order', () => {
    const entries = [
      entry({ path: 'a.ts', line: 0, severity: ERROR }),
      entry({ path: 'b.ts', line: 4, severity: WARNING }),
      entry({ path: 'a.ts', line: 9, severity: ERROR }),
    ];
    const rows = mapDiagnosticEntries(entries, ERROR, WARNING);
    expect(rows.map((r) => `${r.path}:${r.line}`)).toEqual(['a.ts:1', 'b.ts:5', 'a.ts:10']);
  });
});
