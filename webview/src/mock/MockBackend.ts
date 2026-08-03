/*
 * MockBackend — canned host used when no VS Code extension is present.
 * ------------------------------------------------------------------
 * It receives webview->host messages and replays the SHARED scripted
 * host->webview stream (mirrored from src/shared/mockScenario.ts): a full agent
 * turn (reasoning -> tool -> diff -> approval -> plan -> message -> result) plus
 * static-but-real-looking panel payloads. This is the same message shape the
 * real host emits, so App renders identically either way.
 *
 * In the shipped extension the real host owns this contract; the MockBackend is
 * only wired in standalone dev (see bridge.attachMock).
 *
 * W4-T3b (§7 B12): this is the ONLY place W4's multi-tab UI is driveable
 * pre-Fedora under the build-blind rule, so it now mints a REAL session PER
 * TAB (`mock-session-N`) and plays an INDEPENDENT copy of the scripted turn
 * per session — two tabs' turns genuinely interleave, exercising the P-1
 * bleed hazard, the tab strip, drop-unknown routing, and the pending/bound
 * composer states with real (not merely typed) coverage.
 */
import type {
  EditPolicyPreset,
  GlobalPanel,
  HostToWebview,
  NextEditToggleSource,
  NextEditToggleState,
  Panel,
  PanelDataMap,
  WebviewToHost,
  WebviewState,
} from '../protocol';
import { BOOTSTRAP_TAB_ID, makePanelData } from '../protocol';
import { mockApprovalId, mockTheme, mockTurn, panelData } from './fixtures';
import { NEXT_EDIT_ROWS } from '../panels/nextEditCopy';

type Send = (msg: HostToWebview) => void;

/**
 * Task 12 (§5.5/D7 re-base): the set of valid `nextEdit.toggle` sources,
 * DERIVED from the same single-sourced row table the panels render
 * (`NEXT_EDIT_ROWS`) rather than hardcoded as a second copy of the literal
 * pair `'next' | 'generic'` — so a future third NEXT source added to
 * `nextEditCopy.ts` without touching this file fails the malformed-request
 * check instead of silently validating against a stale set.
 */
function isNextEditSource(value: unknown): value is NextEditToggleSource {
  return NEXT_EDIT_ROWS.some((row) => row.source === value);
}

/**
 * Task 12 (§5.5/D7): structural-replace semantics, mirroring the real
 * Guard's `applyToggleToSource` (`src/autocomplete/nextedit/guard.ts`) —
 * unreachable from here since that module imports `vscode`. Turning a
 * source ON always REPLACES whichever source was on before (an enum cannot
 * hold two "on" values, so there is no conflict state left to refuse);
 * turning the ACTIVE source OFF returns to fully-off; turning an already
 * INACTIVE source off is a no-op. This used to be a refusal (turning the
 * second source on while the first was ratified rejected the request) — the
 * refusal is GONE from both the real Guard (since Task 2) and this mock now.
 */
function applyNextEditToggle(
  current: NextEditToggleState,
  source: NextEditToggleSource,
  on: boolean,
): NextEditToggleState {
  if (on) {
    return source === 'next' ? { next: true, generic: false } : { next: false, generic: true };
  }
  return source === 'next' ? { next: false, generic: current.generic } : { next: current.next, generic: false };
}

const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** One bound tab's independent scripted-turn player + policy state. */
interface SessionPlayer {
  readonly sessionId: string;
  timers: ReturnType<typeof setTimeout>[];
  /** Index in `mockTurn` the player is parked at, waiting on an approval; -1 when free. */
  parkedAt: number;
  preset: EditPolicyPreset;
  /** W3-T8 (closes L1 m8): the text of the LATEST `prompt` this session
   * received — restamped onto the scripted `user` step's text at replay
   * time, in place of `mockTurn`'s canned string. Empty until a first
   * `prompt` arrives (the scripted `user` step is only ever emitted after
   * one has). */
  promptText: string;
}

