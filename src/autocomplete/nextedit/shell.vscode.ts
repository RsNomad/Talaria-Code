/**
 * nextedit/shell.vscode.ts — Job B Task 12 · THE shell.
 *
 * Everything `vscode`-shaped that next-edit needs lives here: the effect
 * executor, the trigger path, the listeners, the commands, the toggle gate.
 * Every DECISION this file makes was already made by a pure core it calls —
 * the shell translates, it does not judge. `TextDocument.version` is the
 * freshness token and it stays here (Global Constraints: "Pure cores, thin
 * shell").
 *
 * This file NEVER calls the inline-completion registration API (Global
 * Constraints: "Exactly ONE InlineCompletionItemProvider. Forever." — the
 * sole call site stays `src/autocomplete/index.ts`). Next-edit reaches the
 * screen through decorations + context keys + keybindings, never through the
 * inline-completion surface. Locked by a source scan in this file's tests.
 *
 * Field-by-field object construction only, no object-spread-with-override,
 * and no brand casts — the request brand is obtained by CALLING the one
 * sanctioned mint (`scan.ts`). This file is in scope for
 * `context/ringBuffer.test.ts`'s repo-wide BRAND-FORGERY guards: a ban on
 * forging the request brand via a cast (see that file's own module doc for
 * the exact pattern — not restated here, since that guard's scan reads raw
 * file text, comments included, and restating the pattern here would trip
 * it) plus a brand-preserving-spread ban. Those two guards check ONLY the
 * cast/spread shapes they name, nothing more (F-10: this comment used to
 * call them "purity guards", which overstated what they enforce). The
 * separate `vscode`-import purity boundary this file also lives inside is
 * locked by `nextEditPurity.test.ts`, not by `ringBuffer.test.ts`.
 */
import * as vscode from 'vscode';
import { AutocompleteDebouncer } from '../debouncer';
import { BackendHttpError } from '../backends/http';
import { InsecureTransportError, isLoopbackHost } from '../backends/secureTransport';
import { isSecretForCompletion } from '../../shared/secretPaths';
import { scanSnippetForSecrets } from '../context/secretScanner';
import { createEditTrackerAdapter, type EditTrackerAdapter } from '../context/editTrackerAdapter';
import { isRecordableScheme } from '../context/recordableScheme';
import type { FimActivityListener } from '../provider';
import { regionAroundCursor, remapRange, type ContentChangeLite } from './anchors';
import { NextEditHttpBackend } from './backend';
import { readNextEditConfig } from './config';
import { DEFAULT_FILE_WINDOW_OPTIONS, windowAroundCursor } from './fileWindow';
import { reduceNextEdit } from './fsm';
import { genericInstructFormat } from './formats/genericInstruct';
import { sweepV2Format } from './formats/sweepV2';
import type { NextEditFormat } from './formats/types';
import { NextEditGuard } from './guard';
import { resolveNextEditMode, type NextEditMode, type ToggleRequest, type ToggleState } from './mode';
import { mintScannedNextEditRequest, NextEditMintRejectionError } from './scan';
import type {
  AnchoredProposal,
  EditableRegion,
  LineRange,
  NextEditEffect,
  NextEditFsmEvent,
  NextEditFsmState,
  NextEditRequest,
  NextEditTransportId,
  RecentDiff,
} from './types';

/** The two context keys the executor owns — it is their ONLY writer. */
export type NextEditContextKey = 'talaria.nextEdit.jumpVisible' | 'talaria.nextEdit.jumped';

/** The edit-burst debounce. Matches `talaria.autocomplete.debounceMs`'s own
 *  350 ms default — next-edit rides the same "the user paused typing" signal
 *  FIM does, and reuses FIM's debouncer implementation rather than a second
 *  hand-rolled timer. */
const TRIGGER_DEBOUNCE_MS = 350;

/**
 * Transport defaults for an EMPTY `talaria.nextEdit.endpoint`, whose setting
 * description promises "Leave empty to use the backend's default". These
 * mirror `config.ts`'s own `DEFAULT_ENDPOINTS` rows for the two transports
 * next-edit supports (that table is module-private there, so the two rows are
 * restated rather than reached into).
 */
const DEFAULT_NEXT_EDIT_ENDPOINTS: Readonly<Record<NextEditTransportId, string>> = Object.freeze({
  ollama: 'http://127.0.0.1:11434',
  'openai-compat': 'http://127.0.0.1:8000',
});

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

/** Copy for every `noteOnce` msgId the FSM can emit. */
const NOTE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'apply-failed':
    'Next Edit: the proposed edit could not be applied — the document changed underneath it. The proposal was dismissed.',
});

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

// ─────────────────────────────── the executor ────────────────────────────────

/**
 * The executor's host port. Every effect the FSM can emit lands on exactly
 * one method here, so the executor's own logic (ordering, the forced
 * clear-all, the jumped-locator re-render, the noteOnce dedup) is testable
 * against a mock host with no editor in sight.
 */
export interface NextEditExecutorHost {
  setContext(key: NextEditContextKey, value: boolean): void;
  /**
   * `jumped` selects the locator's verb — `Tab to jump` vs `Tab to accept`.
   *
   * Returns whether the paint actually reached the screen. F-1: a host whose
   * editor is gone (or is no longer the one this proposal belongs to) DECLINES
   * rather than painting, and a declined paint must clear the pair — see
   * property 1 below. A `void` return let a silent early return leave
   * `jumpVisible` up with nothing on screen.
   */
  showDecorations(p: AnchoredProposal, jumped: boolean): boolean;
  clearDecorations(): void;
  reveal(range: LineRange): void;
  applyEdit(region: EditableRegion, newText: string): Promise<boolean>;
  note(msgId: string): void;
}

export interface NextEditExecutor {
  run(effects: readonly NextEditEffect[]): void;
}

/**
 * Executes one FSM effect batch.
 *
 * Three properties this function owns, none of which the FSM can enforce on
 * its own because they are about the SIDE of the boundary where things can
 * fail:
 *
 *  1. **The invariant that replaced the deleted wall-clock timeout**: after
 *     every batch, `talaria.nextEdit.jumpVisible` is up if and only if
 *     decorations are on screen. The FSM guarantees the batches are
 *     well-formed; this function guarantees a THROWING host cannot leave the
 *     pair half-set — any exception mid-batch forces a full `clearAll`. A
 *     stuck `jumpVisible` with nothing on screen would silently steal Tab.
 *     F-1 closed the other half of that guarantee: a host that DECLINES to
 *     paint (returns `false` — a silent early return, not a throw) used to
 *     walk straight through the exception guard, which is precisely the
 *     failure this property names. A declined paint now forces the same
 *     `clearAll`, so the invariant holds for both failure shapes.
 *  2. **The jumped locator re-render**: `reduceNextEdit`'s `proposed×tabJump`
 *     batch is `[setContext jumped, reveal]` — deliberately no
 *     `showDecorations`, because the PROPOSAL did not change, only its
 *     presentation. The executor therefore re-renders the locator itself when
 *     the `jumped` key flips while a proposal is on screen.
 *  3. **`noteOnce` is once**: deduped per msgId for the life of the executor.
 *     (Distinct from the Guard's refusal alerts, which deliberately re-fire —
 *     a refusal answers a fresh user gesture, a note reports a condition.)
 *
 * NO TIMER anywhere in here: no proposal expires on a wall clock (`08` §7.6 —
 * the vendor lifetime enum is Accepted|Rejected|Ignored, there is no Timeout).
 */
