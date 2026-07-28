/*
 * The Priority+ overflow kebab. Holds the panel tabs that don't fit in the
 * strip; opens a `role="menu"` on the RIGHT. Fully keyboard-driven: Arrow keys
 * rove, Enter/Space activate, Esc (or an outside click) closes and returns
 * focus to the `…` trigger.
 */
import { useEffect, useRef, useState } from 'react';
import type { Panel } from '../protocol';
import { Icon } from './Icon';
import type { TabDef } from './PriorityTabs';

interface OverflowMenuProps {
  items: TabDef[];
  active: Panel;
  onSelect: (panel: Panel) => void;
}

export function OverflowMenu({ items, active, onSelect }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Audit G-4: this effect used to depend on [open, items, active]. `items` is
  // a FRESH ARRAY on every parent render (PriorityTabs.tsx:207 passes
  // items={overflow}, which computeLayout() recomputes every render; neither
  // it nor App.tsx's callers memoise it), so during a streaming turn it
  // re-ran every frame and dragged focus back to the parked item, making the
  // menu keyboard-unusable exactly when the agent was answering. Parking
  // focus is a one-shot ON OPEN action, so `open` is the only correct
  // dependency; the values it needs are read through a ref that every render
  // refreshes (react.dev's "latest ref" pattern), which keeps them current
  // without re-running the effect.
  const latest = useRef({ items, active });
  latest.current = { items, active };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `items`/`active`
  // are read through `latest` (refreshed every render, see above) precisely
  // so this effect does NOT re-run when they change; only `open` should
  // re-trigger the one-shot park-on-open action.
  useEffect(() => {
    if (!open) return;
    const { items: currentItems, active: currentActive } = latest.current;
    const ai = currentItems.findIndex((i) => i.id === currentActive);
    const start = ai >= 0 ? ai : 0;
    setFocusIdx(start);
    const raf = requestAnimationFrame(() => itemRefs.current[start]?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Dismiss on an outside pointer press.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // T-16 WV-2: if `items` SHRINKS while the menu is open (PriorityTabs'
  // Priority+ layout regains room and an overflowed tab moves back into the
  // visible strip — a live re-render, not a keypress), a stale `focusIdx`
  // can point PAST the new end. No rendered item then matches `i ===
  // focusIdx` (the roving tabIndex breaks) and the button that used to hold
  // DOM focus is now unmounted, so the browser silently drops focus to
  // `<body>` — invisible to a keyboard user. Clamp back into range and
  // re-park focus on the new valid item at that index.
  //
  // Keyed on `items.length` (a primitive), NOT `items` itself — Audit G-4
  // above is the cautionary tale for why: `items` is a fresh array every
  // parent render, so depending on the array reference would re-run (and
  // re-park focus) on every render, not just a genuine shrink. `focusIdx` is
  // read fresh via the closure each run; it does not need to be a dependency
  // for correctness, but including it keeps the effect honest about what it
  // reads and re-checks after the index itself changes (e.g. a rapid
  // shrink-then-shrink-further).
  useEffect(() => {
    if (!open) return;
    if (items.length === 0) return;
    if (focusIdx <= items.length - 1) return;
    const clamped = items.length - 1;
    setFocusIdx(clamped);
    itemRefs.current[clamped]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // NOT depending on `items` (only its `.length`), same reasoning as the
    // G-4 park-on-open effect above.
  }, [open, items.length, focusIdx]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(next, items.length - 1));
    setFocusIdx(clamped);
    itemRefs.current[clamped]?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        move(focusIdx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(focusIdx - 1);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(items.length - 1);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div className="relative ml-auto flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More panels"
        aria-label="More panels"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex items-center rounded px-1.5 py-1 text-faint transition-colors hover:bg-overlay hover:text-muted ${
          open ? 'bg-overlay text-fg' : ''
        }`}
      >
        <Icon name="ellipsis" size={16} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More panels"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-30 mt-1 min-w-[168px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg"
        >
          {items.map((it, i) => (
            <button
              key={it.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitem"
              type="button"
              tabIndex={i === focusIdx ? 0 : -1}
              aria-current={it.id === active ? 'page' : undefined}
              onClick={() => {
                onSelect(it.id);
                close();
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
