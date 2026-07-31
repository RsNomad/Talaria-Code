import * as vscode from 'vscode';
import type { FimEngine } from './engine';
import { processSingleLineCompletion } from './singleLine';
import type { FimContext } from './types';
// W6-FC (final-3way-arch.md I-6): import the pure classifier directly from
// `shared/secretPaths.ts` rather than reaching up into `host/backend/policy`
// — this file is an autocomplete leaf, not a host-policy consumer.
import { isSecretForCompletion } from '../shared/secretPaths';
import { CrossFileContextService, egressPreconditionsMet } from './context/contextService';
import { isTriggerableScheme } from './context/recordableScheme';
// A5: the typed errors this file's catch block narrows on.
import { BackendHttpError, BackendStreamError } from './backends/http';
import { InsecureTransportError } from './backends/secureTransport';
// Review C-1: the request-side refusal CodestralFimBackend.streamFim throws
// for a keyless build — see that file's doc comment.
import { MissingApiKeyError } from './backends/CodestralFimBackend';
// Task 16 (08 §11, ADR-010): the unknown-model signal — see the polarity
// check in `provideInlineCompletionItems` below.
import { isKnownFimModel } from './templates';

/**
 * A5: the `Set API Key` action label shown on the 401/403 warning
 * (jobA-common.md invariant 3/5 — no key/response body ever appears here,
 * only this fixed string) and the one value {@link
 * TalariaInlineCompletionProvider}'s `showWarningMessage` handler checks for
 * before invoking `talaria.setAutocompleteApiKey`.
 */
const SET_API_KEY_ACTION = 'Set API Key';

/**
 * Task 16 (`08` §11, ADR-010) — FROZEN owner-approved copy (Global
 * Constraints; `09-jobB-final-plan.md` lines 87-89). Character-for-character,
 * including the `{model}` interpolation point — do not improve the wording.
 *
 * T7 (final-review remediation, code finding I-1, 2026-07-25,
 * owner-ratified): the example model tag was changed from the bare
 * `qwen2.5-coder:7b` to `qwen2.5-coder:7b-base`. On Ollama the bare `:7b`
 * tag resolves to the INSTRUCT build (shares digest `dae161e27b0e` with
 * `:7b-instruct`); the base, FIM-capable artifact is the distinct
 * `:7b-base` tag (digest `bd8755145f1c`) — confirmed live against
 * https://ollama.com/library/qwen2.5-coder/tags. This change was already
 * ratified for every other surface in the repo. This is
 * the ONE authorized exception to "do not improve the wording" above: the
 * model-tag example only, nothing else in either string changes.
 *
 * Polarity (the crux of this task, ground truth `08` §11):
 * - `WARN_MSG`: unknown model on a `nativeFim: true` backend (Ollama,
 *   llama.cpp, Codestral, openai-compat — the server renders its own
 *   template). The only foreign contribution from an unrecognized name is
 *   the client-side fallback stop list, so this warns once and PROCEEDS.
 * - `REFUSE_MSG`: unknown model on `vllm` — the sole `nativeFim: false`
 *   backend (`VllmFimBackend.ts:33`), where `FimEngine` itself renders
 *   `<fim_prefix>`-style literals into the prompt (`engine.ts:124-126`).
 *   Guessing that format for a model Hermes doesn't recognize produces
 *   silently wrong bytes — this warns once and REFUSES (returns null,
 *   never reaches the engine).
 */
const WARN_MSG = (model: string): string =>
  `Talaria autocomplete: unrecognized model "${model}". Talaria has no prompt template for this model and will fall back to a generic FIM format — completions may be malformed or silently wrong. Officially supported: qwen2.5-coder (for example "qwen2.5-coder:7b-base").`;

const REFUSE_MSG = (model: string): string =>
  `Talaria autocomplete is paused: unrecognized model "${model}". The vllm backend needs Talaria to build the model-specific FIM prompt itself, and guessing the format would produce silently wrong completions. Set "talaria.autocomplete.model" to a supported model (for example "qwen2.5-coder:7b-base").`;

