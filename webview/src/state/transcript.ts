/*
 * Reducer: folds the SHARED host->webview wire protocol into renderable
 * AppState. Streaming deltas are matched to their transcript item by
 * turnId / blockId / toolId (per the shared contract) and appended.
 *
 * W4 §2e: ONE reducer, re-keyed per-tab. The FIRST step for every
 * session-scoped message resolves `msg.sessionId` -> a tabId via
 * `sessionToTab` (tabs.ts) and folds into THAT tab's slice — an unknown
 * session is DROPPED (dev-log, never `!`/`as` past a missing tab). This is
 * the P-1 isolation guarantee: a message tagged session B can only ever fold
 * into B's tab, never into A's.
 */
import type { HostToWebview, PlanItem, ToolStatus } from '../protocol';
import { foldSetupProgress } from '../panels/setupCards';
import {
  INITIAL_STATE,
  type ApprovalItem,
  type AppState,
  type PlanStepView,
  type TabState,
  type TranscriptItem,
} from '../types';
import { handleSessionChange, sessionToTab } from './tabs';
import { isDenyOptionKind } from './approvalOptions';
import { foldSessionScoped, foldTabScoped } from './scopedFold';
import { foldPanelData } from './panelScopeFold';
import { foldHydrate } from './hydrateFold';

export { findOptionId, isDenyOptionKind } from './approvalOptions';
export { reduceLocal } from './localReducer';
export type { LocalAction } from './localReducer';

/**
 * CA-M15: hard cap on transcript items per tab. The reducer keeps the last
 * MAX_TRANSCRIPT_ITEMS and records the running drop count in `TabState.
 * hiddenCount`. The active turn's items are always at the tail, so trimming
 * the oldest settled items never orphans an in-flight streaming fold — CA-09
 * (below) makes this a structural guarantee of `capTranscript` itself rather
 * than an assumption a single oversized turn could violate.
 */
export const MAX_TRANSCRIPT_ITEMS = 500;

function capTranscript(tab: TabState): TabState {
  const over = tab.transcript.length - MAX_TRANSCRIPT_ITEMS;
  if (over <= 0) return tab;
  // CA-09: SOFT, turn-aware — never trim the active turn (its items are provably at
  // the tail, and trimming its earlier items orphans in-flight folds / duplicates
  // `messageId`). Trim only OLDER-turn items from the front, up to `over`.
  const activeTurnId = tab.transcript[tab.transcript.length - 1]?.turnId;
  const kept: TranscriptItem[] = [];
  let trimmed = 0;
  for (const item of tab.transcript) {
    if (trimmed < over && item.turnId !== activeTurnId) {
      trimmed++;
      continue;
    }
    kept.push(item);
  }
  if (trimmed === 0) return tab;
  return { ...tab, transcript: kept, hiddenCount: (tab.hiddenCount ?? 0) + trimmed };
}

/**
 * Deterministic id for a new message block, derived from the turn and how many
 * message blocks already exist for it. Pure — safe under React StrictMode's
 * double-invocation of reducers (no module-level mutable counter).
 */
function messageId(turnId: string, list: TranscriptItem[]): string {
  const n = list.filter((i) => i.kind === 'message' && i.turnId === turnId).length;
  return `msg-${turnId}-${n}`;
}

