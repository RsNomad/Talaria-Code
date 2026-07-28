/**
 * Minimal structural subset of `web-tree-sitter`'s `SyntaxNode` that our AST
 * chunker depends on. Keeping this as a narrow, hand-rolled interface
 * (rather than importing the real `web-tree-sitter` type) lets
 * `astChunker.ts` be unit-tested with plain object fixtures — no native/WASM
 * dependency required (spec: "keep pure logic testable without those deps").
 * `parser/WebTreeSitterParser.ts` is the only file that bridges a real
 * tree-sitter `SyntaxNode` into this shape.
 */
export interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: readonly SyntaxNodeLike[];
  readonly parent: SyntaxNodeLike | null;
}

/** A chunk before the retrieval header (`path › symbol`) is prepended. */
export interface ChunkWithoutHeader {
  content: string;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
  /** Ancestor breadcrumb (e.g. `['SessionManager', 'refreshToken']`) when
   * derived from an AST node; absent for line-window fallback chunks. */
  symbolPath?: string[];
}
