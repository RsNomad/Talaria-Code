/**
 * nextedit/scan.ts — Job B Task 4 · the request-level secret-scan egress
 * choke point («09-jobB-final-plan.md» Global Constraints, "Secret-scan is
 * NOT inherited"). `assertAllScanned` (`context/assertAllScanned.ts`) takes
 * only a snippets array and by construction cannot cover a whole
 * `NextEditRequest` — a request also carries `fileContext`, `docText`,
 * `preEditDocText`, `preEditRegion`, the editable `region`, and diff
 * history, none of which are `ScannedSnippet`s. This module is the
 * request-level analogue: `mintScannedNextEditRequest` is the ONLY sanctioned
 * site that produces a `ScannedNextEditRequest` (mirrors `ringBuffer.ts`'s
 * `ingest` — the mint is reachable only after every egressing content field
 * has passed `scanSnippetForSecrets`, reusing the SAME W5 scanner, no new
 * detection engine).
 *
 * `NEXT_EDIT_FIELD_CLASSIFICATION` is a `Record<keyof NextEditRequest, ...>`
 * literal — TypeScript requires EVERY key of `NextEditRequest` to be present,
 * so adding a field to `NextEditRequest` (Task 1's `types.ts`) without adding
 * a row here is a `tsc` ERROR, not a silent leak (the keyof exhaustiveness
 * table). The mint's scan loop then walks that SAME table (not a separate
 * hard-coded field list) and, for every field classified `'content'`, looks
 * up a wired extractor in `CONTENT_EXTRACTORS` — a `'content'` field with no
 * extractor wired is ALSO a fail-closed runtime throw, so a future field that
 * is classified but never actually wired into scanning cannot silently ship
 * unscanned either.
 *
 * Fail-closed throughout: a scanner throw is treated as a reject
 * (`ruleId: 'scanner-threw'`, mirroring `assertAllScanned.ts:46-51`); the
 * first reject aborts the whole mint (no "salvage a safe subset"). A sentinel
 * guard additionally rejects any content string carrying a caller-supplied
 * format-restructuring marker (`ruleId: 'sentinel'`) — a prompt-injection
 * concern distinct from secret leakage. The thrown message NEVER carries the
 * matched secret text or the scanned content itself — `ruleId` only, same
 * contract as `SecretScanVerdict`.
 *
 * Field-by-field construction only (no object-spread-with-override, no
 * unsafe casts beyond the one sanctioned brand cast at the very end) — this
 * file lives under `src/autocomplete/` and is in scope for
 * `ringBuffer.test.ts`'s repo-wide `SPREAD_RE` purity guard. The brand cast
 * below is guarded by its OWN sibling sweep (`ringBuffer.test.ts`'s
 * `NEXT_CAST_RE` block, which sanctions exactly this file) — `CAST_RE`
 * itself names only the `ScannedSnippet` brand and cannot see this one.
 */
import { scanSnippetForSecrets } from '../context/secretScanner';
import type { NextEditRequest, ScannedNextEditRequest } from './types';

/**
 * The keyof exhaustiveness table. `content` fields are scanned before
 * egress: `region` (its `.content`), `preEditRegion`, `fileContext`,
 * `docText`, `preEditDocText`, and `diffs` (every `.before` AND `.after`).
 * `structural` fields are NEVER scanned: `model`, `cursor`,
 * `changesAboveCursor`, `docVersion` — scanning them would risk false
 * positives on non-secret metadata (a model name that happens to look like a
 * token, per the shipped test) and they never carry free-form file content.
 *
 * ADDING A FIELD? Classify it 'content' unless it can NEVER carry free-form
 * file/document text. The table forces a row to EXIST, not to be CORRECT —
 * a content-bearing field mis-marked 'structural' compiles clean and ships
 * unscanned. When in doubt: 'content'.
 */
export const NEXT_EDIT_FIELD_CLASSIFICATION: Readonly<Record<keyof NextEditRequest, 'content' | 'structural'>> =
  Object.freeze({
    model: 'structural',
    cursor: 'structural',
    region: 'content',
    preEditRegion: 'content',
    fileContext: 'content',
    docText: 'content',
    preEditDocText: 'content',
    changesAboveCursor: 'structural',
    diffs: 'content',
    docVersion: 'structural',
  });

interface ContentCheck {
  readonly path: string;
  readonly content: string;
}

type ContentExtractor = (req: NextEditRequest) => readonly ContentCheck[];

/**
 * One extractor per `'content'`-classified field — the mint's scan loop
 * consults this map keyed off the SAME `NEXT_EDIT_FIELD_CLASSIFICATION`
 * table it type-checks against, so a content field with no extractor wired
 * here fails closed at mint time (see `contentChecksFor` below) rather than
 * silently skipping the scan.
 */
