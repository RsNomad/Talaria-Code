import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CrossFileContextService,
  buildRecentlyOpenedCandidates,
  createEditTrackerSource,
  egressPreconditionsMet,
  type CrossFileContextServiceDeps,
  type OpenTab,
} from './contextService';
import { RingBuffer } from './ringBuffer';
import { scanSnippetForSecrets } from './secretScanner';
import type { Anchor, SnippetCandidate, SnippetSource } from './types';
import type { BackendCapabilities, FimBackend, FimTemplate } from '../types';
import { must } from '../../testing/must';

vi.mock('./secretScanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secretScanner')>();
  return { ...actual, scanSnippetForSecrets: vi.fn(actual.scanSnippetForSecrets) };
});

// ── egressPreconditionsMet — pure predicate ─────────────────────────────────
describe('egressPreconditionsMet', () => {
  it('is true when not skipping untrusted-remote and enabled', () => {
    expect(egressPreconditionsMet({ skipUntrustedRemote: false, enabled: true })).toBe(true);
  });

  it('is false when skipUntrustedRemote is true, even if enabled', () => {
    expect(egressPreconditionsMet({ skipUntrustedRemote: true, enabled: true })).toBe(false);
  });

  it('is false when not enabled, even if not skipping untrusted-remote', () => {
    expect(egressPreconditionsMet({ skipUntrustedRemote: false, enabled: false })).toBe(false);
  });

  it('is false when both fail', () => {
    expect(egressPreconditionsMet({ skipUntrustedRemote: true, enabled: false })).toBe(false);
  });
});

// ── buildRecentlyOpenedCandidates — pure ────────────────────────────────────
describe('buildRecentlyOpenedCandidates', () => {
  function tab(overrides: Partial<OpenTab> = {}): OpenTab {
    return { uri: 'file:///a.ts', filepath: 'a.ts', content: 'const a = 1;', ...overrides };
  }

  it('orders tabs by MRU (most-recently-focused first)', () => {
    const tabs = [tab({ uri: 'file:///a.ts' }), tab({ uri: 'file:///b.ts' }), tab({ uri: 'file:///c.ts' })];
    const result = buildRecentlyOpenedCandidates(tabs, ['file:///c.ts', 'file:///a.ts'], undefined);

    expect(result.map((c) => c.uri)).toEqual(['file:///c.ts', 'file:///a.ts', 'file:///b.ts']);
  });

  it('sorts tabs never seen in the MRU list after every MRU-known tab, preserving original order', () => {
    const tabs = [tab({ uri: 'file:///x.ts' }), tab({ uri: 'file:///a.ts' }), tab({ uri: 'file:///y.ts' })];
    const result = buildRecentlyOpenedCandidates(tabs, ['file:///a.ts'], undefined);

    expect(result.map((c) => c.uri)).toEqual(['file:///a.ts', 'file:///x.ts', 'file:///y.ts']);
  });

  it('excludes the active document (belt-and-braces)', () => {
    const tabs = [tab({ uri: 'file:///a.ts' }), tab({ uri: 'file:///active.ts' })];
    const result = buildRecentlyOpenedCandidates(tabs, [], 'file:///active.ts');

    expect(result.map((c) => c.uri)).toEqual(['file:///a.ts']);
  });

  it('excerpts to whole lines only, capped at 60 — never bisecting a line (A4)', () => {
    const lines = Array.from({ length: 70 }, (_, i) => `line${i}`);
    const t = tab({ content: lines.join('\n') });
    const candidate = must(buildRecentlyOpenedCandidates([t], [], undefined)[0]);

    expect(candidate.content.split('\n')).toHaveLength(60);
    expect(candidate.content.split('\n')).toEqual(lines.slice(0, 60));
    expect(candidate.startLine).toBe(0);
    expect(candidate.endLine).toBe(59);
  });

  it('does not cap when the file has fewer than 60 lines', () => {
    const t = tab({ content: 'a\nb\nc' });
    const candidate = must(buildRecentlyOpenedCandidates([t], [], undefined)[0]);

    expect(candidate.content).toBe('a\nb\nc');
    expect(candidate.endLine).toBe(2);
  });

  it('produces kind "recently-opened" candidates', () => {
    const candidate = must(buildRecentlyOpenedCandidates([tab()], [], undefined)[0]);
    expect(candidate.kind).toBe('recently-opened');
  });
});

