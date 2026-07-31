import { describe, it, expect } from 'vitest';
import { isRecordableScheme, isTriggerableScheme, isEditableUserDoc } from './recordableScheme';

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

/**
 * §4 — `isRecordableScheme` is now the AND-composition
 * `isTriggerableScheme(scheme) && isEditableUserDoc(scheme)`, so the
 * subset relationship "record ⊆ trigger" is a structural fact about the
 * composition, not a coincidence of two independently-maintained literal
 * lists. `isTriggerableScheme` mirrors GATE-4's denylist shape (deny
 * `vscode-scm`/`output`, allow everything else); `isEditableUserDoc` is the
 * allowlist (`file`/`untitled`) that used to be `isRecordableScheme`'s
 * entire body.
 *
 * This table pins the pair (canTrigger, canRecord) for every scheme GATE-4
 * or the recording sites are known to care about, including three schemes
 * `isTriggerableScheme` allows through but `isEditableUserDoc` still denies
 * (`git`, `vscode-notebook-cell`, `search-editor`) plus two more of the same
 * shape (`vscode-userdata`, `comment`) and the empty-string edge. It is NOT
 * a test of "will a completion actually fire" — the full trigger path has
 * additional gates (typed-length, widget focus, …) this table does not
 * model.
 */
describe('isTriggerableScheme / isRecordableScheme — table + subset invariant', () => {
  const table: ReadonlyArray<{ scheme: string; canTrigger: boolean; canRecord: boolean }> = [
    { scheme: 'file', canTrigger: true, canRecord: true },
    { scheme: 'untitled', canTrigger: true, canRecord: true },
    { scheme: 'vscode-scm', canTrigger: false, canRecord: false },
    { scheme: 'output', canTrigger: false, canRecord: false },
    { scheme: 'git', canTrigger: true, canRecord: false },
    { scheme: 'vscode-notebook-cell', canTrigger: true, canRecord: false },
    { scheme: 'search-editor', canTrigger: true, canRecord: false },
    { scheme: 'vscode-userdata', canTrigger: true, canRecord: false },
    { scheme: 'comment', canTrigger: true, canRecord: false },
    { scheme: '', canTrigger: true, canRecord: false },
  ];

  it.each(table)(
    'scheme "$scheme": isTriggerableScheme=$canTrigger, isRecordableScheme=$canRecord',
    ({ scheme, canTrigger, canRecord }) => {
      expect(isTriggerableScheme(scheme)).toBe(canTrigger);
      expect(isRecordableScheme(scheme)).toBe(canRecord);
    },
  );

  it.each(table)('invariant: canRecord ⇒ canTrigger for scheme "$scheme"', ({ scheme }) => {
    if (isRecordableScheme(scheme)) {
      expect(isTriggerableScheme(scheme)).toBe(true);
    }
  });

  it('isRecordableScheme is exactly isTriggerableScheme AND isEditableUserDoc, on every tabled scheme', () => {
    for (const { scheme } of table) {
      expect(isRecordableScheme(scheme)).toBe(isTriggerableScheme(scheme) && isEditableUserDoc(scheme));
    }
  });
});
