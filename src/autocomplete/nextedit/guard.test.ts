import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscodeTypes from 'vscode';
import type { ToggleState } from './mode';

/**
 * Task 2 (onboarding/setup wave, §5.5/D7) — the Guard over the SETTING.
 *
 * The NEXT/Generic on-off state no longer lives in `globalState`: the single
 * source of truth is the `talaria.nextEdit.source` enum setting
 * (`'off' | 'dedicated' | 'generic'`, machine scope, default `'off'`). The
 * Guard is re-based onto a narrow `NextEditConfigPort` seam so these tests
 * drive it against an in-memory fake port (no live VS Code needed), and the
 * REAL port implementation (`createVsCodeNextEditConfigPort`) is exercised
 * separately against a mocked `vscode` workspace-configuration surface.
 *
 * Mutual exclusion is STRUCTURAL now: one enum cannot hold two "on" values,
 * so toggling the second source on REPLACES the first — there is no refusal
 * path (and no refusal copy) left in this module. The one surviving refusal
 * ("Generic on an unsupported FIM backend") lives in `shell.vscode.ts` and is
 * covered there.
 *
 * Test hygiene (Global Constraints): the spies below are plain functions
 * pushing into arrays, not `vi.fn()` — `vi.fn()` swallows unhandled
 * rejections, which would make the rejection assertions here vacuous.
 */

// ─────────────────────────── the vscode config harness ───────────────────────

/**
 * Backing state for the mocked `vscode.workspace` configuration surface the
 * REAL port implementation is tested against. Grounded against the API:
 * `WorkspaceConfiguration.update(section, value, ConfigurationTarget.Global)`
 * returns a Thenable; `onDidChangeConfiguration` delivers a
 * `ConfigurationChangeEvent` whose `affectsConfiguration(section)` supports
 * dotted names.
 */
const cfgHost = {
  settings: new Map<string, unknown>(),
  updates: [] as { section: string; key: string; value: unknown; target: unknown }[],
  configListeners: [] as ((e: { affectsConfiguration(section: string): boolean }) => void)[],
  updateShouldReject: false,
};

function resetCfgHost(): void {
  cfgHost.settings.clear();
  cfgHost.updates.length = 0;
  cfgHost.configListeners.length = 0;
  cfgHost.updateShouldReject = false;
}

/** Mirrors the real `affectsConfiguration` contract for dotted names: a
 *  change to `a.b.c` affects `a`, `a.b`, `a.b.c` and any descendant query. */
function affects(changedKey: string, section: string): boolean {
  return (
    changedKey === section ||
    changedKey.startsWith(`${section}.`) ||
    section.startsWith(`${changedKey}.`)
  );
}

function fireConfigChange(changedKey: string): void {
  const e = { affectsConfiguration: (section: string) => affects(changedKey, section) };
  for (const listener of [...cfgHost.configListeners]) {
    listener(e);
  }
}

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, dflt: T): T =>
        cfgHost.settings.has(`${section}.${key}`)
          ? (cfgHost.settings.get(`${section}.${key}`) as T)
          : dflt,
      update: (key: string, value: unknown, target: unknown): Thenable<void> => {
        if (cfgHost.updateShouldReject) {
          return Promise.reject(new Error('update failed (settings write error)'));
        }
        cfgHost.updates.push({ section, key, value, target });
        cfgHost.settings.set(`${section}.${key}`, value);
        // The real host fires onDidChangeConfiguration for programmatic
        // updates too — modelled here so the port's own write is observable
        // through the same event a native settings-page edit produces.
        fireConfigChange(`${section}.${key}`);
        return Promise.resolve();
      },
    }),
    onDidChangeConfiguration: (cb: (e: { affectsConfiguration(section: string): boolean }) => void) => {
      cfgHost.configListeners.push(cb);
      return {
        dispose: () => {
          const i = cfgHost.configListeners.indexOf(cb);
          if (i >= 0) cfgHost.configListeners.splice(i, 1);
        },
      };
    },
  },
}));

import {
  NextEditGuard,
  NEXT_EDIT_TOGGLES_KEY,
  NEXT_EDIT_SOURCE_SETTING,
  createVsCodeNextEditConfigPort,
  migrateNextEditToggles,
  type NextEditConfigPort,
  type NextEditSource,
} from './guard';

