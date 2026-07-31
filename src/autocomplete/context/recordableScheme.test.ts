import { describe, it, expect } from 'vitest';
import { isRecordableScheme } from './recordableScheme';

/**
 * CF-19 / W4-T3 — RED-first tests for the shared recording-side scheme gate.
 *
 * `isRecordableScheme` mirrors GATE-4 (`nextedit/shell.vscode.ts`'s
 * `if (document.uri.scheme === 'vscode-scm' || document.uri.scheme ===
 * 'output') return;`, also duplicated in `provider.ts`'s trigger-side scheme
 * skip): both known-bad schemes GATE-4 denies (`vscode-scm`, `output`) must
 * stay denied here too, so recording and triggering agree. Egress/hygiene
 * discipline (fail toward NOT recording): this is an ALLOWLIST, not a mirror
 * of GATE-4's denylist shape — only `file` and `untitled` (real, user-owned
 * editable documents) are recordable; every other scheme, known or not, is
 * denied by default.
 */
describe('isRecordableScheme', () => {
  it('allows "file" — the ordinary on-disk document scheme', () => {
    expect(isRecordableScheme('file')).toBe(true);
  });

  it('allows "untitled" — an unsaved new-file document scheme', () => {
    expect(isRecordableScheme('untitled')).toBe(true);
  });

  it('denies "output" — GATE-4\'s own denied scheme (Output panel text)', () => {
    expect(isRecordableScheme('output')).toBe(false);
  });

  it('denies "vscode-scm" — GATE-4\'s own denied scheme (source-control input box)', () => {
    expect(isRecordableScheme('vscode-scm')).toBe(false);
  });

  it('denies an arbitrary/unknown scheme by default (fail toward NOT recording)', () => {
    expect(isRecordableScheme('git')).toBe(false);
    expect(isRecordableScheme('vscode-notebook-cell')).toBe(false);
    expect(isRecordableScheme('search-editor')).toBe(false);
  });

  it('denies the empty string', () => {
    expect(isRecordableScheme('')).toBe(false);
  });
});
