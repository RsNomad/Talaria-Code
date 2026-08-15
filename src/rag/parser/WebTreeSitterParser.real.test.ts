import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { chunkFile } from '../chunker';
import { GRAMMAR_FILE_BY_LANGUAGE, WebTreeSitterParser } from './WebTreeSitterParser';

/**
 * TB-1 / AU-2 / ADR-2 — the permanent no-mock load gate.
 *
 * Unlike `WebTreeSitterParser.test.ts` (which mocks `web-tree-sitter`
 * wholesale to unit-test the caching/lifecycle logic in isolation — and so
 * stays green even if the REAL package can never load a single grammar),
 * this file imports the real `web-tree-sitter` package and actually
 * `Language.load()`s every bundled `.wasm` grammar from the repo's own
 * `node_modules/tree-sitter-wasms/out`, then parses a real snippet with
 * each. This IS the reproduction harness for AU-2 (V3/V4 in
 * `docs_claude/audit-fix-architecture.md`): at HEAD, with
 * `web-tree-sitter@0.26.11` installed against the bundled
 * `tree-sitter-wasms@0.1.13` grammars, `Language.load()` throws an
 * empty-message `Error` for every one of them — the bundled wasm's legacy
 * `"dylink"` custom section vs 0.26's `dylink.0`-only loader
 * (`failIf(name2 !== "dylink.0")`, upstream tree-sitter#5171). `loadLanguage`
 * swallows that error and caches `null`, so `chunkFile` silently falls back
 * to line-window chunking for every code file, on every platform — AST
 * chunking has never run in production.
 *
 * The fix (ADR-2) is an EXACT pin of `web-tree-sitter` to `0.25.10` — a
 * matched ABI pair with `tree-sitter-wasms@0.1.13`, not a semver
 * relationship. Any future bump of either package must move both together
 * back through this gate.
 */

const GRAMMARS_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out');

const SNIPPET_BY_LANGUAGE: Record<string, string> = {
  typescript: 'function add(a: number, b: number): number {\n  return a + b;\n}\n',
  typescriptreact: 'function App() {\n  return <div>hi</div>;\n}\n',
  javascript: 'function add(a, b) {\n  return a + b;\n}\n',
  javascriptreact: 'function App() {\n  return <div>hi</div>;\n}\n',
  python: 'def add(a, b):\n    return a + b\n',
  go: 'package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n',
  rust: 'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n',
  java: 'class Foo {\n    int add(int a, int b) {\n        return a + b;\n    }\n}\n',
  csharp: 'class Foo {\n    int Add(int a, int b) {\n        return a + b;\n    }\n}\n',
  c: 'int add(int a, int b) {\n  return a + b;\n}\n',
  cpp: 'int add(int a, int b) {\n  return a + b;\n}\n',
};

describe('WebTreeSitterParser — real load smoke test (no mocks, TB-1/AU-2/ADR-2)', () => {
  const languageIds = Object.keys(GRAMMAR_FILE_BY_LANGUAGE);

  // A data-integrity guard, not part of the AU-2 reproduction itself: keeps
  // this test file honest against future GRAMMAR_FILE_BY_LANGUAGE edits — a
  // languageId added there with no matching snippet here would otherwise
  // silently never get exercised below.
  it('has exactly one snippet per GRAMMAR_FILE_BY_LANGUAGE entry', () => {
    expect([...Object.keys(SNIPPET_BY_LANGUAGE)].sort()).toEqual([...languageIds].sort());
  });

  it.each(languageIds)('loads and parses the real bundled grammar for %s', async (languageId) => {
    const parser = new WebTreeSitterParser({ grammarsDir: GRAMMARS_DIR });
    const snippet = SNIPPET_BY_LANGUAGE[languageId];
    expect(snippet).toBeDefined();

    const root = await parser.parse(languageId, snippet as string);

    expect(root).toBeDefined();
    expect(typeof root?.type).toBe('string');
    expect(root?.type.length).toBeGreaterThan(0);
    // `hasError` isn't part of our narrow `SyntaxNodeLike` type (kept
    // structural on purpose — see `chunk/types.ts`) but IS present on the
    // real `web-tree-sitter` `Node` this object actually is at runtime; a
    // genuine parse of well-formed source should never set it.
    expect((root as unknown as { hasError?: boolean } | undefined)?.hasError).toBe(false);

    parser.dispose();
  });

  it('chunkFile end-to-end: a TS file with two functions yields AST (symbol-bearing) chunks, not the line-window fallback', async () => {
    const parser = new WebTreeSitterParser({ grammarsDir: GRAMMARS_DIR });
    const contents = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function subtract(a: number, b: number): number {',
      '  return a - b;',
      '}',
      '',
    ].join('\n');

    const chunks = await chunkFile({
      relPath: 'math.ts',
      contents,
      languageId: 'typescript',
      extension: 'ts',
      parser,
      // Deliberately tiny: forces every node (including the whole-file
      // root) past the "fits as-is" branch in `astChunker.ts`'s
      // `maybeYieldChunk`, so chunking recurses down to the individual
      // function nodes instead of returning the whole file as one chunk —
      // the only way to prove `buildSymbolPath` (and therefore the REAL AST
      // path, not `chunkByLines`, which never sets `symbolPath`) actually
      // ran.
      maxChunkTokens: 1,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const symbolNames = chunks.flatMap((c) => c.symbolPath ?? []);
    expect(symbolNames).toContain('add');
    expect(symbolNames).toContain('subtract');

    parser.dispose();
  });
});