/** Mark every still-streaming message block as settled (called before non-message items). */
function closeOpenMessages(list: TranscriptItem[]): TranscriptItem[] {
  let changed = false;
  const next = list.map((item) => {
    if (item.kind === 'message' && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : list;
}

/** AUDIT-5 UI I-1 (F-3): a plan step claiming `active` after its turn died
 * is a card claiming a running state that is not happening — the same CF-06
 * class as an eternally-streaming reasoning block (PlanList renders `active`
 * as a perpetually spinning `loading` icon). Fold it to the webview-only
 * `'interrupted'` (see PlanStepView's doc): honest "was running when the
 * turn died" — distinct from never-started `pending` — mirroring the tool
 * fold above (`running` → `'interrupted'`), and non-spinning in PlanList. */
function settlePlanSteps(items: PlanStepView[]): PlanStepView[] {
  return items.some((step) => step.status === 'active')
    ? items.map((step) => (step.status === 'active' ? { ...step, status: 'interrupted' as const } : step))
    : items;
}

/**
 * CF-06 (R2 — "settled is enumerated, not derived"): the ONE place every
 * still-open/streaming transcript-item kind is settled, used on an ABNORMAL
 * `turn.end` (any status other than `'complete'` — see that arm's own
 * deliberate no-fold below, T-A1 owner fork, left unchanged). Before this
 * fix, settling was enumerated per-kind: `closeOpenMessages` settled only
 * `message`, and the turn.end fold mapped only `tool`/`approval` — a
 * streaming `reasoning` block fell through BOTH and never settled on an
 * abnormal turn.end, leaving an eternal "Thinking" spinner and its 10 Hz
 * `setInterval` (`ReasoningBlock.tsx`, keyed on `item.streaming`). Every
 * open/streaming kind is enumerated HERE, in one function, so a FUTURE
 * streaming kind added to `TranscriptItem` is a single-site fix, not a fresh
 * miss (see the trip-wire test in transcript.test.ts). `closeOpenMessages`
 * above is UNCHANGED and keeps its own separate MID-TURN role (closing a
 * prior message block when a new reasoning/tool/approval/plan/result block
 * starts) — this function only takes over the turn-END settle. Settled
 * kinds: message, reasoning, tool, approval, and a plan's `active` step (→
 * webview-only `'interrupted'`) alike.
 */
function settleOpenItems(list: TranscriptItem[]): TranscriptItem[] {
  return list.map((item) => {
    if (item.kind === 'message' && item.streaming) {
      return { ...item, streaming: false };
    }
    if (item.kind === 'reasoning' && item.streaming) {
      return { ...item, streaming: false };
    }
    if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running')) {
      return { ...item, status: 'interrupted' as const };
    }
    if (item.kind === 'approval' && item.settledOutcome === undefined) {
      return { ...item, settledOutcome: 'cancelled' as const };
    }
    if (item.kind === 'plan' && item.items.some((step) => step.status === 'active')) {
      return { ...item, items: settlePlanSteps(item.items) };
    }
    return item;
  });
}

/**
 * BH-05 (Q2 / ADR-R2-15): the synthetic edit-approval tool card's derived
 * STATUS for an `approval.settle` echo. Pure translation of the settle
 * outcome (+ the sibling approval item's chosen option, for `'selected'`) —
 * the `approval.settle` fold below applies this ONLY while the matching tool
 * item is still `'pending'` (never `running`/`done`/`failed`).
 */
function deriveSettledToolStatus(
  msg: Extract<HostToWebview, { type: 'approval.settle' }>,
  approvalItem: ApprovalItem | undefined,
): ToolStatus | undefined {
  switch (msg.outcome) {
    case 'cancelled':
    case 'superseded':
      return 'interrupted';
    case 'expired':
      return 'denied';
    case 'selected': {
      const chosenKind = approvalItem?.options.find((o) => o.id === msg.optionId)?.kind;
      return isDenyOptionKind(chosenKind) ? 'denied' : 'approved';
    }
    // no default: the switch above covers all 4 members of `msg.outcome`
    // ('selected'|'cancelled'|'expired'|'superseded'), so every case DOES
    // return. This is a manual invariant, not one tsc verifies — the
    // function's declared return type is `ToolStatus | undefined`, so a
    // missing case would NOT be flagged by tsc; it would just fall through
    // and return `undefined` here. The caller already handles that
    // `undefined` (the settle fold below no-ops when this returns it), so
    // an unnoticed gap would degrade safely rather than break the build.
  }
}

/** Every session-scoped {@link HostToWebview} variant `foldTab` folds — i.e.
 * everything EXCEPT `turn.start` (its own adoption/reconciliation case,
 * below) and `policy.state` (folds `preset`, not the transcript). */
type TranscriptFoldMessage = Extract<
  HostToWebview,
  {
    type:
      | 'clear'
      | 'turn.end'
      | 'user'
      | 'reasoning.start'
      | 'reasoning.delta'
      | 'reasoning.end'
      | 'message.delta'
      | 'message.end'
      | 'tool.start'
      | 'tool.update'
      | 'tool.diff'
      | 'approval.request'
      | 'approval.settle'
      | 'plan.update'
      | 'result.summary'
      | 'error';
  }
>;

/**
 * The existing fold logic (pre-W4: `reduce`'s own switch, `state.transcript`
 * as its root), reused verbatim with a {@link TabState} as its root (§2e).
 */
function foldTab(tab: TabState, msg: TranscriptFoldMessage): TabState {
  switch (msg.type) {
    case 'clear': {
      // exactOptional prep (arm 1): clear `error` by OMITTING the key
      // (absent ≡ initial), never by writing an explicit `undefined` —
      // TabState.error stays `?: {...}`, no `| undefined` widening.
      const { error: _clearedError, ...rest } = tab;
      return { ...rest, transcript: [], plan: [], turnActive: false, stopPending: false, hiddenCount: 0 };
    }

    case 'turn.end': {
      if (msg.status === 'complete') {
        // T-A1 owner fork: NO fold on a complete turn — a tool/approval (or,
        // by the same fork, a reasoning block) still open after
        // `status: 'complete'` is a host bug better left visible than
        // papered over client-side. `closeOpenMessages` still runs its own
        // narrower MID-TURN role here (settling only a still-streaming
        // `message` block) — unchanged, pre-dates this fork.
        return { ...tab, turnActive: false, stopPending: false, transcript: closeOpenMessages(tab.transcript) };
      }
      // V-5/V-4 + CF-06/R2: the webview mirror of the host's
      // `markSubagentsInterrupted` — a turn ending anything other than
      // `'complete'` means nothing is still running in THIS session (one
      // live turn per session), so EVERY still-open/streaming transcript
      // item — message, reasoning, tool, approval alike — must stop lying
      // about being live. Derived in one place (settleOpenItems) instead of
      // enumerated per-kind here.
      return { ...tab, turnActive: false, stopPending: false, transcript: settleOpenItems(tab.transcript), plan: settlePlanSteps(tab.plan) };
    }

    case 'user': {
      // ARCH-1 (final review, UI I-3): the draft is cleared by the HOST's
      // admission echo (emitted synchronously at `SessionController.sendPrompt`
      // AFTER every refusal gate), never optimistically at post time
      // (`useHostActions.sendDraft` no longer dispatches `local.draft.clear`).
      // CF-03: the Composer sends `draft.trim()` as the prompt text (see
      // Composer.tsx `submit`), so `msg.text` here is always the TRIMMED
      // echo — comparing it against the RAW `tab.draft` meant a
      // whitespace-padded draft ('fix bug ') never matched its own trimmed
      // send ('fix bug') and the draft + its attachment chips survived to be
      // accidentally re-sent. Trim-aware guard: if the user already retyped
      // new text while the echo was in flight, `tab.draft.trim()` no longer
      // equals `msg.text` — their new text survives untouched.
      const admitted = tab.draft.trim() === msg.text;
      return {
        ...tab,
        ...(admitted ? { draft: '', draftAttachments: [] } : {}),
        transcript: [...tab.transcript, { kind: 'user', turnId: msg.turnId, text: msg.text, mode: msg.mode }],
      };
    }

    case 'reasoning.start':
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          { kind: 'reasoning', turnId: msg.turnId, blockId: msg.blockId, text: '', streaming: true },
        ],
      };

    case 'reasoning.delta': {
      // L2-CA-07: mirrors `message.delta`'s tail-first splice below EXACTLY
      // (same idiom, same fallback shape) — the open reasoning block is
      // provably the LAST element in the normal flow for the identical
      // reason `message.delta`'s open message is: any interleaving item
      // (a new reasoning/tool/approval/plan block) opens fresh at the tail.
      // Tail check first (O(1) common case); reverse-scan kept as the rare
      // fallback (a reasoning block that is not last) so the result is
      // provably identical to the old full `.map`.
      const lastIndex = tab.transcript.length - 1;
      const last = tab.transcript[lastIndex];
      const matchLast = last !== undefined && last.kind === 'reasoning' && last.blockId === msg.blockId;
      const match = matchLast
        ? last
        : [...tab.transcript].reverse().find((i) => i.kind === 'reasoning' && i.blockId === msg.blockId);
      if (match && match.kind === 'reasoning') {
        // Targeted splice: copy the array once, replace only the matched
        // index — no per-element `.map` callback. Unchanged items keep their
        // references (slice copies references), exactly like the old
        // `.map(i => i === match ? {...} : i)`.
        const idx = matchLast ? lastIndex : tab.transcript.indexOf(match);
        const next = tab.transcript.slice();
        next[idx] = { ...match, text: match.text + msg.text };
        return { ...tab, transcript: next };
      }
      // No match (a missing reasoning block is not a normal flow —
      // `reasoning.start` always creates it) — identity, mirroring the old
      // `.map`'s no-op transform when nothing matched.
      return { ...tab, transcript: tab.transcript };
    }

    case 'reasoning.end': {
      // L2-CA-07: identical to `reasoning.delta` above except the
      // replacement settles `streaming: false` instead of appending text.
      const lastIndex = tab.transcript.length - 1;
      const last = tab.transcript[lastIndex];
      const matchLast = last !== undefined && last.kind === 'reasoning' && last.blockId === msg.blockId;
      const match = matchLast
        ? last
        : [...tab.transcript].reverse().find((i) => i.kind === 'reasoning' && i.blockId === msg.blockId);
      if (match && match.kind === 'reasoning') {
        const idx = matchLast ? lastIndex : tab.transcript.indexOf(match);
        const next = tab.transcript.slice();
        next[idx] = { ...match, streaming: false };
        return { ...tab, transcript: next };
      }
      return { ...tab, transcript: tab.transcript };
    }

    case 'message.delta': {
      // CA-09: the open streaming message is provably the LAST element in the
      // normal flow (any interleaving item runs closeOpenMessages, settling
      // prior streaming messages, so a new delta opens a fresh one at the tail).
      // Check the tail first (O(1)); keep the reverse-scan as the rare fallback
      // (an open message that is not last) so the result is provably identical.
      const lastIndex = tab.transcript.length - 1;
      const last = tab.transcript[lastIndex];
      const openIsLast =
        last !== undefined && last.kind === 'message' && last.streaming && last.turnId === msg.turnId;
      const open = openIsLast
        ? last
        : [...tab.transcript].reverse().find((i) => i.kind === 'message' && i.streaming && i.turnId === msg.turnId);
      if (open && open.kind === 'message') {
        // Targeted splice: copy the array once, replace only the matched index —
        // no per-element .map callback, no reverse-copy on the fast path. Unchanged
        // items keep their references (slice copies references), exactly like the
        // old .map(i => i === open ? {...} : i).
        const idx = openIsLast ? lastIndex : tab.transcript.indexOf(open);
        const nextTranscript = tab.transcript.slice();
        nextTranscript[idx] = { ...open, text: open.text + msg.text };
        return { ...tab, transcript: nextTranscript };
      }
      return {
        ...tab,
        transcript: [
          ...tab.transcript,
          { kind: 'message', turnId: msg.turnId, id: messageId(msg.turnId, tab.transcript), text: msg.text, streaming: true },
        ],
      };
    }

    case 'message.end': {
      // audit-3 Code Important: the host accumulates ALL deltas for the whole
      // turn and emits ONE message.end carrying the FULL turn buffer
      // (turnTranslator.ts:39-49, pinned by turnTranslator.test.ts). On a
      // say→tool→say turn the deltas already built TWO+ message blocks (an
      // interleaving tool/reasoning/approval/plan element closes the
      // pre-tool block via closeOpenMessages, so the next delta opens a NEW
      // one) — the whole-turn buffer only equals ONE block's own text when
      // exactly one block exists for the turn. Reconcile `text` from the
      // buffer ONLY in that single-block case; with multiple blocks, trust
      // the delta-built text and only settle `streaming`.
      const blocks = tab.transcript.filter(
        (i): i is Extract<TranscriptItem, { kind: 'message' }> => i.kind === 'message' && i.turnId === msg.turnId,
      );
      const target = blocks[blocks.length - 1];
      if (!target) {
        // Unreachable today: finish() only emits message.end after >=1
        // delta (turnTranslator.ts:45), which implies >=1 message block
        // already exists for the turn — kept as a defensive fallback per
        // this codebase's defensive-fold convention (audit-3 Code Info-1).
        return {
          ...tab,
          transcript: [
            ...tab.transcript,
            { kind: 'message', turnId: msg.turnId, id: messageId(msg.turnId, tab.transcript), text: msg.text, streaming: false },
          ],
        };
      }
      const text = blocks.length === 1 ? msg.text : target.text;
      return {
        ...tab,
        transcript: tab.transcript.map((i) => (i === target ? { ...i, text, streaming: false } : i)),
      };
    }

    case 'tool.start': {
      // BH-05: create-if-absent. A tool item for this toolId already exists →
      // no-op (the synthetic edit-approval card must never double-insert /
      // dup its React key).
      if (tab.transcript.some((i) => i.kind === 'tool' && i.toolId === msg.toolId)) {
        return tab;
      }
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          {
            kind: 'tool',
            turnId: msg.turnId,
            toolId: msg.toolId,
            toolKind: msg.kind,
            title: msg.title,
            status: msg.status,
            // exactOptional prep (arm 1): omit `rawInput` when the wire
            // didn't carry one, instead of writing an explicit `undefined`
            // into ToolItem's `rawInput?: string`.
            ...(msg.rawInput !== undefined ? { rawInput: msg.rawInput } : {}),
          },
        ],
      };
    }

    case 'tool.update':
      return {
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'tool' && i.toolId === msg.toolId
            ? {
                ...i,
                status: msg.status ?? i.status,
                // exactOptional prep (arm 1): only touch `output` when
                // `msg.output` actually arrived — leaving it untouched when
                // absent preserves `i.output` (present or absent) exactly,
                // instead of re-writing it as an explicit `undefined`.
                ...(msg.output !== undefined ? { output: (i.output ?? '') + msg.output } : {}),
              }
            : i,
        ),
      };

    case 'tool.diff':
      return {
        ...tab,
        transcript: tab.transcript.map((i) =>
          i.kind === 'tool' && i.toolId === msg.toolId
            ? { ...i, diffs: [...(i.diffs ?? []), { path: msg.path, hunks: msg.hunks }] }
            : i,
        ),
      };

    case 'approval.request':
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          {
            kind: 'approval',
            turnId: msg.turnId,
            id: msg.id,
            approvalKind: msg.kind,
            title: msg.title,
            options: msg.options,
            // exactOptional prep (arm 1): toolId/detail/timeoutMs are all
            // optional on ApprovalItem — omit each when the wire didn't
            // carry one instead of writing an explicit `undefined`.
            ...(msg.toolId !== undefined ? { toolId: msg.toolId } : {}),
            ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
            // T-A1: the field already existed on the wire — folded now so
            // T-A2's countdown display has something to read.
            ...(msg.timeoutMs !== undefined ? { timeoutMs: msg.timeoutMs } : {}),
          },
        ],
      };

    case 'approval.settle': {
      // V-5/V-6/V-7: the authoritative host settlement — OVERWRITES any
      // optimistic value unconditionally (ARCH-1: optimistic can never
      // override authoritative). Also locks the settled approval's tool
      // hunks (M3-b) so a still-unresolved sibling hunk (e.g. a 60s auto-deny
      // that fired with zero user clicks) is never left looking live.
      //
      // BH-05 (Q2 / ADR-R2-15): ALSO derives the matching tool item's own
      // `status` (Approved/Denied/Interrupted) for the synthetic
      // edit-approval card — but ONLY while that tool item is still
      // `'pending'` (never touches `running`/`done`/`failed`). Computed once,
      // up front, since it needs the sibling approval item's `options` to
      // resolve the chosen option's kind for the `'selected'` case.
      const approvalItem = tab.transcript.find((i): i is ApprovalItem => i.kind === 'approval' && i.id === msg.id);
      const settledToolStatus = deriveSettledToolStatus(msg, approvalItem);
      return {
        ...tab,
        transcript: tab.transcript.map((item) => {
          if (item.kind === 'approval' && item.id === msg.id) {
            // audit-2 review finding 2: a non-'selected' outcome (cancelled/
            // expired/superseded) must CLEAR a stale optimistic
            // resolvedOptionId, not leave it standing next to the contradicting
            // settlement — a dangling "consent" field on a cancel/expire is a
            // lie any pre-T-A2 consumer reading resolvedOptionId would render.
            // Destructure it out and only re-add on an actual 'selected' pick.
            const { resolvedOptionId: _staleResolvedOptionId, ...rest } = item;
            return {
              ...rest,
              settledOutcome: msg.outcome,
              ...(msg.outcome === 'selected' && msg.optionId !== undefined ? { resolvedOptionId: msg.optionId } : {}),
            };
          }
          if (item.kind === 'tool' && msg.toolId !== undefined && item.toolId === msg.toolId) {
            const status = item.status === 'pending' && settledToolStatus !== undefined ? settledToolStatus : item.status;
            return { ...item, hunksLocked: true, status };
          }
          return item;
        }),
      };
    }

    case 'plan.update': {
      // CA-10 (OD-3): one plan card PER TURN. The predicate is scoped to
      // `msg.turnId` so a later turn's update APPENDS its own card instead of
      // rebinding whichever turn's card `some`/`map` found first — the old
      // turn-blind predicate let turn 3's plan.update rewrite the card still
      // sitting in turn 1's transcript position.
      const exists = tab.transcript.some((i) => i.kind === 'plan' && i.turnId === msg.turnId);
      const transcript = exists
        ? tab.transcript.map((i) => (i.kind === 'plan' && i.turnId === msg.turnId ? { ...i, items: msg.items } : i))
        : [...closeOpenMessages(tab.transcript), { kind: 'plan' as const, turnId: msg.turnId, items: msg.items }];
      return { ...tab, plan: msg.items, transcript };
    }

    case 'result.summary':
      // ARCH-1 (final review, UI I-4): `status` is required on the wire (T1)
      // and passed straight through — T4 owns the honest tone-mapped render.
      return {
        ...tab,
        transcript: [
          ...closeOpenMessages(tab.transcript),
          {
            kind: 'result',
            turnId: msg.turnId,
            status: msg.status,
            // exactOptional prep (arm 1): omit text/usage when the wire
            // didn't carry one, instead of writing an explicit `undefined`.
            ...(msg.text !== undefined ? { text: msg.text } : {}),
            ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
          },
        ],
      };

    case 'error':
      // R-A2: a session-scoped error is NOT a turn terminator. Non-fatal
      // errors (setModel/setMode failures, a refused concurrent prompt)
      // arrive mid-turn and must not unlock THIS tab's composer while its
      // turn still runs — every fatal turn error is accompanied by its own
      // `turn.end{error}`, which is the single place `turnActive` clears.
      return {
        ...tab,
        // exactOptional prep (arm 1): omit `detail` when the wire didn't
        // carry one, instead of writing an explicit `undefined` into
        // TabState.error's `detail?: string`.
        error: { message: msg.message, ...(msg.detail !== undefined ? { detail: msg.detail } : {}) },
      };

    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}

