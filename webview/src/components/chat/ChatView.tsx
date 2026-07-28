/*
 * Renders the streaming transcript. Auto-scrolls to the newest item unless the
 * user has scrolled up to read history. Dispatches diff / approval resolutions.
 */
import { memo, useEffect, useRef } from 'react';
import type { TranscriptItem, ToolItem } from '../../types';
import { Hero } from '../Hero';
import { LiveRegion } from '../LiveRegion';
import { UserMessage } from './UserMessage';
import { ReasoningBlock } from './ReasoningBlock';
import { AgentMarkdown } from './AgentMarkdown';
import { ToolCard } from './ToolCard';
import { DiffCard } from './DiffCard';
import { ApprovalCard } from './ApprovalCard';
import { PlanList } from './PlanList';
import { ResultSummary } from './ResultSummary';

interface ChatViewProps {
  transcript: TranscriptItem[];
  onApproval: (id: string, optionId: string) => void;
  onDiff: (toolId: string, hunkIndex: number, action: 'accept' | 'reject') => void;
  /** W2 T4 (F-D): open the read-only editor diff preview for a still-pending
   * proposed edit (`diff.open {toolId, path}`). */
  onOpenDiff: (toolId: string, path: string) => void;
  onStarter: (text: string) => void;
  /** M1: forwarded straight through to `<Hero>` — see Hero's `disabled` doc. */
  starterDisabled?: boolean;
}

/**
 * W2 T4 (F-D): the toolIds whose edit approval is still pending (an
 * `ApprovalItem` carrying that `toolId` with no `resolvedOptionId` yet) — the
 * ONLY diffs `DiffCard`'s "Open diff in editor" button may render for. A
 * post-apply `tool.diff` (auto-allowed edit, no approval in play at all) has
 * no matching `ApprovalItem`, so it's excluded by construction, mirroring the
 * host's own ask-path-only `EditPreviewRegistry` scoping.
 */
export function pendingDiffToolIds(transcript: TranscriptItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of transcript) {
    if (
      item.kind === 'approval' &&
      item.toolId !== undefined &&
      item.resolvedOptionId === undefined &&
      // T-A2 (V-4/V-5): a turn.end cancel-fold clears NOTHING optimistic
      // (there was none) but sets `settledOutcome` directly — without this
      // clause a card whose approval was cancelled/expired/superseded with
      // zero user clicks would still count as "pending" here.
      item.settledOutcome === undefined
    ) {
      ids.add(item.toolId);
    }
  }
  return ids;
}

/**
 * T-A2-SC2 (audit-2 wave-3 refinement, MUST): the toolIds whose gating
 * approval settled to an EFFECTIVE deny. Derived here — NEVER from the raw
 * `ToolItem.hunksLocked` marker, which T-A1 sets unconditionally on ANY
 * settle (including an ALLOW selection): a pill keyed on that raw flag would
 * mislabel an APPLIED edit "not applied". Two independent routes land a
 * toolId here:
 *   (a) `settledOutcome` is a non-'selected' terminal — cancelled, expired,
 *       or superseded. The harness maps all three to deny for the underlying
 *       ACP permission (`permissions.py:95-104`), so none of them ever
 *       represents an applied edit.
 *   (b) the chosen option's `kind` is 'deny'/'deny_always' — covers an
 *       explicit card-deny click, the optimistic hunk-reject cascade
 *       (`local.diffResolved{reject}`, which sets `settledOutcome:'selected'`
 *       with the deny option id), and the host's own deny echo.
 */
export function deniedToolIds(transcript: TranscriptItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of transcript) {
    if (item.kind !== 'approval' || item.toolId === undefined) continue;
    const settledDeny = item.settledOutcome !== undefined && item.settledOutcome !== 'selected';
    const chosenKind = item.options.find((o) => o.id === item.resolvedOptionId)?.kind;
    const optionDeny = chosenKind === 'deny' || chosenKind === 'deny_always';
    if (settledDeny || optionDeny) ids.add(item.toolId);
  }
  return ids;
}

