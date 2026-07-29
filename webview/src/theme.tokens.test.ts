/**
 * Audit-3 UI/UX I-1 (Task A-2) — regression lock for the `--h-faint` token
 * remap off `--vscode-disabledForeground`.
 *
 * `theme.css:26` used to derive the third text tier from
 * `--vscode-disabledForeground` — a token VS Code *intends* to be
 * sub-threshold (documented as "foreground for disabled elements", ~3.6:1
 * dark / ~2.3:1 light defaults). All 49 `text-faint` call sites in this
 * webview are ACTIVE content (approval deadline, tool input, inactive tab
 * labels) — none is a genuinely-disabled control (those use
 * `disabled:opacity-*` modifiers instead) — so WCAG 1.4.3's inactive-
 * component exception never applied, and the token was the wrong semantic
 * choice. Fork F-1(A) (remediation-architecture.md §2.2/§4): remap to
 * `--vscode-descriptionForeground`, the token VS Code defines for readable
 * secondary/description text, in one line, no per-site or component churn.
 *
 * `.tsx`/DOM assertions can't exercise the actual CSS cascade (jsdom does
 * not apply stylesheet files), so this is a text-level characterization
 * test on the source, in the same spirit as this repo's other
 * `readFileSync` lock tests (e.g. `src/shared/secretPaths.freeze.test.ts`,
 * `webview/src/index.css.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const THEME_CSS_PATH = join(__dirname, 'theme.css');

/** Extract the `--h-faint:` declaration line (and only that line). */
function extractFaintDeclaration(css: string): string {
  const match = css.match(/^\s*--h-faint:.*;\s*$/m);
  if (!match) {
    throw new Error('no `--h-faint:` declaration found in theme.css — has the token been renamed?');
  }
  return match[0];
}

describe('theme.css — audit-3 A-2: --h-faint reads off descriptionForeground, not disabledForeground', () => {
  it('the --h-faint declaration references --vscode-descriptionForeground', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    const decl = extractFaintDeclaration(css);
    expect(decl).toContain('--vscode-descriptionForeground');
  });

  it('the --h-faint declaration no longer references --vscode-disabledForeground', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    const decl = extractFaintDeclaration(css);
    expect(decl).not.toContain('--vscode-disabledForeground');
  });

  it('sanity: exactly one --h-faint declaration exists (the extraction isn\'t swallowing a sibling token)', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    const matches = css.match(/^\s*--h-faint:.*;\s*$/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});
