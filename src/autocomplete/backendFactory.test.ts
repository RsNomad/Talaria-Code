import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createBackend, clearBackendFactoryWarnings } from './backendFactory';
import type { HermesAutocompleteConfig } from './config';
import type { FimBackendName, FimContext, FimRequest } from './types';

function cfg(overrides: Partial<HermesAutocompleteConfig> = {}): HermesAutocompleteConfig {
  return {
    enabled: true,
    backend: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen2.5-coder:1.5b-base',
    debounceMs: 350,
    maxPromptTokens: 1024,
    temperature: 0.01,
    crossFile: { enabled: true, prefixInjection: false, prefixInjectionRemote: false, warmUp: false },
    ...overrides,
  };
}

function fimContext(): FimContext {
  return {
    filepath: 'file:///a.ts',
    languageId: 'typescript',
    prefix: 'const x = ',
    suffix: '',
    workspaceUris: [],
    snippets: [],
  };
}

/** Mirrors VllmFimBackend.test.ts's `req()` — this backend has `nativeFim: false`,
 * so the engine always populates `renderedPrompt` before dispatching; mirrored
 * here since these tests bypass the engine and call `streamFim` directly. */
function fimRequest(): FimRequest {
  return {
    model: 'qwen2.5-coder:1.5b-base',
    prefix: 'const x = ',
    suffix: '',
    renderedPrompt: '<|fim_prefix|>const x = <|fim_suffix|><|fim_middle|>',
    stop: [],
    temperature: 0.01,
    maxTokens: 128,
    context: fimContext(),
  };
}

/** A `fetch` resolution whose body is a stream that closes immediately (no deltas). */
function emptyStreamResponse(): Response {
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('createBackend', () => {
  it('creates an OllamaFimBackend with capabilities.nativeFim = true', () => {
    const backend = createBackend(cfg({ backend: 'ollama' }));
    expect(backend.name).toBe('ollama');
    expect(backend.capabilities.nativeFim).toBe(true);
  });

  it('creates a LlamaCppInfillBackend that assembles cross-file context itself', () => {
    const backend = createBackend(cfg({ backend: 'llamacpp' }));
    expect(backend.name).toBe('llamacpp');
    expect(backend.capabilities.assemblesCrossFileServerSide).toBe(true);
  });

  it('creates a VllmFimBackend with capabilities.nativeFim = false (self-built FIM prompt)', () => {
    const backend = createBackend(cfg({ backend: 'vllm' }));
    expect(backend.name).toBe('vllm');
    expect(backend.capabilities.nativeFim).toBe(false);
  });

  it('creates a CodestralFimBackend', () => {
    const backend = createBackend(cfg({ backend: 'codestral', apiKey: 'k' }));
    expect(backend.name).toBe('codestral');
  });

  it('creates an OpenAICompatFimBackend', () => {
    const backend = createBackend(cfg({ backend: 'openai-compat' }));
    expect(backend.name).toBe('openai-compat');
  });
});

/**
 * A3 — connects the SecretStorage-first `apiKey` (already picked by
 * `index.ts:217-218`) to the vLLM arm, which A2 gave an `apiKey?` option and a
 * conditional Bearer header but never wired up. The `openai-compat` arm above
 * is the correct precedent: pass `cfg.apiKey` straight through, no `?? ''`
 * (that's the `codestral` arm's known wart — not fixed here, out of scope).
 */
describe('createBackend — vLLM arm apiKey wiring (A3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes apiKey through to the constructed VllmFimBackend (Authorization header present on the wire)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = createBackend(cfg({ backend: 'vllm', apiKey: 'k' }));
    const iterator = backend
      .streamFim(fimRequest(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');
  });

  it('passes apiKey through as undefined, not "", when cfg.apiKey is undefined (no `?? \'\'` coercion)', () => {
    const backend = createBackend(cfg({ backend: 'vllm', apiKey: undefined }));
    // Behaviorally, undefined and '' are indistinguishable from the outside —
    // both are falsy at VllmFimBackend's `if (this.opts.apiKey)` header check,
    // so no fetch-header assertion can tell them apart. This is the one
    // assertion in this file that reaches into the private `opts` field; it's
    // the only way to pin "no `?? ''`" per the A3 brief.
    const opts = (backend as unknown as { opts: { apiKey?: string } }).opts;
    expect(opts.apiKey).toBeUndefined();
  });
});

