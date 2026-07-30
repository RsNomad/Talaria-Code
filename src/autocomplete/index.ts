import * as vscode from 'vscode';
import { createBackend, clearBackendFactoryWarnings } from './backendFactory';
import { AutocompleteDebouncer } from './debouncer';
import { InMemoryCompletionCache } from './cache';
import { readConfig, effectivePrefixInjection, type HermesAutocompleteConfig } from './config';
import { FimEngine } from './engine';
import { TalariaInlineCompletionProvider, clearSurfacedAutocompleteFailures } from './provider';
import {
  AUTOCOMPLETE_API_KEY_SECRET,
  pickApiKey,
  shouldMigrateApiKey,
  shouldClearLegacyApiKeySetting,
} from './apiKey';
import { isLoopbackHost } from './backends/secureTransport';
import { getTemplateForModel } from './templates';
import { crossFileMode } from './context/mode';
import { createHermesCrossFileContextService } from './context/contextService.vscode';
import { NextEditGuard } from './nextedit/guard';
import { fimActivityRelay, registerTalariaNextEdit, requestNextEditToggle } from './nextedit/shell.vscode';
import type { NextEditShellDeps } from './nextedit/shell.vscode';
import type { NextEditTogglePort } from '../shared/nextEditTogglePort';
import type { BackendCapabilities, FimBackend, FimTemplate } from './types';

/**
 * S4.3: is `rawUrl`'s host the loopback interface? Reuses S4.2's single
 * source of truth (`secureTransport.ts`'s `LOOPBACK` set via `isLoopbackHost`)
 * rather than hand-rolling a second loopback list. A malformed URL can't
 * reach here in practice (`readConfig` already validates via `isHttpUrl`
 * before falling back to a known-good default), but if it ever did, treating
 * it as non-loopback fails CLOSED — Restricted Mode would skip rather than
 * silently ship code off-box.
 */
