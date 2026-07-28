// nextedit/formats/types.ts — Job B Task 5 · the format-module contract
// (08-jobB-final-architecture.md §4.1, copied verbatim). Declarations only,
// no logic, no vscode import.
//
// `NextEditFormatId` is Task 1's declaration (nextedit/types.ts) — it is
// CONSUMED here (imported for `NextEditFormat.id`'s type), never
// redeclared. With exactly two formats selected by the R5 mode, there is
// no format registry, no `hermes.nextEdit.format` setting, no `'auto'`,
// and no model-name sniffing (§4.1): the NEXT toggle implies sweep-v2, the
// Generic toggle implies generic-instruct — nothing on the wire identifies
// a dialect, so a wrong guess would be confident garbage.
import type { NextEditFormatId, NextEditRequest, NextEditVerdict } from '../types';

export interface RenderedNextEditPrompt {
  /** The COMPLETE wire string, prefill included at its tail (prompt.endsWith(prefill) is a locked invariant). */
  prompt: string;
  /** The prefill duplicated for parse-time reconstruction ('' when the format has none). */
  prefill: string;
  stop: readonly string[];
  temperature: 0;              // both formats are greedy — sourced for sweep-v2 (do_sample=False, 04 §1.1);
                                // for the generic prompt the same vendor's eval harness is the provenance [вывод]
  maxTokens: number;
}

export type NextEditRenderResult =
  | { kind: 'rendered'; prompt: RenderedNextEditPrompt }
  | { kind: 'skip'; reason: string };   // a quiet no-request — NOT an error

export type StopReason = 'stop' | 'length' | 'unknown';
export interface NextEditModelOutput { text: string; stopReason: StopReason }

export interface NextEditFormat {
  readonly id: NextEditFormatId;
  readonly windowLines: number;            // region half-height around the CURSOR (both: 10)
  readonly sentinels: readonly string[];   // the egress mint rejects content containing these
  render(req: NextEditRequest): NextEditRenderResult;
  parse(output: NextEditModelOutput, rendered: RenderedNextEditPrompt, req: NextEditRequest): NextEditVerdict;
}
