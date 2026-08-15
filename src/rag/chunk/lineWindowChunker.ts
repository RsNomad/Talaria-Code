import type { ChunkWithoutHeader } from './types';

/**
 * Sliding-window fallback chunker for unsupported languages / whenever AST
 * chunking isn't available (how-to §3: "~40 lines with ~10 lines (≈25%)
 * overlap"). No `symbolPath` — there's no AST to derive one from;
 * `chunker.ts` applies a lighter heuristic on top of these chunks.
 */
export function chunkByLines(
  contents: string,
  windowLines = 40,
  overlapLines = 10,
): ChunkWithoutHeader[] {
  if (contents.trim().length === 0) return [];

  const lines = contents.split('\n');
  // AU-33: a trailing newline (`"a\nb\n"`) makes `split('\n')` emit a
  // phantom trailing '' element — that's not a real line, just where the
  // string ended. Drop it so `endLine` never points one line past EOF.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const step = Math.max(1, windowLines - overlapLines);
  const chunks: ChunkWithoutHeader[] = [];

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + windowLines, lines.length);
    const content = lines.slice(start, end).join('\n');
    if (content.trim().length > 0) {
      chunks.push({ content, startLine: start, endLine: end - 1 });
    }
    if (end >= lines.length) break;
  }

  return chunks;
}