// ── createEditTrackerSource — thin wrapper over an EditTracker-shaped reader ─
describe('createEditTrackerSource', () => {
  it('maps RecentEdit entries to SnippetCandidates of kind recently-edited', async () => {
    const tracker = {
      getRecentEdits: () => [
        { uri: 'file:///a.ts', filepath: 'a.ts', startLine: 1, endLine: 2, content: 'x' },
      ],
    };
    const source = createEditTrackerSource(tracker);
    const result = await source.gather({ uri: 'file:///cursor.ts', line: 0 }, new AbortController().signal);

    expect(result).toEqual([
      { uri: 'file:///a.ts', filepath: 'a.ts', content: 'x', kind: 'recently-edited', startLine: 1, endLine: 2 },
    ]);
  });

  it('excludes an edit on the anchor (active) document', async () => {
    const tracker = {
      getRecentEdits: () => [
        { uri: 'file:///active.ts', filepath: 'active.ts', startLine: 0, endLine: 0, content: 'x' },
        { uri: 'file:///other.ts', filepath: 'other.ts', startLine: 0, endLine: 0, content: 'y' },
      ],
    };
    const source = createEditTrackerSource(tracker);
    const result = await source.gather({ uri: 'file:///active.ts', line: 0 }, new AbortController().signal);

    expect(result.map((c) => c.uri)).toEqual(['file:///other.ts']);
  });
});

// ── CrossFileContextService — the decision core ─────────────────────────────
function capabilities(overrides: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return { nativeFim: true, assemblesCrossFileServerSide: true, streaming: true, ...overrides };
}

function template(overrides: Partial<FimTemplate> = {}): FimTemplate {
  return { render: () => '', stop: [], ...overrides };
}

function candidate(overrides: Partial<SnippetCandidate> = {}): SnippetCandidate {
  return {
    uri: 'file:///a.ts',
    filepath: 'a.ts',
    content: 'const a = 1;',
    kind: 'recently-edited',
    startLine: 0,
    endLine: 0,
    ...overrides,
  };
}

function spySource(kind: SnippetSource['kind'], result: SnippetCandidate[] = []): SnippetSource & {
  gatherSpy: ReturnType<typeof vi.fn>;
} {
  const gatherSpy = vi.fn().mockResolvedValue(result);
  return { kind, gather: gatherSpy, gatherSpy };
}

/** A minimal `FimBackend` double — `warmUp` omitted by default (mirrors a
 *  non-llamacpp backend, which safely has no `warmUp` at all). */
function fakeBackend(overrides: Partial<FimBackend> = {}): FimBackend {
  return {
    name: 'llamacpp',
    capabilities: capabilities(),
    async *streamFim() {
      // Never exercised by the warm-up wiring tests below.
    },
    ...overrides,
  };
}

interface Harness {
  service: CrossFileContextService;
  ringBuffer: RingBuffer;
  anchor: Anchor;
  now: number;
  advance(ms: number): void;
  deps: CrossFileContextServiceDeps;
}

function makeHarness(overrides: {
  sources?: SnippetSource[];
  crossFileEnabled?: boolean;
  prefixInjection?: boolean;
  capabilitiesOverrides?: Partial<BackendCapabilities>;
  backend?: FimBackend;
  getWarmUpEnabled?: () => boolean;
  getSkipUntrustedRemote?: () => boolean;
} = {}): Harness {
  const ringBuffer = new RingBuffer();
  let anchor: Anchor = { uri: 'file:///active.ts', line: 0 };
  // Starts at 0 (not an arbitrary large epoch-ms value) so a harness that
  // never calls `recordKeystroke()` naturally represents "no keystroke has
  // ever been observed" without every test needing to reason about a large
  // clock/lastKeystrokeAt offset — `advance()` moves it forward from here.
  let clock = 0;

  const deps: CrossFileContextServiceDeps = {
    capabilities: capabilities(overrides.capabilitiesOverrides),
    template: template(),
    crossFileEnabled: overrides.crossFileEnabled ?? true,
    prefixInjection: overrides.prefixInjection ?? false,
    ringBuffer,
    sources: overrides.sources ?? [],
    getCurrentAnchor: () => anchor,
    getSkipUntrustedRemote: overrides.getSkipUntrustedRemote ?? (() => false),
    getEnabled: () => true,
    now: () => clock,
    backend: overrides.backend,
    getWarmUpEnabled: overrides.getWarmUpEnabled,
  };

  const service = new CrossFileContextService(deps);

  return {
    service,
    ringBuffer,
    get anchor() {
      return anchor;
    },
    set anchor(a: Anchor) {
      anchor = a;
    },
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
    deps,
  } as Harness;
}

