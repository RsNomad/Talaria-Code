import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScrollRegion } from './ScrollRegion';

/**
 * WS-U U1 (UX-01, WCAG 2.1.1 / axe `scrollable-region-focusable`): a
 * horizontally-scrolling region needs a tab stop and an accessible name ONLY
 * while it actually overflows (`scrollWidth > clientWidth`) — a
 * non-overflowing container must never carry a dead tab stop (its own a11y
 * defect). jsdom never runs real layout, so `scrollWidth`/`clientWidth` are
 * both 0 by default (not overflowing) unless stubbed. jsdom defines these
 * getters on `Element.prototype`; overriding them one level down on
 * `HTMLElement.prototype` shadows that getter for every rendered element
 * without disturbing the original (restored by simply removing the shadow).
 */
function stubOverflow(scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => clientWidth,
  });
}

function restoreOverflowStub(): void {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
}

describe('ScrollRegion (UX-01): focusable + named ONLY while it actually overflows', () => {
  afterEach(() => {
    restoreOverflowStub();
  });

  it('carries no tabindex/role/aria-label when NOT overflowing (jsdom default: scrollWidth === clientWidth === 0)', () => {
    render(
      <ScrollRegion className="overflow-x-auto" label="Widget">
        <span>content</span>
      </ScrollRegion>,
    );
    const el = screen.getByText('content').parentElement;
    expect(el).not.toHaveAttribute('tabindex');
    expect(el).not.toHaveAttribute('role');
    expect(el).not.toHaveAttribute('aria-label');
  });

  it('becomes a focusable, named role="group" once it actually overflows', () => {
    stubOverflow(1000, 100);
    render(
      <ScrollRegion className="overflow-x-auto" label="Widget">
        <span>content</span>
      </ScrollRegion>,
    );
    const region = screen.getByRole('group', { name: 'Widget' });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('drops the tabindex/role/aria-label again once it stops overflowing (re-render after restoring the getters)', () => {
    stubOverflow(1000, 100);
    const { rerender } = render(
      <ScrollRegion className="overflow-x-auto" label="Widget">
        <span>content</span>
      </ScrollRegion>,
    );
    expect(screen.getByRole('group', { name: 'Widget' })).toBeInTheDocument();
    restoreOverflowStub();
    rerender(
      <ScrollRegion className="overflow-x-auto" label="Widget">
        <span>content</span>
      </ScrollRegion>,
    );
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('renders as a <pre> element when as="pre", keeping the caller className', () => {
    render(
      <ScrollRegion as="pre" className="my-pre-class" label="Code block (ts)">
        <code>const x = 1;</code>
      </ScrollRegion>,
    );
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveClass('my-pre-class');
  });

  it('renders as a <div> by default, keeping the caller className', () => {
    render(
      <ScrollRegion className="my-div-class" label="Widget">
        <span>content</span>
      </ScrollRegion>,
    );
    const div = screen.getByText('content').parentElement;
    expect(div?.tagName).toBe('DIV');
    expect(div).toHaveClass('my-div-class');
  });
});
