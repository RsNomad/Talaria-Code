import * as vscode from 'vscode';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import type { ExecLookup } from './runtime/resolveHermes';
import { locatePipx } from './setup/pipxLocator';
import { installHermes, type SpawnFn, type FileExists } from './setup/pipxInstaller';
import { probeOllama, pullModel } from './setup/ollamaClient';
import { probeRemote } from './setup/remoteProbe';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend } from './setup/registry';
import type { AdvertisedAuthMethod, SetupHost, SetupControllerDeps } from './setup/SetupController';
import { createVsCodeNextEditConfigPort } from '../autocomplete/nextedit/guard';

/**
 * The REAL `vscode`-backed {@link SetupHost} + the real, bound {@link
 * SetupControllerDeps} — Task 9's adapter layer (onboarding-backend-setup-
 * architecture.md §7/§8).
 *
 * Deliberately kept OUTSIDE `src/host/setup/`: `registry.test.ts` (h) scans
 * every non-test `.ts` file directly under that directory for a `vscode`
 * import and has no allowlist mechanism (T3 M-1 / T9 carry-forward). This
 * file lives in `src/host/` instead (a `*.vscode.ts` sibling of `src/host/
 * context/ports.vscode.ts`, `src/host/lib/libToolDeps.vscode.ts`, etc. — the
 * repo's established "vscode shell around a headless core" naming), so the
 * scan never looks at it while `SetupController.ts` itself stays pure.
 */

// --- SpawnFn (installHermes's subprocess seam) ------------------------------

/** Same 10s login-shell lookup timeout `resolveHermes.ts`/`pipxLocator.ts` use. */
function createExecLookup(): ExecLookup {
  return (command, args, opts) =>
    new Promise<string>((resolve, reject) => {
      execFile(command, args, { timeout: opts.timeoutMs, cwd: opts.cwd }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
}

/** Grace period after SIGTERM before escalating to SIGKILL on abort. */
const KILL_ESCALATION_MS = 5_000;

/**
 * T5 CR-Minor carry-forward: `installHermes` abandons `proc.exitCode` on an
 * abort (it never awaits it past `throwIfAborted` — see `pipxInstaller.ts`'s
 * own module doc). That is only safe because THIS adapter guarantees
 * `exitCode` always SETTLES (via `resolve`, never `reject`) no matter how the
 * child dies — an unawaited but still-pending-forever promise, or a rejected
 * one nobody catches, would each be a real leak/unhandled-rejection risk.
 *
 * Spawn hygiene (§7/§8, AUDIT-5 SEC M-2 precedent): absolute-path command +
 * args array, no shell (`nodeSpawn`'s default — never `{shell:true}`).
 */
export function createNodeSpawnFn(): SpawnFn {
  return (cmd, args, opts) => {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let settleExit: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => {
      settleExit = resolve;
    });

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_ESCALATION_MS);
    };
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      opts.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    child.once('exit', (code, signal) => {
      cleanup();
      // Settle even on a signal-kill (code === null) — never leave exitCode
      // dangling, and never reject it (the SpawnFn contract pins
      // `exitCode: Promise<number>`, no rejection case modeled).
      settleExit(code ?? (signal ? -1 : 0));
    });
    child.once('error', () => {
      cleanup();
      // A spawn-level error (e.g. ENOENT) still must SETTLE, not reject —
      // surfaced as a clearly-non-zero code so `exitCode !== 0` checks fire.
      settleExit(-1);
    });

    return {
      stdout: lineIterable(child.stdout),
      stderr: lineIterable(child.stderr),
      exitCode,
    };
  };
}

/** Splits a Node readable byte stream into UTF-8 lines (CRLF-tolerant),
 *  yielding a trailing unterminated line at stream end (mirrors `ollamaClient
 *  .ts`'s own NDJSON buffering discipline one module over). */
async function* lineIterable(stream: NodeJS.ReadableStream | null): AsyncGenerator<string> {
  if (!stream) return;
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, '');
}

// --- FileExists --------------------------------------------------------------

export function createNodeFileExists(): FileExists {
  return async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
}

