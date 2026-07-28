/**
 * DOM-level tests for the Settings panel (W5.2, ADR-015).
 *
 * Scope discipline: these assert WIRING — that a decision reaches the screen,
 * that an interaction reaches a handler, that an attribute reaches an element.
 * Assertions about DECISIONS live in the pure tests and stay there.
 * `SettingsPanel.test.ts`'s character-for-character copy locks are STRONGER
 * than a rendered-text equivalent (rendered text is whitespace-normalised) and
 * must not be moved here. See `docs/testing/dom-tests.md`.
 */
import { describe, it, expect } from 'vitest';
import { Profiler, type ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NextEditToggleSource, NextEditToggleState } from '../protocol';
import { Toggle } from '../components/Toggle';
import { SettingsPanel, NEXT_EDIT_SECTION_LABEL, NEXT_EDIT_ROWS } from './SettingsPanel';
import type { FieldValue } from './settingsField';
import { must } from '../testing/must';

// NEXT_EDIT_ROWS is a fixed two-row array (`SettingsPanel.test.ts` pins its
// exact contents); named once here instead of repeating `NEXT_EDIT_ROWS[0]`/
// `[1]` (each now `Row | undefined` under noUncheckedIndexedAccess) at every
// call site below.
const NEXT_ROW = must(NEXT_EDIT_ROWS[0]);
const GENERIC_ROW = must(NEXT_EDIT_ROWS[1]);

/** Documented shape: invoke `userEvent.setup()` BEFORE rendering, and use the
 *  returned instance rather than the direct API. */
export function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

const noopAsync = async () => undefined;

function renderPanel(config: Parameters<typeof SettingsPanel>[0]['config']) {
  return setup(
    <SettingsPanel
      config={config}
      onRetryConfig={() => undefined}
      onSetConfig={noopAsync}
      nextEdit={{ next: false, generic: false }}
      onToggleNextEdit={noopAsync}
    />,
  );
}

