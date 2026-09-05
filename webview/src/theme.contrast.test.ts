import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const THEME_CSS = readFileSync(join(__dirname, 'theme.css'), 'utf-8');

/** Isolate the `body.vscode-light { … }` block so we only test the light tokens. */
function lightBlock(css: string): string {
  const m = css.match(/body\.vscode-light\s*\{([\s\S]*?)\}/);
  if (!m || m[1] === undefined) throw new Error('no body.vscode-light block in theme.css');
  return m[1];
}

function hexOf(block: string, token: string): string {
  const m = block.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m || m[1] === undefined) throw new Error(`no --${token} hex in body.vscode-light`);
  return m[1];
}

function channelLuminance(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}
function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function contrast(fgHex: string, bg: [number, number, number]): number {
  const l1 = relLuminance(rgb(fgHex));
  const l2 = relLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
/** A 15%-opacity tint hex composited over pure white (the soft-token background). */
function tintOverWhite(tintHex: string): [number, number, number] {
  const [r, g, b] = rgb(tintHex);
  const over = (c: number): number => Math.round(0.15 * c + 0.85 * 255);
  return [over(r), over(g), over(b)];
}

const WHITE: [number, number, number] = [255, 255, 255];

describe('A11Y-04: light-theme brand tokens clear WCAG AA (≥4.5:1)', () => {
  it('--h-accent is ≥4.5:1 on white (text/link/fill)', () => {
    expect(contrast(hexOf(lightBlock(THEME_CSS), 'h-accent'), WHITE)).toBeGreaterThanOrEqual(4.5);
  });
  it('--h-warn is ≥4.5:1 on white AND on its own soft tint', () => {
    const block = lightBlock(THEME_CSS);
    const warn = hexOf(block, 'h-warn');
    expect(contrast(warn, WHITE)).toBeGreaterThanOrEqual(4.5);
    // warn-soft is defined at :root (rgba(214,138,46,0.15)); its light-theme
    // background is that tint over white.
    expect(contrast(warn, tintOverWhite('#d68a2e'))).toBeGreaterThanOrEqual(4.5);
  });
  it('--h-del is ≥4.5:1 on white AND on its own soft tint', () => {
    const block = lightBlock(THEME_CSS);
    const del = hexOf(block, 'h-del');
    expect(contrast(del, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(del, tintOverWhite('#e05475'))).toBeGreaterThanOrEqual(4.5);
  });
  it('dark-theme accent is unchanged (regression guard — do not touch dark)', () => {
    // `[^}]*` (not `[\s\S]*`) keeps the match INSIDE the dark block: `#2dd4bf`
    // also appears in body.vscode-high-contrast and the standalone fallback, so
    // a greedy cross-block match would still pass on a real dark-accent
    // regression. rgba() values contain no `}`, so `[^}]*` cannot leave the block.
    expect(THEME_CSS).toMatch(/body\.vscode-dark\s*\{[^}]*--h-accent:\s*#2dd4bf/);
  });
});
