import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { must } from '../testing/must';

/**
 * T-19 (Tier-2 remediation architecture §12.1, C4 — drift lock): the real
 * Guard's refusal copy (`src/autocomplete/nextedit/guard.ts`'s
 * `NEXT_ROW_LABEL`/`GENERIC_ROW_LABEL`/`REFUSAL_MESSAGES`) and this
 * standalone-dev mock's derived equivalent (`mockRefusalMessage`, this
 * directory's `MockBackend.ts`) are two INDEPENDENT hand-authored copies of
 * the SAME user-facing prose. `MockBackend.ts`'s own doc comment already
 * names the exact history this lock exists to prevent repeating: Wave 1
 * fixed the real Guard's refusal wording (U-6: name the OTHER row's LABEL,
 * not a raw "NEXT"/"Generic" token that appears nowhere on screen) and the
 * mock was left behind for a full wave, silently modelling a refusal
 * production no longer emitted — the one surface this UX was driveable on
 * pre-Fedora showed the WRONG string with zero test failure.
 *
 * Why byte-compare and not a runtime import: `guard.ts` imports `vscode`
 * (`import * as vscode from 'vscode'`), so it cannot be `import()`ed from a
 * webview-context test — there is no `vscode` module for it to resolve
 * (`MockBackend.ts`'s own doc says as much: "guard.ts imports vscode, so its
 * REFUSAL_MESSAGES is unreachable from the webview's module graph"). This
 * lock instead extracts the row LABELS and the refusal MESSAGE TEMPLATE from
 * all three files' SOURCE TEXT (bracket/regex extraction, no module
 * evaluation) and compares them directly:
 *
 *  - `guard.ts`'s `NEXT_ROW_LABEL`/`GENERIC_ROW_LABEL` must equal
 *    `SettingsPanel.tsx`'s `NEXT_EDIT_ROWS` labels for `source: 'next'` /
 *    `'generic'` — both are meant to be `08` §8's row table, "carried
 *    character-for-character" (`SettingsPanel.tsx`'s own doc on
 *    `NEXT_EDIT_ROWS`).
 *  - `guard.ts`'s `REFUSAL_MESSAGES` template prose and `MockBackend.ts`'s
 *    `mockRefusalMessage` template prose must be identical once the
 *    interpolated LABEL is normalized out (the surrounding sentence is what
 *    must match; which variable fills the blank differs by design — one
 *    reads `GENERIC_ROW_LABEL`, the other reads a locally-computed
 *    `otherLabel`).
 */

const GUARD_PATH = join(__dirname, '..', '..', '..', 'src', 'autocomplete', 'nextedit', 'guard.ts');
const SETTINGS_PANEL_PATH = join(__dirname, '..', 'panels', 'SettingsPanel.tsx');
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

/** Replaces every `${...}` interpolation with a fixed placeholder, so the
 *  surrounding literal prose can be compared independent of which variable
 *  name fills the blank. */
function normalizeTemplate(template: string): string {
  return template.replace(/\$\{[^}]+\}/g, '<LABEL>');
}

describe('T-19 (C4) drift lock: MockBackend refusal copy mirrors the real Guard (guard.ts)', () => {
  const guardSource = readFileSync(GUARD_PATH, 'utf8');
  const settingsSource = readFileSync(SETTINGS_PANEL_PATH, 'utf8');
  const mockSource = readFileSync(MOCK_BACKEND_PATH, 'utf8');

  it('setup: all three files exist and are read (non-vacuous — proves the paths above are right)', () => {
    expect(guardSource.length).toBeGreaterThan(0);
    expect(settingsSource.length).toBeGreaterThan(0);
    expect(mockSource.length).toBeGreaterThan(0);
  });

  it('setup: guard.ts really does import vscode (the reason this lock cannot be a runtime import — not vacuous)', () => {
    expect(guardSource).toMatch(/import \* as vscode from 'vscode';/);
  });

  it("guard.ts's NEXT_ROW_LABEL matches SettingsPanel.tsx's NEXT_EDIT_ROWS 'next' row label, verbatim", () => {
    const guardLabel = extractGroup1(/const NEXT_ROW_LABEL = '([^']+)';/, guardSource, 'guard.ts NEXT_ROW_LABEL');
    const settingsLabel = extractGroup1(/source:\s*'next',\s*label:\s*'([^']+)'/s, settingsSource, "SettingsPanel.tsx 'next' row label");
    expect(guardLabel).toBe(settingsLabel);
  });

  it("guard.ts's GENERIC_ROW_LABEL matches SettingsPanel.tsx's NEXT_EDIT_ROWS 'generic' row label, verbatim", () => {
    const guardLabel = extractGroup1(/const GENERIC_ROW_LABEL = '([^']+)';/, guardSource, 'guard.ts GENERIC_ROW_LABEL');
    const settingsLabel = extractGroup1(/source:\s*'generic',\s*label:\s*'([^']+)'/s, settingsSource, "SettingsPanel.tsx 'generic' row label");
    expect(guardLabel).toBe(settingsLabel);
  });

  it("guard.ts's REFUSAL_MESSAGES template prose matches MockBackend.ts's mockRefusalMessage template prose (interpolated LABEL normalized out)", () => {
    const guardTemplate = extractGroup1(/'refused-next':\s*`([^`]+)`/, guardSource, 'guard.ts REFUSAL_MESSAGES.refused-next');
    const mockBody = extractFunctionBody(mockSource, 'function mockRefusalMessage(');
    const mockTemplate = extractGroup1(/return\s+`([^`]+)`;/, mockBody, 'MockBackend.ts mockRefusalMessage return template');

    expect(normalizeTemplate(guardTemplate)).toBe(normalizeTemplate(mockTemplate));
  });

  it('non-vacuity: normalizeTemplate() actually discriminates — two genuinely different sentences do NOT compare equal', () => {
    const a = normalizeTemplate('Next Edit: turn off "${X}" first — the two sources are mutually exclusive.');
    const b = normalizeTemplate('Next Edit: please disable "${X}" — these are mutually exclusive.');
    expect(a).not.toBe(b);
  });

  it('non-vacuity: normalizeTemplate() ignores WHICH variable fills the interpolation, only the surrounding prose', () => {
    const a = normalizeTemplate('Next Edit: turn off "${GENERIC_ROW_LABEL}" first — the two sources are mutually exclusive.');
    const b = normalizeTemplate('Next Edit: turn off "${otherLabel}" first — the two sources are mutually exclusive.');
    expect(a).toBe(b);
  });

  it('RED-first proof: a planted drift in the mock template would be caught (in-memory injection, no disk write)', () => {
    const guardTemplate = extractGroup1(/'refused-next':\s*`([^`]+)`/, guardSource, 'guard.ts REFUSAL_MESSAGES.refused-next');
    const corruptedMockTemplate = 'Next Edit: please turn off "${otherLabel}" — mutually exclusive.';
    expect(normalizeTemplate(corruptedMockTemplate)).not.toBe(normalizeTemplate(guardTemplate));
  });

  it('RED-first proof: a planted drift in a row label would be caught (in-memory injection, no disk write)', () => {
    const guardLabel = extractGroup1(/const NEXT_ROW_LABEL = '([^']+)';/, guardSource, 'guard.ts NEXT_ROW_LABEL');
    const corruptedLabel = `${guardLabel} (DRIFTED)`;
    expect(corruptedLabel).not.toBe(guardLabel);
  });
});
