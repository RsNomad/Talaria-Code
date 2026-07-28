import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FimEngine } from './engine';
import { AutocompleteDebouncer } from './debouncer';
import { InMemoryCompletionCache } from './cache';
import { snippetSetHash } from './context/hash';
import { scannedSnippetForTest } from './context/scannedSnippetTestFactory';
import { getStopTokens } from './stopTokens';
import { getTemplateForModel } from './templates';
import { must } from '../testing/must';
import type {
  AutocompleteOptions,
  BackendCapabilities,
  CompletionCache,
  FimBackend,
  FimContext,
  FimRequest,
} from './types';

class FakeBackend implements FimBackend {
  readonly name = 'ollama' as const;
  readonly capabilities: BackendCapabilities = {
    nativeFim: true,
    assemblesCrossFileServerSide: false,
    streaming: true,
  };
  calls: FimRequest[] = [];
  chunks: string[] = ['hello'];

  async *streamFim(req: FimRequest, signal: AbortSignal): AsyncIterable<string> {
    this.calls.push(req);
    for (const chunk of this.chunks) {
      if (signal.aborted) return;
      yield chunk;
    }
  }
}

function ctx(overrides: Partial<FimContext> = {}): FimContext {
  return {
    filepath: 'file:///repo/a.ts',
    languageId: 'plaintext',
    prefix: 'const x = ',
    suffix: ';\n',
    workspaceUris: ['file:///repo'],
    snippets: [],
    ...overrides,
  };
}

function options(overrides: Partial<AutocompleteOptions> = {}): AutocompleteOptions {
  return {
    model: 'qwen2.5-coder:1.5b-base',
    maxPromptTokens: 1024,
    prefixPercentage: 0.3,
    maxSuffixPercentage: 0.2,
    debounceMs: 350,
    multiline: 'auto',
    temperature: 0.01,
    useCache: true,
    ...overrides,
  };
}

function makeEngine(backend: FakeBackend, opts: AutocompleteOptions) {
  return new FimEngine({
    backend,
    options: opts,
    cache: new InMemoryCompletionCache(),
    debouncer: new AutocompleteDebouncer(),
  });
}

/** Records every key passed to get/put so cache-key tests can pin the exact string,
 *  while still behaving like a real cache (backed by a Map) for round-trip tests. */
class RecordingCache implements CompletionCache {
  readonly gets: string[] = [];
  readonly puts: { key: string; value: string }[] = [];
  private readonly map = new Map<string, string>();

  get(prefixKey: string): string | undefined {
    this.gets.push(prefixKey);
    return this.map.get(prefixKey);
  }

  put(prefixKey: string, completion: string): void {
    this.puts.push({ key: prefixKey, value: completion });
    this.map.set(prefixKey, completion);
  }
}

function snippet(overrides: Partial<Parameters<typeof scannedSnippetForTest>[0]> = {}) {
  return scannedSnippetForTest({
    uri: 'file:///repo/src/util.ts',
    filepath: 'src/util.ts',
    content: 'export function helper() {}',
    kind: 'recently-opened',
    startLine: 0,
    endLine: 1,
    ...overrides,
  });
}