// ─────────────────────────────── the fake port ───────────────────────────────

interface FakePort {
  port: NextEditConfigPort;
  /** Every value `set()` was called with, in order. */
  sets: NextEditSource[];
  /** Simulates a NATIVE settings-page edit: moves the value and fires the
   *  change event — exactly what `onDidChangeConfiguration` delivers. */
  setExternally(v: NextEditSource): void;
  /** Fires the change event WITHOUT moving the value — a same-value or
   *  unrelated-section event the Guard must not re-push for. */
  emitSpuriousChange(): void;
  value(): NextEditSource;
  listenerCount(): number;
  setShouldReject: boolean;
}

function makeFakePort(initial: NextEditSource = 'off'): FakePort {
  let value = initial;
  const sets: NextEditSource[] = [];
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const fake: FakePort = {
    sets,
    setShouldReject: false,
    setExternally: (v) => {
      value = v;
      emit();
    },
    emitSpuriousChange: () => emit(),
    value: () => value,
    listenerCount: () => listeners.size,
    port: {
      get: () => value,
      set: async (v) => {
        // Resolves on a later microtask so a genuinely concurrent second
        // requestToggle has a window to interleave — a synchronous fake
        // would make the serialization test vacuous.
        await Promise.resolve();
        if (fake.setShouldReject) throw new Error('set failed (settings write error)');
        sets.push(v);
        value = v;
        emit();
      },
      onDidChange: (cb) => {
        listeners.add(cb);
        return { dispose: () => void listeners.delete(cb) };
      },
    },
  };
  return fake;
}

function makeDeps(): { reportFailure(msg: string): void; failures: string[] } {
  const failures: string[] = [];
  return { failures, reportFailure: (msg: string) => void failures.push(msg) };
}

/** In-memory `vscode.Memento` with the REAL deletion semantics: `update(key,
 *  undefined)` REMOVES the key (API-pinned — "using `undefined` as value
 *  removes the key from the underlying storage"), which is exactly the §5.3
 *  migration latch these tests depend on. */
function makeMemento(seed?: unknown): {
  memento: vscodeTypes.Memento;
  updates: { key: string; value: unknown }[];
  store: Map<string, unknown>;
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
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
  };
  return { memento, updates, store };
}

// ══════════════════ the REAL port over the mocked vscode ═════════════════════

describe('createVsCodeNextEditConfigPort (the real seam, agent-independent by construction)', () => {
  beforeEach(resetCfgHost);

  it('get() answers the setting default "off" when nothing is stored', () => {
    expect(createVsCodeNextEditConfigPort().get()).toBe('off');
  });

  it('get() answers a stored "dedicated" / "generic" verbatim', () => {
    const port = createVsCodeNextEditConfigPort();
    cfgHost.settings.set('talaria.nextEdit.source', 'dedicated');
    expect(port.get()).toBe('dedicated');
    cfgHost.settings.set('talaria.nextEdit.source', 'generic');
    expect(port.get()).toBe('generic');
  });

  it('get() coerces a hand-edited INVALID value to "off" (fail-closed) rather than throwing', () => {
    const port = createVsCodeNextEditConfigPort();
    for (const junk of ['both', 'ON', true, 42, { next: true }, null]) {
      cfgHost.settings.set('talaria.nextEdit.source', junk);
      expect(port.get(), `junk value ${JSON.stringify(junk)} must degrade to 'off'`).toBe('off');
    }
  });

  it('set() writes exactly {section: talaria.nextEdit, key: source} at ConfigurationTarget.Global (machine-scoped key)', async () => {
    await createVsCodeNextEditConfigPort().set('dedicated');
    expect(cfgHost.updates).toEqual([
      { section: 'talaria.nextEdit', key: 'source', value: 'dedicated', target: 1 },
    ]);
  });

  it('onDidChange fires for a talaria.nextEdit.source change and NOT for an unrelated key; dispose stops it', () => {
    const port = createVsCodeNextEditConfigPort();
    let fired = 0;
    const sub = port.onDidChange(() => {
      fired += 1;
    });

    fireConfigChange('talaria.autocomplete.model');
    expect(fired, 'an unrelated key must not fire the port change event').toBe(0);

    fireConfigChange('talaria.nextEdit.source');
    expect(fired).toBe(1);

    sub.dispose();
    fireConfigChange('talaria.nextEdit.source');
    expect(fired, 'a disposed subscription must stop receiving').toBe(1);
  });

  it('the exported setting-key constant and the port agree on the one key', () => {
    expect(NEXT_EDIT_SOURCE_SETTING).toBe('talaria.nextEdit.source');
  });
});

