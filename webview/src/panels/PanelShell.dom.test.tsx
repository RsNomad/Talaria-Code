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
import { RemotePanel } from './PanelShell';
import type { RemoteData } from '../state/remoteData';

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

  it('success status renders NO aria-busy wrapper — only the resolved children', () => {
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    render(
      <RemotePanel<string> remote={remote} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
  it('omitted refreshError (undefined): success renders with no banner, no role="status" at all', () => {
    const remote: RemoteData<string> = { status: 'success', data: 'hello' };
    render(
      <RemotePanel<string> remote={remote} loadingHint="Loading tools…" onRetry={() => undefined}>
        {(data) => <div>{data}</div>}
      </RemotePanel>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
