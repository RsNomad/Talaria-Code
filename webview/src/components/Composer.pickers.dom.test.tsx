/*
 * B3 / path doc §2.3, §4 B3 (UI M-1) — the preset picker (`Composer.tsx`
 * ~:830-871) and mode picker (~:879-935) claimed `role="menu"` with NONE of
 * the APG menu keyboard contract: opening never moved focus, arrow keys did
 * nothing, and Escape did not close the menu (only an outside mousedown, or
 * re-clicking the trigger, could dismiss it). This file proves the RED state
 * against today's pickers, then — once they adopt the shared `useMenuFocus`
 * hook (the same one AttachMenu.dom.test.tsx characterizes) — the GREEN
 * state: focus-first-on-open, ArrowDown roving, Escape closes AND returns
 * focus to the trigger.
 *
 * Grounding (fetched live for this task, same sources as
 * `webview/src/hooks/useMenuFocus.ts`):
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/ — "Enter: opens
 *   the menu and places focus on the first menu item."
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu/ — Escape returns focus to
 *   "the element or context, e.g., menu button ... from which the menu was
 *   opened"; Up/Down Arrow move focus to the previous/next item.
 */
import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
import { useMenuFocus } from '../hooks/useMenuFocus';
import type { Attachment, ContextRef, CustomModeInfo, EditPolicyPreset } from '../protocol';
import type { ComposerSeed } from '../composer/applySeed';

const MODES: CustomModeInfo[] = [
  { id: 'mode-a', name: 'Alpha' },
  { id: 'mode-b', name: 'Bravo' },
];

function renderComposer(overrides: {
  preset?: EditPolicyPreset;
  availableModes?: CustomModeInfo[];
  activeModeId?: string | null;
} = {}) {
  return render(
    <Composer
      tabId="tab-1"
      draft=""
      draftAttachments={[]}
      onDraftChange={() => undefined}
      onAttachAdd={(_a: Attachment) => undefined}
      onAttachRemove={() => undefined}
      preset={overrides.preset ?? 'normal'}
      modelLabel="test-model"
      busy={false}
      stopping={false}
      disabled={false}
      activeModeId={overrides.activeModeId ?? null}
      availableModes={overrides.availableModes ?? MODES}
      onSetMode={async () => undefined}
      initialHeight={120}
      onHeightChange={() => undefined}
      onSubmit={(_text: string, _attachments?: Attachment[], _mentions?: ContextRef[]) => undefined}
      onCancel={() => undefined}
      onSetPreset={async () => undefined}
      onPickModel={() => undefined}
      onNewSession={() => undefined}
      availableCommands={[]}
      searchFiles={async () => []}
      pendingSeed={null as ComposerSeed | null}
      onSeedApplied={() => undefined}
    />,
  );
}

function getPresetTrigger(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[title^="Edit policy:"]');
  if (!(el instanceof HTMLElement)) throw new Error('preset trigger not found');
  return el;
}

function getModeTrigger(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[title^="Custom mode:"]');
  if (!(el instanceof HTMLElement)) throw new Error('mode trigger not found');
  return el;
}

/*
 * Task 20 (WV4-MIN) — a minimal `useMenuFocus` harness for the two additive
 * pieces that have no existing real consumer to exercise them through yet at
 * RED time: `openMenuAt(index)` (OverflowMenu's post-rewrite G-4 park-on-open
 * calls this, but the rewrite hasn't happened when this test is first
 * written — TDD order, hook tests before the OverflowMenu rewrite) and, as a
 * secondary check, the same Home/End roving the real preset-picker tests
 * below exercise through a live consumer. Shaped like OverflowMenu's own
 * open/menu/item wiring (trigger button + role="menu" + itemRef) so it
 * stands in for "an OverflowMenu-shaped harness" per the task brief.
 */
