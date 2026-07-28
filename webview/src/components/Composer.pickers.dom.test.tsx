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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
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
