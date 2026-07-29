/*
 * W5.1 Task 13 (R5) — the two «Next Edit Suggestions» rows.
 *
 * The row LABELS and DESCRIPTIONS are owner-approved, frozen copy. They
 * are exported as data (`NEXT_EDIT_ROWS`) rather than buried in JSX precisely
 * so this file can lock them character-for-character: the honesty disclaimers
 * ("No published benchmark score exists for this model.", "vendor-reported,
 * unreplicated") are the whole point of the copy, and a well-meaning future
 * edit that "tightens" them would silently un-say them.
 *
 * The vendor-number discipline is a Global Constraint
 * (`09-jobB-final-plan.md`): every benchmark number reaching user-facing copy
 * carries "vendor-reported, unreplicated", NEXT has no published score at all,
 * and 81.28% belongs to an unreleased model and is quoted NOWHERE.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { must } from '../testing/must';
import { NEXT_EDIT_ROWS, NEXT_EDIT_SECTION_LABEL } from './SettingsPanel';

describe('Next Edit Suggestions rows — frozen owner-approved copy (08 §8)', () => {
  it('groups both rows under the pinned section heading (the R5 naming: «Next Edit Suggestions»)', () => {
    expect(NEXT_EDIT_SECTION_LABEL).toBe('Next Edit Suggestions');
  });

  it('renders NEXT first (the dedicated model is the flagship; Generic is the fallback) and exactly two rows', () => {
    expect(NEXT_EDIT_ROWS.map((r) => r.source)).toEqual(['next', 'generic']);
  });

  it('carries the NEXT row label + description verbatim', () => {
    const next = must(NEXT_EDIT_ROWS[0]);
    expect(next.label).toBe('Next Edit — dedicated model');
    expect(next.description).toBe(
      'Uses sweep-next-edit-v2-7B on its own endpoint (talaria.nextEdit.endpoint). No published benchmark score exists for this model. Mutually exclusive with Generic.',
    );
  });

  it('carries the Generic row label + description verbatim, including the vendor qualifier and the OLLAMA_CONTEXT_LENGTH pointer', () => {
    const generic = must(NEXT_EDIT_ROWS[1]);
    expect(generic.label).toBe('Next Edit — Generic via your FIM model');
    expect(generic.description).toBe(
      'Reuses your FIM model and endpoint with a different request shape. Quality ~55.62% (vendor-reported, unreplicated) — review every suggestion. Below 23 GiB VRAM set OLLAMA_CONTEXT_LENGTH=16384 on your server (see docs). Mutually exclusive with NEXT.',
    );
  });

  it('states plainly that NEXT has NO published score — never invents one', () => {
    expect(must(NEXT_EDIT_ROWS[0]).description).toContain('No published benchmark score exists for this model.');
  });

  it('never quotes 81.28% (an unreleased model’s number — quoted nowhere in shipped copy)', () => {
    for (const row of NEXT_EDIT_ROWS) {
      expect(row.description).not.toContain('81.28');
      expect(row.label).not.toContain('81.28');
    }
  });

  it('every benchmark number in the copy carries the vendor-reported qualifier', () => {
    for (const row of NEXT_EDIT_ROWS) {
      const quotesANumber = /\d+\.\d+%/.test(row.description);
      if (quotesANumber) expect(row.description).toContain('(vendor-reported, unreplicated)');
    }
  });

  it('names the mutual exclusion on BOTH rows — the refusal can then never be a surprise', () => {
    expect(must(NEXT_EDIT_ROWS[0]).description).toContain('Mutually exclusive with Generic.');
    expect(must(NEXT_EDIT_ROWS[1]).description).toContain('Mutually exclusive with NEXT.');
  });

  it('mentions no banned model family (no Devstral / zeta / sweep-v1 may appear in shipped copy)', () => {
    for (const row of NEXT_EDIT_ROWS) {
      const copy = `${row.label} ${row.description}`.toLowerCase();
      expect(copy).not.toContain('devstral');
      expect(copy).not.toContain('zeta');
      expect(copy).not.toContain('sweep-v1');
    }
  });
});

/*
 * ════════════════════════════════════════════════════════════════════════════
 * FIX WAVE 2 — F-7: the Next Edit toggles must not be gated on the AGENT.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * THE BUG. Both rows rendered only inside `<RemotePanel remote={globalPanels.
 * settings}>` (`App.tsx:656-671`), i.e. only after the Hermes agent answered
 * `panel.data`. But the toggles are pure extension `globalState`, served
 * HOST-INTERNALLY (`TalariaViewProvider.ts:591`) and pushed over
 * `nextEdit.state` into `AppState.nextEditToggles` — they need no agent at
 * all, and `state.nextEditToggles` is a top-level connection-global slice
 * that is populated whether or not any panel fetch ever resolves.
 *
 * So: user turns Generic on -> the Hermes CLI later fails to start -> Settings
 * shows "Couldn't load this panel" + Retry -> there is now NO WAY TO TURN
 * GENERIC OFF. By design these are not `settings.json` settings either
 * (`08` §8, owner: settings carry DATA, not STATE), so the only remaining
 * remedy is hand-editing `globalState`. An unrecoverable state reachable by
 * ordinary use.
 *
 * THE FIX is structural: `SettingsPanel` now takes the settings `RemoteData`
 * ITSELF (not resolved `SettingsData`) and owns the gate internally, wrapping
 * ONLY the config.yaml sections. The Next Edit section renders unconditionally
 * above it, in all four RemoteData states — idle, loading, error, success.
 *
 * WHY A SOURCE-STRUCTURE LOCK — corrected (final review, Finding 5).
 *
 * The original justification was "this repo has no jsdom and no
 * testing-library (an open owner decision), so 'the section is on screen while
 * the panel is errored' cannot be asserted against a rendered tree — there is
 * no tree." Wave 5.2 FALSIFIED that, and this was the worse of the two stale
 * justifications the final review found: it was the stated rationale for a
 * brittle source-structure lock of an invariant that is now ALSO locked
 * against a real rendered tree. `SettingsPanel.dom.test.tsx`'s "F-7 regression
 * lock" renders this panel in the loading, error and never-requested states
 * and asserts the section and both rows are present AND actionable.
 *
 * So the honest question is no longer "can this be rendered?" but "what does
 * this lock still prove that the DOM test cannot?" — and there is exactly one
 * answer, which is why the lock stays:
 *
 *   THE `App.tsx` HALF OF THE SEAM. The DOM test mounts `SettingsPanel`
 *   DIRECTLY. It therefore can never observe the caller, and the F-7 bug had
 *   two halves: the panel gating its own section, and `App.tsx` wrapping the
 *   whole panel in `<RemotePanel remote={globalPanels.settings}>`. Re-wrapping
 *   it in `App.tsx` restores the unrecoverable state EXACTLY — with
 *   `SettingsPanel` itself unchanged and every DOM assertion still green,
 *   because the panel it renders in isolation is still correct. Only a
 *   caller-side check catches that, and a DOM equivalent would mean rendering
 *   the whole `App` with a mocked connection just to observe a wrapper.
 *
 * The panel-side half below (`SettingsPanel renders the Next Edit rows OUTSIDE
 * its RemotePanel gate`) IS genuinely duplicated by the DOM test, and is kept
 * deliberately: it is the structural statement of the invariant, it names the
 * mechanism rather than a symptom in three sampled states, and it is what the
 * `App.tsx` check is written against — deleting it would leave the surviving
 * half asserting a containment rule whose other side nothing states.
 *
 * Every predicate below is proven against a PLANTED violation (the repo's
 * standing idiom, `coexistence.lock.test.ts`'s three rules) — a scan that
 * matches nothing passes forever, and this branch has already shipped six
 * guards that could never fail.
 */

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
 * `unpaired` is load-bearing, and it exists because a MUTATION of this very
 * lock got away during the fix wave: an opening tag whose close the token
 * regex fails to see records NO span at all, and "not inside any span" is then
 * trivially true — the scan reports the code is safe precisely when it can no
 * longer read the code. That is the same could-never-fail guard shape this
 * branch has now shipped six times. Real source is always balanced
 * (unbalanced JSX does not compile), so any unpaired open here means the
 * SCANNER is broken, and the reach test below fails loudly rather than
 * passing quietly.
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

