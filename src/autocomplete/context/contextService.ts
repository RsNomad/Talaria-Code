/**
 * W5-T5 · `contextService.ts` — `CrossFileContextService`, the module that
 * turns background gather triggers (tab open/close, save, active-editor
 * change, a debounced idle tick — NEVER a keystroke) into a KV-stable
 * `SnippetSnapshot` the provider reads synchronously.
 *
 * Split, mirroring this repo's established `<name>.ts`/`<name>.vscode.ts`
 * convention (`src/host/context/ports.vscode.ts`, `diffDecision.ts`/
 * `diffDecision.vscode.ts`) and W5-T2's identical `editTracker.ts`/
 * `editTrackerAdapter.ts` split: this file is the decision core — it imports
 * NO `vscode` value at all (only structural duck-typed params), so it needs
 * no `vscode` mock to unit test. The real listeners + real "recently-opened"
 * tab enumeration live in the thin, deliberately-untested
 * `contextService.vscode.ts`.
 */
import { RingBuffer, type IngestCandidate } from './ringBuffer';
import { buildSnapshot } from './snippetBudgeter';
import { shouldRegenerate } from './snapshotPolicy';
import { crossFileMode } from './mode';
import type { Anchor, CrossFileMode, SnippetCandidate, SnippetSnapshot, SnippetSource } from './types';
import type { BackendCapabilities, FimBackend, FimTemplate } from '../types';

/** §2.3 — every `gather()` call is raced against this timeout; a slow source
 *  contributes `[]` for that cycle rather than blocking the others. */
const GATHER_TIMEOUT_MS = 100;

/** How long typing must be idle before the "debounced idle tick" gather
 *  trigger fires (picks up `recently-edited` content while the user stays in
 *  the same file, without waiting for a save/tab-switch). Deliberately its
 *  OWN constant, distinct from `snapshotPolicy`'s `SNAPSHOT_IDLE_MS` — one
 *  governs when to GATHER (background, cheap to run late), the other when a
 *  SNAPSHOT may safely swap (KV-stability, §2.4). */
const DEFAULT_GATHER_IDLE_MS = 1500;

/** §2.2 Tabby-esque "give the model an intro to this open file" cap — a
 *  whole-line-count cap (never a char cap here), so this excerpt can NEVER
 *  bisect a line (A4): every line kept is complete, full stop. The
 *  budgeter's own 500-char-per-snippet cap (line-aligned too) trims further
 *  downstream. */
const OPEN_TAB_EXCERPT_LINES = 60;

const EMPTY_SNAPSHOT: SnippetSnapshot = Object.freeze({ snippets: Object.freeze([]) });

// ─────────────────────────────────────────────────────────────────────────
// §2.4 finding 2 — the shared egress predicate. The provider's `:39`/`:43`
// guards (untrusted-remote skip, enabled) ARE these preconditions; both the
// provider AND the (T7) warm-up hook consult this ONE function so the two
// call sites can never drift out of sync with each other.
// ─────────────────────────────────────────────────────────────────────────
export interface EgressPreconditionsInput {
  readonly skipUntrustedRemote: boolean;
  readonly enabled: boolean;
}

export function egressPreconditionsMet(input: EgressPreconditionsInput): boolean {
  return !input.skipUntrustedRemote && input.enabled;
}

// ─────────────────────────────────────────────────────────────────────────
// "recently-opened" candidate shaping — pure. The vscode-touching tab
// enumeration (`contextService.vscode.ts`) hands this already-materialized,
// already-POSIX-relative tab data; this function owns the one real DECISION
// (ordering + line-aligned excerpting), matching "put any real decision in a
// pure helper" (brief).
// ─────────────────────────────────────────────────────────────────────────
export interface OpenTab {
  readonly uri: string;
  readonly filepath: string;
  readonly content: string;
}

/**
 * §2.2 "open tabs, most-recently-focused first". `mruUris` is most-recent
 * FIRST (the caller's focus history); a tab never seen in `mruUris` (opened
 * but never focused this session) sorts after every MRU-known tab, in its
 * original `tabs` order (stable sort). `activeUri` is excluded —
 * belt-and-braces; `ringBuffer.ingest` drops the active document too.
 *
 * Returned candidates are in "most-recently-focused FIRST" order — the
 * caller (`CrossFileContextService`) is responsible for ingesting them in
 * REVERSE so that ordering survives `RingBuffer`'s prepend-based ring (see
 * `runGatherCycle`'s doc comment).
 */