const DOC = { uri: { toString: () => 'file:///active.ts' } };

describe('CrossFileContextService — mode gating (R6)', () => {
  it('mode "none" (crossFileEnabled false): sources are never called and snapshotFor is empty', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source], crossFileEnabled: false });

    await h.service.handleSave('file:///x.ts');
    await h.service.handleActiveEditorChange();
    await h.service.handleTabsChanged();

    expect(source.gatherSpy).not.toHaveBeenCalled();
    expect(h.service.snapshotFor(DOC).snippets).toEqual([]);
    expect(h.service.getStatus().mode).toBe('none');
  });

  it('mode "none" via capabilities/template (no channel + no prefixInjection): still no gather', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({
      sources: [source],
      capabilitiesOverrides: { assemblesCrossFileServerSide: false, nativeFim: true },
      prefixInjection: false,
    });

    await h.service.handleActiveEditorChange();

    expect(source.gatherSpy).not.toHaveBeenCalled();
    expect(h.service.getStatus().mode).toBe('none');
  });

  it('a non-none mode DOES call sources on a gather trigger', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source] }); // default capabilities => input-extra

    expect(h.service.getStatus().mode).toBe('input-extra');
    await h.service.handleActiveEditorChange();

    expect(source.gatherSpy).toHaveBeenCalledTimes(1);
  });

  it('reconfigure() to mode none idles subsequent triggers', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source] });

    h.service.reconfigure({
      capabilities: capabilities(),
      template: template(),
      crossFileEnabled: false,
      prefixInjection: false,
    });
    await h.service.handleActiveEditorChange();

    expect(source.gatherSpy).not.toHaveBeenCalled();
  });
});

describe('CrossFileContextService — snapshotFor reuse vs regenerate (§2.4)', () => {
  it('returns the SAME frozen reference across repeated calls with no new ingest (burst reuse)', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange(); // boundary + first ingest
    const first = h.service.snapshotFor(DOC);
    const second = h.service.snapshotFor(DOC);
    const third = h.service.snapshotFor(DOC);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('reuses mid-burst even when the epoch changed, absent a boundary event or idle (no rate-limiter rotation)', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange();
    const first = h.service.snapshotFor(DOC); // regenerates once (boundary + epoch change)

    // A NEW epoch-bumping ingest arrives via a NON-boundary trigger (tabs
    // changed), and barely any time passes — no boundary, not idle.
    source.gatherSpy.mockResolvedValueOnce([candidate({ uri: 'file:///b.ts' })]);
    await h.service.handleTabsChanged();
    h.advance(10);
    const second = h.service.snapshotFor(DOC);

    expect(second).toBe(first);
  });

  it('regenerates to a NEW reference after a boundary event follows an epoch change', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange();
    const first = h.service.snapshotFor(DOC);

    source.gatherSpy.mockResolvedValueOnce([candidate({ uri: 'file:///b.ts', content: 'const b = 2;' })]);
    await h.service.handleSave('file:///b.ts'); // save = boundary event + gather

    const second = h.service.snapshotFor(DOC);

    expect(second).not.toBe(first);
    expect(second.snippets.length).toBeGreaterThan(0);
  });

  it('regenerates after an epoch change once the caller has been idle long enough', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange();
    const first = h.service.snapshotFor(DOC);

    source.gatherSpy.mockResolvedValueOnce([candidate({ uri: 'file:///b.ts' })]);
    await h.service.handleTabsChanged(); // non-boundary trigger, epoch bumps
    h.advance(5000); // well past the idle threshold, no further keystroke

    const second = h.service.snapshotFor(DOC);

    expect(second).not.toBe(first);
  });

  it('a pending boundary flag survives a "reuse" decision and still regenerates once the epoch actually changes', async () => {
    const source = spySource('recently-edited', []);
    const h = makeHarness({ sources: [source] });

    // Prime `snapshotEpoch` away from its initial -1 sentinel: a boundary
    // event (the source yields no candidates, so the ring's epoch stays at
    // 0) followed by a `snapshotFor` regenerates ONCE — purely because
    // currentEpoch(0) !== the -1 sentinel — and consumes that boundary flag.
    // This establishes snapshotEpoch=0 so the NEXT boundary event below can
    // genuinely exercise "epoch unchanged" rather than tripping the sentinel.
    await h.service.handleActiveEditorChange();
    h.service.snapshotFor(DOC);

    // A SECOND boundary event fires but again nothing gets ingested (epoch
    // stays at 0) — shouldRegenerate sees epochChanged FALSE and
    // short-circuits to 'reuse' WITHOUT even consulting the boundary flag.
    await h.service.handleActiveEditorChange();
    const first = h.service.snapshotFor(DOC);
    expect(first.snippets).toEqual([]);

    // Now content actually lands (epoch changes) via a later NON-boundary
    // trigger, with the clock barely moving (well under the 1200ms idle
    // threshold) — the boundary flag from the SECOND handleActiveEditorChange
    // must still count; it was never consulted (let alone reset) above.
    source.gatherSpy.mockResolvedValueOnce([candidate({ uri: 'file:///late.ts' })]);
    await h.service.handleTabsChanged();
    h.advance(10); // not idle

    const second = h.service.snapshotFor(DOC);
    expect(second).not.toBe(first);
    expect(second.snippets.length).toBeGreaterThan(0);
  });

  it('excludes the queried document from its own snapshot (activeUri belt-and-braces)', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///active.ts' })]);
    const h = makeHarness({ sources: [source] });
    h.anchor = { uri: 'file:///active.ts', line: 0 };

    await h.service.handleActiveEditorChange();
    const snap = h.service.snapshotFor(DOC);

    expect(snap.snippets).toEqual([]);
  });
});