// --- readOsRelease (T5 §1.2 — the container-boundary-aware os-release read) --

/**
 * Injected seams for {@link createReadOsRelease} — real fs/process by
 * default; tests inject fakes (the same DI discipline as `SpawnFn`/
 * `FileExists` above, so the unit tests never touch the real filesystem).
 */
export interface OsReleaseReadSeams {
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
}

const CONTAINER_MARKER_FILES = ['/run/.containerenv', '/.dockerenv'];

/**
 * The `SetupControllerDeps.readOsRelease` binding (beta.5 §1.2, S-F10
 * container/Flatpak honesty):
 *
 *  1. win32 → `{}` (dev-gate host; the controller degrades to `unknown`).
 *  2. `/run/host/os-release` readable → its text — Flatpak/toolbox expose
 *     the HOST identity there, which is what install commands should be
 *     composed for. Preferred unconditionally over `/etc/os-release`.
 *  3. Else, a container marker present (`/run/.containerenv` (podman),
 *     `/.dockerenv` (docker), or a non-empty `$container` (Flatpak/systemd-
 *     nspawn)) → `{ containerMismatch: true }` — the sandbox's own
 *     `/etc/os-release` is deliberately NOT read: reporting the container
 *     image's identity would compose commands for a system the user's
 *     terminal may not act on. Fail-closed, the controller degrades to
 *     `unknown` + the §6 container note.
 *  4. Else `/etc/os-release` → its text; unreadable → `{}`.
 *
 * Never rejects: every fs failure collapses into the honest-degrade shapes
 * above (the controller additionally try/catches its side of the seam).
 */
export function createReadOsRelease(
  seams?: Partial<OsReleaseReadSeams>,
): () => Promise<{ text?: string; containerMismatch?: boolean }> {
  const readFileImpl = seams?.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const fileExistsImpl = seams?.fileExists ?? createNodeFileExists();
  const platform = seams?.platform ?? process.platform;
  const env = seams?.env ?? process.env;
  return async () => {
    if (platform === 'win32') return {};
    try {
      return { text: await readFileImpl('/run/host/os-release') };
    } catch {
      // Host file absent/unreadable — fall through to marker detection.
    }
    for (const marker of CONTAINER_MARKER_FILES) {
      if (await fileExistsImpl(marker)) return { containerMismatch: true };
    }
    const containerEnv = env['container'];
    if (containerEnv !== undefined && containerEnv !== '') return { containerMismatch: true };
    try {
      return { text: await readFileImpl('/etc/os-release') };
    } catch {
      return {};
    }
  };
}

// --- SetupControllerDeps (Task 3-7 engines, bound to real adapters) ----------

/** `fetch` reached via `globalThis.fetch(...)` (never a bare reference) —
 *  same indirection `HermesDashboardClient.ts`'s default `fetchImpl` uses. */
const boundFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * @param getAdvertisedAuthMethods Task 13: the Provider-card seam — REQUIRED
 * (not defaulted) so the wiring can never be silently forgotten.
 * `extension.ts` passes a thunk over the CURRENT backend
 * (`() => backend.getAdvertisedAuthMethods?.()`), read at every
 * `SetupController.status()` call — never a construction-time snapshot, so
 * the trust-upgrade mock→real swap and every `talaria.newSession`
 * re-initialize are picked up automatically.
 */
