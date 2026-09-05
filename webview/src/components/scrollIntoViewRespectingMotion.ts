/*
 * A11Y-02 (WCAG 2.3.3): native `scrollIntoView({behavior:'smooth'})` is not
 * a CSS transition, so NEITHER reduced-motion signal this webview receives
 * suppresses it by itself:
 *  - the OS media query (`prefers-reduced-motion: reduce`), and
 *  - VS Code's own `workbench.reduceMotion`, which reaches a webview ONLY as
 *    the `vscode-reduce-motion` class on <body> (see index.css:104's doc —
 *    the CSS kill-rule there covers transitions/animations, never JS scrolls).
 * ChatView checked only the media query; SetupPanel checked nothing. This is
 * the ONE shared source (ADR-UX) — every JS-initiated smooth scroll routes
 * through it. `matchMedia` is guarded (jsdom and some engines lack it),
 * mirroring the guard the old ChatView-local copy already carried.
 */
export function prefersReducedMotion(): boolean {
  const media =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const vscode =
    typeof document !== 'undefined' && document.body.classList.contains('vscode-reduce-motion');
  return media || vscode;
}

export function scrollIntoViewRespectingMotion(
  el: Element | null | undefined,
  opts?: Omit<ScrollIntoViewOptions, 'behavior'>,
): void {
  el?.scrollIntoView({ ...opts, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