/**
 * `turn.start`'s session adoption (§2e) — the S0-shim adoption path: the
 * CURRENT host has not yet wired `tab.open`/`tab.bound` (single implicit
 * session), so `turn.start` remains the signal that binds a session to a
 * tab, via Continue's `handleSessionChange` reconciliation (case 1 retitle /
 * case 3 adopt on an unbound active tab) instead of a blind
 * `state.sessionId = msg.sessionId` overwrite. Once T3b wires real
 * `tab.open`/`tab.bound`, a `turn.start` for an ALREADY-bound tab is the
 * common case (handled below without reconciliation); this path only fires
 * for a session `turn.start` observes before any binding announced it.
 */
function foldTurnStart(state: AppState, msg: Extract<HostToWebview, { type: 'turn.start' }>): AppState {
  const known = sessionToTab(state.tabs)[msg.sessionId];
  if (known) {
    // exactOptional prep (arm 1): clear `error` by omitting the key.
    return foldTabScoped(state, known, 'turn.start', (tab) => {
      const { error: _clearedError, ...rest } = tab;
      return { ...rest, turnActive: true };
    });
  }
  const activeTab = state.tabs[state.activeTabId];
  const title = activeTab?.title ?? 'Chat';
  const result = handleSessionChange(state, {
    currentSessionId: msg.sessionId,
    currentSessionTitle: title,
    // H1-I4: case 4's fresh-title value — `title` above is the case-1/2/3
    // RETITLE value (an existing tab renamed to the session's own title);
    // if case 4 fires instead (a brand-new tab), it must use THIS, never
    // `title` (a S0-shim `turn.start` for a not-yet-known session always
    // passes the ACTIVE tab's own title as `currentSessionTitle`, so a
    // case-4 mint that inherited it would name two tabs identically).
    newTabTitle: `Chat ${state.nextChatNumber}`,
  });
  // H1-A1 (WS-R4): only case 4 mints — now stated by the reconciler itself
  // instead of inferred from tabOrder growth.
  const minted = result.kind === 'opened';
  const nextChatNumber = minted ? state.nextChatNumber + 1 : state.nextChatNumber;
  // W4-T3b (§7 B9(c) wiring): APPEND whatever handleSessionChange returns
  // onto the existing queue — never overwrite it. Case 2's dedup (the only
  // case that actually produces a closeIntent) is unreachable through THIS
  // specific caller (the `known` check above already proves no tab owns
  // `msg.sessionId`, which is exactly case 2's own precondition) — real
  // dedup fires via T5's `tab.load` reconciliation — but the append must be
  // correct regardless of which caller eventually exercises it, so an
  // unrelated pending intent from a DIFFERENT path is never silently lost.
  const closeIntents = result.closeIntents.length
    ? [...state.closeIntents, ...result.closeIntents]
    : state.closeIntents;
  const boundTab = result.tabs[result.activeTabId];
  if (!boundTab) {
    // Defensive only: handleSessionChange already dev-logged (its one no-op
    // path, an unknown activeTabId) — nothing well-formed to bind a session
    // onto, so preserve the reconciled tab list rather than write a
    // malformed partial TabState.
    return {
      ...state,
      tabs: result.tabs,
      tabOrder: result.tabOrder,
      activeTabId: result.activeTabId,
      closeIntents,
      nextChatNumber,
    };
  }
  // exactOptional prep (arm 1): clear `error` by omitting the key.
  const { error: _clearedBoundTabError, ...boundTabRest } = boundTab;
  return {
    ...state,
    tabs: {
      ...result.tabs,
      [result.activeTabId]: { ...boundTabRest, binding: 'bound', turnActive: true },
    },
    tabOrder: result.tabOrder,
    activeTabId: result.activeTabId,
    closeIntents,
    nextChatNumber,
  };
}

