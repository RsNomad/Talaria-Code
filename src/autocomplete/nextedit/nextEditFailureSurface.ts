/**
 * nextedit/nextEditFailureSurface.ts — WS-F3 F3-7 (FI-13): the PURE copy
 * builder for next-edit's trigger-failure surface, moved out of
 * `shell.vscode.ts`'s `surfaceTriggerFailure` — BYTE-IDENTICAL copy, every
 * arm — with the CLASSIFICATION half handed off to the new shared
 * `classifyBackendFailure` (`../failureClass`). `describeTriggerFailure`
 * decides WHAT to say and on WHICH channel; it never dedups and never calls
 * `vscode` — the shell's own `surfaceTriggerFailure` shrinks to a thin
 * caller that keeps `surfaceOnce`/`surfacedFailures` (the toast + dedup
 * side-effects) exactly as before.
 *
 * REUSE MODULE, per `reuseLocks.test.ts`'s own named-list idiom (mirroring
 * `nextEditEgress.ts`'s header): a NEW leaf under `nextedit/` that is not
 * `*.vscode.ts` and not `*.test.ts`, so it is discovered by both
 * `reuseLocks.test.ts`'s network-call guard sweep and
 * `nextEditPurity.test.ts`'s pure/headless-boundary sweep. Named here — not
 * merely counted — for the same reason those locks name every file they
 * touch: it was looked at, and it is clean.
 *
 * VSCODE-FREE — NOT in `nextEditPurity.test.ts`'s `ADAPTER_ALLOW` (locked at
 * exactly 4 files: `config.ts`, `guard.ts`, `shell.vscode.ts`,
 * `nextEditNotice.vscode.ts`): this module never imports the `vscode`
 * package itself, in any form — not even `import type`.
 *
 * Ground-truth deviation from the brief, documented per this WS's own
 * convention (ADR-025-K/L precedent): the brief's own import list for this
 * file did not name `BackendHttpError`. Re-grounding the moved copy showed
 * three of its arms (`model`/`auth`/`dialect`/`http`) read `err.status` and/
 * or `err.statusText` directly — fields `classifyBackendFailure` deliberately
 * does NOT return (FSU §5 Q11: the classifier hands back `kind` only, never
 * the original error's fields) — so this file re-narrows `err` via its own
 * `instanceof BackendHttpError` check, imported from its DEFINING leaf
 * (`../backends/http`), exactly as `classifyBackendFailure` itself does
 * internally. This is not a second classifier: the BRANCH is chosen by
 * `kind` alone; the re-narrow only recovers the two fields already known
 * (by construction) to exist once `kind` says so.
 *
 * Every string built here is assembled from the transport id, the endpoint
 * HOST, the model name, and (only where `kind` says the underlying error is
 * a {@link BackendHttpError}) `.status`/`.statusText` — never `err.message`
 * (which can carry the raw url, and with it userinfo credentials), never a
 * response body, never an API key, never matched secret text. `08` §9.3's
 * third clause is honoured too: parse/apply failures dismiss silently and
 * never reach here at all (they are verdicts, not throws).
 */
import { classifyBackendFailure } from '../failureClass';
import { BackendHttpError } from '../backends/http';
import { endpointLabel, type NextEditRoute } from './nextEditRoute';
import type { NextEditMode } from './mode';
import { NextEditMintRejectionError } from './scan';

export interface TriggerFailureDescription {
  key: string;
  message: string;
  channel: 'toast' | 'log';
}

/**
 * Pure — classifies (via the shared `classifyBackendFailure`) then builds
 * the byte-exact copy the pre-existing `surfaceTriggerFailure` already
 * produced for every arm below. The caller (`shell.vscode.ts`) owns dedup
 * (`surfaceOnce`/`surfacedFailures`) and the actual `vscode` toast/output-
 * channel calls — this function only ever returns data.
 */
