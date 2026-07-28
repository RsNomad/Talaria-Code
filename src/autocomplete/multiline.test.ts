import { describe, it, expect } from 'vitest';
import { shouldCompleteMultiline } from './multiline';

function input(overrides: Partial<Parameters<typeof shouldCompleteMultiline>[0]> = {}) {
  return {
    fullPrefix: 'function foo() {\n  ',
    fullSuffix: '\n}\n',
    languageId: 'typescript',
    hasSelectedCompletionInfo: false,
    ...overrides,
  };
}

describe('shouldCompleteMultiline', () => {
  it('forces true when opts.multiline is "always"', () => {
    expect(
      shouldCompleteMultiline(
        input({ hasSelectedCompletionInfo: true }),
        { multiline: 'always' },
      ),
    ).toBe(true);
  });

  it('forces false when opts.multiline is "never"', () => {
    expect(shouldCompleteMultiline(input(), { multiline: 'never' })).toBe(false);
  });

  it('is single-line when the IntelliSense widget is open, regardless of language', () => {
    expect(
      shouldCompleteMultiline(input({ hasSelectedCompletionInfo: true }), {
        multiline: 'auto',
      }),
    ).toBe(false);
  });

  it('is single-line when the cursor is inside a line comment', () => {
    expect(
      shouldCompleteMultiline(
        input({ fullPrefix: 'const x = 1;\n// TODO: ' }),
        { multiline: 'auto' },
      ),
    ).toBe(false);
  });

  it('is single-line inside a Python line comment too', () => {
    expect(
      shouldCompleteMultiline(
        input({
          fullPrefix: 'x = 1\n# TODO: ',
          languageId: 'python',
        }),
        { multiline: 'auto' },
      ),
    ).toBe(false);
  });

  it('defaults to multiline otherwise', () => {
    expect(shouldCompleteMultiline(input(), { multiline: 'auto' })).toBe(true);
  });

  it('is not fooled by a line that merely contains a comment marker mid-line', () => {
    expect(
      shouldCompleteMultiline(
        input({ fullPrefix: 'const url = "http://example.com" ' }),
        { multiline: 'auto' },
      ),
    ).toBe(true);
  });
});