export function makeExecutor(
  host: NextEditExecutorHost,
  onApplyResult: (ok: boolean) => void = () => {},
): NextEditExecutor {
  let shownProposal: AnchoredProposal | null = null;
  let jumped = false;
  const noted = new Set<string>();

  function clearAll(): void {
    host.setContext('talaria.nextEdit.jumpVisible', false);
    host.setContext('talaria.nextEdit.jumped', false);
    host.clearDecorations();
    shownProposal = null;
    jumped = false;
  }

  function applyOne(effect: NextEditEffect): void {
    switch (effect.kind) {
      case 'setContext': {
        host.setContext(effect.key, effect.value);
        if (effect.key === 'talaria.nextEdit.jumped') {
          jumped = effect.value;
          // Property 2 above — re-render the locator's verb in place.
          if (shownProposal !== null && !host.showDecorations(shownProposal, jumped)) {
            clearAll();
          }
        }
        return;
      }
      case 'showDecorations': {
        if (!host.showDecorations(effect.p, jumped)) {
          // F-1: the paint was declined, so there is nothing on screen. Taking
          // the batch's `jumpVisible = true` at face value here is exactly the
          // stuck-context-key failure property 1 forbids.
          clearAll();
          return;
        }
        shownProposal = effect.p;
        return;
      }
      case 'reveal': {
        host.reveal(effect.range);
        return;
      }
      case 'applyEdit': {
        // The boolean comes back as the FSM's `applyResult` event. A REJECTED
        // `applyEdit` is reported as `false` (fail-closed: dismiss + note),
        // never left as an unhandled rejection.
        void host.applyEdit(effect.region, effect.newText).then(
          (ok) => onApplyResult(ok),
          () => onApplyResult(false),
        );
        return;
      }
      case 'clearAll': {
        clearAll();
        return;
      }
      case 'noteOnce': {
        if (noted.has(effect.msgId)) return;
        noted.add(effect.msgId);
        host.note(effect.msgId);
        return;
      }
    }
  }

  return {
    run(effects: readonly NextEditEffect[]): void {
      try {
        for (const effect of effects) {
          applyOne(effect);
        }
      } catch {
        // Property 1 above. `clearAll` itself touching a broken host would
        // throw out of `run`, which is the honest outcome — there is nothing
        // left to fall back to, and swallowing it would hide a dead executor.
        clearAll();
      }
    },
  };
}

// ──────────────────────────────── the FIM seam ───────────────────────────────

/**
 * The command VS Code executes when the user ACCEPTS FIM ghost text — the R4
 * seam. Registered exactly once, by `registerTalariaNextEdit` below, and
 * advertised to `provider.ts` through `acceptCommandId()` ONLY by the
 * registration that registered it. `provider.ts` never names this string: an
 * item can therefore not carry a command id that nothing has registered.
 */
const FIM_ACCEPT_COMMAND = 'talaria.nextEdit.onFimAccept';

const NO_OP_FIM_ACTIVITY: FimActivityListener = {
  requestStarted: () => {},
  resultShown: () => {},
  accepted: () => {},
  acceptCommandId: () => undefined,
};

let currentFimActivity: FimActivityListener = NO_OP_FIM_ACTIVITY;

/**
 * The stable object `index.ts` hands to `TalariaInlineCompletionProvider`.
 *
 * Composition-order problem it solves: the provider is constructed by
 * `registerTalariaAutocomplete`, the listener's real implementation by
 * `registerTalariaNextEdit`, and neither can hold the other's result at
 * construction time — while `registerTalariaNextEdit`'s signature is pinned to
 * return a bare `Disposable`. This relay is a fixed forwarding address: it is
 * a no-op until the shell attaches (so a build with next-edit unregistered
 * behaves exactly as before), and reverts to a no-op on dispose.
 *
 * Observation-only in BOTH directions of the R2 rule: FIM tells next-edit
 * what it is doing; next-edit holds no handle that could cancel FIM.
 */
export const fimActivityRelay: FimActivityListener = {
  requestStarted: () => currentFimActivity.requestStarted(),
  resultShown: (hasItem: boolean) => currentFimActivity.resultShown(hasItem),
  accepted: () => currentFimActivity.accepted(),
  // Forwarded, never answered here: the relay must report what the CURRENTLY
  // attached registration has registered — `undefined` while none is.
  acceptCommandId: () => currentFimActivity.acceptCommandId(),
};

// ───────────────────────────── the toggle gate ───────────────────────────────

export interface NextEditShellDeps {
  reportFailure(msg: string): void;
  getAutocompleteEndpoint(): string;
  getAutocompleteModel(): string;
  getAutocompleteBackend(): string;
  /**
   * The EFFECTIVE FIM key — the SecretStorage value, falling back to the
   * deprecated machine-scoped setting, exactly as the FIM engine resolves it
   * (`apiKey.ts` `pickApiKey`). Generic rides FIM's endpoint and FIM's model,
   * so it must ride FIM's credential: the destination is byte-identical, and
   * an unauthenticated request to an authed endpoint is not safer, it is
   * simply one that fails.
   *
   * The NEXT route must NEVER read this — it has its own endpoint, and
   * sending FIM's credential to a different host would be a genuine new
   * exposure. That is enforced structurally: the `next` branch of
   * `resolveRoute` leaves `NextEditRoute.apiKey` unset.
   */
  getAutocompleteApiKey(): string | undefined;
}

/**
 * THE toggle entry point — Task 13's webview `nextEdit.toggle` request calls
 * this, never `guard.requestToggle` directly.
 *
 * Two things wrap the Guard's own (pure, transport-blind) decision:
 *
 *  1. A generic toggle-ON against an unsupported FIM backend is refused HERE,
 *     before the Guard ratifies anything — the Guard knows nothing about
 *     transports, and a refusal that persisted first would leave a mode
 *     selected that can never produce a valid prompt.
 *  2. The `08` §6.3 setup note fires on an ACCEPTED generic toggle-on, and
 *     only there: not on a refusal (either kind), not on toggle-off, not on
 *     the NEXT source. Exactly one note per accepted gesture — it is emitted
 *     from this one site, so there is no second path that could double it.
 */
export async function requestNextEditToggle(
  guard: NextEditGuard,
  req: ToggleRequest,
  deps: NextEditShellDeps,
): Promise<ToggleState> {
  if (req.source === 'generic' && req.on) {
    const fimBackend = deps.getAutocompleteBackend();
    if (deriveGenericTransport(fimBackend) === null) {
      const message = genericUnsupportedBackendMessage(fimBackend);
      deps.reportFailure(message);
      void vscode.window.showWarningMessage(message);
      throw new Error(message);
    }
  }

  const accepted = await guard.requestToggle(req);

  if (req.source === 'generic' && req.on) {
    void vscode.window.showInformationMessage(GENERIC_SETUP_NOTE);
  }

  return accepted;
}

// ────────────────────────────── request building ─────────────────────────────

