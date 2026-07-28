/*
 * RED-first tests for `parseMentions` — the pure text -> ContextRef[]
 * derivation (architecture doc §2b / §7 A7: text is the single source of
 * truth; refs are re-derived from the draft on every change, never tracked
 * in a side-array that could desync from what's actually typed).
 */
import { describe, it, expect } from 'vitest';
import { parseMentions, formatMentionToken } from './parseMentions';

describe('parseMentions — singleton kinds (@problems/@selection/@terminal/@git)', () => {
  it('parses a bare @problems into a singleton ref', () => {
    expect(parseMentions('please check @problems now')).toEqual([{ id: 'problems', kind: 'problems' }]);
  });

  it('parses each of the four singleton kinds', () => {
    expect(parseMentions('@selection')).toEqual([{ id: 'selection', kind: 'selection' }]);
    expect(parseMentions('@terminal')).toEqual([{ id: 'terminal', kind: 'terminal' }]);
    expect(parseMentions('@git')).toEqual([{ id: 'git', kind: 'git' }]);
  });

  it('matches at the very end of the string', () => {
    expect(parseMentions('what do you see in @terminal')).toEqual([{ id: 'terminal', kind: 'terminal' }]);
  });

  it('DELIBERATE FLIP (I1 hardening): "@problems," is NO LONGER a ref — trailing punctuation glued to a singleton is prose, not a mention. Only whitespace/end terminates one, mirroring the picker\'s own `@kind ` insertion.', () => {
    expect(parseMentions('see @problems, then fix it.')).toEqual([]);
  });
});

describe('parseMentions — prose false positives (anchored to KNOWN kinds only)', () => {
  it('does NOT treat "@gitlab.com" as a @git mention (word chars glued after the kind)', () => {
    expect(parseMentions('see the mirror at @gitlab.com for details')).toEqual([]);
  });

  it('does NOT treat "@terminaled" or "@problemsolving" as mentions', () => {
    expect(parseMentions('the shell was @terminaled unexpectedly')).toEqual([]);
    expect(parseMentions('this is a @problemsolving exercise')).toEqual([]);
  });

  it('does NOT treat "@filename.txt" (no colon) as a @file ref — it is just prose', () => {
    expect(parseMentions('rename @filename.txt please')).toEqual([]);
  });

  it('does NOT treat an unrelated @handle as any kind of ref', () => {
    expect(parseMentions('cc @someuser about this')).toEqual([]);
  });
});

describe('parseMentions — I1 SECURITY: leading word-boundary before `@` (mid-word / email-local-part is never a mention)', () => {
  it('does NOT treat the "@git" inside "admin@git.internal.corp" as a mention (no whitespace/start before the @)', () => {
    expect(parseMentions('contact admin@git.internal.corp for access')).toEqual([]);
  });

  it('does NOT treat the "@git" inside "myfile@git" as a mention (mid-word, no leading boundary)', () => {
    expect(parseMentions('myfile@git')).toEqual([]);
  });

  it('DOES still match when the same kind is preceded by whitespace or is at start-of-text', () => {
    expect(parseMentions('start @git')).toEqual([{ id: 'git', kind: 'git' }]);
    expect(parseMentions('@git at the start')).toEqual([{ id: 'git', kind: 'git' }]);
  });
});

describe('parseMentions — I1 SECURITY: singleton trailing guard requires whitespace/end (dot-suffixed and Unicode-glued prose)', () => {
  it('does NOT treat "@terminal.app" as a @terminal mention (dot-suffixed, e.g. an app id/URL in prose)', () => {
    expect(parseMentions('open @terminal.app now')).toEqual([]);
  });

  it('does NOT treat "@problems.io" as a @problems mention (dot-suffixed domain in prose)', () => {
    expect(parseMentions('check @problems.io for the tracker')).toEqual([]);
  });

  it('does NOT treat "@gitämlich" as a @git mention (Unicode letter glued after the kind, not caught by ASCII \\w)', () => {
    expect(parseMentions('@gitämlich')).toEqual([]);
  });

  it('does NOT treat "@terminalöffnung" as a @terminal mention (Unicode letter glued after the kind)', () => {
    expect(parseMentions('@terminalöffnung')).toEqual([]);
  });
});

describe('parseMentions — @file:<path> / @folder:<path>', () => {
  it('parses @file:<path> into a path ref keyed by kind:path', () => {
    expect(parseMentions('look at @file:src/foo.ts please')).toEqual([
      { id: 'file:src/foo.ts', kind: 'file', path: 'src/foo.ts' },
    ]);
  });

  it('parses @folder:<path> into a path ref', () => {
    expect(parseMentions('scan @folder:src/components')).toEqual([
      { id: 'folder:src/components', kind: 'folder', path: 'src/components' },
    ]);
  });

  it('the path is the run of non-whitespace chars after the colon (stops at whitespace)', () => {
    expect(parseMentions('@file:src/a b/c.ts')).toEqual([{ id: 'file:src/a', kind: 'file', path: 'src/a' }]);
  });

  it('a path at the very end of the string is captured in full', () => {
    expect(parseMentions('reference @file:src/foo/bar.ts')).toEqual([
      { id: 'file:src/foo/bar.ts', kind: 'file', path: 'src/foo/bar.ts' },
    ]);
  });
});

