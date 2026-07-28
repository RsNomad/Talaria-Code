import { describe, it, expect } from 'vitest';
import {
  getTemplateForModel,
  isKnownFimModel,
  qwenMultifileFimTemplate,
  starcoder2FimTemplate,
  stableCodeFimTemplate,
  codestralFimTemplate,
  codeLlamaFimTemplate,
  deepseekFimTemplate,
  codegemmaFimTemplate,
  holeFillerTemplate,
} from './templates';
import { scannedSnippetForTest } from './context/scannedSnippetTestFactory';
import type { FimContext } from './types';

function ctx(overrides: Partial<FimContext> = {}): FimContext {
  return {
    filepath: 'file:///repo/src/a.ts',
    languageId: 'typescript',
    prefix: 'const x = ',
    suffix: ';\n',
    workspaceUris: ['file:///repo'],
    snippets: [],
    ...overrides,
  };
}

describe('getTemplateForModel — selection', () => {
  it('picks the Qwen2.5-Coder (multifile) template for qwen+coder models', () => {
    const t = getTemplateForModel('qwen2.5-coder:1.5b-base');
    expect(t.render('PRE', 'SUF', ctx())).toBe(
      '<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>',
    );
    expect(t.stop).toContain('<|fim_prefix|>');
    expect(t.stop).toContain('<|endoftext|>');
  });

  it('picks the generic StableCode FIM template for bare qwen/starcoder(v1)/stable models', () => {
    const t1 = getTemplateForModel('starcoder-1b');
    expect(t1.render('PRE', 'SUF', ctx())).toBe(
      '<fim_prefix>PRE<fim_suffix>SUF<fim_middle>',
    );
    const t2 = getTemplateForModel('stable-code-3b');
    expect(t2.render('PRE', 'SUF', ctx())).toBe(
      '<fim_prefix>PRE<fim_suffix>SUF<fim_middle>',
    );
  });

  it('picks the Codestral template for codestral models', () => {
    const t = getTemplateForModel('codestral-latest');
    expect(t.render('PRE', 'SUF', ctx())).toBe('[SUFFIX]SUF[PREFIX]PRE');
    expect(t.stop).toEqual(['[PREFIX]', '[SUFFIX]']);
  });

  it('picks the CodeLlama template', () => {
    const t = getTemplateForModel('codellama:7b-code');
    expect(t.render('PRE', 'SUF', ctx())).toBe('<PRE> PRE <SUF>SUF <MID>');
    expect(t.stop).toEqual(['<PRE>', '<SUF>', '<MID>', '<EOT>']);
  });

  it('picks the DeepSeek-Coder template', () => {
    const t = getTemplateForModel('deepseek-coder-1.3b-base');
    expect(t.render('PRE', 'SUF', ctx())).toBe(
      '<｜fim▁begin｜>PRE<｜fim▁hole｜>SUF<｜fim▁end｜>',
    );
  });

  it('picks the CodeGemma template', () => {
    const t = getTemplateForModel('codegemma:code');
    expect(t.render('PRE', 'SUF', ctx())).toBe(
      '<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>',
    );
    expect(t.stop).toContain('<|file_separator|>');
    expect(t.stop).toContain('<end_of_turn>');
  });

  it('falls back to the generic StableCode FIM template for unknown models', () => {
    const t = getTemplateForModel('some-unknown-model-xyz');
    expect(t.render('PRE', 'SUF', ctx())).toBe(
      '<fim_prefix>PRE<fim_suffix>SUF<fim_middle>',
    );
  });

  it('is case-insensitive on the model name', () => {
    const t = getTemplateForModel('QWEN2.5-CODER:3B');
    expect(t.render('PRE', 'SUF', ctx())).toBe(
      '<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>',
    );
  });

  it('picks the StarCoder2-specific template for starcoder2 models (A7: not bare StarCoder v1)', () => {
    const v2 = getTemplateForModel('starcoder2-3b');
    expect(v2).toBe(starcoder2FimTemplate);

    const v1 = getTemplateForModel('starcoder-1b');
    expect(v1).toBe(stableCodeFimTemplate);
    expect(v1).not.toBe(starcoder2FimTemplate);
  });

  it('is case-insensitive when matching starcoder2', () => {
    const t = getTemplateForModel('STARCODER2:15B');
    expect(t).toBe(starcoder2FimTemplate);
  });
});

describe('FimTemplate.supportsSnippets', () => {
  it('is true only on qwenMultifileFimTemplate and starcoder2FimTemplate', () => {
    expect(qwenMultifileFimTemplate.supportsSnippets).toBe(true);
    expect(starcoder2FimTemplate.supportsSnippets).toBe(true);
  });

  it('is absent (falsy) on every other template', () => {
    expect(stableCodeFimTemplate.supportsSnippets).toBeUndefined();
    expect(codestralFimTemplate.supportsSnippets).toBeUndefined();
    expect(codeLlamaFimTemplate.supportsSnippets).toBeUndefined();
    expect(deepseekFimTemplate.supportsSnippets).toBeUndefined();
    expect(codegemmaFimTemplate.supportsSnippets).toBeUndefined();
    expect(holeFillerTemplate.supportsSnippets).toBeUndefined();
  });
});

