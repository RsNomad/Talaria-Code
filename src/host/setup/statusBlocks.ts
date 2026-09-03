import type { SetupData } from '../../shared/protocol';
import { NEXT_DEDICATED_MODEL } from './registry';

/**
 * WS-GD.2b (Task B3): `status()` settings-block composers — a pure move of
 * the `fim.tuning` / `nextEdit` / `rag` composition blobs out of
 * `SetupController.status()`'s body. ZERO behavior change: `status()` calls
 * these at the exact same points it used to inline the logic. Every
 * `getSetting` read goes through {@link SettingsReader} (structurally
 * satisfied by `SetupHost`) rather than a `this.host` reference, so this
 * module stays free of any `SetupController` import (no cycle).
 */
export interface SettingsReader {
  getSetting<T>(key: string): T | undefined;
}

/** Reused by {@link composeRagBlock} (`embedEndpoint` fallback) — moved here
 *  because it also anchors {@link RAG_ENDPOINT_DEFAULTS} below, and
 *  `SetupController.ts` still needs it for its own consumers (the probed
 *  `ollamaEndpoint`, `AGENT_ENDPOINT_DEFAULTS`, and the provision family) —
 *  imported back from there, a one-direction value import that breaks any
 *  cycle. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_RAG_EMBED_MODEL = 'qwen3-embedding:0.6b';
const DEFAULT_RAG_INDEX_DIR = '.hermes/index';

/** §6 "NEXT warning (D4, card-level)" — host-composed, honest CPU caveat. */
const NEXT_DEDICATED_WARNING =
  'Needs ~15 GB of GPU memory at full precision, or ~5 GB for the 4-bit build. On a CPU-only machine a 7B model produces a few tokens per second — dedicated next-edit will feel slow; the Generic mode reuses your smaller FIM model instead.';

/** T8 (CC-10): `setup.setNextEdit`'s additive `dedicatedBackendId` enum — the
 *  4 unified-block backend panes. Shared by the write-side validation and the
 *  `status()` read-side coercion (never trust settings.json without
 *  re-checking — same posture as {@link coerceNextEditTransport}). */
const NEXT_DEDICATED_BACKEND_IDS = ['ollama', 'llamacpp', 'vllm', 'openai-compat'] as const;

/** `undefined` for anything outside the 4-value enum — a malformed/edited
 *  settings.json value degrades to "no restoration hint" (the panel's
 *  existing transport-heuristic fallback), never a fabricated pane. Exported
 *  — `SetupController.handleSetNextEdit`'s write-side validation calls this
 *  same coercion (never trust settings.json without re-checking). */
export function coerceDedicatedBackendId(raw: string | undefined): string | undefined {
  return raw !== undefined && (NEXT_DEDICATED_BACKEND_IDS as readonly string[]).includes(raw) ? raw : undefined;
}

function coerceNextEditTransport(raw: string | undefined): 'ollama' | 'openai-compat' {
  return raw === 'openai-compat' ? 'openai-compat' : 'ollama';
}

/** §3.2 (audit A5, beta.6 panel-fix T2): host-owned RAG endpoint defaults —
 *  mirrors {@link AGENT_ENDPOINT_DEFAULTS}'s CC-6 pattern exactly, one const
 *  per surface. `llamacpp` matches {@link LLAMACPP_RUN_FLAGS}'s embedding
 *  port (8081 — drift-locked by test); `openai-compat` is the vLLM
 *  convention port. `ollama` reuses {@link DEFAULT_OLLAMA_ENDPOINT} — ONE
 *  source for that value, never a second literal. Never webview-fabricated
 *  (Global Constraint 1). */
const RAG_ENDPOINT_DEFAULTS: Readonly<{ ollama: string; llamacpp: string; 'openai-compat': string }> = {
  ollama: DEFAULT_OLLAMA_ENDPOINT,
  llamacpp: 'http://127.0.0.1:8081',
  'openai-compat': 'http://127.0.0.1:8000',
};

/** Pure move of `status()`'s `tuning` object literal (Card 3 — autocomplete
 *  FIM tuning knobs). */