function isLoopbackEndpoint(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * F-D (fix wave): corrected — this previously claimed to also feed "the
 * surfaced message text", which is false; `provider.ts`'s `surfaceIfFirst`
 * call sites never interpolate `host` into a message, only into the Set key
 * below.
 *
 * A5: `rawUrl`'s host only (no scheme/port/path/query) — feeds ONLY the
 * one-shot failure-surfacing Set key (`provider.ts`'s `key(statusClass)`
 * closure: `${backend}|${host}|${statusClass}`). Never the full URL (A5
 * brief: "never the full URL with any query"). Mirrors `isLoopbackEndpoint`'s
 * own try/catch-on-malformed-URL posture immediately above; `readConfig`
 * already validates `cfg.endpoint` via `isHttpUrl` before it ever reaches
 * here, so the catch is a defensive fallback, not a real path.
 */
function endpointHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Frozen public entry (Zone AC) — the controller wires this
 * into `extension.ts`. Reads its own config from
 * `vscode.workspace.getConfiguration('talaria.autocomplete')`.
 *
 * Security (security-review.md H1): the API key is sourced from
 * `context.secrets` (SecretStorage, OS-keychain-backed), NOT from plaintext
 * settings. A legacy `talaria.autocomplete.apiKey` setting is migrated into
 * SecretStorage on first activation. The key is never logged.
 */
export function registerTalariaAutocomplete(
  context: vscode.ExtensionContext,
  // A5: DI seam for the `Talaria` output channel line a surfaced failure
  // also appends — mirrors `ControlDispatcherHostPort.showWarningMessage`'s
  // posture (`host/backend/control/ControlDispatcher.ts:59-60`). The real
  // implementation (`output.appendLine`) is wired in at `extension.ts`,
  // where the `Talaria` output channel lives.
  reportFailure: (msg: string) => void,
  // W5.1 R5 (Task 13): DI sink for the next-edit toggle capability. This
  // function is the ONLY place that holds the hydrated Guard, so it is the
  // only place that can hand the webview a way to toggle. Called at most
  // once, from the hydration continuation below; never called when
  // hydration fails, so the view provider keeps refusing `nextEdit.toggle`
  // honestly instead of pretending a store exists. `extension.ts` wires it
  // to `TalariaViewProvider.setNextEditToggles`.
  onNextEditToggles?: (port: NextEditTogglePort) => void,
): vscode.Disposable {
  let cfg = readConfig();
  // Effective secret value, loaded asynchronously (SecretStorage is async) and
  // refreshed on change. Until it resolves, the engine uses whatever legacy
  // setting value `cfg.apiKey` carries (back-compat).
  let secretApiKey: string | undefined;
  let built = buildEngine(cfg, secretApiKey);
  let engine = built.engine;
  // S4.3: recomputed alongside `engine` on every rebuild (config change), so a
  // changed `talaria.autocomplete.endpoint` is reflected immediately. Workspace
  // trust itself needs no separate listener here — `vscode.workspace.isTrusted`
  // below is read live on every completion request, not captured.
  let remote = !isLoopbackEndpoint(cfg.endpoint);

  // W5-T5: owns the single `CrossFileContextService` for this activation
  // (§2.1 critic-C finding 7 — `registerTalariaAutocomplete` is the
  // composition root). Constructed ONCE — its listeners live for the whole
  // activation; `rebuild()` below reconfigures its mode in place rather than
  // tearing down and re-subscribing (no new refresh path).
  const { service: contextService, disposable: contextServiceDisposable } =
    createHermesCrossFileContextService({
      capabilities: built.capabilities,
      template: built.template,
      crossFileEnabled: cfg.crossFile.enabled,
      prefixInjection: effectivePrefixInjection(cfg.crossFile, !remote),
      // W5-T7: the backend `contextService.maybeWarmUp` fires
      // `.warmUp?.()` on (only `LlamaCppInfillBackend` implements it this
      // wave). Re-supplied on every `rebuild()` below via `reconfigure()`
      // so a backend switch retargets warm-up immediately.
      backend: built.backend,
      // Same egress preconditions the provider enforces (§2.4 finding 2) —
      // the warm-up hook consults these THROUGH the service.
      getSkipUntrustedRemote: () => remote && !vscode.workspace.isTrusted,
      getEnabled: () => cfg.enabled,
      // A live closure over the mutable `cfg` binding below (reassigned by
      // `onDidChangeConfiguration`) — reads `talaria.autocomplete.crossFile.
      // warmUp` fresh on every call, needing no separate refresh path.
      getWarmUpEnabled: () => cfg.crossFile.warmUp,
    });

  const provider = new TalariaInlineCompletionProvider(
    () => engine,
    () => cfg.enabled,
    () => remote && !vscode.workspace.isTrusted,
    contextService,
    // A5: live closures over the mutable `cfg` binding below (reassigned by
    // `onDidChangeConfiguration`), same posture as `getEnabled` above.
    () => cfg.backend,
    () => endpointHost(cfg.endpoint),
    // F-B: same live-closure posture — reads `talaria.autocomplete.model`
    // fresh on every failure so the 404 arm's message always names the
    // currently-configured model, not a stale one from a prior rebuild.
    () => cfg.model,
    reportFailure,
    // W5.1 Task 12 (R2/R4): the next-edit observation seam. `fimActivityRelay`
    // is a fixed forwarding address — a no-op until `registerTalariaNextEdit`
    // below attaches to it, and a no-op again after it disposes. Passing it
    // unconditionally keeps the provider's construction independent of
    // whether next-edit registered successfully.
    fimActivityRelay,
  );

  const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider,
  );

  const rebuild = (): void => {
    // T-6 F4/F6: re-arm `createBackend`'s construction-time warnings BEFORE
    // it runs (inside `buildEngine` below) — not after, like
    // `clearSurfacedAutocompleteFailures` below, whose Set is only consulted
    // later, on an actual completion request. `createBackend`'s warnings
    // fire synchronously DURING this call, so clearing after it returns
    // would miss this rebuild's own chance to re-warn on a still-broken (or
    // newly re-broken) config, and only catch up one rebuild late.
    clearBackendFactoryWarnings();
    built = buildEngine(cfg, secretApiKey);
    engine = built.engine;
    remote = !isLoopbackEndpoint(cfg.endpoint);
    // A5: re-arm every surfaced-once failure warning on every rebuild (config
    // change, API-key load/rotation) — a config change (e.g. the user just
    // fixed a wrong key) must produce a fresh signal on the next failure
    // rather than staying silent forever against the OLD key's dedup key.
    clearSurfacedAutocompleteFailures();
    contextService.reconfigure({
      capabilities: built.capabilities,
      template: built.template,
      crossFileEnabled: cfg.crossFile.enabled,
      prefixInjection: effectivePrefixInjection(cfg.crossFile, !remote),
      // W5-T7 — re-supply the freshly-built backend so a backend/model
      // switch retargets warm-up rather than firing against a stale
      // instance (see `CrossFileContextServiceModeInput.backend`'s doc).
      backend: built.backend,
    });
  };

  // Load (and one-time migrate) the API key from SecretStorage.
  void initApiKey(context, cfg.apiKey).then(
    (key) => {
      secretApiKey = key;
      rebuild();
    },
    // F-4 (fix wave): SecretStorage can REJECT — a keyring that is present
    // but erroring, rather than the silent in-memory fallback ADR-017 is
    // about. Without this arm the rejection was unhandled and the user was
    // told nothing at all.
    //
    // Reported by KIND, never by text: an error raised out of
    // `store(key, value)` may carry its arguments in `message`, and the one
    // invariant this whole module exists to hold is that the value never
    // reaches a log or a toast (`apiKey.ts`'s header).
    //
    // Deliberately does NOT call `rebuild()`. The rejection leaves
    // `secretApiKey` exactly as the activation-time `buildEngine` above
    // already saw it — `undefined` — so a rebuild here would reconstruct an
    // identical engine, re-arm the failure dedup, and re-target warm-up for
    // no state change. The engine already reflects reality: `pickApiKey`
    // falls back to the legacy setting, so autocomplete keeps working.
    (err: unknown) => {
      reportFailure(
        `[autocomplete] could not read the API key from SecretStorage (${
          err instanceof Error ? err.name : 'unknown error'
        }) — continuing with the legacy setting, if one is present`,
      );
    },
  );

  const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('talaria.autocomplete')) return;
    // Model/backend/budget/temperature all feed into the engine's construction
    // (and the cache is keyed under an implicit "current model" assumption — see
    // cache.ts's design note), so we simply rebuild the whole engine rather than
    // trying to patch it in place. The `provider` above always calls
    // `getEngine()` fresh, so this swap is transparent to it.
    cfg = readConfig();
    rebuild();
  });

  // React to the API key being set/cleared/rotated (via the command below or
  // another window) without a reload.
  const secretDisposable = context.secrets.onDidChange((e) => {
    if (e.key !== AUTOCOMPLETE_API_KEY_SECRET) return;
    void context.secrets.get(AUTOCOMPLETE_API_KEY_SECRET).then(
      (key) => {
        secretApiKey = key ?? undefined;
        rebuild();
      },
      // Audit C-7: with no rejection handler, a failed keyring read left the
      // PREVIOUS key live and said nothing — the user believes a rotation took
      // effect that did not. Never log the key or the error's payload; the
      // reason is enough to act on.
      (err: unknown) => {
        reportFailure(
          `failed to re-read the autocomplete API key after a SecretStorage change; the previously loaded key is still in use: ${
            err instanceof Error ? err.name : 'unknown error'
          }`,
        );
      },
    );
  });

  const setKeyCommand = vscode.commands.registerCommand(
    'talaria.setAutocompleteApiKey',
    () => promptAndStoreApiKey(context),
  );

  // ── W5.1 Task 12: Next Edit Suggestions ────────────────────────────────────
  // This composition root already holds `context`, and `context.globalState` is
  // the capability's ONE store entry point (R5: the NEXT/Generic toggles are
  // not settings — `settings.json` carries DATA only). Hydration is async
  // (`Memento.update` is a Thenable), so registration lands on a later tick;
  // until then `fimActivityRelay` above is still the no-op it was constructed
  // as, so FIM behaves exactly as it did pre-next-edit.
  //
  // The Guard instance is also what Task 13's webview `nextEdit.toggle`
  // request will need — routed through `requestNextEditToggle`
  // (`nextedit/shell.vscode.ts`), never `guard.requestToggle` directly, so the
  // unsupported-FIM-backend refusal and the Generic setup note cannot be
  // bypassed.
  let nextEditDisposable: vscode.Disposable | undefined;
  let nextEditTornDown = false;
  // Hoisted so the toggle port below and `registerTalariaNextEdit` share ONE
  // deps object: `requestNextEditToggle`'s Generic refusal must be decided
  // against exactly the FIM backend the runtime path would use, never a
  // second, separately-built copy that could drift.
  const nextEditDeps: NextEditShellDeps = {
    reportFailure,
    // Live closures over the mutable `cfg` binding, the same posture as
    // every other seam in this function — Generic follows the FIM
    // endpoint/model/backend wherever a config change moves them.
    getAutocompleteEndpoint: () => cfg.endpoint,
    getAutocompleteModel: () => cfg.model,
    getAutocompleteBackend: () => cfg.backend,
    // The same effective key the FIM engine uses, from the same source and the
    // same live binding: `secretApiKey` is refreshed by the existing
    // `context.secrets.onDidChange` subscription above, so rotation reaches
    // Generic with no reload and nothing new is loaded, watched, or stored.
    getAutocompleteApiKey: () => pickApiKey(secretApiKey, cfg.apiKey),
  };
  void NextEditGuard.hydrate(context.globalState, { reportFailure }).then(
    (guard) => {
      // Registration lost the race with disposal (deactivate during startup):
      // do not attach listeners to a torn-down activation.
      if (nextEditTornDown) return;
      nextEditDisposable = registerTalariaNextEdit(context, guard, nextEditDeps);
      // W5.1 R5 (Task 13): publish the toggle capability to the webview's
      // view provider. `request` goes through `requestNextEditToggle` — NOT
      // `guard.requestToggle` — because only the wrapper can refuse a Generic
      // toggle-on against an `openai-compat`/`codestral` FIM backend (the
      // Guard is transport-blind) and only the wrapper fires the one-shot
      // `OLLAMA_CONTEXT_LENGTH` setup note on an accepted Generic toggle-on.
      onNextEditToggles?.({
        request: (source, on) => requestNextEditToggle(guard, { source, on }, nextEditDeps),
        getState: () => guard.getState(),
        onDidChange: (listener) => guard.onDidChange(listener),
      });
    },
    // Logging is the whole remedy, and that is now safe: `registerTalariaNextEdit`
    // never runs, so `fimActivityRelay` stays the no-op it was constructed as —
    // and a no-op relay advertises NO accept command (`acceptCommandId()` returns
    // `undefined`), so FIM items ship without one instead of naming a command
    // this failed registration never registered. FIM keeps working unchanged;
    // only next-edit is unavailable.
    (err) => reportFailure(`[nextEdit] failed to hydrate the toggle store: ${String(err)}`),
  );

  const disposable = vscode.Disposable.from(
    providerDisposable,
    configDisposable,
    secretDisposable,
    setKeyCommand,
    contextServiceDisposable,
    {
      dispose: () => {
        nextEditTornDown = true;
        nextEditDisposable?.dispose();
      },
    },
  );
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * Read the key from SecretStorage, migrating a legacy plaintext setting into it
 * exactly once. Never logs the value.
 *
 * TWO-SESSION migration (ADR-017): the plaintext setting is NOT cleared in the
 * session that migrates. It is cleared on a later activation where the secret
 * reads back WITHOUT migration running — which is the only available proof
 * that the secret survived a process restart, i.e. that storage is genuinely
 * persisted rather than the silent in-memory fallback. `pickApiKey` already
 * prefers the secret, so the lingering setting changes nothing operationally.
 */
