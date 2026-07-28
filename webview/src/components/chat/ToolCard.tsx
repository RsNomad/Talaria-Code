/*
 * Tool invocation card. States: pending / running / done / failed, each with a
 * distinct status pill. The icon is derived from the tool's semantic `toolKind`;
 * `rawInput` shows as a monospace read-out, plus any streamed output.
 */
import type { ToolItem } from '../../types';
import type { ToolKind, ToolStatus } from '../../protocol';
import { totalLookup } from '../../lookup';
import { Icon } from '../Icon';
import { Pill, type PillTone } from '../Pill';

/** Exported (UI-I1) so `ToolCard.test.ts` can exercise the total lookup
 * directly — this repo's webview tests don't use jsdom. */
export const STATUS: Record<ToolStatus, { tone: PillTone; label: string; icon: string; spin?: boolean }> = {
  pending: { tone: 'neutral', label: 'Queued', icon: 'circle-outline' },
  running: { tone: 'run', label: 'Running', icon: 'loading', spin: true },
  done: { tone: 'add', label: 'Done', icon: 'check' },
  failed: { tone: 'del', label: 'Failed', icon: 'error' },
  // T-A0 (audit-2 Cluster A, M1): keeps this exhaustive Record — and this
  // file's `tsc` compile — green ahead of T-A1's real fold logic. See
  // `ToolStatus`'s own doc for what emits this.
  interrupted: { tone: 'neutral', label: 'Interrupted', icon: 'stop-circle' },
};

/** UI-I1: a `status` outside the known `ToolStatus` enum (a version-skewed or
 * buggy host — `bridge.ts` only checks `.type`) falls back to this instead of
 * `STATUS[bad]` being `undefined` and `.tone` throwing mid-render. */
export const UNKNOWN_TOOL_STATUS: { tone: PillTone; label: string; icon: string; spin?: boolean } = {
  tone: 'neutral',
  label: 'Unknown',
  icon: 'question',
};

export const KIND_ICON: Record<ToolKind, string> = {
  read: 'file',
  edit: 'edit',
  execute: 'terminal',
  search: 'search',
  fetch: 'globe',
  think: 'lightbulb',
  other: 'tools',
};

/** UI-I1 sibling: an out-of-contract `toolKind` degrades gracefully today
 * (`codicon-undefined` renders no glyph) but is still guarded for honesty. */
export const UNKNOWN_KIND_ICON = 'question';

export function ToolCard({ item }: { item: ToolItem }) {
  const s = totalLookup(STATUS, item.status, UNKNOWN_TOOL_STATUS);
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <div className="flex items-center gap-2 bg-surface px-3 py-2">
        <Icon
          name={totalLookup(KIND_ICON, item.toolKind, UNKNOWN_KIND_ICON)}
          size={15}
          className="flex-none text-accent"
        />
        <span className="min-w-0 truncate font-mono text-xs text-muted">
          <span className="text-fg">{item.title}</span>
        </span>
        <span className="ml-auto flex-none">
          <Pill tone={s.tone} icon={s.icon} spin={s.spin} live={item.status === 'running'}>
            {s.label}
          </Pill>
        </span>
      </div>
      {item.rawInput && (
        <div className="overflow-x-auto border-t border-border bg-surface px-3 py-1.5 font-mono text-2xs text-faint">
          {item.rawInput}
        </div>
      )}
      {item.output && (
        <div className="overflow-x-auto whitespace-pre-wrap border-t border-border bg-surface px-3 py-1.5 font-mono text-2xs text-muted">
          {item.output}
        </div>
      )}
    </div>
  );
}