export function createSetupControllerDeps(
  getAdvertisedAuthMethods: () => AdvertisedAuthMethod[] | undefined,
): SetupControllerDeps {
  const exec = createExecLookup();
  const spawn = createNodeSpawnFn();
  const fileExists = createNodeFileExists();
  return {
    // T11 (§3, critic C-11): thread the caller's abort signal through so
    // `handleInstall`'s Cancel can actually reach a wedged login-shell probe
    // — without this, the signal SetupController passes would be silently
    // dropped at this wiring seam despite the plumbing being correct on
    // both sides of it.
    locatePipx: (signal) => locatePipx(exec, signal),
    // T5 §1.2: the container-boundary-aware os-release read (real fs seams).
    readOsRelease: createReadOsRelease(),
    installHermes: (recipe, env, onEvent, signal) => installHermes(recipe, env, spawn, fileExists, onEvent, signal),
    probeOllama: (endpoint, timeoutMs) => probeOllama(endpoint, boundFetch, timeoutMs),
    pullModel: (endpoint, model, onProgress, signal) => pullModel(endpoint, model, boundFetch, onProgress, signal),
    probeRemote: (spec, endpoint, apiKey) => probeRemote(spec, endpoint, apiKey, boundFetch),
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    // R5 (coexistence.lock.test.ts): reads through the Guard's OWN exported
    // port instead of naming the `talaria.nextEdit.source` key here — that
    // key literal is locked to guard.ts alone, so nothing can read/write it
    // around the Guard. `createVsCodeNextEditConfigPort()` is a stateless
    // factory (matches its own doc); constructing one per call is cheap.
    getNextEditSource: () => createVsCodeNextEditConfigPort().get(),
    getAdvertisedAuthMethods,
  };
}

// --- SetupHost (the vscode seam) ---------------------------------------------

/** Splits `'talaria.autocomplete.endpoint'` into `getConfiguration` section
 *  (`'talaria.autocomplete'`) + leaf key (`'endpoint'`) — the same section/key
 *  split `guard.ts`'s `NEXT_EDIT_SOURCE_SETTING` derivation uses one module
 *  over, generalized to any dotted `talaria.*` key. */
function splitSettingKey(key: string): { section: string; prop: string } {
  const idx = key.lastIndexOf('.');
  return { section: key.slice(0, idx), prop: key.slice(idx + 1) };
}

export function createVsCodeSetupHost(context: vscode.ExtensionContext): SetupHost {
  return {
    showModal: async (message, confirmLabel) => {
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
      return choice === confirmLabel;
    },
    showPasswordInput: async (prompt) =>
      vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true }),
    createTerminal: (name, preTypedCommand) => {
      const terminal = vscode.window.createTerminal(name);
      terminal.show();
      // Pre-typed only — the second arg (`addNewLine: false`) means the
      // command is NOT executed; the user must press Enter themselves
      // (§7/§8: sudo-gated installer commands are never run by us).
      terminal.sendText(preTypedCommand, false);
    },
    runInTerminal: (name, shellPath, shellArgs) => {
      const terminal = vscode.window.createTerminal(name, shellPath, shellArgs);
      terminal.show();
    },
    getSetting: <T,>(key: string): T | undefined => {
      const { section, prop } = splitSettingKey(key);
      return vscode.workspace.getConfiguration(section).get<T>(prop);
    },
    updateSettingGlobal: async (key, value) => {
      const { section, prop } = splitSettingKey(key);
      await vscode.workspace.getConfiguration(section).update(prop, value, vscode.ConfigurationTarget.Global);
    },
    secrets: {
      store: (key, v) => Promise.resolve(context.secrets.store(key, v)),
      // Final review wave, pre-merge defensive fix: `has()`'s contract
      // (`SetupHost.secrets.has`, `SetupController.ts`) is `Promise<boolean>`
      // — it must NEVER reject. `context.secrets.get` can reject on a
      // keychain-less host (e.g. a headless Linux CI runner with no OS
      // keyring), and `status()` awaits this unguarded — see
      // `setupHost.vscode.test.ts` for the covering test.
      has: async (key) => {
        try {
          return (await context.secrets.get(key)) !== undefined;
        } catch {
          return false;
        }
      },
      delete: (key) => Promise.resolve(context.secrets.delete(key)),
    },
    globalState: {
      get: <T,>(key: string) => context.globalState.get<T>(key),
      update: (key, v) => Promise.resolve(context.globalState.update(key, v)),
    },
    isTrusted: () => vscode.workspace.isTrusted,
    // Task 11 (`setup.reload`): fired directly from a persistent webview
    // button the user already clicked deliberately — no second native
    // confirmation (contrast `offerReload` below, which prompts because
    // nothing the user did was itself a reload request).
    reload: () => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    offerReload: () => {
      void vscode.window
        .showInformationMessage(
          'Talaria: Hermes installed — reload the window to activate it.',
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    },
  };
}
