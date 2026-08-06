import { assertCatalogSource } from './modelCatalog';
import type { CatalogModel } from './modelCatalog';
import type { GgufStoreSidecar } from './ggufIngest';

/**
 * modelStore — the beta.6 unified "Local Model" component's store-layout +
 * presence-scanner module (beta6-unified-local-model-onboarding-architecture.md
 * §2.2.8 / §2.4 line 307). PURE, `vscode`-free, injected fs seam — mirrors
 * `ggufIngest.ts`'s `GgufIngestIo`/`GgufStoreIo` DI pattern (`:86`) so this
 * module's own suite never touches disk. The REAL bindings (node
 * `fs.promises.lstat`/`stat`/`readFile`, `process.env`) live in
 * `setupHost.vscode.ts`, same split as `ggufIngest.ts`.
 *
 * This module decides WHERE a verified model file lives (`storeRoot`,
 * `ggufDest`) and whether one is PRESENT (`scanPresence`) — it never
 * downloads, hashes, or writes anything itself. `ggufIngest.ts`'s
 * `downloadGgufToStore` is the writer; this module is purely the reader/
 * layout side of that same store.
 *
 * --- storeRoot (SC-A-10) ------------------------------------------------
 * Linux XDG precedence: `$XDG_DATA_HOME` (when set, non-empty) else
 * `$HOME/.local/share` (when set, non-empty), then the Talaria model
 * subdirectory (`talaria/models` — this module's own naming choice; the
 * architecture doc pins the FAIL-CLOSED rule, not a literal path string).
 * An unset OR EMPTY-STRING var is treated as "not set" (mirrors this
 * codebase's own `container` env-marker convention, `setupHost.vscode.ts`'s
 * `createReadOsRelease`). Neither var set -> a TYPED failure (`{ok:false,
 * reason}`) — NEVER a bare/relative path, and NEVER the hardcoded
 * `/.local/share/…` fallback SC-A-10 explicitly forbids.
 *
 * --- ggufDest (A-4) -------------------------------------------------------
 * Two-level layout `<root>/<owner>/<repo>/<file>` — owner and repo as
 * SEPARATE directories, never flattened into one `owner__repo` segment, so
 * `a/b__c` and `a__b/c` can never collide on disk (the `__`-flattening
 * collision A-4 closes). `assertCatalogSource` (the SC-1 charset boundary,
 * `modelCatalog.ts`) is re-run HERE on `hfRepo`+`file` before composing ANY
 * path — a second, independent gate at the placement-layout layer, exactly
 * the SC-A-8-style defense-in-depth `ggufIngest.ts`'s own
 * `assertDigestShape` establishes one call up. `file` containing `/` or
 * `..` is rejected by that same assert (the T3<->T4 boundary item #2 this
 * layer owns).
 *
 * --- lstatCheckedGgufDest (SC-A-3) -----------------------------------------
 * `ggufIngest.ts`'s `downloadGgufToStore` calls `io.ensureDir(destDir)`
 * (`fs.mkdir(dir, {recursive:true})`) which will happily traverse a
 * SYMLINKED store root or `<owner>`/`<repo>` level. This function is the
 * validated-dest gate callers (the controller, T6) MUST run BEFORE ever
 * invoking `downloadGgufToStore` — it `lstat`s (never `stat`, which would
 * FOLLOW the very link being checked) the store root and each `<owner>`/
 * `<repo>` level; any level that EXISTS and IS a symlink refuses. A level
 * that does not exist yet is not a refusal (mkdir -p will legitimately
 * create it).
 *
 * --- scanPresence / readSidecar (§2.2.8 sidecar rule) ----------------------
 * NO hashing on scan — the hash was proven once, at write time
 * (`downloadGgufToStore`'s digest-verified download); the sidecar
 * (`<file>.talaria.json` = {@link GgufStoreSidecar}, T4 imports the type
 * from `ggufIngest.ts` rather than redeclaring it, so writer and reader can
 * never drift apart) attests to it. Presence = sidecar exists AND parses
 * AND is well-formed (`GgufStoreSidecar` shape) AND the on-disk file's byte
 * size === `sidecar.bytes`. A right-sized FOREIGN file with no sidecar is
 * `absent`; a `.part` temp file (T3's `createStoreTempWrite` naming) is
 * never the scanned filename, so it is `absent` by construction — no
 * special-case code needed. The honest copy this scan feeds is "present in
 * Talaria's model folder", never "verified" (§4 line 421) — this module
 * never claims more than the sidecar rule proves.
 */

// ---------------------------------------------------------------------------
// storeRoot
// ---------------------------------------------------------------------------

