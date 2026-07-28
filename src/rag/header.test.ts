import { describe, expect, it } from 'vitest';

import { buildHeaderLine, commentTokenForExtension, prependHeader } from './header';

describe('commentTokenForExtension', () => {
  it('maps known extensions', () => {
    expect(commentTokenForExtension('ts')).toBe('//');
    expect(commentTokenForExtension('PY')).toBe('#');
    expect(commentTokenForExtension('lua')).toBe('--');
    expect(commentTokenForExtension('html')).toBe('<!--');
  });

  it('falls back to // for unknown extensions', () => {
    expect(commentTokenForExtension('zig')).toBe('//');
  });
});

describe('buildHeaderLine', () => {
  it('renders just the path when there is no symbol breadcrumb', () => {
    expect(buildHeaderLine('src/auth/session.ts', [], 'ts')).toBe('// file: src/auth/session.ts');
  });

  it('joins the symbol breadcrumb with " › "', () => {
    expect(buildHeaderLine('src/auth/session.ts', ['SessionManager', 'refreshToken'], 'ts')).toBe(
      '// file: src/auth/session.ts › SessionManager › refreshToken',
    );
  });

  it('uses the # token for python', () => {
    expect(buildHeaderLine('app/models.py', ['User'], 'py')).toBe('# file: app/models.py › User');
  });

  it('wraps html headers in an HTML comment', () => {
    expect(buildHeaderLine('index.html', [], 'html')).toBe('<!-- file: index.html -->');
  });
});

describe('prependHeader', () => {
  it('joins header and content with a single newline', () => {
    expect(prependHeader('// file: a.ts', 'const x = 1;')).toBe('// file: a.ts\nconst x = 1;');
  });
});
