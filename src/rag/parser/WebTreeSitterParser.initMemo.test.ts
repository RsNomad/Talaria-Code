import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TST-02 (WS-TD): the `Parser.init()` memo seam. Lives in its OWN file so the
 * module-level DEFAULT memo is exercised on a fresh module instance (vitest
 * isolates each test file's module graph) — the shared-singleton pin below is
 * the ONLY test anywhere that uses the default, so it can never be polluted
 * by, or pollute, another test regardless of order.
 *
 * Minimal `web-tree-sitter` stand-in (grounded against the installed
 * `web-tree-sitter.d.ts`: `Parser` = `constructor()` + `setLanguage()`/
 * `parse()`/`delete()` + `static init()`; `Tree` = `rootNode` + `delete()`).
 * Everything the factory needs is defined INSIDE it — `vi.mock` factories are
 * hoisted above every top-level binding.
 */
vi.mock('web-tree-sitter', () => {
  class FakeTree {
    readonly rootNode: {
      type: string;
      text: string;
      startIndex: number;
      endIndex: number;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      children: never[];
      parent: null;
    };
    constructor(text: string) {
      this.rootNode = {
        type: 'program',
        text,
        startIndex: 0,
        endIndex: text.length,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: text.length },
        children: [],
        parent: null,
      };
    }
    delete(): void {}
  }
  class FakeParser {
    static init = vi.fn(async (): Promise<void> => undefined);
    setLanguage(): this {
      return this;
    }
    parse(text: string): FakeTree {
      return new FakeTree(text);
    }
    delete(): void {}
  }
  return {
    Parser: FakeParser,
    Language: { load: vi.fn(async () => ({ __fakeLanguage: true })) },
  };
});

import { Parser } from 'web-tree-sitter';

import { WebTreeSitterParser, createParserInitMemo } from './WebTreeSitterParser';

beforeEach(() => {
  vi.mocked(Parser.init).mockClear();
});

describe('Parser.init() memo — the DEFAULT is process-wide (characterization, TST-02)', () => {
  it('two instances constructed with NO memo override share ONE Parser.init() call (module-level singleton semantics)', async () => {
    const a = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });
    const b = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });

    const first = await a.parse('typescript', 'const a = 1;');
    const second = await b.parse('javascript', 'const b = 2;');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(vi.mocked(Parser.init)).toHaveBeenCalledTimes(1);
  });
});

describe('createParserInitMemo — the seam contract (TST-02)', () => {
  it('memoizes: two awaits of ONE memo → exactly one Parser.init() call', async () => {
    const memo = createParserInitMemo();
    await memo();
    await memo();
    expect(vi.mocked(Parser.init)).toHaveBeenCalledTimes(1);
  });

  it('two memos are independent: each performs its own Parser.init()', async () => {
    const a = createParserInitMemo();
    const b = createParserInitMemo();
    await a();
    await b();
    expect(vi.mocked(Parser.init)).toHaveBeenCalledTimes(2);
  });

  it('AU-35 clear-on-reject: a rejected init is NOT memoized — the next call re-attempts and succeeds', async () => {
    vi.mocked(Parser.init).mockRejectedValueOnce(new Error('transient wasm init failure'));
    const memo = createParserInitMemo();
    await expect(memo()).rejects.toThrow('transient wasm init failure');
    await expect(memo()).resolves.toBeUndefined();
    expect(vi.mocked(Parser.init)).toHaveBeenCalledTimes(2);
  });
});
