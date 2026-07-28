import { describe, it, expect } from 'vitest';
import { getStopTokens } from './stopTokens';
import type { FimTemplate } from './types';

const fakeTemplate: FimTemplate = {
  render: (p, s) => `${p}${s}`,
  stop: ['<|fim_prefix|>', '<|fim_middle|>'],
};

describe('getStopTokens', () => {
  it('combines template stop tokens with the common stops', () => {
    const stops = getStopTokens(fakeTemplate, 'qwen2.5-coder:1.5b-base');
    expect(stops).toEqual([
      '<|fim_prefix|>',
      '<|fim_middle|>',
      '/src/',
      '#- coding: utf-8',
      '```',
    ]);
  });

  it('adds StarCoder2 artifact guards only when the model name includes "starcoder2"', () => {
    const stops = getStopTokens(fakeTemplate, 'starcoder2:3b');
    expect(stops).toEqual([
      '<|fim_prefix|>',
      '<|fim_middle|>',
      '/src/',
      '#- coding: utf-8',
      '```',
      't.',
      '\nt',
      '<file_sep>',
    ]);
  });

  it('does not add StarCoder2 guards for other models', () => {
    const stops = getStopTokens(fakeTemplate, 'qwen2.5-coder:1.5b-base');
    expect(stops).not.toContain('t.');
    expect(stops).not.toContain('<file_sep>');
  });
});