/**
 * A5: one-shot dedup for the actionable autocomplete failures
 * (`InsecureTransportError`, `MissingApiKeyError`, a 401/403 auth rejection,
 * a 400 dialect mismatch) — module-level (spans every completion request, every
 * provider instance) so a failing config is surfaced ONCE, not on every
 * keystroke. Keyed `${backend}|${endpointHost}|${statusClass}`. Cleared by
 * {@link clearSurfacedAutocompleteFailures}, which `index.ts`'s `rebuild()`
 * calls on every config change — so fixing the key/endpoint re-arms the
 * warning instead of going silent forever. No timers, no state beyond this
 * Set (A5 DoD).
 */
const surfacedAutocompleteFailures = new Set<string>();

/**
 * A5: re-arms every surfaced-once autocomplete failure warning. Wired into
 * `index.ts`'s `rebuild()` (fires on every `talaria.autocomplete.*` config
 * change and on the initial API-key load) so a user who just fixed their
 * key/endpoint gets a second signal on the next failure instead of
 * permanent silence.
 */
export function clearSurfacedAutocompleteFailures(): void {
  surfacedAutocompleteFailures.clear();
}

/**
 * W5.1 next-edit (Job B Task 12) — the OBSERVATION seam. FIM tells next-edit
 * what it is doing; next-edit gets no handle back that could interfere with
 * FIM. That asymmetry is R2 itself: "FIM-start aborts next-edit, never the
 * reverse."
 *
 * - `requestStarted()` — a FIM request is now in flight. Next-edit aborts any
 *   in-flight prediction of its own and stops building new ones.
 * - `resultShown(hasItem)` — the request settled. `true` (a non-null item) is
 *   treated CONSERVATIVELY as "ghost text is on screen", even though VS Code
 *   may still decline to render it.
 * - `accepted()` — the user took the completion. This is the R4 seam.
 *
 * Defaulted to a no-op below, so a build with next-edit unregistered behaves
 * exactly as it did before this seam existed.
 */
export interface FimActivityListener {
  requestStarted(): void;
  resultShown(hasItem: boolean): void;
  accepted(): void;
  /**
   * The command an accepted item must carry so VS Code can fire the R4 seam
   * — or `undefined` when next-edit is NOT attached, in which case the item
   * carries no command at all.
   *
   * This is asked of the LISTENER rather than hard-coded here because the
   * registration that attaches the listener is the same one that registers
   * the command: the two therefore share a lifetime, and an item can never
   * advertise a command that nothing has registered. That mattered — the
   * command is registered inside `NextEditGuard.hydrate().then(...)`
   * (`index.ts`) whose rejection handler only logs, so a failed hydration
   * used to leave every FIM accept executing an unregistered command. FIM
   * must never degrade because next-edit failed to come up.
   */
  acceptCommandId(): string | undefined;
}

const NO_OP_FIM_ACTIVITY: FimActivityListener = {
  requestStarted: () => {},
  resultShown: () => {},
  accepted: () => {},
  // Nothing is attached, so nothing has registered a command to advertise.
  acceptCommandId: () => undefined,
};

/**
 * F-2 (A7): `completeBracketPairs` is NOT in the stable `vscode.d.ts` — VS
 * Code honours it to auto-balance trailing bracket pairs on accept. Continue
 * sets it the same way (`completionProvider.ts:603`). UNDOCUMENTED: it can
 * disappear without a breaking-change notice; the optional `?` keeps us
 * compiling if it does.
 */
interface InlineCompletionItemWithUndocumentedFlags extends vscode.InlineCompletionItem {
  completeBracketPairs?: boolean;
}

/**
 * §4.4 item 2 — `FimContext.reponame` becomes the `<|repo_name|>` block in
 * `qwenMultifileFimTemplate`'s repo-FIM shape the moment `snippets` goes
 * non-empty (`templates.ts:58`); leaving it unset diverges from the trained
 * repo-FIM shape (llama.cpp inserts a dummy `myproject` server-side for the
 * same slot) now that the snippet branch is a default-on hot path. Pure —
 * no `vscode` needed: `workspaceUris` is already the plain string array the
 * caller builds from `vscode.workspace.workspaceFolders`.
 *
 * Prefers the workspace folder that CONTAINS `filepath` (longest matching
 * URI prefix wins, so a nested multi-root folder wins over its parent),
 * falling back to the FIRST configured folder; POSIX basename of that
 * folder URI's path (Fedora/Linux target — workspace URIs are always
 * `/`-separated regardless of host OS).
 */