export function describeTriggerFailure(
  err: unknown,
  route: NextEditRoute,
  mode: NextEditMode,
): TriggerFailureDescription {
  const where = endpointLabel(route.apiBase);
  const endpointSetting = mode === 'next' ? '"talaria.nextEdit.endpoint"' : '"talaria.autocomplete.endpoint"';
  const modelSetting = mode === 'next' ? '"talaria.nextEdit.model"' : '"talaria.autocomplete.model"';
  const key = (statusClass: string): string => `${route.transport}|${where}|${statusClass}`;

  // Everything else — a connection refusal or DNS failure, an idle-stream
  // reap, an oversize-response cap, a keyless-FIM-only refusal that can
  // never arise on this surface, or a genuinely unrecognised error. ARCH's
  // F-4 named "a wrong endpoint" specifically: without this fallback a
  // typo'd port is indistinguishable from a feature that simply never has
  // anything to suggest. One message per transport/host/class per
  // registration, so a permanently-down server costs exactly one toast.
  const unreachable = (): TriggerFailureDescription => ({
    key: key('unreachable'),
    message: `Next Edit is paused: the request to the ${route.transport} server at ${where} failed. Check ${endpointSetting}, and that the server is running.`,
    channel: 'toast',
  });

  const { kind } = classifyBackendFailure(err);

  switch (kind) {
    case 'insecure-transport':
      // Rebuild the copy — never echo the throw site, which names the
      // scheme, the raw url and "(CWE-319)". Same discipline as
      // `provider.ts`'s insecure-transport arm.
      return {
        key: key('insecure-transport'),
        message:
          'Next Edit is paused: refusing to send credentials over cleartext HTTP to a remote host. Use https, or point the endpoint at a loopback address (127.0.0.1/localhost).',
        channel: 'toast',
      };

    case 'model': {
      if (!(err instanceof BackendHttpError)) return unreachable();
      return {
        key: key('model'),
        message: `Next Edit is paused: the ${route.transport} server at ${where} does not serve the model "${route.model}" (404). Check ${modelSetting}.`,
        channel: 'toast',
      };
    }

    case 'auth': {
      if (!(err instanceof BackendHttpError)) return unreachable();
      return {
        key: key('auth'),
        message: `Next Edit is paused: the ${route.transport} server at ${where} rejected the request (${err.status} ${err.statusText}). Check that ${endpointSetting} points at a server this machine is authorized to use.`,
        channel: 'toast',
      };
    }

    case 'dialect': {
      if (!(err instanceof BackendHttpError)) return unreachable();
      return {
        key: key('dialect'),
        message: `Next Edit is paused: the server at ${where} rejected the request (${err.status} ${err.statusText}). This usually means the configured transport doesn't match the server's API dialect — it can also mean the prompt exceeded the server's context length.`,
        channel: 'toast',
      };
    }

    case 'http': {
      if (!(err instanceof BackendHttpError)) return unreachable();
      return {
        key: key('http'),
        message: `Next Edit is paused: the ${route.transport} server at ${where} returned ${err.status} ${err.statusText}. Check ${endpointSetting}.`,
        channel: 'toast',
      };
    }

    case 'mint': {
      // V-1 fix — the misdiagnosis half. A mint rejection is thrown BEFORE
      // any request is built or sent (`scan.ts`'s `mintScannedNextEditRequest`),
      // so it must never fall into the generic "the request... failed...
      // check that the server is running" copy above — that used to send
      // the user to debug healthy infra for a request that was never sent.
      // Names the real cause (a scan rule) and nothing else — never the
      // matched content, never the endpoint, and deliberately never the
      // word "server" either: this message must not even RESEMBLE the
      // unreachable-fallback's server-blame copy, which is exactly the
      // misdiagnosis this arm exists to prevent. Dedup key includes
      // `ruleId` so a secret-rule skip and a rare oversize skip each
      // surface once, independently.
      //
      // CA-06-NE-face: the HUMAN surface for this condition is the per-file
      // badge + one-shot toast (nextEditNotice.vscode.ts). This arm keeps
      // only the technical audit line — output channel, ruleId-only
      // contract (never matched text, never content) — deduped by the same
      // registration-scoped Set the toast path uses, minus its toast.
      if (!(err instanceof NextEditMintRejectionError)) return unreachable();
      return {
        key: key(`mint|${err.ruleId}`),
        message: `Next Edit skipped for this file: its content cannot be sent safely (rule: ${err.ruleId}). No request was sent.`,
        channel: 'log',
      };
    }

    // next-edit never surfaced these two distinctly — both fall through to
    // the SAME unreachable copy as today's fallback (byte-identical): a
    // keyless-FIM refusal can never arise on this surface at all
    // (`missing-key` is FIM-only), and a mid-stream SSE error frame
    // (`stream`) was never given its own arm here either. Explicit, not an
    // accidental fallthrough — `noFallthroughCasesInSwitch` would reject a
    // real fallthrough; this is three separate `case` labels sharing one
    // `return`.
    case 'missing-key':
    case 'stream':
    case 'unreachable':
      return unreachable();
  }
}
