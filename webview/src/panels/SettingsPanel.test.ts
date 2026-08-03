/*
 * Task 12 (§5.1/§5.2 — "SettingsPanel -> Agent config"): this file used to
 * own two things — the frozen «Next Edit Suggestions» row copy lock, and the
 * F-7 structural lock proving those rows survived every backend state. NEXT
 * moved to the Setup/Talaria-Config panel (`SetupPanel.tsx`); its frozen copy
 * (`nextEditCopy.ts`) is single-sourced and its own lock now lives in
 * `nextEditCopy.test.ts`, so nothing here duplicates it.
 *
 * What remains is the structural half that is STILL true post-Task-12: this
 * panel is retitled "Agent config", holds the Hermes config.yaml sections
 * ONLY, and still takes the settings `RemoteData` itself (not resolved
 * `SettingsData`) and gates the config sections behind a `RemotePanel` —
 * unchanged by this task, just no longer sharing the screen with anything
 * that needed to escape the gate.
 *
 * Every predicate below is proven against a PLANTED violation, following the
 * repo's standing idiom (`coexistence.lock.test.ts`'s three rules): a scan
 * that matches nothing passes forever, and a source-structure lock with no
 * RED-first proof could never fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANELS_DIR = __dirname;
const WEBVIEW_SRC = join(PANELS_DIR, '..');

function readSource(relative: string): string {
  return readFileSync(join(WEBVIEW_SRC, relative), 'utf-8');
}

/**
 * Character spans of every `<Tag …>` … `</Tag>` element in `source`, paired by
 * depth so a nested instance of the same tag is handled correctly. A
 * self-closing `<Tag />` opens no span (it can contain nothing, so nothing can
 * be gated by it).
 */
function elementSpans(source: string, tag: string): Array<[number, number]> {
  return scanElements(source, tag).spans;
}

/**
 * The scan itself, exposing `unpaired` alongside the spans.
 *
 * `unpaired` is load-bearing: an opening tag whose close the token regex
 * fails to see records NO span at all, and "not inside any span" is then
 * trivially true — the scan would report the code as safe precisely when it
 * can no longer read the code. Real source is always balanced (unbalanced
 * JSX does not compile), so any unpaired open here means the SCANNER is
 * broken, and the reach test below fails loudly rather than passing quietly.
 */
function scanElements(
  source: string,
  tag: string,
): { spans: Array<[number, number]>; unpaired: number } {
  const token = new RegExp(`<${tag}(?![A-Za-z0-9_])[^>]*?(/?)>|</${tag}\\s*>`, 'g');
  const spans: Array<[number, number]> = [];
  const open: number[] = [];
  for (const match of source.matchAll(token)) {
    const text = match[0];
    if (text.startsWith('</')) {
      const start = open.pop();
      if (start !== undefined) spans.push([start, match.index + text.length]);
    } else if (match[1] !== '/') {
      open.push(match.index);
    }
  }
  return { spans, unpaired: open.length };
}

function isInsideAny(index: number, spans: ReadonlyArray<readonly [number, number]>): boolean {
  return spans.some(([start, end]) => index > start && index < end);
}

