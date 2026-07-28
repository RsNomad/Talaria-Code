/**
 * Tier-2 T-15, F12 — characterization lock for the reduced-motion kill rules.
 *
 * `@media (prefers-reduced-motion: reduce)` only fires from the OS-level
 * setting. VS Code's own `workbench.reduceMotion` preference does NOT set
 * that OS media feature — it reaches a webview only as the `vscode-reduce-
 * motion` class VS Code adds to the webview's `<body>` element (VS Code
 * webview API guide, fetched live for this task:
 * https://code.visualstudio.com/api/extension-guides/webview — "the class
 * `vscode-reduce-motion` will be added to the document's main body element
 * in cases where the user has expressed a preference to reduce the amount
 * of motion in the window"; confirmed against VS Code core source,
 * `src/vs/workbench/contrib/webview/browser/pre/index.html`, which does
 * exactly `body.classList.add('vscode-reduce-motion')`). Without a
 * `body.vscode-reduce-motion` rule duplicating the kill, a user who set
 * `workbench.reduceMotion` but whose OS has no reduced-motion preference
 * gets none of Hermes' own animations suppressed.
 *
 * `.tsx`/DOM assertions can't exercise actual CSS cascade rules (jsdom does
 * not apply stylesheet files), so this is a text-level characterization
 * test on the source, in the same spirit as this repo's other `readFileSync`
 * lock tests (e.g. `src/shared/secretPaths.freeze.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_PATH = join(__dirname, 'index.css');

describe('index.css — F12: reduced-motion kill rules apply under both the OS signal and VS Code\'s own', () => {
  it('keeps the existing OS-level @media (prefers-reduced-motion: reduce) rule', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
  });

  it('adds a body.vscode-reduce-motion rule for VS Code\'s own workbench.reduceMotion signal', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    // RED today: no `vscode-reduce-motion` selector exists in the file yet.
    expect(css).toMatch(/body\.vscode-reduce-motion/);
  });

  it('the vscode-reduce-motion rule kills the same three properties as the OS media query', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    const match = css.match(/body\.vscode-reduce-motion[^{]*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const body = match ? match[1] : '';
    expect(body).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });
});
