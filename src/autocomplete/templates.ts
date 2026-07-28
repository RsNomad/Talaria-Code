import type { FimContext, FimTemplate } from './types';

/**
 * Exact FIM templates, copied verbatim from
 * `research/vscode-hermes/autocomplete-fim-howto.md` §3.1 (itself pinned from
 * Continue's `core/autocomplete/templating/AutocompleteTemplate.ts`). Special
 * tokens are NOT paraphrased — they must match each model's tokenizer exactly.
 */

/** file:///repo/src/a.ts + [file:///repo] -> src/a.ts. Also passes through already-relative paths unchanged. */
function toRelativePath(uriOrPath: string, workspaceUris: string[]): string {
  for (const wsUri of workspaceUris) {
    const withSlash = wsUri.endsWith('/') ? wsUri : `${wsUri}/`;
    if (uriOrPath.startsWith(withSlash)) {
      return uriOrPath.slice(withSlash.length);
    }
  }
  return uriOrPath;
}

const QWEN_STOP = [
  '<|endoftext|>',
  '<|fim_prefix|>',
  '<|fim_middle|>',
  '<|fim_suffix|>',
  '<|fim_pad|>',
  '<|repo_name|>',
  '<|file_sep|>',
  '<|im_start|>',
  '<|im_end|>',
];

/**
 * Qwen2.5-Coder — repo-level (cross-file) FIM. Falls back to the plain
 * single-file form when there are no snippets.
 *
 * Audit G-14: a second export, `qwenCoderFimTemplate`, used to sit above this
 * one holding a duplicate of the same token string. It was unreachable —
 * `matchTemplateForModel` routes every `qwen`+`coder` model here — and it had
 * the more obvious name, so a future token edit could land in the copy that
 * does nothing. THIS is the only Qwen FIM template.
 */