/**
 * B1 (path doc §4, UI I-7): text for the assertive edit-approval announcer.
 * The arrival of a blocking approval request — the product's core consent
 * gate — warrants an ASSERTIVE interruption (MDN Live_regions, fetched live
 * for this task: `aria-live="assertive"` is for "time-sensitive/critical
 * notifications that absolutely require the user's immediate attention").
 * Empty when nothing is pending: the caller renders this through the shared,
 * UNCHANGED `LiveRegion` component, which stays permanently mounted and just
 * swaps `text` — so the region never needs to un/re-mount to (re-)announce.
 * Scans from the end so the MOST RECENTLY arrived pending approval is the
 * one announced if more than one is somehow outstanding at once.
 */
export function pendingApprovalAnnouncement(transcript: TranscriptItem[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (item === undefined) continue;
    if (
      item.kind === 'approval' &&
      item.resolvedOptionId === undefined &&
      // T-A2-SC1 (MUST): a non-'selected' settle CLEARS resolvedOptionId
      // (T-A1's reducer), so without this clause a dead, already-settled
      // approval still matches the scan above and would get a fresh
      // ASSERTIVE re-announcement the moment it becomes the last
      // unresolved-looking item — resurrecting a decision the backend
      // already closed. This is the 3rd (final) `resolvedOptionId ===
      // undefined` production consumer that needed the same exclusion
      // `pendingDiffToolIds` and `deniedToolIds`'s sibling above already get.
      item.settledOutcome === undefined
    ) {
      return `Approval required: ${item.title}`;
    }
  }
  return '';
}

/**
 * T-A2-SC4 (owner-approved rider): text for a POLITE settlement announcer —
 * a separate, `role="status"` sibling of the assertive approval announcer
 * above, so neither fights the other. `role="log"` (the transcript itself)
 * announces additions but NOT text changes to existing entries reliably
 * (real-AT support for `aria-relevant`'s default is documented as
 * unreliable), and an auto-deny is a consequence-bearing action taken by the
 * passage of time (NN/g visibility-of-system-status heuristic #1: "when the
 * passage of time caused a change in the state of the system, explain it").
 * Scans from the end for the MOST RECENT non-'selected' settlement, mirroring
 * `pendingApprovalAnnouncement`'s own scan discipline. A 'selected' outcome
 * is never announced here — the user just acted, there is nothing new to
 * disclose about the passage of time.
 */
export function settlementAnnouncement(transcript: TranscriptItem[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (item === undefined) continue;
    if (item.kind !== 'approval') continue;
    switch (item.settledOutcome) {
      case 'cancelled':
        return `Approval cancelled: ${item.title}`;
      case 'expired':
        return `Approval expired — automatically denied: ${item.title}`;
      case 'superseded':
        return `Approval no longer pending: ${item.title}`;
      default:
        continue;
    }
  }
  return '';
}

/** A tool card plus any diffs it produced. Diffs share one global hunk index space. */
function ToolWithDiffs({
  item,
  onDiff,
  onOpenDiff,
  pending,
  denied,
}: {
  item: ToolItem;
  onDiff: ChatViewProps['onDiff'];
  onOpenDiff: ChatViewProps['onOpenDiff'];
  pending: boolean;
  denied: boolean;
}) {
  let hunkOffset = 0;
  return (
    <>
      <ToolCard item={item} />
      {item.diffs?.map((diff, di) => {
        const base = hunkOffset;
        hunkOffset += diff.hunks.length;
        return (
          <DiffCard
            key={di}
            diff={diff}
            resolvedHunks={item.resolvedHunks}
            hunkOffset={base}
            pending={pending}
            denied={denied}
            onResolve={(index, action) => onDiff(item.toolId, index, action)}
            onOpenDiff={() => onOpenDiff(item.toolId, diff.path)}
          />
        );
      })}
    </>
  );
}