describe('CrossFileContextService — handleSave clears quarantine (§3.3 item 4)', () => {
  const SECRET_URI = 'file:///secrets.ts';
  const SECRET_CONTENT = 'const key = "AKIAABCDEFGHIJKLMNOP";';

  it('a rejected (quarantined) uri stays dropped on re-ingest until handleSave is called for it', async () => {
    const source = spySource('recently-edited', [candidate({ uri: SECRET_URI, content: SECRET_CONTENT })]);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange(); // ingest #1 (default mock: secret)
    expect(h.ringBuffer.allScanned()).toEqual([]); // quarantined on first reject

    // Re-ingest the SAME secret content again without a save — still dropped.
    await h.service.handleTabsChanged(); // ingest #2 (default mock: secret)
    expect(h.ringBuffer.allScanned()).toEqual([]);

    // handleSave for a DIFFERENT uri does not clear this one (also triggers
    // its own gather — still secret, so it's a no-op either way).
    await h.service.handleSave('file:///unrelated.ts'); // ingest #3 (default mock: secret)
    expect(h.ringBuffer.allScanned()).toEqual([]);

    // handleSave for THIS uri clears the quarantine; the gather IT triggers
    // now sees clean content (source made clean BEFORE the call, since
    // handleSave's own boundary-triggered gather is what must pick it up).
    source.gatherSpy.mockResolvedValue([candidate({ uri: SECRET_URI, content: 'const a = 1;' })]);
    await h.service.handleSave(SECRET_URI); // ingest #4: clears quarantine, then ingests clean content
    expect(h.ringBuffer.allScanned()).toHaveLength(1);
  });

  it('a still-secret file re-quarantines immediately after handleSave clears it (no amnesty)', async () => {
    const source = spySource('recently-edited', [candidate({ uri: SECRET_URI, content: SECRET_CONTENT })]);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange();
    expect(h.ringBuffer.allScanned()).toEqual([]);

    await h.service.handleSave(SECRET_URI); // clears quarantine
    source.gatherSpy.mockResolvedValueOnce([candidate({ uri: SECRET_URI, content: SECRET_CONTENT })]); // still secret
    await h.service.handleTabsChanged();

    expect(h.ringBuffer.allScanned()).toEqual([]); // re-quarantined
  });

  it('clears the quarantine even under mode "none" (harmless bookkeeping; gather still stays idle)', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source], crossFileEnabled: false });

    // Should not throw and should not invoke any source.
    await expect(h.service.handleSave(SECRET_URI)).resolves.toBeUndefined();
    expect(source.gatherSpy).not.toHaveBeenCalled();
  });
});

