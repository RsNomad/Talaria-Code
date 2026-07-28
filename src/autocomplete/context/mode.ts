/**
 * Cross-file assembly-mode predicate + the comment-injection assembler (§4.2/§4.5
 * of `docs/research/wave-5/00-architecture-and-paths.md`). Pure, host-agnostic —
 * no `vscode`. Consumed by `engine.ts` (comment-inject application) and by T5's
 * `provider.ts`/`config.ts` (mode resolution feeding `AutocompleteOptions.crossFileMode`).
 */
import { getSingleLineComment } from '../languageInfo';
import type { BackendCapabilities, CrossFileSnippet, FimTemplate } from '../types';
import type { CrossFileMode } from './types';

/**
 * The single assembly-mode predicate (kills R6 — mode `none` means gathering never
 * runs — and wires the previously-dead `assemblesCrossFileServerSide` flag).
 *
 * Precedence (first match wins):
 *   1. `!cfg.crossFileEnabled`                                    -> 'none'
 *   2. `capabilities.assemblesCrossFileServerSide`                -> 'input-extra'
 *   3. `!capabilities.nativeFim && template.supportsSnippets`     -> 'template'
 *   4. `cfg.prefixInjection`                                      -> 'comment-inject'
 *   5. otherwise                                                  -> 'none'
 *
 * `template` is the caller's already-resolved `getTemplateForModel(model)` result —
 * kept out of this function so it stays pure and trivially testable with a fixture
 * template rather than a real model-name substring match.
 */
export function crossFileMode(
  capabilities: BackendCapabilities,
  template: FimTemplate,
  cfg: { crossFileEnabled: boolean; prefixInjection: boolean },
): CrossFileMode {
  if (!cfg.crossFileEnabled) {
    return 'none';
  }
  if (capabilities.assemblesCrossFileServerSide) {
    return 'input-extra';
  }
  if (!capabilities.nativeFim && template.supportsSnippets === true) {
    return 'template';
  }
  if (cfg.prefixInjection) {
    return 'comment-inject';
  }
  return 'none';
}

const DEFAULT_INJECT_BUDGET_CHARS = 512;

/** `// Path: <filepath>` + comment-prefixed body lines for one snippet. */
function formatSnippetAsComment(snippet: CrossFileSnippet, commentToken: string): string {
  const header = `${commentToken} Path: ${snippet.filepath}`;
  const bodyLines = snippet.content.split('\n').map((line) => `${commentToken} ${line}`);
  return [header, ...bodyLines].join('\n');
}

/**
 * Tabby `build_prefix`-shaped comment injection for the `comment-inject` assembly
 * mode (Ollama/Codestral/openai-compat — all `nativeFim:true`, so they never render
 * a template; this is their only cross-file channel). Formats each snippet as a
 * `// Path: <filepath>` header followed by its body, each line comment-prefixed by
 * `languageId`'s single-line comment token (`#` fallback for unknown languages), and
 * PREPENDS the concatenated block to `prunedPrefix`.
 *
 * The block is capped at `budgetChars` (default 512, §2.6). A snippet that would
 * push the block over budget is skipped WHOLE, never cropped — cropping mid-snippet
 * risks bisecting a line and stranding a fragment past the ring buffer's line-aligned
 * secret-scanner discipline (§2.2). Snippets are already mode-budgeted by the
 * host-side budgeter; this cap is a formatter-local safety net, not the primary
 * budget enforcement.
 *
 * `snippets` is deliberately the UNBRANDED `CrossFileSnippet[]` (not `ScannedSnippet[]`)
 * — this formatter only reads structural fields, and `ScannedSnippet` (a superset via
 * an additive brand) is assignable here, so callers pass either without a cast and
 * unit tests can build plain fixtures with no factory. The scan gate lives at the
 * `FimContext.snippets` boundary, not on this formatter.
 */
export function injectSnippetsAsComments(
  prunedPrefix: string,
  snippets: readonly CrossFileSnippet[],
  languageId: string,
  budgetChars: number = DEFAULT_INJECT_BUDGET_CHARS,
): string {
  const commentToken = getSingleLineComment(languageId) ?? '#';

  const blocks: string[] = [];
  let usedChars = 0;
  for (const snippet of snippets) {
    const block = formatSnippetAsComment(snippet, commentToken);
    const addedChars = block.length + 1; // +1 for the trailing newline separator
    if (usedChars + addedChars > budgetChars) {
      break; // skip-not-crop: stop at the snippet boundary, never truncate mid-snippet
    }
    blocks.push(block);
    usedChars += addedChars;
  }

  if (blocks.length === 0) {
    return prunedPrefix;
  }
  return blocks.join('\n') + '\n' + prunedPrefix;
}

// ── RESERVED SEAM (W5.1 next-edit, NOT built) ──────────────────────────────
// export function nextEditMode(capabilities: BackendCapabilities, model: string,
//   cfg: { nextEditEnabled: boolean }): 'off' | 'model'
// next-edit is MODEL-gated (a model allowlist, like Continue's MODEL_SUPPORTS_NEXT_EDIT),
// not a backend-class flag — so NO capabilities.nextEdit boolean exists. The W5.1
// wave implements this predicate + a NextEditManager that consumes EditTracker's
// getRecentEdits(); any next-edit payload MUST re-run scanSnippetForSecrets (the
// choke-point guarantee is not inherited by a non-ring egress path).
