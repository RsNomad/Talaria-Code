import { describe, it, expect } from 'vitest';
import { postprocessCompletion, trimAtStopTokens } from './postprocess';

describe('trimAtStopTokens', () => {
  it('returns the text unchanged when no stop token appears', () => {
    expect(trimAtStopTokens('result = a + b', ['<|endoftext|>'])).toBe(
      'result = a + b',
    );
  });

  it('cuts the text at the first occurrence of any stop token', () => {
    expect(
      trimAtStopTokens('result = a + b<|fim_suffix|>garbage', [
        '<|fim_prefix|>',
        '<|fim_suffix|>',
      ]),
    ).toBe('result = a + b');
  });

  it('picks the earliest cut point across multiple matching stop tokens', () => {
    expect(trimAtStopTokens('foo\nbar\nbaz', ['\nbaz', '\nbar'])).toBe('foo');
  });

  it('handles an empty stop list', () => {
    expect(trimAtStopTokens('foo', [])).toBe('foo');
  });
});

describe('postprocessCompletion', () => {
  const base = { prefix: '', suffix: '', model: 'qwen2.5-coder:1.5b-base' };

  it('returns undefined for an empty completion', () => {
    expect(
      postprocessCompletion({ ...base, completion: '', stop: [] }),
    ).toBeUndefined();
  });

  it('returns undefined for a whitespace-only completion', () => {
    expect(
      postprocessCompletion({ ...base, completion: '   \n  ', stop: [] }),
    ).toBeUndefined();
  });

  it('trims at the first stop token', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: 'a + b<|endoftext|>junk',
        stop: ['<|endoftext|>'],
      }),
    ).toBe('a + b');
  });

  it('removes a markdown code fence wrapper', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: '```typescript\nconst x = 1;\n```',
        stop: [],
      }),
    ).toBe('const x = 1;');
  });

  it('drops a duplicate leading space when the prefix already ends with a space', () => {
    expect(
      postprocessCompletion({
        prefix: 'const x = ',
        suffix: '',
        model: 'qwen2.5-coder:1.5b-base',
        completion: ' 1;',
        stop: [],
      }),
    ).toBe('1;');
  });

  it('strips <think>...</think> blocks for qwen3 models', () => {
    expect(
      postprocessCompletion({
        prefix: '',
        suffix: '',
        model: 'qwen3-coder:7b',
        completion: '<think>reasoning about it</think>\nconst x = 1;',
        stop: [],
      }),
    ).toBe('const x = 1;');
  });

  it('returns undefined when the completion is just a repeat of the line above', () => {
    expect(
      postprocessCompletion({
        prefix: 'function add(a, b) {\n  return a + b;\n',
        suffix: '',
        model: 'qwen2.5-coder:1.5b-base',
        completion: '  return a + b;',
        stop: [],
      }),
    ).toBeUndefined();
  });

  it('leaves an unrelated completion untouched', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: 'return a + b;',
        stop: [],
      }),
    ).toBe('return a + b;');
  });
});