describe('CrossFileContextService — stale-anchor drop wiring (§2.4)', () => {
  /**
   * The deferred promise is created OUTSIDE `gather()` and captured by
   * reference, so `resolveGather` is valid the instant this helper returns —
   * regardless of exactly when `runGatherCycle`'s microtask actually invokes
   * `gather()`. (An earlier draft created the promise INSIDE the `gather()`
   * closure, which meant `resolveGather` was still the initial no-op at the
   * moment the test called it — `triggerGather()` chains through
   * `Promise.resolve().then(...)`, so `gather()` hasn't run yet on the same
   * tick `handleActiveEditorChange()` returns. The dud resolve made those
   * tests pass only because the unrelated 100ms `raceWithTimeout` fallback
   * happened to yield the same expected value — a false-positive green.)
   */
  function makeDeferredSource(kind: SnippetSource['kind'] = 'recently-edited'): {
    source: SnippetSource;
    resolveGather: (v: SnippetCandidate[]) => void;
  } {
    let resolveGather!: (v: SnippetCandidate[]) => void;
    const deferred = new Promise<SnippetCandidate[]>((resolve) => {
      resolveGather = resolve;
    });
    return { source: { kind, gather: () => deferred }, resolveGather };
  }

  it('drops a whole gather cycle whose candidates resolve after the anchor moved on', async () => {
    const { source, resolveGather } = makeDeferredSource();
    const h = makeHarness({ sources: [source] });

    const pending = h.service.handleActiveEditorChange();
    // `triggerGather` chains through `this.gatherChain.then(...)`, so
    // `runGatherCycle` (and its `requestAnchor` read) runs one microtask
    // AFTER this call returns, not synchronously within it. Flush that one
    // microtask before mutating the anchor, or the mutation below would race
    // ahead of `requestAnchor` being captured and this test would pass for
    // the wrong reason (both reads seeing the SAME, already-moved anchor).
    await Promise.resolve();
    // Simulate the cursor moving to a different file WHILE the gather is in flight.
    h.anchor = { uri: 'file:///moved-away.ts', line: 0 };
    resolveGather([candidate({ uri: 'file:///x.ts' })]);
    await pending;

    expect(h.ringBuffer.allScanned()).toEqual([]);
  });

  it('accepts candidates when the anchor is unchanged across the gather', async () => {
    const { source, resolveGather } = makeDeferredSource();
    const h = makeHarness({ sources: [source] });

    const pending = h.service.handleActiveEditorChange();
    resolveGather([candidate({ uri: 'file:///x.ts' })]);
    await pending;

    expect(h.ringBuffer.allScanned()).toHaveLength(1);
  });
});

describe('CrossFileContextService — ingest ordering preserves source recency (ring-prepend inversion)', () => {
  it('a source returning candidates most-recent-first ends up with the most-recent one at the front of the ring', async () => {
    // Source hands back 6 candidates (exceeds the recently-edited cap of 3
    // in snippetBudgeter's ladder) in most-recent-FIRST order.
    const many = Array.from({ length: 6 }, (_, i) =>
      candidate({ uri: `file:///edit-${i}.ts`, content: `const v${i} = ${i};` }),
    );
    const source = spySource('recently-edited', many);
    const h = makeHarness({ sources: [source] });

    await h.service.handleActiveEditorChange();

    // ringBuffer.allScanned() concatenates each kind's ring, which is itself
    // most-recent-first after `ingest`'s prepend semantics.
    expect(h.ringBuffer.allScanned().map((s) => s.uri)).toEqual(many.map((c) => c.uri));

    const snap = h.service.snapshotFor(DOC);
    // The budgeter caps recently-edited at 3, taking the FIRST 3 survivors in
    // ring/scanned order — so the 3 MOST RECENT candidates (edit-0..edit-2)
    // are the ones that survive the cap (edit-3..edit-5 are dropped).
    // "Most-relevant-LAST" (§2.5) reverses ladder-RUNG order across DIFFERENT
    // kinds, not the fill order WITHIN one rung — with only one rung
    // populated here, within-rung fill order (= recency order) is preserved.
    expect(snap.snippets.map((s) => s.uri)).toEqual([
      'file:///edit-0.ts',
      'file:///edit-1.ts',
      'file:///edit-2.ts',
    ]);
  });
});

