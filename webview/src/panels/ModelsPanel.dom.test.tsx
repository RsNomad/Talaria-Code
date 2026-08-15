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
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelsPanel } from './ModelsPanel';
import { must } from '../testing/must';

/** The "Active model" header card — scoped so a query for the active
 *  model's own label text never collides with the SAME label rendered again
 *  as a row button below it in the provider list. Two `closest('div')` hops:
 *  the eyebrow span's immediate parent is the `flex items-center
 *  justify-between` row; ITS parent is the outer rounded-card. */
function activeModelHeader() {
  const eyebrowRow = must(screen.getByText('Active model').closest('div'));
  return within(must(eyebrowRow.parentElement));
}

/**
 * TG-3 (AU-53, T-G architecture): audit seed CORRECTED — `ModelsPanel.tsx`
 * ALREADY prefers the active tab's live `activeModelId` (ACP-side truth,
 * the same source the composer chip trusts) over the config-plane
 * `data.currentModelId` via `resolveEffectiveModelId` (`modelSelection.ts`).
 * This is a LOCK, not a RED — it pins EXISTING-correct behavior so a future
 * refactor can't regress the precedence back to config-plane-first (the
 * Lens-3 F7 scenario the audit originally flagged). The pure decision is
 * already unit-locked in `modelSelection.test.ts`; this is the DOM-level
 * lock on its ACTUAL USAGE inside the panel — header label, provider slug,
 * and row `aria-current` must all follow the diverging `activeModelId`, not
 * the stale `data.currentModelId`.
 */
describe('TG-3 (AU-53): resolveEffectiveModelId precedence is LOCKED at its ModelsPanel call site', () => {
  it('the active-model header and row highlight follow the ACTIVE TAB\'s live model, not a diverging config-plane currentModelId', () => {
    render(
      <ModelsPanel
        data={{
          // Config-plane snapshot still says m1 (e.g. the default at mint) —
          // a live in-chat switch to m2 has already happened server-side.
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
        onSetModel={() => undefined}
        onAddProviderKey={() => undefined}
      />,
    );

    // Header must show the TAB's live model (Model Two), never the
    // config-plane snapshot (Model One) — a config-plane-first regression
    // would show "Model One" here instead.
    const header = activeModelHeader();
    expect(header.getByText('Model Two')).toBeInTheDocument();
    expect(header.queryByText('Model One')).not.toBeInTheDocument();

    // Row highlight must agree with the header — both derive from the SAME
    // `resolveEffectiveModelId` call, so they can never disagree with each
    // other or with the composer chip.
    expect(screen.getByRole('button', { name: 'Model Two' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Model One' })).not.toHaveAttribute('aria-current');
  });

  it('falls back to the config-plane currentModelId only when the tab has never picked/bound a model (activeModelId === null)', () => {
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
        activeModelId={null}
        onSetModel={() => undefined}
        onAddProviderKey={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Model One' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Model Two' })).not.toHaveAttribute('aria-current');
  });
});

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
        onAddProviderKey={() => undefined}
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
        onAddProviderKey={() => undefined}
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
        onAddProviderKey={() => undefined}
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
        onAddProviderKey={() => undefined}
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
        onAddProviderKey={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Model One' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Model Two' })).not.toHaveAttribute('aria-current');
  });
});

/**
 * CF-13/D1: the "Add provider key" button used to fire `onInvoke('model.save_key')`
 * with NO params and NO UI — dead on arrival (the harness requires
 * `{slug, api_key}`). It is replaced with a PER-PROVIDER "Add key" affordance
 * that posts only the provider's slug (`ModelProvider.id`, sourced from the
 * harness's `slug` — see `reshapeModelOptions`); the key itself is entered
 * host-side and never reaches this component.
 */
describe('CF-13/D1: the dead global "Add provider key" button is replaced by a per-provider affordance', () => {
  function setup(jsx: Parameters<typeof render>[0]) {
    return { user: userEvent.setup(), ...render(jsx) };
  }

  it('renders NO dead global "Add provider key" button', () => {
    render(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [{ id: 'p1', name: 'Ollama', connected: true, models: [{ id: 'm1', label: 'M1' }] }],
        }}
        activeModelId="m1"
        onSetModel={() => undefined}
        onAddProviderKey={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: /^add provider key$/i })).not.toBeInTheDocument();
  });

  it("each provider's \"Add key\" affordance posts THAT provider's own slug (the id field the harness's model.save_key expects)", async () => {
    const calls: string[] = [];
    const { user } = setup(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [
            { id: 'deepseek', name: 'DeepSeek', connected: false, models: [{ id: 'm1', label: 'M1' }] },
            { id: 'xai', name: 'xAI', connected: true, models: [{ id: 'm2', label: 'M2' }] },
          ],
        }}
        activeModelId="m1"
        onSetModel={() => undefined}
        onAddProviderKey={(slug) => calls.push(slug)}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add key for DeepSeek' }));
    await user.click(screen.getByRole('button', { name: 'Add key for xAI' }));

    expect(calls).toEqual(['deepseek', 'xai']);
  });

  it('beta.7 B4: the virtual MoA row renders NO "Add key" (model.save_key would refuse: unknown provider); real rows keep theirs', () => {
    render(
      <ModelsPanel
        data={{
          currentModelId: 'm1',
          providers: [
            { id: 'moa', name: 'Mixture of Agents', connected: true, virtual: true, models: [{ id: 'balanced', label: 'balanced' }] },
            { id: 'deepseek', name: 'DeepSeek', connected: false, models: [{ id: 'm1', label: 'M1' }] },
          ],
        }}
        activeModelId="m1"
        onSetModel={() => undefined}
        onAddProviderKey={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Add key for Mixture of Agents' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add key for DeepSeek' })).toBeInTheDocument();
  });
});