describe('FimEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the debounce for a manual trigger and calls the backend immediately', async () => {
    const backend = new FakeBackend();
    const engine = makeEngine(backend, options());
    const result = await engine.complete(ctx(), { manual: true }, new AbortController().signal);
    expect(backend.calls.length).toBe(1);
    expect(result?.text).toBe('hello');
  });

  it('waits for the debounce delay before calling the backend on an automatic trigger', async () => {
    const backend = new FakeBackend();
    const engine = makeEngine(backend, options({ debounceMs: 350 }));
    const promise = engine.complete(ctx(), { manual: false }, new AbortController().signal);

    expect(backend.calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(350);
    const result = await promise;

    expect(backend.calls.length).toBe(1);
    expect(result?.text).toBe('hello');
  });

  it('drops a superseded automatic request without ever calling the backend for it', async () => {
    const backend = new FakeBackend();
    const engine = makeEngine(backend, options({ debounceMs: 350 }));
    const signal = new AbortController().signal;

    const first = engine.complete(ctx({ prefix: 'const x = 1' }), { manual: false }, signal);
    await vi.advanceTimersByTimeAsync(100);
    const second = engine.complete(ctx({ prefix: 'const x = 12' }), { manual: false }, signal);
    await vi.advanceTimersByTimeAsync(350);

    expect(await first).toBeUndefined();
    expect(await second).toEqual({ text: 'hello' });
    expect(backend.calls.length).toBe(1);
  });

  it('returns undefined and never calls the backend when the signal is already aborted', async () => {
    const backend = new FakeBackend();
    const engine = makeEngine(backend, options());
    const controller = new AbortController();
    controller.abort();

    const result = await engine.complete(ctx(), { manual: true }, controller.signal);

    expect(result).toBeUndefined();
    expect(backend.calls.length).toBe(0);
  });

  it('caches a completion and serves a longest-prefix match on the next call without re-hitting the backend', async () => {
    const backend = new FakeBackend();
    backend.chunks = ['1;'];
    const engine = makeEngine(backend, options());
    const signal = new AbortController().signal;

    const first = await engine.complete(
      ctx({ prefix: 'const x = ', suffix: '\n' }),
      { manual: true },
      signal,
    );
    expect(first?.text).toBe('1;');
    expect(backend.calls.length).toBe(1);

    // User typed the "1" that was already suggested.
    const second = await engine.complete(
      ctx({ prefix: 'const x = 1', suffix: '\n' }),
      { manual: true },
      signal,
    );
    expect(second?.text).toBe(';');
    expect(backend.calls.length).toBe(1); // still 1 -> served from cache
  });

  it('returns undefined when the backend only produces whitespace', async () => {
    const backend = new FakeBackend();
    backend.chunks = ['   '];
    const engine = makeEngine(backend, options());
    const result = await engine.complete(ctx(), { manual: true }, new AbortController().signal);
    expect(result).toBeUndefined();
  });

  it('truncates at the first newline when multiline is forced off', async () => {
    const backend = new FakeBackend();
    backend.chunks = ['foo\nbar'];
    const engine = makeEngine(backend, options({ multiline: 'never' }));
    const result = await engine.complete(ctx(), { manual: true }, new AbortController().signal);
    expect(result?.text).toBe('foo');
  });

  it('allows a multiline completion through untruncated when multiline is forced on', async () => {
    const backend = new FakeBackend();
    backend.chunks = ['foo\nbar'];
    const engine = makeEngine(backend, options({ multiline: 'always' }));
    const result = await engine.complete(ctx(), { manual: true }, new AbortController().signal);
    expect(result?.text).toBe('foo\nbar');
  });

  it('populates renderedPrompt only when the backend is not native-FIM', async () => {
    const backend = new FakeBackend();
    backend.capabilities.nativeFim = false;
    const engine = makeEngine(backend, options({ model: 'qwen2.5-coder:1.5b-base' }));
    await engine.complete(ctx(), { manual: true }, new AbortController().signal);

    expect(must(backend.calls[0]).renderedPrompt).toBe(
      '<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>',
    );
  });

  it('leaves renderedPrompt undefined for a native-FIM backend', async () => {
    const backend = new FakeBackend(); // nativeFim: true by default
    const engine = makeEngine(backend, options());
    await engine.complete(ctx(), { manual: true }, new AbortController().signal);
    expect(must(backend.calls[0]).renderedPrompt).toBeUndefined();
  });

  describe('cache-key snippet-set fold (R4)', () => {
    it('keys an empty-snippet completion on the fixed empty-set hash + pruned prefix (v1 parity)', async () => {
      const backend = new FakeBackend();
      backend.chunks = ['1;'];
      const cache = new RecordingCache();
      const engine = new FimEngine({
        backend,
        options: options(),
        cache,
        debouncer: new AutocompleteDebouncer(),
      });

      await engine.complete(
        ctx({ prefix: 'const x = ', suffix: '\n' }),
        { manual: true },
        new AbortController().signal,
      );

      expect(cache.puts.length).toBe(1);
      expect(must(cache.puts[0]).key).toBe('0000000000000000 const x = ');
    });

    it('produces a different cache key for a different (non-empty) snippet set', async () => {
      const backend = new FakeBackend();
      const cache = new RecordingCache();
      const engine = new FimEngine({
        backend,
        options: options(),
        cache,
        debouncer: new AutocompleteDebouncer(),
      });
      const signal = new AbortController().signal;

      await engine.complete(
        ctx({ prefix: 'const x = ', snippets: [snippet({ filepath: 'src/a.ts', content: 'const a = 1;' })] }),
        { manual: true },
        signal,
      );
      await engine.complete(
        ctx({ prefix: 'const x = ', snippets: [snippet({ filepath: 'src/b.ts', content: 'const b = 2;' })] }),
        { manual: true },
        signal,
      );

      expect(cache.puts.length).toBe(2);
      expect(must(cache.puts[0]).key).not.toBe(must(cache.puts[1]).key);
      expect(backend.calls.length).toBe(2); // second snippet set must not hit the first's cache entry
    });

    it('still serves a longest-prefix cache match within one snippet-set generation', async () => {
      const backend = new FakeBackend();
      backend.chunks = ['1;'];
      const engine = makeEngine(backend, options());
      const signal = new AbortController().signal;
      const snippets = [snippet()];

      const first = await engine.complete(
        ctx({ prefix: 'const x = ', suffix: '\n', snippets }),
        { manual: true },
        signal,
      );
      expect(first?.text).toBe('1;');
      expect(backend.calls.length).toBe(1);

      // Same snippet-set generation, longer (typed-ahead) prefix -> cache remainder.
      const second = await engine.complete(
        ctx({ prefix: 'const x = 1', suffix: '\n', snippets }),
        { manual: true },
        signal,
      );
      expect(second?.text).toBe(';');
      expect(backend.calls.length).toBe(1); // still 1 -> served from cache
    });
  });

  describe('R7 — no double-wrap for nativeFim backends', () => {
    it('never renders a template for a nativeFim backend even when snippets are non-empty', async () => {
      const backend = new FakeBackend(); // nativeFim: true
      const engine = makeEngine(backend, options({ model: 'qwen2.5-coder:1.5b-base' }));
      const snippets = [snippet()];

      await engine.complete(ctx({ snippets }), { manual: true }, new AbortController().signal);

      expect(must(backend.calls[0]).renderedPrompt).toBeUndefined();
      expect(must(backend.calls[0]).context.snippets).toEqual(snippets);
    });
  });

  /**
   * Review C-1: the historical "empty the engine's stop" break (`stop: effectiveStop`
   * -> `stop: []` at engine.ts:133) went undetected — `fimRequestBody.test.ts`
   * builds its own `req()` fixture with a hardcoded `stop`, so it exercises every
   * backend's handling of an already-built stop list but never the engine code that
   * PRODUCES it. This is the seam that closes that gap: drive `FimEngine.complete()`
   * through a stub backend and assert the `req.stop` it hands over is the REAL
   * `getStopTokens(...)` output (computed independently here, not hardcoded), so a
   * `stop: []` (or any other) mutation at the engine's call site goes RED.
   */
  describe('C-1 — engine wires the real stop-token list into the backend request', () => {
    it('hands the backend a non-empty req.stop equal to getStopTokens(template, model) plus the single-line newline guard', async () => {
      const backend = new FakeBackend();
      const model = 'qwen2.5-coder:1.5b-base';
      const engine = makeEngine(backend, options({ model, multiline: 'never' }));

      await engine.complete(ctx(), { manual: true }, new AbortController().signal);

      expect(backend.calls.length).toBe(1);
      const template = getTemplateForModel(model);
      // multiline: 'never' forces the single-line '\n' stop guard (engine.ts:109)
      // on top of the model's own template stop tokens.
      const expectedStop = [...getStopTokens(template, model), '\n'];
      expect(must(backend.calls[0]).stop).toEqual(expectedStop);
      expect(must(backend.calls[0]).stop.length).toBeGreaterThan(0);
      // Sanity: it's not just the newline guard — the template's own FIM/EOT
      // tokens (what actually halts generation at the hole boundary) are present.
      expect(must(backend.calls[0]).stop).toEqual(expect.arrayContaining(template.stop));
    });
  });

  describe('comment-inject engine wiring (§4.5, T5-activated)', () => {
    it('rewrites the request prefix with injected snippet comments when crossFileMode is comment-inject', async () => {
      const backend = new FakeBackend(); // nativeFim: true
      const engine = makeEngine(backend, options({ crossFileMode: 'comment-inject' }));
      const snippets = [snippet({ filepath: 'src/util.ts', content: 'export function helper() {}' })];

      await engine.complete(
        ctx({ prefix: 'const x = ', languageId: 'typescript', snippets }),
        { manual: true },
        new AbortController().signal,
      );

      expect(must(backend.calls[0]).prefix).toBe(
        '// Path: src/util.ts\n// export function helper() {}\nconst x = ',
      );
    });

    it.each([undefined, 'none', 'input-extra', 'template'] as const)(
      'leaves the request prefix untouched when crossFileMode is %s',
      async (mode) => {
        const backend = new FakeBackend();
        const engine = makeEngine(backend, options({ crossFileMode: mode }));
        const snippets = [snippet()];

        await engine.complete(
          ctx({ prefix: 'const x = ', snippets }),
          { manual: true },
          new AbortController().signal,
        );

        expect(must(backend.calls[0]).prefix).toBe('const x = ');
      },
    );

    it('keys the cache on the pruned pre-injection prefix, unaffected by comment-inject', async () => {
      const backend = new FakeBackend();
      backend.chunks = ['1;'];
      const cache = new RecordingCache();
      const engine = new FimEngine({
        backend,
        options: options({ crossFileMode: 'comment-inject' }),
        cache,
        debouncer: new AutocompleteDebouncer(),
      });
      const snippets = [snippet({ filepath: 'src/util.ts', content: 'export function helper() {}' })];

      await engine.complete(
        ctx({ prefix: 'const x = ', snippets }),
        { manual: true },
        new AbortController().signal,
      );

      const expectedHash = snippetSetHash(snippets);
      expect(must(cache.puts[0]).key).toBe(`${expectedHash} const x = `);
    });
  });
});
