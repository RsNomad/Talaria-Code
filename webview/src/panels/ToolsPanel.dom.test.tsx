/**
 * V-11 TOGGLE-HONESTY — DOM-level wiring proof for `ToolsPanel`. Mirrors
 * `SkillsPanel.dom.test.tsx` exactly (same `useToggle`, same `LiveRegion`
 * grammar) but at the TOOLSET grain, which is where `ToolsPanel` actually
 * toggles (`PUT /api/tools/toolsets/{name}` — no per-tool enable route).
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ToolsData } from '../protocol';
import { ToolsPanel } from './ToolsPanel';

function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

function toolsData(enabled: boolean): ToolsData {
  return {
    toolsets: [{ name: 'web', enabled, toolCount: 1 }],
    tools: [
      {
        name: 'fetch_url',
        description: 'Fetch a URL.',
        enabled,
        kind: 'fetch',
        toolset: 'web',
        source: 'core',
      },
    ],
  };
}

/** A request issued and never answered — the only honest model of "the user's
 *  toggle is STILL IN FLIGHT at the instant a host push lands". */
const neverSettles = () => new Promise<unknown>(() => undefined);

describe('ToolsPanel V-11 TOGGLE-HONESTY', () => {
  it('a rejected toolset toggle rolls back AND announces the reason through a live region', async () => {
    const onToggle = () => Promise.reject(new Error('dashboard unreachable'));
    const { user } = setup(<ToolsPanel data={toolsData(true)} onToggle={onToggle} />);

    const toggle = screen.getByRole('switch', { name: 'Enable web toolset' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    // Today (pre-fix) this text never appears anywhere — the rollback is silent.
    expect(await screen.findByText('Not saved: dashboard unreachable')).toBeInTheDocument();
    expect(toggle, 'the switch rolls back to the live server value on rejection').toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('an IN-FLIGHT toolset toggle stands against a disagreeing serverValue push', async () => {
    const { user, rerender } = setup(<ToolsPanel data={toolsData(false)} onToggle={neverSettles} />);
    const toggle = () => screen.getByRole('switch', { name: 'Enable web toolset' });

    await user.click(toggle()); // optimistic ON; the request never answers
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    rerender(<ToolsPanel data={toolsData(false)} onToggle={neverSettles} />);

    expect(
      toggle(),
      'an in-flight optimistic value must never be clobbered by a push — only a SETTLED op may reconcile',
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('once a toolset toggle has SETTLED, a later disagreeing serverValue push wins — the mask is gone', async () => {
    let resolveToggle: (() => void) | undefined;
    const onToggle = () => new Promise<void>((res) => { resolveToggle = res; });
    const { user, rerender } = setup(<ToolsPanel data={toolsData(false)} onToggle={onToggle} />);
    const toggle = () => screen.getByRole('switch', { name: 'Enable web toolset' });

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-checked', 'true'); // optimistic, still in flight

    resolveToggle?.(); // the persist actually succeeds — the toggle SETTLES

    // Another editor then turned it back off — server truth is false again.
    // Today (pre-fix) `overrides[id]` never expires once confirmed, so this
    // push would be masked forever and the switch would stay stuck ON.
    await waitFor(() => {
      rerender(<ToolsPanel data={toolsData(false)} onToggle={onToggle} />);
      expect(
        toggle(),
        'once settled, a later disagreeing serverValue push must win over a confirmed optimistic value',
      ).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('beta.7 C1: the persist note renders ABOVE every toolset group — a panel-level note, not the last group’s caption', () => {
    const data: ToolsData = {
      toolsets: [
        { name: 'web', enabled: true, toolCount: 1 },
        { name: 'computer_use', enabled: true, toolCount: 1 },
      ],
      tools: [
        { name: 'fetch_url', description: 'Fetch a URL.', enabled: true, kind: 'fetch', toolset: 'web', source: 'core' },
        { name: 'screenshot', description: 'Take a screenshot.', enabled: true, kind: 'other', toolset: 'computer_use', source: 'core' },
      ],
    };
    setup(<ToolsPanel data={data} onToggle={async () => undefined} />);
    const note = screen.getByText('Toggles persist immediately and apply to new sessions.');
    const firstGroupToggle = screen.getByRole('switch', { name: 'Enable web toolset' });
    const lastGroupToggle = screen.getByRole('switch', { name: 'Enable computer_use toolset' });
    expect(note.compareDocumentPosition(firstGroupToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(lastGroupToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
