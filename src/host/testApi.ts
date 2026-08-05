import type { PanelFetchCause, WebviewSignal } from './TalariaViewProvider';

/**
 * src/host/testApi.ts (Task 5, onboarding-entrypoint-fix-architecture.md
 * §4.2/§4.3): a small, history-buffered async API layered over
 * `TalariaViewProvider.onWebviewSignal`, exported by `activate()` ONLY under
 * `ExtensionMode.Test` (see `extension.ts`) so a Task-6 `@vscode/test-electron`
 * integration smoke can `await` "the webview announced ready" and "panel X
 * was fetched for cause Y", attributed and counted — without any API into
 * the webview's React state (there isn't one).
 *
 * PURE module: the event source is injected (`onSignal`), never imports
 * `vscode` itself, so it is fully unit-testable with a hand-rolled emitter
 * (`testApi.test.ts`) — the same "pure module, event source injected" seam
 * the architecture doc calls out.
 *
 * History-buffered: `ready`/fetch state is recorded from the moment
 * `createTestApi` subscribes (activation time in real use), so a waiter that
 * calls `whenWebviewReady`/`waitForPanelFetch` AFTER the signal already
 * fired still resolves immediately — no lost-wakeup race between a fast
 * cold boot and the smoke's own `await`.
 *
 * beta.5 T16 (§5.5, S-F15): `getSetupData()` is a second, independent
 * injected seam (`getStatus`) reaching `SetupController.status()` ONLY —
 * NEVER `.handle()` (this surface must never let a test mutate host state).
 * The returned snapshot is untyped (`Promise<unknown>`) on purpose — this
 * module stays free of `SetupData`/`SetupController` imports, and callers
 * must NEVER log or assert on the snapshot wholesale: it can carry
 * user-typed endpoint URLs with embedded userinfo. Extract only the
 * specific fields you need (see `test/integration/openSetup.test.ts`).
 */

/** Default timeout for every wait below — generous enough to cover a real
 *  VS Code extension-host cold boot + webview bundle load under CI. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface PanelFetchResult {
  readonly ok: boolean;
  readonly hasData: boolean;
}

export interface TalariaTestApi {
  whenWebviewReady(timeoutMs?: number): Promise<void>;
  panelFetchCount(panel: string, cause?: PanelFetchCause): number;
  waitForPanelFetch(
    panel: string,
    opts?: { minCount?: number; cause?: PanelFetchCause; timeoutMs?: number },
  ): Promise<PanelFetchResult>;
  /**
   * beta.5 T16 (§5.5, S-F15): the live `SetupController.status()` snapshot —
   * NEVER `.handle()`. Untyped on purpose (see module doc). Callers must
   * extract only the specific fields they assert on and must never log or
   * assert the whole object — it can carry user-typed endpoint URLs with
   * embedded userinfo.
   */
  getSetupData(): Promise<unknown>;
}

/** One recorded `panelFetch` signal, flattened for easy filter/count. */
interface PanelFetchEvent {
  readonly panel: string;
  readonly cause: PanelFetchCause;
  readonly ok: boolean;
  readonly hasData: boolean;
}