interface NextEditRoute {
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
type RouteResolution =
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
function resolveRoute(mode: NextEditMode, deps: NextEditShellDeps): RouteResolution {
  if (mode === 'next') {
    const cfg = readNextEditConfig();
    if (cfg.model === '') return { kind: 'next-model-unset' };
    const apiBase = cfg.endpoint === '' ? DEFAULT_NEXT_EDIT_ENDPOINTS[cfg.backend] : cfg.endpoint;
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
    return {
      kind: 'route',
      route: {
        format: genericInstructFormat,
        transport,
        apiBase,
        model,
        remote: !isLoopbackEndpoint(apiBase),
        apiKey: deps.getAutocompleteApiKey(),
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
function endpointLabel(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return 'the configured endpoint';
  }
}

/** Splits `text` into whole lines, each keeping its own trailing '\n'. */
function splitKeepingNewlines(text: string): string[] {
  const parts = text.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    lines.push(`${parts[i]}\n`);
  }
  const last = parts[parts.length - 1];
  // `text.split('\n')` always yields at least one element, so `last` is
  // always present; the undefined branch is unreachable (kept for
  // totality/type safety, not a behavior change).
  if (last !== undefined && last !== '') {
    lines.push(last);
  }
  return lines;
}

/** The `[startLine, endLine]` (inclusive) span of `text`. */
function extractLines(text: string, startLine: number, endLine: number): string {
  return splitKeepingNewlines(text).slice(startLine, endLine + 1).join('');
}

/** Workspace-relative POSIX path, mirroring `editTrackerAdapter.ts`'s helper
 *  (Fedora/Linux target; workspace URIs are always '/'-separated). */
function toWorkspaceRelativePosixPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).split('\\').join('/');
}

/**
 * CONTRACT (`formats/*`): `fileContext` must end in '\n' — the sweepV2 render
 * splices it directly into the template and the vendor builds the equivalent
 * value via `"".join(lines)`, i.e. always newline-terminated. A file whose
 * last line has no terminator would otherwise glue `{initial_file}` to the
 * next template line.
 */
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `text` without ONE trailing line terminator, `\r\n` preferred over `\n`.
 *  Never strips a second one: a genuinely blank final line is content. */
function stripLineTerminator(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/**
 * C-3 / ADR-018. Reads `text`'s `[startLine, endLine]` span as the SAME RANGE
 * `region.content` is read as, only against the pre-edit text instead of the
 * live document — i.e. the mirror of
 * `getText(new Range(startLine, 0, endLine, lineAt(endLine).text.length))`.
 *
 * Those two values become sweep-v2's `original/` and `current/` blocks — the
 * pair the model diffs — so any difference between them that the user did not
 * make is noise on exactly the axis the model is trained to read as "what the
 * user just changed". `getText` stops at the last line's TEXT LENGTH, before
 * its terminator; `extractLines` KEEPS terminators. Composing the two here is
 * what makes the pair agree by construction rather than by coincidence.
 *
 * The terminator is dropped only when `endLine` names a line `extractLines`
 * actually produced. When the span instead runs past the end — to the empty
 * line a trailing newline creates — `getText` stops there too, so the
 * preceding terminator is inside BOTH blocks and must stay. Dropping it
 * unconditionally would inject the same phantom difference in the other
 * direction, including for an untouched region, where the two blocks must be
 * byte-identical.
 *
 * The vendor has no such asymmetry by construction: `inference.py` assigns
 * literally the same string to both blocks, and v1's `run_model.py` passes
 * both through one join.
 */
function extractRegionRange(text: string, startLine: number, endLine: number): string {
  const lineCount = splitKeepingNewlines(text).length;
  const span = extractLines(text, startLine, endLine);
  return endLine < lineCount ? stripLineTerminator(span) : span;
}

/**
 * F-3 — would this ONE diff survive the mint's own per-field checks?
 *
 * Runs exactly what `scan.ts` runs for a `diffs[]` entry, in the same order
 * (sentinel guard, then `scanSnippetForSecrets`, throw-is-reject), against the
 * SAME `diff.filepath` string the mint will use. That identity is the whole
 * point: normalizing the path here — or checking a different predicate, e.g.
 * the active-file `isSecretForCompletion` gate — would let a diff pass this
 * filter and still abort the mint, which is the bug this closes.
 *
 * An EMPTY sentinel is deliberately not treated as a diff verdict: the mint
 * rejects the whole request for it (`ruleId=empty-sentinel`, a caller-contract
 * bug, not content), and quietly dropping every diff would hide that.
 *
 * FINAL REVIEW — FINDING 7. That identity used to be held by this comment
 * alone. Behavioural tests covered the FILTER, but nothing tied its verdict to
 * the MINT's, and the two are separate code paths that must agree exactly:
 * a diff that passes this filter while the mint still aborts fails CLOSED into
 * a silent kill — every next-edit request in every file dies at the mint with
 * the trigger's catch reporting nothing, which is the precise bug F-3 existed
 * to fix. Same shape the five duplicated line-splitters had before
 * `lineSplitDrift.lock.test.ts` tied them.
 *
 * EXPORTED ONLY for that lock (`diffEgressDrift.lock.test.ts`), mirroring
 * `scan.ts`'s own `contentChecksFor` — "Exported ONLY for the fail-closed
 * drift lock in scan.test.ts". Not part of the shell's API; no production
 * caller outside this module.
 */
export function diffMayEgress(diff: RecentDiff, sentinels: readonly string[]): boolean {
  for (const content of [diff.before, diff.after]) {
    for (const sentinel of sentinels) {
      if (sentinel.length > 0 && content.includes(sentinel)) return false;
    }
    let allowed: boolean;
    try {
      allowed = scanSnippetForSecrets({ path: diff.filepath, content }).allowed;
    } catch {
      allowed = false; // fail-closed, mirroring ringBuffer.ingest's throw-is-reject
    }
    if (!allowed) return false;
  }
  return true;
}

/**
 * F-3 — the caller-side filter that keeps ONE poisoned diff from killing the
 * whole feature.
 *
 * `getRecentDiffs()` is a CROSS-DOCUMENT ring (`editTrackerAdapter.ts`), so a
 * single edit in `.env` used to make every next-edit request in every file
 * abort at the mint (first reject aborts the whole mint) — silently, because
 * the trigger's catch reported nothing. `ringBuffer.ingest` already answers
 * this for the FIM side: DROP the offending entry, keep the feature alive
 * everywhere else.
 *
 * This does not weaken the mint and cannot: the mint still fail-closed-scans
 * everything it is handed, including these very diffs, and remains the
 * authority. This only stops the shell from handing it auxiliary context it
 * had no business collecting for egress in the first place.
 *
 * `dropped` — WHAT IT IS AND IS NOT (corrected, final review Finding 6).
 *
 * This comment used to say the count "is returned so the trigger can note it
 * once (`08` §9.3: 'scan rejects count + note once') rather than dropping in
 * silence". That was written in the present tense about something that has
 * never happened: NOTHING READS `.dropped`. The sole call site
 * (`buildAndRun`, below) destructures `.kept` and nothing else, so drops ARE
 * silent — the comment asserted the opposite of the behaviour, which is the
 * third time on this branch a wrong reason in a comment has outlived the code
 * it described.
 *
 * The silence is nonetheless CORRECT today, and the count is deliberately
 * kept. Both facts are already recorded in `08` §9.3's own addendum: the
 * "count + note once" half is "a counter, not a feature… a deliberate scope
 * cut for fix wave 1 (F-4), not an oversight; wiring the drop count into a
 * one-shot note is open for a future wave, not silently abandoned."
 *
 * Silence is also the right default on the evidence, not merely the shipped
 * one: the FIM sibling this whole design cites — `ringBuffer.ingest` — drops a
 * rejected window with a bare `return`, no report and no toast. A drop here is
 * the protection WORKING, not a failure, and every other message path in this
 * file pairs `reportFailure` with a modal `showWarningMessage`. Noting a
 * routine, correct drop through that pair would be user-hostile noise.
 *
 * Whatever a future wave does with the count, the standing constraint on it is
 * unchanged: the COUNT only — never the path, never the matched text, never
 * the content.
 */
function partitionEgressableDiffs(
  diffs: readonly RecentDiff[],
  sentinels: readonly string[],
): { kept: readonly RecentDiff[]; dropped: number } {
  const kept: RecentDiff[] = [];
  let dropped = 0;
  for (const diff of diffs) {
    if (diffMayEgress(diff, sentinels)) {
      kept.push(diff);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

/**
 * `changesAboveCursor` — DOCUMENTED HEURISTIC, not vendor behaviour.
 * `compute_prefill` takes this flag as a caller-supplied parameter and the
 * vendor reference never shows how its own host derives it (**не нашёл
 * источник**). This implementation: true when the most recent tracked diff
 * for THIS document lies entirely above the cursor line. Being wrong is
 * cosmetic-to-mild — the flag only selects which of `compute_prefill`'s two
 * branches computes the prefill, and both branches produce a legal prefill.
 *
 * C-4 — MIXED COORDINATE SPACES, deliberately. `diff.endLine` is an OLD,
 * PRE-CHANGE document coordinate (see `RecentDiff` in `./types.ts`) while
 * `cursorLine` is a CURRENT one, so this comparison is approximate by
 * construction and drifts further the more edits land after the diff was
 * recorded. That is tolerable ONLY because of the paragraph above: both
 * answers produce a legal prefill, so the imprecision is cosmetic. Do not
 * copy this comparison into any site where being wrong is not cosmetic —
 * re-base the diff first, or use a different signal.
 */
function computeChangesAboveCursor(
  diffs: readonly RecentDiff[],
  uri: string,
  cursorLine: number,
): boolean {
  const mostRecent = diffs.find((diff) => diff.uri === uri);
  return mostRecent !== undefined && mostRecent.endLine < cursorLine;
}

/**
 * Assembles `ContentChangeLite[]` from a raw change event.
 *
 * ORDERING CONTRACT (`anchors.ts`): `remapRange` does NOT re-sort — whoever
 * assembles its input must resolve delivery order FIRST. VS Code gives no
 * ordering guarantee for a multi-part `contentChanges` array
 * (microsoft/vscode#11487), and every `change.range` is expressed in the
 * OLD/pre-change document, so this mirrors `editTrackerAdapter.ts`'s
 * established descending sort (highest start position first): applying a
 * HIGHER change first never shifts the line numbers a LOWER, not-yet-applied
 * change still refers to. The source array is readonly — copy before sorting.
 */
function toContentChangeLites(
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): ContentChangeLite[] {
  return [...changes]
    .sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    })
    .map((change) => ({
      startLine: change.range.start.line,
      endLine: change.range.end.line,
      // Replacing the inclusive span [start, end] with text carrying N
      // newlines yields N+1 lines.
      newLineCount: (change.text.match(/\n/g) ?? []).length + 1,
    }));
}

// ─────────────────────────────── registration ────────────────────────────────

/**
 * Wires next-edit into VS Code. Called from `index.ts` beside
 * `registerTalariaAutocomplete`, with a Guard already hydrated from
 * `context.globalState`.
 */
export function registerTalariaNextEdit(
  context: vscode.ExtensionContext,
  guard: NextEditGuard,
  deps: NextEditShellDeps,
): vscode.Disposable {
  let disposed = false;
  let state: NextEditFsmState = { kind: 'idle' };
  /** The document version the live proposal is anchored to. `null` when idle.
   *  This is the freshness token the Global Constraints keep in the shell. */
  let trackedVersion: number | null = null;
  /** The next-edit request in flight, if any. Aborted by a FIM start (R2) and
   *  by the next next-edit trigger (single-flight). NEVER the reverse: this
   *  module holds no FIM cancellation handle at all. */
  let inFlight: AbortController | null = null;

  /**
   * R2's view of what FIM is doing. `inFlightCount` is a REFCOUNT, not a
   * flag, and that distinction is load-bearing: VS Code invokes
   * `provideInlineCompletionItems` concurrently — it cancels the superseded
   * token, but that invocation still runs to its own `finally`, which fires
   * the paired `resultShown` (`provider.ts`). So the ORDINARY keystroke
   * sequence is `requestStarted(#2)` and only then `resultShown(#1)`. A
   * boolean would be cleared by #1's late settle while #2 was genuinely in
   * flight, opening GATE 2 and letting next-edit build a request during a
   * live FIM request — precisely what R2 forbids. Counting makes "FIM is
   * idle" mean what it says: every started request has settled.
   */
  const fim = { visible: false, inFlightCount: 0 };
  /** GATE 2's predicate, and the same one the post-round-trip freshness
   *  re-check uses — one definition so the two can never drift apart. */
  function fimBusy(): boolean {
    return fim.visible || fim.inFlightCount > 0;
  }
  const debouncer = new AutocompleteDebouncer();

  /**
   * CF-20-lazy — `createEditTrackerAdapter()` is next-edit's HALF of two
   * complete edit-tracking pipelines that used to run on the keystroke hot
   * path regardless of whether next-edit was ever reachable: it subscribes
   * to `onDidChangeTextDocument`/`onDidChangeVisibleTextEditors` and folds
   * every edit into a live diff ring plus a per-document shadow-text cache
   * (`editTrackerAdapter.ts`). A user who never enables EITHER next-edit
   * toggle used to pay that cost forever, for a feature that GATE 1 below
   * refuses to even build a request for. FIM's own tracker
   * (`context/contextService.vscode.ts`) is a wholly separate instance and
   * is unaffected by this — that half was never gated by these toggles.
   *
   * Deferred to the Guard's FIRST toggle-on and memoized: built at most
   * once per registration, and every later toggle reuses the same instance
   * rather than rebuilding it.
   *
   * Why this reads `ToggleState` (via `guard.getState()` / the change
   * listener's own argument) and resolves it with `resolveNextEditMode`
   * rather than calling `guard.getMode()`: the read-through-hazard source
   * lock further down this file (`shell.vscode.test.ts`, "the trigger
   * snapshots the mode ONCE") pins `guard.getMode()` to EXACTLY one call
   * site, inside `trigger()`. A second call site here would trip it, and
   * would also (for the reason that lock exists) risk answering
   * differently mid-flight from the read `trigger()` already took.
   */
  let editTrackerInstance: EditTrackerAdapter | null = null;
  function ensureEditTracker(): EditTrackerAdapter {
    if (editTrackerInstance === null) {
      editTrackerInstance = createEditTrackerAdapter();
    }
    return editTrackerInstance;
  }
  function buildEditTrackerOnToggleOn(toggles: ToggleState): void {
    if (resolveNextEditMode(toggles.next, toggles.generic) !== 'off') {
      ensureEditTracker();
    }
  }
  // Covers a Guard hydrated ALREADY on (state persisted from a previous
  // session) — no `onDidChange` event fires this session in that case, so
  // without this check the adapter would never be built at all and
  // next-edit would run silently inert (no pre-edit shadow, an always-empty
  // diff ring) until the user toggled it off and back on.
  buildEditTrackerOnToggleOn(guard.getState());
  const guardToggleSubscription = guard.onDidChange(buildEditTrackerOnToggleOn);

  /**
   * F-4 — the one-shot failure surface, mirroring `provider.ts`'s
   * `surfacedAutocompleteFailures` + `surfaceIfFirst` pair rather than
   * inventing a second mechanism. `08` §9.3: transport-guard refusals
   * "surface once (actionable)".
   *
   * REGISTRATION-scoped, not module-scoped, which is the one deliberate
   * difference from the FIM side: `registerTalariaNextEdit` IS next-edit's
   * re-arm point (a fresh registration re-arms every warning), so no
   * `clearSurfaced…` export is needed and no state leaks between activations.
   * A config-change re-arm was considered and rejected: it would need an
   * `onDidChangeConfiguration` subscription, and the shell's own coexistence
   * lock suite constructs it against a fake `vscode` that has no such API.
   *
   * No timers, no counters, no state beyond this Set.
   */
  const surfacedFailures = new Set<string>();
  function surfaceOnce(key: string, message: string): void {
    if (surfacedFailures.has(key)) return;
    surfacedFailures.add(key);
    deps.reportFailure(message);
    void vscode.window.showWarningMessage(message);
  }

  // Two decoration types, created ONCE for the whole activation.
  const regionDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  });
  const locatorDecoration = vscode.window.createTextEditorDecorationType({});

  function editorFor(uri: string): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    return active !== undefined && active.document.uri.toString() === uri ? active : undefined;
  }

