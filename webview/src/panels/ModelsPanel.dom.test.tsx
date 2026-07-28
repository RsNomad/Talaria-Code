/**
 * DOM-level tests for the Models panel's active-model header (Task 22,
 * G-10).
 *
 * Scope discipline (docs/testing/dom-tests.md): these prove WIRING — that the
 * ACTIVE model's provider `connected` state actually reaches the "Online" /
 * "Not connected" pill, not merely that the panel can compute it in the
 * abstract.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelsPanel } from './ModelsPanel';

describe('G-10: the Active model header does not claim a connection it cannot see', () => {
  it('shows "Online" only when the active model\'s provider reports connected', () => {
    render(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [{ id: 'p1', name: 'Ollama', connected: true, models: [{ id: 'm1', label: 'M1' }] }],
        }}
        activeModelId="m1"
        onSetModel={async () => undefined}
        onInvoke={async () => undefined}
      />,
    );
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('does NOT show "Online" when the active model\'s provider is not connected', () => {
    render(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [{ id: 'p1', name: 'Ollama', connected: false, models: [{ id: 'm1', label: 'M1' }] }],
        }}
        activeModelId="m1"
        onSetModel={async () => undefined}
        onInvoke={async () => undefined}
      />,
    );
    // The hardcoded pill sat directly above the provider's own "not connected"
    // marker — the panel contradicted itself on one screen.
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.getByText('not connected')).toBeInTheDocument();
  });
});

/**
 * B5 (path doc §4 B5, item 3 of 3 remaining): the active model row is
 * distinguished from the rest of the list only by an icon swap
 * (`pass-filled` vs `circle-large-outline`) and an accent text color — both
 * invisible to a screen-reader user. Fix: `aria-current={isActive ? 'true' :
 * undefined}` on the row button. MDN: aria-current marks "the current item
 * within a set" indicated to sighted users by styling alone
 * (https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current,
 * fetched this task).
 */
describe('B5: the active model row exposes aria-current (today it is icon+color only)', () => {
  it('the active row carries aria-current="true"; every other row carries none', () => {
    render(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [
            {
              id: 'p1',
              name: 'Ollama',
              connected: true,
              models: [
                { id: 'm1', label: 'Model One' },
                { id: 'm2', label: 'Model Two' },
              ],
            },
          ],
        }}
        activeModelId="m1"
        onSetModel={async () => undefined}
        onInvoke={async () => undefined}
      />,
    );

    // RED today: neither row carries aria-current at all.
    expect(screen.getByRole('button', { name: 'Model One' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Model Two' })).not.toHaveAttribute('aria-current');
  });

  it('aria-current follows the ACTIVE model when it changes — not a fixed row', () => {
    const { rerender } = render(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [
            {
              id: 'p1',
              name: 'Ollama',
              connected: true,
              models: [
                { id: 'm1', label: 'Model One' },
                { id: 'm2', label: 'Model Two' },
              ],
            },
          ],
        }}
        activeModelId="m2"
        onSetModel={async () => undefined}
        onInvoke={async () => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Model Two' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Model One' })).not.toHaveAttribute('aria-current');

    rerender(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [
            {
              id: 'p1',
              name: 'Ollama',
              connected: true,
              models: [
                { id: 'm1', label: 'Model One' },
                { id: 'm2', label: 'Model Two' },
              ],
            },
          ],
        }}
        activeModelId="m1"
        onSetModel={async () => undefined}
        onInvoke={async () => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Model One' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Model Two' })).not.toHaveAttribute('aria-current');
  });
});
