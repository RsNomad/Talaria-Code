/**
 * W2 T4 — F-D: pure `talaria-diff:` URI parser.
 *
 * `talaria-diff://before/<sessionId>/<toolId>/<path>` /
 * `talaria-diff://after/<sessionId>/<toolId>/<path>`. Structural over a
 * `vscode.Uri`-shaped value (`{scheme, authority, path}` — `vscode.Uri.path`
 * is already percent-DECODED) so this stays headless unit-testable without
 * importing `vscode`.
 *
 * W4-T3b (T1b carry — Q-9/R7): `sessionId` is now the FIRST path segment —
 * `EditPreviewRegistry` is keyed `(sessionId, toolCallId)` (a single shared
 * instance across every session, so a bare `toolCallId` could collide across
 * two unrelated sessions), so the URI that resolves it must carry the same
 * compound key.
 *
 * SECURITY: this ONLY shapes the `(side, sessionId, toolId, path)` the
 * caller then hands to `EditPreviewRegistry.getFile` — it never touches
 * `fs`, and a malformed or "oracle-y" URI (wrong scheme, a side value that
 * isn't literally `before`/`after`, a missing sessionId/toolId/path segment)
 * resolves to `null` rather than being coerced into SOME lookup.
 * `EditPreviewRegistry` itself never falls back to a file read on a miss
 * either way (§7 B7) — this parser is a second, independent layer of "never
 * silently accept a shape we didn't design for".
 */
export interface ParsedDiffUri {
  side: 'before' | 'after';
  sessionId: string;
  toolId: string;
  path: string;
}

/** The minimal structural slice of `vscode.Uri` this parser needs. */
export interface DiffUriLike {
  scheme: string;
  authority: string;
  path: string;
}

const SCHEME = 'talaria-diff';

export function parseDiffUri(uri: DiffUriLike): ParsedDiffUri | null {
  if (uri.scheme !== SCHEME) return null;
  if (uri.authority !== 'before' && uri.authority !== 'after') return null;

  const raw = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
  if (!raw) return null;

  const firstSlash = raw.indexOf('/');
  if (firstSlash <= 0) return null; // no segments at all, or an empty sessionId ahead of them
  const sessionId = raw.slice(0, firstSlash);
  const rest = raw.slice(firstSlash + 1);

  const secondSlash = rest.indexOf('/');
  if (secondSlash <= 0) return null; // no path segment at all, or an empty toolId ahead of it
  const toolId = rest.slice(0, secondSlash);
  const path = rest.slice(secondSlash + 1);
  if (!sessionId || !toolId || !path) return null;

  return { side: uri.authority, sessionId, toolId, path };
}

/**
 * {@link parseDiffUri}'s inverse: the `{scheme, authority, path}` parts for
 * one `talaria-diff:` side, ready to hand to `vscode.Uri.from(...)`. Kept pure
 * (no `vscode` import) so `HermesViewProvider`'s `diff.open` routing stays a
 * one-line `vscode.Uri.from(buildDiffUriParts(...))` call — the URI-building
 * logic itself is headless-tested here, round-tripped against
 * {@link parseDiffUri} in the test file. Assumes `sessionId`/`toolId` never
 * themselves contain a `/` (ACP session/tool-call ids don't); `path` may
 * (nested directories).
 */
export function buildDiffUriParts(
  side: 'before' | 'after',
  sessionId: string,
  toolId: string,
  path: string,
): DiffUriLike {
  return { scheme: SCHEME, authority: side, path: `/${sessionId}/${toolId}/${path}` };
}