describe('CrossFileContextService — gather timeout (racePromise, 100ms)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a source that never resolves contributes [] after 100ms, without blocking a faster source', async () => {
    const hungSource: SnippetSource = { kind: 'recently-edited', gather: () => new Promise(() => {}) };
    const fastSource = spySource('recently-opened', [candidate({ uri: 'file:///fast.ts', kind: 'recently-opened' })]);
    const h = makeHarness({ sources: [hungSource, fastSource] });

    const pending = h.service.handleActiveEditorChange();
    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(h.ringBuffer.allScanned().map((s) => s.uri)).toEqual(['file:///fast.ts']);
  });
});

describe('CrossFileContextService — recordKeystroke debounced idle tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not gather immediately on a keystroke', () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source] });

    h.service.recordKeystroke();

    expect(source.gatherSpy).not.toHaveBeenCalled();
  });

  it('gathers once typing has been idle for the configured debounce', async () => {
    const source = spySource('recently-edited');
    const ringBuffer = new RingBuffer();
    let anchor: Anchor = { uri: 'file:///active.ts', line: 0 };
    const service = new CrossFileContextService({
      capabilities: capabilities(),
      template: template(),
      crossFileEnabled: true,
      prefixInjection: false,
      ringBuffer,
      sources: [source],
      getCurrentAnchor: () => anchor,
      getSkipUntrustedRemote: () => false,
      getEnabled: () => true,
      gatherIdleMs: 1500,
    });

    service.recordKeystroke();
    await vi.advanceTimersByTimeAsync(1499);
    expect(source.gatherSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(source.gatherSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the idle timer on each keystroke (no gather while still typing)', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source] });

    h.service.recordKeystroke();
    await vi.advanceTimersByTimeAsync(1000);
    h.service.recordKeystroke(); // resets the timer
    await vi.advanceTimersByTimeAsync(1000);

    expect(source.gatherSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(source.gatherSpy).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels a pending idle-tick timer', async () => {
    const source = spySource('recently-edited');
    const h = makeHarness({ sources: [source] });

    h.service.recordKeystroke();
    h.service.dispose();
    await vi.advanceTimersByTimeAsync(5000);

    expect(source.gatherSpy).not.toHaveBeenCalled();
  });
});

// ── gather-failure resilience (Opus reliability review, w5-t5 FIX PASS) ────
// A single `source.gather()` REJECTION must never permanently disable ALL
// future background gathering, must never discard a SIBLING source's
// results for the same cycle, and must never surface as a process-level
// unhandled rejection. `flushMicrotasks` mirrors the established pattern in
// `src/mcp/lsp/toolPipeline.test.ts`'s `withDeadline` unhandled-rejection
// regression test — repeated `await Promise.resolve()` to deterministically
// drain an already-scheduled promise chain, no real sleep involved.
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('CrossFileContextService — gather-failure resilience (reject-then-healthy)', () => {
  it(
    'a rejecting source does not short-circuit a healthy sibling, the chain survives ' +
      'subsequent triggers, and no unhandled rejection reaches the process',
    async () => {
      const rejectingGather = vi.fn().mockRejectedValue(new Error('source boom'));
      const rejectingSource: SnippetSource = { kind: 'recently-edited', gather: rejectingGather };
      const healthySource = spySource('recently-opened', [
        candidate({ uri: 'file:///healthy.ts', kind: 'recently-opened' }),
      ]);
      const h = makeHarness({ sources: [rejectingSource, healthySource] });

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        // Fire-and-forget, exactly like the real `.vscode.ts` call sites
        // (`void this.triggerGather()` / `handleSave` with no `.catch`
        // attached by the caller) — if a source's rejection ever reaches
        // this returned promise, it becomes a genuine process-level
        // unhandled rejection, exactly as Opus's probe found.
        void h.service.handleActiveEditorChange(); // cycle 1
        await flushMicrotasks();

        void h.service.handleTabsChanged(); // cycle 2
        await flushMicrotasks();

        void h.service.handleTabsChanged(); // cycle 3
        await flushMicrotasks();
        // A real event-loop tick — Node's unhandledRejection detection fires
        // on a later macrotask, not merely after more microtasks.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }

      // (a) the healthy source's candidates still reached the ring on cycle
      // 1 — one rejecting source must not discard the OTHER sources'
      // results for that cycle (no Promise.all short-circuit).
      expect(h.ringBuffer.allScanned().map((s) => s.uri)).toContain('file:///healthy.ts');

      // (b) the chain survived — SUBSEQUENT triggers still ran a real
      // gather cycle each time (not silently skipped because a prior
      // cycle's promise stayed rejected forever).
      expect(healthySource.gatherSpy).toHaveBeenCalledTimes(3);
      expect(rejectingGather).toHaveBeenCalledTimes(3);

      // (c) no unhandled promise rejection reached the process.
      expect(unhandled).toEqual([]);
    },
  );

  it('an awaited gather trigger resolves (never rejects) even when the ONLY source rejects', async () => {
    const rejectingSource: SnippetSource = {
      kind: 'recently-edited',
      gather: vi.fn().mockRejectedValue(new Error('only source boom')),
    };
    const h = makeHarness({ sources: [rejectingSource] });

    await expect(h.service.handleActiveEditorChange()).resolves.toBeUndefined();
    // The failed cycle contributes nothing — fails toward LESS context, not
    // an exception. The ring simply stays empty for this cycle.
    expect(h.ringBuffer.allScanned()).toEqual([]);
  });

  it('reports a rejecting source to the injected logger (diagnostics only — swallow still happens without one)', async () => {
    const rejectingSource: SnippetSource = {
      kind: 'recently-edited',
      gather: vi.fn().mockRejectedValue(new Error('logged boom')),
    };
    const appended: string[] = [];
    const ringBuffer = new RingBuffer();
    const anchor: Anchor = { uri: 'file:///active.ts', line: 0 };
    const service = new CrossFileContextService({
      capabilities: capabilities(),
      template: template(),
      crossFileEnabled: true,
      prefixInjection: false,
      ringBuffer,
      sources: [rejectingSource],
      getCurrentAnchor: () => anchor,
      getSkipUntrustedRemote: () => false,
      getEnabled: () => true,
      logger: { append: (line: string) => appended.push(line) },
    });

    await service.handleActiveEditorChange();

    expect(appended).toHaveLength(1);
    expect(appended[0]).toContain('recently-edited');
    expect(appended[0]).toContain('logged boom');
  });

  it('the outer try/catch resolves normally even when something OTHER than a source throws (e.g. ringBuffer.ingest)', async () => {
    // Forces a throw path that layer 1 (the per-source `.catch`) CANNOT
    // reach — every source here resolves cleanly, so this isolates layer 2
    // (runGatherCycle's own try/catch) as independently load-bearing, not
    // merely riding on layer 1 already having neutralized everything.
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source] });
    vi.spyOn(h.ringBuffer, 'ingest').mockImplementation(() => {
      throw new Error('ingest exploded');
    });

    await expect(h.service.handleActiveEditorChange()).resolves.toBeUndefined();
  });
});

