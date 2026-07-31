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

import { WebTreeSitterParser } from './WebTreeSitterParser';

beforeEach(() => {
  trackedParsers.length = 0;
  trackedTrees.length = 0;
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
});