/**
 * Shallow-restamp a scripted `HostToWebview` message onto `sessionId` — every
 * `mockTurn` step bakes in a single fixed session id; replaying the SAME
 * script for a second, independent tab must not leak the first tab's id.
 *
 * W3-T8 (closes L1 m8): the scripted `user` step also bakes in CANNED text
 * (`mockTurn`'s fixed "Refactor the login()..." string). Replaying that
 * verbatim makes the F5 mock demo echo a prompt the person never typed —
 * restamp the step's `text` with `promptText` (the ACTUAL incoming prompt)
 * too, the same way `sessionId` is restamped. Every other scripted field
 * (assistant steps, tools, timing, the frozen `mockTurn` data itself) is
 * untouched.
 */
function restamp(msg: HostToWebview, sessionId: string, promptText: string): HostToWebview {
  if (msg.type === 'user') return { ...msg, sessionId, text: promptText };
  if ('sessionId' in msg) return { ...msg, sessionId };
  return msg;
}

export class MockBackend {
  private send: Send;
  /** W4-T3b (B12): one player per BOUND tab, keyed by sessionId — the
   * two-tab interleave vehicle. Replaces the old single connection-level
   * `parkedAt`/`timers`/`preset`/`currentSessionId` fields. */
  private readonly players = new Map<string, SessionPlayer>();
  /** The bootstrap tab's session id, once auto-bound (mirrors the REAL
   * backend's `establishInitialSession`/host MockBackend's `start()` —
   * §2c: "the first tab's open replaces today's in-`start()` session
   * mint" is honored here too: the bootstrap tab binds on `ready`, no
   * explicit `tab.open` needed for tab #1). */
  private bootstrapSessionId: string | undefined;
  private nextMockSessionSeq = 0;
  /** R5 (Task 13): the scaffold's stand-in for the Guard's `globalState`
   *  store. In-memory only — the standalone app has no persistence — and
   *  boots both-OFF, the same hardcoded first-run default the Guard uses. */
  private nextEditToggles: NextEditToggleState = { next: false, generic: false };

  constructor(send: Send) {
    this.send = send;
  }

