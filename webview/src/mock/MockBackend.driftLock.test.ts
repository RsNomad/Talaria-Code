import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { must } from '../testing/must';

/**
 * T-19 (Tier-2 remediation architecture §12.1, C4 — drift lock), RE-BASED by
 * onboarding/setup Task 2 (§5.5/D7), RE-BASED by Task 10 (§6 — the
 * Setup/Talaria-Config panel), RE-BASED AGAIN by Task 12 (§5.5/D7 — the mock
 * moves onto the same structural-replace semantics as the real Guard).
 *
 * The original lock byte-compared this mock's refusal copy against the real
 * Guard's `NEXT_ROW_LABEL`/`GENERIC_ROW_LABEL`/`REFUSAL_MESSAGES`
 * (`src/autocomplete/nextedit/guard.ts`). Task 2 DELETED that whole surface
 * from the host: the toggle state moved onto the `talaria.nextEdit.source`
 * enum, mutual exclusion became STRUCTURAL (toggling the second source on
 * REPLACES the first), and production no longer emits a mutual-exclusion
 * refusal at all.
 *
 * Task 10 moved the frozen row LITERAL (`NEXT_EDIT_ROWS`) out of
 * `SettingsPanel.tsx` into its own module, `panels/nextEditCopy.ts`. Task 12
 * deleted the NEXT rows from `SettingsPanel.tsx` entirely (NEXT lives in
 * Talaria Config now, via `SetupPanel.tsx`) AND finally re-based
 * `MockBackend.ts`'s own toggle handling onto structural-replace — the
 * "mock-only legacy" refusal this file used to pin (see the old revision)
 * is gone from the mock too. What is left to lock, and why each half still
 * matters:
 *
 *  1. The frozen `NEXT_EDIT_ROWS` labels in `nextEditCopy.ts` are still
 *     exactly right — this is the underlying fact every consumer (SetupPanel,
 *     the mock) depends on staying frozen, independent of who currently
 *     reads it. (The richer content lock — the full owner-approved copy,
 *     the vendor-qualifier discipline, the banned-model-name scan — lives in
 *     `panels/nextEditCopy.test.ts`; this file keeps only the two labels,
 *     verified by reading the SOURCE TEXT directly rather than importing the
 *     constant, which is a different verification technique with its own
 *     value: it would catch a case where the exported value still reads
 *     correctly through TypeScript but the on-disk literal was hand-edited
 *     in some way the type system can't see.)
 *  2. `MockBackend.ts` still DERIVES its valid-source set from
 *     `NEXT_EDIT_ROWS` (`isNextEditSource`), never hardcoding the
 *     `'next' | 'generic'` pair as a second, driftable copy of the row
 *     table's keys — the label-derivation discipline the original T-19 lock
 *     existed for, now applied to the one thing the mock still needs from
 *     the row table (which source ids are valid) rather than to refusal
 *     copy it no longer builds.
 *  3. `MockBackend.ts` genuinely implements structural REPLACE, not the old
 *     refusal — proven both by a source-level scan (no `ok: false` path
 *     keyed off a toggle-on conflict) and RED-first against the old
 *     refusal shape.
 *  4. The sanity check that the real host-side refusal surface is really
 *     gone (`guard.ts` has no `REFUSAL_MESSAGES`) — unchanged, still true.
 */

const NEXT_EDIT_COPY_PATH = join(__dirname, '..', 'panels', 'nextEditCopy.ts');
const MOCK_BACKEND_PATH = join(__dirname, 'MockBackend.ts');

/** Bracket-matched function body extraction — robust to the function's
 *  position in the file (unlike a plain regex search for its `return`,
 *  which could hit an unrelated same-shaped `return \`...\`;` elsewhere). */
