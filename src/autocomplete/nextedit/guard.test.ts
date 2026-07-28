import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscodeTypes from 'vscode';
import type { ToggleState } from './mode';

/**
 * Task 12 Step 2 — the Guard.
 *
 * The Guard is the single writer AND the single reader of the toggle store.
 * These tests drive it against an in-memory `Memento` fake (a `Map`-backed
 * `{ get, update, keys }`) and a fake `vscode.window.showWarningMessage`, so
 * every persistence decision is observable: what was written, what was NOT
 * written, and in which order two racing callers were served.
 *
 * Test hygiene (Global Constraints): the spies below are plain functions
 * pushing into arrays, not `vi.fn()` — `vi.fn()` swallows unhandled
 * rejections, which would make the rejection assertions here vacuous.
 */
const warnings: string[] = [];
const infos: string[] = [];

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: (msg: string) => {
      warnings.push(msg);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (msg: string) => {
      infos.push(msg);
      return Promise.resolve(undefined);
    },
  },
}));

import { NextEditGuard, NEXT_EDIT_TOGGLES_KEY, refusalAlertKey } from './guard';

/** In-memory `vscode.Memento`. `update` resolves on a later microtask so a
 *  genuinely concurrent second `requestToggle` has a window to interleave —
 *  a synchronous fake would make the serialization test vacuous. */
function makeMemento(seed?: unknown): {
  memento: vscodeTypes.Memento;
  updates: { key: string; value: unknown }[];
} {
  const store = new Map<string, unknown>();
  if (seed !== undefined) store.set(NEXT_EDIT_TOGGLES_KEY, seed);
  const updates: { key: string; value: unknown }[] = [];
  const memento: vscodeTypes.Memento = {
    keys: () => [...store.keys()],
    get: (<T>(key: string, dflt?: T): T | undefined =>
      (store.has(key) ? (store.get(key) as T) : dflt)) as vscodeTypes.Memento['get'],
    update: async (key: string, value: unknown): Promise<void> => {
      await Promise.resolve();
      updates.push({ key, value });
      store.set(key, value);
    },
  };
  return { memento, updates };
}

function makeDeps(): { reportFailure(msg: string): void; failures: string[] } {
  const failures: string[] = [];
  return { failures, reportFailure: (msg: string) => void failures.push(msg) };
}

describe('NextEditGuard.hydrate', () => {
  beforeEach(() => {
    warnings.length = 0;
    infos.length = 0;
  });

  it('an EMPTY store hydrates to the hardcoded both-off default and persists NOTHING', async () => {
    const { memento, updates } = makeMemento();
    const deps = makeDeps();

    const guard = await NextEditGuard.hydrate(memento, deps);

    expect(guard.getState()).toEqual({ next: false, generic: false });
    expect(guard.getMode()).toBe('off');
    expect(updates).toEqual([]);       // first run must not write
    expect(deps.failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a hand-edited BOTH-ON store resets to both-off, PERSISTS the reset, and reports once', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: true });
    const deps = makeDeps();

    const guard = await NextEditGuard.hydrate(memento, deps);

    expect(guard.getState()).toEqual({ next: false, generic: false });
    expect(guard.getMode()).toBe('off');
    // «расширение его пошлет к херам и скинет в OFF» — and the reset is
    // WRITTEN BACK, so the next cold start does not re-discover the conflict.
    expect(updates).toEqual([{ key: NEXT_EDIT_TOGGLES_KEY, value: { next: false, generic: false } }]);
    expect(deps.failures).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('a single ratified toggle survives hydration untouched and nothing is persisted', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: false });
    const deps = makeDeps();

    const guard = await NextEditGuard.hydrate(memento, deps);

    expect(guard.getState()).toEqual({ next: true, generic: false });
    expect(guard.getMode()).toBe('next');
    expect(updates).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a MALFORMED stored value degrades to the both-off default rather than throwing', async () => {
    const { memento } = makeMemento({ next: 'yes', generic: null });
    const deps = makeDeps();

    const guard = await NextEditGuard.hydrate(memento, deps);

    expect(guard.getState()).toEqual({ next: false, generic: false });
  });
});