/**
 * F-1 — architecture-review finding: the old `default` arm silently returned
 * an `OllamaFimBackend` for any unrecognized `cfg.backend`, so a hand-built
 * config bypassing `readConfig()`'s `isFimBackendName` validation (a typo'd
 * `"vlmm"`, say) would silently speak the Ollama dialect at whatever endpoint
 * the user configured — a foreign server gets Ollama-shaped requests and the
 * user is told nothing. The exhaustiveness-checked default now fails loud.
 */
describe('createBackend — F-1 unknown backend name fails closed', () => {
  it('throws naming the offending value for a cast-forged unknown backend name', () => {
    const forged = cfg({ backend: 'nope' as unknown as FimBackendName });
    expect(() => createBackend(forged)).toThrow(/nope/);
  });
});

/**
 * Audit C-4 / review C-1 fix. `codestral` is the only backend whose DEFAULT
 * endpoint is a third-party cloud (`https://codestral.mistral.ai`,
 * `config.ts`'s `DEFAULT_ENDPOINTS`), so a keyless build must still make
 * ZERO egress — but `createBackend` itself must NEVER throw.
 *
 * WHY THE ORIGINAL FIX (throwing here) WAS WRONG (review C-1, Critical):
 * `index.ts`'s `buildEngine` calls `createBackend` SYNCHRONOUSLY at
 * activation, before SecretStorage's async load resolves — so the FIRST
 * `createBackend` call any activation makes always sees `cfg.apiKey ===
 * undefined`, even for the correct, documented "key lives in SecretStorage"
 * configuration, and even when autocomplete is disabled (`buildEngine` runs
 * before any `cfg.enabled` check). A throw here escaped `activate()` itself
 * (no try/catch anywhere around `registerHermesAutocomplete`,
 * `extension.ts:325`), killing every zone registered after autocomplete. See
 * `activationDoesNotThrow.test.ts` for the real-activation regression proof
 * (drives the REAL `registerHermesAutocomplete` against this REAL
 * `createBackend`, not a mock — every OTHER activation test mocks
 * `./backendFactory`, which is exactly why this shipped with the full suite
 * green).
 *
 * The refusal now lives on `CodestralFimBackend.streamFim` — the request
 * path — instead: see `CodestralFimBackend.test.ts` for the
 * "throws-before-fetch" proof at that layer.
 *
 * Note on naming: this project's implementation exports `createBackend`
 * (`backendFactory.ts:12`), not `createFimBackend` as an earlier draft of the
 * task-2 brief named it — matched to the real export here, and to this
 * file's own pre-existing `cfg()` helper (which uses `prefixInjectionRemote`,
 * not the brief's `prefixInjectionRemoteOptIn`) rather than re-declaring a
 * config literal that would drift from `HermesAutocompleteConfig`'s real
 * shape.
 */
