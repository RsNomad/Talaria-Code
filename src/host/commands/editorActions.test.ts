/**
 * W2 T3 (F-A code actions, §3.3) — the PURE `buildSeed` seed-text builder.
 *
 * Every editor action (Add/Explain/Improve/Fix with Talaria) is a prompt
 * SEEDER, never a `WorkspaceEdit`: the impure command handler snapshots
 * `vscode.window.activeTextEditor` and hands the plain data over to this
 * function, which builds the `composer.seed` payload
 * (`{text, mentions: ContextRef[]}`) with zero `vscode` import — table-tested
 * here per intent, headless.
 */
import { describe, it, expect } from 'vitest';

import { buildSeed, flattenDiagnosticsForFix } from './editorActions';

const RANGE = { startLine: 3, endLine: 5 };
const ERROR = 0;
const WARNING = 1;
const INFO = 2;

describe('buildSeed — pure editor-action seed builder (W2 T3, §3.3)', () => {
  it('"add" intent: seeds a fenced code block with the intent line, no problems section', () => {
    const seed = buildSeed({
      intent: 'add',
      path: 'src/a.ts',
      languageId: 'typescript',
      code: 'const x = 1;',
      range: RANGE,
      problems: '',
    });

    expect(seed.text).toBe(
      'Add this code for context.\n\nsrc/a.ts:3-5\n```typescript\nconst x = 1;\n```',
    );
    expect(seed.text).not.toMatch(/Problems:/);
  });

  it('"explain" intent: seeds the explain intent line + fenced code', () => {
    const seed = buildSeed({
      intent: 'explain',
      path: 'src/b.py',
      languageId: 'python',
      code: 'def f():\n    pass',
      range: { startLine: 10, endLine: 11 },
      problems: '',
    });

    expect(seed.text).toBe(
      'Explain this code.\n\nsrc/b.py:10-11\n```python\ndef f():\n    pass\n```',
    );
  });

  it('"improve" intent: seeds the improve intent line + fenced code', () => {
    const seed = buildSeed({
      intent: 'improve',
      path: 'src/c.go',
      languageId: 'go',
      code: 'func f() {}',
      range: { startLine: 1, endLine: 1 },
      problems: '',
    });

    expect(seed.text).toBe(
      'Improve this code.\n\nsrc/c.go:1-1\n```go\nfunc f() {}\n```',
    );
  });

  it('"fix" intent WITH problems: appends a "Problems:" section after the fenced code', () => {
    const seed = buildSeed({
      intent: 'fix',
      path: 'src/d.ts',
      languageId: 'typescript',
      code: 'const y: number = "oops";',
      range: { startLine: 7, endLine: 7 },
      problems: "src/d.ts:7 error Type 'string' is not assignable to type 'number'. (tsc)",
    });

    expect(seed.text).toBe(
      'Fix the problem(s) below in this code.\n\n' +
        'src/d.ts:7-7\n' +
        '```typescript\nconst y: number = "oops";\n```\n\n' +
        "Problems:\nsrc/d.ts:7 error Type 'string' is not assignable to type 'number'. (tsc)",
    );
  });

  it('"fix" intent with EMPTY problems: omits the "Problems:" section entirely (no dangling header)', () => {
    const seed = buildSeed({
      intent: 'fix',
      path: 'src/e.ts',
      languageId: 'typescript',
      code: 'const z = 1;',
      range: { startLine: 2, endLine: 2 },
      problems: '',
    });

    expect(seed.text).toBe('Fix the problem(s) below in this code.\n\nsrc/e.ts:2-2\n```typescript\nconst z = 1;\n```');
    expect(seed.text).not.toMatch(/Problems:/);
  });

  it('non-fix intents ignore a non-empty `problems` input (only fix ever surfaces it)', () => {
    const seed = buildSeed({
      intent: 'explain',
      path: 'src/f.ts',
      languageId: 'typescript',
      code: 'const w = 1;',
      range: { startLine: 1, endLine: 1 },
      problems: 'this must never appear',
    });

    expect(seed.text).not.toMatch(/this must never appear/);
  });

  it('emits exactly one file mention carrying the snapshot path and range', () => {
    const seed = buildSeed({
      intent: 'add',
      path: 'src/g.ts',
      languageId: 'typescript',
      code: 'const v = 1;',
      range: { startLine: 4, endLine: 6 },
      problems: '',
    });

    expect(seed.mentions).toEqual([
      { id: 'file:src/g.ts', kind: 'file', path: 'src/g.ts', range: { startLine: 4, endLine: 6 } },
    ]);
  });

  it('falls back to an unlabeled fence when languageId is empty (no "```" + garbage)', () => {
    const seed = buildSeed({
      intent: 'add',
      path: 'src/h.txt',
      languageId: '',
      code: 'plain text',
      range: { startLine: 1, endLine: 1 },
      problems: '',
    });

    expect(seed.text).toBe('Add this code for context.\n\nsrc/h.txt:1-1\n```\nplain text\n```');
  });
});

describe('flattenDiagnosticsForFix — pure "Problems:" flattener for the fix intent (§5.7)', () => {
  it('empty diagnostics flattens to an empty string', () => {
    expect(flattenDiagnosticsForFix('src/a.ts', [], ERROR, WARNING)).toBe('');
  });

  it('formats a single error as "path:line error message"', () => {
    const out = flattenDiagnosticsForFix(
      'src/a.ts',
      [{ severity: ERROR, line: 6, message: 'boom' }],
      ERROR,
      WARNING,
    );
    expect(out).toBe('src/a.ts:7 error boom');
  });

  it('appends the source in parentheses when present', () => {
    const out = flattenDiagnosticsForFix(
      'src/a.ts',
      [{ severity: ERROR, line: 0, message: 'boom', source: 'tsc' }],
      ERROR,
      WARNING,
    );
    expect(out).toBe('src/a.ts:1 error boom (tsc)');
  });

  it('drops severities other than error/warning (e.g. Information)', () => {
    const out = flattenDiagnosticsForFix(
      'src/a.ts',
      [{ severity: INFO, line: 0, message: 'fyi' }],
      ERROR,
      WARNING,
    );
    expect(out).toBe('');
  });

  it('flattens multiple diagnostics, one per line, in input order', () => {
    const out = flattenDiagnosticsForFix(
      'src/a.ts',
      [
        { severity: ERROR, line: 0, message: 'first' },
        { severity: WARNING, line: 4, message: 'second' },
      ],
      ERROR,
      WARNING,
    );
    expect(out).toBe('src/a.ts:1 error first\nsrc/a.ts:5 warning second');
  });
});