async function initApiKey(
  context: vscode.ExtensionContext,
  settingValue: string | undefined,
): Promise<string | undefined> {
  const existing = await context.secrets.get(AUTOCOMPLETE_API_KEY_SECRET);
  let migratedThisSession = false;
  let effective = existing ?? undefined;

  if (shouldMigrateApiKey(existing, settingValue)) {
    const legacy = settingValue!.trim();
    await context.secrets.store(AUTOCOMPLETE_API_KEY_SECRET, legacy);
    migratedThisSession = true;
    effective = legacy;
  }

  if (shouldClearLegacyApiKeySetting(effective, settingValue, migratedThisSession)) {
    try {
      await vscode.workspace
        .getConfiguration('talaria.autocomplete')
        .update('apiKey', undefined, vscode.ConfigurationTarget.Global);
    } catch {
      // Non-fatal: the machine-scoped plaintext setting may linger, but the
      // SecretStorage value takes precedence (see pickApiKey).
    }
  }

  return effective;
}

/**
 * F-2 (fix wave): remove the legacy plaintext setting, reporting whether the
 * value is actually GONE afterwards rather than whether the call resolved.
 *
 * Returns `true` when nothing is left for `pickApiKey` to fall back to. The
 * post-update re-read is the point: `talaria.autocomplete.apiKey` is
 * machine-scoped, and a resolving `update` is not proof the value is gone —
 * the same "a resolving call proves nothing" trap ADR-017 is built around.
 * A fresh `getConfiguration` snapshot is taken deliberately; the pre-update
 * one predates the write.
 */