describe('createBackend — audit C-4 / review C-1: a keyless Codestral config builds, but never egresses', () => {
  it('does NOT throw for backend=codestral with no apiKey (construction must survive the async SecretStorage race)', () => {
    expect(() =>
      createBackend(cfg({ backend: 'codestral', apiKey: undefined })),
    ).not.toThrow();
  });

  it('the keyless build still refuses BEFORE any egress: streamFim throws, fetch is never called', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const backend = createBackend(cfg({ backend: 'codestral', apiKey: undefined }));
      const iterator = backend
        .streamFim(fimRequest(), new AbortController().signal)
        [Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toThrow(
        'talaria.autocomplete.backend=codestral requires an API key',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still builds a working codestral backend when a key IS present', () => {
    const backend = createBackend(cfg({ backend: 'codestral', apiKey: 'sk-test' }));
    expect(backend.name).toBe('codestral');
  });

  it('does NOT refuse the local runners without a key (the remote-runner architecture stays intact)', () => {
    for (const backend of ['ollama', 'llamacpp', 'vllm', 'openai-compat'] as const) {
      expect(() =>
        createBackend(cfg({ backend, endpoint: 'http://gpu.lan:8000', apiKey: undefined })),
      ).not.toThrow();
    }
  });
});

/**
 * T-6 F4: `OllamaFimBackendOptions` has no `apiKey` field at all — Ollama's
 * `/api/generate` has no auth story this codebase speaks, so a configured
 * `talaria.autocomplete.apiKey` is silently dropped on the floor with no
 * signal anywhere (the key never even reaches `OllamaFimBackend`). This is
 * a construction-time, warn-only observation — `createBackend` must never
 * throw (see the codestral arm's own doc comment above), so this is a
 * `console.warn`, not a refusal.
 */
describe('createBackend — F4: warns once when a configured apiKey is dropped for backend=ollama', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearBackendFactoryWarnings();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when backend=ollama has a non-empty apiKey configured', () => {
    createBackend(cfg({ backend: 'ollama', apiKey: 'sk-unused' }));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/ollama/i);
  });

  it('does NOT warn when backend=ollama has no apiKey configured', () => {
    createBackend(cfg({ backend: 'ollama', apiKey: undefined }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when backend=ollama has a whitespace-only apiKey configured', () => {
    createBackend(cfg({ backend: 'ollama', apiKey: '   ' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for a DIFFERENT backend with an apiKey configured (e.g. vllm, which DOES use the key)', () => {
    createBackend(cfg({ backend: 'vllm', apiKey: 'sk-real', model: 'my-model' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns only ONCE across repeated createBackend calls until clearBackendFactoryWarnings() re-arms it', () => {
    createBackend(cfg({ backend: 'ollama', apiKey: 'sk-unused' }));
    createBackend(cfg({ backend: 'ollama', apiKey: 'sk-unused' }));
    createBackend(cfg({ backend: 'ollama', apiKey: 'sk-unused' }));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    clearBackendFactoryWarnings();
    createBackend(cfg({ backend: 'ollama', apiKey: 'sk-unused' }));
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('never throws even with the key configured', () => {
    expect(() => createBackend(cfg({ backend: 'ollama', apiKey: 'sk-unused' }))).not.toThrow();
  });
});

/**
 * T-6 F6: construction-time `surfaceOnce` (here: `console.warn`, see F4's
 * doc comment above for why) for a backend↔endpoint/model pairing this
 * codebase's OWN backend doc comments already document as broken —
 * WARN-ONLY, no behavior/egress change. Two pairings, per the architecture
 * doc: `openai-compat` pointed at vLLM's own default port (vLLM
 * 400-rejects the `suffix` field `OpenAICompatFimBackend` sends — its own
 * doc comment says so), and `vllm` given an Ollama-style `name:tag` model
 * string (vLLM serves models by their own repo id/served-name, never that
 * convention — the audit's F-B finding: this is true of `config.ts`'s own
 * DEFAULT_MODEL).
 */
describe('createBackend — F6: warns once for a self-documented-broken backend/endpoint/model pairing', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearBackendFactoryWarnings();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when backend=openai-compat is pointed at vLLM\'s default port (127.0.0.1:8000)', () => {
    createBackend(cfg({ backend: 'openai-compat', endpoint: 'http://127.0.0.1:8000' }));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/vllm/i);
  });

  it('does NOT warn when backend=openai-compat is pointed at a DIFFERENT port', () => {
    createBackend(cfg({ backend: 'openai-compat', endpoint: 'http://127.0.0.1:11434' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for backend=vllm itself pointed at its own default port (that pairing is CORRECT)', () => {
    createBackend(cfg({ backend: 'vllm', endpoint: 'http://127.0.0.1:8000', model: 'Qwen/Qwen2.5-Coder-7B' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when backend=vllm is given an Ollama-style "name:tag" model', () => {
    createBackend(cfg({ backend: 'vllm', model: 'qwen2.5-coder:7b-base' }));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/vllm/i);
  });

  it('does NOT warn when backend=vllm is given a plain (colon-free) model name', () => {
    createBackend(cfg({ backend: 'vllm', model: 'Qwen/Qwen2.5-Coder-7B' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for backend=ollama given the SAME colon-tag model (that pairing is CORRECT — Ollama tags always look like this)', () => {
    createBackend(cfg({ backend: 'ollama', model: 'qwen2.5-coder:7b-base' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never throws for a garbage (non-URL) endpoint on backend=openai-compat', () => {
    expect(() =>
      createBackend(cfg({ backend: 'openai-compat', endpoint: 'not a url at all' })),
    ).not.toThrow();
  });
});