const STORE_SUBDIR_SEGMENTS = ['talaria', 'models'] as const;

export type StoreRootResult = { ok: true; root: string } | { ok: false; reason: string };

/** `Readonly<Record<string,string|undefined>>` — the same seam shape
 *  `setupHost.vscode.ts`'s `OsReleaseReadSeams.env` already uses for
 *  `process.env` (structurally compatible with `NodeJS.ProcessEnv` without
 *  importing the ambient Node type here). */
export type ModelStoreEnv = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function storeRoot(env: ModelStoreEnv): StoreRootResult {
  const xdgDataHome = nonEmpty(env.XDG_DATA_HOME);
  if (xdgDataHome !== undefined) {
    return { ok: true, root: joinPosix(xdgDataHome, ...STORE_SUBDIR_SEGMENTS) };
  }
  const home = nonEmpty(env.HOME);
  if (home !== undefined) {
    return { ok: true, root: joinPosix(home, '.local', 'share', ...STORE_SUBDIR_SEGMENTS) };
  }
  return {
    ok: false,
    reason: 'no $XDG_DATA_HOME and no $HOME set — refusing to resolve a model store root',
  };
}

// ---------------------------------------------------------------------------
// ggufDest
// ---------------------------------------------------------------------------

export type GgufDestResult =
  | { ok: true; destDir: string; destFile: string; destPath: string }
  | { ok: false; reason: string };

export function ggufDest(root: string, hfRepo: string, file: string): GgufDestResult {
  const assertion = assertCatalogSource({ hfRepo, file });
  if (!assertion.ok) {
    return { ok: false, reason: assertion.reason };
  }
  // assertCatalogSource already proved hfRepo is exactly "owner/repo" — the
  // `?? ''` fallbacks below are pure noUncheckedIndexedAccess bureaucracy,
  // never actually hit (same pattern `modelCatalog.ts`'s own
  // `checkOwnerRepo` uses).
  const segments = hfRepo.split('/');
  const owner = segments[0] ?? '';
  const repo = segments[1] ?? '';
  const destDir = joinPosix(root, owner, repo);
  const destPath = joinPosix(destDir, file);
  return { ok: true, destDir, destFile: file, destPath };
}

// ---------------------------------------------------------------------------
// lstatCheckedGgufDest (SC-A-3)
// ---------------------------------------------------------------------------

/** The lstat seam — `setupHost.vscode.ts` binds this to `fs.promises.lstat`
 *  with ENOENT swallowed to `null` (any OTHER rejection propagates
 *  unchanged, fail-closed by default promise rejection). Deliberately typed
 *  to the minimal shape this module needs (`isSymbolicLink()`) rather than
 *  importing Node's `fs.Stats` — keeps this module's own surface small and
 *  trivially fakeable in tests. */
export interface ModelStoreLstatIo {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean } | null>;
}

async function refuseIfSymlink(
  io: ModelStoreLstatIo,
  path: string,
  label: string,
): Promise<GgufDestResult | undefined> {
  const stat = await io.lstat(path);
  if (stat !== null && stat.isSymbolicLink()) {
    return { ok: false, reason: `${label} ("${path}") is a symlink — refusing` };
  }
  return undefined;
}

/**
 * The validated-dest gate the controller (T6) MUST call before ever
 * invoking `downloadGgufToStore` — see this module's own top doc comment
 * ("lstatCheckedGgufDest (SC-A-3)") for the full rationale. Composes via
 * {@link ggufDest} first (charset-refuses BEFORE any `lstat` call — proven
 * by a dedicated test), then `lstat`-checks the store root, the `<owner>`
 * level, and the `<repo>` level, in that order, short-circuiting on the
 * first symlink found.
 */
export async function lstatCheckedGgufDest(
  io: ModelStoreLstatIo,
  root: string,
  hfRepo: string,
  file: string,
): Promise<GgufDestResult> {
  const dest = ggufDest(root, hfRepo, file);
  if (!dest.ok) return dest;

  const rootRefusal = await refuseIfSymlink(io, root, 'store root');
  if (rootRefusal) return rootRefusal;

  const ownerDir = dirnameOfPosix(dest.destDir);
  const ownerRefusal = await refuseIfSymlink(io, ownerDir, '<owner> directory');
  if (ownerRefusal) return ownerRefusal;

  const repoRefusal = await refuseIfSymlink(io, dest.destDir, '<repo> directory');
  if (repoRefusal) return repoRefusal;

  return dest;
}

// ---------------------------------------------------------------------------
// scanPresence / readSidecar (§2.2.8 sidecar rule)
// ---------------------------------------------------------------------------

