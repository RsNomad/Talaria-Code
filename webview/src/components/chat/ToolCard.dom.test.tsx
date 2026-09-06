/*
 * WS-U U1 (UX-01, WCAG 2.1.1 / axe `scrollable-region-focusable`): rawInput
 * and output are wrapped in `ScrollRegion` so a keyboard-only user can reach
 * and pan them — but ONLY while they actually overflow. jsdom never runs real
 * layout (`scrollWidth`/`clientWidth` are both 0), so the golden block below
 * pins the no-dead-tab-stop behavior; the RED block after it stubs overflow
 * to prove the wrapper actually names each region once it does.
 *
 * NEW file, deliberately: `ToolCard.test.ts` (jsdom-FREE by this repo's own
 * convention — see its own header comment) exercises the `STATUS`/`KIND_ICON`
 * lookup tables directly with no DOM at all. Adding a DOM test there would
 * break that convention; this file is the DOM-testing sibling instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCard } from './ToolCard';
import type { ToolItem } from '../../types';

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

const baseItem: ToolItem = {
  kind: 'tool',
  turnId: 't1',
  toolId: 'tool-1',
  toolKind: 'execute',
  title: 'run tests',
  status: 'done',
  rawInput: 'npm test -- --run some/very/long/command/line/argument',
  output: 'PASS a very long line of streamed tool output text here',
};

describe('ToolCard — WS-U U1 Step 1 golden: rawInput/output carry no dead tab stop when not overflowing', () => {
  it('rawInput carries no tabindex/role/aria-label', () => {
    render(<ToolCard item={baseItem} />);
    const rawInput = screen.getByText(baseItem.rawInput as string);
    expect(rawInput).not.toHaveAttribute('tabindex');
    expect(rawInput).not.toHaveAttribute('role');
    expect(rawInput).not.toHaveAttribute('aria-label');
  });

  it('output carries no tabindex/role/aria-label', () => {
    render(<ToolCard item={baseItem} />);
    const output = screen.getByText(baseItem.output as string);
    expect(output).not.toHaveAttribute('tabindex');
    expect(output).not.toHaveAttribute('role');
    expect(output).not.toHaveAttribute('aria-label');
  });
});

describe('ToolCard — WS-U U1 Step 2 RED->GREEN: rawInput/output become named, focusable groups ONLY while overflowing', () => {
  afterEach(() => {
    restoreOverflowStub();
  });

  it('rawInput becomes role="group" named "Tool input" once it overflows', () => {
    stubOverflow(1000, 100);
    render(<ToolCard item={baseItem} />);
    const region = screen.getByRole('group', { name: 'Tool input' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent(baseItem.rawInput as string);
  });

  it('output becomes role="group" named "Tool output" once it overflows', () => {
    stubOverflow(1000, 100);
    render(<ToolCard item={baseItem} />);
    const region = screen.getByRole('group', { name: 'Tool output' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent(baseItem.output as string);
  });

  it('rawInput and output are two DISTINCT named regions (not the same accessible name)', () => {
    stubOverflow(1000, 100);
    render(<ToolCard item={baseItem} />);
    expect(screen.getByRole('group', { name: 'Tool input' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Tool output' })).toBeInTheDocument();
  });
});

describe('ToolCard — WS-U U1: no false affordance when there is nothing to scroll', () => {
  it('renders neither region when rawInput/output are absent', () => {
    stubOverflow(1000, 100);
    // exactOptionalPropertyTypes: omit the keys entirely rather than set them
    // to `undefined` — `ToolItem.rawInput`/`.output` are `?: string`, not
    // `?: string | undefined`.
    const item: ToolItem = {
      kind: 'tool',
      turnId: 't1',
      toolId: 'tool-2',
      toolKind: 'execute',
      title: 'run tests',
      status: 'done',
    };
    render(<ToolCard item={item} />);
    expect(screen.queryByRole('group', { name: 'Tool input' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Tool output' })).not.toBeInTheDocument();
    restoreOverflowStub();
  });
});
