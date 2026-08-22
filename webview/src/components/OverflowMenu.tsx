/*
 * The Priority+ overflow kebab. Holds the panel tabs that don't fit in the
 * strip; opens a `role="menu"` on the RIGHT. Fully keyboard-driven: Arrow keys
 * rove, Enter/Space activate, Esc (or an outside click) closes and returns
 * focus to the `…` trigger.
 *
 * Task 20 (WV4-MIN): the open/focus-first/roving/Home/End/Escape/Tab contract
 * now lives in the shared `useMenuFocus` hook (this was the second call site
 * after AttachMenu/the Composer pickers — see the hook's own doc comment for
 * the full contract and grounding). `OverflowMenu.dom.test.tsx` characterizes
 * the three pieces of behavior below that stay LOCAL — the hook's own doc
 * scopes them out deliberately — and must stay green, unmodified, across
 * this refactor: that is the proof it preserved behavior exactly.
 */
import { useEffect, useRef } from 'react';
import type { Panel } from '../protocol';
import { Icon } from './Icon';
import type { TabDef } from './PriorityTabs';
import { useMenuFocus } from '../hooks/useMenuFocus';

interface OverflowMenuProps {
  items: TabDef[];
  active: Panel;
  onSelect: (panel: Panel) => void;
}

export function OverflowMenu({ items, active, onSelect }: OverflowMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menu = useMenuFocus(items.length, triggerRef);

  // Audit G-4: reading `items`/`active` through a ref refreshed every render
  // (react.dev's "latest ref" pattern) rather than closing over the render's
  // own values directly keeps this file consistent with how the rest of this
  // component reads props that change on every parent render (`items` is a
  // FRESH ARRAY each time — PriorityTabs.tsx:207 passes items={overflow},
  // recomputed by computeLayout() every render; neither it nor App.tsx's
  // callers memoise it). Parking focus on the ACTIVE item now happens
  // ONCE, imperatively, from the trigger's own open handlers below (via
  // `menu.openMenuAt`) rather than from a `[open, items, active]`-keyed
  // effect — the effect was the original source of the G-4 bug (a fresh
  // `items` array re-ran it every frame during a streaming turn and dragged
  // focus back to the parked item); an imperative call made once, at the
  // moment the menu is asked to open, has no re-run-on-every-render surface
  // at all.
  const latest = useRef({ items, active });
  latest.current = { items, active };

  const openAtActive = () => {
    const { items: currentItems, active: currentActive } = latest.current;
    const ai = currentItems.findIndex((i) => i.id === currentActive);
    menu.openMenuAt(ai >= 0 ? ai : 0);
  };

  // Dismiss on an outside pointer press. Deliberately local — the shared
  // hook's own doc scopes this out (every call site needs its own
  // trigger-node check, to avoid the opening click immediately re-closing
  // the menu). `closeMenu(false)`: an outside click does not refocus the
  // trigger, matching this effect's pre-extraction behavior.
  useEffect(() => {
    if (!menu.open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) menu.closeMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `menu.closeMenu`
    // is a fresh function identity every render (the hook doesn't memoize
    // it); depending on it would re-attach this listener every render for no
    // behavioral difference. `menu.open` is the only dependency that should
    // re-run this effect.
  }, [menu.open]);

  // T-16 WV-2: if `items` SHRINKS while the menu is open (PriorityTabs'
  // Priority+ layout regains room and an overflowed tab moves back into the
  // visible strip — a live re-render, not a keypress), a stale `focusIdx`
  // can point PAST the new end. No rendered item then matches `i ===
  // focusIdx` (the roving tabIndex breaks) and the button that used to hold
  // DOM focus is now unmounted, so the browser silently drops focus to
  // `<body>` — invisible to a keyboard user. Clamp back into range and
  // re-park focus on the new valid item at that index via the hook's
  // `focusItem`.
  //
  // Keyed on `items.length` (a primitive), NOT `items` itself — Audit G-4
  // above is the cautionary tale for why: `items` is a fresh array every
  // parent render, so depending on the array reference would re-run (and
  // re-park focus) on every render, not just a genuine shrink. `menu.focusIdx`
  // is read fresh via the closure each run; it does not need to be a
  // dependency for correctness, but including it keeps the effect honest
  // about what it reads and re-checks after the index itself changes (e.g. a
  // rapid shrink-then-shrink-further).
  useEffect(() => {
    if (!menu.open) return;
    if (items.length === 0) return;
    if (menu.focusIdx <= items.length - 1) return;
    menu.focusItem(items.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // NOT depending on `items` (only its `.length`), same reasoning as the
    // G-4 park-on-open note above.
  }, [menu.open, items.length, menu.focusIdx]);

  return (
    <div className="relative ml-auto flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title="More panels"
        aria-label="More panels"
        onClick={() => {
          if (menu.open) {
            menu.closeMenu();
          } else {
            openAtActive();
          }
        }}
        onKeyDown={(e) => {
          if (!menu.open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openAtActive();
          }
        }}
        className={`flex items-center rounded px-1.5 py-1 text-faint transition-colors hover:bg-overlay hover:text-muted ${
          menu.open ? 'bg-overlay text-fg' : ''
        }`}
      >
        <Icon name="ellipsis" size={16} />
      </button>

      {menu.open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More panels"
          onKeyDown={menu.onMenuKey}
          className="absolute right-0 top-full z-30 mt-1 min-w-[168px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg"
        >
          {items.map((it, i) => (
            <button
              key={it.id}
              ref={menu.itemRef(i)}
              role="menuitem"
              type="button"
              tabIndex={i === menu.focusIdx ? 0 : -1}
              aria-current={it.id === active ? 'page' : undefined}
              onClick={() => {
                onSelect(it.id);
                menu.closeMenu();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-2xs uppercase tracking-wide transition-colors hover:bg-accent-soft hover:text-fg ${
                it.id === active ? 'text-accent' : 'text-muted'
              }`}
            >
              <Icon name={it.icon} size={13} className="flex-none" />
              <span className="truncate">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
