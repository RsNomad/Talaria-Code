/*
 * B3 / path doc §2.3 — CHARACTERIZATION test for AttachMenu's PRE-EXISTING
 * correct APG menu-button behavior, written BEFORE extracting the shared
 * `useMenuFocus` hook (webview/src/hooks/useMenuFocus.ts). This file must
 * pass GREEN both BEFORE and AFTER the extraction — that pair is the proof
 * the refactor is behavior-preserving (memory `unexecuted-assurance`: a
 * claim of "unchanged" needs a red/green pair actually run, not an
 * assertion). Do not weaken or "improve" these assertions once the hook
 * exists — they pin AttachMenu's contract, they don't test the hook itself.
 *
 * Grounding (fetched live for this task):
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/ — "Enter: opens
 *   the menu and places focus on the first menu item."
 * - https://www.w3.org/WAI/ARIA/apg/patterns/menu/ — Escape: "Close the menu
 *   that contains focus and return focus to the element or context, e.g.,
 *   menu button ... from which the menu was opened."; Tab: "move focus out
 *   of the menu ... and close all menus"; Up/Down Arrow move focus to the
 *   previous/next item ("optionally wrapping" — AttachMenu's pre-existing
 *   convention CLAMPS at the ends, `Math.max(0, Math.min(next, count-1))`,
 *   not wrap).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachMenu } from './AttachMenu';

function renderMenu() {
  return render(<AttachMenu onAttachFile={() => undefined} onAddImage={() => undefined} />);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole('button', { name: 'Attach' });
  await user.click(trigger);
  const items = screen.getAllByRole('menuitem');
  // The focus-first-item effect runs inside requestAnimationFrame (real
  // timers, no fake-timer config in this repo — see OverflowMenu.dom.test.tsx
  // for the same pattern), so focus does not land in the same tick the
  // click resolves.
  await waitFor(() => expect(document.activeElement).toBe(items[0]));
  return { trigger, items };
}

describe('AttachMenu: APG menu-button keyboard contract (characterization)', () => {
  it('opening the menu focuses the first item', async () => {
    const user = userEvent.setup();
    renderMenu();

    const { items } = await openMenu(user);

    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowDown moves focus to the next item, clamped at the last item', async () => {
    const user = userEvent.setup();
    renderMenu();
    const { items } = await openMenu(user);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);

    // AttachMenu has exactly 2 items — clamp keeps focus on the last one.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
  });

  it('ArrowUp moves focus to the previous item, clamped at the first item', async () => {
    const user = userEvent.setup();
    renderMenu();
    const { items } = await openMenu(user);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items[0]);

    // Clamp at the first item.
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    const { trigger } = await openMenu(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('Tab closes the menu', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.keyboard('{Tab}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