  const executorHost: NextEditExecutorHost = {
    setContext(key, value) {
      void vscode.commands.executeCommand('setContext', key, value);
    },
    showDecorations(p, jumped) {
      const editor = editorFor(p.region.uri);
      // F-1: DECLINE rather than silently no-op. The executor turns a declined
      // paint into a full `clearAll`, so `jumpVisible` can never stand up
      // against an empty screen (and Tab can never be stolen in a file that
      // has no proposal).
      if (editor === undefined) return false;
      const regionRange = new vscode.Range(p.region.startLine, 0, p.region.endLine, 0);
      editor.setDecorations(regionDecoration, [regionRange]);

      // U-7 — the SPAN, in the 1-based coordinates the gutter shows, not a
      // "distance". `regionAroundCursor` returns cursor ± windowLines, so the
      // old `|startLine − cursorLine|` was the CONSTANT `windowLines` for
      // every proposal past line 10, and its `⤵` pointed DOWN at a region
      // that starts ten lines ABOVE the cursor. This says something the user
      // can check against their own gutter.
      const firstLine = p.region.startLine + 1;
      const lastLine = p.region.endLine + 1;
      const verb = jumped ? 'Tab to accept' : 'Tab to jump';
      const lineLength = editor.document.lineAt(p.cursorLine).text.length;
      // Zero-width end-of-line range on the CURSOR line — the locator rides
      // where the user is looking, not where the edit is.
      const locatorRange = new vscode.Range(p.cursorLine, lineLength, p.cursorLine, lineLength);
      editor.setDecorations(locatorDecoration, [
        {
          range: locatorRange,
          renderOptions: {
            after: {
              // U-7: `08` §10 pins this copy as `⤵ N lines · <verb> · Esc to
              // dismiss`. The verb and the Esc clause are kept verbatim; the
              // leading clause is the one the final review found to be
              // untrue in every case, so it now reports the span instead of a
              // constant. `⇕` because the region brackets the cursor (it is
              // cursor ± windowLines) — it never lies below it, which is what
              // `⤵` claimed. Visual separation from the code is `margin`'s
              // job, never padding baked into the string.
              contentText: `⇕ lines ${firstLine}–${lastLine} · ${verb} · Esc to dismiss`,
              margin: '0 0 0 1em',
              color: new vscode.ThemeColor('editorGhostText.foreground'),
            },
          },
        },
      ]);
      return true;
    },
    clearDecorations() {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(regionDecoration, []);
        editor.setDecorations(locatorDecoration, []);
      }
    },
    reveal(range) {
      // F-1: `range` is bare line geometry — it carries no uri of its own, so
      // an unqualified `activeTextEditor` would happily scroll a FOREIGN file
      // to line numbers taken from the proposal's document. The live proposal
      // is the range's only owner (`reveal` is emitted solely by
      // `proposed × tabJump`, whose `p` is the state the shell already holds),
      // so resolve the editor through the SAME `editorFor` identity check the
      // paint uses — one definition, so the two cannot drift.
      const proposal = currentProposal();
      const editor = proposal === null ? undefined : editorFor(proposal.region.uri);
      if (editor === undefined) return;
      editor.revealRange(
        new vscode.Range(range.startLine, 0, range.endLine, 0),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    },
    async applyEdit(region, newText) {
      // A plain WorkspaceEdit — never the ACP diff-decision gate (Global
      // Constraints). This is the user's own accepted edit in their own
      // editor, not an agent-proposed change needing approval.
      const editor = editorFor(region.uri);
      if (editor === undefined) return false;
      const document = editor.document;
      const endLine = Math.min(region.endLine, document.lineCount - 1);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(region.startLine, 0, endLine, document.lineAt(endLine).text.length),
        newText,
      );
      return vscode.workspace.applyEdit(edit);
    },
    note(msgId) {
      const message = NOTE_MESSAGES[msgId] ?? `Next Edit: ${msgId}`;
      deps.reportFailure(message);
      void vscode.window.showWarningMessage(message);
    },
  };

  const executor = makeExecutor(executorHost, (ok) => dispatch({ kind: 'applyResult', ok }));

  function currentProposal(): AnchoredProposal | null {
    return state.kind === 'idle' ? null : state.p;
  }

  function dispatch(event: NextEditFsmEvent): void {
    if (disposed) return;
    const next = reduceNextEdit(state, event);
    state = next.state;
    if (state.kind === 'idle') {
      trackedVersion = null;
    }
    executor.run(next.effects);
  }

  /**
   * F-4 — classify ONE trigger failure into a message the user can act on, or
   * into deliberate silence.
   *
   * Every string built here is assembled from status/statusText, the transport
   * id, the endpoint HOST and the model name — never `err.message` (which can
   * carry the raw url, and with it userinfo credentials), never a response
   * body, never an API key, never matched secret text. `08` §9.3's third
   * clause is honoured too: parse/apply failures dismiss silently and never
   * reach here at all (they are verdicts, not throws).
   */
  function surfaceTriggerFailure(err: unknown, route: NextEditRoute, mode: NextEditMode): void {
    const where = endpointLabel(route.apiBase);
    const endpointSetting =
      mode === 'next' ? '"talaria.nextEdit.endpoint"' : '"talaria.autocomplete.endpoint"';
    const modelSetting = mode === 'next' ? '"talaria.nextEdit.model"' : '"talaria.autocomplete.model"';
    const key = (statusClass: string): string => `${route.transport}|${where}|${statusClass}`;

    if (err instanceof InsecureTransportError) {
      // Rebuild the copy — never echo the throw site, which names the scheme,
      // the raw url and "(CWE-319)". Same discipline as `provider.ts`'s
      // insecure-transport arm.
      surfaceOnce(
        key('insecure-transport'),
        'Next Edit is paused: refusing to send credentials over cleartext HTTP to a remote host. Use https, or point the endpoint at a loopback address (127.0.0.1/localhost).',
      );
      return;
    }

    if (err instanceof BackendHttpError) {
      if (err.status === 404) {
        surfaceOnce(
          key('model'),
          `Next Edit is paused: the ${route.transport} server at ${where} does not serve the model "${route.model}" (404). Check ${modelSetting}.`,
        );
        return;
      }
      if (err.status === 401 || err.status === 403) {
        surfaceOnce(
          key('auth'),
          `Next Edit is paused: the ${route.transport} server at ${where} rejected the request (${err.status} ${err.statusText}). Check that ${endpointSetting} points at a server this machine is authorized to use.`,
        );
        return;
      }
      if (err.status === 400) {
        surfaceOnce(
          key('dialect'),
          `Next Edit is paused: the server at ${where} rejected the request (${err.status} ${err.statusText}). This usually means the configured transport doesn't match the server's API dialect — it can also mean the prompt exceeded the server's context length.`,
        );
        return;
      }
      surfaceOnce(
        key('http'),
        `Next Edit is paused: the ${route.transport} server at ${where} returned ${err.status} ${err.statusText}. Check ${endpointSetting}.`,
      );
      return;
    }

    // V-1 fix — the misdiagnosis half. A mint rejection is thrown BEFORE any
    // request is built or sent (`scan.ts`'s `mintScannedNextEditRequest`),
    // so it must never fall into the generic "the request... failed... check
    // that the server is running" copy below — that used to send the user to
    // debug healthy infra for a request that was never sent. Names the real
    // cause (a scan rule) and nothing else — never the matched content,
    // never the endpoint, and deliberately never the word "server" either:
    // this message must not even RESEMBLE the unreachable-fallback's
    // server-blame copy, which is exactly the misdiagnosis this arm exists
    // to prevent. Dedup key includes `ruleId` so a secret-rule skip and a
    // rare oversize skip each surface once, independently.
    if (err instanceof NextEditMintRejectionError) {
      surfaceOnce(
        key(`mint|${err.ruleId}`),
        `Next Edit skipped for this file: its content cannot be sent safely (rule: ${err.ruleId}). No request was sent.`,
      );
      return;
    }

    // Everything else — a connection refusal or DNS failure (a mint
    // rejection is handled by the arm above, before this fallback, so it can
    // no longer reach here). ARCH's F-4 named "a wrong endpoint" specifically:
    // without this arm a typo'd port is indistinguishable from a feature
    // that simply never has anything to suggest. One message per
    // transport/host/class per registration, so a permanently-down server
    // costs exactly one toast.
    surfaceOnce(
      key('unreachable'),
      `Next Edit is paused: the request to the ${route.transport} server at ${where} failed. Check ${endpointSetting}, and that the server is running.`,
    );
  }

  function abortInFlight(): void {
    if (inFlight !== null) {
      inFlight.abort();
      inFlight = null;
    }
  }

  // ── the ONE trigger path ───────────────────────────────────────────────────

  /**
   * The gates run IN ORDER — this is a sequence, not a set. A later gate is
   * never reachable when an earlier one would have stopped the trigger, which
   * is what keeps the cheapest and most security-relevant checks (is the
   * capability even on? is FIM busy?) ahead of anything that touches the
   * document.
   */
  async function trigger(): Promise<void> {
    // GATE 1 — mode. The Guard is the ONLY authority; nothing here reads the
    // store or a config boolean (there is none).
    const mode = guard.getMode();
    if (mode !== 'next' && mode !== 'generic') return;

    // GATE 2 — R2: FIM idle. Next-edit may not even BUILD a request while FIM
    // has ghost text on screen OR a request in flight.
    if (fimBusy()) return;

    // GATE 2b (F-2) — next-edit's OWN surface is idle. R2's shape applied to
    // this feature's own decorations: do not even BUILD a request while a
    // proposal is displayed.
    //
    // Why this and not "model `proposed × proposalReady` as a replacement in
    // the FSM": T10's reducer treats every unmodeled combination as
    // `idle + clearAll` (`08` §7.6 — a SAFE DEFAULT, not a designed
    // behaviour), and `08` specifies no replacement semantics anywhere. So a
    // proposal on screen plus a debounced edit destroyed BOTH — the live
    // proposal AND the fresh one that had just been paid for. Gating here
    // leaves the displayed proposal to be re-anchored by `docChanged` (which
    // is what `remapRange` is for) and skips a wasted round trip; the FSM's
    // reviewed pure core is left exactly as T10 shipped it.
    //
    // A gate, not a stop: `esc`, an overlapping edit, a focus loss, an editor
    // switch and an accept all return the state to `idle`, and the very next
    // edit burst triggers normally.
    if (state.kind !== 'idle') return;

    // NOT a gate — the two steps the gate sequence is INTERRUPTED by, named
    // explicitly because the brief pins the order mode → FIM → trust →
    // scheme → secret and this sits between gates 2 and 3.
    //
    // Why it is safe HERE rather than after GATE 5: neither step reads a
    // single byte of the document. The editor lookup only resolves WHICH
    // document is current (its content is read further down, after every
    // gate has passed), and `resolveRoute` reads configuration only —
    // endpoint/model/backend, and (W5.2 Task 2) the FIM key for the generic
    // branch — never `document`. Reading the key here is not egress: it is
    // copied into a local route object, and the single construction site that
    // hands it to a backend still sits strictly BELOW the trust gate, where it
    // has always been. Nothing security-relevant
    // can therefore happen ahead of the trust, scheme or secret gates; both
    // are pure "is there anything to do at all?" checks, and doing them
    // early only means bailing out sooner. Do NOT add a step here that
    // touches the document — that belongs below GATE 5.
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) return;
    const document = editor.document;

    // F-5 / C-5 — a route that cannot be built is REPORTED (once) when the
    // user can do something about it, instead of returning into silence while
    // the panel row still reads as if the source were running.
    const resolution = resolveRoute(mode, deps);
    if (resolution.kind === 'next-model-unset') {
      surfaceOnce('next-model-unset', NEXT_EDIT_MODEL_UNSET_NOTE);
      return;
    }
    if (resolution.kind === 'generic-unsupported-backend') {
      surfaceOnce(
        `generic-unsupported-backend|${resolution.fimBackend}`,
        genericUnsupportedBackendMessage(resolution.fimBackend),
      );
      return;
    }
    if (resolution.kind !== 'route') return;
    const route = resolution.route;

    // B.2 tripwire. NEXT deliberately has NO credential (ADR-014): the shipped
    // matrix is a local GGUF import on a loopback endpoint, so there is nothing
    // to authenticate to. The one observation that would reopen that decision
    // is a NEXT route pointing off-box — and `remote` is ALREADY computed, so
    // reporting it costs one line and turns a speculative question into an
    // observed event. This is an observation, not a warning: it does not gate,
    // block, or refuse anything.
    if (mode === 'next' && route.remote) {
      surfaceOnce(
        'next-remote-endpoint',
        'Next Edit is using a REMOTE endpoint for its dedicated model (talaria.nextEdit.endpoint). ' +
          'Next Edit sends no credential of its own. If this endpoint requires authentication, say so — ' +
          'it would need its own key, never the autocomplete key.',
      );
    }

    // GATE 3 — trust. Read unconditionally (not short-circuited behind
    // `route.remote`) so reaching this gate is observable.
    const trusted = vscode.workspace.isTrusted;
    if (route.remote && !trusted) return;

    // GATE 4 — scheme filter, mirroring `provider.ts`.
    if (document.uri.scheme === 'vscode-scm' || document.uri.scheme === 'output') return;

    // GATE 5 — secret-path skip, FIM parity (`08` §9.3). Secret-scan is NOT
    // inherited: this is the ACTIVE-FILE gate, and the request-level mint
    // below is the separate content-level backstop.
    const fsPathLike = (document.uri.path ?? document.uri.fsPath ?? '').replace(/\\/g, '/');
    if (isSecretForCompletion(fsPathLike)) return;

    const cursor = editor.selection.active;
    const uri = document.uri.toString();
    const span = regionAroundCursor(cursor.line, document.lineCount, route.format.windowLines);
    const regionEndLength = document.lineAt(span.endLine).text.length;
    const regionContent = document.getText(
      new vscode.Range(span.startLine, 0, span.endLine, regionEndLength),
    );
    const docText = document.getText();
    const preEditDocText = ensureEditTracker().getPreEditText(uri) ?? null;
    // C-3 / ADR-018 — `preEditRegion` is extracted from the FULL pre-edit
    // text, BEFORE windowing. The region and the doc-level window are
    // independent (exactly as in the vendor script: `block` is ±10 lines,
    // `initial_file` is ±150 — two separate slots, not one derived from the
    // other), so this must not move below the V-1 windowing step.
    const preEditRegion =
      preEditDocText === null ? null : extractRegionRange(preEditDocText, span.startLine, span.endLine);
    // V-1 fix — bound the doc-level context to a SCANNED window around the
    // cursor (vendor-conformant ±150 lines, `fileWindow.ts`) instead of the
    // whole file. This happens strictly BEFORE `mintScannedNextEditRequest`
    // below: the mint itself, and every field it scans, is UNCHANGED — this
    // only shrinks WHAT the fields carry, never WHO scans them.
    // `windowAroundCursor` clamps `cursorLine` internally, so the same
    // `cursor.line` (a CURRENT-document coordinate) is safe to pass for the
    // pre-edit shadow too, even though that text may have a different line
    // count.
    const docWindow = windowAroundCursor(docText, cursor.line, DEFAULT_FILE_WINDOW_OPTIONS);
    const preEditWindow =
      preEditDocText === null ? null : windowAroundCursor(preEditDocText, cursor.line, DEFAULT_FILE_WINDOW_OPTIONS);
    // F-3 — the ring is cross-document, so it is filtered HERE, before the
    // mint ever sees it. `changesAboveCursor` reads the same kept list, so the
    // structural heuristic and the egressing payload describe one history.
    const ringDiffs = partitionEgressableDiffs(
      ensureEditTracker().tracker.getRecentDiffs(),
      route.format.sentinels,
    );
    const diffs = ringDiffs.kept;
    const docVersion = document.version;

    const region: EditableRegion = {
      uri,
      filepath: toWorkspaceRelativePosixPath(document.uri),
      startLine: span.startLine,
      endLine: span.endLine,
      content: regionContent,
    };

    const request: NextEditRequest = {
      model: route.model,
      cursor: { uri, line: cursor.line, character: cursor.character },
      region,
      preEditRegion,
      fileContext: ensureTrailingNewline(docWindow.text),
      docText: docWindow.text,
      preEditDocText: preEditWindow?.text ?? null,
      changesAboveCursor: computeChangesAboveCursor(diffs, uri, cursor.line),
      diffs,
      docVersion,
    };

    const renderResult = route.format.render(request);
    if (renderResult.kind === 'skip') return;
    const rendered = renderResult.prompt;

    const controller = new AbortController();
    abortInFlight();
    inFlight = controller;

    try {
      // The brand comes from CALLING the one sanctioned mint — it throws
      // fail-closed (ruleId only, never the matched text) if any egressing
      // content field carries a secret or a format sentinel.
      const scanned = mintScannedNextEditRequest(request, route.format.sentinels);

      const backend = new NextEditHttpBackend({
        transport: route.transport,
        apiBase: route.apiBase,
        model: route.model,
        sentinels: route.format.sentinels,
        // `undefined` for the NEXT branch, by construction (see NextEditRoute).
        apiKey: route.apiKey,
      });

      const output = await backend.predict(scanned, rendered, controller.signal);
      if (controller.signal.aborted || disposed) return;

      // CONTRACT (`formats/*`): `parse` trusts that `rendered` and `request`
      // are a MATCHED pair — it cannot detect a mismatch. Both locals below
      // come from this one call, and nothing reassigns them.
      const verdict = route.format.parse(output, rendered, request);
      if (verdict.kind !== 'rewrite') return;

      // Freshness re-check: the document must not have moved under the
      // request, and FIM must STILL be idle (R2 covers the whole round trip,
      // not just its start).
      if (document.version !== docVersion) return;
      if (fimBusy()) return;
      // F-1 — IDENTITY re-check, the third freshness dimension. `version` only
      // answers "did THIS document change?"; it says nothing about whether the
      // user is still looking at it. Switching files mid-round-trip moves
      // neither the version nor `fimBusy()`, so without this the proposal
      // lands for a document that is no longer on screen: `jumpVisible` goes
      // up with zero decorations anywhere and Tab is hijacked in the file the
      // user actually has open. Same `editorFor` predicate the paint uses.
      if (editorFor(uri) === undefined) return;

      trackedVersion = docVersion;
      dispatch({
        kind: 'proposalReady',
        p: {
          region: verdict.region,
          newText: verdict.newText,
          docVersion,
          cursorLine: cursor.line,
        },
      });
    } catch (err) {
      // Aborts are the common case here and are not failures: R2 aborts every
      // in-flight prediction the moment FIM starts, and each new trigger
      // aborts its predecessor. Those must stay silent.
      if (controller.signal.aborted || disposed) return;
      // F-4 — everything else is surfaced ONCE and actionably (`08` §9.3).
      // The old bare catch swallowed all of it, so a CWE-319 refusal, a wrong
      // endpoint or a 404-ing model left next-edit dead for the whole session
      // with no signal anywhere. A toast per keystroke would indeed be worse
      // than a missing suggestion, which is exactly what `surfaceOnce` is for.
      surfaceTriggerFailure(err, route, mode);
    } finally {
      if (inFlight === controller) {
        inFlight = null;
      }
    }
  }

  function armTrigger(): void {
    void debouncer.delayAndShouldDebounce(TRIGGER_DEBOUNCE_MS).then(
      (superseded) => {
        if (superseded || disposed) return undefined;
        return trigger();
      },
      () => undefined,
    );
  }

  // ── listeners ──────────────────────────────────────────────────────────────

  /**
   * Held under its own name so `dispose()` below can prove it still OWNS the
   * module-level relay slot before clearing it — `currentFimActivity` is a
   * single shared slot, and a newer registration may already have taken it.
   */
  const fimActivity: FimActivityListener = {
    requestStarted() {
      fim.inFlightCount += 1;
      try {
        // R2, the direction that matters: FIM-start aborts next-edit. Never
        // the reverse — nothing in this module can cancel a FIM request.
        abortInFlight();
        dispatch({ kind: 'fimVisibility', visible: true });
      } catch {
        // Must not escape this call: `provider.ts` sets its own
        // `fimRequested` flag only AFTER `requestStarted()` returns, and
        // only a set flag makes its `finally` call the paired
        // `resultShown` later. A throw here (e.g. `dispatch()` reaching a
        // throwing host) would skip that flag and strand the increment
        // above forever — unlike the boolean this refcount replaced, it
        // does not self-heal on the next FIM cycle. The count's integrity
        // matters more than reporting whatever failed downstream.
      }
    },
    resultShown(hasItem: boolean) {
      if (fim.inFlightCount === 0) {
        // UNPAIRED settle: a settle whose `requestStarted` was delivered to
        // a PREVIOUS registration (the relay swapped while that request was
        // in flight), or a stray duplicate — either way nothing of ours is
        // outstanding to count out. Complete no-op: touching `visible` here
        // could silently clear a GENUINELY visible ghost-text flag set by a
        // real, unrelated request, reopening GATE 2 against R2.
        return;
      }
      fim.inFlightCount -= 1;
      // SUPERSEDED settle — a NEWER FIM request is still in flight, so this
      // result speaks for a request VS Code has already cancelled and whose
      // item it discarded. It may not report on visibility at all: the
      // newest request is the one that gets to settle that, and until it
      // does the refcount above holds GATE 2 closed on its own. Treating a
      // stale settle as authoritative is what let a boolean `visible` be
      // cleared out from under a live FIM request.
      if (fim.inFlightCount > 0) return;
      // Conservative visibility: a non-null item COUNTS as on screen, even
      // though VS Code may still decline to render it.
      fim.visible = hasItem;
      dispatch({ kind: 'fimVisibility', visible: hasItem });
    },
    accepted() {
      // The ghost text was consumed, so FIM is no longer on screen — and this
      // is the R4 seam: the post-FIM-accept moment is exactly when a next
      // edit is most likely to exist.
      //
      // The refcount is deliberately NOT zeroed here. `provider.ts` pairs
      // every `requestStarted` with a `resultShown` in its own `finally`, so
      // the request that produced this accepted item has already been counted
      // out; any count still standing belongs to a LATER request that is
      // genuinely in flight. Zeroing it would discard that and reopen GATE 2
      // against R2 — the armed trigger below simply waits for it instead.
      fim.visible = false;
      dispatch({ kind: 'fimVisibility', visible: false });
      armTrigger();
    },
    // Safe to answer unconditionally: this object only ever reaches the relay
    // AFTER the command below is registered (see the attach site at the end of
    // this function), and it leaves the relay when this registration disposes.
    acceptCommandId: () => FIM_ACCEPT_COMMAND,
  };

  const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
    // CF-19 — GATE-4 parity: a non-recordable scheme (Output/SCM/etc.) must
    // not arm anything at all. Before this guard, `armTrigger()` ran
    // unconditionally on EVERY `onDidChangeTextDocument` event regardless of
    // which document changed, so edit-burst noise from an unrelated
    // Output/SCM document could arm (and eventually fire) a next-edit
    // request against the CURRENT active editor — a document GATE-4 would
    // separately have to be scheme-valid on its own, but the arm itself
    // never checked the document that actually changed.
    if (!isRecordableScheme(e.document.uri.scheme)) return;

    // Source 2 of the ONE trigger path: the debounced edit burst. Armed
    // unconditionally (once past the scheme guard above) — `trigger()`
    // itself resolves which editor/document is current, so no editor lookup
    // is needed (or wanted) this early.
    armTrigger();

    const proposal = currentProposal();
    if (proposal === null || proposal.region.uri !== e.document.uri.toString()) return;

    if (e.contentChanges.length === 0) {
      // A metadata-only event (dirty-flag, EOL, save) still bumps `version`.
      // Nothing textual moved, so re-baseline instead of dismissing.
      trackedVersion = e.document.version;
      return;
    }

    if (trackedVersion === null || e.document.version !== trackedVersion + 1) {
      // Versions skipped ⇒ at least one change event never reached us, so the
      // changes in hand cannot describe the full delta. Fail closed.
      dispatch({ kind: 'docChanged', remapped: null });
      return;
    }

    const remapped = remapRange(
      { startLine: proposal.region.startLine, endLine: proposal.region.endLine },
      toContentChangeLites(e.contentChanges),
    );
    trackedVersion = e.document.version;
    dispatch({ kind: 'docChanged', remapped });
  });

  const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
    // C-6 — the one clearer `fim.visible` can safely have. Esc on ghost text
    // is unobservable on the stable API, so nothing but the NEXT FIM request
    // settling ever lowered this flag; disable FIM in between and GATE 2 stays
    // shut for the rest of the session with no ghost text on screen at all.
    //
    // Why THIS event and not `onDidChangeTextDocument`: an inline suggestion
    // is painted into ONE editor and cannot outlive it being switched away
    // from, so clearing here cannot let next-edit build against ghost text
    // that is genuinely on screen. A document change would be the wrong
    // signal — the ordinary keystroke path fires it BEFORE FIM's provider is
    // invoked, so it would reopen the gate in exactly the window R2 exists to
    // close.
    //
    // `inFlightCount` is deliberately NOT touched: a FIM request in flight
    // survives an editor switch, and it alone must keep the gate shut.
    fim.visible = false;
    dispatch({ kind: 'editorChanged' });
  });

  const windowStateSubscription = vscode.window.onDidChangeWindowState((windowState) => {
    if (!windowState.focused) {
      dispatch({ kind: 'focusLost' });
    }
  });

  // ── commands (registered ONCE) ─────────────────────────────────────────────

  const jumpCommand = vscode.commands.registerCommand('talaria.nextEdit.jump', () => {
    dispatch({ kind: 'tabJump' });
  });
  const acceptCommand = vscode.commands.registerCommand('talaria.nextEdit.accept', () => {
    dispatch({ kind: 'tabAccept' });
  });
  const dismissCommand = vscode.commands.registerCommand('talaria.nextEdit.dismiss', () => {
    dispatch({ kind: 'esc' });
  });
  // The R4 seam: fired by the InlineCompletionItem's own `command`, which VS
  // Code executes when the user ACCEPTS the FIM ghost text.
  const onFimAcceptCommand = vscode.commands.registerCommand(FIM_ACCEPT_COMMAND, () => {
    fimActivityRelay.accepted();
  });

  // ATTACH LAST. `fimActivity.acceptCommandId()` advertises FIM_ACCEPT_COMMAND
  // to `provider.ts`, so the relay may not point here until that command is
  // actually registered — which is the line above. Ordering it this way makes
  // "an advertised command is a registered command" structural rather than a
  // property of where the assignment happened to sit.
  currentFimActivity = fimActivity;

  const disposable = vscode.Disposable.from(
    changeSubscription,
    activeEditorSubscription,
    windowStateSubscription,
    jumpCommand,
    acceptCommand,
    dismissCommand,
    onFimAcceptCommand,
    guardToggleSubscription,
    regionDecoration,
    locatorDecoration,
    {
      dispose: () => {
        disposed = true;
        abortInFlight();
        // CF-20-lazy: the adapter may never have been built at all (both
        // toggles stayed off for the whole registration) — `?.` rather than
        // an unconditional `.dispose()`.
        editTrackerInstance?.dispose();
        // BF-B's liveness idiom (`SessionController.ts`'s `disposed` re-check),
        // applied to a MODULE-level slot: clear the relay only while THIS
        // registration still owns it. Disposing a registration that a newer
        // one already replaced must not point the relay back at the no-op —
        // that would silently disarm R2 for the shell that is actually live.
        if (currentFimActivity === fimActivity) {
          currentFimActivity = NO_OP_FIM_ACTIVITY;
        }
      },
    },
  );

  context.subscriptions.push(disposable);
  return disposable;
}
