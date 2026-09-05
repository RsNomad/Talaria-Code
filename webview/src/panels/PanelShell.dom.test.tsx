/**
 * DOM-level tests for `RemotePanel`'s loading busy semantics (audit-3 UI/UX
 * M-4). `RemotePanel` centralizes the idle/loading/error/success gate every
 * data panel renders through — see the block comment above it in
 * `PanelShell.tsx`. Before this fix the idle|loading branch returned a bare
 * `<EmptyPanel hint={loadingHint} />` with no ARIA signal that a fetch is in
 * flight, so a screen-reader user gets silence instead of "busy" (WAI-ARIA
 * `aria-busy` + `role="status"` is the standard live-region pattern for a
 * loading placeholder). The fix wraps ONLY that branch; success still
 * delegates straight to `children(data)` with no busy wrapper, and
 * `EmptyPanel` itself (shared by genuine non-loading empty states) is
 * untouched.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemotePanel, PanelShell, SectionLabel } from './PanelShell';
import type { RemoteData } from '../state/remoteData';
import { must } from '../testing/must';

/**
 * A11Y-03 (WCAG 1.3.1 / 2.4.6): the panel title used to be a plain `<span>`
 * and `SectionLabel` a plain `<div>` — AT saw NO document structure anywhere
 * in panel chrome, no heading to navigate to, no landmark naming the panel.
 * `PanelShell`'s title is now a real `<h2>` and the shell itself is a
 * `role="region"` named by that h2 (via `aria-labelledby`, so the string
 * lives in exactly one place); `SectionLabel` is now a real `<h3>` — both are
 * visual no-ops (Tailwind preflight zeroes heading margin/font-size, and
 * `.h-eyebrow` already fully defines the rendered appearance).
 */