const CONTENT_EXTRACTORS: Partial<Record<keyof NextEditRequest, ContentExtractor>> = {
  region: (req) => [{ path: req.region.filepath, content: req.region.content }],
  preEditRegion: (req) =>
    req.preEditRegion === null ? [] : [{ path: req.region.filepath, content: req.preEditRegion }],
  fileContext: (req) => [{ path: req.region.filepath, content: req.fileContext }],
  docText: (req) => [{ path: req.region.filepath, content: req.docText }],
  preEditDocText: (req) =>
    req.preEditDocText === null ? [] : [{ path: req.region.filepath, content: req.preEditDocText }],
  diffs: (req) =>
    req.diffs.flatMap((diff) => [
      { path: diff.filepath, content: diff.before },
      { path: diff.filepath, content: diff.after },
    ]),
};

/**
 * V-1 fix — the honest-failure half. Before this, every mint rejection was a
 * bare `Error`, indistinguishable at the catch site from a network failure;
 * `shell.vscode.ts`'s `surfaceTriggerFailure` fell through to its generic
 * "the request to the {transport} server failed... check that the server is
 * running" copy for a request that was NEVER SENT. This typed class lets the
 * shell tell the two apart and name the real cause. `ruleId` is the ONLY
 * payload — same contract as `SecretScanVerdict`: never the matched secret
 * text, never the scanned content, never a response body.
 */
export class NextEditMintRejectionError extends Error {
  constructor(public readonly ruleId: string) {
    super(`mintScannedNextEditRequest: refusing to mint (fail-closed) — ruleId=${ruleId}.`);
    this.name = 'NextEditMintRejectionError';
  }
}

/** Never includes the matched secret text or scanned content — `ruleId` only. */
function rejectWith(ruleId: string): never {
  throw new NextEditMintRejectionError(ruleId);
}

/** Exported ONLY for the fail-closed drift lock in scan.test.ts. */
export function contentChecksFor(req: NextEditRequest, key: keyof NextEditRequest): readonly ContentCheck[] {
  const extractor = CONTENT_EXTRACTORS[key];
  if (extractor === undefined) {
    // A field classified 'content' but never wired into CONTENT_EXTRACTORS —
    // a table/extractor drift bug, not a real request shape. Fail closed
    // rather than silently scanning nothing for it.
    rejectWith('no-extractor');
  }
  return extractor(req);
}

/**
 * Sentinel guard first (prompt-restructuring concern), then the secret
 * scanner (mirrors `assertAllScanned.ts`'s throw-is-reject). First reject
 * aborts the whole mint.
 */
function checkContent(check: ContentCheck, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) {
    if (check.content.includes(sentinel)) {
      rejectWith('sentinel');
    }
  }

  let allowed: boolean;
  let ruleId: string | undefined;
  try {
    ({ allowed, ruleId } = scanSnippetForSecrets({ path: check.path, content: check.content }));
  } catch {
    allowed = false;
    ruleId = 'scanner-threw';
  }
  if (!allowed) {
    rejectWith(ruleId ?? 'unknown');
  }
}

/**
 * THE only mint. Scans every egressing content field of `req` (per
 * `NEXT_EDIT_FIELD_CLASSIFICATION`) against `scanSnippetForSecrets` and the
 * caller-supplied `sentinels`, throwing on the first reject (ruleId-only
 * message, never the matched text), and only then casts the request to the
 * `ScannedNextEditRequest` brand. Structural fields are never scanned.
 */
export function mintScannedNextEditRequest(
  req: NextEditRequest,
  sentinels: readonly string[],
): ScannedNextEditRequest {
  for (const sentinel of sentinels) {
    if (sentinel.length === 0) {
      // `''.includes('')` is true for every string — an empty sentinel would
      // silently reject EVERY mint under the misleading ruleId 'sentinel'.
      // Same fail-closed direction, but named: this is a caller-contract
      // bug (T12 wires sentinels from format-module constants), not a
      // content verdict.
      rejectWith('empty-sentinel');
    }
  }

  for (const key of Object.keys(NEXT_EDIT_FIELD_CLASSIFICATION) as (keyof NextEditRequest)[]) {
    if (NEXT_EDIT_FIELD_CLASSIFICATION[key] !== 'content') {
      continue;
    }
    for (const check of contentChecksFor(req, key)) {
      checkContent(check, sentinels);
    }
  }

  // Explicit field-by-field construction (no object-spread-with-override) —
  // the one sanctioned brand-cast site, mirroring ringBuffer.ts's mint.
  const minted: NextEditRequest = {
    model: req.model,
    cursor: req.cursor,
    region: req.region,
    preEditRegion: req.preEditRegion,
    fileContext: req.fileContext,
    docText: req.docText,
    preEditDocText: req.preEditDocText,
    changesAboveCursor: req.changesAboveCursor,
    diffs: req.diffs,
    docVersion: req.docVersion,
  };
  return minted as ScannedNextEditRequest;
}
