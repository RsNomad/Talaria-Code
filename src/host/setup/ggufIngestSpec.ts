/**
 * WS-F8 F8-3 (FI-17): `GgufIngestSpec` extracted VERBATIM out of
 * `SetupController.ts` into its own leaf — the FROZEN `ggufIngest.ts:2`
 * `import type { GgufIngestSpec } from './SetupController'` keeps resolving
 * unchanged because `SetupController.ts` now type-re-exports this interface
 * (`export type { GgufIngestSpec } from './ggufIngestSpec';`, erased at
 * compile time by `verbatimModuleSyntax` — no runtime edge, no cycle).
 */

/**
 * T13 (beta.5 §4.4.3d): what the controller hands the T14 ingest engine —
 * ALWAYS the registry-pinned artifact (`NEXT_DEDICATED_MODEL.gguf` +
 * `ollamaCreatedName`), never anything webview-derived. The engine's own
 * io/fs/fetch seams are bound in `setupHost.vscode.ts`, NOT passed here.
 */
export interface GgufIngestSpec {
  gguf: {
    hfRepo: string;
    file: string;
    quant: string;
    sha256: string;
    approxBytes: number;
    /** T3 (beta.6 §2.4): optional — meaningful only in `pinned` mode (the
     *  pinned llama.cpp/Ollama path passes it for `verifyHfDigest`'s exact-
     *  file-set check upstream of `ingestGguf`; `live-oid` mode passes
     *  none, since nothing else in the repo is ever read for that file). */
    allowedRepoFiles?: readonly string[];
  };
  ollamaCreatedName: string;
}