export function composeFimTuning(reader: SettingsReader): SetupData['fim']['tuning'] {
  return {
    debounceMs: reader.getSetting<number>('talaria.autocomplete.debounceMs') ?? 350,
    maxPromptTokens: reader.getSetting<number>('talaria.autocomplete.maxPromptTokens') ?? 1024,
    temperature: reader.getSetting<number>('talaria.autocomplete.temperature') ?? 0.01,
    crossFileEnabled: reader.getSetting<boolean>('talaria.autocomplete.crossFile.enabled') ?? true,
    prefixInjection: reader.getSetting<boolean>('talaria.autocomplete.crossFile.prefixInjection') ?? false,
    prefixInjectionRemote:
      reader.getSetting<boolean>('talaria.autocomplete.crossFile.prefixInjectionRemote') ?? false,
    warmUp: reader.getSetting<boolean>('talaria.autocomplete.crossFile.warmUp') ?? false,
  };
}

/** Pure move of `status()`'s `nextEdit` composition (Card 4 — NEXT info
 *  panel + dedicated-setup flow). `nextSource` and `genericSupported` are
 *  computed by the caller (they need `this.deps`/`fimDescriptor`, which this
 *  module deliberately has no access to) and passed in; `fimDisplayName`
 *  replaces the caller's `fimDescriptor.displayName` in the refusal copy. */
export function composeNextEditBlock(args: {
  reader: SettingsReader;
  nextSource: 'off' | 'dedicated' | 'generic';
  genericSupported: boolean;
  fimDisplayName: string;
}): SetupData['nextEdit'] {
  const { reader, nextSource, genericSupported, fimDisplayName } = args;
  const nextBackend = coerceNextEditTransport(reader.getSetting<string>('talaria.nextEdit.backend'));
  const nextEndpoint = (reader.getSetting<string>('talaria.nextEdit.endpoint') ?? '').trim();
  const nextModel = (reader.getSetting<string>('talaria.nextEdit.model') ?? '').trim();
  const dedicatedConfigured = nextEndpoint !== '' && nextModel !== '';
  // T8 (beta.6 CC-10): additive restoration hint — which unified-block pane
  // configured the dedicated NEXT connection. `undefined` (never set, or a
  // malformed/edited settings.json value) ⇒ omitted from the wire, so the
  // panel falls back to its existing transport heuristic.
  const nextDedicatedBackendIdRaw = (
    reader.getSetting<string>('talaria.nextEdit.dedicatedBackendId') ?? ''
  ).trim();
  const nextDedicatedBackendId = coerceDedicatedBackendId(
    nextDedicatedBackendIdRaw === '' ? undefined : nextDedicatedBackendIdRaw,
  );
  // T13 (§4.2): capability + raw facts for the dedicated NEXT card —
  // computed purely from the registry pins (no await; the CR-002
  // synchronous tail below stays intact). `downloadReady` is driven by the
  // sha256 pin and NOTHING else.
  const downloadReady = (NEXT_DEDICATED_MODEL.gguf.sha256 as string) !== '';
  const dedicated: NonNullable<SetupData['nextEdit']['dedicated']> = {
    displayName: NEXT_DEDICATED_MODEL.displayName,
    // ⚠ R-3: '' while !downloadReady — configuration is fail-closed, not
    // just the download (see the protocol.ts field doc).
    modelDefaults: {
      ollama: downloadReady ? NEXT_DEDICATED_MODEL.ollamaCreatedName : '',
      openaiCompat: NEXT_DEDICATED_MODEL.upstream.hfRepo,
    },
    downloadReady,
    downloadApproxBytes: NEXT_DEDICATED_MODEL.gguf.approxBytes,
    warning: NEXT_DEDICATED_WARNING,
    guided: {
      // §6 copy: command line + honesty note, newline-separated.
      vllm: `Run: vllm serve ${NEXT_DEDICATED_MODEL.upstream.hfRepo}\n(official Sweep release, ~15 GB download)`,
      // llamacpp ONLY when the pin is published (S-F2/S-F5): `-hf` verifies
      // nothing itself, so the line ships WITH the manual sha256sum hint.
      ...(downloadReady
        ? {
            llamacpp:
              `Run: llama-server -hf ${NEXT_DEDICATED_MODEL.gguf.hfRepo}:${NEXT_DEDICATED_MODEL.gguf.quant} --port 8012` +
              `\nVerify the download: sha256sum should print ${NEXT_DEDICATED_MODEL.gguf.sha256}`,
          }
        : {}),
    },
  };
  return {
    source: nextSource,
    backend: nextBackend,
    endpoint: nextEndpoint,
    model: nextModel,
    dedicatedConfigured,
    ...(nextDedicatedBackendId !== undefined ? { dedicatedBackendId: nextDedicatedBackendId } : {}),
    genericSupported,
    ...(nextSource === 'generic' && !genericSupported
      ? {
          refusalDetail: `The selected FIM backend ('${fimDisplayName}') does not support Generic Next-Edit.`,
        }
      : {}),
    dedicated,
  };
}

