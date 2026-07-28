import type { FimTemplate } from './types';

// TODO: revisit whether a bare "/src/" string is too aggressive a stop condition
// for real codebases with a src/ directory in-context; ported as-is from Continue's
// `getStopTokens.ts` per the how-to.
const COMMON_STOPS = ['/src/', '#- coding: utf-8', '```'];

// StarCoder2 tends to output artifacts starting with the letter "t".
const STARCODER2_ARTIFACT_GUARDS = ['t.', '\nt', '<file_sep>'];

/**
 * Combines the model template's own FIM/EOT stop tokens with a small set of common
 * stops, per `core/autocomplete/templating/getStopTokens.ts` (grounded in the how-to
 * §2.5). Always send the model's own FIM tokens as `stop` so it halts at the hole
 * boundary instead of continuing to hallucinate past it.
 */
export function getStopTokens(template: FimTemplate, model: string): string[] {
  return [
    ...template.stop,
    ...COMMON_STOPS,
    ...(model.toLowerCase().includes('starcoder2')
      ? STARCODER2_ARTIFACT_GUARDS
      : []),
  ];
}
