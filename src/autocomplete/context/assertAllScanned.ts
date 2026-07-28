/**
 * W6-FD · the `assertAllScanned` wire-adjacent egress backstop — ratified
 * resolution of W5 critic-pin B1 (`docs/research/_critic-pins.md`,
 * `docs/research/wave-5/00-architecture-and-paths.md` §3.2 "Wire-adjacent
 * backstop"), built per `final-3way-arch.md` finding I-5 (it was ratified in
 * the W5 design but SILENTLY DROPPED at build time — zero hits in tree).
 *
 * The `ScannedSnippet` brand (`context/types.ts`'s `declare const SCANNED:
 * unique symbol`) is a COMPILE-TIME-only guarantee: `ringBuffer.ts`'s
 * sanctioned mint-site cast assigns no runtime value for that symbol key, so
 * there is no runtime bit anywhere on the object to inspect —
 * "was this really scanned?" cannot be answered by looking at the value
 * itself (TypeScript brands are erased at runtime by design). §3.2 pins the
 * answer instead: "each backend, immediately before `fetch`, runs a cheap
 * ... `assertAllScanned(req.context.snippets)`" — a RE-SCAN of every
 * snippet through the SAME `scanSnippetForSecrets` choke point
 * `ringBuffer.ingest` already gates on, run again right at the wire
 * (mirrors `backends/secureTransport.ts`'s `assertSecureAuthTransport`,
 * called at the top of every backend's `streamFim`, immediately before its
 * own `fetch`).
 *
 * This is deliberate belt-and-suspenders, not redundant busywork: the type
 * system is the PRIMARY gate (an unscanned array does not type-check as
 * `FimContext.snippets`); this is the runtime SECONDARY gate that still
 * fires when the type system is bypassed — an unsafe cast, a
 * `// @ts-expect-error`, or a future `any`-typed seam that launders an
 * unscanned/forged array past the compiler. `final-3way-arch.md`'s I-5
 * calls this out explicitly as the only layer that catches "cast-free
 * `any`-laundering".
 *
 * Fail-closed, "fails toward LESS egress": throws on the FIRST snippet that
 * re-scans as rejected (or whose scan itself throws — mirroring
 * `ringBuffer.ingest`'s own throw-is-reject treatment, §3.2) rather than
 * continuing to try to salvage a "safe subset" of the batch; aborting the
 * whole request is safer than guessing which snippets are trustworthy.
 * NEVER includes the matched secret text in the thrown message — `ruleId`
 * only, the same contract `SecretScanVerdict` itself carries.
 */
import { scanSnippetForSecrets } from './secretScanner';
import type { ScannedSnippet } from './types';

export function assertAllScanned(snippets: readonly ScannedSnippet[]): void {
  for (const snippet of snippets) {
    let allowed: boolean;
    let ruleId: string | undefined;
    try {
      ({ allowed, ruleId } = scanSnippetForSecrets({ path: snippet.filepath, content: snippet.content }));
    } catch {
      allowed = false;
      ruleId = 'scanner-threw';
    }
    if (!allowed) {
      throw new Error(
        `assertAllScanned: a snippet reached the egress point without a passing secret-scan verdict ` +
          `(ruleId=${ruleId ?? 'unknown'}). Refusing to send (fail-closed).`,
      );
    }
  }
}
