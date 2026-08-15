/**
 * AU-40 — structural regression lock for the F-8 doctrine sweep.
 *
 * `McpPanel.tsx`/`SkillsPanel.tsx`/`SessionsPanel.tsx`/`CheckpointsPanel.tsx`
 * used to render ~11 in-flight action buttons with a raw `disabled={busyFlag}`
 * — the F-8 bug `Toggle.tsx` already documented for the switch, reproduced on
 * plain `<button>`s. The fix routes every one of those sites through
 * `busyInteraction` (`busyInteraction.ts`) and renders its `.nativeDisabled`
 * field, never a raw flag.
 *
 * `.tsx`/DOM assertions can't prove a NEGATIVE across every call site at once
 * ("nothing in this file EVER passes a busy flag straight to `disabled`") —
 * a DOM test only proves whatever ONE fixture it happens to render. This is a
 * text-level characterization test on the source instead, in the same spirit
 * as this repo's other `readFileSync` lock tests (`theme.tokens.test.ts`,
 * `index.css.test.ts`, `src/shared/secretPaths.freeze.test.ts`).
 *
 * Scope: the four swept panels only. `Toggle.tsx` (the F-8 original) and
 * `SettingsPanel.tsx`'s documented `<select>` carve-out (V11,
 * `busyInteraction.ts`'s own module doc) are deliberately NOT swept by this
 * lock — AU-40 is scoped to plain `<button>`s in these four files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SWEPT_FILES = [
  'McpPanel.tsx',
  'SkillsPanel.tsx',
  'SessionsPanel.tsx',
  'CheckpointsPanel.tsx',
] as const;

/** The MINIMUM number of `disabled={` sites AU-40 actually swept in each
 *  file — a floor, not a ceiling, so a future button ADDED the right way
 *  (through `busyInteraction`) never breaks this lock; only a future button
 *  that AVOIDS `disabled={` entirely (undetectable by this regex either way)
 *  or a regression that deletes a swept site would silently drop the count.
 *  Guards against the regex itself silently matching nothing (this repo's
 *  own documented M-6 failure mode, `vitest.config.ts`'s header doc). */
const MIN_SWEPT_SITES: Record<(typeof SWEPT_FILES)[number], number> = {
  'McpPanel.tsx': 6,
  'SkillsPanel.tsx': 4,
  'SessionsPanel.tsx': 1,
  'CheckpointsPanel.tsx': 6,
};

/**
 * Every plain `disabled={...}` attribute (never `aria-disabled={...}` — the
 * negative lookbehind excludes it) across the whole file, as the raw
 * (untrimmed) expression text inside the braces.
 */
function extractDisabledExpressions(source: string): string[] {
  const matches = source.matchAll(/(?<!aria-)\bdisabled=\{([^}]*)\}/g);
  return [...matches].map((m) => m[1] ?? '');
}

describe('AU-40: no swept panel passes an in-flight/busy flag straight to native `disabled`', () => {
  for (const file of SWEPT_FILES) {
    describe(file, () => {
      const source = readFileSync(join(__dirname, file), 'utf-8');
      const expressions = extractDisabledExpressions(source);

      it(`has at least ${MIN_SWEPT_SITES[file]} swept disabled={} site(s) — the regex is not silently matching nothing`, () => {
        expect(expressions.length).toBeGreaterThanOrEqual(MIN_SWEPT_SITES[file]);
      });

      it('every disabled={} expression reads a busyInteraction result\'s .nativeDisabled field, never a raw flag', () => {
        for (const expr of expressions) {
          expect(
            expr.trim(),
            `${file}: found \`disabled={${expr.trim()}}\` — every in-flight button must route through ` +
              'busyInteraction() and render `.nativeDisabled`, never a raw busy/pending flag (that is the exact ' +
              'F-8 regression AU-40 exists to close: a busy control going natively disabled drops keyboard focus).',
          ).toMatch(/\.nativeDisabled$/);
        }
      });
    });
  }
});