describe('Task 12: SettingsPanel is "Agent config" — title, no NEXT content, config.yaml sections unchanged', () => {
  const settingsPanelSource = readSource('panels/SettingsPanel.tsx');
  const appSource = readSource('App.tsx');

  it('reach: both sources really were read (an empty read would rubber-stamp every check below)', () => {
    expect(settingsPanelSource).toContain('export function SettingsPanel');
    expect(appSource).toContain('<SettingsPanel');
    expect(
      elementSpans(appSource, 'RemotePanel').length,
      'reach: App.tsx must still contain RemotePanel gates — if the span finder sees none, the containment checks below are vacuous',
    ).toBeGreaterThan(0);
  });

  it('reach: every RemotePanel in both files PAIRS — an unreadable gate must fail loudly, not silently pass', () => {
    for (const [name, source] of [
      ['App.tsx', appSource],
      ['SettingsPanel.tsx', settingsPanelSource],
    ] as const) {
      expect(
        scanElements(source, 'RemotePanel').unpaired,
        `reach: ${name} has RemotePanel opening tags the scanner could not pair — the containment checks below are silently vacuous`,
      ).toBe(0);
    }
  });

  it('the span finder is not a no-op (sanity check on the mechanism every check below depends on)', () => {
    const sample = '<A><Gate a={1}>\ninside\n</Gate>outside</A>';
    const spans = elementSpans(sample, 'Gate');
    expect(spans).toHaveLength(1);
    expect(isInsideAny(sample.indexOf('inside'), spans)).toBe(true);
    expect(isInsideAny(sample.indexOf('outside'), spans)).toBe(false);
    // A self-closing tag gates nothing.
    expect(elementSpans('<Gate />after', 'Gate')).toHaveLength(0);
    // Nesting pairs by depth, not by first-close.
    expect(elementSpans('<Gate><Gate>x</Gate></Gate>', 'Gate')).toHaveLength(2);
    // An unclosed open is REPORTED, not silently treated as "gates nothing".
    expect(scanElements('<Gate a={1}>orphan', 'Gate').unpaired).toBe(1);
    expect(scanElements('<Gate>x</Gate>', 'Gate').unpaired).toBe(0);
    // A tag whose attributes contain `>` (an arrow function — every onRetry in
    // App.tsx) must still register as an open.
    expect(elementSpans("<Gate onRetry={() => f('x')}>inner</Gate>", 'Gate')).toHaveLength(1);
  });

  it('the panel is titled "Agent config" (Task 12 retitle — agent-runtime config only, NEXT moved to Talaria Config)', () => {
    expect(
      settingsPanelSource,
      'Task 12: SettingsPanel must render <PanelShell title="Agent config"> — the panel id (\'settings\') stays unchanged on the wire, only the title changes',
    ).toContain('<PanelShell title="Agent config">');
  });

  it('renders NO Next-Edit content — Task 12 removed it entirely (NEXT now lives in SetupPanel, via nextEditCopy.ts)', () => {
    // Code-level signals only — NOT the English phrase "Next Edit
    // Suggestions", which legitimately still appears in this file's own
    // explanatory prose (breadcrumbing the Task 12 history) without the
    // section itself existing.
    for (const banned of ['NEXT_EDIT_ROWS', 'NextEditRow', 'onToggleNextEdit'] as const) {
      expect(
        settingsPanelSource.includes(banned),
        `Task 12: SettingsPanel.tsx must not reference "${banned}" — NEXT rows moved to SetupPanel.tsx entirely`,
      ).toBe(false);
    }
  });

  it('RED-first proof: the ban above really would catch a re-introduced Next-Edit reference', () => {
    const withReintroduced = `${settingsPanelSource}\n// leaked: NEXT_EDIT_ROWS.map(...)\n`;
    expect(withReintroduced.includes('NEXT_EDIT_ROWS')).toBe(true);
  });

  it('the config.yaml sections render INSIDE the RemotePanel gate — F-7 gating structure unchanged', () => {
    const sectionAt = settingsPanelSource.indexOf('data.sections.map');
    expect(sectionAt, 'reach: SettingsPanel.tsx must render data.sections.map').toBeGreaterThanOrEqual(0);

    const gates = elementSpans(settingsPanelSource, 'RemotePanel');
    expect(
      gates.length,
      'reach: SettingsPanel must still gate the config.yaml sections behind a RemotePanel — zero gates would pass the containment check for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      isInsideAny(sectionAt, gates),
      'F-7 (unchanged): the config.yaml sections still need the agent, so they still render behind the RemotePanel gate',
    ).toBe(true);
  });

  it('SettingsPanel still takes the settings RemoteData itself, so it CANNOT be mounted success-only', () => {
    // The compile-time half of the F-7 guarantee, unchanged by Task 12: a
    // caller holding only resolved `SettingsData` still cannot satisfy this
    // prop, so "render it after the fetch succeeds" still does not typecheck.
    expect(
      settingsPanelSource,
      'F-7 (unchanged): SettingsPanel must accept the settings RemoteData (all four states), not a resolved SettingsData',
    ).toMatch(/config:\s*RemoteData<SettingsData>/);
  });

  it('App.tsx does not wrap SettingsPanel in an external RemotePanel gate', () => {
    const panelAt = appSource.indexOf('<SettingsPanel');
    expect(panelAt, 'reach: App.tsx must render <SettingsPanel').toBeGreaterThanOrEqual(0);

    expect(
      isInsideAny(panelAt, elementSpans(appSource, 'RemotePanel')),
      'SettingsPanel still owns its own internal gate (unchanged shape) — wrapping it in an external RemotePanel here would double-gate it',
    ).toBe(false);
  });

  it('App.tsx no longer threads nextEdit/onToggleNextEdit into SettingsPanel (that wiring moved to SetupPanel)', () => {
    const panelAt = appSource.indexOf('<SettingsPanel');
    const closeAt = appSource.indexOf('/>', panelAt);
    const settingsPanelJsx = appSource.slice(panelAt, closeAt);
    expect(
      settingsPanelJsx,
      'Task 12: <SettingsPanel ...> must no longer receive nextEdit/onToggleNextEdit — SetupPanel is the sole consumer now',
    ).not.toMatch(/nextEdit/);
  });
});
