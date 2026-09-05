import { describe, it, expect } from 'vitest';
import { GRAMMAR_FILE_BY_LANGUAGE } from './WebTreeSitterParser';

describe('WV3-MIN-SYN: GRAMMAR_FILE_BY_LANGUAGE is frozen', () => {
  it('the language→wasm map cannot be mutated by importers', () => {
    expect(Object.isFrozen(GRAMMAR_FILE_BY_LANGUAGE)).toBe(true);
  });
});
