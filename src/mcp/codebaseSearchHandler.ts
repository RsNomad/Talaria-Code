import { IndexNotReadyError } from '../rag/store/LanceDBStore';
import type { SearchHit } from '../rag/store/VectorStore';
import { mintFrameNonce } from './lsp/frameSanitize';
import { frameLspResult } from './lsp/resultShaper';
import { formatHitAsText } from './search';
import type { CodebaseSearchInput } from './toolSchema';

/**
 * Args as delivered to `makeCodebaseSearchHandler`'s returned function.
 * Mirrors `CodebaseSearchInput` (the SDK's post-zod-parse, defaults-applied
 * shape) except `k` stays optional here: `codebase-server.test.ts` drives
 * this handler directly (the real seam, not a mock), bypassing the SDK's
 * schema parsing — so the defaulting that normally fills `k` never runs for
 * those calls, and the handler must tolerate its absence the same way
 * `runCodebaseSearch`'s own `input.k ?? 10` already does.
 */
export type CodebaseSearchArgs = Omit<CodebaseSearchInput, 'k'> & { k?: number };

/**
 * The `codebase_search` handler, as an injectable factory.
 *
 * Audit D-3: this used to be an inline closure with NO try/catch, so the MCP
 * SDK turned any thrown error into `createToolError(error.message)`
 * (`mcp.js:141`) and Hermes forwarded it to the model as
 * `{"error": <message>}` (`tools/mcp_tool.py:3947-3956`) — raw exception text,
 * including absolute paths, straight into the model's context. LIB's
 * `safeHandler` (`src/mcp/lsp/tools.ts:337-344`) has always returned a FIXED
 * string for exactly this reason; this brings the codebase server to parity.
 *
 * Lives in its own module — not `codebase-server.ts` — so
 * `codebase-server.test.ts` can import this factory directly without ever
 * importing `codebase-server.ts`. That file is a run-on-import stdio
 * entrypoint (`main()` executes unconditionally at module scope, exactly
 * like it did before this factory existed); importing it as a module would
 * run it. Splitting the pure factory out of the entrypoint solves that
 * structurally, with no runtime "am I the entry point" detection needed.
 */
export function makeCodebaseSearchHandler(deps: {
  runSearch: (args: CodebaseSearchArgs) => Promise<{ hits: SearchHit[] }>;
  log?: (line: string) => void;
}) {
  return async (args: CodebaseSearchArgs) => {
    try {
      const { hits } = await deps.runSearch(args);
      // V-21 (tier2-remediation-architecture.md §8): reuse the EXISTING
      // LSP-side envelope verbatim rather than inventing a second sanitizer —
      // one nonce per REQUEST, threaded into every hit's frame, so an
      // untrusted repo file can never forge the closing delimiter (it cannot
      // contain a nonce minted after the file was read).
      // Audit-2 CRITICAL follow-up (V-21 sibling-channel closure): this used
      // to ALSO return `structuredContent: { results: hits }` — the SAME
      // hits, completely raw and un-neutralized, sitting next to the framed
      // `content` channel above. The MCP SDK forwards `structuredContent`
      // verbatim whenever no `outputSchema` is declared (none is, here —
      // `codebase-server.ts`'s `registerTool` call), and Hermes's harness
      // combines `content` + `structuredContent` before handing both to the
      // model (`mcp_tool.py:3983-3990`) — so the frame envelope on `content`
      // alone left the exact same injection surface open one field over.
      // Repo-wide grep found no consumer of this tool's `structuredContent`
      // (no `outputSchema`, no webview render, no test asserting its
      // presence) and the LSP-side tools ship no `structuredContent` at all
      // for the identical reason — so it is dropped rather than sanitized:
      // there is nothing here worth a second copy of the frame machinery.
      // CF-04 / L5 F-7: an empty `hits` array used to become `content: []`
      // — on the wire, indistinguishable from a request the SDK never
      // fulfilled at all. Say plainly that the search ran and found
      // nothing, rather than going silent (the OTHER empty case — the
      // index not existing yet — is a distinct, thrown condition handled
      // in the catch block below, never folded into this message).
      if (hits.length === 0) {
        return { content: [{ type: 'text' as const, text: '(no results)' }] };
      }
      const nonce = mintFrameNonce();
      return {
        content: hits.map((h) => ({ type: 'text' as const, text: frameLspResult(formatHitAsText(h), nonce) })),
      };
    } catch (error) {
      // The detail goes to OUR stderr, never to the model. Swallow a
      // throwing `log` too — the fixed-string return below is the whole
      // point of this catch, and a logger failure must never mask it or
      // propagate a (possibly still-sensitive) error to the SDK instead.
      try {
        deps.log?.(`codebase_search failed: ${error instanceof Error ? error.message : 'unknown'}`);
      } catch {
        // Intentionally ignored — see comment above.
      }
      // CF-04: `LanceDBStore.hybridSearch` throws this specific, detail-free
      // error when the codebase index hasn't been built yet (first-ever run
      // racing indexing — see LanceDBStore.ts). That's an honest, EXPECTED
      // state, not the unexpected-failure case the generic message below is
      // for — say so plainly instead of collapsing both into one string.
      if (error instanceof IndexNotReadyError) {
        return { content: [{ type: 'text' as const, text: '(index not ready)' }] };
      }
      return {
        content: [{ type: 'text' as const, text: '[codebase_search: error] search failed unexpectedly' }],
      };
    }
  };
}