export function reponameFromWorkspace(
  filepath: string,
  workspaceUris: readonly string[],
): string | undefined {
  const containing = workspaceUris
    .filter((uri) => filepath === uri || filepath.startsWith(uri.endsWith('/') ? uri : `${uri}/`))
    .sort((a, b) => b.length - a.length)[0];
  const folderUri = containing ?? workspaceUris[0];
  if (folderUri === undefined) {
    return undefined;
  }
  const trimmed = folderUri.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const base = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  return base.length > 0 ? base : undefined;
}

/**
 * Thin VS Code adapter over the IDE-agnostic `FimEngine`. Registered for
 * `{ pattern: '**' }` by `registerTalariaAutocomplete` (`index.ts`).
 *
 * Grounded via Context7 (`/websites/code_visualstudio_api`):
 * - `provideInlineCompletionItems(document, position, context, token)` is called on
 *   every keystroke/cursor move — debouncing/cancellation is entirely our job.
 * - `context.selectedCompletionInfo` (set when the IntelliSense widget is open):
 *   our completion MUST start with its `.text` and use its `.range`, or VS Code
 *   won't preview it (how-to §2.1).
 * - `context.triggerKind === InlineCompletionTriggerKind.Invoke` = explicit user
 *   gesture -> skip debounce (mapped to `{ manual: true }` on the engine).
 * - `new vscode.InlineCompletionItem(insertText, range?, command?)`.
 */
