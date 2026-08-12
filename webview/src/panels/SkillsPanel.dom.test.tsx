/**
 * V-11 TOGGLE-HONESTY — DOM-level wiring proof for `SkillsPanel`.
 *
 * Scope discipline (`docs/testing/dom-tests.md`): these assert WIRING — that a
 * rejection reaches the screen through the `LiveRegion`, that a settled toggle
 * actually lets a later disagreeing `serverValue` push win. The DECISIONS
 * themselves (the `settledSeq`/`lastError`/`reconcileToggle` transitions) are
 * pure-tested in `useToggle.test.ts` and stay there.
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SkillsData } from '../protocol';
import { SkillsPanel } from './SkillsPanel';

function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

function skillsData(enabled: boolean): SkillsData {
  return {
    skills: [
      {
        id: 'web-search',
        name: 'web-search',
        category: 'research',
        description: 'Search the web for current information.',
        enabled,
      },
    ],
    categories: ['research'],
  };
}

const noop = () => undefined;

/** A request issued and never answered — the only honest model of "the user's
 *  toggle is STILL IN FLIGHT at the instant a host push lands". Resolving it
 *  would settle the row through confirm/rollback and destroy the race. */
const neverSettles = () => new Promise<unknown>(() => undefined);

describe('SkillsPanel V-11 TOGGLE-HONESTY', () => {
  it('a rejected toggle rolls the switch back AND announces the reason through a live region', async () => {
    const onToggle = () => Promise.reject(new Error('dashboard unreachable'));
    const { user } = setup(<SkillsPanel data={skillsData(true)} onToggle={onToggle} onRefresh={noop} />);

    const toggle = screen.getByRole('switch', { name: 'Enable web-search' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    // Today (pre-fix) this text never appears anywhere — the rollback is silent.
    expect(await screen.findByText('Not saved: dashboard unreachable')).toBeInTheDocument();
    expect(toggle, 'the switch rolls back to the live server value on rejection').toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('an IN-FLIGHT toggle stands against a disagreeing serverValue push (never clobbered while pending)', async () => {
    const { user, rerender } = setup(
      <SkillsPanel data={skillsData(false)} onToggle={neverSettles} onRefresh={noop} />,
    );
    const toggle = () => screen.getByRole('switch', { name: 'Enable web-search' });

    await user.click(toggle()); // optimistic ON; the request never answers
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    // A host push lands while our own toggle is still in flight — the server
    // side still disagrees (still reports false).
    rerender(<SkillsPanel data={skillsData(false)} onToggle={neverSettles} onRefresh={noop} />);

    expect(
      toggle(),
      'an in-flight optimistic value must never be clobbered by a push — only a SETTLED op may reconcile',
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('once a toggle has SETTLED, a later disagreeing serverValue push wins — the mask is gone', async () => {
    let resolveToggle: (() => void) | undefined;
    const onToggle = () => new Promise<void>((res) => { resolveToggle = res; });
    const { user, rerender } = setup(
      <SkillsPanel data={skillsData(false)} onToggle={onToggle} onRefresh={noop} />,
    );
    const toggle = () => screen.getByRole('switch', { name: 'Enable web-search' });

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-checked', 'true'); // optimistic, still in flight

    resolveToggle?.(); // the persist actually succeeds — the toggle SETTLES

    // Another editor then turned it back off — server truth is false again.
    // Today (pre-fix) `overrides[id]` never expires once confirmed, so this
    // push would be masked forever and the switch would stay stuck ON.
    await waitFor(() => {
      rerender(<SkillsPanel data={skillsData(false)} onToggle={onToggle} onRefresh={noop} />);
      expect(
        toggle(),
        'once settled, a later disagreeing serverValue push must win over a confirmed optimistic value',
      ).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('beta.7 C3: the persist note renders ABOVE every skill row — a panel-level note, not the last group’s caption', () => {
    const data: SkillsData = {
      skills: [
        {
          id: 'web-search',
          name: 'web-search',
          category: 'research',
          description: 'Search the web for current information.',
          enabled: true,
        },
        {
          id: 'code-review',
          name: 'code-review',
          category: 'engineering',
          description: 'Review code for issues.',
          enabled: true,
        },
      ],
      categories: ['research', 'engineering'],
    };
    setup(<SkillsPanel data={data} onToggle={async () => undefined} onRefresh={noop} />);
    const note = screen.getByText(
      'Toggles persist immediately and apply to new sessions; a chat already running may keep its current skills until its next session.',
    );
    const firstToggle = screen.getByRole('switch', { name: 'Enable web-search' });
    const lastToggle = screen.getByRole('switch', { name: 'Enable code-review' });
    expect(note.compareDocumentPosition(firstToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(lastToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