describe('F-7 regression lock: the Next Edit toggles survive every backend state', () => {
  // The toggles are extension globalState served host-internally. They need no
  // agent at all — which is the whole point: a Hermes CLI that fails to start
  // must not leave the user unable to turn Generic OFF, and by design these are
  // not `settings.json` settings either.
  //
  // `RemoteData<T>`'s actual discriminant is `status` (`webview/src/state/remoteData.ts`),
  // not `kind` — adjusted from the brief's draft accordingly. The error member's
  // payload is `error: RemoteError` (`{ message, retryable }`), not a bare `message`.
  const states = [
    { name: 'loading', config: { status: 'loading' } as const },
    {
      name: 'error',
      config: { status: 'error', error: { message: 'hermes acp failed to start', retryable: true } } as const,
    },
    { name: 'undefined (never requested)', config: undefined },
  ];

  for (const { name, config } of states) {
    it(`renders the section and both rows, ACTIONABLE, while config is ${name}`, () => {
      renderPanel(config);

      expect(screen.getByText(NEXT_EDIT_SECTION_LABEL)).toBeInTheDocument();

      for (const row of NEXT_EDIT_ROWS) {
        const control = screen.getByRole('switch', { name: row.label });
        expect(control).toBeInTheDocument();
        // ACTIONABLE, not merely present: a disabled control would be exactly
        // the unrecoverable state F-7 was.
        expect(
          control,
          `F-7: the "${row.label}" switch must remain operable when the agent is ${name}`,
        ).toBeEnabled();
        expect(control).toHaveAttribute('aria-checked', 'false');
      }
    });
  }

  it('reflects the ratified state it is given, in every backend state', () => {
    setup(
      <SettingsPanel
        config={{ status: 'error', error: { message: 'backend down', retryable: true } }}
        onRetryConfig={() => undefined}
        onSetConfig={noopAsync}
        nextEdit={{ next: true, generic: false }}
        onToggleNextEdit={noopAsync}
      />,
    );
    expect(screen.getByRole('switch', { name: NEXT_ROW.label })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: GENERIC_ROW.label })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

/**
 * The R5 panel with the config half parked in a non-success state. The Next
 * Edit rows render in EVERY backend state (F-7, locked above), so parking the
 * config half keeps each reconcile case down to the one variable it is about.
 *
 * `RemoteData`'s discriminant is `status` with an `error: RemoteError` payload
 * — the `{ kind, message }` shape in the task brief's draft does not exist.
 */
function nextEditPanel(
  nextEdit: NextEditToggleState,
  onToggleNextEdit: (source: NextEditToggleSource, on: boolean) => Promise<unknown>,
) {
  return (
    <SettingsPanel
      config={{ status: 'error', error: { message: 'backend down', retryable: true } }}
      onRetryConfig={() => undefined}
      onSetConfig={noopAsync}
      nextEdit={nextEdit}
      onToggleNextEdit={onToggleNextEdit}
    />
  );
}

/** A request that is issued and never answered — the only honest model of "the
 *  user's edit is STILL IN FLIGHT at the instant the host push lands". Resolving
 *  it would settle the row through confirm/rollback and destroy the race. */
const neverSettles = () => new Promise<unknown>(() => undefined);

describe('the render-time prop-wins reconcile — a HOST push overrides local row state', () => {
  // This is the code a reviewer deleted outright with 370/370 still green: no
  // test rendered anything, so nothing noticed. The value of this block is its
  // RED proof under deletion, not its GREEN — if it passes with
  // `SettingsPanel.tsx`'s `reconciled` lines removed, it is testing something
  // else and must be rewritten.
  //
  // Both reconcile call sites are covered: `NextEditRow` (:223-224, via
  // `reconcileNextEditRowState`) and `FieldRow` (:124-125, via
  // `reconcileFieldEditState`). Deleting EITHER must turn this block red.

  it('a new `nextEdit` prop wins over the row state left by a previous render', async () => {
    // The baseline case: no local edit at all, so the ONLY thing that can move
    // the switch is the reconcile. `useState`'s initializer runs once and the
    // row's `key` is stable, so without the reconcile the row is frozen at its
    // mount-time value forever.
    const { rerender } = setup(nextEditPanel({ next: false, generic: false }, noopAsync));

    const nextSwitch = () => screen.getByRole('switch', { name: NEXT_ROW.label });
    expect(nextSwitch()).toHaveAttribute('aria-checked', 'false');

    // The host push: another window (or this one's Guard) ratified NEXT on.
    rerender(nextEditPanel({ next: true, generic: false }, noopAsync));

    expect(
      nextSwitch(),
      'prop-wins reconcile: a host push must be authoritative over whatever row state the previous ' +
        'render left behind — without it the switch keeps showing the stale local value',
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('a host push wins over a local edit that is STILL IN FLIGHT — the actual race', async () => {
    // THE RACE, built explicitly. The test above proves the reconcile runs; this
    // one proves it WINS against a live competitor, which is the property the
    // production comment actually claims.
    //
    // It has to be driven through the OTHER row's `otherOn`, and that is a
    // structural fact, not a stylistic choice: an optimistic local edit always
    // sets `displayValue` to `!lastPropValue`, and this row's own `on` can only
    // reconcile when it too has moved to `!lastPropValue` — so on `aria-checked`
    // specifically, the local edit and the push AGREE by construction on the
    // own-value axis and no assertion there could ever tell them apart. (Fix
    // wave Finding 2: `aria-busy` DOES still differ on the own-value axis —
    // reconcile clears `pending`, its absence leaves it set — this test just
    // isn't the one checking that.) The cross-toggle axis is the only one on
    // which a stale `aria-checked` value is observable at all.
    const { user, rerender } = setup(nextEditPanel({ next: true, generic: false }, neverSettles));

    const genericSwitch = () => screen.getByRole('switch', { name: GENERIC_ROW.label });

    // Turn Generic on while NEXT is on. The Guard will refuse this (the two
    // sources are mutually exclusive) but has not answered yet.
    await user.click(genericSwitch());

    // PROOF THE RACE EXISTS. `aria-busy` is the row's own `pending` flag, which
    // is true ONLY between `editFieldLocally` and confirm/rollback — so these
    // two assertions are the state machine testifying that a local edit really
    // is outstanding at this instant. Without them "the push wins" would be
    // vacuously true against a row that had nothing to win against.
    expect(
      genericSwitch(),
      'fixture integrity: the optimistic local edit must be on screen, or there is no race to test',
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      genericSwitch(),
      'fixture integrity: the toggle request must still be IN FLIGHT when the push lands, or this ' +
        'test is not exercising the race it claims to',
    ).toHaveAttribute('aria-busy', 'true');

    // The host push lands mid-flight: NEXT went off in another window. Generic's
    // own `on` prop does NOT move (it is still false) — only `otherOn` does.
    rerender(nextEditPanel({ next: false, generic: false }, neverSettles));

    expect(
      genericSwitch(),
      'prop-wins reconcile: a host push must beat an in-flight local edit — without it the row keeps ' +
        'displaying the unratified optimistic value and lies about what is actually persisted',
    ).toHaveAttribute('aria-checked', 'false');
    expect(
      genericSwitch(),
      'prop-wins reconcile: the push IS the answer, so the row must leave its in-flight state — without ' +
        'it the row spins on "Saving…" forever waiting for a reply that already arrived by another route',
    ).not.toHaveAttribute('aria-busy');
  });

  it('a host push CLEARS a rolled-back refusal error on the same row', async () => {
    const refuse = () =>
      Promise.reject(
        new Error(
          'Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.',
        ),
      );
    const { user, rerender } = setup(nextEditPanel({ next: true, generic: false }, refuse));

    await user.click(screen.getByRole('switch', { name: GENERIC_ROW.label }));
    // Lower-case "mutually exclusive" appears only in the refusal; both row
    // DESCRIPTIONS say "Mutually exclusive with …", and the match is
    // case-sensitive, so this cannot accidentally match the static prose.
    expect(await screen.findByText(/mutually exclusive/)).toBeInTheDocument();

    // The host then pushes a state in which the refusal no longer applies.
    rerender(nextEditPanel({ next: false, generic: false }, refuse));

    expect(
      screen.queryByText(/mutually exclusive/),
      'prop-wins reconcile: a host push must clear a stale refusal, not leave the user staring at an ' +
        'error about a state that no longer exists',
    ).toBeNull();
  });

  it('the FieldRow copy of the reconcile also lets a host push beat a rolled-back local edit', async () => {
    // Task 6 Step 4 asked whether `FieldRow`'s copy at :124-125 is protected.
    // It was not — nothing in the DOM project rendered a config row at all
    // (every case above parks `config` in a non-success state, so `RemotePanel`
    // never reaches `children`). Rather than record that as a permanent known
    // gap, this closes it: same reconcile, same defect class, its own RED proof.
    //
    // A ROLLED-BACK edit is what makes the two outcomes distinguishable here,
    // on `aria-checked` and the inline "Not saved" text. `FieldRow` has no
    // `otherOn` axis, so on `aria-checked` specifically an in-flight edit would
    // agree with the push by construction (see the race test above) — though
    // Fix wave Finding 2: `aria-busy` would still differ (reconcile clears
    // `pending`, its absence leaves it set); this test isn't checking that.
    // After a rollback the display is pinned back to `lastPropValue`, so a
    // push that moves the prop is genuinely visible on `aria-checked` too.
    const FIELD_KEY = 'autocomplete.enabled';
    const rejectSet = (_key: string, _value: FieldValue) =>
      Promise.reject(new Error('config.set refused: read-only workspace'));

    const configPanel = (fieldValue: boolean) => (
      <SettingsPanel
        config={{
          status: 'success',
          data: {
            sections: [
              { name: 'autocomplete', fields: [{ key: FIELD_KEY, value: fieldValue, type: 'boolean' }] },
            ],
          },
        }}
        onRetryConfig={() => undefined}
        onSetConfig={rejectSet}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={noopAsync}
      />
    );

    const { user, rerender } = setup(configPanel(false));
    const fieldSwitch = () => screen.getByRole('switch', { name: FIELD_KEY });

    // Local edit → refused → rolled back to `false`, with the reason inline.
    await user.click(fieldSwitch());
    expect(await screen.findByText(/read-only workspace/)).toBeInTheDocument();
    expect(
      fieldSwitch(),
      'fixture integrity: the refused edit must have rolled the row back to the old value, or the push ' +
        'below has nothing stale to overwrite',
    ).toHaveAttribute('aria-checked', 'false');

    // The host pushes the field ON anyway — another editor set it.
    rerender(configPanel(true));

    expect(
      fieldSwitch(),
      'prop-wins reconcile (FieldRow): a host push must be authoritative over a rolled-back local edit ' +
        '— without it the config row shows a stale value and calls it persisted',
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.queryByText(/read-only workspace/),
      'prop-wins reconcile (FieldRow): the push must clear the stale "Not saved" reason along with the ' +
        'stale value',
    ).toBeNull();
  });

  it('fix wave Finding 1: the reconcile runs during the SAME commit as the host push, not a second one', () => {
    // The eight tests above lock that the reconcile EXISTS (they go RED if
    // it is deleted) but not that it runs at RENDER TIME rather than in a
    // `useEffect` — a reviewer moved `SettingsPanel.tsx:223-224` verbatim
    // into `useEffect([on, otherOn])` and all eight stayed green, because
    // RTL's `rerender` is `act`-wrapped: the Effect's extra pass flushes
    // before any assertion runs, so a plain `aria-checked`/`aria-busy` check
    // cannot see it.
    //
    // The defect IS an extra commit, so this asserts that directly instead
    // of proxying through the word `useEffect`. React's own guidance
    // (react.dev, "You Might Not Need an Effect" -> "Adjusting some state
    // when a prop changes") is that adjusting state DURING render lets React
    // "re-render immediately" and "throw away the returned JSX" before
    // committing, so a host push lands in ONE commit with the reconciled
    // value already in it and nothing stale ever paints. Moving the same
    // line into an Effect instead commits the STALE value first (that is
    // the frame `SettingsPanel.tsx:117-123`'s comment says this design
    // exists to avoid), then the Effect's own `setState` schedules a
    // second, separate commit once it reconciles. React's `<Profiler
    // onRender>` fires exactly once per commit — not once per
    // function-component invocation, confirmed against react.dev's
    // Profiler reference — so counting its calls across one host push
    // measures commits directly.
    //
    // Baseline measured against the actual (unmutated) code: mount is 1
    // commit, and the push below is also exactly 1 commit — reset the
    // counter after mount so only the push is asserted. Replayed against
    // the reviewer's exact mutation (reconcile moved verbatim into
    // `useEffect([on, otherOn])`), the same push produces 2 commits while
    // all eight tests above stayed green, reproducing the reviewer's
    // finding and confirming this assertion is the one that catches it.
    let commits = 0;
    const onRender = () => {
      commits += 1;
    };

    const { rerender } = setup(
      <Profiler id="next-edit-row-reconcile" onRender={onRender}>
        {nextEditPanel({ next: false, generic: false }, noopAsync)}
      </Profiler>,
    );
    commits = 0; // only the push below is under test, not mount's own commit

    rerender(
      <Profiler id="next-edit-row-reconcile" onRender={onRender}>
        {nextEditPanel({ next: true, generic: false }, noopAsync)}
      </Profiler>,
    );

    expect(
      commits,
      'render-time reconcile: a host push must land in exactly ONE commit — a second commit means the ' +
        'reconcile ran in an Effect, and the first of the two commits is the stale frame the render-time ' +
        'design exists to avoid painting',
    ).toBe(1);
  });
});

/*
 * Task 7 — three DOM locks for defects that ALREADY SHIPPED FIXED:
 *
 * F-8 (focus retention): `Toggle` distinguishes `busy` (stays focusable —
 * `aria-disabled` + `aria-busy`, click-guarded) from genuine `disabled`
 * (native attribute). The bug this guards: the toggle used to go natively
 * `disabled` mid-request, so a keyboard user who pressed Space was blurred to
 * `<body>` and had to tab through the whole panel again to retry a refused
 * toggle.
 *
 * The ARIA surface: `Toggle`'s own `aria-label` must win accessible-name
 * computation (SettingsPanel.tsx:242-244's comment), and the row's
 * `role="status"` region (Finding 7) must stay mounted unconditionally —
 * only its text changes — because a region that mounts together with its
 * own content is the known-unreliable screen-reader announcement pattern.
 *
 * U-2 (row click target): the row's `<label>` wraps the title only
 * (`htmlFor`/`id`), not the ~3 lines of descriptive prose a user would
 * click-and-drag to copy — SettingsPanel.tsx:245 / Toggle.tsx:34-44.
 *
 * `config` below uses `RemoteData`'s real discriminant (`status`/`error`),
 * matching `nextEditPanel` above — not the `{ kind, message }` shape in the
 * task brief's draft, which does not exist on `SettingsPanelProps['config']`
 * and would fail `webview typecheck`.
 */

describe('F-8: the toggle keeps keyboard focus across the request round trip', () => {
  it('the switch still has focus after a REFUSED toggle settles', async () => {
    let reject: (e: Error) => void = () => undefined;
    const pending = () => new Promise<never>((_, r) => { reject = r; });

    const { user } = setup(
      <SettingsPanel
        config={{ status: 'error', error: { message: 'backend down', retryable: true } }}
        onRetryConfig={() => undefined}
        onSetConfig={noopAsync}
        nextEdit={{ next: true, generic: false }}
        onToggleNextEdit={pending}
      />,
    );

    const generic = screen.getByRole('switch', { name: GENERIC_ROW.label });
    // Fixture integrity: prove the click is what moves focus, not an
    // accident of jsdom's default active element — otherwise the
    // `toHaveFocus()` checks below could pass trivially.
    expect(
      generic,
      'fixture integrity: the switch must not already have focus before the click, or the focus ' +
        'assertions below prove nothing about the click actually moving it there',
    ).not.toHaveFocus();

    await user.click(generic);
    expect(generic, 'F-8: an in-flight control must stay focusable — never natively disabled').toHaveFocus();
    expect(generic).toHaveAttribute('aria-busy', 'true');
    expect(generic).not.toBeDisabled();

    reject(new Error('Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.'));
    expect(await screen.findByText(/mutually exclusive/)).toBeInTheDocument();

    expect(
      generic,
      'F-8: after the response lands, focus must still be on the control the user never meant to leave — ' +
        'retrying a refused toggle must not mean tabbing through the whole panel again',
    ).toHaveFocus();
  });
});

describe('the ARIA surface reaches the DOM', () => {
  it("the switch's accessible name IS its aria-label, not the surrounding prose", () => {
    renderPanel({ status: 'error', error: { message: 'backend down', retryable: true } });
    // The source comment in SettingsPanel.tsx asserts that Toggle's own
    // aria-label wins accessible-name computation. Until now that was an
    // UNVERIFIED assertion about the DOM. This query is the lock.
    for (const row of NEXT_EDIT_ROWS) {
      expect(screen.getByRole('switch', { name: row.label })).toBeInTheDocument();
    }

    // The two queries above cannot, on their own, prove aria-label WINS:
    // `NextEditRow`'s `<label htmlFor>` carries the exact same text as the
    // `aria-label` it passes to `Toggle` (both are the same `label`
    // variable), so removing `aria-label` leaves the computed accessible
    // name unchanged here — the label-association fallback happens to
    // supply an identical string. Confirmed by planting exactly that
    // mutation (deleting `aria-label={label}` from Toggle.tsx) and watching
    // this block stay GREEN regardless. Mounting `Toggle` directly with an
    // aria-label that DIFFERS from a surrounding `<label>` is the only way
    // to make SettingsPanel.tsx's actual claim — "an explicit aria-label
    // wins accessible-name computation over an associated <label>'s text"
    // — falsifiable.
    render(
      <div>
        <label htmlFor="isolated-toggle">Surrounding label text</label>
        <Toggle id="isolated-toggle" on={false} label="Its own aria-label" />
      </div>,
    );
    expect(
      screen.getByRole('switch', { name: 'Its own aria-label' }),
      'the ARIA surface: an explicit aria-label must win accessible-name computation over an associated ' +
        "<label>'s own different text",
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Surrounding label text' }),
      'the ARIA surface: the associated <label>\'s own text must NOT become the accessible name while ' +
        'aria-label is present',
    ).toBeNull();
  });

  it('a refusal is announced through a role="status" live region', async () => {
    const refuse = () => Promise.reject(new Error('Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.'));
    const { user } = setup(
      <SettingsPanel
        config={{ status: 'error', error: { message: 'backend down', retryable: true } }}
        onRetryConfig={() => undefined}
        onSetConfig={noopAsync}
        nextEdit={{ next: true, generic: false }}
        onToggleNextEdit={refuse}
      />,
    );

    // Both NEXT_EDIT_ROWS render their own `role="status"` region
    // unconditionally (Finding 7), so an unscoped `getByRole('status')`
    // would match BOTH rows and throw "multiple elements" (verified: the
    // brief's literal unscoped query throws exactly this, even against the
    // correct, unmutated code) — scope to the row under test via its
    // switch's parent (Toggle's `<button>` is a direct JSX child of the
    // row's outer `<div>` in `NextEditRow`).
    const genericSwitch = screen.getByRole('switch', { name: GENERIC_ROW.label });
    const genericRow = genericSwitch.parentElement as HTMLElement;

    // Fix wave Finding 7: the region must exist BEFORE there is anything to
    // announce — a region only CREATED once `lastError` is set is the
    // known-unreliable mount-with-content pattern. Queried synchronously
    // (`getByRole`, not `findByRole`) so a conditionally-mounted region
    // fails this line immediately instead of being masked by
    // `findByRole`'s polling picking it up once it later appears.
    const status = within(genericRow).getByRole('status');
    expect(
      status,
      'the ARIA surface: the refusal text must not exist before any request has been refused, or the ' +
        '"already mounted" half of this test proves nothing',
    ).not.toHaveTextContent(/mutually exclusive/);

    await user.click(genericSwitch);
    await screen.findByText(/mutually exclusive/);

    expect(
      within(genericRow).getByRole('status'),
      'the ARIA surface: the SAME node must update its text, not be unmounted and replaced — a fresh ' +
        'node would miss a live-region listener a screen reader attached at mount time',
    ).toBe(status);
    expect(status).toHaveTextContent(/mutually exclusive/);
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('A3: a FieldRow "Not saved" refusal is announced through a role="status" live region', async () => {
    // Mirrors the NextEditRow lock directly above (Finding 7's mounted-empty
    // discipline), but for a config FieldRow: today `FieldRow`'s error
    // (SettingsPanel.tsx) is a conditionally-mounted plain `<div>` with no
    // ARIA role at all, so a screen reader never hears a rejected config
    // write — WCAG 2.2 SC 4.1.3 (status-messages.html, fetched this task)
    // requires the message be programmatically determinable without moving
    // focus. This must go RED against today's visual-only markup.
    const FIELD_KEY = 'autocomplete.enabled';
    const rejectSet = () => Promise.reject(new Error('config.set refused: read-only workspace'));
    const { user } = setup(
      <SettingsPanel
        config={{
          status: 'success',
          data: {
            sections: [{ name: 'autocomplete', fields: [{ key: FIELD_KEY, value: false, type: 'boolean' }] }],
          },
        }}
        onRetryConfig={() => undefined}
        onSetConfig={rejectSet}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={noopAsync}
      />,
    );

    const fieldSwitch = screen.getByRole('switch', { name: FIELD_KEY });
    const fieldRow = fieldSwitch.parentElement as HTMLElement;

    // The region must exist BEFORE anything has failed — a region only
    // created once `lastError` is set is the known-unreliable
    // mount-with-content pattern (Finding 7).
    const status = within(fieldRow).getByRole('status');
    expect(
      status,
      'the region must not carry the refusal text before any request has been refused, or the ' +
        '"already mounted" half of this test proves nothing',
    ).not.toHaveTextContent(/read-only workspace/);

    await user.click(fieldSwitch);
    await screen.findByText(/read-only workspace/);

    expect(
      within(fieldRow).getByRole('status'),
      'the SAME node must update its text, not be unmounted and replaced — a fresh node would miss a ' +
        'live-region listener a screen reader attached at mount time',
    ).toBe(status);
    expect(status).toHaveTextContent(/Not saved:.*read-only workspace/);
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});

describe('U-2: the click target is the control, not the descriptive prose', () => {
  it('clicking the switch requests a toggle', async () => {
    const calls: Array<{ source: string; on: boolean }> = [];
    const record = async (source: string, on: boolean) => { calls.push({ source, on }); };
    const { user } = setup(
      <SettingsPanel
        config={{ status: 'error', error: { message: 'backend down', retryable: true } }}
        onRetryConfig={() => undefined}
        onSetConfig={noopAsync}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={record as never}
      />,
    );

    await user.click(screen.getByRole('switch', { name: NEXT_ROW.label }));
    expect(calls).toEqual([{ source: 'next', on: true }]);
  });

  it('clicking the DESCRIPTION text does NOT toggle — the half that catches U-2', async () => {
    const calls: Array<{ source: string; on: boolean }> = [];
    const record = async (source: string, on: boolean) => { calls.push({ source, on }); };
    const { user } = setup(
      <SettingsPanel
        config={{ status: 'error', error: { message: 'backend down', retryable: true } }}
        onRetryConfig={() => undefined}
        onSetConfig={noopAsync}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={record as never}
      />,
    );

    await user.click(screen.getByText(NEXT_ROW.description));
    expect(
      calls,
      'U-2: a whole-row <label> turns copyable prose into a toggle. Clicking the description must be inert.',
    ).toEqual([]);
  });
});

/**
 * G-3. `FieldRow`'s config-row analogue of U-2 above: the row's `<label>` used
 * to wrap the WHOLE row, including the `Not saved: …` inline error — so
 * clicking the error to read or copy it flipped the switch and re-issued the
 * write that had just failed. `SettingsData`'s real shape is
 * `{ sections: [{ name, fields }] }` (`src/shared/protocol.ts`) and
 * `RemoteData`'s success discriminant is `status: 'success'`
 * (`webview/src/state/remoteData.ts`) — the task brief's draft config
 * (`status: 'ready'`, `data: { fields }` with no `sections` wrapper) matches
 * neither and would fail `webview typecheck`; corrected here to the real
 * shapes, matching the `configPanel` helper used earlier in this file.
 */
describe('G-3: clicking a settings row error must not toggle the switch', () => {
  it('a click on the "Not saved:" text does NOT issue a config.set', async () => {
    const sets: { key: string; value: unknown }[] = []; // plain array, not vi.fn()
    const { user } = setup(
      <SettingsPanel
        config={{
          status: 'success',
          data: {
            sections: [
              {
                name: 'autocomplete',
                fields: [
                  {
                    key: 'talaria.autocomplete.enabled',
                    type: 'boolean',
                    value: true,
                    description: 'Enable Talaria inline (FIM) autocomplete.',
                  },
                ],
              },
            ],
          },
        }}
        onRetryConfig={() => undefined}
        onSetConfig={async (key, value) => {
          sets.push({ key, value });
          throw new Error('rejected by the host');
        }}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={async () => undefined}
      />,
    );

    // Fail the write so the inline error appears.
    await user.click(screen.getByRole('switch', { name: 'talaria.autocomplete.enabled' }));
    const error = await screen.findByText(/Not saved:/);
    sets.length = 0;

    // The user reaches for the error to read or copy it.
    await user.click(error);

    expect(sets).toEqual([]);
  });

  it('clicking the row TITLE still toggles (the affordance is preserved, not removed)', async () => {
    const sets: { key: string; value: unknown }[] = [];
    const { user } = setup(
      <SettingsPanel
        config={{
          status: 'success',
          data: {
            sections: [
              {
                name: 'autocomplete',
                fields: [{ key: 'talaria.autocomplete.enabled', type: 'boolean', value: true }],
              },
            ],
          },
        }}
        onRetryConfig={() => undefined}
        onSetConfig={async (key, value) => {
          sets.push({ key, value });
        }}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={async () => undefined}
      />,
    );

    await user.click(screen.getByText('talaria.autocomplete.enabled'));
    expect(sets).toHaveLength(1);
  });

  it('B-5 wiring: a click on a BUSY switch is ignored (the decision function is tested in Toggle.test.ts)', async () => {
    const sets: { key: string; value: unknown }[] = [];
    let release: (() => void) | undefined;
    const { user } = setup(
      <SettingsPanel
        config={{
          status: 'success',
          data: {
            sections: [
              {
                name: 'autocomplete',
                fields: [{ key: 'talaria.autocomplete.enabled', type: 'boolean', value: true }],
              },
            ],
          },
        }}
        onRetryConfig={() => undefined}
        onSetConfig={async (key, value) => {
          sets.push({ key, value });
          await new Promise<void>((r) => {
            release = r;
          });
        }}
        nextEdit={{ next: false, generic: false }}
        onToggleNextEdit={async () => undefined}
      />,
    );

    const control = screen.getByRole('switch', { name: 'talaria.autocomplete.enabled' });
    await user.click(control);
    await user.click(control); // second click while the first is in flight
    expect(sets).toHaveLength(1);
    release?.();
  });
});