/** Pure move of `status()`'s `rag` composition (Card 5 — codebase index).
 *  `trusted`/`ollamaRunning`/`ollamaModels` are computed by the caller and
 *  passed in. **CAUTION**: `embedModelPresent` reproduces the deprecated
 *  wrong-daemon computation byte-identically — see its own doc below. */
export function composeRagBlock(args: {
  reader: SettingsReader;
  trusted: boolean;
  ollamaRunning: boolean;
  ollamaModels: readonly { name: string }[];
}): SetupData['rag'] {
  const { reader, trusted, ollamaRunning, ollamaModels } = args;
  const ragEnabled = reader.getSetting<boolean>('talaria.rag.enabled') ?? true;
  const ragEmbedEndpoint =
    (reader.getSetting<string>('talaria.rag.embedEndpoint') ?? '').trim() || DEFAULT_OLLAMA_ENDPOINT;
  // T8 (beta.6 CC-10): additive restoration hint — which backend the RAG
  // embedder block is configured against. UNLIKE `dedicatedBackendId`, this
  // has one clean single default ('ollama') and is ALWAYS populated on the
  // wire (never omitted) — a malformed/edited settings.json value degrades
  // to that default, same fail-closed coercion as `coerceNextEditTransport`.
  const ragEmbedBackendRaw = reader.getSetting<string>('talaria.rag.embedBackend');
  const ragEmbedBackend: 'ollama' | 'llamacpp' | 'openai-compat' =
    ragEmbedBackendRaw === 'llamacpp' || ragEmbedBackendRaw === 'openai-compat' ? ragEmbedBackendRaw : 'ollama';
  const ragEmbedModel = (reader.getSetting<string>('talaria.rag.embedModel') ?? '').trim() || DEFAULT_RAG_EMBED_MODEL;
  const ragTuning = {
    dims: reader.getSetting<number>('talaria.rag.dims') ?? 0,
    maxChunkTokens: reader.getSetting<number>('talaria.rag.maxChunkTokens') ?? 512,
    debounceMs: reader.getSetting<number>('talaria.rag.debounceMs') ?? 500,
    excludeGlobs: reader.getSetting<string[]>('talaria.rag.excludeGlobs') ?? [],
  };
  const ragIndexDir = (reader.getSetting<string>('talaria.rag.indexDir') ?? '').trim() || DEFAULT_RAG_INDEX_DIR;
  return {
    enabled: ragEnabled,
    embedEndpoint: ragEmbedEndpoint,
    embedBackend: ragEmbedBackend,
    embedModel: ragEmbedModel,
    // beta.6 panel-fix T2 (audit A5): host-owned per-pane endpoint
    // defaults, ALWAYS populated — mirrors agentLocalModel.endpointDefaults
    // (CC-6) exactly. Never webview-fabricated (Global Constraint 1).
    endpointDefaults: RAG_ENDPOINT_DEFAULTS,
    // @deprecated beta.6 T14 (wire compat only): the wrong-daemon
    // computation §3.4 replaced — it answers for the endpoint this
    // status() probed, not `embedEndpoint`, and the exact `===` misses
    // `:latest`. The unified UI derives presence client-side instead
    // (`ragEmbedPresence`, endpoint-scoped per C-6); no webview code
    // reads this field anymore (source-scan-locked in SetupPanel.test.ts).
    embedModelPresent: ollamaRunning ? ollamaModels.some((m) => m.name === ragEmbedModel) : false,
    tuning: ragTuning,
    indexDir: ragIndexDir,
    ...(trusted ? {} : { preconditionDetail: 'The codebase index needs a trusted, open workspace.' }),
  };
}