export function reduce(state: AppState, msg: HostToWebview): AppState {
  switch (msg.type) {
    case 'hydrate':
      return foldHydrate(state, msg);

    case 'theme':
      return { ...state, theme: msg.theme };

    // D2 (A2): connection-global scalar push, folded exactly like `theme`
    // above — the trust-upgrade mock->acp swap's ONLY signal, since
    // `TalariaViewProvider.setBackend` deliberately never re-hydrates.
    case 'backend.state':
      return { ...state, backendKind: msg.kind };

    // W5.1 R5 (Task 13): connection-global scalar push, folded exactly like
    // `theme`/`backend.state` above. This is the ONLY writer of
    // `nextEditToggles` — the Guard ratifies, the host pushes, the panel
    // renders. A refused toggle pushes nothing, so a refusal can never move
    // this slice (the row's own rollback is what snaps the switch back).
    case 'nextEdit.state':
      return { ...state, nextEditToggles: msg.state };

    case 'system.error':
      // §7 B1: a CONNECTION-GLOBAL error — no session to tag it to. Renders
      // as a banner across every tab (AppState.systemError), never folded
      // into (or dropped alongside) any one tab's transcript.
      // exactOptional prep (arm 1): omit `detail` when the wire didn't
      // carry one, instead of writing an explicit `undefined`.
      return {
        ...state,
        systemError: { message: msg.message, ...(msg.detail !== undefined ? { detail: msg.detail } : {}) },
      };

    case 'system.recovered': {
      // ARCH-1 / Q2 (final review): retirement of the `system.error` banner
      // on a successful connection establish — not a second signal, the
      // resolution of the first. Idempotent (a fresh boot with no standing
      // banner folds to the same undefined it already was).
      // exactOptional prep (arm 1): clear by omitting the key.
      const { systemError: _clearedSystemError, ...rest } = state;
      return rest;
    }

    case 'gateway.health':
      // UX-02: CONNECTION-GLOBAL — same posture as `backend.state`/
      // `nextEdit.state` above (no sessionId, one gateway per connection).
      // exactOptional (arm 1): omit `attempts` when the wire omitted it.
      return {
        ...state,
        gatewayHealth: {
          state: msg.state,
          ...(msg.attempts !== undefined ? { attempts: msg.attempts } : {}),
        },
      };

    case 'turn.start':
      return foldTurnStart(state, msg);

    case 'policy.state':
      return foldSessionScoped(state, msg.sessionId, 'policy.state', (tab) => ({ ...tab, preset: msg.preset }));

    case 'commands.available':
      // W6-FE Part 1 (3-way ARCH I-3b): session-scoped, folded per-tab —
      // was a single GLOBAL `useState` in App.tsx pre-fix, so a second
      // tab's push overwrote the first tab's slash palette (cross-tab
      // clobber). Routes through the SAME foldSessionScoped -> sessionToTab
      // discipline every other session-scoped message uses (P-1).
      return foldSessionScoped(state, msg.sessionId, 'commands.available', (tab) => ({
        ...tab,
        availableCommands: msg.commands,
      }));

    case 'mode.state':
      // SF-2 (T4 owns the engine/floor — T3b wires only the picker UI SHELL
      // reading this fold): the active custom mode + the catalog this
      // session may switch to.
      return foldSessionScoped(state, msg.sessionId, 'mode.state', (tab) => ({
        ...tab,
        activeModeId: msg.modeId,
        availableModes: msg.available,
      }));

    case 'model.state':
      // ARCH-1 (final review, UI I-1): the authoritative overwrite of the
      // optimistic `local.setModel` write — legal ONLY because this push
      // (confirm or corrective snap-back) always lands afterward and owns
      // the same field. T2 owns the SessionController emitter.
      return foldSessionScoped(state, msg.sessionId, 'model.state', (tab) => ({
        ...tab,
        currentModelId: msg.modelId,
      }));

    case 'panel.data':
      return foldPanelData(state, msg);

    case 'tab.bound':
      // D1 (the checkpoints eternal-spinner fix): `rootId` is the tab's
      // REAL RootCoordinator root key — until this fold sets it, the tab's
      // `''` default never matches the `rootId` a checkpoints `panel.data`
      // push carries, so `AppState.rootPanels[tab.rootId]` (the App-level
      // read) can never resolve. This is the ONE place `TabState.rootId`
      // ever changes.
      return clearResolvedSessionLoad(
        foldTabScoped(state, msg.tabId, 'tab.bound', (tab) => {
          // UX-04a: `newSessionPending` is exactOptional (`?: true`) — clear
          // by KEY OMISSION (never `false`/`undefined`), same discipline the
          // `clear`/`tab.clear` folds already use for `error`. A successful
          // bind is one of this flag's two terminals.
          // UX-04c: a successful bind retires `sessionLostReason` together
          // with the `sessionLost` marker it rides on — same key-omission
          // discipline (exactOptional: cleared by omission, never `undefined`).
          const {
            newSessionPending: _clearedNewSessionPending,
            sessionLostReason: _clearedSessionLostReason,
            ...rest
          } = tab;
          return {
            ...rest,
            sessionId: msg.sessionId,
            binding: 'bound',
            rootId: msg.rootId,
            title: msg.title ?? tab.title,
            // Audit G-9: a successful bind is the one thing that retires the marker.
            openFailed: false,
            // ARCH-1 (final review, UI I-3): a successful bind is likewise the
            // one thing that retires the session-lost marker (G-9 parity).
            sessionLost: false,
          };
        }),
        msg.tabId,
      );

    case 'tab.error':
      // §7 B8: `kind` drives the retry affordance (App.tsx re-posts `tab.open`
      // for `open-failed`). Audit G-9: `openFailed` outlives the banner so the
      // route back survives a dismissal.
      return clearResolvedSessionLoad(
        foldTabScoped(state, msg.tabId, 'tab.error', (tab) => {
          // UX-04a: the other terminal for `newSessionPending` — every host
          // refusal path for `tab.newSession` already lands as `tab.error`
          // (verified — `AcpBackend.newSessionInTabInternal`), so this is the
          // exhaustive pair with `tab.bound` above. Same key-omission clear.
          const { newSessionPending: _clearedNewSessionPending, ...rest } = tab;
          if (msg.kind === 'open-failed') {
            // UX-04c: open-failed leaves any prior session-lost marker AND
            // its reason untouched, exactly as before — its standing row is
            // already honest for every open-failed path (no reason
            // vocabulary needed there, scope pin).
            return { ...rest, error: { message: msg.message, kind: msg.kind }, openFailed: true };
          }
          // ARCH-1 (final review, UI I-3): a lost session is a terminal
          // transition — regress `binding` so the composer (App.tsx
          // `disabled={tab.binding !== 'bound'}`) stops accepting sends that
          // have nowhere to go. `sessionLost` outlives the dismissible banner
          // exactly like `openFailed` does (G-9 pattern); cleared by the next
          // successful `tab.bound` above.
          // UX-04c: strip any PREVIOUS loss's reason first, so a reason-less
          // new loss never wears stale vocabulary; re-add only what THIS
          // message says (exactOptional: key omitted when the host sent none).
          const { sessionLostReason: _staleReason, ...restWithoutReason } = rest;
          return {
            ...restWithoutReason,
            error: { message: msg.message, kind: msg.kind },
            binding: 'unbound' as const,
            sessionLost: true,
            ...(msg.reason !== undefined ? { sessionLostReason: msg.reason } : {}),
          };
        }),
        msg.tabId,
      );

    case 'tab.clear':
      // IMP-2 (W3-T6 3-lens review fix, CF-11): tabId-scoped — NOT routed
      // through `foldSessionScoped`/`sessionToTab` like the generic `clear`
      // below, because the whole point is to reach a tab whose session is
      // already gone (no sessionId left to resolve). Reuses `foldTab`'s own
      // `clear` reset (transcript/plan/turnActive/error) and ALSO retires
      // `openFailed`/`sessionLost` — those two markers deliberately OUTLIVE
      // the dismissible banner (G-9/ARCH-1) and `foldTab`'s generic clear was
      // never taught to retire them (its only callers until now always
      // preceded a fresh bind on an already-live tab, never a session-lost
      // one). Without this, a "New Session" click on a session-lost tab left
      // the stale "Session lost" banner standing even after the fresh
      // `tab.bound` that follows.
      // exactOptional prep (arm 1): clear `error` by omitting the key
      // (openFailed/sessionLost stay explicit `false` — a real, non-undefined
      // boolean value, not the exactOptional case).
      // UX-04c: `sessionLostReason` rides the same exactOptional-by-omission
      // discipline as `error` — strip it here too, or a stale reason from the
      // session that just went lost would survive into the fresh tab.
      return foldTabScoped(state, msg.tabId, 'tab.clear', (tab) => {
        const { error: _clearedError, sessionLostReason: _clearedReason, ...rest } = tab;
        return { ...rest, transcript: [], plan: [], turnActive: false, stopPending: false, openFailed: false, sessionLost: false, hiddenCount: 0 };
      });

    // ---- generic session-scoped fold (drop-unknown; §2e reuses foldTab) ----
    case 'clear':
    case 'turn.end':
    case 'user':
    case 'reasoning.start':
    case 'reasoning.delta':
    case 'reasoning.end':
    case 'message.delta':
    case 'message.end':
    case 'tool.start':
    case 'tool.update':
    case 'tool.diff':
    case 'approval.request':
    case 'approval.settle':
    case 'plan.update':
    case 'result.summary':
    case 'error':
      return foldSessionScoped(state, msg.sessionId, msg.type, (tab) => capTranscript(foldTab(tab, msg)));

    // Task 10: CONNECTION-GLOBAL accumulation of the throttled
    // `setup.progress` stream (Agent install log lines, FIM/RAG model pull
    // bytes) — same posture as `nextEdit.state`/`backend.state` above (no
    // sessionId; there is one Setup panel per connection, not one per chat
    // tab). `foldSetupProgress` (setupCards.ts) is pure and independently
    // tested (`SetupPanel.test.ts`); this fold just threads it through.
    case 'setup.progress':
      return { ...state, setupProgress: foldSetupProgress(state.setupProgress, msg) };

    // P1 entry-point fix: host-driven panel switch — same connection-global
    // posture as `setup.progress` above (no sessionId). This folds only the
    // STATE half (`activePanel`); the App layer owns the FETCH half (a
    // `trigger`-tagged `requestPanel` call), which the pure reducer cannot
    // perform as a side effect.
    case 'panel.activate':
      return { ...state, activePanel: msg.panel };

    default:
      return state;
  }
}

