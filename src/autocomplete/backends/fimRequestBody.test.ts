import { describe, it, expect, vi, afterEach } from 'vitest';
import { VllmFimBackend } from './VllmFimBackend';
import { OllamaFimBackend } from './OllamaFimBackend';
import { LlamaCppInfillBackend } from './LlamaCppInfillBackend';
import { OpenAICompatFimBackend } from './OpenAICompatFimBackend';
import { CodestralFimBackend } from './CodestralFimBackend';
import type { FimContext, FimRequest } from '../types';

/**
 * Audit B-9 + F-1. Before this file, exactly ONE assertion in the whole suite
 * looked at a FIM request body (`VllmFimBackend.test.ts:254`, and only at
 * `body.prompt`). Deleting `suffix`, deleting `stop`, or SWAPPING prefix and
 * suffix all left the suite green. These tests pin the wire body of every
 * backend field-by-field, so any of those mutations goes RED.
 */
function fimContext(): FimContext {
  return {
    filepath: 'file:///a.ts',
    languageId: 'typescript',
    prefix: 'PREFIX_MARKER',
    suffix: 'SUFFIX_MARKER',
    workspaceUris: [],
    snippets: [],
  };
}

function req(): FimRequest {
  return {
    model: 'qwen2.5-coder:1.5b-base',
    prefix: 'PREFIX_MARKER',
    suffix: 'SUFFIX_MARKER',
    renderedPrompt: '<|fim_prefix|>PREFIX_MARKER<|fim_suffix|>SUFFIX_MARKER<|fim_middle|>',
    stop: ['<|fim_pad|>', '<|endoftext|>'],
    temperature: 0.01,
    maxTokens: 128,
    context: fimContext(),
  };
}

function emptyStreamResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

