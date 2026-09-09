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
    /** FI-34: optional — this engine (`ingestGguf`) never reads it. Exact-
     *  file-set enforcement, when it applies, happens UPSTREAM of this sink:
     *  `verifyHfDigest` (`hfDigest.ts`, ⚠ S-F4), called by `provisionRunner`
     *  in pinned mode BEFORE `ingestGguf` ever runs — NOT here. This field
     *  exists only for shape parity with `GgufStoreSpec.gguf.allowedRepoFiles`
     *  (`ggufIngest.ts`, also optional) so a `GgufIngestSpec` literal can
     *  carry it; a caller must not read its presence on THIS type as "the
     *  sink enforces the exact file set." */
    allowedRepoFiles?: readonly string[];
  };
  ollamaCreatedName: string;
}
