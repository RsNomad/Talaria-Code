/*
 * Chat-session tab strip (W4 §2e) — NOT the panel strip (`PriorityTabs`,
 * which switches side panels). From W4 on, "tab" means a chat-session tab
 * only; this renders `AppState.tabOrder`, highlights the active tab, and
 * offers "+" (open, capped at `MAX_TABS`) / "x" (close, kept while more than
 * one tab remains) affordances. A `pending`-bound tab shows a small spinner
 * so the "waiting on tab.bound" window is visible, not just an inert label.
 *
 * B2 (UI I-8) / path doc §2.2: implements the APG Tabs pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/, fetched live for this
 * task). `role="tab"` + `aria-selected` + roving `tabIndex` live on the
 * title BUTTON itself (the element that actually receives DOM focus) — the
 * surrounding `<div>` keeps layout/visual-state classes only, it is not part
 * of the ARIA tab semantics. Arrow keys move focus AND call `onSelect`
 * immediately (AUTOMATIC activation — APG: "It is recommended that tabs
 * activate automatically when they receive focus as long as their
 * associated tab panels are displayed without noticeable latency"; chat-tab
 * switching is instant local state, unlike `PriorityTabs` which stays
 * manual-activation and is NOT changed here). The close "×" button is a
 * sibling OUTSIDE the roving order (its own tab stop) and must stay visible
 * while it holds keyboard focus (WCAG 2.4.7 / F78,
 * https://www.w3.org/WAI/WCAG22/Techniques/failures/F78, fetched live for
 * this task: `opacity-0` gated only on `group-hover` hides the focus
 * indicator from keyboard users) — `focus-visible:opacity-100` +
 * `group-focus-within:opacity-100` fix that.
 *
 * B2 item 4 (path doc §4 B2, "aria-controls trio"): each tab additionally
 * carries `aria-controls={CHAT_TABPANEL_ID}` and a stable DOM `id`
 * (`tabDomId`) - APG: "Each element with role tab has the property
 * aria-controls referring to its associated tabpanel element" (ibid.). The
 * panel side (`role="tabpanel"` + `aria-labelledby`) lives on the ChatView
 * wrapper in `App.tsx`, which imports `tabDomId`/`CHAT_TABPANEL_ID` from
 * here so the two files can never drift onto different literal strings.
 * Only ONE chat tabpanel is ever mounted (the active tab's `ChatView`), so
 * every tab - active or not - points `aria-controls` at the same shared id;
 * that id resolves to real content only once its tab becomes active.
 */
import { useRef } from 'react';
import type { BackendKind } from '../protocol';
import type { TabState } from '../types';
import { Icon } from './Icon';
import { Pill } from './Pill';
import { nextRovingIndex } from './rovingIndex';

/**
 * B2 item 4: the single shared `id` of the chat tabpanel every tab's
 * `aria-controls` points at (App.tsx's ChatView wrapper). One constant
 * shared by both files instead of two independent string literals, so the
 * association cannot silently drift out of sync.
 */
export const CHAT_TABPANEL_ID = 'chat-tabpanel';

/** B2 item 4: the stable DOM `id` for a chat tab's `role="tab"` button,
 * given its `TabState.tabId`. App.tsx uses this to build the active tab's
 * `aria-labelledby` on the tabpanel wrapper — same derivation, one source of
 * truth, so the panel always labels the tab that is actually active. */
export function tabDomId(tabId: string): string {
  return `chat-tab-${tabId}`;
}

export interface TabStripProps {
  /** Tabs in `AppState.tabOrder` order. */
  tabs: TabState[];
  activeTabId: string;
  maxTabs: number;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onOpen: () => void;
  /**
   * D2 (A2): connection-global — which backend is LIVE. Renders a "Mock"
   * `Pill` in the trailing slot when `'mock'` (surfaces the silent
   * untrusted-workspace mock fallback, `trustGate.ts`'s
   * `selectBackendKind`); renders nothing for `'acp'`.
   */
  backendKind: BackendKind;
}

export function TabStrip({ tabs, activeTabId, maxTabs, onSelect, onClose, onOpen, backendKind }: TabStripProps) {
  const atCap = tabs.length >= maxTabs;
  const canClose = tabs.length > 1;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving Arrow/Home/End navigation, wrap at the ends (APG tabs). Automatic
  // activation: moving focus also calls `onSelect` — no separate Enter/Space
  // step, since switching a chat tab is instant local state.
  const onTabKey = (pos: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = nextRovingIndex(pos, e.key, tabs.length, { wrap: true });
    if (next === null) return;
    const nextTab = tabs[next];
    if (!nextTab) return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
    onSelect(nextTab.tabId);
  };

  return (
    <div
      role="tablist"
      aria-label="Chat sessions"
      className="flex flex-none items-center gap-1 overflow-x-auto border-b border-border bg-raised px-2 py-1"
    >
      {tabs.map((tab, pos) => {
        const active = tab.tabId === activeTabId;
        return (
          <div
            key={tab.tabId}
            className={`group flex flex-none items-center gap-1 rounded px-2 py-1 text-2xs transition-colors ${
              active ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-overlay hover:text-muted'
            }`}
          >
            <button
              ref={(el) => {
                tabRefs.current[pos] = el;
              }}
              type="button"
              id={tabDomId(tab.tabId)}
              role="tab"
              aria-selected={active}
              aria-controls={CHAT_TABPANEL_ID}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.tabId)}
              onKeyDown={(e) => onTabKey(pos, e)}
              title={tab.title}
              className="flex max-w-[9rem] items-center gap-1 truncate"
            >
              {tab.binding === 'pending' && (
                <Icon name="loading" size={10} spin className="flex-none" />
              )}
              <span className="truncate">{tab.title}</span>
            </button>
            {canClose && (
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.tabId);
                }}
                className="flex-none rounded p-0.5 opacity-0 hover:text-del group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
              >
                <Icon name="close" size={10} />
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        aria-label="New chat tab"
        title={atCap ? `Maximum ${maxTabs} tabs open` : 'New chat tab'}
        disabled={atCap}
        onClick={onOpen}
        className="flex-none rounded p-1 text-faint transition-colors hover:bg-overlay hover:text-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="add" size={12} />
      </button>

      {backendKind === 'mock' && (
        <span
          className="ml-auto flex-none"
          title="MockBackend — set talaria.backend to 'acp' and trust this workspace to run the real agent."
        >
          <Pill tone="warn">Mock</Pill>
        </span>
      )}
    </div>
  );
}
