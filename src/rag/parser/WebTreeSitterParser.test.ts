import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A hand-rolled stand-in for `web-tree-sitter`'s `Parser`/`Tree`/`Language`
 * (grounded against the installed `node_modules/web-tree-sitter`
 * `web-tree-sitter.d.ts`, v0.26.10 — `Parser` is a plain `constructor()` +
 * `setLanguage()`/`parse()`/`delete()`; `Tree` has `rootNode` + `delete()`).
 * Everything the mock factory and the tests both need to see lives inside
 * one `vi.hoisted()` block, since `vi.mock` factories are hoisted above
 * regular module code and can only close over hoisted state.
 */
const { FakeParser, trackedParsers, trackedTrees } = vi.hoisted(() => {
  interface FakeNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: FakeNode[];
    parent: FakeNode | null;
  }

  class FakeTree {
    deleted = false;
    readonly rootNode: FakeNode;
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
    delete(): void {
      this.deleted = true;
    }
  }

  const trackedParsers: FakeParserImpl[] = [];
  const trackedTrees: FakeTree[] = [];

  class FakeParserImpl {
    deleted = false;
    readonly setLanguageCalls: unknown[] = [];
    constructor() {
      trackedParsers.push(this);
    }
    setLanguage(language: unknown): this {
      this.setLanguageCalls.push(language);
      return this;
    }
    parse(text: string): FakeTree {
      const tree = new FakeTree(text);
      trackedTrees.push(tree);
      return tree;
    }
    delete(): void {
      this.deleted = true;
    }
  }

  return { FakeParser: FakeParserImpl, trackedParsers, trackedTrees };
});

vi.mock('web-tree-sitter', () => ({
  Parser: Object.assign(FakeParser, { init: vi.fn().mockResolvedValue(undefined) }),
  Language: { load: vi.fn().mockResolvedValue({ __fakeLanguage: true }) },
}));

import { Parser } from 'web-tree-sitter';

import { WebTreeSitterParser, resetParserInitForTests } from './WebTreeSitterParser';

beforeEach(() => {
  trackedParsers.length = 0;
  trackedTrees.length = 0;
  // The `parserInitPromise` memo is module-level (shared across every
  // `WebTreeSitterParser` instance, mirroring the real singleton
  // `Parser.init()` semantics), so it must be reset between tests the same
  // way `resetHermesBinCache` resets `resolveHermes.ts`'s module cache.
  resetParserInitForTests();
  vi.mocked(Parser.init).mockClear();
});

describe('WebTreeSitterParser', () => {
  it('reuses the same Parser instance across repeated parse() calls for the same language', async () => {
    const parser = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });

    await parser.parse('typescript', 'const a = 1;');
    await parser.parse('typescript', 'const b = 2;');

    // Today: a fresh `new Parser()` is constructed on every call, so this
    // would be 2.
    expect(trackedParsers).toHaveLength(1);
  });

  it('caches a separate Parser per language, reusing each within its own language', async () => {
    const parser = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });

    await parser.parse('typescript', 'const a = 1;');
    await parser.parse('javascript', 'const b = 2;');
    await parser.parse('typescript', 'const c = 3;');

    expect(trackedParsers).toHaveLength(2);
  });

  it('keeps a parsed tree alive through consumption, and only frees it once the next parse() call starts', async () => {
    const parser = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });

    const root1 = await parser.parse('typescript', 'const a = 1;');
    const tree1 = trackedTrees[0];
    expect(tree1).toBeDefined();

    // Not deleted yet: the real caller (`chunker.ts`'s `chunkFile`)
    // synchronously hands `root1` to `chunkAst` right after `parse()`
    // resolves — a premature delete here would free memory `chunkAst` is
    // still reading. Prove the node is still genuinely readable.
    expect(tree1?.deleted).toBe(false);
    expect(root1?.text).toBe('const a = 1;');

    await parser.parse('typescript', 'const b = 2;');

    // Only *after* call 1's tree was handed out and (per the assertions
    // above) proven still-readable is it freed — never before.
    expect(tree1?.deleted).toBe(true);
    const tree2 = trackedTrees[1];
    expect(tree2?.deleted).toBe(false);
  });

  // AU-35 (TA-9): a transient `Parser.init()` failure (FS/wasm hiccup) must
  // not poison the module-level memo forever. `loadLanguage` has its OWN
  // per-languageId null-cache-on-throw (out of TA-9's scope — that's the
  // separate AU-2/TB-1 concern), so the FIRST call's languageId can never
  // observe a retry by itself: its `languageCache` entry is permanently
  // `null` after one failure regardless of the init memo. Using a SECOND,
  // never-before-attempted languageId isolates exactly the behavior this
  // task fixes: does `ensureParserInit()` retry, or does it replay the
  // cached rejection forever?
  it('RED: a Parser.init() rejection does not poison future parses — a later parse() for a different language re-attempts init', async () => {
    const initMock = vi.mocked(Parser.init);
    initMock.mockRejectedValueOnce(new Error('transient wasm init failure'));

    const parser = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await parser.parse('typescript', 'const a = 1;');
    expect(first).toBeUndefined(); // grammar load failed because init rejected

    const second = await parser.parse('javascript', 'const b = 2;');

    errorSpy.mockRestore();

    // Fails at HEAD: the module-level `parserInitPromise` cached the
    // rejection forever, so this SECOND call's `ensureParserInit()` reuses
    // the same dead rejected promise instead of calling `Parser.init()`
    // again — `initMock` would show only 1 call, and `second` would stay
    // `undefined` even though the transient failure has "cleared".
    expect(initMock).toHaveBeenCalledTimes(2);
    expect(second).toBeDefined();
  });

  it('RED: dispose() frees the cached parser and pending tree, and a later parse() call re-initializes cleanly rather than crashing', async () => {
    const parser = new WebTreeSitterParser({ grammarsDir: '/fake-grammars' });

    await parser.parse('typescript', 'const a = 1;');
    const cachedParser = trackedParsers[0];
    const tree = trackedTrees[0];
    expect(cachedParser?.deleted).toBe(false);
    expect(tree?.deleted).toBe(false);

    parser.dispose();

    // Fails at HEAD: `dispose()` does not exist on `WebTreeSitterParser`.
    expect(cachedParser?.deleted).toBe(true);
    expect(tree?.deleted).toBe(true);

    // Safe post-dispose state: not a crash, and re-initializes rather than
    // reusing the now-deleted handle — a fresh `Parser` is constructed.
    const after = await parser.parse('typescript', 'const b = 2;');
    expect(after).toBeDefined();
    expect(trackedParsers).toHaveLength(2);
    expect(trackedParsers[1]?.deleted).toBe(false);
  });
});
