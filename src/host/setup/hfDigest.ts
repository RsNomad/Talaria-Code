/**
 * hfDigest — the HF-tree integrity pre-flight for verified downloads
 * (beta5-setup-hardening-architecture.md §4.4.3c, facts §0.3; generalized
 * for the allowlist tier by beta6-unified-local-model-onboarding-architecture.md
 * §2.2.5/§2.4, T2).
 *
 * PURE — no `vscode` (the directory purity scan applies), no ambient fetch:
 * the caller injects `fetchImpl` (`setupHost.vscode.ts` binds the real one;
 * tests serve canned tree JSON).
 *
 * Two entry points share one tree-fetch/shape-validation core
 * ({@link fetchHfTree}):
 *  - `verifyHfDigest` (Sweep, `pinned` mode) — exact-file-set equality
 *    against a code-pinned digest.
 *  - `resolveLfsOid` (allowlist tier, `live-oid` mode) — resolves ONE
 *    file's live `lfs.oid`; makes no exact-file-set claim (nothing else in
 *    the repo is ever read for this file).
 *
 * Security rules shared by both, all fail-closed:
 *  - **`lfs.oid` ONLY, never the git-SHA1 `oid`** (⚠ S-F16b): per-file
 *    `lfs.oid` is the SHA-256 of the LFS artifact; non-LFS entries carry a
 *    git-SHA1 `oid` that MUST NOT be consulted — an entry for the gguf file
 *    without an `lfs` block refuses even if its `oid` happens to equal the
 *    pin (a fallback reader would be spoofable by a 20-byte-hash preimage
 *    surface it was never designed to resist).
 *  - **Pagination refuses** (⚠ SC-A-1): the tree API paginates
 *    (`Link: rel="next"`); a present next-page marker means the read tree
 *    could be a truncated partial view, so BOTH functions refuse rather
 *    than verify against it — never a silent partial verify, never a
 *    `/resolve` HEAD/ETag fallback.
 *
 * `verifyHfDigest` additionally enforces **exact-file-set equality**
 * against `gguf.allowedRepoFiles` (⚠ S-F4): Ollama also ingests
 * `template`/`system`/`params` from a pulled repo, so weights-only
 * verification is insufficient there — ANY unexpected path in the tree
 * (including one smuggled after publication) refuses, as does any missing
 * expected path. `resolveLfsOid` additionally asserts the resolved oid's
 * **shape** (`^[0-9a-f]{64}$`) — a malformed or wrong-length value (e.g. a
 * git-SHA1-length string smuggled into `lfs.oid`) refuses rather than being
 * passed on to the download engine as a "verified" digest.
 *
 * Every failure mode — HTTP error, network rejection, timeout, malformed
 * body, pagination, set mismatch, digest mismatch, digest shape — collapses
 * to a typed `{ok:false, reason}`; neither function ever throws. Callers map
 * ANY `{ok:false}` to their one pinned refusal line and abort the download.
 */

export interface HfGgufSpec {
  /** e.g. `SyntinalCo/sweep-next-edit-v2-7B-GGUF` (owner-pinned, §4.1). */
  hfRepo: string;
  /** The weights file whose `lfs.oid` must equal {@link HfGgufSpec.sha256}. */
  file: string;
  /** The code-pinned SHA-256 (64 hex chars; `''` = unpublished, caller refuses earlier). */
  sha256: string;
  /** The ONLY paths the repo may contain — exact set equality, both directions. */
  allowedRepoFiles: readonly string[];
}

export type HfDigestVerdict = { ok: true } | { ok: false; reason: string };

/** The `live-oid` counterpart of {@link HfDigestVerdict} — carries the resolved digest. */
export type LfsOidVerdict = { ok: true; oid: string } | { ok: false; reason: string };

/** §4.4: the tree API gets 10 s to answer before the pre-flight refuses. */
const TREE_TIMEOUT_MS = 10_000;

/** HF's own `lfs.oid` shape: lowercase SHA-256 hex, always. */
const LFS_OID_SHAPE = /^[0-9a-f]{64}$/;

interface HfTreeEntry {
  path: string;
  /** Set ONLY from `entry.lfs.oid` — the top-level git-SHA1 `oid` is never read (S-F16b). */
  lfsOid: string | undefined;
}

type HfTreeFetchResult = { ok: true; entries: HfTreeEntry[] } | { ok: false; reason: string };

/**
 * True when the response carries a `Link` header naming `rel="next"` — the
 * HF tree API's pagination marker (SC-A-1). Defensive against responses
 * (real or mocked) that omit `headers` entirely: no header ⇒ not paginated,
 * never a thrown error.
 */
function hasNextPageLink(response: Response): boolean {
  const headers = (response as { headers?: { get?: (name: string) => string | null } }).headers;
  if (!headers || typeof headers.get !== 'function') return false;
  let link: string | null = null;
  try {
    link = headers.get('Link') ?? headers.get('link');
  } catch {
    return false;
  }
  if (!link) return false;
  return /rel\s*=\s*"?next"?/i.test(link);
}