// ═══════════════════════ (a) state derivation from the enum ══════════════════

describe('NextEditGuard.getState/getMode — derived from the enum, read-through', () => {
  it.each([
    ['off', { next: false, generic: false }, 'off'],
    ['dedicated', { next: true, generic: false }, 'next'],
    ['generic', { next: false, generic: true }, 'generic'],
  ] as const)('source %s -> state %o, mode %s', async (source, state, mode) => {
    const fake = makeFakePort(source);
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    expect(guard.getState()).toEqual(state);
    expect(guard.getMode()).toBe(mode);
  });

  it('read-through: getState()/getMode() reflect a value moved BEHIND the Guard (native page / another window)', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    expect(guard.getMode()).toBe('off');

    fake.setExternally('dedicated');

    expect(guard.getState()).toEqual({ next: true, generic: false });
    expect(guard.getMode()).toBe('next');
  });

  it('getState() returns a fresh copy: mutating it cannot change the mode', async () => {
    const fake = makeFakePort('dedicated');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const s = guard.getState();
    s.next = false;
    expect(guard.getMode()).toBe('next');
    expect(guard.getState()).toEqual({ next: true, generic: false });
  });

  it('hydrate() itself writes NOTHING — hydration is a pure read', async () => {
    const fake = makeFakePort('generic');
    await NextEditGuard.hydrate(fake.port, makeDeps());
    expect(fake.sets).toEqual([]);
  });
});

// ══════════════ (b)(c) toggles: ONE enum write, structural exclusion ═════════

