import { describe, it, expect } from 'vitest';
import { escapeSqlLiteral } from './LanceDBStore';

/**
 * Audit B-11. `filter.language` comes from the agent's own tool arguments
 * (LanceDBStore.ts:109) and is concatenated into a `where` predicate. Round 1
 * replaced the whole function body with `return value;` and the suite stayed
 * green.
 */
describe('escapeSqlLiteral', () => {
  it('doubles a single quote', () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
  });

  it('doubles EVERY single quote, not just the first', () => {
    expect(escapeSqlLiteral("a'b'c")).toBe("a''b''c");
  });

  it('neutralises a predicate-breakout attempt from an agent-supplied language filter', () => {
    const hostile = "ts' OR 1=1 --";
    const predicate = `language = '${escapeSqlLiteral(hostile)}'`;
    expect(predicate).toBe("language = 'ts'' OR 1=1 --'");
    // The literal stays ONE literal: no unescaped quote can close it early.
    expect(predicate.match(/(?<!')'(?!')/g)).toHaveLength(2);
  });

  it('leaves a clean value untouched and never throws on empty input', () => {
    expect(escapeSqlLiteral('typescript')).toBe('typescript');
    expect(escapeSqlLiteral('')).toBe('');
  });

  it('leaves a backslash literal and still doubles an adjacent quote (no backslash-escape breakout)', () => {
    // A lone backslash is a LITERAL backslash — DataFusion/LanceDB SQL has no
    // backslash string-escape, so it must pass through unchanged.
    expect(escapeSqlLiteral('a\\b')).toBe('a\\b');
    // The security-relevant case: a backslash immediately before a quote must
    // NOT be treated as a MySQL-style `\'` escape. The quote is still doubled,
    // so a `\'`-prefixed payload cannot close the surrounding literal early.
    expect(escapeSqlLiteral("ts\\' OR 1=1 --")).toBe("ts\\'' OR 1=1 --");
  });
});