async function captureBody(run: () => AsyncIterable<string>): Promise<Record<string, unknown>> {
  const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
  vi.stubGlobal('fetch', fetchSpy);
  const iterator = run()[Symbol.asyncIterator]();
  await iterator.next().catch(() => undefined);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('F-1: the vLLM FIM body pins skip_special_tokens:false', () => {
  it('sends skip_special_tokens:false so special-token stops can fire at all', async () => {
    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    // vLLM's default is skip_special_tokens=True
    // (Runners/vllm/vllm/sampling_params.py:295 — `skip_special_tokens: bool = True`),
    // and stop STRINGS are matched against already-detokenized text, so
    // 9 of our 12 stop strings can never fire without this field.
    expect(body.skip_special_tokens).toBe(false);
  });

  it('sends the stop list verbatim and in order', async () => {
    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(body.stop).toEqual(['<|fim_pad|>', '<|endoftext|>']);
  });

  it('sends renderedPrompt verbatim — prefix before suffix, never swapped', async () => {
    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(body.prompt).toBe('<|fim_prefix|>PREFIX_MARKER<|fim_suffix|>SUFFIX_MARKER<|fim_middle|>');
  });
});

describe('B-9: every FIM backend body carries prefix and suffix in the right slots', () => {
  it('Ollama sends prefix as `prompt` and suffix as its own field, never swapped', async () => {
    // Constraint (wave-6, added over the brief): the brief's version of this
    // test asserted `body.prompt` CONTAINS both PREFIX_MARKER and
    // SUFFIX_MARKER — i.e. it assumed a single combined rendered-prompt
    // string, the vLLM (`nativeFim:false`) shape. Ollama is `nativeFim:true`
    // (`OllamaFimBackend.ts`'s own doc comment: `POST /api/generate` with
    // `{prompt, suffix}` — native server-side FIM; `BackendCapabilities.
    // nativeFim`'s doc: "true = endpoint takes prefix/suffix fields
    // server-side (Ollama, Codestral, OpenAI-compat)"). `body.prompt` is
    // ALWAYS just the prefix here — the suffix never appears inside it. The
    // brief's assertion could not pass against correct code; source wins.
    // This exact-field check is strictly stronger than the brief's substring
    // check anyway: it still catches a deleted `suffix` (audit history #1)
    // or a prefix/suffix swap, and now matches the llama.cpp/Codestral
    // sibling tests' field-by-field shape in this same describe block.
    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(body.prompt).toBe('PREFIX_MARKER');
    expect(body.suffix).toBe('SUFFIX_MARKER');
    // Global Constraint: FIM never sends `raw`.
    expect(body.raw).toBeUndefined();
    // Global Constraint: no `num_ctx` in code, ever.
    expect(JSON.stringify(body)).not.toContain('num_ctx');
    // Review I-2: `stop` was deleted from this backend in one of the historical
    // breaks; it lives NESTED at `options.stop` here (Ollama's `/api/generate`
    // shape), not at the top level — a top-level `body.stop` assertion would
    // silently miss a deletion of the nested field.
    const options = body.options as Record<string, unknown>;
    expect(options.stop).toEqual(['<|fim_pad|>', '<|endoftext|>']);
  });

  it('llama.cpp /infill puts prefix and suffix in their OWN fields, never swapped', async () => {
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(body.input_prefix).toBe('PREFIX_MARKER');
    expect(body.input_suffix).toBe('SUFFIX_MARKER');
    // Review I-2: `stop` is a top-level field on this backend's `/infill` body.
    expect(body.stop).toEqual(['<|fim_pad|>', '<|endoftext|>']);
  });

  it('openai-compat pins skip_special_tokens:false and sends the stop list', async () => {
    const backend = new OpenAICompatFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    // Constraint (wave-6, added over the brief): the brief's own version of
    // this test named "pins skip_special_tokens:false" in its title but
    // never actually asserted on `body.skip_special_tokens` — a test that
    // cannot fail for the behavior it claims to pin is a defect in the test,
    // not a passing guard. Asserting on the field for real is what makes
    // "add the field to that backend too" (brief, Step 1 preamble) a change
    // this file can actually prove.
    expect(body.skip_special_tokens).toBe(false);
    expect(body.stop).toEqual(['<|fim_pad|>', '<|endoftext|>']);
    // Review I-3: this describe block is titled "every FIM backend body carries
    // prefix and suffix in the right slots" but this one case (alone, of the
    // five) never checked it — a prefix/suffix swap here was invisible to a
    // reader auditing by the block's own name. Two lines close it.
    expect(body.prompt).toBe('PREFIX_MARKER');
    expect(body.suffix).toBe('SUFFIX_MARKER');
  });

  it('Codestral sends prefix as `prompt` and suffix as `suffix`, never swapped', async () => {
    const backend = new CodestralFimBackend({
      apiBase: 'https://codestral.mistral.ai',
      apiKey: 'sk-test',
      model: 'codestral-latest',
    });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(body.prompt).toBe('PREFIX_MARKER');
    expect(body.suffix).toBe('SUFFIX_MARKER');
    // Review I-2: `stop` is a top-level field on Codestral's `/v1/fim/completions` body.
    expect(body.stop).toEqual(['<|fim_pad|>', '<|endoftext|>']);
  });
});

/**
 * Review I-1: every assertion above is a key-SUBSET check (`expect(body.field)...`)
 * — it proves the pinned fields are present and correct, but says nothing about
 * fields that shouldn't be there. A renamed, added, or retyped field that the
 * subset checks don't happen to name is invisible: the reviewer's M7 plant
 * (rename `max_tokens` -> `maxTokens`, add `echo: true` and `best_of: 4`) left
 * every existing assertion in this file satisfied and the whole suite green,
 * while `maxTokens` is silently ignored by a real `/v1/completions` server
 * (unbounded generation — the same symptom as C-1) and `echo: true` makes the
 * server prepend the entire FIM prompt to the completion (prefix duplicated
 * into ghost text).
 *
 * Fix: the exact-key-set pattern already used for next-edit's Ollama body
 * (`nextedit/backend.test.ts:182`, `Object.keys(options).sort()).toEqual([...])`)
 * applied here to all five FIM bodies, converting subset checks into exact
 * checks. Key REORDERING must stay green (JSON key order isn't semantic);
 * a renamed/added/retyped key must go RED.
 */
describe('I-1: FIM request bodies are an exact key set (rename/add/retype must go RED)', () => {
  it('vLLM body has exactly these keys, no more, no fewer', async () => {
    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'model', 'prompt', 'skip_special_tokens', 'stop', 'stream', 'temperature'].sort(),
    );
  });

  it('Ollama body has exactly these top-level keys, and options has exactly these nested keys', async () => {
    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(Object.keys(body).sort()).toEqual(
      ['keep_alive', 'model', 'options', 'prompt', 'stream', 'suffix'].sort(),
    );
    const options = body.options as Record<string, unknown>;
    expect(Object.keys(options).sort()).toEqual(['num_predict', 'stop', 'temperature'].sort());
  });

  it('llama.cpp /infill body has exactly these keys, no more, no fewer', async () => {
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(Object.keys(body).sort()).toEqual(
      ['input_extra', 'input_prefix', 'input_suffix', 'n_predict', 'prompt', 'stop', 'stream', 'temperature'].sort(),
    );
  });

  it('openai-compat body has exactly these keys, no more, no fewer', async () => {
    const backend = new OpenAICompatFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'm' });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'model', 'prompt', 'skip_special_tokens', 'stop', 'stream', 'suffix', 'temperature'].sort(),
    );
  });

  it('Codestral body has exactly these keys, no more, no fewer', async () => {
    const backend = new CodestralFimBackend({
      apiBase: 'https://codestral.mistral.ai',
      apiKey: 'sk-test',
      model: 'codestral-latest',
    });
    const body = await captureBody(() => backend.streamFim(req(), new AbortController().signal));
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'model', 'prompt', 'stop', 'stream', 'suffix', 'temperature'].sort(),
    );
  });
});