/**
 * A6 (T-18 mechanization): compile-time-only companion to the `default:
 * return state` fallback above — never invoked at runtime (this function is
 * not called anywhere; its whole job is to fail `npm run typecheck -w
 * webview` if it ever stops compiling). `composer.seed` (folded by the
 * composer's own seed effect — see `App.tsx` — never through this reducer)
 * and `control.response` (folded by the control-request correlator) are the
 * two `HostToWebview` variants every `case` in the switch above
 * deliberately leaves unhandled; every OTHER variant — exactly
 * `Exclude<HostToWebview, { type: 'composer.seed' | 'control.response' }>`
 * — must be given an explicit `case` there. If `HostToWebview` ever grows a
 * new variant that is neither of those two nor added to a `case` in EITHER
 * switch, `msg` in the `default:` branch below stops narrowing to `never`
 * and this function fails to compile — the TS narrowing handbook's
 * never-assert pattern (same shape as `foldTab`'s own `default` above and
 * `assertExhaustivePanel` in `./panels`), applied to the complementary
 * slice of the union this reducer's own switch is responsible for. This is
 * the mechanical trip-wire: without it, a genuinely new message type with
 * no `case` anywhere would compile clean forever and silently hit
 * `default: return state` above — exactly the silent-swallow class
 * `assertExhaustivePanel`'s own module doc already named for `panel.data`.
 */
