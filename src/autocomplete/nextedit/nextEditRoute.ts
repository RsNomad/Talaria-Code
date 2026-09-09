/**
 * nextedit/nextEditRoute.ts — WS-F3 F3-3 (FI-06): the route-resolution core
 * + the route/toggle copy, moved out of `shell.vscode.ts`, verbatim.
 *
 * REUSE MODULE, per `reuseLocks.test.ts`'s own named-list idiom (mirroring
 * `nextEditText.ts`'s header): a NEW leaf under `nextedit/` that is not
 * `*.vscode.ts` and not `*.test.ts`, so it is discovered by both
 * `reuseLocks.test.ts`'s network-call guard sweep and
 * `nextEditPurity.test.ts`'s pure/headless-boundary sweep. Named here — not
 * merely counted — for the same reason those locks name every file they
 * touch: it was looked at, and it is clean.
 *
 * VSCODE-FREE — NOT in `nextEditPurity.test.ts`'s `ADAPTER_ALLOW` (locked at
 * exactly 4 files: `config.ts`, `guard.ts`, `shell.vscode.ts`,
 * `nextEditNotice.vscode.ts`): this module never imports the `vscode`
 * package itself, in any form. The one import below that names
 * `./shell.vscode` is `import type` only —
 * erased at runtime, so it neither reintroduces vscode into this module nor
 * creates a runtime cycle with the shell's own runtime import of
 * `resolveRoute` from here (shell→nextEditRoute is a real runtime edge;
 * nextEditRoute→shell is type-only, gone by the time either module runs).
 *
 * `resolveRoute` and `endpointLabel` were module-PRIVATE in `shell.vscode.ts`
 * — both are exported here (required so `nextEditRoute.test.ts` can pin
 * `RouteResolution`'s whole shape directly, discharging F3-1's deferred
 * format-pin item — see that file's own module doc). `isLoopbackEndpoint`
 * stays module-private: only `resolveRoute` calls it, in either its old home
 * or this one.
 *
 * This module makes no network call of any kind and never spells the banned
 * network-call token, not even in a comment — `reuseLocks.test.ts`'s
 * `:194-203` raw-content sanity scan confirms that byte-for-byte on every
 * run.
 */
import { isLoopbackHost } from '../backends/secureTransport';
import { DEFAULT_ENDPOINTS } from '../endpoints';
import { readNextEditConfig } from './config';
import { genericInstructFormat } from './formats/genericInstruct';
import { sweepV2Format } from './formats/sweepV2';
import type { NextEditFormat } from './formats/types';
import type { NextEditMode } from './mode';
import type { NextEditShellDeps } from './shell.vscode';
import type { NextEditTransportId } from './types';

/**
 * `08` §6.3 — the one-shot Generic setup note, pinned copy. No detection
 * backs this (Global Constraints: "No orchestration. No code may measure
 * VRAM, detect hardware, count loaded models, or check whether models fit") —
 * it is a note, shown once per accepted generic toggle-on, and nothing more.
 */
export const GENERIC_SETUP_NOTE =
  "Generic next-edit sends ~6k-token prompts. Ollama's default context below 23 GiB VRAM is 4096: set OLLAMA_CONTEXT_LENGTH=16384 on your server, or proposals will be built from a truncated prompt.";

/**
 * F-5 — the NEXT twin of {@link GENERIC_SETUP_NOTE}.
 *
 * `talaria.nextEdit.model` ships EMPTY (there is no sane default: the model is
 * served on the user's own endpoint), so flipping the NEXT row on with shipped
 * defaults used to be permanently, silently inert while the panel row read
 * "Uses sweep-next-edit-v2-7B on its own endpoint" in the present tense.
 * Generic got a one-shot setup note; NEXT — the source that actually REQUIRES
 * hand-editing `settings.json` — got nothing at all.
 *
 * Names the setting, because that is the only thing the user can act on. No
 * detection backs it (Global Constraints: nothing measures VRAM or checks
 * whether a model is loaded) — it fires on the observed empty string only.
 */
export const NEXT_EDIT_MODEL_UNSET_NOTE =
  'Next Edit is on, but "talaria.nextEdit.model" is empty — no suggestion can ever be produced. Set it in your settings (for example "sweep-next-edit-v2-7B"), together with "talaria.nextEdit.endpoint" if your model is not on the default port.';

/**
 * `08` §5.3 / ADR-009 — why Generic REFUSES these two FIM backends rather
 * than silently producing garbage: an `openai-compat` FIM endpoint may be
 * Ollama's OpenAI surface, whose `/v1/completions` re-templates the prompt
 * with no `raw` escape (`openai/openai.go:777-786` sets no `Raw`;
 * `routes.go:508-541` wraps the prompt as a user chat message). Generic
 * renders its OWN complete chat prompt, so a second server-side templating
 * pass yields the well-formed-and-wrong class of failure — the kind no error
 * surface ever reports. Codestral's FIM API has no raw-completion route at
 * all. Actionable copy: names the offending backend and the exact way out.
 */
export function genericUnsupportedBackendMessage(fimBackend: string): string {
  return `Next Edit (Generic) cannot use the "${fimBackend}" autocomplete backend: that API re-templates the prompt server-side, which would silently corrupt the next-edit prompt. Set "talaria.autocomplete.backend" to ollama, vllm or llamacpp, or use the NEXT source instead.`;
}

/**
 * Generic's transport derivation (`08` §5.3 / ADR-009). `null` means
 * UNSUPPORTED — the generic toggle-on is refused, never silently downgraded.
 */
