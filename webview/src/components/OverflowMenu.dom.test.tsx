import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverflowMenu } from './OverflowMenu';
import type { TabDef } from './PriorityTabs';

/**
 * Audit G-4. The focus-parking effect depended on [open, items, active], and
 * `items` is a fresh array every parent render (PriorityTabs.tsx:207 passes
 * items={overflow}, a value recomputed by computeLayout() on every render;
 * neither it nor App.tsx's callers memoise it). During a streaming turn App
 * re-renders continuously, so the effect re-fired every frame and yanked
 * focus back to the parked item: the menu was keyboard-unusable exactly
 * while the agent answered.
 *
 * Timing note (verified against this repo's jsdom, not assumed): the
 * open-effect's `.focus()` runs inside `requestAnimationFrame`, and this
 * workspace uses REAL timers (no `vi.useFakeTimers()` anywhere in the
 * config), so the DOM does not have focus on the menu item in the same tick
 * `user.click()` resolves — a direct read of `document.activeElement`
 * immediately after the click still sees the trigger button. Both
 * assertions below wait for focus to actually land before comparing, so a
 * "nothing happened yet" state can't be mistaken for "nothing changed".
 */
function items(): TabDef[] {
  return [
    { id: 'tools', label: 'Tools', icon: 'tools' },
    { id: 'skills', label: 'Skills', icon: 'skills' },
    { id: 'models', label: 'Models', icon: 'models' },
  ] as TabDef[];
}

describe('G-4: the overflow menu keeps focus where the user put it', () => {
  it('a parent re-render with a NEW items array does not move focus', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <OverflowMenu items={items()} active="tools" onSelect={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: /more/i }));
    // Wait for the open-effect's rAF to actually park focus before doing
    // anything keyboard-driven with it.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Tools'));

    // Move to the second item, as a keyboard user would. `move()` calls
    // `.focus()` synchronously (no rAF involved), so no extra wait is needed
    // for the keypress itself.
    await user.keyboard('{ArrowDown}');
    const focusedBefore = document.activeElement?.textContent;
    // Sanity check the setup actually moved focus, so the comparison below
    // can't pass by both sides being empty/stale.
    expect(focusedBefore).toContain('Skills');

    // Simulate the streaming-turn re-render: same content, brand-new array.
    rerender(<OverflowMenu items={items()} active="tools" onSelect={() => undefined} />);

    // Give a wrongly-scheduled rAF (the exact bug this test guards against)
    // real wall-clock time to fire before asserting nothing moved.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement?.textContent).toBe(focusedBefore);
  });

  it('opening the menu still parks focus on the active item (non-vacuous)', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu items={items()} active="skills" onSelect={() => undefined} />);
    await user.click(screen.getByRole('button', { name: /more/i }));
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Skills'));
  });
});

/**
 * T-16 WV-2 (Tier-2 §12.1): `move()` only clamps `focusIdx` reactively, on an
 * explicit ArrowUp/Down/Home/End keypress. If `items` SHRINKS while the menu
 * stays open (PriorityTabs' Priority+ layout regains room and an overflowed
 * tab moves back into the visible strip — a live re-render, not a user
 * keypress) and `focusIdx` was pointing at an index the new, shorter array no
 * longer has, nothing re-clamps it: no rendered item then matches `i ===
 * focusIdx` (the roving tabIndex breaks) and the unmounted button that used
 * to hold DOM focus drops focus to `<body>` — invisible/untraceable to a
 * keyboard user, the same class of "focus silently lost" bug as Audit G-4
 * above. Fix: an effect keyed on `[open, items.length]` (a primitive, so it
 * does NOT re-run on every parent render the way G-4's `items`-object
 * dependency did) that clamps `focusIdx` back into range and re-parks focus
 * on the new valid item at that index.
 */
describe('T-16 WV-2: shrinking items while the menu is open re-parks focus instead of losing it', () => {
  it('clamps a stale focusIdx into range and refocuses a valid item when items shrink', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <OverflowMenu items={items()} active="tools" onSelect={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: /more/i }));
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Tools'));

    // Move focus to the LAST item (index 2, "Models").
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Models');

    // Shrink to a single item while the menu stays open — the button that
    // held focus ("Models") no longer exists in the new tree.
    const shrunk = items().slice(0, 1);
    rerender(<OverflowMenu items={shrunk} active="tools" onSelect={() => undefined} />);

    // `document.body.textContent` trivially "contains" every item's label
    // (they're all still descendants of body), so comparing against body's
    // OWN textContent would be vacuous if focus were lost to it — assert
    // against the specific remaining menuitem element instead.
    await waitFor(() => {
      const onlyItem = screen.getByRole('menuitem');
      expect(document.activeElement).toBe(onlyItem);
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does not touch focus when items grow back (no spurious re-park)', async () => {
    const user = userEvent.setup();
    const short = items().slice(0, 1);
    const { rerender } = render(
      <OverflowMenu items={short} active="tools" onSelect={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: /more/i }));
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Tools'));
    const focusedBefore = document.activeElement;

    rerender(<OverflowMenu items={items()} active="tools" onSelect={() => undefined} />);
    // Give any wrongly-scheduled re-park real wall-clock time to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.activeElement).toBe(focusedBefore);
  });
});