export function buildRecentlyOpenedCandidates(
  tabs: readonly OpenTab[],
  mruUris: readonly string[],
  activeUri: string | undefined,
): SnippetCandidate[] {
  const rank = new Map(mruUris.map((uri, index) => [uri, index]));
  const ordered = tabs
    .filter((tab) => tab.uri !== activeUri)
    .map((tab, originalIndex) => ({ tab, originalIndex }))
    .sort((a, b) => {
      const rankA = rank.get(a.tab.uri) ?? Number.MAX_SAFE_INTEGER;
      const rankB = rank.get(b.tab.uri) ?? Number.MAX_SAFE_INTEGER;
      return rankA !== rankB ? rankA - rankB : a.originalIndex - b.originalIndex;
    })
    .map(({ tab }) => tab);

  return ordered.map((tab): SnippetCandidate => {
    const lines = tab.content.split('\n').slice(0, OPEN_TAB_EXCERPT_LINES);
    return {
      uri: tab.uri,
      filepath: tab.filepath,
      content: lines.join('\n'),
      kind: 'recently-opened',
      startLine: 0,
      endLine: Math.max(lines.length - 1, 0),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// A minimal `EditTracker`-shaped source — kept here (not in
// `editTracker.ts`/`editTrackerAdapter.ts`, T2-owned files this task only
// CONSUMES) so T5 owns zero lines in T2's files.
// ─────────────────────────────────────────────────────────────────────────
export interface RecentEditsReader {
  getRecentEdits(): Array<{
    uri: string;
    filepath: string;
    startLine: number;
    endLine: number;
    content: string;
  }>;
}

export function createEditTrackerSource(tracker: RecentEditsReader): SnippetSource {
  return {
    kind: 'recently-edited',
    async gather(anchor: Anchor): Promise<SnippetCandidate[]> {
      return tracker
        .getRecentEdits()
        .filter((edit) => edit.uri !== anchor.uri)
        .map((edit): SnippetCandidate => ({
          uri: edit.uri,
          filepath: edit.filepath,
          content: edit.content,
          kind: 'recently-edited',
          startLine: edit.startLine,
          endLine: edit.endLine,
        }));
    },
  };
}

/** §2.3 — races one source's `gather()` against `GATHER_TIMEOUT_MS`; a slow
 *  or hung source resolves to `[]` for this cycle (never blocks the others)
 *  and its `AbortSignal` is aborted so a well-behaved source can bail early.
 *  Note: this only rescues a HUNG source. A source whose `gather()` REJECTS
 *  wins the `Promise.race` with that rejection — the caller (`runGatherCycle`)
 *  is responsible for catching a rejecting source separately (fix w5-t5). */
function raceWithTimeout(
  run: (signal: AbortSignal) => Promise<SnippetCandidate[]>,
  ms: number,
): Promise<SnippetCandidate[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<SnippetCandidate[]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve([]);
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Structural, duck-typed sink for non-fatal gather-cycle failures — mirrors
 * `host/transport/JsonRpcStdio.ts`'s `Logger` shape (`append(line)`) without
 * importing it, so this file keeps its zero-vscode-value-import guarantee
 * and gains no dependency on `host/transport` for a single optional method.
 */
export interface GatherCycleLogger {
  append(line: string): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CrossFileContextServiceModeInput {
  readonly capabilities: BackendCapabilities;
  readonly template: FimTemplate;
  readonly crossFileEnabled: boolean;
  /** Already the EFFECTIVE (loopback-gated) value — `config.ts`'s
   *  `effectivePrefixInjection` is the caller's job, not this class's. */
  readonly prefixInjection: boolean;
  /**
   * W5-T7 — the currently-active `FimBackend`, re-supplied on every
   * `reconfigure()` alongside `capabilities`/`template` so a backend switch
   * (e.g. `talaria.autocomplete.backend` changes from `ollama` to
   * `llamacpp`) retargets warm-up immediately rather than firing against a
   * stale backend instance. Optional — most tests of this service don't
   * exercise warm-up at all and can omit it (no `.warmUp` ever fires
   * without it, same as any other backend that doesn't implement it).
   */
  readonly backend?: FimBackend;
}

export interface CrossFileContextServiceDeps extends CrossFileContextServiceModeInput {
  readonly ringBuffer: RingBuffer;
  readonly sources: readonly SnippetSource[];
  /** Live "where is the user's attention right now" reader — used BOTH to
   *  tag a gather request and, re-read after the gather resolves, as the
   *  ingest-time `currentAnchor` for the stale-async drop (§2.4). Injected
   *  so the class needs no `vscode.window.activeTextEditor` of its own. */
  readonly getCurrentAnchor: () => Anchor;
  readonly getSkipUntrustedRemote: () => boolean;
  readonly getEnabled: () => boolean;
  /**
   * W5-T7 — reads `talaria.autocomplete.crossFile.warmUp` (default false).
   * A stable closure over live config (like `getEnabled`/
   * `getSkipUntrustedRemote`), NOT re-supplied via `reconfigure()` — it
   * needs no refresh path of its own because `index.ts` closes over the
   * SAME mutable `cfg` binding `getEnabled` already does. Optional; a
   * caller that omits it gets the safe default (warm-up off).
   */
  readonly getWarmUpEnabled?: () => boolean;
  readonly now?: () => number;
  readonly gatherIdleMs?: number;
  /** Optional non-fatal-failure sink (fix w5-t5) — a rejecting `gather()` or
   *  any other unexpected `runGatherCycle` throw is always swallowed
   *  regardless of whether a logger is supplied; this is diagnostics only. */
  readonly logger?: GatherCycleLogger;
}

export interface CrossFileContextServiceStatus {
  readonly mode: CrossFileMode;
  readonly snippetCount: number;
}

/**
 * The decision core. Deliberately holds no `vscode` value import — every
 * vscode-shaped input arrives pre-materialized through injected callbacks
 * (`getCurrentAnchor`) or plain data (`sources`), so this class is testable
 * with zero mocking (see `contextService.test.ts`).
 *
 * TIER (W6-FK / I-9 honest grading — see `src/host/purityScan.ts`'s
 * three-tier vocabulary doc): **headless**, NOT pure. Vscode-free, yes — but
 * `this.now` defaults to the real `Date.now` (constructor below), so a
 * freshly-constructed instance is NOT deterministic unless a caller
 * explicitly injects a fake `now`. Mechanically scanned (vscode/fs-free) by
 * `contextPurity.test.ts`, which also pins this file to `headless`
 * (not `pure`) honestly, matching what it actually is.
 */
export class CrossFileContextService {
  private readonly ringBuffer: RingBuffer;
  private readonly sources: readonly SnippetSource[];
  private readonly getCurrentAnchor: () => Anchor;
  private readonly getSkipUntrustedRemote: () => boolean;
  private readonly getEnabled: () => boolean;
  private readonly getWarmUpEnabled: () => boolean;
  private readonly now: () => number;
  private readonly gatherIdleMs: number;
  private readonly logger: GatherCycleLogger | undefined;
  /** W5-T7 — re-supplied on every `reconfigure()`, see
   *  `CrossFileContextServiceModeInput.backend`'s doc comment. */
  private backend: FimBackend | undefined;
  /** The `AbortController` behind the MOST RECENT warm-up fired, if any —
   *  aborted when a NEWER regenerate supersedes it (the snippet set it was
   *  priming KV for is already stale the moment a new snapshot exists) and
   *  on `dispose()` so no in-flight warm-up outlives the service. */
  private warmUpAbortController: AbortController | undefined;

  private mode: CrossFileMode = 'none';
  private cachedSnapshot: SnippetSnapshot = EMPTY_SNAPSHOT;
  /** The ring-buffer epoch the CACHED snapshot was last built from. Starts
   *  at -1 (never equal to a real epoch, which starts at 0) so the very
   *  first `snapshotFor` call with any ingested content regenerates. */
  private snapshotEpoch = -1;
  private pendingBoundaryEvent = false;
  private lastKeystrokeAt = 0;
  private gatherChain: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: CrossFileContextServiceDeps) {
    this.ringBuffer = deps.ringBuffer;
    this.sources = deps.sources;
    this.getCurrentAnchor = deps.getCurrentAnchor;
    this.getSkipUntrustedRemote = deps.getSkipUntrustedRemote;
    this.getEnabled = deps.getEnabled;
    this.getWarmUpEnabled = deps.getWarmUpEnabled ?? (() => false);
    this.now = deps.now ?? Date.now;
    this.gatherIdleMs = deps.gatherIdleMs ?? DEFAULT_GATHER_IDLE_MS;
    this.logger = deps.logger;
    this.reconfigure(deps);
  }

  /**
   * §4.2 — recompute the assembly mode. Called once at construction and
   * again by `index.ts`'s existing `rebuild()` on every config/backend/model
   * change (critic-C finding 7: no new refresh path). Mode `none` idles
   * every future gather trigger; it does NOT retroactively empty the ring
   * (harmless — `snapshotFor` checks `mode === 'none'` FIRST, before
   * touching the cache, so a stale non-empty ring under a newly-`none` mode
   * still yields an empty snapshot).
   */
  reconfigure(input: CrossFileContextServiceModeInput): void {
    this.mode = crossFileMode(input.capabilities, input.template, {
      crossFileEnabled: input.crossFileEnabled,
      prefixInjection: input.prefixInjection,
    });
    this.backend = input.backend;
  }

  getStatus(): CrossFileContextServiceStatus {
    return { mode: this.mode, snippetCount: this.cachedSnapshot.snippets.length };
  }

  /**
   * §3.3 item 4 / P7 — the ONLY sound quarantine-clear condition: a
   * whole-file save signal from OUTSIDE the ring buffer. Runs UNCONDITIONALLY
   * (even under `mode === 'none'`) — clearing a quarantine entry the moment
   * mode idles is harmless bookkeeping, not an egress decision; gathering
   * itself stays gated below. Deliberately NOT wired to every keystroke
   * (churny) — save is the meaningful whole-file boundary.
   */
  handleSave(uri: string): Promise<void> {
    this.ringBuffer.clearQuarantine(uri);
    this.pendingBoundaryEvent = true;
    return this.triggerGather();
  }

  /** §2.4 boundary event (active-editor change is ALSO a snapshot boundary,
   *  unlike tab open/close and the idle tick below). */
  handleActiveEditorChange(): Promise<void> {
    this.pendingBoundaryEvent = true;
    return this.triggerGather();
  }

  /** A gather trigger (§2.1) — NOT a snapshot boundary event (§2.4 defines
   *  boundary as active-editor-change/save only). */
  handleTabsChanged(): Promise<void> {
    return this.triggerGather();
  }

  /**
   * Cheap, keystroke-path-legal bookkeeping (O(1) — mirrors `EditTracker`'s
   * own per-keystroke `record()`, which the architecture already accepts on
   * this path): stamps `lastKeystrokeAt` for `snapshotPolicy`'s idle check,
   * and (re)arms the debounced idle-tick gather trigger. The actual
   * gather/scan cost only runs once typing has been idle for
   * `gatherIdleMs` — never per keystroke (§2.1).
   */
  recordKeystroke(): void {
    this.lastKeystrokeAt = this.now();
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      void this.triggerGather();
    }, this.gatherIdleMs);
  }

  /**
   * Reliability fix (Opus review, w5-t5) — a single `source.gather()`
   * rejection used to permanently poison `gatherChain`: once a `.then()`
   * link in the chain settles rejected, every SUBSEQUENT
   * `.then(onFulfilled)` skips `runGatherCycle` forever (onFulfilled is
   * never called on a rejected promise), silently killing all future
   * background gathering for the session, AND surfacing as an unhandled
   * promise rejection at the `.vscode.ts` call sites (`void
   * this.triggerGather()` / `handleSave` etc. attach no `.catch`).
   *
   * `runGatherCycle` itself can no longer reject (see its own try/catch,
   * plus the per-source `.catch(() => [])` inside it) — so under normal
   * operation this method's chained `.catch()` below never needs to rescue
   * anything. It is defense-in-depth ONLY: it ensures `gatherChain` (and the
   * promise returned to the caller) can never become permanently rejected
   * even under some hypothetical FUTURE regression that reintroduces a
   * throw inside `runGatherCycle` — a bad cycle stays a no-op, the next
   * trigger still runs a real gather.
   *
   * Deliberately just ONE `.then(() => this.runGatherCycle())` hop off
   * `this.gatherChain`, matching the ORIGINAL chaining shape exactly — an
   * extra `.catch()` inserted BEFORE this `.then()` would add a second
   * microtask hop before `runGatherCycle` (and its `requestAnchor` capture)
   * actually runs, silently breaking the one-microtask timing the
   * stale-anchor-drop tests pin (see `contextService.test.ts`'s
   * `makeDeferredSource` doc comment). The trailing `.catch()` is safe to
   * chain AFTER `.then()` because it does not delay the `.then()` callback
   * itself — it only guards the promise `gatherChain` is reassigned to.
   */
  private triggerGather(): Promise<void> {
    if (this.mode === 'none') {
      // R6 — mode `none` means sources idle: zero gather, zero scan, zero
      // ring churn. No source is ever invoked past this line.
      return Promise.resolve();
    }
    const cycle = this.gatherChain.then(() => this.runGatherCycle()).catch((err: unknown) => {
      this.logger?.append(
        `[CrossFileContextService] gather chain guard caught an unexpected rejection — treating as a no-op cycle: ${errorMessage(err)}`,
      );
    });
    this.gatherChain = cycle;
    return cycle;
  }

  /**
   * §2.3/§2.4 — every source races against `GATHER_TIMEOUT_MS`, tagged with
   * the anchor at REQUEST time. After the await, `currentAnchor` is
   * re-read LIVE — if the user has since moved to another file/scope,
   * `ringBuffer.ingest` drops every candidate from this cycle on its own
   * (stale-async drop); this method does not need to special-case that.
   *
   * Ingestion order: each source is documented to return candidates
   * most-recent-FIRST (`buildRecentlyOpenedCandidates`, `EditTracker`'s own
   * `getRecentEdits()`). `RingBuffer.ingest` PREPENDS each accepted
   * candidate, so ingesting in FORWARD array order would put the LEAST
   * recent one at the ring's front (inverted). Iterating each source's
   * result in REVERSE restores the intended order: the most-recent
   * candidate is ingested LAST and lands at index 0.
   *
   * Reliability fix (Opus review, w5-t5): `raceWithTimeout` only rescues a
   * HUNG source (timeout → `[]`) — a source whose `gather()` REJECTS wins
   * `Promise.race` with that rejection, which used to reject the whole
   * `Promise.all` below, discarding every OTHER (healthy) source's results
   * for the cycle and rejecting this method, which in turn permanently
   * poisoned `triggerGather`'s `gatherChain` (see its doc comment). Each
   * source's raced promise now carries its own `.catch(() => [])`: a
   * rejecting source contributes an empty result for THIS cycle only —
   * `Promise.all` still resolves, every other source's candidates still
   * ingest, and the ring simply has less to show this cycle (fails toward
   * LESS context, never more egress). The outer try/catch is a second,
   * independent safety net for any OTHER unexpected throw in this method
   * (e.g. `getCurrentAnchor`/`ringBuffer.ingest`) — a bad cycle is a no-op,
   * never a rejection.
   */
  private async runGatherCycle(): Promise<void> {
    try {
      const requestAnchor = this.getCurrentAnchor();
      const perSource = await Promise.all(
        this.sources.map((source) =>
          raceWithTimeout((signal) => source.gather(requestAnchor, signal), GATHER_TIMEOUT_MS).catch(
            (err: unknown): SnippetCandidate[] => {
              this.logger?.append(
                `[CrossFileContextService] source '${source.kind}' gather() rejected — contributing [] for this cycle: ${errorMessage(err)}`,
              );
              return [];
            },
          ),
        ),
      );

      const liveAnchor = this.getCurrentAnchor();
      for (const candidates of perSource) {
        for (let i = candidates.length - 1; i >= 0; i--) {
          const candidate = candidates[i];
          if (candidate === undefined) {
            // Unreachable: i ranges over [0, candidates.length - 1] here.
            continue;
          }
          // Field-by-field (not an object spread) on purpose:
          // `ringBuffer.test.ts`'s SPREAD_RE source-scan lock flags any
          // brand-preserving spread-plus-override object literal outside
          // its sanctioned file list, and this file isn't one of them — a
          // spread here would be a false positive for THAT lock's actual
          // concern (ScannedSnippet content provenance), but the lock is a
          // deliberately blunt syntactic scan, not a type-aware one.
          const ingestCandidate: IngestCandidate = {
            uri: candidate.uri,
            filepath: candidate.filepath,
            content: candidate.content,
            kind: candidate.kind,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            score: candidate.score,
            anchor: requestAnchor,
          };
          this.ringBuffer.ingest(ingestCandidate, liveAnchor.uri, liveAnchor);
        }
      }
    } catch (err) {
      this.logger?.append(
        `[CrossFileContextService] gather cycle failed — skipping this cycle: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * SYNCHRONOUS — a read of already-materialized state (§2.1). `document`
   * is accepted structurally (not `vscode.TextDocument`) so this file needs
   * no `vscode` value/type import at all.
   *
   * `mode === 'none'` (disabled, or the backend/model has no snippet
   * channel) short-circuits to the frozen empty snapshot BEFORE touching
   * the policy or the cache — exact v1 no-egress behavior, fail toward LESS
   * egress on any misconfiguration.
   */
  snapshotFor(document: { readonly uri: { toString(): string } }): SnippetSnapshot {
    if (this.mode === 'none') {
      return EMPTY_SNAPSHOT;
    }

    const currentEpoch = this.ringBuffer.currentEpoch();
    const decision = shouldRegenerate({
      prevEpoch: this.snapshotEpoch,
      currentEpoch,
      boundaryEvent: this.pendingBoundaryEvent,
      lastKeystrokeAt: this.lastKeystrokeAt,
      now: this.now(),
    });

    if (decision === 'regenerate') {
      // Immutable copy-on-write: `buildSnapshot` returns a NEW frozen
      // snapshot; the OLD `this.cachedSnapshot` reference is never mutated,
      // only replaced — a completion already holding the old reference (via
      // the provider's ONE-TIME capture) is unaffected (§2.4).
      const next = buildSnapshot(this.ringBuffer.allScanned(), this.mode, document.uri.toString());
      this.cachedSnapshot = next;
      this.snapshotEpoch = currentEpoch;
      // Consumed only on an ACTUAL regenerate — a `reuse` decision (whether
      // because the epoch hasn't changed yet, or because it changed but the
      // boundary/idle gate hasn't fired) must NOT drop a pending boundary
      // flag that a LATER call still needs to see.
      this.pendingBoundaryEvent = false;
      this.maybeWarmUp(next);
    }

    return this.cachedSnapshot;
  }

  /**
   * §2.4 warm-up hook (W5-T7). Fires a llama.vim-style KV-cache warm-up,
   * fire-and-forget, ONLY when ALL of:
   *  1. `getWarmUpEnabled()` — `talaria.autocomplete.crossFile.warmUp`,
   *     default-off (no default-on until Fedora P2 evidence).
   *  2. `egressPreconditionsMet()` — the SAME shared predicate the provider
   *     itself consults (R14 — warm-up is a second, independent egress
   *     initiator that inherits none of the provider's guards, since it
   *     fires from `contextService`, not `provideInlineCompletionItems`).
   *  3. The active backend actually exposes `.warmUp` (only
   *     `LlamaCppInfillBackend` this wave; every other backend safely
   *     no-ops here via optional chaining).
   *
   * Carries `snapshot.snippets` — the SAME already-scanned array just built
   * by `buildSnapshot` — verbatim. Never re-gathers, never touches
   * active-file prefix/suffix (this method's parameter type,
   * `SnippetSnapshot`, has no such field to reach for even by mistake).
   *
   * A superseding regenerate aborts any still-in-flight PREVIOUS warm-up
   * (its snippet set is already stale the moment a newer snapshot exists)
   * — `LlamaCppInfillBackend.warmUp` swallows the resulting abort error
   * internally, so this is purely a "stop wasting the request" optimization,
   * never something this method needs to await or react to.
   */
  private maybeWarmUp(snapshot: SnippetSnapshot): void {
    if (
      !egressPreconditionsMet({
        skipUntrustedRemote: this.getSkipUntrustedRemote(),
        enabled: this.getEnabled(),
      })
    ) {
      return;
    }
    if (!this.getWarmUpEnabled()) {
      return;
    }
    if (!this.backend?.warmUp) {
      return;
    }
    this.warmUpAbortController?.abort();
    const controller = new AbortController();
    this.warmUpAbortController = controller;
    this.backend.warmUp(snapshot.snippets, controller.signal);
  }

  dispose(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    this.warmUpAbortController?.abort();
  }
}