export function deriveGenericTransport(fimBackend: string): NextEditTransportId | null {
  if (fimBackend === 'ollama') return 'ollama';
  if (fimBackend === 'vllm' || fimBackend === 'llamacpp') return 'openai-compat';
  // 'codestral' and 'openai-compat' — see genericUnsupportedBackendMessage.
  return null;
}

export interface NextEditRoute {
  format: NextEditFormat;
  transport: NextEditTransportId;
  apiBase: string;
  model: string;
  /** Non-loopback endpoint — the half of the trust gate that does not need
   *  `vscode.workspace.isTrusted` and so can be computed before it. */
  remote: boolean;
  /**
   * Set ONLY by the generic branch. `undefined` on the NEXT branch, by
   * construction — that is what keeps "NEXT gets no key" a structural
   * property rather than an intention.
   */
  apiKey?: string;
}

/**
 * S4.3 parity with `index.ts`'s own `isLoopbackEndpoint`: reuses
 * `secureTransport.ts`'s single loopback source of truth, and treats a
 * malformed URL as NON-loopback — which fails CLOSED (an untrusted workspace
 * then skips rather than shipping code off-box).
 */
function isLoopbackEndpoint(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Why no request can be built — the shape that lets the trigger tell a
 * SILENT skip from a condition the user can actually fix (F-5, C-5). Before
 * this, every one of these collapsed into a bare `null` and the feature went
 * quietly dead with the panel row still reading as if it were running.
 */
export type RouteResolution =
  | { kind: 'route'; route: NextEditRoute }
  /** NEXT is on but `talaria.nextEdit.model` is empty — actionable (F-5). */
  | { kind: 'next-model-unset' }
  /** Generic against a FIM backend whose API re-templates the prompt. The
   *  toggle-time refusal (`requestNextEditToggle`) cannot cover this: the
   *  backend can be changed AFTER Generic was ratified (C-5). */
  | { kind: 'generic-unsupported-backend'; fimBackend: string }
  /** Generic with no endpoint/model at all — see the note at the site. */
  | { kind: 'generic-unconfigured' }
  /** Mode is off. Unreachable from `trigger()` (GATE 1 already returned). */
  | { kind: 'mode-off' };

/**
 * Endpoint/model/transport/format per mode (`08` §5.3):
 *  - `next`    ⇒ `talaria.nextEdit.{endpoint,model,backend}` + sweep-v2;
 *  - `generic` ⇒ the AUTOCOMPLETE endpoint+model + generic-instruct, with the
 *                transport DERIVED from the FIM backend id.
 *
 * Anything but `'route'` = build nothing. An unconfigured model is one such
 * case: it cannot produce anything but a 404, and `backend.ts`'s fail-closed
 * model reconciliation would refuse it at the wire anyway. Note that
 * `route.model` is the SINGLE source for both `NextEditRequest.model` and the
 * backend's `opts.model`, which is what makes that reconciliation check
 * unfailable here by construction.
 */
export function resolveRoute(mode: NextEditMode, deps: NextEditShellDeps): RouteResolution {
  if (mode === 'next') {
    const cfg = readNextEditConfig();
    if (cfg.model === '') return { kind: 'next-model-unset' };
    const apiBase = cfg.endpoint === '' ? DEFAULT_ENDPOINTS[cfg.backend] : cfg.endpoint;
    return {
      kind: 'route',
      route: {
        format: sweepV2Format,
        transport: cfg.backend,
        apiBase,
        model: cfg.model,
        remote: !isLoopbackEndpoint(apiBase),
      },
    };
  }

  if (mode === 'generic') {
    const fimBackend = deps.getAutocompleteBackend();
    const transport = deriveGenericTransport(fimBackend);
    if (transport === null) return { kind: 'generic-unsupported-backend', fimBackend };
    const apiBase = deps.getAutocompleteEndpoint();
    const model = deps.getAutocompleteModel();
    // JUSTIFIED, not dead (the final review flagged it as dead code): it IS
    // unreachable through the shipped composition root, because `index.ts`
    // feeds these from `readConfig()`, which coerces both to a default
    // (`config.ts:76,83`). But `NextEditShellDeps` is a plain interface, not a
    // binding to `readConfig` — any other implementation of it may return ''.
    // Removing this check would send an empty apiBase to `joinUrl` and an
    // empty model to the wire, which is a worse failure than skipping. Kept
    // deliberately as an interface-contract check, and silent because there is
    // no user-facing setting that can be in this state.
    if (apiBase === '' || model === '') return { kind: 'generic-unconfigured' };
    const genericApiKey = deps.getAutocompleteApiKey();
    return {
      kind: 'route',
      route: {
        format: genericInstructFormat,
        transport,
        apiBase,
        model,
        remote: !isLoopbackEndpoint(apiBase),
        ...(genericApiKey !== undefined ? { apiKey: genericApiKey } : {}),
      },
    };
  }

  return { kind: 'mode-off' };
}

/**
 * The host label for a user-facing message: `URL.host` only.
 *
 * Deliberately NOT the raw `apiBase` — a URL may carry `user:password@`
 * userinfo, and `host` is the one accessor that cannot return it (Global
 * Constraint: error messages never carry an API key). A malformed endpoint has
 * no host to name, so it degrades to a neutral phrase rather than echoing the
 * unparsed string back at the user.
 */
export function endpointLabel(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return 'the configured endpoint';
  }
}