describe('NextEditGuard.requestToggle — a toggle is ONE enum write; conflict REPLACES, never refuses', () => {
  it('(b) toggling NEXT on while GENERIC is active writes "dedicated" — REPLACING generic, no refusal, no warning', async () => {
    const fake = makeFakePort('generic');
    const deps = makeDeps();
    const guard = await NextEditGuard.hydrate(fake.port, deps);
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    const result = await guard.requestToggle({ source: 'next', on: true });

    expect(result).toEqual({ next: true, generic: false });
    expect(guard.getMode()).toBe('next');
    expect(fake.sets, 'exactly ONE write — the enum replaces, there is no off-then-on pair').toEqual([
      'dedicated',
    ]);
    expect(seen).toEqual([{ next: true, generic: false }]);
    expect(deps.failures).toEqual([]);
  });

  it('(b mirror) toggling GENERIC on while NEXT is active writes "generic" — the same structural replace', async () => {
    const fake = makeFakePort('dedicated');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());

    const result = await guard.requestToggle({ source: 'generic', on: true });

    expect(result).toEqual({ next: false, generic: true });
    expect(fake.sets).toEqual(['generic']);
  });

  it('toggling a source on from OFF writes its enum value', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());

    await guard.requestToggle({ source: 'generic', on: true });
    expect(fake.sets).toEqual(['generic']);
    expect(guard.getMode()).toBe('generic');
  });

  it('(c) toggling the ACTIVE source off writes "off"', async () => {
    const fake = makeFakePort('dedicated');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());

    const result = await guard.requestToggle({ source: 'next', on: false });

    expect(result).toEqual({ next: false, generic: false });
    expect(guard.getMode()).toBe('off');
    expect(fake.sets).toEqual(['off']);
  });

  it('(c) toggling the INACTIVE source off is a no-op: NO write, the active source survives', async () => {
    const fake = makeFakePort('generic');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    const result = await guard.requestToggle({ source: 'next', on: false });

    expect(result).toEqual({ next: false, generic: true });
    expect(fake.sets, 'nothing changed, so nothing may be written').toEqual([]);
    expect(seen, 'nothing changed, so nothing may be pushed').toEqual([]);
    expect(guard.getMode()).toBe('generic');
  });

  it('toggling an already-on source on again is a no-op write too', async () => {
    const fake = makeFakePort('dedicated');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());

    const result = await guard.requestToggle({ source: 'next', on: true });

    expect(result).toEqual({ next: true, generic: false });
    expect(fake.sets).toEqual([]);
  });

  it('two RACING requestToggles are serialized in order — the second decides against the FIRST result', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());

    // Issued together, neither awaited first. Both are accepted now (the enum
    // replaces); what the queue must still guarantee is ORDER — the writes
    // land as issued, and the last one is the ratified value.
    const first = guard.requestToggle({ source: 'next', on: true });
    const second = guard.requestToggle({ source: 'generic', on: true });

    await expect(first).resolves.toEqual({ next: true, generic: false });
    await expect(second).resolves.toEqual({ next: false, generic: true });

    expect(fake.sets).toEqual(['dedicated', 'generic']);
    expect(fake.value()).toBe('generic');
    expect(guard.getMode()).toBe('generic');
  });

  it('a REJECTED settings write rejects the caller, reports to the output channel, and does not poison the queue', async () => {
    const fake = makeFakePort('off');
    const deps = makeDeps();
    const guard = await NextEditGuard.hydrate(fake.port, deps);

    fake.setShouldReject = true;
    await expect(guard.requestToggle({ source: 'next', on: true })).rejects.toThrow(
      'set failed (settings write error)',
    );
    expect(deps.failures).toHaveLength(1);
    expect(deps.failures[0]).toContain(NEXT_EDIT_SOURCE_SETTING);
    expect(guard.getMode(), 'a failed write must leave the ratified value untouched').toBe('off');

    fake.setShouldReject = false;
    await expect(guard.requestToggle({ source: 'next', on: true })).resolves.toEqual({
      next: true,
      generic: false,
    });
    expect(fake.sets).toEqual(['dedicated']);
  });

  it('getMode is exactly resolveNextEditMode over the derived state, across a toggle sequence', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());

    expect(guard.getMode()).toBe('off');
    await guard.requestToggle({ source: 'generic', on: true });
    expect(guard.getMode()).toBe('generic');
    await guard.requestToggle({ source: 'generic', on: false });
    await guard.requestToggle({ source: 'next', on: true });
    expect(guard.getMode()).toBe('next');
  });
});

// ═════════════ (f) the config-change event feeds onDidChange ═════════════════

describe('NextEditGuard.onDidChange — fed by the config port event (native-page edits flow in for free)', () => {
  it('(f) an EXTERNAL config change (native settings page) fires onDidChange with the derived state', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    fake.setExternally('dedicated');
    expect(seen).toEqual([{ next: true, generic: false }]);

    fake.setExternally('off');
    expect(seen).toEqual([
      { next: true, generic: false },
      { next: false, generic: false },
    ]);
  });

  it('a change event that did NOT move the value is not re-pushed (dedupe against event noise)', async () => {
    const fake = makeFakePort('dedicated');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    fake.emitSpuriousChange();
    fake.emitSpuriousChange();

    expect(seen).toEqual([]);
  });

  it('a disposed onDidChange listener stops receiving pushes', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const seen: ToggleState[] = [];
    const sub = guard.onDidChange((s) => void seen.push(s));

    await guard.requestToggle({ source: 'next', on: true });
    sub.dispose();
    await guard.requestToggle({ source: 'next', on: false });

    expect(seen).toEqual([{ next: true, generic: false }]);
  });

  it('guard.dispose() unsubscribes from the port — no push reaches a disposed Guard', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));
    expect(fake.listenerCount()).toBe(1);

    guard.dispose();

    expect(fake.listenerCount(), 'dispose must release the port subscription').toBe(0);
    fake.setExternally('dedicated');
    expect(seen).toEqual([]);
  });

  it('each listener receives the state each accepted toggle produced, in order', async () => {
    const fake = makeFakePort('off');
    const guard = await NextEditGuard.hydrate(fake.port, makeDeps());
    const seen: ToggleState[] = [];
    guard.onDidChange((s) => void seen.push(s));

    await guard.requestToggle({ source: 'next', on: true });
    await guard.requestToggle({ source: 'generic', on: true }); // structural replace
    await guard.requestToggle({ source: 'generic', on: false });

    expect(seen).toEqual([
      { next: true, generic: false },
      { next: false, generic: true },
      { next: false, generic: false },
    ]);
  });
});

