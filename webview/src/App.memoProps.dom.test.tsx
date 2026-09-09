import { describe, it, expect, vi } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bridge } from './bridge';
import { BOOTSTRAP_TAB_ID } from './types';

type ChatViewProps = ComponentProps<typeof import('./components/chat/ChatView').ChatView>;
const seen: ChatViewProps[] = [];
vi.mock('./components/chat/ChatView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/chat/ChatView')>();
  const Probe = (props: ChatViewProps) => {
    seen.push(props);
    return createElement(actual.ChatView, props);
  };
  return { ...actual, ChatView: Probe };
});
import { App } from './App';

describe('R3-UI-01: every ChatView handler prop keeps its identity across an App re-render', () => {
  it('onOpenSetup (and the four already-stable siblings) are Object.is-equal before and after two App re-renders', async () => {
    const user = userEvent.setup();
    render(<App />);
    const first = seen[0];
    expect(first).toBeDefined();
    // Deterministic App re-renders that leave `tab.transcript` untouched (the G-9 idiom):
    act(() => {
      bridge.emit({ type: 'tab.error', tabId: BOOTSTRAP_TAB_ID, message: 'x', kind: 'open-failed' });
    });
    await user.click(screen.getByRole('button', { name: 'Dismiss this error' }));
    const last = seen[seen.length - 1];
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const key of ['onOpenSetup', 'onApproval', 'onDiff', 'onOpenDiff', 'onStarter'] as const) {
      expect(Object.is(first?.[key], last?.[key]), key).toBe(true);
    }
  });
});
