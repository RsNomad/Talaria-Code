/*
 * UI#1 (Wave 2, task W2-T7): the "jump to latest" pill. ChatView's streaming
 * auto-scroll pin used to implement only half the contract — scrolling up
 * during a live turn silenced auto-scroll with no signal that content was
 * still arriving below and no one-click way back. This is the other half:
 * a floating, horizontally-centered pill that ChatView mounts ONLY while
 * the user is scrolled away from the bottom AND content has actually landed
 * below them (see `ChatView.tsx`'s `unseenCount`/`pinned` wiring). A real
 * `<button>` — not a `<div onClick>` — so it is reachable and activatable
 * identically whether the user drives via mouse, touch, or keyboard.
 */
import { Icon } from '../Icon';

interface JumpToLatestProps {
  /** Items that have landed in the transcript since the user scrolled away.
   * ChatView only mounts this component once this is > 0, but the count
   * still drives both the visible label and the accessible name here. */
  count: number;
  onClick: () => void;
}

export function JumpToLatest({ count, onClick }: JumpToLatestProps) {
  const label = `Jump to latest, ${count} new`;
  return (
    // `pointer-events-none` on the full-width overlay row keeps the empty
    // space either side of the pill from intercepting clicks meant for the
    // transcript underneath; `pointer-events-auto` re-enables them on the
    // pill itself.
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-accent bg-raised px-3 py-1.5 font-mono text-2xs uppercase tracking-wide text-accent shadow-lg transition-colors hover:bg-accent-soft"
      >
        <span>{count} new</span>
        <Icon name="chevron-down" size={11} />
      </button>
    </div>
  );
}
