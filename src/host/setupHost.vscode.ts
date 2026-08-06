import * as vscode from 'vscode';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { access, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { ExecLookup } from './runtime/resolveHermes';
import { locatePipx } from './setup/pipxLocator';
import { installHermes, type SpawnFn, type FileExists } from './setup/pipxInstaller';
import { probeOllama, pullModel } from './setup/ollamaClient';
import { verifyHfDigest } from './setup/hfDigest';
import { ingestGguf, type GgufIngestIo, type GgufStoreIo, type TempWriteHandle, type TempReadStream } from './setup/ggufIngest';
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

// --- GgufIngestIo (T14 §4.4.3d: the real temp-file seams for ggufIngest.ts) --

/**
 * The `GgufIngestIo` binding — real `node:fs`/`node:os`/`node:crypto`-backed
 * temp file, `fetchImpl` = `boundFetch` (declared below, shared with every
 * other `SetupControllerDeps` network binding). `ggufIngest.ts` itself stays
 * disk/socket-free (T14's own module doc); every touch happens here.
 *
 * One temp file per {@link createTempWrite} call, named with a `randomUUID`
 * suffix under `os.tmpdir()` so concurrent installs (impossible today — the
 * controller's single-flight latch precedes this, `handleVettedIngest`)
 * could never collide even if that ever changed. `openTempRead` hands back
 * an `fs.ReadStream` directly: it already satisfies `AsyncIterable<Uint8Array>`
 * via Node's native `Readable` async iteration, matching the async-iterable
 * `BodyInit` shape undici documents (see `ggufIngest.ts`'s own doc comment
 * on {@link GgufIngestIo.openTempRead} for the citation) — no `stream/web`
 * conversion needed.
 *
 * T3 (beta.6 §2.4): the returned object ALSO satisfies {@link GgufStoreIo}
 * — the SAME bound object is handed to both `ingestGguf` and (once T7 wires
 * it into `SetupControllerDeps`) `downloadGgufToStore`, matching the
 * architecture doc's "io gains" phrasing verbatim. The four new members
 * write INSIDE the caller-given `destDir` (never `os.tmpdir()`) — `rename`
 * is same-directory, therefore atomic on POSIX; a cross-filesystem rename
 * (EXDEV) rejects exactly as `fs.rename` does, and `downloadGgufToStore`
 * itself refuses on any such rejection rather than falling back to a copy.
 */
function createNodeGgufIngestIo(): GgufIngestIo & GgufStoreIo {
  return {
    fetchImpl: boundFetch,
    createTempWrite: async (): Promise<TempWriteHandle> => {
      const path = joinPath(tmpdir(), `talaria-gguf-${randomUUID()}.tmp`);
      const stream = createWriteStream(path);
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
      });
      return {
        path,
        write: (chunk) =>
          new Promise<void>((resolve, reject) => {
            stream.write(chunk, (err) => (err ? reject(err) : resolve()));
          }),
        // Finding 1 (IMPORTANT, T14 review): `stream.end(callback)`'s
        // callback fires on the WEAKER 'finish' event ("all data has been
        // flushed to the underlying system" — Node stream docs), NOT
        // 'close' ("the stream and any of its underlying resources — a
        // file descriptor, for example — have been closed"). Resolving on
        // 'finish' alone raced ahead of the fd actually closing, so
        // `ingestGguf`'s `removeTemp` unlink could run before the fd was
        // released — on POSIX, an unlinked-but-still-open file's disk
        // blocks aren't reclaimed until the fd closes, i.e. leaking disk
        // space for the process lifetime on every cancel/error. `destroy()`
        // (not `end()`) is safe here and needs no graceful flush: every
        // `write()` above is individually awaited to its OWN fs-level
        // completion callback before the caller ever calls `close()`
        // (`ggufIngest.ts`'s `downloadToTemp` never has a write in flight
        // when it closes), so there is nothing buffered left to lose.
        // Idempotent: a stream already destroyed (e.g. a prior write error
        // auto-closed it, `autoClose` defaults true) resolves immediately
        // instead of waiting on a 'close' that already fired before this
        // listener attached.
        close: () =>
          stream.destroyed
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                stream.once('close', () => resolve());
                stream.destroy();
              }),
      };
    },
    // Never rejects: a temp file already gone (e.g. the write handle never
    // reached open, or a caller mistakenly double-removes) is exactly the
    // post-condition `removeTemp` promises — "the temp file is gone" — so
    // ENOENT (and any other unlink failure) is swallowed, matching
    // `ingestGguf`'s own single unconditional `finally`-cleanup call site.
    removeTemp: async (path: string): Promise<void> => {
      try {
        await unlink(path);
      } catch {
        // Already gone — nothing to clean up.
      }
    },
    // Finding 2 (MINOR, T14 review): `fs.ReadStream` already exposes a real
    // `destroy()` (inherited from `stream.Readable`) satisfying
    // `TempReadStream`'s optional `destroy` — `putBlob` calls it
    // unconditionally in a `finally` so this fd is released on every exit
    // from the blob-POST step too, not just when the body drains fully.
    openTempRead: async (path: string): Promise<TempReadStream> => createReadStream(path),

    // --- GgufStoreIo (T3, beta.6 §2.4/§2.2.8) --------------------------------

    ensureDir: async (dir: string): Promise<void> => {
      await mkdir(dir, { recursive: true });
    },
    // Same open/write/close discipline as `createTempWrite` above (T14
    // Finding 1's own comment applies verbatim: `destroy()` + wait for the
    // 'close' event, never `end()`'s weaker 'finish') — the ONLY difference
    // is the path: INSIDE `destDir` (a `.part` suffix, not `.tmp`), never
    // `os.tmpdir()`, so the later same-directory `rename` below is atomic.
    createStoreTempWrite: async (destDir: string): Promise<TempWriteHandle> => {
      const path = joinPath(destDir, `talaria-gguf-${randomUUID()}.part`);
      const stream = createWriteStream(path);
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
      });
      return {
        path,
        write: (chunk) =>
          new Promise<void>((resolve, reject) => {
            stream.write(chunk, (err) => (err ? reject(err) : resolve()));
          }),
        close: () =>
          stream.destroyed
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                stream.once('close', () => resolve());
                stream.destroy();
              }),
      };
    },
    // Same-directory `fs.rename` — atomic on POSIX. Rejects (EXDEV or
    // otherwise) exactly as `fs.rename` does; `downloadGgufToStore` itself
    // is the one that refuses-and-cleans-up rather than falling back to a
    // copy — this binding never catches or retries.
    renameTemp: (tempPath: string, destPath: string): Promise<void> => rename(tempPath, destPath),
    writeSidecar: (sidecarPath: string, content: string): Promise<void> => writeFile(sidecarPath, content, 'utf8'),
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
  const ggufIo = createNodeGgufIngestIo();
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
    // T13 (beta.5 §4.4.3c): the HF-tree digest pre-flight over real fetch.
    verifyHfDigest: (gguf) => verifyHfDigest(boundFetch, gguf),
    // T14 (beta.5 §4.4.3d): the digest-enforced ingest ENGINE
    // (`src/host/setup/ggufIngest.ts`) bound to the real temp-file/fetch
    // seams (`ggufIo`, above). With the registry's sha256 pin still empty
    // (§5.4) `handleVettedIngest` refuses at §4.4.3a before this is ever
    // reached in production — fail-closed either way.
    ingestGguf: (spec, endpoint, onProgress, signal) => ingestGguf(ggufIo, spec, endpoint, onProgress, signal),
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