describe('PanelShell — A11Y-03: real h2 + region landmark', () => {
  it('the panel title is a real h2 and the shell is a region named by it', () => {
    render(<PanelShell title="History">x</PanelShell>);
    expect(screen.getByRole('heading', { level: 2, name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument();
  });
});

describe('SectionLabel — A11Y-03: real h3 heading', () => {
  it('renders a level-3 heading', () => {
    render(<SectionLabel>Agent</SectionLabel>);
    expect(screen.getByRole('heading', { level: 3, name: 'Agent' })).toBeInTheDocument();
  });
});

describe('RemotePanel — B5 M-4: loading/idle announces busy status', () => {
  it('idle (remote=undefined) renders a role="status" element with aria-busy="true"', () => {
    render(
      <RemotePanel<string> remote={undefined} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading tools…');
  });

  it('loading status renders a role="status" element with aria-busy="true"', () => {
    const remote: RemoteData<string> = { status: 'loading' };
    render(
      <RemotePanel<string> remote={remote} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  /**
   * Task 17 (Finding-7, WV4-MIN, DELIBERATE pin update): success used to
   * render NO `role="status"` at all. It now always mounts exactly ONE —
   * the sr-only stale-data `LiveRegion` this task adds to `RemotePanel`'s
   * success branch (see the "Task 17" describe block below) — empty while
   * there is no refreshError. This test's real claim survives narrowed: the
   * B5 busy WRAPPER (the loading-branch's `aria-busy` idiom) never leaks
   * into success.
   */
  it('success status renders NO aria-busy wrapper — only the resolved children (+ the sr-only stale-data region, Task 17)', () => {
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    render(
      <RemotePanel<string> remote={remote} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    const status = screen.getByRole('status');
    expect(status).not.toHaveAttribute('aria-busy');
    expect(status.textContent).toBe('');
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});

/**
 * TI-3 (AU-42 Part B): `RemotePanel`'s new `refreshError` prop — a
 * background-refresh failure over `success` data renders a dismissible
 * banner ABOVE the resolved children, never replacing them (the SYSTEMIC
 * defect this task fixes: `local.panelError` used to wipe `success` back to
 * a bare `failure(...)` card unconditionally — see `state/panels.ts` and
 * `state/transcript.ts`). Omitting the prop (every pre-existing caller
 * above) renders byte-for-byte as before — pinned by the "success status
 * renders NO aria-busy wrapper" test just above, which passes no
 * `refreshError` and still finds no `role="status"` at all.
 */
describe('RemotePanel — TI-3 (AU-42 Part B): the refreshError banner', () => {
  /**
   * Task 17 (Finding-7, WV4-MIN, DELIBERATE pin update): this used to pin
   * "no role=status at all" for the omitted-refreshError case. Success now
   * ALWAYS mounts exactly one `role="status"` — the sr-only stale-data
   * `LiveRegion` below the resolved children — empty until refreshError
   * appears. The pin narrows to "exactly one, and it carries no text".
   */
  it('omitted refreshError (undefined): success renders exactly ONE role="status" (the sr-only region), empty', () => {
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    render(
      <RemotePanel<string> remote={remote} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(must(statuses[0]).textContent).toBe('');
  });

  it('present refreshError: renders the banner AND the resolved children — data is never wiped', () => {
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    render(
      <RemotePanel<string>
        remote={remote}
        loadingHint="Loading tools…"
        onRetry={() => undefined}
        refreshError={{ message: 'Agent is not connected yet.', onRetry: () => undefined, onDismiss: () => undefined }}
      >
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Couldn.t refresh/i);
    expect(screen.getByText('Agent is not connected yet.')).toBeInTheDocument();
    expect(screen.getByText('hello'), 'the previously-loaded data must stay visible').toBeInTheDocument();
  });

  it('a NON-success status (error) ignores refreshError entirely — the first-load error card still wins', () => {
    const remote: RemoteData<string> = { status: 'error', error: { message: 'nope', retryable: true } };
    render(
      <RemotePanel<string>
        remote={remote}
        loadingHint="Loading tools…"
        onRetry={() => undefined}
        refreshError={{ message: 'stale message', onRetry: () => undefined, onDismiss: () => undefined }}
      >
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    expect(screen.getByText('nope')).toBeInTheDocument();
    expect(screen.queryByText('stale message')).not.toBeInTheDocument();
  });

  it('Retry and Dismiss call their own handlers', async () => {
    const user = userEvent.setup();
    const retried: boolean[] = [];
    const dismissed: boolean[] = [];
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    render(
      <RemotePanel<string>
        remote={remote}
        loadingHint="Loading tools…"
        onRetry={() => undefined}
        refreshError={{
          message: 'Agent is not connected yet.',
          onRetry: () => retried.push(true),
          onDismiss: () => dismissed.push(true),
        }}
      >
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retried).toEqual([true]);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismissed).toEqual([true]);
  });
});

/**
 * Task 17 (Finding-7, WV4-MIN): the stale-data announcement itself now rides
 * an ALWAYS-mounted sr-only `LiveRegion` in the success branch, not the
 * visible banner's own (now dropped) `role="status"` — a region that mounts
 * together with its content is the known-unreliable screen-reader
 * announcement pattern this task closes out. MDN Live regions: "Start with
 * an empty live region, then – in a separate step – change the content
 * inside the region."
 */
describe('RemotePanel — Task 17 (Finding-7, WV4-MIN): permanently-mounted sr-only stale-data region', () => {
  it('the region exists (empty) with no refreshError, then fills once refreshError appears — the SAME node', () => {
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    const { rerender } = render(
      <RemotePanel<string> remote={remote} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    const status = screen.getByRole('status');
    expect(
      status,
      'the region must not carry the stale-data text before any refreshError, or the "already mounted" ' +
        'half of this test proves nothing',
    ).not.toHaveTextContent(/refresh/i);

    rerender(
      <RemotePanel<string>
        remote={remote}
        loadingHint="Loading tools…"
        onRetry={() => undefined}
        refreshError={{ message: 'Agent is not connected yet.', onRetry: () => undefined, onDismiss: () => undefined }}
      >
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );

    expect(
      screen.getByRole('status'),
      'the SAME node must update its text, not be unmounted and replaced — a fresh node would miss a ' +
        'live-region listener a screen reader attached at mount time',
    ).toBe(status);
    expect(status).toHaveTextContent('Couldn’t refresh — showing last loaded data.');
  });
});
