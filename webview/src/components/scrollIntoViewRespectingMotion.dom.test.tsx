import { describe, it, expect, vi, afterEach } from 'vitest';
import { prefersReducedMotion, scrollIntoViewRespectingMotion } from './scrollIntoViewRespectingMotion';

afterEach(() => {
  document.body.className = '';
  vi.restoreAllMocks();
});

describe('A11Y-02: scrollIntoViewRespectingMotion honors BOTH reduced-motion signals', () => {
  it('body.vscode-reduce-motion alone forces behavior "auto" (jsdom has no matchMedia)', () => {
    document.body.classList.add('vscode-reduce-motion');
    const el = document.createElement('div');
    const spy = vi.spyOn(el, 'scrollIntoView').mockImplementation(() => undefined);
    scrollIntoViewRespectingMotion(el, { block: 'start' });
    expect(spy).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });
  it('no signal → smooth', () => {
    const el = document.createElement('div');
    const spy = vi.spyOn(el, 'scrollIntoView').mockImplementation(() => undefined);
    scrollIntoViewRespectingMotion(el, { block: 'start' });
    expect(spy).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });
  it('the OS media query alone forces "auto"', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);
    vi.unstubAllGlobals();
  });
  it('null/undefined element is a no-op, never a throw', () => {
    expect(() => scrollIntoViewRespectingMotion(null)).not.toThrow();
  });
});