function OpenAtHarness({ count }: { count: number }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { open, focusIdx, itemRef, onMenuKey, openMenuAt } = useMenuFocus(count, triggerRef);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => openMenuAt(2)}>
        open at 2
      </button>
      {open && (
        <div role="menu" aria-label="harness" onKeyDown={onMenuKey}>
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              ref={itemRef(i)}
              role="menuitem"
              type="button"
              tabIndex={i === focusIdx ? 0 : -1}
            >
              Item {i}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

describe('B3 (UI M-1): preset picker gains the APG menu keyboard contract', () => {
  it('opening the menu focuses the first item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getPresetTrigger(container));
    const items = screen.getAllByRole('menuitemradio');

    await waitFor(() => expect(document.activeElement).toBe(items[0]));
  });

  it('ArrowDown moves focus to the second item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getPresetTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    const trigger = getPresetTrigger(container);
    await user.click(trigger);
    await waitFor(() => expect(screen.getAllByRole('menuitemradio')[0]).toHaveFocus());

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

/**
 * W4-T6 (UI#8): both `role="menu"` popups carried no accessible name at all
 * (no `aria-label`/`aria-labelledby` on the menu element itself) — APG's
 * Menu pattern (https://www.w3.org/WAI/ARIA/apg/patterns/menu/, fetched live
 * for this task): "An element with role menu either has: aria-labelledby set
 * to a value that refers to the menuitem or button that controls its
 * display[, or] a label provided by aria-label." `AttachMenu.tsx`'s own
 * `role="menu"` already does this correctly (`aria-label="Attach"`) — these
 * two were the exception, not the rule.
 */
describe('W4-T6 (UI#8): the preset menu carries an accessible name (APG: a menu MUST be labelled)', () => {
  it('the preset menu is reachable as a NAMED role=menu, not an anonymous one', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getPresetTrigger(container));

    expect(screen.getByRole('menu', { name: 'Edit policy' })).toBeInTheDocument();
  });
});

/**
 * T-16 F8 (Tier-2 §12.1): both pickers are single-select groups (exactly one
 * preset / one mode active at a time) but claimed plain `role="menuitem"`
 * with selection conveyed ONLY by a `text-accent` vs `text-muted` color class
 * — WCAG 1.4.1 (Use of Color): "Color is not used as the only visual means of
 * conveying information". APG's Menu pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/menu/, fetched live for this
 * task): "When a menuitemcheckbox or menuitemradio is checked, aria-checked
 * is set to true" — a mutually exclusive list like this is the textbook
 * `menuitemradio` case. Fix adds `role="menuitemradio"` + `aria-checked` +
 * a visible check glyph on the selected item; the color cue stays (additive,
 * not a replacement).
 */
describe('T-16 F8: preset picker items are menuitemradio with a non-color selected indicator', () => {
  it('the active preset item is menuitemradio with aria-checked=true, others aria-checked=false', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer({ preset: 'normal' });

    await user.click(getPresetTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.length).toBeGreaterThan(1);

    const checked = items.filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    // No leftover plain `menuitem` items — every option converted.
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('the selected item shows a visible check glyph, not just a color change', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer({ preset: 'normal' });

    await user.click(getPresetTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    const selected = items.find((el) => el.getAttribute('aria-checked') === 'true');
    if (!selected) throw new Error('no selected preset item found');
    const unselected = items.find((el) => el.getAttribute('aria-checked') === 'false');
    if (!unselected) throw new Error('no unselected preset item found');

    expect(selected.querySelector('.codicon-check')).not.toBeNull();
    expect(unselected.querySelector('.codicon-check')).toBeNull();
  });
});

describe('T-16 F8: mode picker items are menuitemradio with a non-color selected indicator', () => {
  it('the active mode ("None") is menuitemradio with aria-checked=true, others aria-checked=false', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer({ activeModeId: null });

    await user.click(getModeTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.length).toBeGreaterThan(1);

    const checked = items.filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toContain('None');
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('a non-default selected mode shows the check glyph on the right item, not "None"', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer({ activeModeId: 'mode-b' });

    await user.click(getModeTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    const selected = items.find((el) => el.getAttribute('aria-checked') === 'true');
    if (!selected) throw new Error('no selected mode item found');

    expect(selected.textContent).toContain('Bravo');
    expect(selected.querySelector('.codicon-check')).not.toBeNull();
  });
});

/**
 * T-16 F10 (Tier-2 §12.1): `useMenuFocus`'s `onTriggerKey` opened the menu at
 * the FIRST item regardless of which arrow key opened it. APG menu-button
 * pattern (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/, fetched
 * live for this task): "Down Arrow ... Opens the menu ... moves focus to the
 * first item"; "Up Arrow ... Opens the menu ... moves focus to the LAST
 * item." Exercised here through the preset picker (a real `useMenuFocus`
 * consumer), not the hook in isolation, matching this file's existing idiom.
 */
describe('T-16 F10: ArrowUp on a closed menu trigger opens at the LAST item (APG menu-button)', () => {
  it('ArrowUp on the preset trigger opens the menu with focus on the last item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    const trigger = getPresetTrigger(container);
    trigger.focus();
    await user.keyboard('{ArrowUp}');

    const items = screen.getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[items.length - 1]));
  });

  it('ArrowDown on the preset trigger still opens at the FIRST item (unchanged)', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    const trigger = getPresetTrigger(container);
    trigger.focus();
    await user.keyboard('{ArrowDown}');

    const items = screen.getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
  });
});

