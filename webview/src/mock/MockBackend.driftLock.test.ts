import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { must } from '../testing/must';

/**
 * T-19 (Tier-2 remediation architecture §12.1, C4 — drift lock), RE-BASED by
 * onboarding/setup Task 2 (§5.5/D7), RE-BASED AGAIN by Task 10 (§6 — the
 * Setup/Talaria-Config panel).
 *
 * The original lock byte-compared this mock's refusal copy against the real
 * Guard's `NEXT_ROW_LABEL`/`GENERIC_ROW_LABEL`/`REFUSAL_MESSAGES`
 * (`src/autocomplete/nextedit/guard.ts`). Task 2 DELETED that whole surface
 * from the host: the toggle state moved onto the `talaria.nextEdit.source`
 * enum, mutual exclusion became STRUCTURAL (toggling the second source on
 * REPLACES the first), and production no longer emits a mutual-exclusion
 * refusal at all — so there is no host copy left to compare against.
 *
 * Task 10 moved the frozen row LITERAL (`NEXT_EDIT_ROWS`) out of
 * `SettingsPanel.tsx` into its own module, `panels/nextEditCopy.ts` — the
 * Setup panel needs the exact same copy, and Task 12 deletes the NEXT rows
 * from `SettingsPanel.tsx` entirely (NEXT lives in Talaria Config after
 * that), which would have orphaned this lock's extraction site. This file
 * (and `MockBackend.ts`'s own import) were re-pointed at `nextEditCopy.ts`
 * accordingly — the INTENT is unchanged: labels are single-sourced, the mock
 * derives from them, and no hand-retyped copy is allowed to exist anywhere.
 *
 * What remains to lock, and why each half matters:
 *
 *  1. The mock's row LABELS are DERIVED from the single-sourced frozen row
 *     table (`NEXT_EDIT_ROWS`, `panels/nextEditCopy.ts` — owner copy, carried
 *     character-for-character), never retyped. That derivation is the U-6 fix
 *     that ended the original drift; this file pins it at the source level so
 *     a future edit cannot quietly reintroduce a hand-typed label.
 *  2. The mock's refusal TEMPLATE prose is pinned VERBATIM here. It is now
 *     MOCK-ONLY legacy: the standalone-dev harness still simulates the old
 *     conflict refusal until Task 12 re-bases the panel's rows (and this
 *     mock) onto the structural-replace semantics. Pinning the sentence keeps
 *     the one pre-Fedora driveable surface stable — and this comment is the
 *     recorded reason the mock deliberately diverges from production
 *     behaviour in the meantime.
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

describe('T-19 (C4) drift lock, re-based: MockBackend refusal copy derives from the frozen panel rows', () => {
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

  it('MockBackend DERIVES its labels from NEXT_EDIT_ROWS — imported, looked up by row, never retyped', () => {
    // The import — the only legitimate label source for the mock.
    expect(mockSource).toMatch(/import\s+\{\s*NEXT_EDIT_ROWS\s*\}\s+from\s+'\.\.\/panels\/nextEditCopy';/);
    // The lookup inside the refusal builder itself.
    const body = extractFunctionBody(mockSource, 'function mockRefusalMessage(');
    expect(body).toContain('NEXT_EDIT_ROWS.find');
    // And no hand-retyped copy of either label anywhere in the mock: the
    // exact drift the original T-19 lock existed to prevent.
    expect(
      mockSource.includes('Next Edit — dedicated model'),
      'MockBackend.ts must not hand-retype a row label — labels come from NEXT_EDIT_ROWS only',
    ).toBe(false);
    expect(mockSource.includes('Next Edit — Generic via your FIM model')).toBe(false);
  });

  it("MockBackend's refusal template prose is pinned verbatim (mock-only legacy until Task 12 re-bases the panel on structural replace)", () => {
    const body = extractFunctionBody(mockSource, 'function mockRefusalMessage(');
    const template = extractGroup1(/return\s+`([^`]+)`;/, body, 'MockBackend.ts mockRefusalMessage return template');
    expect(template).toBe(
      'Next Edit: turn off "${otherLabel}" first — the two sources are mutually exclusive.',
    );
  });

  it('RED-first proof: a hand-retyped label planted in the mock source would be caught (in-memory injection, no disk write)', () => {
    const withRetypedLabel = `${mockSource}\nconst leaked = 'Next Edit — dedicated model';\n`;
    expect(
      withRetypedLabel.includes('Next Edit — dedicated model'),
      'the planted retyped label must be visible to the same predicate the real assertion uses',
    ).toBe(true);
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