export const qwenMultifileFimTemplate: FimTemplate = {
  render: (prefix, suffix, ctx: FimContext) => {
    if (ctx.snippets.length === 0) {
      return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
    }
    const fileBlocks = ctx.snippets
      .map(
        (s) =>
          `<|file_sep|>${toRelativePath(s.filepath, ctx.workspaceUris)}\n${s.content}`,
      )
      .join('\n');
    const currentPath = toRelativePath(ctx.filepath, ctx.workspaceUris);
    return (
      `<|repo_name|>${ctx.reponame ?? ''}\n${fileBlocks}\n` +
      `<|file_sep|>${currentPath}\n` +
      `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
    );
  },
  stop: QWEN_STOP,
  supportsSnippets: true,
};

/** StarCoder2 (arXiv 2402.19173 §5.1) — cross-file snippets joined by `<file_sep>`. */
export const starcoder2FimTemplate: FimTemplate = {
  render: (prefix, suffix, ctx: FimContext) => {
    const otherFiles =
      ctx.snippets.length === 0
        ? ''
        : `<file_sep>${ctx.snippets.map((s) => s.content).join('<file_sep>')}<file_sep>`;
    return `${otherFiles}<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`;
  },
  stop: [
    '<fim_prefix>',
    '<fim_suffix>',
    '<fim_middle>',
    '<file_sep>',
    '<|endoftext|>',
    // StarCoder2 artifact guards (getStopTokens.ts adds these too when model
    // includes "starcoder2"; kept here as well so this template is self-contained).
    't.',
    '\nt',
  ],
  supportsSnippets: true,
};

/** StableCode / generic fallback — also selected for bare "qwen" (non-coder) and codeqwen. */
export const stableCodeFimTemplate: FimTemplate = {
  render: (prefix, suffix) =>
    `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
  stop: [
    '<fim_prefix>',
    '<fim_suffix>',
    '<fim_middle>',
    '<file_sep>',
    '<|endoftext|>',
    '</fim_middle>',
    '</code>',
  ],
};

/** Codestral — raw template form. Prefer `CodestralFimBackend`'s native endpoint instead. */
export const codestralFimTemplate: FimTemplate = {
  render: (prefix, suffix) => `[SUFFIX]${suffix}[PREFIX]${prefix}`,
  stop: ['[PREFIX]', '[SUFFIX]'],
};

export const codeLlamaFimTemplate: FimTemplate = {
  render: (prefix, suffix) => `<PRE> ${prefix} <SUF>${suffix} <MID>`,
  stop: ['<PRE>', '<SUF>', '<MID>', '<EOT>'],
};

export const deepseekFimTemplate: FimTemplate = {
  render: (prefix, suffix) =>
    `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
  stop: [
    '<｜fim▁begin｜>',
    '<｜fim▁hole｜>',
    '<｜fim▁end｜>',
    '//',
    '<｜end▁of▁sentence｜>',
  ],
};

export const codegemmaFimTemplate: FimTemplate = {
  render: (prefix, suffix) =>
    `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
  stop: [
    '<|fim_prefix|>',
    '<|fim_suffix|>',
    '<|fim_middle|>',
    '<|file_separator|>',
    '<end_of_turn>',
    '<eos>',
  ],
};

/** Instruct "hole filler" fallback for chat-only models (gpt/claude) with no FIM tokens. */
export const holeFillerTemplate: FimTemplate = {
  render: (prefix, suffix) =>
    'You are a HOLE FILLER. Complete the code where {{FILL_HERE}} appears, replying with ' +
    'only the replacement text inside a <COMPLETION/> tag.\n\n<QUERY>\n' +
    `${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\n<COMPLETION>`,
  stop: ['</COMPLETION>'],
};

/**
 * Selects the FIM template by substring match on the model name, per
 * `getTemplateForModel` (how-to §3.1): "qwen"+"coder" -> Qwen multifile;
 * "starcoder2" (checked BEFORE the bare-starcoder catch-all, A7) -> StarCoder2;
 * bare "starcoder"/"star-coder" (v1)/"stable"/"codeqwen"/"qwen" -> StableCode FIM;
 * "codestral" -> Codestral; "codellama"/"deepseek"/"codegemma" -> their own;
 * "gpt"/"claude" -> hole filler.
 *
 * Task 16 (`08` §11, ADR-010): this is the chain itself, WITHOUT the
 * unknown-model default — `null` means "no branch matched". Both
 * `getTemplateForModel` (the fallback survives, unchanged) and
 * `isKnownFimModel` (the new caught-here signal) are thin wrappers over this
 * one function so the two can never disagree about what "known" means.
 */
function matchTemplateForModel(model: string): FimTemplate | null {
  const m = model.toLowerCase();

  if (m.includes('qwen') && m.includes('coder')) {
    return qwenMultifileFimTemplate;
  }
  // A7: match starcoder2 SPECIFICALLY, before the bare-starcoder catch-all below —
  // a bare match would also capture StarCoder v1 and silently swap in StarCoder2's
  // stop list / <file_sep> repo-FIM dialect for a family trained differently.
  if (m.includes('starcoder2')) {
    return starcoder2FimTemplate;
  }
  if (
    m.includes('starcoder') ||
    m.includes('star-coder') ||
    m.includes('stable') ||
    m.includes('codeqwen') ||
    m.includes('qwen')
  ) {
    return stableCodeFimTemplate;
  }
  if (m.includes('codestral')) {
    return codestralFimTemplate;
  }
  if (m.includes('codegemma')) {
    return codegemmaFimTemplate;
  }
  if (m.includes('codellama')) {
    return codeLlamaFimTemplate;
  }
  if (m.includes('deepseek')) {
    return deepseekFimTemplate;
  }
  if (m.includes('gpt') || m.includes('claude') || m.includes('davinci')) {
    return holeFillerTemplate;
  }

  return null;
}

/**
 * Zero behavior change from the pre-Task-16 chain: every existing caller
 * (`engine.ts:93`, `index.ts:340`) keeps getting `stableCodeFimTemplate` for
 * an unrecognized model — the nativeFim paths (stop-list-only consumption)
 * depend on that fallback surviving.
 */
export function getTemplateForModel(model: string): FimTemplate {
  return matchTemplateForModel(model) ?? stableCodeFimTemplate;
}

/**
 * Task 16 (`08` §11, ADR-010): true iff `model` matches a REAL branch of the
 * chain above (not merely "produces a template" — every input produces one,
 * via the fallback). Consumed by `provider.ts` to decide the one-shot
 * warn-and-proceed (nativeFim backends) vs warn-and-REFUSE (`vllm`
 * self-render) split before the engine is ever called.
 */
export function isKnownFimModel(model: string): boolean {
  return matchTemplateForModel(model) !== null;
}
