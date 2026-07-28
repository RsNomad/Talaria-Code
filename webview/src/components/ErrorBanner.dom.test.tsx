import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBanner } from './ErrorBanner';

/**
 * UI I-6 / WCAG 2.2 SC 4.1.3. ErrorBanner is conditionally mounted by the
 * caller (App.tsx renders it only when `systemError`/tab `error` is set), so
 * the message text is already present the moment the element enters the DOM.
 * `role="alert"` is the one live role documented to announce content that
 * arrives already-populated (MDN Live_regions: "in most cases, the content
 * inside role="alert" regions is announced, even when the region ... is
 * present in the initial markup of the page, or injected dynamically into
 * the page" — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions).
 * `role="status"` requires an empty-then-fill two-step mount, which does not
 * fit this component's conditional-mount design (see path doc §2.1/§3 A1).
 * Precedent: `ErrorBoundary.tsx:71` already uses bare `role="alert"` with no
 * extra `aria-live` (MDN: doubling role=alert with aria-live=assertive risks
 * double-announcing).
 */
describe('ErrorBanner accessibility', () => {
  it('announces its message to screen readers via role=alert', () => {
    render(
      <ErrorBanner
        message="Connection to the model failed"
        dismissLabel="Dismiss"
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Connection to the model failed');
  });
});
