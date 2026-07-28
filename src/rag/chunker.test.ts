import { describe, expect, it } from 'vitest';

import { chunkFile } from './chunker';
import type { CodeParser } from './parser/CodeParser';
import type { SyntaxNodeLike } from './chunk/types';
import { must } from '../testing/must';

function mkFakeRoot(text: string): SyntaxNodeLike {
  return {
    type: 'program',
    text,
    startIndex: 0,
    endIndex: text.length,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: text.split('\n').length - 1, column: 0 },
    children: [],
    parent: null,
  };
}

describe('chunkFile', () => {
  it('falls back to line-window chunking when no parser is given', async () => {
    const contents = 'plain text with no function-like patterns\nsecond line';
    const chunks = await chunkFile({
      relPath: 'notes.txt',
      contents,
      languageId: 'plaintext',
      extension: 'txt',
    });

    expect(chunks).toHaveLength(1);
    expect(must(chunks[0]).headeredContent).toBe(`// file: notes.txt\n${contents}`);
  });

  it('uses the parser when it supports the language, and prepends a header with the derived symbolPath', async () => {
    const contents = 'const x = 1;';
    const parser: CodeParser = {
      supports: (id) => id === 'typescript',
      parse: async () => mkFakeRoot(contents),
    };

    const chunks = await chunkFile({
      relPath: 'src/a.ts',
      contents,
      languageId: 'typescript',
      extension: 'ts',
      parser,
      maxChunkTokens: 512,
    });

    expect(chunks).toHaveLength(1);
    expect(must(chunks[0]).headeredContent).toBe(`// file: src/a.ts\n${contents}`);
  });

  it('falls back to line windows when the parser throws', async () => {
    const contents = 'function doThing(x) {\n  return x;\n}';
    const parser: CodeParser = {
      supports: () => true,
      parse: async () => {
        throw new Error('grammar failed to load');
      },
    };

    const chunks = await chunkFile({
      relPath: 'src/b.ts',
      contents,
      languageId: 'typescript',
      extension: 'ts',
      parser,
    });

    expect(chunks).toHaveLength(1);
    // Line-window fallback chunks have no AST symbolPath, so the regex
    // heuristic on the chunk's first line should pick up "doThing".
    expect(must(chunks[0]).headeredContent).toBe(`// file: src/b.ts › doThing\n${contents}`);
  });

  it('skips the parser when it does not support the language', async () => {
    const contents = 'echo hi there';
    const parser: CodeParser = {
      supports: () => false,
      parse: async () => {
        throw new Error('should never be called');
      },
    };

    const chunks = await chunkFile({
      relPath: 'script.sh',
      contents,
      languageId: 'shellscript',
      extension: 'sh',
      parser,
    });

    expect(chunks).toHaveLength(1);
    expect(must(chunks[0]).headeredContent).toBe(`# file: script.sh\n${contents}`);
  });

  it('returns [] for whitespace-only content', async () => {
    const chunks = await chunkFile({
      relPath: 'empty.ts',
      contents: '   \n  \n',
      languageId: 'typescript',
      extension: 'ts',
    });
    expect(chunks).toEqual([]);
  });
});
