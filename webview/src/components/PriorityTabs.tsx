/*
 * Priority+ responsive tab strip.
 * ------------------------------------------------------------------
 * A hidden measurement layer records each tab's natural width in both its
 * labelled and icon-only forms; a ResizeObserver reports the live strip width.
 * From those two numbers we degrade progressively as space shrinks:
 *   1. leading tabs keep their label,
 *   2. tabs that no longer fit as labels collapse to icon-only,
 *   3. whatever still doesn't fit overflows into the `…` kebab on the RIGHT.
 * The active tab is always pulled into the visible row. Roving tabindex +
 * arrow-key navigation make the strip keyboard-operable.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { Panel } from '../protocol';
import { Icon } from './Icon';
import { OverflowMenu } from './OverflowMenu';
import { nextRovingIndex } from './rovingIndex';
import { CHAT_TABPANEL_ID } from './TabStrip';

export interface TabDef {
  id: Panel;
  label: string;
  icon: string;
}

/**
 * T-16 F9 (Tier-2 §12.1) — mirrors TabStrip.tsx's `tabDomId`/`CHAT_TABPANEL_ID`
 * "aria-controls trio" (path doc §4 B2, APG tabs:
 * https://www.w3.org/WAI/ARIA/apg/patterns/tabs/, fetched live for this task
 * — "Each element with role tab has the property aria-controls referring to
 * its associated tabpanel element"). PriorityTabs switches between 9 DISTINCT
 * panels (not one shared panel like TabStrip's chat sessions), so each tab
 * gets its own stable id / controls pair instead of one shared constant.
 */
export function panelTabDomId(panel: Panel): string {
  return `panel-tab-${panel}`;
}

/**
 * T-16 F9: the DOM id each PriorityTabs tab's `aria-controls` points at.
 * `chat` reuses the EXISTING `CHAT_TABPANEL_ID` — App.tsx's ChatView wrapper
 * already carries `role="tabpanel"` there for TabStrip's OWN chat-session
 * tabs, and that wrapper's content genuinely IS "the chat panel", so this
 * points at it directly instead of minting and mounting a second wrapper
 * (which would leave TWO simultaneous `role="tabpanel"` elements for the same
 * region). Every other panel gets a private id that App.tsx mounts a
 * dedicated wrapper for.
 */
export function panelTabpanelId(panel: Panel): string {
  return panel === 'chat' ? CHAT_TABPANEL_ID : `panel-tabpanel-${panel}`;
}