describe('qwenMultifileTemplate — repo-level cross-file assembly', () => {
  it('renders the plain single-file form when there are no snippets', () => {
    const t = getTemplateForModel('qwen2.5-coder:1.5b-base');
    const rendered = t.render('PRE', 'SUF', ctx({ snippets: [] }));
    expect(rendered).toBe('<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>');
  });

  // W5-T4: restored using `scannedSnippetForTest` (the sanctioned test-only mint,
  // `context/scannedSnippetTestFactory.ts`) now that `qwenMultifileFimTemplate` is a
  // default-on hot path (`supportsSnippets: true`). See W5-T0's report for why this
  // was `it.todo`'d in the first place (the `ScannedSnippet` brand is unforgeable
  // outside `ringBuffer.ts`).
  it('prepends <|repo_name|>/<|file_sep|> blocks when snippets are present', () => {
    const t = getTemplateForModel('qwen2.5-coder:1.5b-base');
    const snippets = [
      scannedSnippetForTest({
        uri: 'file:///repo/src/util.ts',
        filepath: 'file:///repo/src/util.ts',
        content: 'export function helper() {}',
        kind: 'recently-opened',
        startLine: 0,
        endLine: 1,
      }),
    ];
    const rendered = t.render('PRE', 'SUF', ctx({ snippets, reponame: 'myrepo' }));
    expect(rendered).toBe(
      '<|repo_name|>myrepo\n<|file_sep|>src/util.ts\nexport function helper() {}\n' +
        '<|file_sep|>src/a.ts\n' +
        '<|fim_prefix|>PRE<|fim_suffix|>SUF<|fim_middle|>',
    );
  });
});

// ── Task 16 (08 §11, ADR-010) ────────────────────────────────────────────────
describe('isKnownFimModel', () => {
  it('is true for every branch of the existing match chain', () => {
    expect(isKnownFimModel('qwen2.5-coder:7b')).toBe(true); // qwen+coder
    expect(isKnownFimModel('starcoder2-3b')).toBe(true); // starcoder2 (A7 specific)
    expect(isKnownFimModel('starcoder-1b')).toBe(true); // bare starcoder -> StableCode branch
    expect(isKnownFimModel('star-coder-1b')).toBe(true); // "star-coder" spelling -> StableCode branch
    expect(isKnownFimModel('stable-code-3b')).toBe(true); // "stable" -> StableCode branch
    expect(isKnownFimModel('codeqwen1.5-7b')).toBe(true); // "codeqwen" -> StableCode branch
    expect(isKnownFimModel('qwen2.5:7b')).toBe(true); // bare "qwen" (non-coder) -> StableCode branch
    expect(isKnownFimModel('codestral-latest')).toBe(true);
    expect(isKnownFimModel('codegemma')).toBe(true);
    expect(isKnownFimModel('codellama')).toBe(true);
    expect(isKnownFimModel('deepseek-coder')).toBe(true);
    expect(isKnownFimModel('gpt-4o-mini')).toBe(true);
    expect(isKnownFimModel('claude-3-5-sonnet')).toBe(true);
    expect(isKnownFimModel('davinci-002')).toBe(true);
  });

  it('is case-insensitive, matching getTemplateForModel', () => {
    expect(isKnownFimModel('QWEN2.5-CODER:3B')).toBe(true);
    expect(isKnownFimModel('STARCODER2:15B')).toBe(true);
  });

  // The cut-model names the Global Constraints forbid in shipped code
  // (`09`:58) are deliberately NOT used as fixtures here. These prove the
  // same thing without planting a forbidden string: a real unrecognized
  // model (`granite-code`), a one-character typo of a recognized model
  // (`qwem2.5-coder`), the empty string, and one obviously-fictional name.
  it('is false for unrecognized model names', () => {
    expect(isKnownFimModel('granite-code')).toBe(false);
    expect(isKnownFimModel('qwem2.5-coder')).toBe(false); // typo: "qwem" not "qwen"
    expect(isKnownFimModel('')).toBe(false);
    expect(isKnownFimModel('zorblex-9000')).toBe(false); // fictional
  });

  it('locks that getTemplateForModel still falls back to stableCodeFimTemplate for every one of those unrecognized names (nativeFim paths depend on this fallback)', () => {
    for (const model of ['granite-code', 'qwem2.5-coder', '', 'zorblex-9000']) {
      expect(getTemplateForModel(model)).toBe(stableCodeFimTemplate);
    }
  });

  it('G-14: qwen+coder always resolves to the multifile template — there is no second Qwen template to edit by mistake', () => {
    expect(getTemplateForModel('qwen2.5-coder:1.5b-base')).toBe(qwenMultifileFimTemplate);
    expect(getTemplateForModel('qwen2.5-coder:7b-base')).toBe(qwenMultifileFimTemplate);
  });
});
