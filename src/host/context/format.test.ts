import { describe, it, expect } from 'vitest';
import { formatDiagnostics, formatSelection, formatTerminal, formatGit } from './format';

describe('formatDiagnostics', () => {
  it('returns an empty string for no diagnostics', () => {
    expect(formatDiagnostics([])).toBe('');
  });

  it('formats a single row as "path:line severity message"', () => {
    const result = formatDiagnostics([{ path: 'src/foo.ts', severity: 'error', line: 12, message: "Cannot find name 'x'" }]);
    expect(result).toBe("src/foo.ts:12 error Cannot find name 'x'");
  });

  it('appends the diagnostic source in parentheses when present', () => {
    const result = formatDiagnostics([
      { path: 'src/foo.ts', severity: 'warning', line: 3, message: 'unused variable', source: 'eslint' },
    ]);
    expect(result).toBe('src/foo.ts:3 warning unused variable (eslint)');
  });

  it('groups rows by file (same-file rows are contiguous) regardless of input interleaving', () => {
    const rows = [
      { path: 'a.ts', severity: 'error' as const, line: 1, message: 'e1' },
      { path: 'b.ts', severity: 'error' as const, line: 1, message: 'e2' },
      { path: 'a.ts', severity: 'error' as const, line: 2, message: 'e3' },
    ];
    const result = formatDiagnostics(rows);
    const lines = result.split('\n');
    expect(lines).toEqual(['a.ts:1 error e1', 'a.ts:2 error e3', 'b.ts:1 error e2']);
  });

  it('caps at max rows and appends an "N more…" tail', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      path: 'src/many.ts',
      severity: 'error' as const,
      line: i + 1,
      message: `err ${i}`,
    }));
    const result = formatDiagnostics(rows, 50);
    const lines = result.split('\n');
    expect(lines).toHaveLength(51);
    expect(lines[50]).toBe('10 more…');
  });

  it('defaults the cap to CONTEXT_BUDGET.diagnosticsMax (50)', () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      path: 'src/many.ts',
      severity: 'error' as const,
      line: i + 1,
      message: `err ${i}`,
    }));
    const result = formatDiagnostics(rows);
    expect(result.split('\n')).toHaveLength(51);
    expect(result.split('\n')[50]).toBe('5 more…');
  });
});

describe('formatSelection', () => {
  it('renders a fenced code block labelled path:startLine-endLine', () => {
    const result = formatSelection({
      path: 'src/foo.ts',
      text: 'const x = 1;',
      range: { startLine: 10, endLine: 10 },
    });
    expect(result).toBe('```src/foo.ts:10-10\nconst x = 1;\n```');
  });

  it('renders a multi-line selection with the full range', () => {
    const result = formatSelection({
      path: 'src/foo.ts',
      text: 'line a\nline b',
      range: { startLine: 3, endLine: 4 },
    });
    expect(result).toBe('```src/foo.ts:3-4\nline a\nline b\n```');
  });
});

describe('formatTerminal', () => {
  it('returns the honest-empty notice when no output was captured', () => {
    const result = formatTerminal({ name: 'bash', text: '' });
    expect(result).toBe('(no terminal output captured — shell integration inactive or nothing run since activation)');
  });

  it('renders the terminal name and captured tail when present', () => {
    const result = formatTerminal({ name: 'bash', text: '$ npm test\nok' });
    expect(result).toBe('Terminal: bash\n$ npm test\nok');
  });
});

describe('formatGit', () => {
  it('returns an honest-empty notice when there is no diff and no changed paths', () => {
    const result = formatGit({ diff: '', changedPaths: [] });
    expect(result).toBe('(no working-tree changes)');
  });

  it('renders short status (staged/unstaged) followed by the diff', () => {
    const result = formatGit({
      diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',
      changedPaths: [
        { path: 'x.ts', staged: true },
        { path: 'y.ts', staged: false },
      ],
    });
    expect(result).toBe('staged  x.ts\nunstaged  y.ts\n\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new');
  });

  it('renders status alone when there is no diff text', () => {
    const result = formatGit({ diff: '', changedPaths: [{ path: 'x.ts', staged: false }] });
    expect(result).toBe('unstaged  x.ts');
  });
});