// ═══════════════════ (e) the §5.3 one-time migration latch ═══════════════════

describe('migrateNextEditToggles — the §5.3 latch (memento delete IS the latch)', () => {
  it('memento {next:true} + setting still default "off" -> writes "dedicated", then DELETES the memento key', async () => {
    const { memento, store } = makeMemento({ next: true, generic: false });
    const fake = makeFakePort('off');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets).toEqual(['dedicated']);
    expect(fake.value()).toBe('dedicated');
    expect(store.has(NEXT_EDIT_TOGGLES_KEY), 'the memento key must be DELETED — that delete is the latch').toBe(
      false,
    );
  });

  it('memento {generic:true} migrates to "generic"', async () => {
    const { memento, store } = makeMemento({ next: false, generic: true });
    const fake = makeFakePort('off');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets).toEqual(['generic']);
    expect(store.has(NEXT_EDIT_TOGGLES_KEY)).toBe(false);
  });

  it('a SECOND run is a complete no-op (the latch): no write, no memento touch', async () => {
    const { memento, updates } = makeMemento({ next: true, generic: false });
    const fake = makeFakePort('off');
    await migrateNextEditToggles(memento, fake.port);
    const setsAfterFirst = fake.sets.length;
    const updatesAfterFirst = updates.length;

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets.length, 'second run must not write the setting again').toBe(setsAfterFirst);
    expect(updates.length, 'second run must not touch the memento at all').toBe(updatesAfterFirst);
  });

  it('memento ABSENT (fresh install / already migrated elsewhere) is a complete no-op', async () => {
    const { memento, updates } = makeMemento();
    const fake = makeFakePort('off');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('setting already NON-default -> the user has spoken since: memento deleted WITHOUT overwriting the setting', async () => {
    const { memento, store } = makeMemento({ next: true, generic: false });
    const fake = makeFakePort('generic');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets, 'a non-default setting must NEVER be overwritten by stale memento state').toEqual([]);
    expect(fake.value()).toBe('generic');
    expect(store.has(NEXT_EDIT_TOGGLES_KEY)).toBe(false);
  });

  it('memento BOTH-OFF -> no settings write is needed ("off" is already the default), memento deleted', async () => {
    const { memento, store } = makeMemento({ next: false, generic: false });
    const fake = makeFakePort('off');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets, 'writing the default explicitly would only churn settings.json').toEqual([]);
    expect(fake.value()).toBe('off');
    expect(store.has(NEXT_EDIT_TOGGLES_KEY)).toBe(false);
  });

  it('memento BOTH-ON (the old hand-edited conflict) sanitizes to OFF — same outcome the old cold-start reset produced', async () => {
    const { memento, store } = makeMemento({ next: true, generic: true });
    const fake = makeFakePort('off');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets, 'a both-on conflict must land as OFF, never silently pick one source').toEqual([]);
    expect(fake.value()).toBe('off');
    expect(store.has(NEXT_EDIT_TOGGLES_KEY)).toBe(false);
  });

  it('a MALFORMED memento value degrades field-by-field to false (so to OFF) rather than throwing', async () => {
    const { memento, store } = makeMemento({ next: 'yes', generic: null });
    const fake = makeFakePort('off');

    await migrateNextEditToggles(memento, fake.port);

    expect(fake.sets).toEqual([]);
    expect(fake.value()).toBe('off');
    expect(store.has(NEXT_EDIT_TOGGLES_KEY)).toBe(false);
  });

  it('a FAILED settings write keeps the memento (the latch is not burned; next activation retries)', async () => {
    const { memento, store } = makeMemento({ next: true, generic: false });
    const fake = makeFakePort('off');
    fake.setShouldReject = true;

    await expect(migrateNextEditToggles(memento, fake.port)).rejects.toThrow(
      'set failed (settings write error)',
    );

    expect(
      store.has(NEXT_EDIT_TOGGLES_KEY),
      'the memento must SURVIVE a failed write — deleting it would burn the latch with nothing migrated',
    ).toBe(true);
  });
});