function extractFunctionBody(source: string, fnMarker: string): string {
  const start = source.indexOf(fnMarker);
  if (start === -1) throw new Error(`drift lock setup: marker not found: ${fnMarker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`drift lock setup: could not close function body for ${fnMarker}`);
  return source.slice(open, end);
}

/** Matches `re` against `text` and returns capture group 1, narrowed via the
 *  project's `must()` (never `!`) — throws loudly (naming `label`) if either
 *  the whole pattern or the capture group didn't match. */
function extractGroup1(re: RegExp, text: string, label: string): string {
  const m = must(text.match(re), `drift lock setup: no match for ${label}`);
  return must(m[1], `drift lock setup: capture group 1 empty for ${label}`);
}

describe('T-19 (C4) drift lock, re-based again by Task 12: MockBackend derives from nextEditCopy, no refusal left', () => {
  const nextEditCopySource = readFileSync(NEXT_EDIT_COPY_PATH, 'utf8');
  const mockSource = readFileSync(MOCK_BACKEND_PATH, 'utf8');

  it('setup: both files exist and are read (non-vacuous — proves the paths above are right)', () => {
    expect(nextEditCopySource.length).toBeGreaterThan(0);
    expect(mockSource.length).toBeGreaterThan(0);
  });

  it('the frozen NEXT_EDIT_ROWS labels are still present in nextEditCopy.ts, verbatim (owner copy, single-sourced since Task 10)', () => {
    const nextLabel = extractGroup1(
      /source:\s*'next',\s*label:\s*'([^']+)'/s,
      nextEditCopySource,
      "nextEditCopy.ts 'next' row label",
    );
    const genericLabel = extractGroup1(
      /source:\s*'generic',\s*label:\s*'([^']+)'/s,
      nextEditCopySource,
      "nextEditCopy.ts 'generic' row label",
    );
    expect(nextLabel).toBe('Next Edit — dedicated model');
    expect(genericLabel).toBe('Next Edit — Generic via your FIM model');
  });

  it('MockBackend DERIVES its valid toggle sources from NEXT_EDIT_ROWS — imported, never a second hardcoded copy', () => {
    // The import — the only legitimate source of truth for which `source`
    // ids the mock accepts.
    expect(mockSource).toMatch(/import\s+\{\s*NEXT_EDIT_ROWS\s*\}\s+from\s+'\.\.\/panels\/nextEditCopy';/);
    // The lookup inside the validity check itself.
    const body = extractFunctionBody(mockSource, 'function isNextEditSource(');
    expect(body).toContain('NEXT_EDIT_ROWS.some');
  });

  it("MockBackend's toggle handling implements structural REPLACE — no refusal (ok:false) path keyed off a source conflict", () => {
    const applyBody = extractFunctionBody(mockSource, 'function applyNextEditToggle(');
    // The old refusal shape checked the OTHER source's current state before
    // accepting a toggle-on and could answer `ok: false`. Replace never
    // reads "the other source is on" as a rejection condition — it always
    // returns a new state.
    expect(
      applyBody,
      'Task 12: applyNextEditToggle must not contain a conflict/refusal branch — replace is unconditional',
    ).not.toMatch(/ok:\s*false/);

    // Direct scan of handleNextEditToggle: the only `ok: false` left in the
    // whole handler is the malformed-request guard, not a conflict refusal.
    const handlerStart = mockSource.indexOf('private handleNextEditToggle(');
    const handlerEnd = mockSource.indexOf('\n  }', handlerStart);
    const handlerSource = mockSource.slice(handlerStart, handlerEnd);
    const okFalseCount = (handlerSource.match(/ok:\s*false/g) ?? []).length;
    expect(
      okFalseCount,
      'Task 12: handleNextEditToggle must have exactly ONE ok:false path (the malformed-request guard) — a second would be a re-introduced refusal',
    ).toBe(1);
    expect(handlerSource).toContain('malformed toggle request');
  });

  it('RED-first proof: a re-introduced conflict refusal in applyNextEditToggle would be caught', () => {
    const withReintroducedRefusal = mockSource.replace(
      'function applyNextEditToggle(',
      'function applyNextEditTogglePlanted(current: unknown, source: unknown, on: unknown) { return { ok: false }; }\nfunction applyNextEditToggle(',
    );
    const plantedBody = extractFunctionBody(withReintroducedRefusal, 'function applyNextEditTogglePlanted(');
    expect(plantedBody).toMatch(/ok:\s*false/);
  });

  it('sanity: the real host-side refusal surface is really gone — guard.ts no longer declares REFUSAL_MESSAGES (the reason this lock was re-based)', () => {
    const guardSource = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'autocomplete', 'nextedit', 'guard.ts'),
      'utf8',
    );
    expect(guardSource.length).toBeGreaterThan(0);
    expect(
      guardSource.includes('REFUSAL_MESSAGES'),
      're-base sanity: if guard.ts grows a REFUSAL_MESSAGES surface again, this lock must go back to comparing against it',
    ).toBe(false);
  });
});