describe('F-7: the Next Edit section is reachable with the agent backend DOWN', () => {
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
    // See `scanElements`'s doc: an open the scanner cannot pair records no
    // span, and every containment check below then passes for the worst
    // possible reason. Real JSX is always balanced, so a non-zero count here
    // means the token regex has stopped matching this codebase.
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

  it('SettingsPanel renders the Next Edit rows OUTSIDE its RemotePanel gate', () => {
    const sectionAt = settingsPanelSource.indexOf('NEXT_EDIT_ROWS.map');
    expect(sectionAt, 'reach: SettingsPanel.tsx must render NEXT_EDIT_ROWS.map').toBeGreaterThanOrEqual(0);

    const gates = elementSpans(settingsPanelSource, 'RemotePanel');
    expect(
      gates.length,
      'reach: SettingsPanel must still gate the config.yaml sections behind a RemotePanel — zero gates would pass the containment check for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      isInsideAny(sectionAt, gates),
      'F-7: the Next Edit rows must NOT render inside the RemotePanel gate — the toggles are extension globalState served host-internally and need no agent, so gating them on panel.data makes them unreachable (and Generic un-turn-off-able) whenever the Hermes CLI is down',
    ).toBe(false);
  });

  it('App.tsx does not re-wrap SettingsPanel in the gate it was just moved out of', () => {
    const panelAt = appSource.indexOf('<SettingsPanel');
    expect(panelAt, 'reach: App.tsx must render <SettingsPanel').toBeGreaterThanOrEqual(0);

    expect(
      isInsideAny(panelAt, elementSpans(appSource, 'RemotePanel')),
      'F-7: App.tsx must mount SettingsPanel UNCONDITIONALLY — it now owns its own gate for the config sections only. Wrapping it in a RemotePanel again restores the unrecoverable state exactly.',
    ).toBe(false);
  });

  it('SettingsPanel takes the settings RemoteData itself, so it CANNOT be mounted success-only', () => {
    // The compile-time half of the same guarantee: a caller holding only
    // resolved `SettingsData` can no longer satisfy this prop, so the
    // "render it after the fetch succeeds" shape does not typecheck.
    expect(
      settingsPanelSource,
      'F-7: SettingsPanel must accept the settings RemoteData (all four states), not a resolved SettingsData — that is what makes the success-only mounting the bug depended on un-expressible',
    ).toMatch(/config:\s*RemoteData<SettingsData>/);
  });

  it('RED-first proof: the SAME predicates flag the pre-fix (gated) structure', () => {
    // The exact shape the bug had: the section nested inside the gate.
    const gatedPanel = [
      '<PanelShell title="Talaria config">',
      '  <RemotePanel remote={config} loadingHint="Loading settings…" onRetry={onRetryConfig}>',
      '    {(data) => (<>',
      '      {NEXT_EDIT_ROWS.map((row) => (<NextEditRow key={row.source} />))}',
      '      {data.sections.map((s) => (<div key={s.name} />))}',
      '    </>)}',
      '  </RemotePanel>',
      '</PanelShell>',
    ].join('\n');
    expect(
      isInsideAny(gatedPanel.indexOf('NEXT_EDIT_ROWS.map'), elementSpans(gatedPanel, 'RemotePanel')),
      'RED-first proof failed: the pre-fix structure (rows nested inside the gate) was NOT flagged — the containment predicate cannot detect the very bug F-7 is about',
    ).toBe(true);

    const gatedApp = [
      "<RemotePanel remote={globalPanels.settings} loadingHint=\"Loading settings…\" onRetry={() => requestPanel('settings')}>",
      '  {(data) => (<SettingsPanel data={data} nextEdit={state.nextEditToggles} />)}',
      '</RemotePanel>',
    ].join('\n');
    expect(
      isInsideAny(gatedApp.indexOf('<SettingsPanel'), elementSpans(gatedApp, 'RemotePanel')),
      "RED-first proof failed: App.tsx's pre-fix wrapper was NOT flagged — the containment predicate would not catch a re-wrap",
    ).toBe(true);
  });

  it('the toggles stay CONNECTION-GLOBAL: the rows read the pushed state, never a per-tab slice', () => {
    // The F-1 discipline, at the RENDER seam rather than the RPC seam (which
    // `rpc.test.ts:164-199` owns). `nextEditToggles` is a top-level AppState
    // field precisely because the toggle store is one-per-extension; reading
    // it through the active TAB would tie a connection-global control to a
    // tab's lifetime — the shape of the wrong-session Composer-draft Critical
    // this webview has already shipped once. Moving the section out of the
    // panel gate is exactly the kind of restructure that invites it.
    expect(
      appSource,
      'F-1 discipline: the Next Edit rows must be fed from the connection-global state.nextEditToggles, never from a per-tab slice',
    ).toContain('nextEdit={state.nextEditToggles}');
    expect(
      appSource,
      'F-1 discipline: no per-tab source may feed the connection-global Next Edit rows',
    ).not.toMatch(/nextEdit=\{tab\./);
  });
});

