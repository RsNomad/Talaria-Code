import type { ChunkWithoutHeader } from './chunk/types';
import { chunkAst } from './chunk/astChunker';
import { chunkByLines } from './chunk/lineWindowChunker';
import { buildHeaderLine, prependHeader } from './header';
import type { CodeParser } from './parser/CodeParser';

export interface ChunkFileOptions {
  /** Path relative to the workspace root, POSIX-separated. */
  relPath: string;
  contents: string;
  /** VS Code-style language id (e.g. `typescript`), used to pick the parser grammar. */
  languageId: string;
  /** File extension without the dot, used for the header's comment token. */
  extension: string;
  /** Omit to force the line-window fallback (unsupported language, or the
   * caller already knows AST chunking isn't applicable). */
  parser?: CodeParser;
  maxChunkTokens?: number;
}

export interface FileChunk extends ChunkWithoutHeader {
  /** Header-prepended text — this is what actually gets embedded. */
  headeredContent: string;
}

const DEFAULT_MAX_CHUNK_TOKENS = 512;
const LINE_WINDOW_SIZE = 40;
const LINE_WINDOW_OVERLAP = 10;

/**
 * Chunks one file's contents into retrieval units: AST-aware (function/
 * class granularity, how-to §3) when a parser is supplied and supports the
 * language, else a 40-line/10-line-overlap sliding window. Every chunk gets
 * a `path › symbol` header prepended before embedding.
 */
export async function chunkFile(opts: ChunkFileOptions): Promise<FileChunk[]> {
  const maxChunkTokens = opts.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;

  let rawChunks: ChunkWithoutHeader[] | undefined;

  if (opts.parser?.supports(opts.languageId)) {
    try {
      const root = await opts.parser.parse(opts.languageId, opts.contents);
      if (root) {
        rawChunks = chunkAst(root, opts.contents, maxChunkTokens);
      }
    } catch (err) {
      console.error(
        `hermes-codebase: AST chunking failed for ${opts.relPath}, falling back to line windows`,
        err,
      );
      rawChunks = undefined;
    }
  }

  if (!rawChunks || rawChunks.length === 0) {
    rawChunks = chunkByLines(opts.contents, LINE_WINDOW_SIZE, LINE_WINDOW_OVERLAP);
  }

  return rawChunks
    .filter((c) => c.content.trim().length > 0)
    .map((c) => {
      const symbolPath = c.symbolPath ?? extractSymbolPathHeuristic(c.content);
      const headerLine = buildHeaderLine(opts.relPath, symbolPath, opts.extension);
      return {
        ...c,
        headeredContent: prependHeader(headerLine, c.content),
      };
    });
}

/**
 * Best-effort single-name heuristic pulled from a chunk's first non-empty
 * line (e.g. `function refreshToken(...) {` → `['refreshToken']`), used
 * only when there's no AST-derived `symbolPath` (line-window chunks have no
 * tree at all). Not a real symbol resolver — good enough to make the header
 * breadcrumb useful without an AST.
 */
function extractSymbolPathHeuristic(content: string): string[] {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return [];
  const match = firstLine.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  const name = match?.[1];
  return name !== undefined ? [name] : [];
}
