import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { HttpEmbedder } from '../rag/embedder';
import { LanceDBStore } from '../rag/store/LanceDBStore';
import { makeCodebaseSearchHandler } from './codebaseSearchHandler';
import { runCodebaseSearch } from './search';
import {
  CODEBASE_SEARCH_DESCRIPTION,
  CODEBASE_SEARCH_TOOL_NAME,
  codebaseSearchInputShape,
} from './toolSchema';

/**
 * Standalone stdio MCP server Hermes spawns directly
 * (`node dist/mcp/codebase-server.js`, how-to §7.1). Reads the index the
 * extension host already built via `createIndexer` — this process never
 * writes to it and never touches VS Code APIs (spec: "the MCP process only
 * queries").
 *
 * READ-ONLY TOOL SURFACE (F3 guard): this server intentionally exposes
 * exactly one tool, `codebase_search`, and no write-capable tool. Hermes
 * executes MCP tools without consulting the extension's edit-approval seam,
 * so any file-writing tool added here would be an ungated mutation path.
 * Keep the surface read-only — `codebase-server.test.ts` locks this
 * invariant and must be updated deliberately if the tool set ever grows.
 *
 * Env contract (frozen, spec Zone RG):
 *   - HERMES_INDEX_DIR      — absolute path to `.hermes/index`
 *   - HERMES_EMBED_ENDPOINT — runner base URL, e.g. http://127.0.0.1:11434
 *   - EMBED_MODEL           — e.g. qwen3-embedding:0.6b
 *   - HERMES_EMBED_DIMS     — optional, defaults to 0 (D-1: "let the server
 *                             decide" — never a silent nonzero default; see
 *                             `embedder.ts`'s `buildEmbeddingsRequestBody`)
 */
async function main(): Promise<void> {
  const indexDir = process.env.HERMES_INDEX_DIR;
  const embedEndpoint = process.env.HERMES_EMBED_ENDPOINT;
  const embedModel = process.env.EMBED_MODEL;
  const dims = process.env.HERMES_EMBED_DIMS ? Number(process.env.HERMES_EMBED_DIMS) : 0;

  if (!indexDir || !embedEndpoint || !embedModel) {
    console.error(
      'hermes-codebase: missing required env (HERMES_INDEX_DIR, HERMES_EMBED_ENDPOINT, EMBED_MODEL)',
    );
    process.exitCode = 1;
    return;
  }

  const embedder = new HttpEmbedder({ endpoint: embedEndpoint, model: embedModel, dimensions: dims });
  const store = new LanceDBStore(indexDir);
  await store.init();

  const server = new McpServer({ name: 'hermes-codebase', version: '1.0.0' });

  server.registerTool(
    CODEBASE_SEARCH_TOOL_NAME,
    {
      title: 'Semantic codebase search',
      description: CODEBASE_SEARCH_DESCRIPTION,
      inputSchema: codebaseSearchInputShape,
    },
    makeCodebaseSearchHandler({
      runSearch: (args) =>
        runCodebaseSearch(
          { embedder, store },
          { query: args.query, k: args.k ?? 10, path_globs: args.path_globs, language: args.language },
        ),
      log: (line) => console.error(line),
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('hermes-codebase MCP server running on stdio');
}

main().catch((err) => {
  console.error('hermes-codebase: fatal error', err);
  process.exitCode = 1;
});
