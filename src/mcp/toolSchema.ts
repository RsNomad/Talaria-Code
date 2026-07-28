import { z } from 'zod';

/**
 * `codebase_search` tool contract — pinned exactly to the how-to §7.2 wire
 * schema. `codebaseSearchInputShape` is the raw zod-shape object the MCP TS
 * SDK's `registerTool` (stable v1.x, `@modelcontextprotocol/sdk`) expects
 * for `inputSchema` — a plain `{ key: ZodType }` record, NOT wrapped in
 * `z.object(...)` (the SDK wraps it internally; verified against the v1.x
 * branch docs via Context7: `server.registerTool('name', { inputSchema: {
 * weightKg: z.number(), ... } }, handler)`).
 */
export const CODEBASE_SEARCH_TOOL_NAME = 'codebase_search';

export const CODEBASE_SEARCH_DESCRIPTION =
  'Hybrid (semantic vector + keyword) search over the indexed workspace. ' +
  'Returns the top-k most relevant code chunks with file path and line range. ' +
  "Use for conceptual questions ('where is auth refresh handled?', 'how do we retry uploads?'). " +
  'For exact strings/symbols, prefer ripgrep/search_files.';

/**
 * V-21 pathGlob amplifier caps (tier2-remediation-architecture.md §8): an
 * uncapped `path_globs` array is a cheap CPU amplifier — each entry compiles
 * to its own regex (`compilePathGlobs`), tested against every candidate hit.
 * 16 entries / 256 chars each is generously above the how-to §7.2 examples
 * (`src/**`, `!**\/*.test.*` — slash escaped only to keep this example from
 * prematurely closing this very block comment, same gotcha `pathGlob.ts`'s
 * header documents) while bounding the worst case. The regex-engine
 * redesign for pathologically degenerate globs stays deferred (Minor: needs
 * BOTH a degenerate glob AND a path repeating its literal; workspace paths
 * aren't attacker-chosen).
 */
const MAX_PATH_GLOBS = 16;
const MAX_PATH_GLOB_LENGTH = 256;

export const codebaseSearchInputShape = {
  query: z.string().describe('Natural-language or code query'),
  k: z.number().int().min(1).max(50).default(10),
  path_globs: z
    .array(z.string().max(MAX_PATH_GLOB_LENGTH))
    .max(MAX_PATH_GLOBS)
    .optional()
    .describe("Optional path filters, e.g. ['src/**','!**/*.test.*']"),
  language: z.string().optional().describe("Optional language filter, e.g. 'typescript'"),
};

export const codebaseSearchInputSchema = z.object(codebaseSearchInputShape);

export type CodebaseSearchInput = z.infer<typeof codebaseSearchInputSchema>;

/** Wire-form JSON Schema mirror of the shape above (how-to §7.2), kept as a
 * plain object so it can be asserted against in tests without depending on
 * zod's own JSON Schema conversion (which varies by zod version). */
export const CODEBASE_SEARCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Natural-language or code query' },
    k: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
    path_globs: {
      type: 'array',
      items: { type: 'string', maxLength: MAX_PATH_GLOB_LENGTH },
      maxItems: MAX_PATH_GLOBS,
      description: 'Optional path filters',
    },
    language: { type: 'string', description: 'Optional language filter' },
  },
  required: ['query'],
} as const;