describe('NextEditGuard.requestToggle', () => {
  beforeEach(() => {
    warnings.length = 0;
    infos.length = 0;
  });

  it('an ACCEPTED toggle is persisted and fires onDidChange', async () => {
    const { memento, updates } = makeMemento();
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    const result = await guard.requestToggle({ source: 'next', on: true });

    expect(result).toEqual({ next: true, generic: false });
    expect(guard.getState()).toEqual({ next: true, generic: false });
    expect(guard.getMode()).toBe('next');
    expect(updates).toEqual([{ key: NEXT_EDIT_TOGGLES_KEY, value: { next: true, generic: false } }]);
    expect(seen).toEqual([{ next: true, generic: false }]);
    expect(warnings).toEqual([]);
  });

  it('turning on the SECOND source while the first is ratified REJECTS, persists NOTHING, and alerts once', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    await expect(guard.requestToggle({ source: 'generic', on: true })).rejects.toThrow(
      'Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.',
    );

    expect(updates).toEqual([]);                                   // nothing persisted
    expect(guard.getState()).toEqual({ next: true, generic: false }); // ratified state untouched
    expect(seen).toEqual([]);                                      // no state push on a refusal
    expect(warnings).toEqual([
      'Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.',
    ]);
  });

  it('the mirrored refusal names the OTHER toggle (generic ratified on, next requested)', async () => {
    const { memento } = makeMemento({ next: false, generic: true });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());

    await expect(guard.requestToggle({ source: 'next', on: true })).rejects.toThrow(
      'Next Edit: turn off "Next Edit — Generic via your FIM model" first — the two sources are mutually exclusive.',
    );
    expect(warnings).toEqual([
      'Next Edit: turn off "Next Edit — Generic via your FIM model" first — the two sources are mutually exclusive.',
    ]);
  });

  /**
   * U-6 — the refusal must name what is ON SCREEN. `08` §8 specifies the
   * OTHER ROW'S LABEL be interpolated; the shipped copy said "turn off NEXT
   * first" / "turn off Generic first", and neither bare token appears
   * anywhere in the panel, so the user had to guess which of the two rows
   * was meant. These two labels are the panel's, verbatim
   * (`webview/src/panels/SettingsPanel.tsx:84,90`, pinned by that panel's own
   * suite) — this test is the host-side half of that pin.
   */
  it('U-6: each refusal names the OTHER ROW LABEL, never a bare token that appears nowhere on screen', async () => {
    const nextOn = await NextEditGuard.hydrate(makeMemento({ next: true, generic: false }).memento, makeDeps());
    await expect(nextOn.requestToggle({ source: 'generic', on: true })).rejects.toThrow(
      'Next Edit — dedicated model',
    );

    warnings.length = 0;
    const genericOn = await NextEditGuard.hydrate(makeMemento({ next: false, generic: true }).memento, makeDeps());
    await expect(genericOn.requestToggle({ source: 'next', on: true })).rejects.toThrow(
      'Next Edit — Generic via your FIM model',
    );

    // The bare tokens are gone from both directions.
    for (const warning of warnings) {
      expect(warning).not.toContain('turn off NEXT first');
      expect(warning).not.toContain('turn off Generic first');
    }
  });

  it('a SECOND identical refused attempt re-alerts — a deliberate retry is a new gesture, never deduped', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());

    await expect(guard.requestToggle({ source: 'generic', on: true })).rejects.toThrow();
    await expect(guard.requestToggle({ source: 'generic', on: true })).rejects.toThrow();

    expect(warnings).toHaveLength(2);
    expect(updates).toEqual([]);
  });

  it('turning a source OFF is always accepted, even from a ratified-on state', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());

    const result = await guard.requestToggle({ source: 'next', on: false });

    expect(result).toEqual({ next: false, generic: false });
    expect(guard.getMode()).toBe('off');
    expect(updates).toEqual([{ key: NEXT_EDIT_TOGGLES_KEY, value: { next: false, generic: false } }]);
  });

  it('two RACING requestToggles are serialized — the second sees the first\'s ratified state', async () => {
    const { memento, updates } = makeMemento();
    const guard = await NextEditGuard.hydrate(memento, makeDeps());

    // Issued together, neither awaited first. Without the promise queue both
    // would decide against the same both-off snapshot and BOTH would be
    // accepted — persisting the conflict state the Guard exists to prevent.
    const first = guard.requestToggle({ source: 'next', on: true });
    const second = guard.requestToggle({ source: 'generic', on: true });

    await expect(first).resolves.toEqual({ next: true, generic: false });
    await expect(second).rejects.toThrow('mutually exclusive');

    expect(guard.getState()).toEqual({ next: true, generic: false });
    expect(updates).toEqual([{ key: NEXT_EDIT_TOGGLES_KEY, value: { next: true, generic: false } }]);
  });

  it('a refusal does not poison the queue — a later legitimate toggle still succeeds', async () => {
    const { memento } = makeMemento({ next: true, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());

    await expect(guard.requestToggle({ source: 'generic', on: true })).rejects.toThrow();
    await expect(guard.requestToggle({ source: 'next', on: false })).resolves.toEqual({
      next: false,
      generic: false,
    });
    await expect(guard.requestToggle({ source: 'generic', on: true })).resolves.toEqual({
      next: false,
      generic: true,
    });
    expect(guard.getMode()).toBe('generic');
  });

  it('getMode is exactly resolveNextEditMode over the ratified state', async () => {
    const { memento } = makeMemento();
    const guard = await NextEditGuard.hydrate(memento, makeDeps());

    expect(guard.getMode()).toBe('off');
    await guard.requestToggle({ source: 'generic', on: true });
    expect(guard.getMode()).toBe('generic');
    await guard.requestToggle({ source: 'generic', on: false });
    await guard.requestToggle({ source: 'next', on: true });
    expect(guard.getMode()).toBe('next');
  });

  it('a disposed onDidChange listener stops receiving state pushes', async () => {
    const { memento } = makeMemento();
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    const seen: ToggleState[] = [];
    const sub = guard.onDidChange((s) => void seen.push(s));

    await guard.requestToggle({ source: 'next', on: true });
    sub.dispose();
    await guard.requestToggle({ source: 'next', on: false });

    expect(seen).toEqual([{ next: true, generic: false }]);
  });
});