describe('CrossFileContextService — getStatus', () => {
  it('reports the current mode and cached snippet count', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source] });

    expect(h.service.getStatus()).toEqual({ mode: 'input-extra', snippetCount: 0 });

    await h.service.handleActiveEditorChange();
    h.service.snapshotFor(DOC);

    expect(h.service.getStatus()).toEqual({ mode: 'input-extra', snippetCount: 1 });
  });
});

// ── warm-up wiring (W5-T7, §2.4) ────────────────────────────────────────────
// The optional llama.vim-style KV warm-up: fires ONLY when (flag on ∧
// egressPreconditionsMet ∧ backend.warmUp exists), on an ACTUAL regenerate,
// carrying the SAME already-scanned `snapshot.snippets` — never re-gathered,
// never active-file content. Default-off (`getWarmUpEnabled` omitted/false).
describe('CrossFileContextService — warm-up wiring (W5-T7)', () => {
  it('fires backend.warmUp with the regenerated snapshot snippets when flag on, egress met, and backend exposes warmUp', async () => {
    const warmUpSpy = vi.fn();
    const backend = fakeBackend({ warmUp: warmUpSpy });
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source], backend, getWarmUpEnabled: () => true });

    await h.service.handleActiveEditorChange();
    const snap = h.service.snapshotFor(DOC);

    expect(warmUpSpy).toHaveBeenCalledTimes(1);
    const [snippetsArg, signalArg] = warmUpSpy.mock.calls[0] as [unknown, AbortSignal];
    // SAME already-scanned array reference — proves warm-up reuses the
    // snapshot rather than re-gathering or touching active-file content.
    expect(snippetsArg).toBe(snap.snippets);
    expect(signalArg).toBeInstanceOf(AbortSignal);
    expect(signalArg.aborted).toBe(false);
  });

  it('does NOT fire when the warm-up flag is off (the default) even though egress is met and backend has warmUp', async () => {
    const warmUpSpy = vi.fn();
    const backend = fakeBackend({ warmUp: warmUpSpy });
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    // getWarmUpEnabled omitted entirely — exercises the real production
    // default (config key defaults to false; deps field is optional too).
    const h = makeHarness({ sources: [source], backend });

    await h.service.handleActiveEditorChange();
    h.service.snapshotFor(DOC);

    expect(warmUpSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when egressPreconditionsMet is false (skipUntrustedRemote), even with the flag on and backend.warmUp present', async () => {
    const warmUpSpy = vi.fn();
    const backend = fakeBackend({ warmUp: warmUpSpy });
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({
      sources: [source],
      backend,
      getWarmUpEnabled: () => true,
      getSkipUntrustedRemote: () => true,
    });

    await h.service.handleActiveEditorChange();
    h.service.snapshotFor(DOC);

    expect(warmUpSpy).not.toHaveBeenCalled();
  });

  it('does NOT throw when the backend has no warmUp method (safe no-op, e.g. a non-llamacpp backend)', async () => {
    const backend = fakeBackend(); // no `warmUp` override — matches Ollama/Codestral/etc.
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source], backend, getWarmUpEnabled: () => true });

    await expect(h.service.handleActiveEditorChange()).resolves.toBeUndefined();
    expect(() => h.service.snapshotFor(DOC)).not.toThrow();
  });

  it('does NOT fire when no backend was supplied at all', async () => {
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source], getWarmUpEnabled: () => true }); // no `backend`

    await expect(h.service.handleActiveEditorChange()).resolves.toBeUndefined();
    expect(() => h.service.snapshotFor(DOC)).not.toThrow();
  });

  it('fires only once per actual regenerate — a burst of "reuse" snapshotFor calls does not re-fire warm-up', async () => {
    const warmUpSpy = vi.fn();
    const backend = fakeBackend({ warmUp: warmUpSpy });
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source], backend, getWarmUpEnabled: () => true });

    await h.service.handleActiveEditorChange(); // boundary + first ingest -> regenerate
    h.service.snapshotFor(DOC);
    h.service.snapshotFor(DOC); // reuse
    h.service.snapshotFor(DOC); // reuse

    expect(warmUpSpy).toHaveBeenCalledTimes(1);
  });

  it('reconfigure() picks up a NEW backend reference for subsequent warm-ups (backend switch)', async () => {
    const staleWarmUpSpy = vi.fn();
    const freshWarmUpSpy = vi.fn();
    const staleBackend = fakeBackend({ warmUp: staleWarmUpSpy });
    const freshBackend = fakeBackend({ warmUp: freshWarmUpSpy });
    const source = spySource('recently-edited', [candidate({ uri: 'file:///a.ts' })]);
    const h = makeHarness({ sources: [source], backend: staleBackend, getWarmUpEnabled: () => true });

    h.service.reconfigure({
      capabilities: capabilities(),
      template: template(),
      crossFileEnabled: true,
      prefixInjection: false,
      backend: freshBackend,
    });

    await h.service.handleActiveEditorChange();
    h.service.snapshotFor(DOC);

    expect(staleWarmUpSpy).not.toHaveBeenCalled();
    expect(freshWarmUpSpy).toHaveBeenCalledTimes(1);
  });
});

// Sanity: confirm the scanner mock doesn't mask a real reject-path bug —
// exercise it directly once so a broken mock setup fails loudly here rather
// than silently passing every quarantine test above.
describe('secretScanner mock sanity', () => {
  it('the real scanner rejects the AKIA fixture used above', () => {
    expect(scanSnippetForSecrets({ path: 'secrets.ts', content: 'const key = "AKIAABCDEFGHIJKLMNOP";' }).allowed).toBe(
      false,
    );
  });
});