/**
 * The shared tree-fetch/shape-validation core (T2 extraction). Fetches the
 * HF tree API for `hfRepo`, applies the 10 s abort + pagination-refuse +
 * body-shape checks, and returns a normalized, per-entry-validated list.
 * Both `verifyHfDigest` and `resolveLfsOid` build their own semantics on
 * top of this — set-equality for the former, single-file lookup for the
 * latter — but neither re-implements fetch/timeout/pagination/shape
 * handling.
 */
async function fetchHfTree(fetchImpl: typeof fetch, hfRepo: string): Promise<HfTreeFetchResult> {
  const url = `https://huggingface.co/api/models/${hfRepo}/tree/main?recursive=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TREE_TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    // Pagination-refuse (SC-A-1): a present next-page marker means this
    // page could be a truncated partial view — refuse before trusting
    // anything else about the response, including its status.
    if (hasNextPageLink(response)) {
      return {
        ok: false,
        reason: 'tree API response is paginated (Link rel="next") — refusing to verify against a possibly truncated tree',
      };
    }
    if (!response.ok) {
      return { ok: false, reason: `tree API responded ${response.status}` };
    }
    body = await response.json();
  } catch (err) {
    return { ok: false, reason: `tree API request failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(body)) {
    return { ok: false, reason: 'tree API returned an unexpected shape' };
  }

  const entries: HfTreeEntry[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'tree API returned an unexpected entry shape' };
    }
    const path = (entry as Record<string, unknown>)['path'];
    if (typeof path !== 'string') {
      return { ok: false, reason: 'tree API returned an entry without a path' };
    }
    let lfsOid: string | undefined;
    const lfs = (entry as Record<string, unknown>)['lfs'];
    if (typeof lfs === 'object' && lfs !== null) {
      const oid = (lfs as Record<string, unknown>)['oid'];
      if (typeof oid === 'string') lfsOid = oid;
    }
    entries.push({ path, lfsOid });
  }

  return { ok: true, entries };
}

export async function verifyHfDigest(fetchImpl: typeof fetch, gguf: HfGgufSpec): Promise<HfDigestVerdict> {
  // final-fixwave Fix 1: normalize the pin to lowercase at point of use — HF's
  // `lfs.oid` is always lowercase hex, but the code-pinned `gguf.sha256` is a
  // manually-pasted string; an UPPERCASE/mixed-case paste must still verify
  // rather than silently refusing every download. `'' → ''` is unchanged, so
  // the empty-pin fail-closed behavior below is untouched.
  const pin = gguf.sha256.toLowerCase();

  const treeResult = await fetchHfTree(fetchImpl, gguf.hfRepo);
  if (!treeResult.ok) return treeResult;

  const treePaths = new Set<string>();
  let ggufLfsOid: string | undefined;
  let ggufEntrySeen = false;
  for (const entry of treeResult.entries) {
    treePaths.add(entry.path);
    if (entry.path === gguf.file) {
      ggufEntrySeen = true;
      ggufLfsOid = entry.lfsOid;
    }
  }

  // Exact set equality, both directions (S-F4).
  const allowed = new Set(gguf.allowedRepoFiles);
  for (const path of treePaths) {
    if (!allowed.has(path)) return { ok: false, reason: `unexpected file in repo tree: ${path}` };
  }
  for (const path of allowed) {
    if (!treePaths.has(path)) return { ok: false, reason: `expected file missing from repo tree: ${path}` };
  }

  if (!ggufEntrySeen) {
    return { ok: false, reason: `expected file missing from repo tree: ${gguf.file}` };
  }
  if (ggufLfsOid === undefined) {
    return { ok: false, reason: 'gguf entry carries no lfs.oid (non-LFS entry — git-SHA1 oid is never consulted)' };
  }
  if (ggufLfsOid !== pin) {
    return { ok: false, reason: 'gguf lfs.oid does not match the pinned sha256' };
  }
  return { ok: true };
}

/**
 * §2.2.5 — the `live-oid` resolver for the allowlist tier: resolves exactly
 * one file's live `lfs.oid` from its publisher's HF repo tree. Makes NO
 * exact-file-set claim (unlike `verifyHfDigest`) — sound because nothing
 * else in the repo is ever read for this file; the resolved digest is
 * handed to the SAME download-and-hash engine that `verifyHfDigest` feeds,
 * so the received bytes are still hashed and compared before any
 * placement/ingest.
 */
export async function resolveLfsOid(fetchImpl: typeof fetch, hfRepo: string, file: string): Promise<LfsOidVerdict> {
  const treeResult = await fetchHfTree(fetchImpl, hfRepo);
  if (!treeResult.ok) return treeResult;

  const entry = treeResult.entries.find((e) => e.path === file);
  if (!entry) {
    return { ok: false, reason: `expected file missing from repo tree: ${file}` };
  }
  if (entry.lfsOid === undefined) {
    return { ok: false, reason: 'gguf entry carries no lfs.oid (non-LFS entry — git-SHA1 oid is never consulted)' };
  }
  if (!LFS_OID_SHAPE.test(entry.lfsOid)) {
    return { ok: false, reason: 'lfs.oid does not match the expected 64-hex-character shape' };
  }
  return { ok: true, oid: entry.lfsOid };
}