  /** Handle an inbound webview->host message. */
  handle(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.hydrate();
        break;
      case 'prompt':
        this.runTurn(msg.sessionId, msg.text);
        break;
      case 'newSession':
        // Legacy connection-global "start over" affordance (no sessionId on
        // the wire) — operates on the bootstrap session, matching the
        // pre-T3b single-session behavior; the tab strip's "+" is `tab.open`.
        this.newSessionFor(this.bootstrapSessionId ?? this.bindBootstrap());
        break;
      case 'switchPanel':
        this.sendPanel(msg.panel);
        break;
      case 'tab.open':
        this.bindTab(msg.tabId);
        break;
      case 'tab.newSession':
        // W3-T6 (CF-11/D2): the composer's per-tab "New Session" — clears
        // and replaces ONLY this tab's own player, leaving every sibling
        // tab's player (and its scripted turn) running untouched.
        this.newSessionInTab(msg.tabId, msg.sessionId);
        break;
      case 'control.request':
        this.handleControlRequest(msg);
        break;
      case 'approval.respond':
        this.resumeParked(msg.sessionId, msg.id);
        break;
      case 'cancel':
        this.cancelTurn(msg.sessionId);
        break;
      case 'policy.setPreset': {
        const player = this.players.get(msg.sessionId);
        if (player) player.preset = msg.preset;
        this.send({ type: 'policy.state', sessionId: msg.sessionId, preset: msg.preset });
        break;
      }
      case 'setModel':
        // ARCH-1 (final review, UI I-1) / T2: the mock always confirms — the
        // real host's `SessionController.setModel` only ever emits a
        // rejection when the underlying ACP `session/set_model` call fails,
        // which the mock has no analogue for. This closes the P7-N6 "push
        // that never came" gap (`modelSelection.ts`'s header doc): before
        // this, ModelsPanel's header/highlight (`resolveEffectiveModelId`)
        // never saw a corrective/confirming push and stayed pinned to the
        // stale panel payload until the next unrelated re-hydrate.
        this.send({ type: 'model.state', sessionId: msg.sessionId, modelId: msg.modelId });
        break;
      default:
        // setMode / diff.resolve / control.invoke / tab.close / tab.activate
        // are acknowledged optimistically in the UI; nothing to echo in the
        // mock.
        break;
    }
  }

  dispose(): void {
    for (const player of this.players.values()) this.clearTimers(player);
  }

  // ---- tab binding ----

  /** Auto-bind the bootstrap tab (idempotent — only the FIRST `ready` binds
   * it, mirroring the real backend's `backendStarted` R-C4 latch). Returns
   * its sessionId. */
  private bindBootstrap(): string {
    if (this.bootstrapSessionId) return this.bootstrapSessionId;
    const sessionId = this.mintSession();
    this.bootstrapSessionId = sessionId;
    this.registerPlayer(sessionId);
    this.emit({ type: 'tab.bound', tabId: BOOTSTRAP_TAB_ID, sessionId, rootId: sessionId });
    return sessionId;
  }

  /** W4 §2d/§7 B12: mint a fresh session and bind it to a NEW (non-bootstrap)
   * tab — the "+" button's real, independently-playable multi-session path. */
  private bindTab(tabId: string): void {
    const sessionId = this.mintSession();
    this.registerPlayer(sessionId);
    this.emit({ type: 'tab.bound', tabId, sessionId, rootId: sessionId });
  }

  /**
   * W3-T6 (CF-11/D2): rebind ONLY `tabId` — retire its OLD player (if any,
   * keyed by the wire's own `sessionId` hint; this scaffold has no
   * tabId-keyed registry to re-derive it from, unlike the real backend's
   * `getByTabId`) and mint a fresh one bound to the SAME tab. Every OTHER
   * tab's player is never touched — `players` only ever loses the ONE entry
   * named here.
   *
   * IMP-2/MIN-B (3-lens review, parity with the real backend + host mock):
   * the clear is `tab.clear{tabId}` — tabId-keyed, not the old
   * sessionId-keyed `clear` — and UNCONDITIONAL (fires even when `sessionId`
   * is absent/unresolvable), so the same emission reaches a session-lost tab
   * exactly like the real backend's `newSessionInTabInternal` now does.
   */
  private newSessionInTab(tabId: string, sessionId?: string): void {
    if (sessionId) {
      const old = this.players.get(sessionId);
      if (old) {
        this.clearTimers(old);
        this.players.delete(sessionId);
      }
    }
    this.emit({ type: 'tab.clear', tabId });
    const fresh = this.mintSession();
    this.registerPlayer(fresh);
    this.emit({ type: 'tab.bound', tabId, sessionId: fresh, rootId: fresh });
    if (tabId === BOOTSTRAP_TAB_ID) this.bootstrapSessionId = fresh;
  }

  private registerPlayer(sessionId: string): void {
    this.players.set(sessionId, { sessionId, timers: [], parkedAt: -1, preset: 'manual', promptText: '' });
  }

  /** W4 §2d/§7 B12: mint the next scaffold session id (`mock-session-N`). */
  private mintSession(): string {
    this.nextMockSessionSeq += 1;
    return `mock-session-${this.nextMockSessionSeq}`;
  }

  // ---- scripted streams (per session) ----

  private hydrate(): void {
    this.send({ type: 'theme', theme: mockTheme });
    const state: WebviewState = {
      sessionId: null,
      theme: mockTheme,
      mode: 'default',
      // D2 (A2): this standalone webview-dev mock has no real backend at
      // all — 'mock' is the only honest value.
      backendKind: 'mock',
      // W2-F1: reflect the live preset (boots at 'manual', the same
      // ask-everything default as the real host) so a rebuild stays coherent.
      preset: 'manual',
      currentModelId: null,
      activePanel: 'chat',
    };
    this.send({ type: 'hydrate', state });
    // R5 (Task 13): mirror the host's mount-time `nextEdit.state` push, so the
    // scaffold's Settings rows are seeded from the (mock) store rather than
    // rendering the boot default indefinitely.
    this.send({ type: 'nextEdit.state', state: this.nextEditToggles });
    this.bindBootstrap();
  }

  private newSessionFor(sessionId: string): void {
    const player = this.players.get(sessionId);
    if (player) {
      this.clearTimers(player);
      player.parkedAt = -1;
    }
    this.emit({ type: 'clear', sessionId });
  }

  private sendPanel(panel: Panel): void {
    if (panel === 'chat') return;
    this.emit(this.buildPanelDataMessage(panel, panelData[panel]));
  }

  /**
   * W4 §7 B2: mirrors `AcpBackend.buildPanelDataMessage`/the host
   * MockBackend's twin — the standalone mock has no real per-root/per-cwd
   * scoping either (S0/T3b posture unchanged for panels — B12 is scoped to
   * the CHAT interleave), so `rootId`/`cwd` both fall back to the bootstrap
   * (or freshly-bound) session id.
   */
  private buildPanelDataMessage<P extends Exclude<Panel, 'chat'>>(panel: P, data: PanelDataMap[P]): HostToWebview {
    const sessionId = this.bootstrapSessionId ?? this.bindBootstrap();
    if (panel === 'subagents') {
      return makePanelData(panel, data as PanelDataMap['subagents'], { sessionId });
    }
    if (panel === 'checkpoints') {
      return makePanelData(panel, data as PanelDataMap['checkpoints'], { rootId: sessionId });
    }
    if (panel === 'sessions') {
      return makePanelData(panel, data as PanelDataMap['sessions'], { cwd: sessionId });
    }
    if (
      panel === 'tools' ||
      panel === 'mcp' ||
      panel === 'skills' ||
      panel === 'models' ||
      panel === 'settings' ||
      panel === 'setup'
    ) {
      return makePanelData(panel, data as PanelDataMap[GlobalPanel]);
    }
    const exhaustive: never = panel;
    throw new Error(`unhandled panel: ${String(exhaustive)}`);
  }

  /**
   * Answer a correlated `control.request` (Part A2): fire the relevant
   * `panel.data` push (for a panel fetch) or a canned result (checkpoint
   * restore), then always echo a `control.response` back so the webview's
   * pending promise resolves — the standalone mirror of the host's
   * `invokeControl` round trip.
   */
  private handleControlRequest(msg: Extract<WebviewToHost, { type: 'control.request' }>): void {
    const { requestId, method, params } = msg;
    if (method === 'panel.data') {
      const panel = (params as { panel?: Panel } | undefined)?.panel;
      if (panel && panel !== 'chat') this.sendPanel(panel);
      this.send({ type: 'control.response', requestId, ok: true, result: undefined });
      return;
    }
    if (method === 'checkpoint.restore') {
      this.send({
        type: 'control.response',
        requestId,
        ok: true,
        result: { restored: true, filesChanged: 0, changedPaths: [] },
      });
      return;
    }
    if (method === 'nextEdit.toggle') {
      this.handleNextEditToggle(requestId, params);
      return;
    }
    // Any other correlated method: acknowledge with no result.
    this.send({ type: 'control.response', requestId, ok: true, result: undefined });
  }

  /**
   * R5 (Task 13), RE-BASED by Task 12 (§5.5/D7): the standalone mirror of
   * the host's Guard. Modelled, not acked: the catch-all above would have
   * confirmed BOTH sources on, which is precisely the both-on state the
   * real Guard makes unreachable — and this scaffold is the only place the
   * toggle UX can be driven pre-Fedora, so it has to tell the truth.
   *
   * Mirrors `applyNextEditToggle`'s structural-replace rule and
   * `NextEditGuard`'s push ordering: the new state is notified BEFORE the
   * response resolves. There is no refusal path left to model — turning the
   * second source on REPLACES the first instead of being rejected.
   */
  private handleNextEditToggle(requestId: number, params: Record<string, unknown> | undefined): void {
    const source = params?.source;
    const on = params?.on;
    if (!isNextEditSource(source) || typeof on !== 'boolean') {
      this.send({
        type: 'control.response',
        requestId,
        ok: false,
        error: { message: 'Next Edit: malformed toggle request.' },
      });
      return;
    }
    this.nextEditToggles = applyNextEditToggle(this.nextEditToggles, source, on);
    this.send({ type: 'nextEdit.state', state: this.nextEditToggles });
    this.send({ type: 'control.response', requestId, ok: true, result: this.nextEditToggles });
  }

  /** Start (or restart) `sessionId`'s scripted turn from the top — an
   * unregistered sessionId (a `prompt` for a session the mock never bound,
   * theoretically unreachable through the real App.tsx flow) is dropped
   * silently rather than fabricating a player, mirroring the reducer's own
   * drop-unknown discipline.
   *
   * W3-T8 (closes L1 m8): `text` is the prompt the user actually typed —
   * stashed on the player so `playFrom` can restamp the scripted `user`
   * step with it instead of replaying `mockTurn`'s canned string. */
  private runTurn(sessionId: string, text: string): void {
    const player = this.players.get(sessionId);
    if (!player) return;
    this.clearTimers(player);
    player.parkedAt = -1;
    player.promptText = text;
    this.playFrom(player, 0);
  }

  /** Walk `mockTurn` from step `i` for `player`'s OWN session, sleeping each
   * step's delay, parking on gates. Every emitted message is restamped onto
   * `player.sessionId` — the P-1 isolation guarantee for the mock itself —
   * and the scripted `user` step is ALSO restamped onto `player.promptText`
   * (W3-T8 / L1 m8), so the replayed turn echoes what this session's own
   * user actually typed rather than `mockTurn`'s canned text. */
  private playFrom(player: SessionPlayer, i: number): void {
    if (i >= mockTurn.length) return;
    const step = mockTurn[i];
    if (step === undefined) return;
    this.at(player, step.delayMs, () => {
      this.emit(restamp(step.message, player.sessionId, player.promptText));
      if (step.gate) {
        player.parkedAt = i;
        return; // wait for the matching user response
      }
      this.playFrom(player, i + 1);
    });
  }

  /** Resume `sessionId`'s parked script iff it is genuinely parked on
   * `approvalId` — a mismatched or already-resolved session is a silent
   * no-op (never resumes a DIFFERENT tab's script; the independent-parking
   * guarantee B12 exists to exercise). */
  private resumeParked(sessionId: string, approvalId: string): void {
    const player = this.players.get(sessionId);
    if (!player || player.parkedAt < 0 || approvalId !== mockApprovalId) return;
    const resume = player.parkedAt + 1;
    player.parkedAt = -1;
    this.playFrom(player, resume);
  }

  private cancelTurn(sessionId: string): void {
    const player = this.players.get(sessionId);
    if (player) {
      this.clearTimers(player);
      player.parkedAt = -1;
    }
    this.emit({ type: 'turn.end', turnId: 'turn-1', sessionId, status: 'cancelled' });
  }

  /** W4 §2d/§7 B12: send + track nothing globally anymore (each message
   * already carries its OWN correct sessionId, restamped at the source). */
  private emit(message: HostToWebview): void {
    this.send(message);
  }

  /** Delay helper (per-player timer bookkeeping) that respects reduced-motion
   * by collapsing to near-instant. */
  private at(player: SessionPlayer, ms: number, fn: () => void): void {
    const delay = REDUCED_MOTION ? Math.min(ms, 30) : ms;
    player.timers.push(setTimeout(fn, delay));
  }

  private clearTimers(player: SessionPlayer): void {
    player.timers.forEach(clearTimeout);
    player.timers = [];
  }
}
