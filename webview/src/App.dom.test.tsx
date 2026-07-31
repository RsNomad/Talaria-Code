/**
 * DOM-level tests for App.tsx's error banners (Task 22, G-6).
 *
 * Scope discipline (docs/testing/dom-tests.md): these prove WIRING — that an
 * `aria-label` attribute actually reaches the rendered `<button>` and
 * computes into its accessible name — not decisions, which stay in pure
 * tests.
 *
 * `App` itself owns its error state via `useReducer` and is driven entirely
 * by host messages through the bridge; the standalone `MockBackend` has no
 * scripted path that ever produces a `systemError` or a `tab.error` (neither
 * message type appears in its scripted stream), so wiring the full `App` to
 * reach these two banners would mean either hand-rolling a second bridge mock
 * or reaching into `App`'s internals — both disproportionate for what is, at
 * bottom, a two-button attribute check. Per the task brief, the two banners
 * are extracted into `ErrorBanner` (also removing the duplication between the
 * two near-identical inline copies App.tsx carried before), and this file
 * renders that component directly with the same props App.tsx passes it.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBanner } from './components/ErrorBanner';
import { App } from './App';
import { bridge } from './bridge';
import { BOOTSTRAP_TAB_ID } from './types';
import { tabDomId, CHAT_TABPANEL_ID } from './components/TabStrip';

/** Mirrors App.tsx's `state.systemError` banner call site. */
function renderAppWithSystemError({ message }: { message: string }) {
  return render(
    <ErrorBanner message={message} dismissLabel="Dismiss this message" onDismiss={() => undefined} />,
  );
}

/** Mirrors App.tsx's `tab.error` banner call site for an `'open-failed'` tab
 * error (the case that also renders a Retry button alongside the dismiss
 * button, so this exercises both buttons at once). */
function renderAppWithTabError({ message, kind }: { message: string; kind: 'open-failed' | 'session-lost' }) {
  return render(
    <ErrorBanner
      message={message}
      dismissLabel="Dismiss this error"
      onDismiss={() => undefined}
      retry={kind === 'open-failed' ? { label: 'Retry', onClick: () => undefined } : undefined}
    />,
  );
}

