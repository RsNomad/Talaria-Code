/*
 * W2 Bucket-1 F3 guard — the codebase MCP server's tool surface must stay
 * READ-ONLY.
 *
 * Hermes executes MCP tools without ever consulting our `request_permission`
 * seam (research brief Part 1; contract-map C10), so a write-capable tool
 * registered on this server would be an ungated file-mutation path. The
 * extension's "the MCP-write bypass does not apply to OUR server" claim is
 * true only while this server registers read-only tools — this test locks
 * that invariant and fails loudly if a write-capable tool is ever added.
 *
 * `codebase-server.ts` is a run-on-import stdio entrypoint (it calls `main()`
 * unconditionally at module scope and connects a transport), so the guard
 * enumerates tool registrations statically from its source instead of
 * importing it. The `codebase_search` handler itself lives in the sibling
 * `codebaseSearchHandler.ts` module precisely so the D-3 tests below can
 * import the real factory without ever importing (and therefore running)
 * this entrypoint.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeCodebaseSearchHandler } from './codebaseSearchHandler';
import { CODEBASE_SEARCH_TOOL_NAME } from './toolSchema';
import { must } from '../testing/must';

/**
 * First-argument tokens of every tool registration in the given source —
 * covers both spellings the MCP TS SDK v1.x offers (`server.registerTool(...)`
 * and the legacy `server.tool(...)`).
 */
function findToolRegistrations(source: string): string[] {
  const registration = /\.\s*(?:registerTool|tool)\s*\(\s*([^,)]+)/g;
  return [...source.matchAll(registration)].map((m) => must(m[1]).trim());
}

/** Tool-name shapes that suggest a mutation capability. */
const WRITE_CAPABLE =
  /write|edit|patch|create|delete|remove|move|rename|append|mkdir|exec|run|apply|update|insert/i;

const serverSource = readFileSync(
  new URL('./codebase-server.ts', import.meta.url),
  'utf8',
);

describe('codebase-server read-only tool surface (F3 guard)', () => {
  it('scanner detects write-capable registrations (self-check)', () => {
    const hostile = [
      'server.registerTool(CODEBASE_SEARCH_TOOL_NAME, cfg, handler);',
      "server.registerTool('write_file', cfg2, handler2);",
      'server.tool("apply_patch", handler3);',
    ].join('\n');
    expect(findToolRegistrations(hostile)).toEqual([
      'CODEBASE_SEARCH_TOOL_NAME',
      "'write_file'",
      '"apply_patch"',
    ]);
  });

  it('registers exactly one tool: codebase_search', () => {
    expect(findToolRegistrations(serverSource)).toEqual(['CODEBASE_SEARCH_TOOL_NAME']);
    expect(CODEBASE_SEARCH_TOOL_NAME).toBe('codebase_search');
  });

  it('the registered tool name is not write-capable', () => {
    expect(CODEBASE_SEARCH_TOOL_NAME).not.toMatch(WRITE_CAPABLE);
  });
});

describe('D-3: codebase_search never ships an exception to the model', () => {
  it('returns a FIXED failure string when the search throws, not the exception text', async () => {
    const handler = makeCodebaseSearchHandler({
      runSearch: async () => {
        throw new Error('LanceDB: /home/user/.hermes/index/chunks.lance is corrupt (SECRET_PATH)');
      },
    });

    const result = await handler({ query: 'x' });
    const text = result.content.map((c) => c.text).join('');
    expect(text).toBe('[codebase_search: error] search failed unexpectedly');
    expect(text).not.toContain('SECRET_PATH');
    expect(text).not.toContain('LanceDB');
  });

  it('still returns real hits on the happy path (non-vacuous)', async () => {
    // `id`/`score` are added to the fixture (absent from the brief's literal)
    // because the handler's real return type is the production `SearchHit`
    // (from `../rag/store/VectorStore`), which requires both — matching what
    // `runCodebaseSearch` actually produces in the registered handler.
    const handler = makeCodebaseSearchHandler({
      runSearch: async () => ({
        hits: [{ id: 'h1', path: 'a.ts', startLine: 1, endLine: 2, content: 'x', score: 1 }],
      }),
    });
    const result = await handler({ query: 'x' });
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('still returns the fixed failure string when the injected log itself throws', async () => {
    // A throwing `log` must not escape the catch and propagate to the SDK —
    // that would ship the logger's exception (or a wrapped copy of the
    // original detail) to the model, defeating the whole point of D-3.
    const handler = makeCodebaseSearchHandler({
      runSearch: async () => {
        throw new Error('LanceDB: /home/user/.hermes/index/chunks.lance is corrupt (SECRET_PATH)');
      },
      log: () => {
        throw new Error('logger is down');
      },
    });

    const result = await handler({ query: 'x' });
    const text = result.content.map((c) => c.text).join('');
    expect(text).toBe('[codebase_search: error] search failed unexpectedly');
    expect(text).not.toContain('SECRET_PATH');
    expect(text).not.toContain('logger is down');
  });
});
