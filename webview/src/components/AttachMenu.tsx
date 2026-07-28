/*
 * The composer's 📎 attach menu. Opens a small `role="menu"` with the two
 * upload entry points; the footer reminds people that paste and drag-drop work
 * too (so the menu isn't the only path). Keyboard-driven with Esc + outside
 * click to dismiss.
 *
 * B3 / path doc §2.3: the open/focus-first/roving/Escape/Tab contract now
 * lives in the shared `useMenuFocus` hook (this component was its
 * extraction source — `AttachMenu.dom.test.tsx` characterizes the exact
 * behavior below and must stay green across the refactor). Outside-mousedown
 * dismissal stays local: it needs the trigger-node check the shared hook
 * deliberately doesn't own (see the hook's own doc comment).
 */
import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { useMenuFocus } from '../hooks/useMenuFocus';

interface AttachMenuProps {
  onAttachFile: () => void;
  onAddImage: () => void;
}

const ITEMS = [
  { id: 'file', label: 'Attach file…', icon: 'file' },
  { id: 'image', label: 'Add image…', icon: 'device-camera' },
] as const;

export function AttachMenu({ onAttachFile, onAddImage }: AttachMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, focusIdx, itemRef, onMenuKey, onTriggerKey, toggleMenu, closeMenu } = useMenuFocus(
    ITEMS.length,
    triggerRef,
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) closeMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `closeMenu` is
    // a fresh function identity every render (useMenuFocus doesn't memoize
    // it); depending on it would re-attach this listener every render for no
    // behavioral difference. `open` is the only dependency that should
    // re-run this effect (mirrors the pre-extraction effect's own deps).
  }, [open]);

  const choose = (id: (typeof ITEMS)[number]['id']) => {
    closeMenu(false);
    if (id === 'file') onAttachFile();
    else onAddImage();
  };

  return (
    <div className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach"
        aria-label="Attach"
        onClick={toggleMenu}
        onKeyDown={onTriggerKey}
        className={`flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:border-accent hover:text-fg ${
          open ? 'border-accent text-fg' : ''
        }`}
      >
        <Icon name="file-add" size={14} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Attach"
          onKeyDown={onMenuKey}
          className="absolute bottom-full left-0 z-30 mb-1 min-w-[176px] overflow-hidden rounded-card border border-border bg-overlay py-1 shadow-lg"
        >
          {ITEMS.map((it, i) => (
            <button
              key={it.id}
              ref={itemRef(i)}
              role="menuitem"
              type="button"
              tabIndex={i === focusIdx ? 0 : -1}
              onClick={() => choose(it.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            >
              <Icon name={it.icon} size={14} className="flex-none text-accent" />
              {it.label}
            </button>
          ))}
          <div className="mt-1 border-t border-border px-3 pb-0.5 pt-1.5 text-2xs text-faint">
            Paste or drop files here too
          </div>
        </div>
      )}
    </div>
  );
}
