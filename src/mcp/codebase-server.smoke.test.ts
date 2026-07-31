import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CODEBASE_SEARCH_TOOL_NAME } from './toolSchema';

/**
 * CF-22 / R3 / D4 — the build-blind-boundary smoke test.
 *
 * Everything else in this suite exercises `codebase-server.ts` (or its
 * factored-out `codebaseSearchHandler.ts`) as TypeScript, transformed by
 * vitest's own loader. That proves the SOURCE is correct but is structurally
 * blind to defects introduced by `esbuild.js`'s bundling of the standalone
 * `dist/mcp/codebase-server.js` entrypoint — a real one shipped once:
 * `import.meta.url` collapsing to `{}` under esbuild's CJS output silently
 * broke the whole bundled MCP server while every unit test and `tsc` stayed
 * green (the source under test never went through esbuild at all). The only
 * genuine proof is running the BUILT artifact under a real `node`, exactly
 * as Hermes spawns it (`node dist/mcp/codebase-server.js`, how-to §7.1).
 *
 * `beforeAll` rebuilds the host bundle before spawning it, so this file is
 * HERMETIC — it cannot pass on a stale or hand-broken `dist/` even when run
 * standalone (`vitest run src/mcp/codebase-server.smoke.test.ts`) outside
 * `npm test`'s new `pretest` rebuild (`package.json`).
 *
 * Runs headless, with no network and no model backend, because:
 *  - the child requires exactly `HERMES_INDEX_DIR` / `HERMES_EMBED_ENDPOINT`
 *    / `EMBED_MODEL` (else it logs and exits 1 before serving — see
 *    `codebase-server.ts`'s env-contract guard) — an intentionally
 *    throwaway temp dir and an unreachable loopback port satisfy that
 *    without touching anything real;
 *  - `LanceDBStore.init()` against an empty, freshly created directory is
 *    non-throwing (`openTableIfExists` swallows the "no table yet" case and
 *    leaves `this.table` `undefined` — see `LanceDBStore.ts`);
 *  - `HttpEmbedder` only ever fetches inside `embed()`, never during
 *    construction or `initialize` — so `client.connect()` (which performs
 *    the full MCP `initialize` handshake and resolves only on a valid
 *    response) settles with zero network activity.
 * That means the built artifact's process bootstrap, native-module
 * resolution (`@lancedb/lancedb`, externalized by `esbuild.js`), and tool
 * registration are all genuinely exercised — not the network-dependent
 * search path, which is covered elsewhere (`search.test.ts`,
 * `codebaseSearchHandler.test.ts`, `LanceDBStore.test.ts`).
 *
 * KEEP-LIST: `codebase_search` / `hermes-codebase` / the three `HERMES_*` /
 * `EMBED_MODEL` env var names are the real, frozen contract — do not rename
 * here without updating `codebase-server.ts` first.
 *
 * Non-vacuity was hand-verified before this file was committed: a temporary
 * `throw new Error('smoke-break')` at the top of `codebase-server.ts`'s
 * `main()`, rebuilt and run against this exact test, made `client.connect()`
 * reject (the child exits before the transport ever completes `initialize`)
 * — i.e. this test genuinely fails on a broken bundle, not just a source
 * edit `tsc` would already have caught. The edit was reverted and the bundle
 * rebuilt clean immediately after. See the commit body / `w4-t1-report.md`
 * for the full transcript.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const distEntry = path.join(repoRoot, 'dist', 'mcp', 'codebase-server.js');

describe('codebase-server build smoke (CF-22 / D4)', () => {
  let indexDir: string;

  beforeAll(() => {
    // Rebuild BOTH esbuild entry points (host + this MCP child share one
    // `esbuild.js` invocation) so the artifact under test can never be
    // stale, regardless of how this file is invoked.
    execFileSync(process.execPath, ['esbuild.js'], { cwd: repoRoot, stdio: 'inherit' });
    indexDir = mkdtempSync(path.join(os.tmpdir(), 'talaria-mcp-smoke-'));
  }, 60_000);

  afterAll(() => {
    if (indexDir) rmSync(indexDir, { recursive: true, force: true });
  });

  it(
    'spawns the built dist child under real node, completes MCP initialize, and advertises codebase_search',
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [distEntry],
        env: {
          HERMES_INDEX_DIR: indexDir,
          // Unreachable on purpose (port 1, loopback-only) — the happy-path
          // search flow is exercised elsewhere; this test only needs
          // `initialize` to resolve without any real network activity.
          HERMES_EMBED_ENDPOINT: 'http://127.0.0.1:1',
          EMBED_MODEL: 'smoke-model',
        },
      });

      const client = new Client({ name: 'talaria-build-smoke', version: '0.0.0' });
      try {
        // Performs the actual MCP `initialize` handshake over stdio;
        // resolves only once the built child returns a valid response.
        await client.connect(transport);

        expect(client.getServerVersion()?.name).toBe('hermes-codebase');

        const { tools } = await client.listTools();
        expect(tools.some((tool) => tool.name === CODEBASE_SEARCH_TOOL_NAME)).toBe(true);
      } finally {
        // Best-effort: if `connect()` itself rejected, there is nothing
        // live to close, and a secondary close failure must never mask the
        // original assertion/connection failure above.
        await client.close().catch(() => undefined);
      }
    },
    30_000,
  );
});
