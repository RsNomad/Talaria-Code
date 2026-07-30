/*
 * File patch card with per-hunk accept/reject and a resolved counter.
 * ------------------------------------------------------------------
 * The shared `DiffHunk` carries only a header + lines tagged with a `sign`
 * (`+`/`-`/` `) — no per-line numbers and no per-hunk id. Resolution is keyed by
 * the hunk's INDEX (its position in the tool's overall hunk sequence), which is
 * exactly what `diff.resolve.hunkIndex` expects. Each hunk body scrolls
 * horizontally on its own so the panel body never does.
 * ------------------------------------------------------------------
 * T-A2 (audit-2 Cluster A, V-7): hunk Accept/Reject buttons render ONLY when
 * `pending && !resolved` — mirroring "Open diff in editor"'s existing
 * `pending` gate. Before this fix the buttons rendered for ANY unresolved
 * hunk regardless of `pending`, so a diff card that outlived its approval
 * (settled/interrupted) kept offering operable controls for a decision the
 * backend had already made.
 *
 * The `denied` prop (T-A2-SC2) is derived by the CALLER (`ChatView`'s
 * `deniedToolIds`) from the gating approval's EFFECTIVE outcome — never from
 * the raw state-level `hunksLocked` marker, which T-A1 sets on ANY settle
 * including an ALLOW. Under `denied`, an unresolved or previously-ACCEPTED
 * hunk shows a neutral "not applied" pill (SC3: the edit was denied, so a
 * green "accepted" on an individually-accepted sibling would be exactly the
 * V-7 lie); an explicit per-hunk 'reject' keeps its own red "rejected" pill.
 */
import type { DiffHunk, ToolDiff } from '../../protocol';
import { Icon } from '../Icon';
import { Pill, type PillTone } from '../Pill';

interface DiffCardProps {
  diff: ToolDiff;
  resolvedHunks?: Record<number, 'accept' | 'reject'>;
  /** Global index of this diff's first hunk within the tool's hunk sequence. */
  hunkOffset: number;
  onResolve: (hunkIndex: number, action: 'accept' | 'reject') => void;
  /** W2 T4 (F-D): true only while this diff's edit approval is still
   * pending — a post-apply (auto-allowed) tool.diff card never sets this, so
   * "Open diff in editor" is never offered for one (there is no live
   * approval left for the host's `EditPreviewRegistry` to have kept).
   * T-A2 also gates the per-hunk Accept/Reject buttons on this. */
  pending?: boolean;
  /** T-A2-SC2: the gating approval settled to an effective DENY (derived by
   * the caller — see `ChatView.deniedToolIds`). Drives the neutral "not
   * applied" pill for any hunk without its own explicit 'reject'. */
  denied?: boolean;
  /** Posts `diff.open {toolId, path}` — opens the read-only, both-virtual
   * editor diff preview for this file. */
  onOpenDiff?: () => void;
}

function hunkPill(
  resolution: 'accept' | 'reject' | undefined,
  denied: boolean,
): { tone: PillTone; label: string } | undefined {
  if (resolution === 'reject') return { tone: 'del', label: 'rejected' };
  if (resolution === 'accept') {
    // SC3: an individually-accepted hunk loses its green pill the instant
    // the whole edit is denied — the accept never actually applied.
    return denied ? { tone: 'neutral', label: 'not applied' } : { tone: 'add', label: 'accepted' };
  }
  // Unresolved: only a denied edit gets a pill at all (a still-pending or
  // post-apply-auto-allowed unresolved hunk stays pill-less, unchanged).
  return denied ? { tone: 'neutral', label: 'not applied' } : undefined;
}

function HunkView({
  hunk,
  resolution,
  pending,
  denied,
  onResolve,
  hunkNumber,
  total,
  path,
}: {
  hunk: DiffHunk;
  resolution?: 'accept' | 'reject';
  pending: boolean;
  denied: boolean;
  onResolve: (action: 'accept' | 'reject') => void;
  /** B5 (M-3): this hunk's 1-based position within the file's diff — combined
   * with `total`/`path` to give the Accept/Reject buttons a per-hunk
   * accessible name (otherwise identical across every hunk in the card). */
  hunkNumber: number;
  total: number;
  path: string;
}) {
  const resolved = resolution !== undefined;
  const showButtons = pending && !resolved;
  const pill = hunkPill(resolution, denied);
  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-2 bg-surface px-3 py-1.5 font-mono text-2xs text-faint">
        <Icon name="diff" size={12} />
        <span>{hunk.header}</span>
        {pill && (
          <span className="ml-auto">
            <Pill tone={pill.tone}>{pill.label}</Pill>
          </span>
        )}
      </div>

      <div className="overflow-x-auto font-mono text-[11.5px] leading-relaxed">
        {hunk.lines.map((ln, i) => (
          <div
            key={i}
            className={`whitespace-pre px-2 ${
              ln.sign === '+'
                ? 'bg-add-soft text-add'
                : ln.sign === '-'
                  ? 'bg-del-soft text-del'
                  : 'text-muted'
            }`}
          >
            {ln.sign} {ln.text}
          </div>
        ))}
      </div>

      {showButtons && (
        <div className="flex gap-2 border-t border-border bg-surface px-3 py-2">
          <button
            type="button"
            onClick={() => onResolve('accept')}
            aria-label={`Accept hunk ${hunkNumber} of ${total} in ${path}`}
            className="rounded border border-accent bg-accent px-2.5 py-1 text-2xs font-semibold text-accent-fg hover:opacity-90"
          >
            Accept hunk
          </button>
          <button
            type="button"
            onClick={() => onResolve('reject')}
            aria-label={`Reject hunk ${hunkNumber} of ${total} in ${path}`}
            className="rounded border border-border px-2.5 py-1 text-2xs font-semibold text-muted hover:bg-overlay"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function DiffCard({ diff, resolvedHunks, hunkOffset, onResolve, pending, denied = false, onOpenDiff }: DiffCardProps) {
  const total = diff.hunks.length;
  const resolvedCount = diff.hunks.filter(
    (_, i) => resolvedHunks?.[hunkOffset + i] !== undefined,
  ).length;
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <div className="flex items-center gap-2 bg-surface px-3 py-2">
        <Icon name="file-code" size={15} className="flex-none text-accent" />
        <span className="min-w-0 truncate font-mono text-xs text-fg">{diff.path}</span>
        {pending && onOpenDiff && (
          <button
            type="button"
            onClick={onOpenDiff}
            aria-label="Open diff in editor"
            title="Open a read-only diff preview in the editor"
            className="flex-none rounded p-0.5 text-faint hover:text-fg"
          >
            <Icon name="link-external" size={13} />
          </button>
        )}
        <span className="ml-auto flex-none font-mono text-2xs text-faint">
          {resolvedCount} / {total} hunks
        </span>
      </div>
      {diff.hunks.map((h, i) => {
        const index = hunkOffset + i;
        return (
          <HunkView
            key={index}
            hunk={h}
            resolution={resolvedHunks?.[index]}
            pending={pending ?? false}
            denied={denied}
            onResolve={(action) => onResolve(index, action)}
            hunkNumber={i + 1}
            total={total}
            path={diff.path}
          />
        );
      })}
    </div>
  );
}
