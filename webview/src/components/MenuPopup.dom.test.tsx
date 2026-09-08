import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MenuPopup } from './MenuPopup';

/**
 * FI-15 drift-lock: `MenuPopup` single-sources the `role="menu"` +
 * `aria-label` + border/positioning chrome that `Composer.tsx`'s preset and
 * mode pickers used to repeat inline, identical except `min-w`. This test
 * asserts that chrome byte-for-byte (the FULL container className string,
 * not just a subset of classes) for both real callers' `minWidthClass`
 * values, so any future drift in the ONE shared component is caught here
 * first — same drift-lock idiom as `PanelScaffold.dom.test.tsx` (FI-14).
 */
describe('MenuPopup: shared APG menu container chrome for the preset & mode pickers (FI-15)', () => {
  it('renders role="menu" with the given aria-label, the exact container className (preset variant), and the children inside', () => {
    render(
      <MenuPopup ariaLabel="Edit policy" minWidthClass="min-w-[184px]" onKeyDown={() => undefined}>
        <div>preset items</div>
      </MenuPopup>,
    );

    const menu = screen.getByRole('menu', { name: 'Edit policy' });
    expect(menu.className).toBe(
      'absolute bottom-full left-0 z-30 mb-1 min-w-[184px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg',
    );
    expect(screen.getByText('preset items')).toBeInTheDocument();
  });

  it('renders the exact container className for the mode variant — the ONLY thing that differs from the preset variant is min-w', () => {
    render(
      <MenuPopup ariaLabel="Mode" minWidthClass="min-w-[160px]" onKeyDown={() => undefined}>
        <div>mode items</div>
      </MenuPopup>,
    );

    const menu = screen.getByRole('menu', { name: 'Mode' });
    expect(menu.className).toBe(
      'absolute bottom-full left-0 z-30 mb-1 min-w-[160px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg',
    );
    expect(screen.getByText('mode items')).toBeInTheDocument();
  });

  it('wires onKeyDown through to the container — the APG menu keyboard contract (useMenuFocus.onMenuKey) fires on the container element', () => {
    const onKeyDown = vi.fn();
    render(
      <MenuPopup ariaLabel="Edit policy" minWidthClass="min-w-[184px]" onKeyDown={onKeyDown}>
        <div>item</div>
      </MenuPopup>,
    );

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
