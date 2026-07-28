/*
 * Collapsible reasoning trace. Shows a live elapsed counter while streaming,
 * then a final "Thought for Ns" summary. Collapsed by default once finished.
 * The shared protocol carries no elapsed time, so we measure it locally and
 * freeze the reading when the block stops streaming.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReasoningItem } from '../../types';
import { Icon } from '../Icon';

export function ReasoningBlock({ item }: { item: ReasoningItem }) {
  const [open, setOpen] = useState(true);
  const startRef = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const frozenRef = useRef<number>(0);
  /*
   * M4: a history-loaded/replayed block arrives with `item.streaming` already
   * false, so the timer effect below never ticks and `frozenRef` stays at its
   * initial 0 — rendering a bogus "Thought 0.0s". Track whether a duration
   * was ever actually MEASURED locally (as opposed to defaulted) so we can
   * omit the duration entirely for a block we never watched stream. A ref
   * (not state) is fine: it only needs to be correct at render time, and the
   * live path already re-renders via `setElapsed` on every tick.
   */
  const measuredRef = useRef(false);

  useEffect(() => {
    if (!item.streaming) return;
    const t = setInterval(() => {
      const e = Date.now() - startRef.current;
      frozenRef.current = e;
      measuredRef.current = true;
      setElapsed(e);
    }, 100);
    return () => clearInterval(t);
  }, [item.streaming]);

  // Auto-collapse when reasoning completes.
  useEffect(() => {
    if (!item.streaming) setOpen(false);
  }, [item.streaming]);

  const showDuration = item.streaming || measuredRef.current;
  const seconds = ((item.streaming ? elapsed : frozenRef.current) / 1000).toFixed(1);

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 font-mono text-2xs text-faint hover:text-muted"
      >
        <Icon
          name={item.streaming ? 'loading' : 'sparkle'}
          size={12}
          spin={item.streaming}
          className="text-accent"
        />
        <span>{item.streaming ? 'Thinking' : 'Thought'}</span>
        {/* T-15/F7: this counter ticks ~10x/s while streaming, inside
            ChatView's `role="log"` region (implicit aria-live="polite") — a
            screen reader would otherwise chatter "0.1s, 0.2s, 0.3s…" for the
            whole duration of a reasoning block. `aria-hidden` removes it
            from the accessibility tree (and from the button's accessible
            name computation) without affecting the sighted-user rendering. */}
        {showDuration && (
          <span className="text-accent" aria-hidden="true">
            {seconds}s
          </span>
        )}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} className="ml-auto" />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 pl-7 text-xs italic leading-relaxed text-muted">
          {item.text}
          {item.streaming && <span className="h-live">▍</span>}
        </div>
      )}
    </div>
  );
}