async function clearLegacyApiKeySetting(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('talaria.autocomplete');
  // Nothing to clear: skip the write rather than churn the user's
  // settings.json (and report honest success — no value remains).
  if (!config.get<string>('apiKey', '').trim()) return true;
  try {
    await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
  } catch {
    return false;
  }
  return !vscode.workspace.getConfiguration('talaria.autocomplete').get<string>('apiKey', '').trim();
}

/** Command handler: prompt for the key (masked) and store it in SecretStorage. */
async function promptAndStoreApiKey(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'Talaria Autocomplete API Key',
    prompt: 'Stored securely in the OS keychain (SecretStorage). Leave blank to clear.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return; // cancelled
  if (value.trim() === '') {
    await context.secrets.delete(AUTOCOMPLETE_API_KEY_SECRET);
    // F-2: "clear" has to mean the user is left with no key anywhere this
    // command can reach. Deleting only the secret left the legacy plaintext
    // setting live, so `pickApiKey` fell straight back to it and the next
    // activation migrated it back into SecretStorage — the toast was false
    // within one session, and PERMANENTLY false on the keyring-less box
    // ADR-017 exists for, where the clearing session never arrives.
    //
    // ADR-017's caution does not transfer here. Its two-session rule guards
    // the user's only durable copy through an AUTOMATIC, unrequested
    // migration; this is the user explicitly asking to hold no key, so
    // keeping a durable copy is the opposite of the request. Its
    // `secret === setting` agreement check stops the automatic path deleting
    // data it never copied; a value the user is deleting on purpose needs no
    // such protection — which also closes the hole where a plaintext value
    // DIFFERING from the secret was unclearable by any path at all.
    //
    // The `else` branch below is deliberately NOT given the same treatment:
    // clearing the plaintext setting in the same session that stores a new
    // secret is exactly the same-session delete ADR-017's rule for successors
    // forbids, because the replacement has not been proven to survive a
    // restart.
    if (await clearLegacyApiKeySetting()) {
      void vscode.window.showInformationMessage('Talaria: autocomplete API key cleared.');
    } else {
      // Never claim a removal that could not be confirmed. Names the setting
      // to remove — never its value.
      void vscode.window.showWarningMessage(
        'Talaria: the API key was removed from the OS keychain, but the deprecated ' +
          '`talaria.autocomplete.apiKey` setting could not be cleared and is still in effect. ' +
          'Remove it manually in Settings.',
      );
    }
  } else {
    await context.secrets.store(AUTOCOMPLETE_API_KEY_SECRET, value.trim());
    void vscode.window.showInformationMessage('Talaria: autocomplete API key saved to SecretStorage.');
  }
}

