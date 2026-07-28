import { describe, it, expect } from 'vitest';
import { joinUrl } from './util';

describe('joinUrl', () => {
  it('joins a base without a trailing slash to a relative path', () => {
    expect(joinUrl('http://127.0.0.1:11434', 'api/generate')).toBe(
      'http://127.0.0.1:11434/api/generate',
    );
  });

  it('joins a base with a trailing slash without doubling it', () => {
    expect(joinUrl('http://127.0.0.1:8080/', 'infill')).toBe(
      'http://127.0.0.1:8080/infill',
    );
  });

  it('does not drop existing path segments on the base', () => {
    expect(joinUrl('https://api.mistral.ai', 'v1/fim/completions')).toBe(
      'https://api.mistral.ai/v1/fim/completions',
    );
  });

  it('preserves a base with its own subpath', () => {
    expect(joinUrl('http://localhost:8000/proxy', 'v1/completions')).toBe(
      'http://localhost:8000/proxy/v1/completions',
    );
  });
});
