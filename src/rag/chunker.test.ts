import { describe, expect, it, vi } from 'vitest';

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
      logger: () => {},
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
      logger: () => {},
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
      logger: () => {},
    });

    expect(chunks).toHaveLength(1);
    // Line-window fallback chunks have no AST symbolPath, so the regex
    // heuristic on the chunk's first line should pick up "doThing".
    expect(must(chunks[0]).headeredContent).toBe(`// file: src/b.ts › doThing\n${contents}`);
  });

  // WS-F6 F6-6 (FI-20/FI-31): at HEAD this AST-failure branch logged via
  // `console.error(\`... for ${opts.relPath} ...\`, err)` — the raw error
  // object AND the path, straight to the process's stderr. The fix routes it
  // through the injected `opts.logger` instead, carrying `err.name` ONLY —
  // mirrors `indexer.ts`'s `readManifest`/`readMeta` `(${err.name})` idiom.
  it('RED: logs err.name only through the injected logger when the parser throws — never the path, never the raw error, never console.error', async () => {
    const contents = 'function doThing(x) {\n  return x;\n}';
    const parser: CodeParser = {
      supports: () => true,
      parse: async () => {
        throw new RangeError('grammar failed to load: secret-looking detail that must never leak');
      },
    };
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await chunkFile({
      relPath: 'src/very/secret/path/b.ts',
      contents,
      languageId: 'typescript',
      extension: 'ts',
      parser,
      logger: (line) => logs.push(line),
    });

    errorSpy.mockRestore();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('RangeError');
    expect(logs[0]).not.toContain('src/very/secret/path/b.ts');
    expect(logs[0]).not.toContain('secret-looking detail');
    expect(errorSpy).not.toHaveBeenCalled();
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
      logger: () => {},
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
      logger: () => {},
    });
    expect(chunks).toEqual([]);
  });
});