describe('parseMentions — I2 correctness: quoted @file:"path with spaces" tokens round-trip in full', () => {
  it('parses a quoted space-containing path into a ref with the quotes stripped and the full path intact', () => {
    expect(parseMentions('please open @file:"docs/My Notes.txt" today')).toEqual([
      { id: 'file:docs/My Notes.txt', kind: 'file', path: 'docs/My Notes.txt' },
    ]);
  });

  it('parses a quoted space-containing @folder path the same way', () => {
    expect(parseMentions('scan @folder:"src/My Components"')).toEqual([
      { id: 'folder:src/My Components', kind: 'folder', path: 'src/My Components' },
    ]);
  });

  it('an unquoted path with a literal quote but no closing quote falls through to the bare-path grammar (documented residual, truncates at first whitespace)', () => {
    expect(parseMentions('@file:"unterminated no closing quote')).toEqual([
      { id: 'file:"unterminated', kind: 'file', path: '"unterminated' },
    ]);
  });

  it('a lone quote with nothing else after the colon is not stripped to an empty path (kept as the literal bare token, not a ref-breaking empty path)', () => {
    expect(parseMentions('typing @file:"')).toEqual([{ id: 'file:"', kind: 'file', path: '"' }]);
  });

  it('an empty quoted path ("") strips to empty and is NOT a ref, same as an empty bare path', () => {
    expect(parseMentions('@file:"" nothing here')).toEqual([]);
  });
});

describe('parseMentions — bare @file / @folder and empty paths are NOT refs (incomplete tokens)', () => {
  it('a bare @file with no colon/path is not a ref (it only opens the submenu)', () => {
    expect(parseMentions('attach @file to this')).toEqual([]);
  });

  it('a bare @folder with no colon/path is not a ref', () => {
    expect(parseMentions('attach @folder to this')).toEqual([]);
  });

  it('@file: with an empty path (immediately followed by whitespace) is not a ref', () => {
    expect(parseMentions('@file: please help')).toEqual([]);
  });

  it('@file: with an empty path at end of string is not a ref', () => {
    expect(parseMentions('typing @file:')).toEqual([]);
  });

  it('@folder: with an empty path is not a ref', () => {
    expect(parseMentions('@folder: ')).toEqual([]);
  });
});

describe('parseMentions — dedup (same token twice yields ONE ref)', () => {
  it('dedups a repeated singleton mention', () => {
    expect(parseMentions('@problems ... still @problems')).toEqual([{ id: 'problems', kind: 'problems' }]);
  });

  it('dedups a repeated identical @file:<path> mention', () => {
    expect(parseMentions('@file:src/a.ts and again @file:src/a.ts')).toEqual([
      { id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' },
    ]);
  });

  it('does NOT dedup @file:<path> vs @folder:<path> for the same path (different kind -> different id)', () => {
    expect(parseMentions('@file:src/a.ts @folder:src/a.ts')).toEqual([
      { id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' },
      { id: 'folder:src/a.ts', kind: 'folder', path: 'src/a.ts' },
    ]);
  });
});

describe('parseMentions — mixed kinds and ordering (first appearance in text)', () => {
  it('returns refs in first-appearance order across mixed kinds', () => {
    // NOTE: uses "@problems also" (no glued comma) — under the I1 stricter
    // singleton trailing guard, "@problems," would no longer be a ref at all
    // (see the DELIBERATE FLIP test above); this test is about ordering, not
    // that behavior, so it stays punctuation-free around the singleton.
    expect(parseMentions('@git status, @file:src/a.ts and @problems also @selection')).toEqual([
      { id: 'git', kind: 'git' },
      { id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' },
      { id: 'problems', kind: 'problems' },
      { id: 'selection', kind: 'selection' },
    ]);
  });

  it('keeps the FIRST-seen position even when a duplicate appears much later', () => {
    expect(parseMentions('@selection @file:a.ts @selection @file:b.ts')).toEqual([
      { id: 'selection', kind: 'selection' },
      { id: 'file:a.ts', kind: 'file', path: 'a.ts' },
      { id: 'file:b.ts', kind: 'file', path: 'b.ts' },
    ]);
  });
});

describe('parseMentions — edge cases', () => {
  it('empty text yields no refs', () => {
    expect(parseMentions('')).toEqual([]);
  });

  it('text with no @ at all yields no refs', () => {
    expect(parseMentions('just plain text, nothing to see here')).toEqual([]);
  });

  it('a lone "@" with nothing after it yields no refs', () => {
    expect(parseMentions('reach me @')).toEqual([]);
  });
});

describe('formatMentionToken — I2 correctness: PURE inserter helper, quotes space-containing paths', () => {
  it('quotes a path that contains whitespace', () => {
    expect(formatMentionToken('file', 'docs/My Notes.txt')).toBe('@file:"docs/My Notes.txt" ');
  });

  it('does NOT quote a path with no whitespace', () => {
    expect(formatMentionToken('file', 'src/foo.ts')).toBe('@file:src/foo.ts ');
  });

  it('quotes a @folder path that contains whitespace the same way', () => {
    expect(formatMentionToken('folder', 'src/My Components')).toBe('@folder:"src/My Components" ');
  });

  it('round-trips through parseMentions: a quoted space-path token parses back to the exact original path', () => {
    const token = formatMentionToken('file', 'docs/My Notes.txt');
    expect(parseMentions(`please see ${token}now`)).toEqual([
      { id: 'file:docs/My Notes.txt', kind: 'file', path: 'docs/My Notes.txt' },
    ]);
  });

  it('round-trips a whitespace-free path unquoted through parseMentions', () => {
    const token = formatMentionToken('folder', 'src/components');
    expect(parseMentions(`please see ${token}now`)).toEqual([
      { id: 'folder:src/components', kind: 'folder', path: 'src/components' },
    ]);
  });
});
