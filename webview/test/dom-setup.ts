/**
 * Setup for the `webview-dom` project ONLY (`vitest.config.ts`).
 *
 * `globals` is off repo-wide, so React Testing Library's auto-cleanup does not
 * install itself and cleanup MUST be manual. Skipping this is the classic
 * failure mode: without `cleanup()` the previous test's tree stays mounted,
 * `screen.getByRole` starts throwing "found multiple elements", and the
 * failure looks like a component bug rather than a config bug.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * Audit M-8. jsdom has no `ResizeObserver`, and `Composer.tsx:230` /
 * `PriorityTabs.tsx:148` both construct one on mount — so every DOM test of
 * the two most interaction-heavy components threw on render. This stub never
 * fires a callback: components must render and be operable without a resize
 * observation, and a test that needs a specific measured width should inject
 * it, not wait for an observer.
 *
 * Scoped to the `webview-dom` project only (this file is its `setupFiles`), so
 * the `host` and `webview-pure` projects are untouched.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub;

/**
 * B1: jsdom has no `scrollIntoView` implementation, and `ChatView.tsx`'s
 * pinned-to-bottom effect calls `endRef.current?.scrollIntoView(...)` on
 * every transcript change (including the initial mount) — so any DOM test
 * of `ChatView` with a non-empty transcript threw before rendering
 * anything. Same class of gap as the `ResizeObserver` stub above: stub the
 * browser API jsdom doesn't implement rather than have every consuming
 * test carry its own ad-hoc patch.
 */
Element.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