describe('W5.2 read-through: the STORE is the authority, not the cached field', () => {
  beforeEach(() => {
    warnings.length = 0;
    infos.length = 0;
  });

  it('getMode() reflects a value written BEHIND the Guard\'s back', async () => {
    const { memento } = makeMemento({ next: false, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    expect(guard.getMode()).toBe('off');

    // Another window's write, arriving through ExtensionMemento's own refresh.
    await memento.update(NEXT_EDIT_TOGGLES_KEY, { next: true, generic: false });

    expect(
      guard.getMode(),
      'read-through failed: getMode() still answered from the cached field after the store moved',
    ).toBe('next');
  });

  it('getState() sanitizes a both-on store SILENTLY — persists nothing, warns nothing', async () => {
    const { memento, updates } = makeMemento({ next: false, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    await memento.update(NEXT_EDIT_TOGGLES_KEY, { next: true, generic: true });
    const updatesBefore = updates.length;
    warnings.length = 0;

    expect(guard.getState()).toEqual({ next: false, generic: false });
    expect(guard.getMode()).toBe('off');
    expect(
      updates.length,
      'the READ path must never write — sanitize-and-persist belongs to hydrate() alone',
    ).toBe(updatesBefore);
    expect(
      warnings,
      'the READ path must never alert — the one notice belongs to hydrate() alone',
    ).toEqual([]);
  });

  /**
   * NON-VACUITY COMPANION to the silent-sanitize test above. That test moves
   * the store to BOTH-ON, whose sanitized value (both-off) is identical to the
   * stale cached field — so its `toEqual({ next: false, generic: false })` is
   * satisfied by a cached read too, and it locks only the SILENCE (no write,
   * no alert), never the freshness. This test moves the store to a state the
   * stale field cannot coincide with, so `getState()`'s read-through is the
   * only thing that can satisfy it.
   */
  it('getState() reflects a SINGLE-ON value written behind the Guard\'s back', async () => {
    const { memento } = makeMemento({ next: false, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    expect(guard.getState()).toEqual({ next: false, generic: false });

    await memento.update(NEXT_EDIT_TOGGLES_KEY, { next: true, generic: false });

    expect(
      guard.getState(),
      'read-through failed: getState() still answered from the cached field after the store moved',
    ).toEqual({ next: true, generic: false });
  });

  /**
   * NON-VACUITY COMPANION to the silent-sanitize test's WRITE assertion.
   * `makeMemento`'s `update` pushes into `updates` only after
   * `await Promise.resolve()`, so a read path that fired a fire-and-forget
   * `void this.state.update(...)` — the realistic shape of "the read path
   * became a second writer", since making `readCurrent` async is a
   * non-starter — lands its push AFTER a synchronous `updates.length` check.
   * Proven: that mutation survived the test above and is caught only here.
   * Draining the microtask queue is what makes the R5 single-writer assertion
   * able to fail at all.
   */
  it('the READ path writes NOTHING even after the microtask queue drains (fire-and-forget second writer)', async () => {
    const { memento, updates } = makeMemento({ next: false, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    await memento.update(NEXT_EDIT_TOGGLES_KEY, { next: true, generic: true });
    const updatesBefore = updates.length;

    guard.getState();
    guard.getMode();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      updates.length,
      'the READ path persisted its sanitize — it has become a SECOND WRITER and R5 single-writer is gone',
    ).toBe(updatesBefore);
  });

  it('getState() returns a COPY: mutating it cannot change the mode', async () => {
    const { memento } = makeMemento({ next: true, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    const s = guard.getState();
    s.next = false;
    expect(guard.getMode()).toBe('next');
  });

  /**
   * Fix wave, Finding 1 (reviewer's probe). The test above proves a mutation
   * cannot change THIS Guard's own mode — but that alone does not rule out a
   * worse failure: on an EMPTY store, `readCurrent()` bottoms out at the
   * module-level `DEFAULT_TOGGLES` singleton (`coerceStoredToggles` returns it
   * BY REFERENCE, and `sanitizeStoredToggles` passes a non-conflicting value
   * through by reference too — see `guard.ts`'s own comments on both). If
   * `getState()` ever stopped copying, mutating its result would reach that
   * shared singleton directly, corrupting the hardcoded default for every
   * OTHER Guard that will ever hydrate from an empty store afterward — not
   * just this one. That is a process-wide, cross-instance failure, which is
   * why this is a SEPARATE probe from the one above rather than a duplicate.
   *
   * Must PASS at HEAD (the explicit copy in `getState()` returns a fresh
   * object every time, never the singleton) and go RED under mutation M7
   * (`getState()` returns `readCurrent()`'s result directly, without the
   * copy): on an empty store that mutation attempt lands on the now-frozen
   * `DEFAULT_TOGGLES` and throws under strict mode, so the test fails loudly
   * rather than silently proving nothing.
   */
  it("getState()'s result cannot corrupt a LATER Guard hydrated from an unrelated empty store", async () => {
    const { memento: firstStore } = makeMemento();
    const guard1 = await NextEditGuard.hydrate(firstStore, makeDeps());
    const s = guard1.getState();
    expect(s).toEqual({ next: false, generic: false });

    // The escape attempt itself. Deliberately not wrapped in try/catch: under
    // the intended (copy-preserving) design this is a plain, harmless write to
    // an ordinary object. Only a regression that hands back the frozen
    // module singleton makes this line itself throw — and an uncaught throw
    // here is exactly the loud failure a corrupted shared default deserves.
    s.next = true;

    const { memento: secondStore } = makeMemento();
    const guard2 = await NextEditGuard.hydrate(secondStore, makeDeps());
    expect(
      guard2.getState(),
      "a fresh Guard on an unrelated empty store observed a mutation performed through another Guard's " +
        'getState() result — DEFAULT_TOGGLES is a shared mutable singleton',
    ).toEqual({ next: false, generic: false });
  });

  it('hydrate() on a both-on store STILL persists the reset and alerts exactly once', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: true });
    const deps = makeDeps();
    const guard = await NextEditGuard.hydrate(memento, deps);

    expect(updates).toEqual([
      { key: NEXT_EDIT_TOGGLES_KEY, value: { next: false, generic: false } },
    ]);
    expect(warnings.length, 'hydrate must alert exactly once').toBe(1);
    expect(deps.failures.length).toBe(1);
    expect(guard.getMode()).toBe('off');
  });

  it('a refusal still writes NOTHING when the store moved underneath since hydrate', async () => {
    const { memento, updates } = makeMemento({ next: false, generic: false });
    const guard = await NextEditGuard.hydrate(memento, makeDeps());
    // Another window ratified NEXT. The cached field still says both-off.
    await memento.update(NEXT_EDIT_TOGGLES_KEY, { next: true, generic: false });
    const updatesBefore = updates.length;

    await expect(guard.requestToggle({ source: 'generic', on: true })).rejects.toThrow(
      /mutually exclusive/,
    );
    expect(
      updates.length,
      'refusal persisted something, or the decision was made against the stale field',
    ).toBe(updatesBefore);
    expect(guard.getMode()).toBe('next');
  });
});

describe('LOCK: the store key literal lives in guard.ts alone', () => {
  it('no other non-test file under src/ contains the toggles store key (Task 14 owns the exhaustive lock)', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const offenders = collectNonTestTsSources(path.join(__dirname, '..', '..'))
      .filter((f) => f.content.includes('hermes.nextEdit.toggles'))
      .map((f) => f.file);

    expect(offenders).toEqual(['autocomplete/nextedit/guard.ts']);
  });
});

/**
 * F-9 (final-review-findings.md SEC I-1) — `setKeysForSync` is the only
 * Global Constraint that shipped with NO source lock. This module's own
 * header (lines 12-14 above) documents it in prose — "these toggles are
 * hardware-bound ... and must not roam between machines via Settings Sync"
 * — but until this lock, that was enforced by nobody writing the call, not
 * by any mechanism.
 *
 * The security lens proved the gap is real, not theoretical: it added
 * `context.globalState.setKeysForSync([NEXT_EDIT_TOGGLES_KEY])` (the
 * IMPORTED CONSTANT, not the literal string) at the composition root
 * (`index.ts`, right beside the `NextEditGuard.hydrate(...)` call above) and
 * got `check-types` clean plus a fully green suite. The LOCK block directly
 * above only greps the store-KEY literal (`'hermes.nextEdit.toggles'`); a
 * call built from the imported `NEXT_EDIT_TOGGLES_KEY` constant never spells
 * that literal anywhere and evades it completely. This is a SEPARATE lock on
 * a separate token — the CALL itself — because the two evade each other.
 *
 * Scoped to all of `src/` (same root as the lock above, not just
 * `nextedit/`): `context.globalState` is reachable from any composition
 * root that holds `context`, and an egress-enabling toggle roaming to a
 * machine the user never consented to enable it on is the failure this
 * closes, regardless of which file the call would land in.
 */
describe('LOCK: setKeysForSync is never called anywhere under src/ (Global Constraint — no Settings Sync roaming)', () => {
  /**
   * Audit B-4, PROVEN: `context.globalState.setKeysForSync?.([])` passed the
   * old `/\bsetKeysForSync\s*\(/` predicate AND `check-types`, while the
   * plain-dot control went RED. Optional-call syntax puts `?.` between the
   * name and the paren. The bracket-access form is the neighbouring evasion
   * and is covered by the second alternative.
   */
  const SET_KEYS_FOR_SYNC_CALL =
    /\bsetKeysForSync\s*(?:\?\.\s*)?\(|\[\s*['"]setKeysForSync['"]\s*\]/;

  it('the call setKeysForSync( appears NOWHERE under src/ — catches the imported-constant form the store-key lock above evades', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const offenders = collectNonTestTsSources(path.join(__dirname, '..', '..'))
      .filter((f) => SET_KEYS_FOR_SYNC_CALL.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('sanity: this module\'s own header comment mentions setKeysForSync in prose without a call, and is correctly NOT flagged (negative control on the mechanism itself)', () => {
    // guard.ts's own header (line 12) reads "`setKeysForSync` is deliberately
    // NOT called" — no open paren follows the name, so the CALL pattern must
    // not match it. If this ever regressed (someone reworded the comment to
    // spell the call shape with parens), this assertion would catch a
    // self-tripping lock before it ever reached the offenders check above.
    const proseOnly = '`setKeysForSync` is deliberately NOT called: these toggles are hardware-bound';
    expect(SET_KEYS_FOR_SYNC_CALL.test(proseOnly)).toBe(false);
  });

  /**
   * RED-first non-vacuous proof, IN-MEMORY (no disk write into `src/`
   * itself — the same H6-B9 discipline `contextPurity.test.ts`/
   * `reuseLocks.test.ts` already document at length): appending a synthetic
   * entry to the REAL, already-collected file list proves the predicate
   * fires without racing any concurrently-writing probe test in a sibling
   * directory. This is the EXACT evasion shape the security lens proved:
   * the call built from the imported constant, not the literal string.
   */
  it('RED-first proof: a synthetic in-memory offender calling setKeysForSync( with the IMPORTED CONSTANT (the exact evasion form the security lens proved) is flagged by the same predicate the real assertion uses (zero disk I/O)', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const withInjectedViolation = [
      ...collectNonTestTsSources(path.join(__dirname, '..', '..')),
      {
        file: 'autocomplete/__setKeysForSync_probe__.ts',
        absPath: '',
        content:
          "import { NEXT_EDIT_TOGGLES_KEY } from './nextedit/guard';\n" +
          'context.globalState.setKeysForSync([NEXT_EDIT_TOGGLES_KEY]);\n',
      },
    ];
    const offenders = withInjectedViolation
      .filter((f) => SET_KEYS_FOR_SYNC_CALL.test(f.content))
      .map((f) => f.file);

    expect(offenders).toContain('autocomplete/__setKeysForSync_probe__.ts');
  });

  it('negative control: a synthetic entry that only MENTIONS setKeysForSync in prose (no call) is not flagged', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const withCommentOnly = [
      ...collectNonTestTsSources(path.join(__dirname, '..', '..')),
      {
        file: 'autocomplete/__setKeysForSync_probe__.ts',
        absPath: '',
        content: '// setKeysForSync is deliberately never called from this file\nconst x = 1;\n',
      },
    ];
    const offenders = withCommentOnly
      .filter((f) => SET_KEYS_FOR_SYNC_CALL.test(f.content))
      .map((f) => f.file);

    expect(offenders).not.toContain('autocomplete/__setKeysForSync_probe__.ts');
  });

  it('RED-first proof: the OPTIONAL-CALL form setKeysForSync?.( is flagged (audit B-4 — this exact form was green AND type-clean)', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');
    const withInjectedViolation = [
      ...collectNonTestTsSources(path.join(__dirname, '..', '..')),
      {
        file: 'autocomplete/__optional_call_probe__.ts',
        absPath: '',
        content: 'context.globalState.setKeysForSync?.([NEXT_EDIT_TOGGLES_KEY]);\n',
      },
    ];
    const offenders = withInjectedViolation
      .filter((f) => SET_KEYS_FOR_SYNC_CALL.test(f.content))
      .map((f) => f.file);
    expect(offenders).toContain('autocomplete/__optional_call_probe__.ts');
  });

  it('RED-first proof: the BRACKET-ACCESS form is flagged too', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');
    const withInjectedViolation = [
      ...collectNonTestTsSources(path.join(__dirname, '..', '..')),
      {
        file: 'autocomplete/__bracket_probe__.ts',
        absPath: '',
        content: "context.globalState['setKeysForSync']([NEXT_EDIT_TOGGLES_KEY]);\n",
      },
    ];
    const offenders = withInjectedViolation
      .filter((f) => SET_KEYS_FOR_SYNC_CALL.test(f.content))
      .map((f) => f.file);
    expect(offenders).toContain('autocomplete/__bracket_probe__.ts');
  });
});

/**
 * T-6 sweep pair: `applyOne`'s refusal-message lookup used to be
 * `decision.alert === null ? REFUSAL_MESSAGES['refused-next'] : REFUSAL_MESSAGES[decision.alert]`
 * — a defensive fallback for a `null` `decision.alert` that `applyToggleRequest`
 * (`mode.ts:48`) never actually produces when `result === 'refused'` (its
 * `alert` is ALWAYS `'refused-next'` or `'refused-generic'` in that branch;
 * TypeScript's structural type just can't see that guarantee, hence the
 * defensive check existing at all). Had that branch ever been reached
 * anyway — a future `mode.ts` change, a hand-built `ToggleDecision` — the
 * OLD fallback named "refused-next" UNCONDITIONALLY, which tells the user
 * to turn off the WRONG row (always "Generic") whenever the offending
 * request (`req.source`) was actually 'generic'. `refusalAlertKey` derives
 * the fallback from `req.source` instead, mirroring the exact conditional
 * `applyToggleRequest` itself uses (`mode.ts:48`), so even the
 * defensively-unreachable branch names the RIGHT row.
 *
 * Exercised directly (not through `NextEditGuard`, which can never
 * construct the `alert: null` input through the real `applyToggleRequest`)
 * — a pure function, `Pick`-typed so a minimal synthetic `ToggleDecision`
 * suffices.
 */
describe('refusalAlertKey (T-6 sweep: guard.ts:214 fallback names the RIGHT toggle row)', () => {
  it('passes decision.alert straight through when it is already set (the normal, reachable case)', () => {
    expect(refusalAlertKey({ alert: 'refused-next' }, { source: 'generic' })).toBe('refused-next');
    expect(refusalAlertKey({ alert: 'refused-generic' }, { source: 'next' })).toBe('refused-generic');
  });

  it('a defensively-unreachable null alert falls back to "refused-next" when the offending request was for "next" (matches mode.ts:48\'s own conditional)', () => {
    expect(refusalAlertKey({ alert: null }, { source: 'next' })).toBe('refused-next');
  });

  it('a defensively-unreachable null alert falls back to "refused-generic" when the offending request was for "generic" — the case the OLD hardcoded fallback got WRONG', () => {
    expect(refusalAlertKey({ alert: null }, { source: 'generic' })).toBe('refused-generic');
  });
});
