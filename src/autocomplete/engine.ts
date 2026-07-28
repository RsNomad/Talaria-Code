import { AutocompleteDebouncer } from './debouncer';
import { balanceBrackets } from './brackets';
import { getStopTokens } from './stopTokens';
import { shouldCompleteMultiline } from './multiline';
import { postprocessCompletion } from './postprocess';
import { pruneToBudget } from './prefixSuffix';
import { getTemplateForModel } from './templates';
import { snippetSetHash } from './context/hash';
import { injectSnippetsAsComments } from './context/mode';
import type {
  AutocompleteOptions,
  CompletionCache,
  FimBackend,
  FimContext,
  FimRequest,
} from './types';

const SINGLE_LINE_MAX_TOKENS = 128;
const MULTILINE_MAX_TOKENS = 256;

export interface FimEngineDeps {
  backend: FimBackend;
  options: AutocompleteOptions;
  cache: CompletionCache;
  debouncer: AutocompleteDebouncer;
}

/**
 * IDE-agnostic core: orchestrates debounce -> prune -> cache -> backend ->
 * postprocess, per how-to §4.1/§2.6 (mirroring Continue's
 * `core/autocomplete/CompletionProvider.ts` orchestration, scoped down to the v1.0
 * single-backend/no-cross-file slice — see how-to §5).
 *
 * Deliberately has zero `vscode` dependency so it is testable without the editor
 * host (see `engine.test.ts`) and reusable if Hermes ever ships a non-VS-Code
 * client.
 */
export class FimEngine {
  private backend: FimBackend;
  private readonly options: AutocompleteOptions;
  private readonly cache: CompletionCache;
  private readonly debouncer: AutocompleteDebouncer;

  constructor(deps: FimEngineDeps) {
    this.backend = deps.backend;
    this.options = deps.options;
    this.cache = deps.cache;
    this.debouncer = deps.debouncer;
  }

  /** Hot-swap Ollama <-> llama.cpp <-> vLLM <-> Codestral <-> OpenAI-compat. */
  setBackend(backend: FimBackend): void {
    this.backend = backend;
  }

  async complete(
    ctx: FimContext,
    opts: { manual: boolean },
    signal: AbortSignal,
  ): Promise<{ text: string } | undefined> {
    if (signal.aborted) return undefined;

    if (!opts.manual) {
      // Automatic (typing) trigger: debounce. A manual (Invoke) trigger skips this
      // entirely, per how-to §2.1 ("wasManuallyTriggered ... skips debounce").
      const shouldDebounce = await this.debouncer.delayAndShouldDebounce(
        this.options.debounceMs,
      );
      if (shouldDebounce || signal.aborted) return undefined;
    }

    const { prefix: prunedPrefix, suffix } = pruneToBudget(
      ctx.prefix,
      ctx.suffix,
      this.options,
    );
    // R4 (§2.6): fold the snippet-set hash into the cache key so distinct snippet
    // sets never collide on a shared prefix. Keyed on the PRUNED (pre-injection)
    // prefix — the hash already distinguishes snippet sets, so comment-inject
    // (below) needs no extra key handling (§4.5). Empty snippets -> T0's fixed
    // constant, so v1 (no cross-file gathering) cache keys stay bit-stable vs
    // pre-W5. Recomputed here (not plumbed from the host snapshot) to keep the
    // FimContext boundary a flat `readonly ScannedSnippet[]` array (§2.6 pin).
    const cacheKey = snippetSetHash(ctx.snippets) + ' ' + prunedPrefix;

    if (this.options.useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return { text: cached };
      }
    }

    const template = getTemplateForModel(this.options.model);
    const stop = getStopTokens(template, this.options.model);

    const multiline = shouldCompleteMultiline(
      {
        fullPrefix: ctx.prefix,
        fullSuffix: ctx.suffix,
        languageId: ctx.languageId,
        hasSelectedCompletionInfo: ctx.selectedCompletionInfo !== undefined,
      },
      { multiline: this.options.multiline },
    );

    // If we're forcing single-line, add a bare newline stop so well-behaved
    // backends halt on their own; we still hard-truncate client-side below as a
    // safety net (not every runner treats "\n" as a meaningful stop string).
    const effectiveStop = multiline ? stop : [...stop, '\n'];

    // §4.5: comment-inject rewrites the request prefix AFTER the cache key is
    // computed on the pruned prefix (above) — mutually exclusive with the
    // input-extra/template modes (a backend is in exactly one crossFileMode).
    // Inert until options.crossFileMode is actually set to 'comment-inject' (T5).
    const prefix =
      this.options.crossFileMode === 'comment-inject'
        ? injectSnippetsAsComments(prunedPrefix, ctx.snippets, ctx.languageId)
        : prunedPrefix;

    const requestContext: FimContext = { ...ctx, prefix, suffix };
    // R7 (no double-wrap) — DO NOT weaken: a nativeFim backend receives snippets
    // only as raw `context.snippets` (e.g. llama.cpp input_extra), never through a
    // rendered template.
    const renderedPrompt = this.backend.capabilities.nativeFim
      ? undefined
      : template.render(prefix, suffix, requestContext);

    const req: FimRequest = {
      model: this.options.model,
      prefix,
      suffix,
      renderedPrompt,
      stop: effectiveStop,
      temperature: this.options.temperature,
      maxTokens: multiline ? MULTILINE_MAX_TOKENS : SINGLE_LINE_MAX_TOKENS,
      context: requestContext,
    };

    let completion = '';
    for await (const delta of this.backend.streamFim(req, signal)) {
      if (signal.aborted) return undefined;
      completion += delta;
      if (!multiline) {
        const newlineIdx = completion.indexOf('\n');
        if (newlineIdx !== -1) {
          completion = completion.slice(0, newlineIdx);
          break;
        }
      }
    }
    if (signal.aborted) return undefined;

    const processed = postprocessCompletion({
      completion,
      prefix,
      suffix,
      model: this.options.model,
      stop: effectiveStop,
    });
    if (processed === undefined) return undefined;

    const balanced = balanceBrackets(processed, prefix, suffix);
    if (balanced.length === 0) return undefined;

    if (this.options.useCache) {
      this.cache.put(cacheKey, balanced);
    }

    return { text: balanced };
  }
}
