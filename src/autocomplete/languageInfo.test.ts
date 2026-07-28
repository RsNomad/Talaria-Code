import { describe, it, expect } from 'vitest';
import { getSingleLineComment } from './languageInfo';

describe('getSingleLineComment', () => {
  it('returns // for C-family languages', () => {
    expect(getSingleLineComment('typescript')).toBe('//');
    expect(getSingleLineComment('typescriptreact')).toBe('//');
    expect(getSingleLineComment('javascript')).toBe('//');
    expect(getSingleLineComment('java')).toBe('//');
    expect(getSingleLineComment('go')).toBe('//');
    expect(getSingleLineComment('rust')).toBe('//');
  });

  it('returns # for script languages', () => {
    expect(getSingleLineComment('python')).toBe('#');
    expect(getSingleLineComment('ruby')).toBe('#');
    expect(getSingleLineComment('shellscript')).toBe('#');
    expect(getSingleLineComment('yaml')).toBe('#');
  });

  it('returns -- for SQL/Lua', () => {
    expect(getSingleLineComment('sql')).toBe('--');
    expect(getSingleLineComment('lua')).toBe('--');
  });

  it('returns undefined for languages with no single-line comment or unknown ids', () => {
    expect(getSingleLineComment('html')).toBeUndefined();
    expect(getSingleLineComment('json')).toBeUndefined();
    expect(getSingleLineComment('some-made-up-language')).toBeUndefined();
  });
});