// ═════════════════════════════ the key locks ═════════════════════════════════

describe('LOCK: the two store-key literals live in guard.ts alone', () => {
  /**
   * Comments are STRIPPED and the match requires a QUOTED literal — the same
   * discipline `coexistence.lock.test.ts` documents at length (Task 11's
   * lesson: a scan over raw bytes is satisfiable, or trippable, by prose).
   * Several modules legitimately DOCUMENT the setting key in comments
   * (`extension.ts`'s migration note, the toggle port's contract doc); only
   * CODE naming the key is a bypass.
   */
  const stripComments = (content: string): string =>
    content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const LEGACY_KEY_LITERAL = /['"`]hermes\.nextEdit\.toggles['"`]/;
  const SOURCE_KEY_LITERAL = /['"`]talaria\.nextEdit\.source['"`]/;

  it('the LEGACY memento key literal (migration-only) appears in no other non-test file under src/', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const offenders = collectNonTestTsSources(path.join(__dirname, '..', '..'))
      .filter((f) => LEGACY_KEY_LITERAL.test(stripComments(f.content)))
      .map((f) => f.file);

    expect(offenders).toEqual(['autocomplete/nextedit/guard.ts']);
  });

  it('the SETTING key literal talaria.nextEdit.source appears in no other non-test file under src/', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const offenders = collectNonTestTsSources(path.join(__dirname, '..', '..'))
      .filter((f) => SOURCE_KEY_LITERAL.test(stripComments(f.content)))
      .map((f) => f.file);

    expect(offenders).toEqual(['autocomplete/nextedit/guard.ts']);
  });

  it('negative control: prose naming a key in a comment is not a bypass; RED-first: quoted code IS one', () => {
    expect(
      SOURCE_KEY_LITERAL.test(stripComments("// documents 'talaria.nextEdit.source' in prose\nconst x = 1;")),
      'prose in a stripped comment must not count',
    ).toBe(false);
    expect(
      SOURCE_KEY_LITERAL.test(stripComments("cfg.update('talaria.nextEdit.source', 'generic');")),
      'a quoted key literal in real code must count',
    ).toBe(true);
    expect(
      LEGACY_KEY_LITERAL.test(stripComments("state.get('hermes.nextEdit.toggles');")),
      'a quoted legacy-key literal in real code must count',
    ).toBe(true);
  });

  it('the exported constants really ARE those literals (the scans and the runtime agree)', () => {
    expect(NEXT_EDIT_TOGGLES_KEY).toBe('hermes.nextEdit.toggles');
    expect(NEXT_EDIT_SOURCE_SETTING).toBe('talaria.nextEdit.source');
    expect(LEGACY_KEY_LITERAL.test(`const k = '${NEXT_EDIT_TOGGLES_KEY}';`)).toBe(true);
    expect(SOURCE_KEY_LITERAL.test(`const k = '${NEXT_EDIT_SOURCE_SETTING}';`)).toBe(true);
  });
});

/**
 * F-9 (final-review-findings.md SEC I-1) — `setKeysForSync` remains banned.
 * The toggle state now lives in a `machine`-scoped SETTING (which VS Code
 * itself never roams via Settings Sync), but `globalState` still exists (the
 * migration reads it once) and a future `setKeysForSync` call anywhere would
 * reopen the roaming question for whatever key it names. The lock is kept
 * verbatim: the CALL itself, in any spelling, appears nowhere under src/.
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

  it('sanity: prose naming setKeysForSync without a call is correctly NOT flagged (negative control on the mechanism itself)', () => {
    const proseOnly = '`setKeysForSync` is deliberately NOT called: these toggles are hardware-bound';
    expect(SET_KEYS_FOR_SYNC_CALL.test(proseOnly)).toBe(false);
  });

  /**
   * RED-first non-vacuous proof, IN-MEMORY (no disk write into `src/` itself
   * — the same H6-B9 discipline `contextPurity.test.ts`/`reuseLocks.test.ts`
   * document at length): appending a synthetic entry to the REAL,
   * already-collected file list proves the predicate fires without racing any
   * concurrently-writing probe test in a sibling directory. This is the EXACT
   * evasion shape the security lens proved: the call built from the imported
   * constant, not the literal string.
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
