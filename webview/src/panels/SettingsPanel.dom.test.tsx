/**
 * DOM-level tests for the Settings ("Agent config") panel (W5.2, ADR-015).
 *
 * Scope discipline: these assert WIRING — that a decision reaches the screen,
 * that an interaction reaches a handler, that an attribute reaches an element.
 * Assertions about DECISIONS live in the pure tests and stay there.
 *
 * Task 12 (§5.1/§5.2 — "SettingsPanel -> Agent config"): the «Next Edit
 * Suggestions» rows this file used to exercise (`NextEditRow`, fed by the
 * `nextEdit`/`onToggleNextEdit` props) are gone — NEXT moved to
 * `SetupPanel.tsx`, which has its own DOM coverage in
 * `SetupPanel.dom.test.tsx`. Every case below that tested a genuinely generic
 * mechanism (the render-time prop-wins reconcile, F-8 busy-not-disabled focus
 * retention, the ARIA accessible-name/live-region surface, U-2's
 * click-target discipline) is carried forward onto `FieldRow` — the only row
 * kind left in this panel — rather than deleted outright, so none of that
 * mechanism coverage is lost; only the NEXT-specific fixtures are gone.
 */
import { describe, it, expect } from 'vitest';
import { Profiler, type ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from '../components/Toggle';
import { SettingsPanel } from './SettingsPanel';
import type { FieldValue } from './settingsField';

/** Documented shape: invoke `userEvent.setup()` BEFORE rendering, and use the
 *  returned instance rather than the direct API. */
export function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

const noopAsync = async () => undefined;

const FIELD_KEY = 'autocomplete.enabled';

/** A single-field success config, the shape every FieldRow-driven test below
 *  renders against (mirrors `SettingsData`'s real `{ sections: [{ name,
 *  fields }] }` shape — `webview/src/shared/protocol.ts`). */
function successConfig(fieldValue: boolean, key: string = FIELD_KEY): Parameters<typeof SettingsPanel>[0]['config'] {
  return {
    status: 'success',
    data: {
      sections: [{ name: 'autocomplete', fields: [{ key, value: fieldValue, type: 'boolean' }] }],
    },
  };
}

function renderPanel(config: Parameters<typeof SettingsPanel>[0]['config']) {
  return setup(<SettingsPanel config={config} onRetryConfig={() => undefined} onSetConfig={noopAsync} />);
}

/** A request that is issued and never answered — the only honest model of "the
 *  user's edit is STILL IN FLIGHT at the instant the host push lands". Resolving
 *  it would settle the row through confirm/rollback and destroy the race. */
const neverSettles = () => new Promise<unknown>(() => undefined);

describe('the render-time prop-wins reconcile — a HOST push overrides local row state', () => {
  // This is the code a reviewer deleted outright with 370/370 still green: no
  // test rendered anything, so nothing noticed. The value of this block is its
  // RED proof under deletion, not its GREEN — if it passes with
  // `SettingsPanel.tsx`'s `reconciled` line in `FieldRow` removed, it is
  // testing something else and must be rewritten.

  it('a host push wins over a local edit that is STILL IN FLIGHT — the actual race', async () => {
    // THE RACE, built with a 3-option enum field: a host push must land a
    // value distinct from BOTH the mount value and the local optimistic
    // edit's target for the race to be provable on the DISPLAYED value. A
    // boolean field's only two states make this unprovable by construction
    // (mount=false -> optimistic edit=true is the ONLY value a host push
    // that "moved since mount" can land on too, so aria-checked can't tell
    // an in-flight optimistic edit apart from the push arriving — the same
    // degenerate case `NextEditRow` used to escape via its cross-toggle
    // `otherOn` axis; a 3-way enum escapes it here instead, with no second
    // axis needed).
    const enumConfig = (value: string): Parameters<typeof SettingsPanel>[0]['config'] => ({
      status: 'success',
      data: {
        sections: [
          {
            name: 'autocomplete',
            fields: [{ key: 'autocomplete.backend', value, type: 'enum', options: ['a', 'b', 'c'] }],
          },
        ],
      },
    });

    const { user, rerender } = setup(
      <SettingsPanel config={enumConfig('a')} onRetryConfig={() => undefined} onSetConfig={neverSettles} />,
    );

    const select = () =>
      screen.getByRole('combobox', { name: 'autocomplete.backend' }) as HTMLSelectElement;
    await user.selectOptions(select(), 'b');

    // PROOF THE RACE EXISTS. The `<select>` goes natively `disabled` while
    // `pending` (FieldRow's enum branch, unlike its boolean `Toggle` branch)
    // — these two assertions are the state machine testifying that a local
    // edit really is outstanding at this instant. Without them "the push
    // wins" would be vacuously true against a row that had nothing to win
    // against.
    expect(
      select().value,
      'fixture integrity: the optimistic local edit must be on screen, or there is no race to test',
    ).toBe('b');
    expect(
      select(),
      'fixture integrity: the config.set request must still be IN FLIGHT when the push lands, or this ' +
        'test is not exercising the race it claims to',
    ).toBeDisabled();

    // The host push lands mid-flight, landing a THIRD value — neither the
    // mount value ('a') nor the in-flight optimistic edit's target ('b').
    rerender(<SettingsPanel config={enumConfig('c')} onRetryConfig={() => undefined} onSetConfig={neverSettles} />);

    expect(
      select().value,
      'prop-wins reconcile: a host push must beat an in-flight local edit — without it the row keeps ' +
        'displaying the unratified optimistic value and lies about what is actually persisted',
    ).toBe('c');
    expect(
      select(),
      'prop-wins reconcile: the push IS the answer, so the row must leave its in-flight state — without ' +
        'it the row stays disabled forever waiting for a reply that already arrived by another route',
    ).not.toBeDisabled();
  });

  it('a host push lets a rolled-back local edit be overwritten by a fresh value', async () => {
    const rejectSet = (_key: string, _value: FieldValue) =>
      Promise.reject(new Error('config.set refused: read-only workspace'));

    const configPanel = (fieldValue: boolean) => (
      <SettingsPanel config={successConfig(fieldValue)} onRetryConfig={() => undefined} onSetConfig={rejectSet} />
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
    // Locks that the reconcile EXISTS (this block goes RED if it is deleted)
    // AND that it runs at RENDER TIME rather than in a `useEffect` — moving
    // `FieldRow`'s reconcile line verbatim into `useEffect([field.value])`
    // would keep an `aria-checked`/`aria-busy` check green (RTL's `rerender`
    // is `act`-wrapped, so the Effect's extra pass flushes before any
    // assertion runs) while still committing a stale frame first.
    //
    // React's own guidance (react.dev, "You Might Not Need an Effect" ->
    // "Adjusting some state when a prop changes") is that adjusting state
    // DURING render lets React "re-render immediately" and "throw away the
    // returned JSX" before committing, so a host push lands in ONE commit
    // with the reconciled value already in it. `<Profiler onRender>` fires
    // exactly once per commit (react.dev Profiler reference), so counting
    // its calls across one host push measures commits directly.
    let commits = 0;
    const onRender = () => {
      commits += 1;
    };

    const { rerender } = setup(
      <Profiler id="settings-field-row-reconcile" onRender={onRender}>
        <SettingsPanel config={successConfig(false)} onRetryConfig={() => undefined} onSetConfig={noopAsync} />
      </Profiler>,
    );
    commits = 0; // only the push below is under test, not mount's own commit

    rerender(
      <Profiler id="settings-field-row-reconcile" onRender={onRender}>
        <SettingsPanel config={successConfig(true)} onRetryConfig={() => undefined} onSetConfig={noopAsync} />
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
 * Three DOM locks for defects that ALREADY SHIPPED FIXED, all in `FieldRow`
 * since Task 12 removed `NextEditRow` (they used to be provable on either
 * row — same shared grammar — and are now provable only on the survivor):
 *
 * F-8 (focus retention): `Toggle` distinguishes `busy` (stays focusable —
 * `aria-disabled` + `aria-busy`, click-guarded) from genuine `disabled`
 * (native attribute). The bug this guards: the toggle used to go natively
 * `disabled` mid-request, so a keyboard user who pressed Space was blurred to
 * `<body>` and had to tab through the whole panel again to retry a refused
 * write.
 *
 * The ARIA surface: `Toggle`'s own `aria-label` must win accessible-name
 * computation, and the row's `role="status"` region (Finding 7) must stay
 * mounted unconditionally — only its text changes — because a region that
 * mounts together with its own content is the known-unreliable screen-reader
 * announcement pattern.
 *
 * U-2 (row click target): the row's `<label>` wraps the title only
 * (`htmlFor`/`id`), not the descriptive prose a user would click-and-drag to
 * copy.
 */

describe('F-8: the toggle keeps keyboard focus across the request round trip', () => {
  it('the switch still has focus after a REJECTED config.set settles', async () => {
    let reject: (e: Error) => void = () => undefined;
    const pending = (_key: string, _value: FieldValue) => new Promise<never>((_, r) => { reject = r; });

    const { user } = setup(
      <SettingsPanel config={successConfig(false)} onRetryConfig={() => undefined} onSetConfig={pending} />,
    );

    const fieldSwitch = screen.getByRole('switch', { name: FIELD_KEY });
    // Fixture integrity: prove the click is what moves focus, not an
    // accident of jsdom's default active element — otherwise the
    // `toHaveFocus()` checks below could pass trivially.
    expect(
      fieldSwitch,
      'fixture integrity: the switch must not already have focus before the click, or the focus ' +
        'assertions below prove nothing about the click actually moving it there',
    ).not.toHaveFocus();

    await user.click(fieldSwitch);
    expect(fieldSwitch, 'F-8: an in-flight control must stay focusable — never natively disabled').toHaveFocus();
    expect(fieldSwitch).toHaveAttribute('aria-busy', 'true');
    expect(fieldSwitch).not.toBeDisabled();

    reject(new Error('config.set refused: read-only workspace'));
    expect(await screen.findByText(/read-only workspace/)).toBeInTheDocument();

    expect(
      fieldSwitch,
      'F-8: after the response lands, focus must still be on the control the user never meant to leave — ' +
        'retrying a rejected write must not mean tabbing through the whole panel again',
    ).toHaveFocus();
  });
});

describe('the ARIA surface reaches the DOM', () => {
  it("the switch's accessible name IS its aria-label, not the surrounding prose", () => {
    renderPanel(successConfig(false));
    // The source comment in SettingsPanel.tsx asserts that Toggle's own
    // aria-label wins accessible-name computation. This query is the lock.
    expect(screen.getByRole('switch', { name: FIELD_KEY })).toBeInTheDocument();

    // The query above cannot, on its own, prove aria-label WINS: `FieldRow`'s
    // `<label htmlFor>` carries the exact same text as the `aria-label` it
    // passes to `Toggle` (both are `field.key`), so removing `aria-label`
    // leaves the computed accessible name unchanged here — the
    // label-association fallback happens to supply an identical string.
    // Mounting `Toggle` directly with an aria-label that DIFFERS from a
    // surrounding `<label>` is the only way to make the actual claim — "an
    // explicit aria-label wins accessible-name computation over an
    // associated <label>'s text" — falsifiable.
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

  it('A3: a FieldRow "Not saved" refusal is announced through a role="status" live region', async () => {
    // WCAG 2.2 SC 4.1.3 (status-messages.html) requires the message be
    // programmatically determinable without moving focus.
    const rejectSet = () => Promise.reject(new Error('config.set refused: read-only workspace'));
    const { user } = setup(
      <SettingsPanel config={successConfig(false)} onRetryConfig={() => undefined} onSetConfig={rejectSet} />,
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

describe('U-2: the click target is the control and the title, not the descriptive prose', () => {
  it('clicking the switch requests a config.set', async () => {
    const sets: { key: string; value: unknown }[] = [];
    const record = async (key: string, value: FieldValue) => {
      sets.push({ key, value });
    };
    const { user } = setup(
      <SettingsPanel config={successConfig(false)} onRetryConfig={() => undefined} onSetConfig={record} />,
    );

    await user.click(screen.getByRole('switch', { name: FIELD_KEY }));
    expect(sets).toEqual([{ key: FIELD_KEY, value: true }]);
  });

  it('clicking the DESCRIPTION text does NOT toggle — the half that catches U-2', async () => {
    const sets: { key: string; value: unknown }[] = [];
    const record = async (key: string, value: FieldValue) => {
      sets.push({ key, value });
    };
    const config: Parameters<typeof SettingsPanel>[0]['config'] = {
      status: 'success',
      data: {
        sections: [
          {
            name: 'autocomplete',
            fields: [{ key: FIELD_KEY, type: 'boolean', value: false, description: 'Enable inline suggestions.' }],
          },
        ],
      },
    };
    const { user } = setup(<SettingsPanel config={config} onRetryConfig={() => undefined} onSetConfig={record} />);

    await user.click(screen.getByText('Enable inline suggestions.'));
    expect(
      sets,
      'U-2: a whole-row <label> turns copyable prose into a toggle. Clicking the description must be inert.',
    ).toEqual([]);
  });
});

/**
 * G-3. `FieldRow`'s row `<label>` used to wrap the WHOLE row, including the
 * `Not saved: …` inline error — so clicking the error to read or copy it
 * flipped the switch and re-issued the write that had just failed.
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
      />,
    );

    const control = screen.getByRole('switch', { name: 'talaria.autocomplete.enabled' });
    await user.click(control);
    await user.click(control); // second click while the first is in flight
    expect(sets).toHaveLength(1);
    release?.();
  });
});
