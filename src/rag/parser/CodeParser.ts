import type { SyntaxNodeLike } from '../chunk/types';

/**
 * Thin seam over `web-tree-sitter` so `chunker.ts`'s orchestration and
 * `astChunker.ts`'s pure logic never import the native/WASM parser
 * directly (spec: keep native deps behind an interface so pure logic is
 * testable without them).
 */
export interface CodeParser {
  /** True if this parser has (or can lazily load) a grammar for the language. */
  supports(languageId: string): boolean;
  /** Parses `contents` and returns the syntax tree root, or `undefined` if
   * the grammar isn't available / failed to load for this language. */
  parse(languageId: string, contents: string): Promise<SyntaxNodeLike | undefined>;
  /**
   * AU-35: frees any native/WASM handles this parser holds. Optional
   * because a `CodeParser` that owns no native resources (e.g. a test
   * stand-in) has nothing to free.
   */
  dispose?(): void;
}
