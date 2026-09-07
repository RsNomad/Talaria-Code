/**
 * autocomplete/failureClass.ts — WS-F3 F3-7 (FI-13): the ONE shared backend-
 * failure CLASSIFIER, extracted out of the two near-duplicate `instanceof`
 * ladders that used to live entirely inside `provider.ts`'s
 * `surfaceCompletionFailure` and `nextedit/shell.vscode.ts`'s
 * `surfaceTriggerFailure`. This file draws the line FSU §5 Q11 settled:
 * `kind` (the discriminant below) is SHARED — both surfaces classify a given
 * error identically — but the human copy string and the dedup key
 * (`statusClass`/`key(...)`) stay per-surface, built by each caller from
 * `kind`, never by this file. `classifyBackendFailure` decides WHAT went
 * wrong; it never decides what to say about it or whether to say anything at
 * all — that is `nextEditFailureSurface.ts`'s and `provider.ts`'s job, and
 * each keeps its own copy table (F-4 / A5's discipline, unmoved).
 *
 * ROOT purity guard, not `nextedit/`'s or `context/`'s: this file lives at
 * `src/autocomplete/` (a sibling of both `nextedit/` and `backends/`, not
 * inside either) because BOTH `provider.ts` (FIM) and
 * `nextedit/nextEditFailureSurface.ts` (next-edit) need it, and neither
 * surface may import the other's directory. Pure and headless — no `vscode`
 * import (not even `import type`), no `node:fs` import — verified by hand
 * (no mechanical `src/autocomplete/`-root scan exists yet; `nextedit/`'s and
 * `context/`'s own `*Purity.test.ts` files are scoped to their own
 * subdirectories and do not reach this file).
 *
 * Import-cycle proof (critic M-10): every error class below is imported from
 * its DEFINING leaf (`backends/http.ts`, `backends/secureTransport.ts`,
 * `backends/CodestralFimBackend.ts`, `nextedit/scan.ts`) — never re-exported
 * through `provider.ts` or `shell.vscode.ts`. None of those four leaves
 * imports this file, `provider.ts`, or `shell.vscode.ts` (confirmed by
 * reading each one), so there is no cycle to break. `classifyBackendFailure`
 * only ever calls `instanceof` on these classes INSIDE the function body, at
 * CALL time — never at module-eval time — so even a hypothetical future
 * cycle could not corrupt an evaluation order here. `tsc` (0 errors) and the
 * full gate are the runtime proof this holds.
 */
import { BackendHttpError, BackendStreamError } from './backends/http';
import { InsecureTransportError } from './backends/secureTransport';
import { MissingApiKeyError } from './backends/CodestralFimBackend';
import { NextEditMintRejectionError } from './nextedit/scan';

/**
 * The 9-member shared discriminant (FSU §5 Q11). `'stream'` is deliberately
 * narrower than "every stream-shaped failure class in `backends/http.ts`":
 * it fires ONLY for {@link BackendStreamError} (a mid-stream SSE error
 * FRAME on an otherwise-healthy connection — a real backend-reported
 * failure). `StreamIdleTimeoutError` and `StreamByteCapError` are transport-
 * level hardening failures (a dead connection, a hostile/oversized
 * response) — ground-truthed against BOTH surfaces' current, pinned
 * behaviour (`provider.test.ts`'s dedicated "StreamIdleTimeoutError ...
 * returns null silently" characterization, and next-edit's pre-existing
 * "no stream arm at all" ladder) neither surface treats them as the
 * mid-stream-error case; both already fall through to the generic
 * `'unreachable'` bucket today. Folding them into `'stream'` instead would
 * have made FIM start toasting on a stream-idle reap it deliberately stays
 * silent on — a copy regression this task exists to PREVENT, not introduce.
 */
export type BackendFailureKind =
  | 'insecure-transport'
  | 'missing-key'
  | 'auth'
  | 'dialect'
  | 'model'
  | 'stream'
  | 'http'
  | 'mint'
  | 'unreachable';

/**
 * Classifies ONE backend failure. `statusClass` is a ready-made dedup-key
 * fragment that happens to equal `kind`'s own string in every branch below
 * (the mint branch's `ruleId` suffix is layered on by the CALLER, which
 * re-narrows `err` itself — see `nextEditFailureSurface.ts`) — surfaces are
 * free to reuse it verbatim (next-edit's `key(...)` does) or build their own
 * (FIM's `status-${err.status}` catch-all key does), per FSU §5 Q11.
 *
 * Never throws, never reads `err.message` (that string can carry a raw URL,
 * userinfo credentials, or a runner's own internal detail — jobA-common.md
 * invariant 5) — this function only ever inspects `instanceof` and, for
 * {@link BackendHttpError}, `.status`. It never builds a user-facing string.
 */
export function classifyBackendFailure(err: unknown): { statusClass: string; kind: BackendFailureKind } {
  if (err instanceof InsecureTransportError) {
    return { statusClass: 'insecure-transport', kind: 'insecure-transport' };
  }
  if (err instanceof MissingApiKeyError) {
    return { statusClass: 'missing-key', kind: 'missing-key' };
  }
  if (err instanceof NextEditMintRejectionError) {
    return { statusClass: 'mint', kind: 'mint' };
  }
  if (err instanceof BackendHttpError) {
    if (err.status === 404) return { statusClass: 'model', kind: 'model' };
    if (err.status === 401 || err.status === 403) return { statusClass: 'auth', kind: 'auth' };
    if (err.status === 400) return { statusClass: 'dialect', kind: 'dialect' };
    return { statusClass: 'http', kind: 'http' };
  }
  if (err instanceof BackendStreamError) {
    return { statusClass: 'stream', kind: 'stream' };
  }
  return { statusClass: 'unreachable', kind: 'unreachable' };
}