interface ReadyWaiter {
  readonly kind: 'ready';
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PanelFetchWaiter {
  readonly kind: 'panelFetch';
  readonly panel: string;
  readonly cause: PanelFetchCause | undefined;
  readonly minCount: number;
  readonly resolve: (result: PanelFetchResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type Waiter = ReadyWaiter | PanelFetchWaiter;

/**
 * Builds the {@link TalariaTestApi} plus its own `dispose()`. `onSignal` is
 * shaped exactly like `vscode.Event<WebviewSignal>` (a function taking a
 * listener and returning a `{dispose(): void}` subscription), so
 * `provider.onWebviewSignal` can be passed directly — see `extension.ts`'s
 * `createTestApi(provider.onWebviewSignal, () => setupController.status())`
 * call.
 *
 * `getStatus` (beta.5 T16) is a second, independent injected seam for
 * {@link TalariaTestApi.getSetupData} — optional so existing callers/tests
 * that only exercise the ready/panelFetch surface (this module's own
 * `testApi.test.ts`) need no change; `getSetupData()` throws a diagnosable
 * error if invoked without it wired.
 */
export function createTestApi(
  onSignal: (listener: (signal: WebviewSignal) => void) => { dispose(): void },
  getStatus?: () => Promise<unknown>,
): { api: TalariaTestApi; dispose(): void } {
  let ready = false;
  const fetchEvents: PanelFetchEvent[] = [];
  const waiters = new Set<Waiter>();

  const matchingFetches = (panel: string, cause: PanelFetchCause | undefined): PanelFetchEvent[] =>
    fetchEvents.filter((event) => event.panel === panel && (cause === undefined || event.cause === cause));

  /** Re-checks one waiter against current state; removes + settles it (via
   *  its own `resolve`) if satisfied. Returns whether it settled. */
  const trySettle = (waiter: Waiter): boolean => {
    if (waiter.kind === 'ready') {
      if (!ready) return false;
      clearTimeout(waiter.timer);
      waiter.resolve();
      return true;
    }
    const matches = matchingFetches(waiter.panel, waiter.cause);
    if (matches.length < waiter.minCount) return false;
    const match = matches[waiter.minCount - 1];
    if (match === undefined) {
      // Invariant: matches.length >= waiter.minCount (>= 1) was just
      // checked above, so index minCount-1 is in bounds. Defensive throw
      // (never a non-null assertion) in case that invariant is ever broken
      // by a future edit.
      throw new Error('TalariaTestApi: internal invariant violated — indexed fetch match was undefined.');
    }
    clearTimeout(waiter.timer);
    waiter.resolve({ ok: match.ok, hasData: match.hasData });
    return true;
  };

  const settleAll = (): void => {
    for (const waiter of [...waiters]) {
      if (trySettle(waiter)) waiters.delete(waiter);
    }
  };

  const listener = (signal: WebviewSignal): void => {
    if (signal.kind === 'ready') {
      ready = true;
    } else {
      fetchEvents.push({ panel: signal.panel, cause: signal.cause, ok: signal.ok, hasData: signal.hasData });
    }
    settleAll();
  };

  const subscription = onSignal(listener);

  const api: TalariaTestApi = {
    whenWebviewReady(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
      if (ready) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter: ReadyWaiter = {
          kind: 'ready',
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `TalariaTestApi.whenWebviewReady: timed out waiting for the webview 'ready' signal within ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },

    panelFetchCount(panel: string, cause?: PanelFetchCause): number {
      return matchingFetches(panel, cause).length;
    },

    waitForPanelFetch(
      panel: string,
      opts: { minCount?: number; cause?: PanelFetchCause; timeoutMs?: number } = {},
    ): Promise<PanelFetchResult> {
      const minCount = opts.minCount ?? 1;
      const { cause } = opts;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const alreadyMatched = matchingFetches(panel, cause);
      if (alreadyMatched.length >= minCount) {
        const match = alreadyMatched[minCount - 1];
        if (match === undefined) {
          throw new Error('TalariaTestApi: internal invariant violated — indexed fetch match was undefined.');
        }
        return Promise.resolve({ ok: match.ok, hasData: match.hasData });
      }

      return new Promise<PanelFetchResult>((resolve, reject) => {
        const causeSuffix = cause === undefined ? '' : ` (cause "${cause}")`;
        const waiter: PanelFetchWaiter = {
          kind: 'panelFetch',
          panel,
          cause,
          minCount,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `TalariaTestApi.waitForPanelFetch: timed out waiting for panel "${panel}"${causeSuffix} to reach ${minCount} fetch(es) within ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },

    getSetupData(): Promise<unknown> {
      if (!getStatus) {
        throw new Error(
          'TalariaTestApi.getSetupData: createTestApi was not given a getStatus() seam — wire ' +
            "SetupController.status() through createTestApi's second argument.",
        );
      }
      return getStatus();
    },
  };

  return {
    api,
    dispose(): void {
      for (const waiter of waiters) clearTimeout(waiter.timer);
      waiters.clear();
      subscription.dispose();
    },
  };
}