interface BuiltEngine {
  engine: FimEngine;
  /** The freshly-constructed backend's capabilities + the model's resolved
   *  template — exposed so the caller can feed the SAME values into
   *  `CrossFileContextService.reconfigure` (§4.2) without constructing a
   *  second backend just to read `.capabilities`. */
  capabilities: BackendCapabilities;
  template: FimTemplate;
  /** W5-T7 — the SAME backend instance the engine holds, exposed so
   *  `CrossFileContextService` can target its (optional) `.warmUp` without
   *  constructing a second backend. */
  backend: FimBackend;
}

function buildEngine(
  cfg: HermesAutocompleteConfig,
  secretApiKey: string | undefined,
): BuiltEngine {
  const apiKey = pickApiKey(secretApiKey, cfg.apiKey);
  const backend = createBackend({ ...cfg, apiKey });
  const template = getTemplateForModel(cfg.model);
  // §4.2 — the crossFileMode predicate gates gathering (R6) and tells the
  // engine which assembly path applies (comment-inject is the only one the
  // engine itself branches on; input-extra/template are already implied by
  // `capabilities`/`supportsSnippets` and need no engine-side flag).
  const mode = crossFileMode(backend.capabilities, template, {
    crossFileEnabled: cfg.crossFile.enabled,
    prefixInjection: effectivePrefixInjection(cfg.crossFile, isLoopbackEndpoint(cfg.endpoint)),
  });

  const engine = new FimEngine({
    backend,
    options: {
      model: cfg.model,
      maxPromptTokens: cfg.maxPromptTokens,
      // Not exposed as their own `talaria.autocomplete.*` keys (the frozen contract
      // only names enabled/backend/endpoint/model/debounceMs/maxPromptTokens/
      // temperature) — these mirror Continue's tuned defaults (how-to §2.2).
      prefixPercentage: 0.3,
      maxSuffixPercentage: 0.2,
      multiline: 'auto',
      useCache: true,
      debounceMs: cfg.debounceMs,
      temperature: cfg.temperature,
      crossFileMode: mode,
    },
    cache: new InMemoryCompletionCache(),
    debouncer: new AutocompleteDebouncer(),
  });

  return { engine, capabilities: backend.capabilities, template, backend };
}