function assertReduceHandlesEveryRoutedMessage(
  msg: Exclude<HostToWebview, { type: 'composer.seed' | 'control.response' }>,
): void {
  switch (msg.type) {
    case 'hydrate':
    case 'theme':
    case 'backend.state':
    case 'nextEdit.state':
    case 'system.error':
    case 'system.recovered':
    case 'gateway.health':
    case 'turn.start':
    case 'policy.state':
    case 'commands.available':
    case 'mode.state':
    case 'model.state':
    case 'panel.data':
    case 'tab.bound':
    case 'tab.error':
    case 'tab.clear':
    case 'clear':
    case 'turn.end':
    case 'user':
    case 'reasoning.start':
    case 'reasoning.delta':
    case 'reasoning.end':
    case 'message.delta':
    case 'message.end':
    case 'tool.start':
    case 'tool.update':
    case 'tool.diff':
    case 'approval.request':
    case 'approval.settle':
    case 'plan.update':
    case 'result.summary':
    case 'error':
    // Task 10: see the matching `case 'setup.progress'` in `reduce()` above
    // (folds into `AppState.setupProgress` via `foldSetupProgress`).
    case 'setup.progress':
    // P1 entry-point fix: see the matching `case 'panel.activate'` in
    // `reduce()` above (folds `AppState.activePanel`).
    case 'panel.activate':
      return;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}
// Referenced (never called) so `noUnusedLocals` doesn't flag a function
// whose entire value is compile-time-only.
void assertReduceHandlesEveryRoutedMessage;

/**
 * TI-1 (AU-39): clears `AppState.pendingSessionLoad` once the load it
 * tracks has resolved — called from BOTH the `tab.bound` and `tab.error`
 * cases below, which is why it takes the already-folded `next` state rather
 * than folding itself. Matches on `tabId` alone (never `sessionId`):
 * `tab.error` carries no `sessionId` on the wire (`protocol.ts`'s `tab.error`
 * shape has no such field), and a `tab.bound` for the loading tab is always
 * the SAME load resolving (P3's target-tab-busy refusal means a second load
 * can never be issued into a tab that already has one in flight). A
 * `tab.bound`/`tab.error` for any OTHER tabId leaves it untouched (P-1
 * isolation — an unrelated tab's own bind/error must never clear a DIFFERENT
 * tab's still-in-flight History load).
 */
function clearResolvedSessionLoad(next: AppState, tabId: string): AppState {
  if (next.pendingSessionLoad?.tabId !== tabId) return next;
  // exactOptional prep (arm 1): clear `pendingSessionLoad` by omitting the
  // key, never by writing an explicit `undefined`.
  const { pendingSessionLoad: _clearedPendingSessionLoad, ...rest } = next;
  return rest;
}

export type { PlanItem };
export { INITIAL_STATE };