describe('B3 (UI M-1): mode picker gains the APG menu keyboard contract', () => {
  it('opening the menu focuses the first item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getModeTrigger(container));
    const items = screen.getAllByRole('menuitemradio');

    await waitFor(() => expect(document.activeElement).toBe(items[0]));
  });

  it('ArrowDown moves focus to the second item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getModeTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    const trigger = getModeTrigger(container);
    await user.click(trigger);
    await waitFor(() => expect(screen.getAllByRole('menuitemradio')[0]).toHaveFocus());

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

/**
 * W4-T6 (UI#8): the mode menu's half of the same unnamed-menu fix — see the
 * preset menu's twin describe above for the full APG grounding.
 */
describe('W4-T6 (UI#8): the mode menu carries an accessible name (APG: a menu MUST be labelled)', () => {
  it('the mode menu is reachable as a NAMED role=menu, not an anonymous one', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getModeTrigger(container));

    expect(screen.getByRole('menu', { name: 'Mode' })).toBeInTheDocument();
  });
});

/**
 * Task 20 (WV4-MIN): `useMenuFocus.onMenuKey` previously routed only
 * ArrowDown/ArrowUp — Home/End were no-ops. APG's Menu pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/menu/, fetched live for this
 * task): "Home: moves focus to first item"; "End: moves focus to last item".
 * `nextRovingIndex` (rovingIndex.ts) already computes both; this only wires
 * them into the hook's key handler. Exercised through the preset picker (a
 * real `useMenuFocus` consumer, 4 items — manual/normal/strict/plan), same
 * idiom as the existing ArrowDown test above.
 */
describe('Task 20: useMenuFocus gains Home/End (additive, APG menu pattern)', () => {
  it('End moves focus to the last item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getPresetTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('Home moves focus back to the first item', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(getPresetTrigger(container));
    const items = screen.getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
  });
});

/**
 * Task 20 (WV4-MIN): `openMenuAt(index)` — additive to `UseMenuFocusResult`.
 * OverflowMenu's post-rewrite G-4 park-on-open behavior calls this with the
 * active item's index; this pins the hook's own contract directly (see
 * `OpenAtHarness` above) ahead of that rewrite.
 */
describe('Task 20: useMenuFocus.openMenuAt opens with initial focus on a given index', () => {
  it('openMenuAt(2) focuses item 2 once the menu opens', async () => {
    const user = userEvent.setup();
    render(<OpenAtHarness count={4} />);

    await user.click(screen.getByRole('button', { name: 'open at 2' }));
    const items = screen.getAllByRole('menuitem');

    await waitFor(() => expect(document.activeElement).toBe(items[2]));
  });

  it('openMenuAt clamps an out-of-range index to the last item', async () => {
    const user = userEvent.setup();
    render(<OpenAtHarness count={2} />);

    await user.click(screen.getByRole('button', { name: 'open at 2' }));
    const items = screen.getAllByRole('menuitem');

    await waitFor(() => expect(document.activeElement).toBe(items[items.length - 1]));
  });
});
