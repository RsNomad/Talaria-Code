import { describe, it, expect } from 'vitest';
import { reduceNextEdit } from './fsm';
import type { AnchoredProposal, EditableRegion, NextEditFsmEvent, NextEditFsmState, NextEditEffect } from './types';

const REGION: EditableRegion = { uri: 'file:///a.ts', filepath: 'a.ts', startLine: 40, endLine: 60, content: 'stuff' };
const P: AnchoredProposal = { region: REGION, newText: 'x\n', docVersion: 1, cursorLine: 50 };
const P2: AnchoredProposal = { region: { ...REGION }, newText: 'y\n', docVersion: 2, cursorLine: 51 };
const REMAPPED = { startLine: 41, endLine: 61 };

const ALL_STATES: NextEditFsmState[] = [
  { kind: 'idle' }, { kind: 'proposed', p: P }, { kind: 'jumped', p: P },
];

const CLEARING: NextEditFsmEvent[] = [
  { kind: 'focusLost' }, { kind: 'editorChanged' },
  { kind: 'docChanged', remapped: null }, { kind: 'fimVisibility', visible: true },
];

it('THEOREM: ∀ state × clearing-event ⇒ idle and effects contain clearAll', () => {
  for (const s of ALL_STATES) for (const e of CLEARING) {
    const { state, effects } = reduceNextEdit(s, e);
    expect(state.kind, `${s.kind} × ${e.kind}`).toBe('idle');
    expect(effects.some((f) => f.kind === 'clearAll'), `${s.kind} × ${e.kind}`).toBe(true);
  }
});

it('the two-step Tab: proposed→jumped(reveal), jumped→idle(applyEdit)', () => {
  const jump = reduceNextEdit({ kind: 'proposed', p: P }, { kind: 'tabJump' });
  expect(jump.state).toEqual({ kind: 'jumped', p: P });
  expect(jump.effects).toEqual([
    { kind: 'setContext', key: 'hermes.nextEdit.jumped', value: true },
    { kind: 'reveal', range: { startLine: 40, endLine: 60 } },
  ]);

  const accept = reduceNextEdit({ kind: 'jumped', p: P }, { kind: 'tabAccept' });
  expect(accept.state).toEqual({ kind: 'idle' });
  expect(accept.effects).toEqual([
    { kind: 'applyEdit', region: REGION, newText: 'x\n' },
    { kind: 'clearAll' },
  ]);
});

it('idle × proposalReady ⇒ proposed, setContext(jumpVisible,true) + showDecorations', () => {
  const { state, effects } = reduceNextEdit({ kind: 'idle' }, { kind: 'proposalReady', p: P });
  expect(state).toEqual({ kind: 'proposed', p: P });
  expect(effects).toEqual([
    { kind: 'setContext', key: 'hermes.nextEdit.jumpVisible', value: true },
    { kind: 'showDecorations', p: P },
  ]);
});

it('applyResult(false) ⇒ idle + clearAll + noteOnce, from every state', () => {
  for (const s of ALL_STATES) {
    const { state, effects } = reduceNextEdit(s, { kind: 'applyResult', ok: false });
    expect(state, s.kind).toEqual({ kind: 'idle' });
    expect(effects, s.kind).toEqual([{ kind: 'clearAll' }, { kind: 'noteOnce', msgId: 'apply-failed' }]);
  }
});

it('idle × applyResult(true) ⇒ idle, no effects', () => {
  const { state, effects } = reduceNextEdit({ kind: 'idle' }, { kind: 'applyResult', ok: true });
  expect(state).toEqual({ kind: 'idle' });
  expect(effects).toEqual([]);
});

it('unmodeled: tabAccept in idle ⇒ idle + clearAll (safe default)', () => {
  const { state, effects } = reduceNextEdit({ kind: 'idle' }, { kind: 'tabAccept' });
  expect(state).toEqual({ kind: 'idle' });
  expect(effects).toEqual([{ kind: 'clearAll' }]);
});

it('unmodeled: tabJump in idle and jumped ⇒ idle + clearAll (safe default)', () => {
  for (const s of [{ kind: 'idle' } as const, { kind: 'jumped', p: P } as const]) {
    const { state, effects } = reduceNextEdit(s, { kind: 'tabJump' });
    expect(state, s.kind).toEqual({ kind: 'idle' });
    expect(effects, s.kind).toEqual([{ kind: 'clearAll' }]);
  }
});

