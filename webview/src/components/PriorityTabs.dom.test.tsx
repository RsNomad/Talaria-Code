import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PriorityTabs } from './PriorityTabs';

/**
 * Audit M-8. jsdom does not implement ResizeObserver, and both `Composer`
 * (`Composer.tsx:230`) and `PriorityTabs` (`PriorityTabs.tsx:148`) construct
 * one on mount. Before `dom-setup.ts` provided a stub, every DOM test of these
 * components threw on render — which is the mechanical reason the whole G
 * cluster of UI defects had no test coverage to find them.
 */
describe('M-8: the interaction-heavy components render at all under jsdom', () => {
  it('PriorityTabs mounts without throwing on ResizeObserver', () => {
    render(<PriorityTabs active="chat" onSelect={() => undefined} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});

/**
 * T-16 F9 (Tier-2 §12.1): the overflow `…` trigger used to be a DIRECT CHILD
 * of the `role="tablist"` div (a plain `aria-haspopup="menu"` button, not a
 * `role="tab"`) — APG's tabs pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/, fetched live for this
 * task) defines the tablist container as holding tab elements; a non-tab
 * control living inside it is structurally wrong (and, practically, most
 * assistive tech's tab-navigation commands only expect `role="tab"` children
 * there). Fixed by nesting `role="tablist"` one level deeper so the overflow
 * trigger becomes a SIBLING instead of a child.
 *
 * jsdom never runs real layout (`getBoundingClientRect`/`offsetWidth` are
 * always 0), so `PriorityTabs`' Priority+ algorithm's early-return
 * ("`width <= 0` -> show everything labelled, zero overflow", `PriorityTabs.
 * tsx`) means the overflow trigger NEVER mounts under a plain render — a test
 * that just rendered normally and asserted "no overflow button found inside
 * the tablist" would be vacuously true even before the fix. This forces a
 * genuine overflow by stubbing `offsetWidth` (per measured span, keyed off
 * the same `data-m` attributes `PriorityTabs.tsx`'s hidden measurement layer
 * already sets) and the row's own `getBoundingClientRect().width`, so the
 * SAME layout math a real narrow VS Code sidebar would hit actually runs.
 */
describe('T-16 F9: the overflow trigger sits OUTSIDE the Panels tablist, not inside it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function forceOverflow() {
    // Deterministic per-span widths keyed by the `data-m` attribute
    // PriorityTabs.tsx's hidden measurement layer already stamps on every
    // span (`data-m="label" | "icon" | "kebab"`) — mirrors a real font's
    // proportional label widths closely enough to reliably overflow several
    // tabs at a narrow row width, without depending on real layout.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const m = this.dataset.m;
      if (m === 'kebab') return 28;
      if (m === 'icon') return 24;
      if (m === 'label') return 20 + (this.textContent?.length ?? 0) * 7;
      return 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 150,
      height: 32,
      top: 0,
      left: 0,
      right: 150,
      bottom: 32,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
  }

  it('the overflow trigger renders as a sibling of the tablist, never a descendant', () => {
    forceOverflow();
    render(<PriorityTabs active="chat" onSelect={() => undefined} />);

    const overflowTrigger = screen.getByRole('button', { name: 'More panels' });
    const tablist = screen.getByRole('tablist', { name: 'Panels' });

    // Sanity: the mocked layout genuinely produced an overflow set (not a
    // vacuous pass) — the tablist holds fewer than all 9 panels.
    expect(within(tablist).getAllByRole('tab').length).toBeLessThan(9);

    expect(tablist.contains(overflowTrigger)).toBe(false);
    expect(within(tablist).queryByRole('button', { name: 'More panels' })).toBeNull();
  });

  it('every direct child of the tablist is a role=tab element', () => {
    forceOverflow();
    render(<PriorityTabs active="chat" onSelect={() => undefined} />);

    const tablist = screen.getByRole('tablist', { name: 'Panels' });
    for (const child of Array.from(tablist.children)) {
      expect(child.getAttribute('role')).toBe('tab');
    }
  });
});
