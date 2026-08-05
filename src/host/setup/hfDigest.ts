/**
 * hfDigest — the HF-tree integrity pre-flight for the vetted NEXT download
 * (beta5-setup-hardening-architecture.md §4.4.3c, facts §0.3).
 *
 * PURE — no `vscode` (the directory purity scan applies), no ambient fetch:
 * the caller injects `fetchImpl` (`setupHost.vscode.ts` binds the real one;
 * tests serve canned tree JSON).
 *
 * Two load-bearing security rules, both fail-closed:
 *  - **Exact-file-set equality** against `gguf.allowedRepoFiles` (⚠ S-F4):
 *    Ollama also ingests `template`/`system`/`params` from a pulled repo, so
 *    weights-only verification is insufficient — ANY unexpected path in the
 *    tree (including one smuggled after publication) refuses, as does any
 *    missing expected path.
 *  - **`lfs.oid` ONLY, never the git-SHA1 `oid`** (⚠ S-F16b): per-file
 *    `lfs.oid` is the SHA-256 of the LFS artifact; non-LFS entries carry a
 *    git-SHA1 `oid` that MUST NOT be consulted — an entry for the gguf file
 *    without an `lfs` block refuses even if its `oid` happens to equal the
 *    pin (a fallback reader would be spoofable by a 20-byte-hash preimage
 *    surface it was never designed to resist).
 *
 * Every failure mode — HTTP error, network rejection, timeout, malformed
 * body, set mismatch, digest mismatch — collapses to `{ok:false, reason}`;
 * the function never throws. The caller (SetupController §4.4.3c) maps ANY
 * `{ok:false}` to its one pinned refusal line and aborts the download.
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

/** §4.4: the tree API gets 10 s to answer before the pre-flight refuses. */
const TREE_TIMEOUT_MS = 10_000;

export async function verifyHfDigest(fetchImpl: typeof fetch, gguf: HfGgufSpec): Promise<HfDigestVerdict> {
  // final-fixwave Fix 1: normalize the pin to lowercase at point of use — HF's
  // `lfs.oid` is always lowercase hex, but the code-pinned `gguf.sha256` is a
  // manually-pasted string; an UPPERCASE/mixed-case paste must still verify
  // rather than silently refusing every download. `'' → ''` is unchanged, so
  // the empty-pin fail-closed behavior below is untouched.
  const pin = gguf.sha256.toLowerCase();
  const url = `https://huggingface.co/api/models/${gguf.hfRepo}/tree/main?recursive=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TREE_TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
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

  const treePaths = new Set<string>();
  let ggufLfsOid: string | undefined;
  let ggufEntrySeen = false;
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'tree API returned an unexpected entry shape' };
    }
    const path = (entry as Record<string, unknown>)['path'];
    if (typeof path !== 'string') {
      return { ok: false, reason: 'tree API returned an entry without a path' };
    }
    treePaths.add(path);
    if (path === gguf.file) {
      ggufEntrySeen = true;
      // lfs.oid ONLY — the top-level git-SHA1 `oid` is NEVER read (S-F16b).
      const lfs = (entry as Record<string, unknown>)['lfs'];
      if (typeof lfs === 'object' && lfs !== null) {
        const oid = (lfs as Record<string, unknown>)['oid'];
        if (typeof oid === 'string') ggufLfsOid = oid;
      }
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