it('unmodeled: proposalReady while proposed/jumped ⇒ idle + clearAll (safe default, no silent overwrite)', () => {
  for (const s of [{ kind: 'proposed', p: P } as const, { kind: 'jumped', p: P } as const]) {
    const { state, effects } = reduceNextEdit(s, { kind: 'proposalReady', p: P2 });
    expect(state, s.kind).toEqual({ kind: 'idle' });
    expect(effects, s.kind).toEqual([{ kind: 'clearAll' }]);
  }
});

it('fimVisibility(false) never disturbs a live proposal: proposed/jumped stay put, zero effects', () => {
  for (const s of [{ kind: 'proposed', p: P } as const, { kind: 'jumped', p: P } as const]) {
    const { state, effects } = reduceNextEdit(s, { kind: 'fimVisibility', visible: false });
    expect(state, s.kind).toEqual(s);
    expect(effects, s.kind).toEqual([]);
  }
});

it('fimVisibility(false) in idle: idle, zero effects', () => {
  const { state, effects } = reduceNextEdit({ kind: 'idle' }, { kind: 'fimVisibility', visible: false });
  expect(state).toEqual({ kind: 'idle' });
  expect(effects).toEqual([]);
});

it('esc from proposed/jumped ⇒ idle + clearAll only', () => {
  for (const s of [{ kind: 'proposed', p: P } as const, { kind: 'jumped', p: P } as const]) {
    const { state, effects } = reduceNextEdit(s, { kind: 'esc' });
    expect(state, s.kind).toEqual({ kind: 'idle' });
    expect(effects, s.kind).toEqual([{ kind: 'clearAll' }]);
  }
});

it('docChanged with a successful remap keeps the state and re-anchors the proposal (proposed and jumped)', () => {
  for (const kind of ['proposed', 'jumped'] as const) {
    const s: NextEditFsmState = { kind, p: P };
    const { state, effects } = reduceNextEdit(s, { kind: 'docChanged', remapped: REMAPPED });
    const reanchored: AnchoredProposal = {
      region: { uri: REGION.uri, filepath: REGION.filepath, startLine: 41, endLine: 61, content: REGION.content },
      newText: P.newText,
      docVersion: P.docVersion,
      cursorLine: P.cursorLine,
    };
    expect(state, kind).toEqual({ kind, p: reanchored });
    expect(effects, kind).toEqual([{ kind: 'showDecorations', p: reanchored }]);
  }
});

it('docChanged(non-null) in idle is unmodeled ⇒ idle + clearAll (safe default)', () => {
  const { state, effects } = reduceNextEdit({ kind: 'idle' }, { kind: 'docChanged', remapped: REMAPPED });
  expect(state).toEqual({ kind: 'idle' });
  expect(effects).toEqual([{ kind: 'clearAll' }]);
});

// ---------------------------------------------------------------------------
// THE cross-product theorem: EVERY (state × event) pair, programmatically
// enumerated (3 states × 12 concrete event instances = 36 pairs — not a
// hand-picked sample), proving the design's replacement for the deleted
// wall-clock timeout: the context-key ⟺ decorations invariant. A tiny "world"
// model applies the returned effects the same way the shell would, then
// asserts the UI is NEVER left half-shown: either both the jumpVisible key
// and the decorations are up (proposed/jumped) or both are down (idle).
// ---------------------------------------------------------------------------
interface World { jumpVisible: boolean; jumped: boolean; decorationsShown: boolean }

function worldFor(s: NextEditFsmState): World {
  return s.kind === 'idle'
    ? { jumpVisible: false, jumped: false, decorationsShown: false }
    : { jumpVisible: true, jumped: s.kind === 'jumped', decorationsShown: true };
}

function applyEffects(w: World, effects: readonly NextEditEffect[]): World {
  let jumpVisible = w.jumpVisible;
  let jumped = w.jumped;
  let decorationsShown = w.decorationsShown;
  for (const f of effects) {
    if (f.kind === 'setContext') {
      if (f.key === 'hermes.nextEdit.jumpVisible') jumpVisible = f.value;
      else jumped = f.value;
    } else if (f.kind === 'showDecorations') {
      decorationsShown = true;
    } else if (f.kind === 'clearAll') {
      jumpVisible = false;
      jumped = false;
      decorationsShown = false;
    }
    // reveal / applyEdit / noteOnce never touch visibility flags.
  }
  return { jumpVisible, jumped, decorationsShown };
}

const ALL_EVENTS: NextEditFsmEvent[] = [
  { kind: 'proposalReady', p: P2 },
  { kind: 'tabJump' },
  { kind: 'tabAccept' },
  { kind: 'esc' },
  { kind: 'docChanged', remapped: null },
  { kind: 'docChanged', remapped: REMAPPED },
  { kind: 'focusLost' },
  { kind: 'editorChanged' },
  { kind: 'fimVisibility', visible: true },
  { kind: 'fimVisibility', visible: false },
  { kind: 'applyResult', ok: true },
  { kind: 'applyResult', ok: false },
];

