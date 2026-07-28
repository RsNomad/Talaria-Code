import { describe, it, expect } from 'vitest';
import { processSingleLineCompletion } from './singleLine';

describe('processSingleLineCompletion', () => {
  it('returns undefined for an empty completion line', () => {
    expect(processSingleLineCompletion('', 'rest', 4)).toBeUndefined();
  });

  it('is a plain insertion when there is nothing after the cursor on the line', () => {
    expect(processSingleLineCompletion('+ 1', '', 10)).toEqual({
      completionText: '+ 1',
    });
  });

  it('returns undefined when everything to insert is already present after the cursor', () => {
    expect(processSingleLineCompletion('wor', 'world', 3)).toBeUndefined();
  });

  it('returns undefined for an exact duplicate of the existing suffix', () => {
    expect(processSingleLineCompletion('abc', 'abc', 5)).toBeUndefined();
  });

  it('extends the replace range through the existing suffix when the model regenerated it', () => {
    expect(processSingleLineCompletion('x, y)', ')', 8)).toEqual({
      completionText: 'x, y)',
      range: { start: 8, end: 9 },
    });
  });

  it('falls back to plain insertion for an unrelated mid-line completion', () => {
    expect(processSingleLineCompletion('42', ';', 6)).toEqual({
      completionText: '42',
    });
  });
});