function renderItem(
  item: TranscriptItem,
  onApproval: ChatViewProps['onApproval'],
  onDiff: ChatViewProps['onDiff'],
  onOpenDiff: ChatViewProps['onOpenDiff'],
  pendingToolIds: Set<string>,
  deniedIds: Set<string>,
) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />;
    case 'reasoning':
      return <ReasoningBlock item={item} />;
    case 'message':
      return <AgentMarkdown text={item.text} streaming={item.streaming} />;
    case 'tool':
      return (
        <ToolWithDiffs
          item={item}
          onDiff={onDiff}
          onOpenDiff={onOpenDiff}
          pending={pendingToolIds.has(item.toolId)}
          denied={deniedIds.has(item.toolId)}
        />
      );
    case 'approval':
      return <ApprovalCard item={item} onRespond={(optionId) => onApproval(item.id, optionId)} />;
    case 'plan':
      return <PlanList item={item} />;
    case 'result':
      return <ResultSummary item={item} />;
    default:
      return null;
  }
}

/**
 * Stable key for a transcript item. M8: `user` / `result` / `plan` each
 * occur at most once per turn, so `turnId` (prefixed by `kind` to avoid
 * colliding with that same turn's other items) is a stable identity —
 * unlike the transcript index, which shifts whenever an earlier item is
 * inserted (e.g. a reasoning block folding in ahead of the eventual
 * `result`).
 */
export function itemKey(item: TranscriptItem, index: number): string {
  // Captured pre-switch: with all 7 `TranscriptItem` kinds now handled below,
  // TS narrows `item` to `never` inside `default`, so `item.kind` there would
  // no longer type-check. `kind` (unnarrowed) keeps the fallback expressible
  // without a cast — it's unreachable today but stays harmless if a new
  // TranscriptItem kind is ever added without a matching case here.
  const kind = item.kind;
  switch (item.kind) {
    case 'reasoning':
      return `reasoning-${item.blockId}`;
    case 'message':
      return `message-${item.id}`;
    case 'tool':
      return `tool-${item.toolId}`;
    case 'approval':
      return `approval-${item.id}`;
    case 'user':
      return `user-${item.turnId}`;
    case 'result':
      return `result-${item.turnId}`;
    case 'plan':
      return `plan-${item.turnId}`;
    default:
      return `${kind}-${index}`;
  }
}

/**
 * ARCH Minor-11 (perf, done as a follow-up to P7-N1 since the draft's
 * per-keystroke reducer dispatch is what introduces per-keystroke App
 * re-renders): `React.memo` so a keystroke that only changes
 * `TabState.draft` doesn't re-tokenize the settled transcript. This only
 * pays off because `tab.transcript` keeps its array identity across a draft
 * fold (the reducer only ever touches `draft`/`draftAttachments`) and
 * App.tsx's `onApproval`/`onDiff`/`onOpenDiff`/`onStarter` handlers are
 * `useCallback`-stabilized — otherwise a fresh function identity every
 * render would defeat the memo.
 */
export const ChatView = memo(function ChatView({
  transcript,
  onApproval,
  onDiff,
  onOpenDiff,
  onStarter,
  starterDisabled,
}: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const pendingToolIds = pendingDiffToolIds(transcript);
  const deniedIds = deniedToolIds(transcript);

  // Track whether the user is pinned to the bottom.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript]);

  if (transcript.length === 0) {
    return <Hero onStarter={onStarter} disabled={starterDisabled} />;
  }

  return (
    <>
      {/* B1: assertive sibling, mounted BEFORE the log region — a separate
       * element from the log's own implicit polite live-ness (role="log"
       * already carries an implicit aria-live="polite"; doubling an
       * assertive announcer onto that same element would fight it). Stays
       * mounted at all times (Finding-7 discipline) and only its text
       * changes; `sr-only` keeps it out of the visual layout. */}
      <LiveRegion text={pendingApprovalAnnouncement(transcript)} assertive className="sr-only" />
      {/* T-A2-SC4: a SEPARATE polite region for settlement disclosure — a
       * state change inside `role="log"` is not reliably announced, and the
       * assertive region above only ever speaks PENDING approvals (it goes
       * silent, not descriptive, the instant one settles). Same
       * always-mounted, text-swap-only discipline as the assertive sibling. */}
      <LiveRegion text={settlementAnnouncement(transcript)} className="sr-only" />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 py-3.5"
      >
        {transcript.map((item, i) => (
          <div key={itemKey(item, i)}>
            {renderItem(item, onApproval, onDiff, onOpenDiff, pendingToolIds, deniedIds)}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </>
  );
});