// ---------------------------------------------------------------------------
// Type-linked exhaustiveness guard for ALL_STATES / ALL_EVENTS.
//
// ALL_STATES and ALL_EVENTS above are hand-maintained plain arrays with no
// compile-time link to the NextEditFsmState / NextEditFsmEvent unions in
// ./types.ts. Without this guard, a future variant added to either union
// (e.g. wiring a new FSM event for T11-T16) that is *not* also added to the
// array here would silently narrow the theorem's coverage: `pairCount`
// below is derived from `ALL_EVENTS.length`/`ALL_STATES.length`, so it
// would keep reading the old number and the theorem would keep "passing"
// while quietly no longer exhausting the real state/event space.
//
// The two `Record<Kind, true>` witnesses below close that hole at
// compile time: TypeScript requires every member of `NextEditFsmState['kind']`
// / `NextEditFsmEvent['kind']` to be a key, so adding a union variant
// without listing its `kind` here is a `tsc` ERROR (not a silently-passing
// test) — see fsm.test.ts RED-proof notes. The `it(...)` blocks right below
// them are the runtime half: they confirm ALL_STATES/ALL_EVENTS actually
// *contain* an instance of every kind the witnesses claim, so the witness
// object can't itself drift out of sync with the array the theorem walks.
//
// We keep `pairCount === 36` as a plain literal rather than deriving it
// from the witnesses: pairCount counts array *entries* (12 event instances,
// several kinds like `docChanged`/`fimVisibility`/`applyResult` contribute
// 2 entries each for their boolean/nullable payload), while the witnesses
// count distinct *kinds* (9) — the two numbers measure different things,
// so deriving one from the other would be misleading, not safer. Instead
// the literal pin and the kind-coverage assertions below are independent
// checks that must BOTH hold; a drift that fooled one (e.g. a new kind
// added with its `ALL_EVENTS` entries, keeping length semantics murky) is
// still caught by the other.
type StateKind = NextEditFsmState['kind'];
type EventKind = NextEditFsmEvent['kind'];

const STATE_KIND_WITNESS: Record<StateKind, true> = {
  idle: true,
  proposed: true,
  jumped: true,
};

const EVENT_KIND_WITNESS: Record<EventKind, true> = {
  proposalReady: true,
  tabJump: true,
  tabAccept: true,
  esc: true,
  docChanged: true,
  focusLost: true,
  editorChanged: true,
  fimVisibility: true,
  applyResult: true,
};

it('ALL_STATES contains an instance of every NextEditFsmState kind (type-linked)', () => {
  const kindsInArray = new Set(ALL_STATES.map((s) => s.kind));
  const kindsInWitness = Object.keys(STATE_KIND_WITNESS).sort();
  expect([...kindsInArray].sort(), 'ALL_STATES is missing a kind present in NextEditFsmState').toEqual(kindsInWitness);
});

it('ALL_EVENTS contains an instance of every NextEditFsmEvent kind (type-linked)', () => {
  const kindsInArray = new Set(ALL_EVENTS.map((e) => e.kind));
  const kindsInWitness = Object.keys(EVENT_KIND_WITNESS).sort();
  expect([...kindsInArray].sort(), 'ALL_EVENTS is missing a kind present in NextEditFsmEvent').toEqual(kindsInWitness);
});

describe('THEOREM: the FSM can never leave the UI half-shown, over the full (state × event) cross product', () => {
  const pairCount = ALL_STATES.length * ALL_EVENTS.length;

  it(`covers ${pairCount} programmatically-enumerated pairs (3 states × 12 events)`, () => {
    expect(pairCount).toBe(36);
  });

  for (const s of ALL_STATES) {
    for (const e of ALL_EVENTS) {
      it(`${s.kind} × ${JSON.stringify(e)} ⇒ key/decorations never half`, () => {
        const before = worldFor(s);
        const { state, effects } = reduceNextEdit(s, e);
        const after = applyEffects(before, effects);

        // never half: the jumpVisible key and the decorations agree.
        expect(after.jumpVisible).toBe(after.decorationsShown);

        if (state.kind === 'idle') {
          expect(after.jumpVisible).toBe(false);
          expect(after.decorationsShown).toBe(false);
        } else {
          expect(after.jumpVisible).toBe(true);
          expect(after.decorationsShown).toBe(true);
        }
      });
    }
  }
});
