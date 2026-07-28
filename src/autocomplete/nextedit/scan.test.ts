import { describe, it, expect, vi } from 'vitest';
import { mintScannedNextEditRequest, NEXT_EDIT_FIELD_CLASSIFICATION, contentChecksFor } from './scan';
import type { NextEditRequest } from './types';
import { must } from '../../testing/must';

const baseReq = (): NextEditRequest => ({
  model: 'sweep-next-edit-v2-7b',
  cursor: { uri: 'file:///a.ts', line: 50, character: 4 },
  region: { uri: 'file:///a.ts', filepath: 'file:///a.ts', startLine: 40, endLine: 60, content: 'const x = 1;\n' },
  preEditRegion: 'const x = 0;\n',
  fileContext: 'context lines\n',
  docText: 'whole file\n',
  preEditDocText: 'whole file before\n',
  changesAboveCursor: false,
  diffs: [{ uri: 'file:///a.ts', filepath: 'file:///a.ts', startLine: 1, endLine: 2, before: 'b', after: 'a' }],
  docVersion: 7,
});

describe('NEXT_EDIT_FIELD_CLASSIFICATION exhaustiveness', () => {
  it('classifies every runtime key (a new field without a row fails here AND at compile time)', () => {
    for (const key of Object.keys(baseReq())) {
      expect(NEXT_EDIT_FIELD_CLASSIFICATION[key as keyof NextEditRequest],
        `unclassified field: ${key}`).toMatch(/^(content|structural)$/);
    }
  });

  it("is frozen — in-process reassignment cannot silently disable a field's scan", () => {
    expect(Object.isFrozen(NEXT_EDIT_FIELD_CLASSIFICATION)).toBe(true);
  });

  it('fail-closed: a classified field with NO wired extractor refuses the mint (table/extractor drift)', () => {
    // 'model' deliberately has no extractor — driving the lookup with it
    // exercises the exact drift branch: the branch keys on extractor
    // ABSENCE (scan.ts contentChecksFor), not on the classification value.
    expect(() => contentChecksFor(baseReq(), 'model')).toThrow(/ruleId=no-extractor/);
  });

  it('rejects an empty-string sentinel loudly (it would otherwise reject every mint as ruleId=sentinel)', () => {
    expect(() => mintScannedNextEditRequest(baseReq(), [''])).toThrow(/ruleId=empty-sentinel/);
  });
});

describe('mintScannedNextEditRequest', () => {
  it('mints a clean request', () => {
    expect(() => mintScannedNextEditRequest(baseReq(), ['<|file_sep|>'])).not.toThrow();
  });

  it.each([
    ['region', (r: NextEditRequest) => ({ ...r, region: { ...r.region, content: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' } })],
    ['docText', (r: NextEditRequest) => ({ ...r, docText: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' })],
    ['preEditDocText', (r: NextEditRequest) => ({ ...r, preEditDocText: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' })],
    ['diffs.before', (r: NextEditRequest) => ({ ...r, diffs: [{ ...must(r.diffs[0]), before: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' }] })],
    ['preEditRegion', (r: NextEditRequest) => ({ ...r, preEditRegion: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' })],
    ['diffs.after', (r: NextEditRequest) => ({ ...r, diffs: [{ ...must(r.diffs[0]), after: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' }] })],
  ])('rejects a secret in %s; the error carries a ruleId but never the matched text', (_name, poison) => {
    let err: Error | undefined;
    try { mintScannedNextEditRequest(poison(baseReq()), []); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/ruleId=/);
    expect(err!.message).not.toContain('wJalrXUtnFEMI');
  });

  it('rejects content carrying a format sentinel (prompt restructuring)', () => {
    const poisoned = { ...baseReq(), fileContext: 'text with <|file_sep|> inside\n' };
    expect(() => mintScannedNextEditRequest(poisoned, ['<|file_sep|>'])).toThrow(/ruleId=sentinel/);
  });

  it('does NOT scan structural fields (no false positive on a secret-looking model name)', () => {
    const r = { ...baseReq(), model: 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' };
    expect(() => mintScannedNextEditRequest(r, [])).not.toThrow();
  });

  it('treats a scanner throw as a reject (fail-closed)', async () => {
    vi.resetModules();
    vi.doMock('../context/secretScanner', () => ({
      scanSnippetForSecrets: () => { throw new Error('boom'); },
    }));
    const { mintScannedNextEditRequest: mintMocked } = await import('./scan');
    expect(() => mintMocked(baseReq(), [])).toThrow(/ruleId=scanner-threw/);
    vi.doUnmock('../context/secretScanner');
  });
});