export class TalariaInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  constructor(
    private readonly getEngine: () => FimEngine,
    private readonly getEnabled: () => boolean,
    // S4.3: true when the workspace is Restricted Mode (untrusted) AND the
    // configured endpoint is remote (non-loopback) — skip rather than ship
    // workspace code off-box without trust.
    private readonly getSkipUntrustedRemote: () => boolean,
    // W5-T5: the single background gatherer/snapshot cache — §2.1/§2.4.
    private readonly contextService: CrossFileContextService,
    // A5: the currently-configured backend name + endpoint host, read fresh
    // on every failure (mirrors `getEnabled`/`getSkipUntrustedRemote`'s
    // live-closure-over-mutable-`cfg` posture in `index.ts`) — used ONLY to
    // build the one-shot Set key and the surfaced message text, never sent
    // anywhere.
    private readonly getBackendName: () => string,
    private readonly getEndpointHost: () => string,
    // F-B: the currently-configured model name — same live-closure posture
    // as getBackendName/getEndpointHost above. Used ONLY in the 404 arm's
    // surfaced message text (never the Set key, which stays keyed on the
    // fixed `'model'` statusClass) — the model name is user config, not a
    // secret, so naming it is safe and is what makes the message actionable.
    private readonly getModelName: () => string,
    // A5: DI seam for the `Talaria` output channel line — mirrors
    // `ControlDispatcherHostPort.showWarningMessage`'s posture
    // (`host/backend/control/ControlDispatcher.ts:59-60`): keeps this file
    // mockable without a real `vscode.OutputChannel`. Wired to the real
    // channel at the composition root (`index.ts` -> `extension.ts`).
    private readonly reportFailure: (msg: string) => void,
    // W5.1 Task 12: the next-edit observation seam. Optional and defaulted to
    // a no-op — every existing call site (and every existing test) keeps
    // working unchanged, and FIM behaviour is identical when next-edit is not
    // registered.
    private readonly fimActivity: FimActivityListener = NO_OP_FIM_ACTIVITY,
  ) {}

  /**
   * A5: surface `message` (+ optional action `items`, e.g. `Set API Key`)
   * via `vscode.window.showWarningMessage` — the repo's established
   * surfacing primitive (precedent: `host/backend/customModes.ts:125`) —
   * and append one line to the `Talaria` output channel via the injected
   * {@link reportFailure} seam. Only on the FIRST insertion of `key` into
   * {@link surfacedAutocompleteFailures} (one-shot, not per-keystroke);
   * every subsequent identical failure is silent until the next engine
   * rebuild clears the Set. A dismissed warning (the Thenable resolving
   * `undefined`) is a normal outcome, not an error.
   *
   * M3 (A7, pulled forward from A5's review): `showWarningMessage` returns a
   * `Thenable`, which — unlike a real Promise — has no `.catch`; the
   * two-argument `.then(onFulfilled, onRejected)` form below routes a
   * REJECTED `showWarningMessage` Thenable itself to {@link reportFailure}
   * instead of leaving an unhandled rejection. Mirrors
   * `TalariaViewProvider.ts`'s `openDiffPreview`.
   *
   * F-A (final fix wave): that `onRejected` arm only ever sees
   * `showWarningMessage` rejecting — it is blind to a rejection thrown
   * *inside* `onFulfilled`, and `talaria.setAutocompleteApiKey`'s own promise
   * used to be `void`-discarded there. On a keyring-less Fedora box (our ship
   * target) `context.secrets.store` can reject: the key was never saved, no
   * error shown, and — because `store` failing means `onDidChange` never
   * fires — `rebuild()` never re-armed this key, so every later failure went
   * silent forever. The command's promise now gets the SAME
   * `.then(undefined, onRejected)` treatment (it too is a `Thenable`), and
   * its `onRejected` deletes `key` from {@link surfacedAutocompleteFailures}
   * before reporting — the remediation itself failed, so the user must be
   * re-armed for a fresh signal, not stranded in silence.
   *
   * F-C (final fix wave): `channelMessage` defaults to `message` (every arm
   * but one wants the toast and the output-channel line identical) — the
   * insecure-transport arm below is the one exception, passing a
   * DIFFERENT, more detailed `channelMessage` so the raw throw-site message
   * (developer detail) never has to double as user-facing toast copy.
   */
  private surfaceIfFirst(
    key: string,
    message: string,
    items: readonly string[] = [],
    channelMessage: string = message,
  ): void {
    if (surfacedAutocompleteFailures.has(key)) return;
    surfacedAutocompleteFailures.add(key);
    this.reportFailure(channelMessage);
    void vscode.window.showWarningMessage(message, ...items).then(
      (selection) => {
        if (selection === SET_API_KEY_ACTION) {
          void vscode.commands.executeCommand('talaria.setAutocompleteApiKey').then(undefined, (err) => {
            surfacedAutocompleteFailures.delete(key);
            this.reportFailure(`[autocomplete.setApiKey] ${String(err)}`);
          });
        }
      },
      (err) => this.reportFailure(`[autocomplete.warning] ${String(err)}`),
    );
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    // W5-T5: `egressPreconditionsMet` folds the two guards below (untrusted-
    // remote skip, enabled) into the ONE predicate `context/contextService.ts`
    // also exposes to the (future, T7) warm-up hook — same behavior, single
    // source of truth (§2.4 finding 2).
    if (
      !egressPreconditionsMet({
        skipUntrustedRemote: this.getSkipUntrustedRemote(),
        enabled: this.getEnabled(),
      })
    ) {
      return null;
    }

    if (token.isCancellationRequested) {
      return null;
    }

    // Skip generated/diff/output-ish schemes; only complete in real editable docs.
    if (!isTriggerableScheme(document.uri.scheme)) {
      return null;
    }

    // S4.1 (CWE-200/312): never complete — and so never POST — a secret-classified
    // document (.env, id_rsa, *.pem, anything under .ssh/.git, PLUS the broader
    // exfiltration-only surface: *.key/*.p12/*.pfx/*.pkcs12/*.jks/*.keystore,
    // id_ecdsa/id_dsa, credentials/kubeconfig/serviceaccount.json, .netrc/.npmrc/
    // .pgpass/.pypirc/.envrc, .aws/.gnupg/.kube dirs, PLUS W6-FC's
    // credentials.json/application_default_credentials.json/.git-credentials/
    // secrets.*/*.tfvars). Deliberately broader than the edit-approval
    // classifier (`classifyPath`) — see `isSecretForCompletion` in
    // `shared/secretPaths.ts` for why the two must stay separate. THIS is the
    // ACTIVE-FILE egress gate — the sharpest vector (no content-scan backstop
    // for the file being edited), so this function's completeness is
    // load-bearing on its own, not just a defense-in-depth layer.
    // Name-based (no realpath): a symlink with an innocuous name pointing at a
    // secret is NOT caught here — a documented residual (per-keystroke realpath is
    // too costly for this low-severity, malicious-clone-only threat).
    const fsPathLike = (document.uri.path ?? document.uri.fsPath ?? '').replace(/\\/g, '/');
    if (isSecretForCompletion(fsPathLike)) {
      return null;
    }

    const selectedCompletionInfo = context.selectedCompletionInfo;
    if (selectedCompletionInfo) {
      const typedText = document.getText(selectedCompletionInfo.range);
      const typedLength =
        selectedCompletionInfo.range.end.character -
        selectedCompletionInfo.range.start.character;
      // Mirrors Continue: require >= 4 typed chars and a compatible widget selection
      // before bothering to complete alongside IntelliSense (how-to §2.1).
      if (typedLength < 4 || !selectedCompletionInfo.text.startsWith(typedText)) {
        return null;
      }
    }

    const abortController = new AbortController();
    const cancelSub = token.onCancellationRequested(() =>
      abortController.abort(),
    );

    // W5.1 Task 12 (R2): observation-seam bookkeeping. `fimRequested` gates
    // the paired `resultShown` so the seam only reports on requests that
    // actually STARTED — the gate-and-skip returns above never announced one.
    let fimRequested = false;
    let fimShown = false;

    try {
      const text = document.getText();
      const offset = document.offsetAt(position);
      // With the widget open, `selectedCompletionInfo.range` is [wordStart, cursor]
      // and `.text` is the FULL replacement word — splice at the range START, not
      // the cursor, or the already-typed partial word ends up duplicated ahead of
      // the full word (e.g. typed "getD" + widget word "getData" -> "...getDgetData").
      const prefixSpliceOffset = selectedCompletionInfo
        ? document.offsetAt(selectedCompletionInfo.range.start)
        : offset;
      const prefix = text.slice(0, prefixSpliceOffset) + (selectedCompletionInfo?.text ?? '');
      const suffix = text.slice(offset);

      const documentUri = document.uri.toString();
      const workspaceUris = (vscode.workspace.workspaceFolders ?? []).map((f) =>
        f.uri.toString(),
      );

      const fimContext: FimContext = {
        filepath: documentUri,
        languageId: document.languageId,
        prefix,
        suffix,
        reponame: reponameFromWorkspace(documentUri, workspaceUris),
        workspaceUris,
        // W5-T5 `:106` seam: captured ONCE, right here — `snapshotFor()` is a
        // synchronous read of an already-materialized, `===`-stable frozen
        // snapshot (§2.4). This completion's `snippetSetHash` (engine.ts)
        // will always match exactly what this array holds: no
        // debounce/regeneration race, even if the background buffer
        // regenerates again before the engine's own 350ms debounce settles.
        snippets: this.contextService.snapshotFor(document).snippets,
        selectedCompletionInfo: selectedCompletionInfo
          ? {
              range: {
                start: selectedCompletionInfo.range.start.character,
                end: selectedCompletionInfo.range.end.character,
              },
              text: selectedCompletionInfo.text,
            }
          : undefined,
      };

      const manual =
        context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

      // Task 16 (08 §11, ADR-010): catch an unrecognized model BEFORE the
      // engine ever builds a prompt — `templates.ts:195`'s old fall-through
      // used to feed both the self-render prompt and the stop-token list to
      // every unrecognized model silently. Polarity per the WARN_MSG/
      // REFUSE_MSG doc comments above: `vllm` (nativeFim:false) fails
      // closed and VISIBLE; every other (nativeFim:true, server-templated)
      // backend warns once and proceeds — the fallback stop list is the
      // only foreign contribution there.
      const model = this.getModelName();
      if (!isKnownFimModel(model)) {
        const backend = this.getBackendName();
        const key = (statusClass: string): string => `${backend}|${this.getEndpointHost()}|${statusClass}`;
        if (backend === 'vllm') {
          this.surfaceIfFirst(key('unknown-model'), REFUSE_MSG(model));
          return null;
        }
        this.surfaceIfFirst(key('unknown-model'), WARN_MSG(model));
      }

      // R2: a FIM request is now in flight — next-edit aborts anything of its
      // own and stops building new requests until this settles.
      this.fimActivity.requestStarted();
      fimRequested = true;

      const outcome = await this.getEngine().complete(
        fimContext,
        { manual },
        abortController.signal,
      );

      if (
        !outcome ||
        !outcome.text ||
        abortController.signal.aborted ||
        token.isCancellationRequested
      ) {
        return null;
      }

      let completionText = outcome.text;
      if (selectedCompletionInfo) {
        if (!completionText.startsWith(selectedCompletionInfo.text)) {
          return null;
        }
      }

      const startPos = selectedCompletionInfo?.range.start ?? position;
      // With the widget open, the item must replace [wordStart, cursor] (the
      // already-typed partial word) with `completionText` (which starts with
      // `selectedCompletionInfo.text`, checked above) — not just insert at
      // wordStart and leave the typed partial behind. Collapses to the plain
      // cursor-only insertion when no widget is open (startPos === position).
      let range = new vscode.Range(startPos, position);

      const isSingleLine = completionText.split('\n').length <= 1;
      if (isSingleLine) {
        const currentLineSuffix = document
          .lineAt(position)
          .text.slice(position.character);
        const processed = processSingleLineCompletion(
          completionText,
          currentLineSuffix,
          position.character,
        );
        if (!processed) {
          return null;
        }
        completionText = processed.completionText;
        if (processed.range) {
          range = new vscode.Range(
            new vscode.Position(position.line, startPos.character),
            new vscode.Position(position.line, processed.range.end),
          );
        }
      } else {
        // Extend the range to end-of-line for multiline completions (how-to §2.1).
        range = new vscode.Range(startPos, document.lineAt(startPos).range.end);
      }

      if (!completionText) {
        return null;
      }

      // W5.1 Task 12 — the accept hook. `InlineCompletionItem`'s optional
      // third `command` argument is executed by VS Code when the user ACCEPTS
      // this item (Context7 `/microsoft/vscode-docs`,
      // programmatic-language-features). This was a comment-only seam through
      // W5 (architecture doc §5 deferral); it is now the live R4 trigger.
      // The command is registered exactly once, in the next-edit shell — this
      // file still registers nothing (shape-lock: provider.test.ts).
      //
      // `undefined` means next-edit is not attached and so has registered
      // nothing: the item ships WITHOUT a command rather than naming one VS
      // Code cannot execute. See `FimActivityListener.acceptCommandId`.
      const acceptCommandId = this.fimActivity.acceptCommandId();
      const item =
        acceptCommandId === undefined
          ? new vscode.InlineCompletionItem(completionText, range)
          : new vscode.InlineCompletionItem(completionText, range, {
              command: acceptCommandId,
              title: '',
            });
      // F-2 (A7): see InlineCompletionItemWithUndocumentedFlags's doc comment
      // above — this is the one place completeBracketPairs is set.
      (item as InlineCompletionItemWithUndocumentedFlags).completeBracketPairs = true;

      fimShown = true;
      return [item];
    } catch (err) {
      // A5/F-B: narrowed, not widened — only the four ACTIONABLE failures below
      // are ever surfaced (each at most once per backend/host/statusClass
      // until the next engine rebuild). Everything else (timeouts, connection
      // refused, other non-2xx, etc.) still fails this single completion
      // request silently rather than surfacing a VS Code error toast on every
      // keystroke — a failing provider doesn't fail the overall
      // inline-completion operation anyway (how-to §2.1). Never put the API
      // key or a response body in a surfaced message (jobA-common.md
      // invariant 5) — status + backend name + endpoint host/model only.
      const backend = this.getBackendName();
      const host = this.getEndpointHost();
      const key = (statusClass: string): string => `${backend}|${host}|${statusClass}`;

      if (err instanceof InsecureTransportError) {
        // F-C Minor-4 (also security M-3): a config/security refusal is
        // always actionable, but the toast must NOT echo the throw site's
        // raw `err.message` verbatim — that message shows a non-expert user
        // "(CWE-319)" and is one future edit away from carrying `rawUrl`
        // (which can hold userinfo credentials). Rebuild the user-facing
        // text the way every other arm here does; keep the developer detail
        // (still no key, no response body) in the output channel only.
        this.surfaceIfFirst(
          key('insecure-transport'),
          'Talaria autocomplete: refusing to send the API key over cleartext HTTP to a remote host. Use https, or point the endpoint at a loopback address (127.0.0.1/localhost).',
          [],
          `Talaria autocomplete: ${err.message}`,
        );
      } else if (err instanceof MissingApiKeyError) {
        // Review C-1 fix: CodestralFimBackend.streamFim throws this BEFORE
        // any fetch when the configured backend's key is empty/whitespace —
        // a config/security refusal, always actionable, the same posture as
        // InsecureTransportError immediately above. No key value in the
        // message (there is none to leak — the whole point is that no key
        // was ever supplied).
        this.surfaceIfFirst(
          key('missing-key'),
          `Talaria autocomplete: ${backend} requires an API key. Run "Talaria: Set Autocomplete API Key", or switch "talaria.autocomplete.backend" to a local backend.`,
          [SET_API_KEY_ACTION],
        );
      } else if (err instanceof BackendHttpError && (err.status === 401 || err.status === 403)) {
        // F-C Minor-2/Minor-3: "Set the API key" was the wrong mood for the
        // common case (a MISTYPED key, not an absent one) — the copy now
        // covers both. Includes statusText (permitted by invariant 5), and
        // "the vllm server" rather than raw "vllm" as the grammatical subject.
        this.surfaceIfFirst(
          key('auth'),
          `Talaria autocomplete: the ${backend} server rejected the request (${err.status} ${err.statusText}) — the API key is missing or incorrect.`,
          [SET_API_KEY_ACTION],
        );
      } else if (err instanceof BackendHttpError && err.status === 400) {
        // F-C Minor-1: a dialect mismatch is the likely, not the only, cause
        // (vLLM also 400s on context-length overflow / malformed sampling
        // params) — hedge rather than assert a cause this code cannot know.
        this.surfaceIfFirst(
          key('dialect'),
          `Talaria autocomplete: ${backend} rejected the request (${err.status} ${err.statusText}). This usually means "talaria.autocomplete.backend" doesn't match your server's API dialect — it can also mean the request itself was invalid (e.g. too many tokens for the server's context length).`,
        );
      } else if (err instanceof BackendHttpError && err.status === 404) {
        // F-B: vLLM's check_model 404s for a model it doesn't serve — the
        // DEFAULT vLLM path, since config.ts's DEFAULT_MODEL is an Ollama tag
        // format vLLM never serves. Without this arm, a correctly-authed user
        // who never touches talaria.autocomplete.model gets pure silence.
        this.surfaceIfFirst(
          key('model'),
          `Talaria autocomplete: ${backend} does not serve the model "${this.getModelName()}" (404). Check "talaria.autocomplete.model".`,
        );
      } else if (err instanceof BackendStreamError) {
        // T-5 (closes V-14): a mid-stream SSE error frame on an otherwise-200
        // response — the runner's real error-as-data-frame convention (root
        // cause: vLLM `serving.py:491-497`). `BackendStreamError` is a
        // DISJOINT class from `BackendHttpError` (this response was 2xx), so
        // this arm composes with every arm above/below without overlap.
        // Body-free by construction on both ends: the error itself never
        // carries the frame's message text (`http.ts`'s `readOpenAiSseText`),
        // and this toast is a fixed template that never reads `err.message`.
        this.surfaceIfFirst(
          key('stream'),
          `Talaria autocomplete: the ${backend} server at ${host} reported an error while generating (mid-stream). Check the server log.`,
        );
      } else if (err instanceof BackendHttpError) {
        // T-D1 (closes V-15): every OTHER HTTP status a FIM backend can throw
        // — crucially llama.cpp's 501 "Infill is not supported by this
        // model" (`post_infill` -> `format_error_response(...,
        // ERROR_TYPE_NOT_SUPPORTED)` when the loaded GGUF's vocab lacks FIM
        // pre/suf/mid tokens: the classic non-FIM-GGUF misconfiguration),
        // plus any 5xx/unlisted status — used to fall through every arm
        // above into the silent `return null` below: autocomplete died
        // permanently with zero diagnostic signal. This catch-all surfaces
        // status + statusText ONLY, never a response body (invariant 5),
        // once per backend|host|statusClass via the same surfaceIfFirst
        // dedup as every arm above (no per-keystroke spam). Non-HTTP
        // failures (timeouts, ECONNREFUSED) are not a BackendHttpError and
        // so still fall through this arm too — they stay deliberately
        // silent, per the documented per-keystroke design at :514-522.
        const fimHint =
          err.status === 501
            ? ' A 501 from a local runner usually means the loaded model does not support fill-in-the-middle — use a FIM-capable model (e.g. a coder "-base" tag).'
            : '';
        this.surfaceIfFirst(
          key(`status-${err.status}`),
          `Talaria autocomplete: the ${backend} server rejected the request (${err.status} ${err.statusText}).${fimHint}`,
        );
      }
      return null;
    } finally {
      cancelSub.dispose();
      // Paired with `requestStarted()` above — reports on EVERY exit from a
      // started request (item, no item, or a thrown backend failure), so the
      // next-edit side can never be left believing FIM is still in flight.
      if (fimRequested) {
        this.fimActivity.resultShown(fimShown);
      }
    }
  }
}
