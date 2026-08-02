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

/**
 * AUDIT-5 UI M-1 (Task 7 redesign) — the three-tier text ladder must be three
 * tiers IN-EDITOR. `--h-muted` becomes the color-mix midpoint of the theme's
 * two text anchors; `--h-faint` stays on descriptionForeground (the safe
 * floor — audit-3 A-2 above is UNTOUCHED and must stay green). Contrast
 * grounding: docs_claude/audit5-remediation-architecture.md, Addendum 2.
 */
function extractMutedDeclaration(css: string): string {
  const match = css.match(/^\s*--h-muted:.*;\s*$/m);
  if (!match) {
    throw new Error('no `--h-muted:` declaration found in theme.css — has the token been renamed?');
  }
  return match[0];
}

/** All --vscode-* variables referenced by a declaration line, deduped+sorted. */
function vscodeVarsOf(decl: string): string[] {
  return [...new Set(decl.match(/--vscode-[a-zA-Z-]+/g) ?? [])].sort();
}

describe('theme.css — AUDIT-5 UI M-1: --h-muted is a real middle tier, distinct from --h-faint in-editor', () => {
  it('muted does not resolve to the same --vscode-* variable set as faint (the tier-collapse pin)', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    expect(vscodeVarsOf(extractMutedDeclaration(css))).not.toEqual(vscodeVarsOf(extractFaintDeclaration(css)));
  });

  it('muted is the color-mix(in srgb) midpoint of foreground and descriptionForeground', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    const decl = extractMutedDeclaration(css);
    expect(decl).toContain('color-mix(in srgb');
    expect(decl).toContain('--vscode-foreground');
    expect(decl).toContain('--vscode-descriptionForeground');
  });

  it('regression pin (green both sides): muted never references --vscode-disabledForeground (audit-3 A-2 guarantee extended to the middle tier)', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    expect(extractMutedDeclaration(css)).not.toContain('--vscode-disabledForeground');
  });

  it('regression pin (green both sides): faint stays the plain descriptionForeground floor (no color-mix on the faint tier)', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    expect(extractFaintDeclaration(css)).not.toContain('color-mix');
  });

  it('sanity: exactly one --h-muted declaration exists', () => {
    const css = readFileSync(THEME_CSS_PATH, 'utf-8');
    const matches = css.match(/^\s*--h-muted:.*;\s*$/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});