/** Panel priority order — earlier tabs keep their label / stay visible longer. */
const TABS: TabDef[] = [
  { id: 'chat', label: 'Chat', icon: 'comment-discussion' },
  { id: 'tools', label: 'Tools', icon: 'tools' },
  { id: 'mcp', label: 'MCP', icon: 'server-process' },
  { id: 'skills', label: 'Skills', icon: 'extensions' },
  { id: 'checkpoints', label: 'Checkpoints', icon: 'history' },
  { id: 'subagents', label: 'Subagents', icon: 'type-hierarchy' },
  { id: 'sessions', label: 'History', icon: 'archive' },
  { id: 'models', label: 'Models', icon: 'chip' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** Flex gap between chips, in px (matches the `gap-1` on the strip). */
const GAP = 4;

const CHIP =
  'flex flex-none items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 font-mono text-2xs uppercase tracking-wide';

interface Metrics {
  label: number[];
  icon: number[];
  kebab: number;
}

interface Row {
  tab: TabDef;
  form: 'label' | 'icon';
}

interface Layout {
  rows: Row[];
  overflow: TabDef[];
}

/** Solve the visible/overflow split for the current width from measured widths. */
function computeLayout(active: Panel, width: number, m: Metrics | null): Layout {
  // Before measurement (or zero width) render everything labelled; the hidden
  // pass reflows us on the next frame.
  if (!m || width <= 0) {
    return { rows: TABS.map((tab) => ({ tab, form: 'label' })), overflow: [] };
  }
  const n = TABS.length;

  // How many tabs fit at their icon-only (minimum) footprint, reserving the
  // kebab whenever at least one tab overflows.
  const iconFits = (v: number): boolean => {
    if (v <= 0) return true;
    let sum = GAP * (v - 1);
    for (let i = 0; i < v; i++) {
      // The hidden measurement layer renders exactly `TABS.length` icon spans
      // (unconditional `TABS.map`, read back in the layout-effect AFTER
      // commit), so `m.icon` always has `n` entries and `i < v <= n` is
      // always in range — this guard cannot fail in practice, but the type
      // can't express that, so it stays an honest runtime check.
      const w = m.icon[i];
      if (w === undefined) continue;
      sum += w;
    }
    if (v < n) sum += m.kebab + GAP;
    return sum <= width;
  };
  let visible = n;
  while (visible > 0 && !iconFits(visible)) visible--;
  visible = Math.max(1, visible);

  // Of those visible tabs, how many leading ones can keep their full label.
  const labelFits = (labelled: number): boolean => {
    let sum = GAP * (visible - 1);
    for (let i = 0; i < visible; i++) {
      const w = i < labelled ? m.label[i] : m.icon[i];
      if (w === undefined) continue; // same invariant as iconFits above
      sum += w;
    }
    if (visible < n) sum += m.kebab + GAP;
    return sum <= width;
  };
  let labelled = visible;
  while (labelled > 0 && !labelFits(labelled)) labelled--;

  // Visible indices are the leading prefix; if the active tab fell into the
  // overflow, swap it into the last visible slot so it's always reachable.
  const idx: number[] = [];
  for (let i = 0; i < visible; i++) idx.push(i);
  const activeIdx = TABS.findIndex((t) => t.id === active);
  if (activeIdx >= visible) idx[visible - 1] = activeIdx;

  const shown = new Set(idx);
  // `idx` entries are either `< n` (the leading-prefix loop above) or
  // `activeIdx` (a `TABS.findIndex` result) — TABS enumerates every `Panel`
  // value 1:1, so `active` always matches and `activeIdx` is never -1. Both
  // sources are therefore always valid TABS indices; the check below is an
  // honest guard for that invariant, not a lie.
  const rows: Row[] = [];
  for (const [pos, i] of idx.entries()) {
    const tab = TABS[i];
    if (tab === undefined) continue;
    rows.push({ tab, form: pos < labelled ? 'label' : 'icon' });
  }
  const overflow = TABS.filter((_, i) => !shown.has(i));
  return { rows, overflow };
}

interface PriorityTabsProps {
  active: Panel;
  onSelect: (panel: Panel) => void;
}

export function PriorityTabs({ active, onSelect }: PriorityTabsProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [width, setWidth] = useState(0);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  // Measure the hidden layer once mounted, then again after fonts settle (label
  // widths depend on the VS Code UI font, which may load after first paint).
  useLayoutEffect(() => {
    const readWidths = () => {
      const el = measureRef.current;
      if (!el) return;
      const labels = Array.from(el.querySelectorAll<HTMLElement>('[data-m="label"]'));
      const icons = Array.from(el.querySelectorAll<HTMLElement>('[data-m="icon"]'));
      const kebab = el.querySelector<HTMLElement>('[data-m="kebab"]');
      setMetrics({
        label: labels.map((n) => n.offsetWidth),
        icon: icons.map((n) => n.offsetWidth),
        kebab: kebab?.offsetWidth ?? 28,
      });
    };
    readWidths();
    let cancelled = false;
    const fonts = document.fonts;
    if (fonts?.ready) {
      fonts.ready.then(() => {
        if (!cancelled) readWidths();
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Track the live strip width.
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const { rows, overflow } = computeLayout(active, width, metrics);

  // Arrow-key roving across the visible tabs (the selected tab is the tab
  // stop). Manual activation — this only moves DOM focus; `onSelect` fires
  // separately on click/Enter/Space (unchanged; PriorityTabs is NOT switched
  // to automatic activation — path doc §2.2/B2 CHANGED-vs-draft item 2).
  // B2: index arithmetic now shared with TabStrip via `nextRovingIndex`
  // (`wrap: true`, same as this hand-rolled math it replaces).
  const onTabKey = (pos: number, e: React.KeyboardEvent) => {
    const next = nextRovingIndex(pos, e.key, rows.length, { wrap: true });
    if (next === null) return;
    e.preventDefault();
    btnRefs.current[next]?.focus();
  };

  return (
    <div className="relative flex-none border-b border-border bg-raised">
      {/* T-16 F9: `rowRef` (the ResizeObserver measurement target) stays on
          this OUTER row so its measured width is unaffected by the nesting
          below. `role="tablist"` moves down onto the INNER div that wraps
          ONLY the mapped tab buttons — the overflow `…` trigger is a
          `role="menu"`-owning button, not a tab, and APG's tablist container
          is defined to hold tab elements; a non-tab control living inside it
          was a structural bug (WV-2's sibling finding in the same audit
          pass), fixed here by making it a SIBLING of the tablist instead of
          a child. `gap-1` on both levels reproduces the previous flat
          spacing exactly (uniform gap between every adjacent item). */}
      <div ref={rowRef} className="flex items-center gap-1 px-2 py-1">
        <div role="tablist" aria-label="Panels" className="flex items-center gap-1">
          {rows.map(({ tab, form }, pos) => {
            const on = tab.id === active;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  btnRefs.current[pos] = el;
                }}
                type="button"
                id={panelTabDomId(tab.id)}
                role="tab"
                aria-selected={on}
                aria-controls={panelTabpanelId(tab.id)}
                tabIndex={on ? 0 : -1}
                title={form === 'icon' ? tab.label : undefined}
                aria-label={form === 'icon' ? tab.label : undefined}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(e) => onTabKey(pos, e)}
                className={`${CHIP} transition-colors ${
                  on ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-overlay hover:text-muted'
                }`}
              >
                <Icon name={tab.icon} size={12} />
                {form === 'label' && tab.label}
              </button>
            );
          })}
        </div>

        {overflow.length > 0 && <OverflowMenu items={overflow} active={active} onSelect={onSelect} />}
      </div>

      {/* Hidden measurement layer — never painted, never in the layout flow. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex gap-1"
      >
        {TABS.map((t) => (
          <span key={`l-${t.id}`} data-m="label" className={CHIP}>
            <Icon name={t.icon} size={12} />
            {t.label}
          </span>
        ))}
        {TABS.map((t) => (
          <span key={`i-${t.id}`} data-m="icon" className={CHIP}>
            <Icon name={t.icon} size={12} />
          </span>
        ))}
        <span data-m="kebab" className="flex items-center rounded px-1.5 py-1">
          <Icon name="ellipsis" size={16} />
        </span>
      </div>
    </div>
  );
}
