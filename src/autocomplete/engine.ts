import { AutocompleteDebouncer } from './debouncer';
import { balanceBrackets } from './brackets';
import { getStopTokens } from './stopTokens';
import { shouldCompleteMultiline } from './multiline';
import { postprocessCompletion } from './postprocess';
import { pruneToBudget } from './prefixSuffix';
import { getTemplateForModel } from './templates';
import { snippetSetHash, fimContextHash } from './context/hash';
import { injectSnippetsAsComments } from './context/mode';
import type { FimEgressGuard } from './egressScan';
import type {
  AutocompleteOptions,
  CompletionCache,
  FimBackend,
  FimContext,
  FimRequest,
} from './types';

const SINGLE_LINE_MAX_TOKENS = 128;
const MULTILINE_MAX_TOKENS = 256;

/** CA-06-face + CA-06-path-face — the notice seam's verdict union and shape.
 *  Host-pure: plain types, no vscode. 'content-block'/'allow' are the
 *  ENGINE's face (its guard verdict, mapped at the single call site);
 *  'path-block' is emitted one layer above by the PROVIDER's secret-path
 *  gate (provider.ts) — the engine can never emit it, and the provider
 *  never emits the other two. */
export type FimEgressNoticeVerdict = 'path-block' | 'content-block' | 'allow';
export type EgressVerdictObserver = (filepath: string, verdict: FimEgressNoticeVerdict) => void;

export interface FimEngineDeps {
  backend: FimBackend;
  options: AutocompleteOptions;
  cache: CompletionCache;
  debouncer: AutocompleteDebouncer;
  /** CA-06 — consulted with the exact egressing strings immediately before
   *  `streamFim`. `'block'` ⇒ return undefined (no egress, fail-closed).
   *  Built once per engine (`makeFimEgressGuard(cfg.endpoint)`) — loopback
   *  endpoints get a constant-allow (zero added work on the default path). */
  checkEgress: FimEgressGuard;
  /** CA-06-face — optional, purely OBSERVATIONAL: notified with the guard's
   *  verdict on every guard-consulted attempt. It cannot affect the
   *  completion path: the verdict is decided before the call, the return
   *  value is ignored, and a throw is swallowed at the call site. The
   *  composition root OMITS this key entirely (key omission, never
   *  `= undefined`) for loopback endpoints, so the default path never even
   *  carries the callback. Optional-by-design — absence is a first-class
   *  correct state for an observer, unlike the load-bearing `checkEgress`. */
  onEgressVerdict?: EgressVerdictObserver;
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
  private readonly checkEgress: FimEgressGuard;
  private readonly onEgressVerdict: EgressVerdictObserver | undefined;

  constructor(deps: FimEngineDeps) {
    this.backend = deps.backend;
    this.options = deps.options;
    this.cache = deps.cache;
    this.debouncer = deps.debouncer;
    this.checkEgress = deps.checkEgress;
    this.onEgressVerdict = deps.onEgressVerdict;
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
    // R4 (§2.6): the snippet-set hash keys the context PARTITION so distinct
    // snippet sets never collide on a shared prefix. CA-07 widens this with
    // a fixed-width fold of the pruned suffix, filepath and languageId --
    // same-prefix requests from a different context must never collide on
    // a shared cache partition. The PRUNED suffix is used here (the same
    // bytes that egress below). Keyed on the PRUNED (pre-injection) prefix
    // — see the original design note.
    const contextKey =
      snippetSetHash(ctx.snippets) + ' ' + fimContextHash(ctx.languageId, ctx.filepath, suffix);
    // F1-10: an empty pruned prefix gives prefix-matching nothing to match
    // on — skip the cache entirely (the cache also refuses at both ends).
    const cacheEligible = this.options.useCache && prunedPrefix.length > 0;

    if (cacheEligible) {
      const cached = this.cache.get(contextKey, prunedPrefix);
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

    // CA-06 — the active-file content egress gate. `prefix` here is the
    // post-prune, post-injection string and `suffix` the post-prune string:
    // exactly the bytes about to egress (renderedPrompt is derived from
    // these two plus already-scanned ScannedSnippets and name-derived
    // fields). A 'block' — scanner hit OR scanner error — means NO egress,
    // silently (the ringBuffer.ingest drop posture): fail-closed.
    const egressVerdict = this.checkEgress([prefix, suffix]);
    if (this.onEgressVerdict !== undefined) {
      // CA-06-face: observational ONLY. The verdict is already decided (the
      // const above); the observer gets no scanned text, its return value is
      // ignored, and a throw is swallowed — it cannot cause egress, cannot
      // un-block, cannot break or delay completions (never awaited). The
      // guard verdict maps onto the two-kind notice union here: the engine
      // only ever speaks content kinds ('path-block' is the provider's).
      try {
        this.onEgressVerdict(ctx.filepath, egressVerdict === 'block' ? 'content-block' : 'allow');
      } catch {
        // Fail-safe surface: a broken notice must never reach this path.
      }
    }
    if (egressVerdict === 'block') {
      return undefined;
    }

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
      ...(renderedPrompt !== undefined ? { renderedPrompt } : {}),
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

    if (cacheEligible) {
      this.cache.put(contextKey, prunedPrefix, balanced);
    }

    return { text: balanced };
  }
}
