/**
 * IDE-agnostic types for the Hermes FIM (fill-in-the-middle) autocomplete engine.
 *
 * Nothing in this file imports `vscode`. The VS Code adapter (`provider.ts`) is the
 * only place that translates editor state into these shapes, so the engine below it
 * (`engine.ts`) and everything it depends on stays testable without the editor host.
 *
 * Shapes are pinned from `research/vscode-hermes/autocomplete-fim-howto.md` §4.1.
 */
import type { ScannedSnippet, CrossFileMode } from './context/types';

/** Raw editor context captured on each provider call, pre-templating. */
export interface FimContext {
  /** `document.uri.toString()`. */
  filepath: string;
  /** `document.languageId`. */
  languageId: string;
  /** Start-of-file → cursor (plus any selected IntelliSense widget text). May be pruned. */
  prefix: string;
  /** Cursor → end-of-file. May be pruned. */
  suffix: string;
  reponame?: string;
  workspaceUris: string[];
  /** Cross-file context. Empty in v1 (no cross-file gathering — see how-to §5 v1.2).
   *  Ordered most-relevant-LAST (§2.5). Every element has passed the secret scanner
   *  (§3.2, `ringBuffer.ts` ingest) — the `ScannedSnippet` brand IS the gate: an
   *  unscanned array does not type-check here. */
  snippets: readonly ScannedSnippet[];
  /** Set when the IntelliSense widget is open; mirrors `vscode.SelectedCompletionInfo`. */
  selectedCompletionInfo?: {
    range: { start: number; end: number };
    text: string;
  };
}

export type CrossFileSnippetKind =
  | 'recently-edited'
  | 'recently-opened'
  | 'import-def'
  | 'lsp-def'
  | 'diff'
  | 'rag';

export interface CrossFileSnippet {
  uri: string;
  filepath: string;
  content: string;
  kind: CrossFileSnippetKind;
  startLine: number;
  endLine: number;
}

/** Fully rendered request handed to a backend. */
export interface FimRequest {
  model: string;
  /** Pruned to `prefixPercentage` of the token budget. */
  prefix: string;
  /** Pruned to `maxSuffixPercentage` of the token budget. */
  suffix: string;
  /** Set when the chosen backend has `capabilities.nativeFim === false`; undefined otherwise. */
  renderedPrompt?: string;
  stop: string[];
  temperature: number;
  maxTokens: number;
  /** For backends that assemble their own cross-file context (llama.cpp `input_extra`). */
  context: FimContext;
}

export interface BackendCapabilities {
  /** true = endpoint takes prefix/suffix fields server-side (Ollama, Codestral, OpenAI-compat). */
  nativeFim: boolean;
  /** true = backend assembles cross-file context itself, e.g. llama.cpp `input_extra`. */
  assemblesCrossFileServerSide: boolean;
  streaming: boolean;
}

export type FimBackendName =
  | 'ollama'
  | 'llamacpp'
  | 'vllm'
  | 'codestral'
  | 'openai-compat';

/** The pluggable backend contract. Every backend implements exactly this. */
export interface FimBackend {
  readonly name: FimBackendName;
  readonly capabilities: BackendCapabilities;
  /** Stream completion text deltas; must honor `signal` for cancellation. */
  streamFim(req: FimRequest, signal: AbortSignal): AsyncIterable<string>;
  /**
   * Optional llama.vim-style KV-cache warm-up (W5-T7, §2.4). Only
   * `LlamaCppInfillBackend` implements this; every other backend is a safe
   * no-op via optional chaining at the call site — mirrors the W4
   * `AcpClientLike.closeSession?` pattern. Called fire-and-forget by
   * `CrossFileContextService` on snapshot regeneration, default-off.
   *
   * Typed with the engine-visible `readonly ScannedSnippet[]`, NOT the
   * host-side `SnippetSnapshot` (critic finding 11): the backend contract
   * must not import a `context/`-layer snapshot type, or it inverts the
   * engine→gather dependency direction.
   *
   * Fire-and-forget by CONTRACT: returns `void`, never a `Promise` the
   * caller is expected to await. An implementation must swallow its own
   * errors internally (a warm-up failure must never surface or throw — it
   * is a best-effort latency optimization, not a real request) and honor
   * `signal` for cancellation.
   */
  warmUp?(snippets: readonly ScannedSnippet[], signal: AbortSignal): void;
}

/** Builds the raw FIM prompt string for a model family; unused by native-FIM backends. */
export interface FimTemplate {
  render(prefix: string, suffix: string, ctx: FimContext): string;
  stop: string[];
  /** Optional (single-owner boundary — see W5-T0 report): `true` on templates that
   *  know how to render `ctx.snippets` into the prompt (set by T4 on the two
   *  snippet-aware templates). `undefined`/absent = not snippet-aware = safe
   *  degrade, identical to v1. */
  supportsSnippets?: boolean;
}

export interface AutocompleteOptions {
  model: string;
  maxPromptTokens: number; // 1024
  prefixPercentage: number; // 0.30
  maxSuffixPercentage: number; // 0.20
  debounceMs: number; // 350
  multiline: 'auto' | 'always' | 'never';
  temperature: number; // 0.01
  useCache: boolean;
  /** Optional (single-owner boundary — see W5-T0 report): `undefined` = `'none'` =
   *  v1 behavior. T4/T5 set this through the rebuild path. */
  crossFileMode?: CrossFileMode;
}

export interface CompletionCache {
  /** Longest-prefix match, returns the completion remainder (already-typed portion sliced off). */
  get(prefixKey: string): string | undefined;
  put(prefixKey: string, completion: string): void;
}