describe('G-6: every icon-only control has an accessible name (WCAG 2.2 SC 4.1.2)', () => {
  it('the system-error dismiss button is reachable by name', () => {
    renderAppWithSystemError({ message: 'hermes acp exited (code 1)' });
    expect(screen.getByRole('button', { name: 'Dismiss this message' })).toBeInTheDocument();
  });

  it('the tab-error dismiss button is reachable by name', () => {
    renderAppWithTabError({ message: 'could not open the session', kind: 'open-failed' });
    expect(screen.getByRole('button', { name: 'Dismiss this error' })).toBeInTheDocument();
  });

  it('no button in the rendered tree is left without an accessible name', () => {
    renderAppWithTabError({ message: 'could not open the session', kind: 'open-failed' });
    const unnamed = screen
      .getAllByRole('button')
      .filter((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length === 0);
    expect(unnamed).toEqual([]);
  });
});

/**
 * Final-review Finding 2: the two describes above prove the ErrorBanner
 * component's own wiring, but never exercise a REAL `<App>` render — so
 * audit G-9's App-level affordance (the persistent, non-dismissible
 * "Reconnect" row at App.tsx, rendered only once `tab.error` is cleared but
 * `tab.openFailed` survives) had no DOM coverage against the actual
 * component tree App.tsx assembles.
 *
 * This header comment's own "MockBackend has no scripted `tab.error` path"
 * claim is still true, but it does not actually block a real `<App>` render:
 * `bridge.emit()` (bridge.ts) is not test-only scaffolding, it is the SAME
 * public method the real webview host's `window.addEventListener('message',
 * …)` listener calls, and the same one `attachMock`'s returned function
 * wraps — so calling it directly here delivers a `tab.error` exactly as the
 * extension host would, without inventing a second mock or reaching into
 * `App`'s internals. `App`'s message subscription (`bridge.onMessage`) is
 * installed and torn down per-render (App.tsx's `useEffect` cleanup, `return
 * off`), and `dom-setup.ts` runs RTL's `cleanup()` after every test, so the
 * module-singleton `bridge` does not leak a listener across tests.
 */
describe('G-9 at the App level: the Reconnect route back survives against a REAL <App> render', () => {
  /** Same idiom as `CheckpointsPanel.dom.test.tsx`/`SettingsPanel.dom.test.tsx`:
   *  the `userEvent` instance is created BEFORE render. */
  function setup(jsx: ReactElement) {
    return { user: userEvent.setup(), ...render(jsx) };
  }

  /** Delivers a `tab.error{kind:'open-failed'}` for the bootstrap tab exactly
   *  as the real host would — `bridge.emit` runs the listener synchronously,
   *  so the resulting `dispatch` must be wrapped in `act()`. */
  function emitOpenFailed() {
    act(() => {
      bridge.emit({
        type: 'tab.error',
        tabId: BOOTSTRAP_TAB_ID,
        message: 'could not open the session',
        kind: 'open-failed',
      });
    });
  }

  it('shows the persistent, named Reconnect row once the dismissible tab.error banner is dismissed', async () => {
    const { user } = setup(<App />);
    emitOpenFailed();

    // Before dismissal: App.tsx renders the standing route-back row only
    // when `!tab.error`, so only the dismissible banner is visible yet.
    expect(screen.getByRole('button', { name: 'Dismiss this error' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss this error' }));

    // After dismissal: `local.dismissError` clears `tab.error` but NOT
    // `tab.openFailed` (transcript.ts) — the route back must remain.
    expect(screen.queryByRole('button', { name: 'Dismiss this error' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('no button in the full rendered <App> tree is left without an accessible name in the openFailed-after-dismiss state', async () => {
    const { user } = setup(<App />);
    emitOpenFailed();
    await user.click(screen.getByRole('button', { name: 'Dismiss this error' }));

    // The two describes above (this file's original G-6 coverage) check only
    // `aria-label`/textContent, because ErrorBanner never relies on `title`.
    // The REAL App tree also includes Composer.tsx's model-picker and
    // edit-policy pill buttons, which — verified by running this sweep with
    // the narrower check first — DO name themselves via a bare `title`
    // attribute rather than `aria-label`, a real (if weaker-AT-support)
    // accessible-name source per the HTML accname algorithm. Checked here too
    // so the sweep reflects the actual tree instead of false-flagging them.
    const unnamed = screen
      .getAllByRole('button')
      .filter(
        (b) =>
          (b.getAttribute('aria-label') ?? b.getAttribute('title') ?? b.textContent ?? '').trim().length ===
          0,
      );
    expect(unnamed).toEqual([]);
  });
});

/**
 * ARCH-1 (final review, UI I-3): the session-lost G-9 sibling. A previously
 * (or never) bound tab whose session died must never eat sends silently — the
 * composer disables with an honest placeholder, and a standing "History" row
 * (same non-dismissible posture as G-9's Reconnect row) routes the user to
 * the real recovery surface instead of offering a retry that would just fail
 * again (there is no session left to retry into).
 */
describe('session-lost at the App level (ARCH-1, UI I-3): a dead session disables the composer and offers a route to History', () => {
  function setup(jsx: ReactElement) {
    return { user: userEvent.setup(), ...render(jsx) };
  }

  /** Delivers a `tab.error{kind:'session-lost'}` for the bootstrap tab exactly
   *  as the real host would — same idiom as `emitOpenFailed` above. */
  function emitSessionLost() {
    act(() => {
      bridge.emit({
        type: 'tab.error',
        tabId: BOOTSTRAP_TAB_ID,
        message: 'the session died when the agent restarted',
        kind: 'session-lost',
      });
    });
  }

  it('disables the composer with the session-lost placeholder (never the generic "Connecting…")', () => {
    setup(<App />);
    emitSessionLost();

    const textarea = screen.getByPlaceholderText(
      'Session lost — load it again from History or start a new chat',
    );
    expect(textarea).toBeDisabled();
    expect(screen.queryByPlaceholderText('Connecting…')).not.toBeInTheDocument();
  });

  it('shows the persistent, named History row that survives dismissing the per-tab error banner (G-9 parity)', async () => {
    const { user } = setup(<App />);
    emitSessionLost();

    // Before dismissal: the standing row is gated on `!tab.error`, so only
    // the dismissible banner is visible yet.
    expect(screen.getByRole('button', { name: 'Dismiss this error' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss this error' }));

    // `local.dismissError` clears `tab.error` but NOT `tab.sessionLost`
    // (transcript.ts) — the route back must remain, same as G-9's openFailed.
    expect(screen.queryByRole('button', { name: 'Dismiss this error' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
  });

  it('never offers a fake Retry for a lost session — no retry button in the error banner (unlike open-failed)', () => {
    setup(<App />);
    emitSessionLost();

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('clicking History routes away from the chat panel (no fake in-place retry)', async () => {
    const { user } = setup(<App />);
    emitSessionLost();
    await user.click(screen.getByRole('button', { name: 'Dismiss this error' }));

    await user.click(screen.getByRole('button', { name: 'History' }));

    // Composer only renders while `state.activePanel === 'chat'` (App.tsx) —
    // routing to History navigates away from it.
    expect(
      screen.queryByPlaceholderText('Session lost — load it again from History or start a new chat'),
    ).not.toBeInTheDocument();
  });
});

/**
 * B2 item 4 (path doc `af-architecture-path.md` §4 B2, "aria-controls trio",
 * fetched live for this task: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
 * — "Each element with role tabpanel has the property aria-labelledby
 * referring to its associated tab element"). TabStrip.dom.test.tsx proves the
 * TAB side (`aria-controls`); this proves the PANEL side — the ChatView
 * wrapper in App.tsx carries `role="tabpanel"` + a stable `id` + an
 * `aria-labelledby` that resolves to the DOM id of whichever tab is
 * currently active — against a REAL `<App>` render, the same idiom as the
 * G-9/session-lost describes above.
 *
 * CRITICAL coexistence check (path doc): the new `role="tabpanel"` sits on
 * the OUTER wrapper; B1's `role="log"` scroll container (ChatView.tsx) is a
 * SEPARATE INNER element nested inside it — never merged, never replaced.
 */
describe('B2 item 4: ChatView wrapper carries role=tabpanel + aria-labelledby (APG tabs)', () => {
  it('the chat tabpanel wrapper has role=tabpanel, a stable id, and aria-labelledby pointing at the active tab', () => {
    render(<App />);

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', CHAT_TABPANEL_ID);
    expect(panel).toHaveAttribute('aria-labelledby', tabDomId(BOOTSTRAP_TAB_ID));

    // The referenced tab must actually exist and point back at this same
    // panel. Scoped to TabStrip's own tablist ("Chat sessions") — PriorityTabs
    // (the side-panel strip) also uses role=tab for an unrelated tab set.
    const chatTabs = within(screen.getByRole('tablist', { name: 'Chat sessions' }));
    const activeTab = chatTabs.getByRole('tab');
    expect(activeTab.id).toBe(tabDomId(BOOTSTRAP_TAB_ID));
    expect(activeTab).toHaveAttribute('aria-controls', CHAT_TABPANEL_ID);
  });

  it("coexists with B1's role=log region as a separate, nested inner element once the transcript is non-empty", () => {
    render(<App />);

    // Bind the bootstrap tab to a session, then stream one message — without
    // this, ChatView's empty-transcript branch renders <Hero>, not the log.
    act(() => {
      bridge.emit({ type: 'tab.bound', tabId: BOOTSTRAP_TAB_ID, sessionId: 's1', rootId: 'root1' });
    });
    act(() => {
      bridge.emit({ type: 'message.delta', turnId: 't1', sessionId: 's1', text: 'hello' });
    });

    const panel = screen.getByRole('tabpanel');
    const log = screen.getByRole('log');
    expect(panel).not.toBe(log); // distinct elements — B1's log role is untouched, not merged
    expect(panel.contains(log)).toBe(true); // the log region is nested INSIDE the outer tabpanel
  });
});

/**
 * T-16 F9 (Tier-2 §12.1): the SIDE-PANEL sibling of the B2 describe above.
 * Every PriorityTabs tab (the "Panels" strip, distinct from TabStrip's "Chat
 * sessions" strip) now carries `aria-controls` pointing at its own panel's
 * `role="tabpanel"` wrapper — the same "aria-controls trio" idiom, just one
 * pairing per panel instead of one shared id (PriorityTabs switches between 9
 * DISTINCT panels, not one). The `chat` tab is the one exception: it reuses
 * the EXISTING ChatView wrapper's id (`CHAT_TABPANEL_ID`, proved by the B2
 * describe above) rather than a second wrapper — proved separately below so
 * this loop can stay uniform across all 9 panels.
 *
 * Also proves the WCAG/APG fix half of F9: no tab in the Panels tablist
 * carries `aria-current` any more — https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
 * (fetched live for this task) defines a tab's selected state as
 * `aria-selected`; `aria-current` is a DIFFERENT semantic (current item in a
 * navigation-style widget, e.g. a breadcrumb or nav menu) and was the wrong
 * attribute here.
 */
describe('T-16 F9: every PriorityTabs tab controls a real role=tabpanel, and none carries aria-current', () => {
  const PANELS: Array<{ label: string }> = [
    { label: 'Chat' },
    { label: 'Tools' },
    { label: 'MCP' },
    { label: 'Skills' },
    { label: 'Checkpoints' },
    { label: 'Subagents' },
    { label: 'History' },
    { label: 'Models' },
    { label: 'Settings' },
  ];

  it('no tab in the Panels tablist carries aria-current (aria-selected is the correct tab state)', () => {
    render(<App />);
    const panelsTablist = within(screen.getByRole('tablist', { name: 'Panels' }));
    const tabs = panelsTablist.getAllByRole('tab');
    expect(tabs.length).toBe(PANELS.length);
    for (const t of tabs) {
      expect(t).not.toHaveAttribute('aria-current');
    }
  });

  it.each(PANELS)('the "$label" tab\'s aria-controls resolves to an existing role=tabpanel element', async ({ label }) => {
    const user = userEvent.setup();
    render(<App />);

    const panelsTablist = within(screen.getByRole('tablist', { name: 'Panels' }));
    const tabBtn = panelsTablist.getByRole('tab', { name: label });
    await user.click(tabBtn);

    const controlsId = tabBtn.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const panelEl = controlsId === null ? null : document.getElementById(controlsId);
    expect(panelEl).not.toBeNull();
    expect(panelEl).toHaveAttribute('role', 'tabpanel');
  });

  it('the "Chat" tab\'s aria-controls is the SAME id as ChatView\'s existing tabpanel wrapper (no second wrapper mounted)', () => {
    render(<App />);
    const panelsTablist = within(screen.getByRole('tablist', { name: 'Panels' }));
    const chatTab = panelsTablist.getByRole('tab', { name: 'Chat' });
    expect(chatTab).toHaveAttribute('aria-controls', CHAT_TABPANEL_ID);
    // Exactly one role=tabpanel exists (the chat panel is active by default)
    // — proves no duplicate wrapper was mounted for the chat case.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });
});

/**
 * Audit-3 I-2 / remediation architecture §2.3 (Task A-3): the only prior
 * disclosure that the connection-global `backendKind` is `'mock'` was
 * TabStrip's hover-`title`-gated pill — unreachable to keyboard/touch
 * scanning and invisible to a tester mid-flow. `MockNotice` (new component)
 * is a persistent, non-dismissible, text-only strip mounted directly under
 * `TabStrip`, driven by the SAME `state.backendKind` the pill already reads
 * (folded from `hydrate` and the `backend.state` push — `transcript.ts`'s
 * `case 'backend.state': return { ...state, backendKind: msg.kind }`).
 * Fork F-2(A): no dismiss state, no buttons — so there is nothing to drive
 * here except `backendKind` itself.
 */
describe('A-3 (audit-3 I-2): persistent mock-mode disclosure strip', () => {
  const theme = { kind: 'dark' as const, accent: '#14b8a6' };

  /** Minimal valid `hydrate` seed (same required fields as
   *  `transcript.test.ts`'s hydrate payloads) with a caller-chosen
   *  `backendKind`. */
  function hydrateWith(backendKind: 'mock' | 'acp') {
    act(() => {
      bridge.emit({
        type: 'hydrate',
        state: {
          sessionId: null,
          theme,
          mode: 'default',
          preset: 'manual',
          currentModelId: null,
          activePanel: 'chat',
          backendKind,
        },
      });
    });
  }

  it('is visible (role=note, non-hover text) once hydrate confirms the live backend is mock', () => {
    render(<App />);
    hydrateWith('mock');

    const notice = screen.getByRole('note', { name: 'Demo mode notice' });
    expect(notice).toHaveTextContent(
      'Demo mode — responses are canned. Set talaria.backend to "acp" and trust this workspace to use the real agent.',
    );
  });

  it('disappears once a `backend.state` push reports the trust-upgrade swap to acp', () => {
    render(<App />);
    hydrateWith('mock');
    expect(screen.getByRole('note', { name: 'Demo mode notice' })).toBeInTheDocument();

    act(() => {
      bridge.emit({ type: 'backend.state', kind: 'acp' });
    });

    expect(screen.queryByRole('note', { name: 'Demo mode notice' })).not.toBeInTheDocument();
  });

  it('the pre-hydrate boot-default render also shows the notice (documented honest-boot decision, types.ts D2/A2) — no gating state added', () => {
    render(<App />);
    // No hydrate delivered yet: INITIAL_STATE.backendKind boots 'mock'.
    expect(screen.getByRole('note', { name: 'Demo mode notice' })).toBeInTheDocument();
  });
});

/**
 * W3-T6 (CF-11/D2): the composer's "New Session" button now rebinds ONLY
 * the current tab (`tab.newSession`) instead of restarting the whole
 * connection (`newSession`, which used to end every tab's live turn). This
 * proves the WIRING against a real `<App>` render — what actually gets
 * posted when the button is clicked — mirroring `bridge.test.ts`'s posture
 * that `bridge.post` is the one true channel to the host.
 */
describe('W3-T6 (CF-11/D2): the composer posts tab.newSession, never the old connection-global newSession', () => {
  function setup(jsx: ReactElement) {
    return { user: userEvent.setup(), ...render(jsx) };
  }

  it('clicking "New Session" posts {type:"tab.newSession", tabId, sessionId} for the active tab', async () => {
    const postSpy = vi.spyOn(bridge, 'post');
    const { user } = setup(<App />);
    // Bind the bootstrap tab first — App.tsx reads `tab.sessionId` off the
    // active tab's CURRENT binding, mirroring what a real host bind gives it.
    act(() => {
      bridge.emit({ type: 'tab.bound', tabId: BOOTSTRAP_TAB_ID, sessionId: 's1', rootId: 'root1' });
    });

    await user.click(screen.getByRole('button', { name: 'New Session' }));

    expect(postSpy).toHaveBeenCalledWith({ type: 'tab.newSession', tabId: BOOTSTRAP_TAB_ID, sessionId: 's1' });
    expect(postSpy).not.toHaveBeenCalledWith({ type: 'newSession' });
    postSpy.mockRestore();
  });

  it('clicking "New Session" before any bind still posts tab.newSession (never the legacy connection-global message)', async () => {
    const postSpy = vi.spyOn(bridge, 'post');
    const { user } = setup(<App />);

    await user.click(screen.getByRole('button', { name: 'New Session' }));

    const newSessionCalls = postSpy.mock.calls.filter(([msg]) => msg.type === 'newSession');
    expect(newSessionCalls).toEqual([]);
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tab.newSession', tabId: BOOTSTRAP_TAB_ID }),
    );
    postSpy.mockRestore();
  });
});

/**
 * CF-12 review fix (W3-T7, IMP-2): `checkpoint.restore` is wired through an
 * `App.tsx`-owned `restoreCheckpoint` callback that carries BOTH `rootId`
 * (params, multi-root routing) and `tab.tabId` (the `bridge.request` "tag"
 * arg, so `bridge.rejectTab` on tab close rejects an in-flight request
 * promptly instead of hanging until RPC timeout). The panel's redo/redo-all
 * originally fired `checkpoint.redo`/`checkpoint.redoAll` directly over a
 * dynamically-imported `bridge` with NEITHER — an in-flight redo on a
 * closing tab hung, and a multi-root workspace had no way to disambiguate
 * the target root. This proves redo now carries the SAME two things restore
 * does, against a REAL `<App>` render (same idiom as the W3-T6 describe
 * above): bind a tab to a root, navigate to the Checkpoints panel, push a
 * `data.redo`, click Redo/Redo all, and assert what `bridge.request` was
 * actually called with.
 */
describe('CF-12 review fix (W3-T7, IMP-2): checkpoint redo carries rootId + the tab tag, same as restore', () => {
  function setup(jsx: ReactElement) {
    return { user: userEvent.setup(), ...render(jsx) };
  }

  /** Binds the bootstrap tab to `rootId`, navigates to the Checkpoints
   *  panel, and pushes a `data.redo` for that root — the minimum sequence
   *  needed for the Redo/Redo all buttons to actually render. */
  async function openCheckpointsWithRedo(user: ReturnType<typeof userEvent.setup>, rootId: string) {
    act(() => {
      bridge.emit({ type: 'tab.bound', tabId: BOOTSTRAP_TAB_ID, sessionId: 's1', rootId });
    });

    const panelsTablist = within(screen.getByRole('tablist', { name: 'Panels' }));
    await user.click(panelsTablist.getByRole('tab', { name: 'Checkpoints' }));

    act(() => {
      bridge.emit({
        type: 'panel.data',
        panel: 'checkpoints',
        rootId,
        data: { checkpoints: [], redo: { anchorId: 'anchor-1', cursorId: 'cursor-1' } },
      });
    });
  }

  it('clicking Redo posts checkpoint.redo with {rootId} tagged to the active tab (mirrors restore)', async () => {
    const requestSpy = vi
      .spyOn(bridge, 'request')
      .mockResolvedValue({ restored: true, filesChanged: 0, changedPaths: [] });
    const { user } = setup(<App />);
    await openCheckpointsWithRedo(user, 'root-1');

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(requestSpy).toHaveBeenCalledWith('checkpoint.redo', { rootId: 'root-1' }, BOOTSTRAP_TAB_ID);
    requestSpy.mockRestore();
  });

  it('clicking Redo all posts checkpoint.redoAll with {rootId} tagged to the active tab (mirrors restore)', async () => {
    const requestSpy = vi
      .spyOn(bridge, 'request')
      .mockResolvedValue({ restored: true, filesChanged: 0, changedPaths: [] });
    const { user } = setup(<App />);
    await openCheckpointsWithRedo(user, 'root-2');

    await user.click(screen.getByRole('button', { name: 'Redo all' }));

    expect(requestSpy).toHaveBeenCalledWith('checkpoint.redoAll', { rootId: 'root-2' }, BOOTSTRAP_TAB_ID);
    requestSpy.mockRestore();
  });

  it('a force retry ("Redo anyway") posts {rootId, force: true}, still tagged to the active tab', async () => {
    // NOT `mockResolvedValueOnce` chaining: the FIRST `bridge.request` call in
    // this flow is the Checkpoints panel's own `panel.data` fetch (fired when
    // `openCheckpointsWithRedo` navigates to the tab), so a plain once-chain
    // would bind its result to that unrelated call instead of the first
    // `checkpoint.redo`. Branch on the method name instead, and assert
    // against the SECOND matching call.
    let redoCallCount = 0;
    const requestSpy = vi.spyOn(bridge, 'request').mockImplementation(async (method) => {
      if (method === 'checkpoint.redo') {
        redoCallCount += 1;
        return redoCallCount === 1
          ? { restored: false, reason: 'A turn is still running — wait for it to finish.' }
          : { restored: true, filesChanged: 0, changedPaths: [] };
      }
      return { restored: true, filesChanged: 0, changedPaths: [] };
    });
    const { user } = setup(<App />);
    await openCheckpointsWithRedo(user, 'root-3');

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    const retry = await screen.findByRole('button', { name: 'Redo anyway' });
    await user.click(retry);

    const redoCalls = requestSpy.mock.calls.filter(([method]) => method === 'checkpoint.redo');
    expect(redoCalls).toHaveLength(2);
    expect(redoCalls[1]).toEqual(['checkpoint.redo', { rootId: 'root-3', force: true }, BOOTSTRAP_TAB_ID]);
    requestSpy.mockRestore();
  });
});