/** The presence-scan seam — `setupHost.vscode.ts` binds `readFile` to
 *  `fs.promises.readFile(path, 'utf8')` and `statSize` to
 *  `fs.promises.stat(path).then(s => s.size)`, both with ENOENT (and any
 *  other "doesn't exist" condition) swallowed to `null` — any OTHER
 *  rejection propagates unchanged. `env` is bundled onto the same seam
 *  object (the established pattern in this codebase — see
 *  `setupHost.vscode.ts`'s `OsReleaseReadSeams.env`) so `scanPresence`'s own
 *  signature stays the two-argument `(io, catalog)` shape the architecture
 *  doc names (§2.4 line 307). */
export interface ModelStorePresenceIo {
  env: ModelStoreEnv;
  /** `null` = the path does not exist. Never used to hash — only to read
   *  the sidecar's JSON text. */
  readFile(path: string): Promise<string | null>;
  /** `null` = the path does not exist. The on-disk byte SIZE only — no
   *  bytes are ever read or hashed on scan (§2.2.8: "the hash was proven at
   *  write; the sidecar attests it"). */
  statSize(path: string): Promise<number | null>;
}

/**
 * Parse + shape-validate a sidecar's raw JSON text. Fail-closed: invalid
 * JSON or a well-formed-JSON-but-wrong-shape value both return `null`
 * (never throws out to the caller) — `scanPresence` treats a `null` result
 * exactly like a missing sidecar (`absent`).
 */
export function readSidecar(raw: string): GgufStoreSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isWellFormedSidecar(parsed) ? parsed : null;
}

function isWellFormedSidecar(value: unknown): value is GgufStoreSidecar {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.catalogId === 'string' &&
    typeof v.sha256 === 'string' &&
    typeof v.bytes === 'number' &&
    Number.isFinite(v.bytes) &&
    v.bytes >= 0 &&
    typeof v.verifiedAt === 'string'
  );
}

/**
 * The §2.2.8 sidecar presence truth table, for every catalog row that HAS a
 * llama.cpp gguf offering (rows without one are excluded from the returned
 * map entirely — there is nothing for this scan to say about them). NO
 * hashing on scan, ever: `ModelStorePresenceIo` has no digest/hash seam to
 * even reach for.
 *
 * When `storeRoot(io.env)` itself refuses (no `$XDG_DATA_HOME`, no `$HOME`)
 * every eligible row is marked `absent` WITHOUT any `readFile`/`statSize`
 * call — fail-closed: there is nowhere to look, so honestly nothing can be
 * present there.
 */
export async function scanPresence(
  io: ModelStorePresenceIo,
  catalog: readonly CatalogModel[],
): Promise<ReadonlyMap<string, boolean>> {
  const result = new Map<string, boolean>();
  const rootResult = storeRoot(io.env);
  for (const model of catalog) {
    const gguf = model.llamacpp?.gguf;
    if (!gguf) continue;
    if (!rootResult.ok) {
      result.set(model.id, false);
      continue;
    }
    result.set(model.id, await scanOnePresence(io, rootResult.root, gguf));
  }
  return result;
}

async function scanOnePresence(
  io: ModelStorePresenceIo,
  root: string,
  gguf: { hfRepo: string; file: string },
): Promise<boolean> {
  const dest = ggufDest(root, gguf.hfRepo, gguf.file);
  if (!dest.ok) return false;

  const sidecarRaw = await io.readFile(`${dest.destPath}.talaria.json`);
  if (sidecarRaw === null) return false;

  const sidecar = readSidecar(sidecarRaw);
  if (sidecar === null) return false;

  const size = await io.statSize(dest.destPath);
  if (size === null) return false;

  return size === sidecar.bytes;
}

// ---------------------------------------------------------------------------
// POSIX path internals (Fedora/Linux target — deliberately no `node:path`
// import, mirroring `ggufIngest.ts`'s own no-ambient-fs/os discipline: every
// path here is a plain string, never resolved against the real filesystem).
// ---------------------------------------------------------------------------

function joinPosix(base: string, ...rest: string[]): string {
  let result = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
  for (const part of rest) {
    const trimmed = part.replace(/^\/+/, '').replace(/\/+$/, '');
    if (trimmed.length === 0) continue;
    result = result.endsWith('/') ? `${result}${trimmed}` : `${result}/${trimmed}`;
  }
  return result;
}

/** Mirrors `ggufIngest.ts`'s own local `dirnameOf` exactly (unexported
 *  internals one module over — that module's own established
 *  self-contained-module discipline, not imported). */
function dirnameOfPosix(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}
