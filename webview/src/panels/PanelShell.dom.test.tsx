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
