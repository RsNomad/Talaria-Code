/**
 * Pure response-building for the `context.searchFiles` control request
 * (`docs/research/wave-2/00-architecture-and-paths.md` §2e; §7 finding A4
 * "moved INTO `CONTROL_METHODS` as an `invokeControl`-style special-case,
 * B9's clamps adopted"). `TalariaViewProvider.ts` calls this with a real
 * `WorkspacePort.findFiles`; this file takes it as an INJECTED function so
 * the whole response-shaping contract — query coercion, `maxResults`
 * clamping, secret-path filtering — is testable with a fake, with zero
 * `vscode` import.
 */
import { isSecretForCompletion } from '../backend/policy/editPolicy';

export type FindFilesFn = (query: string, maxResults: number) => Promise<string[]>;

export interface SearchFilesParams {
  query?: unknown;
  maxResults?: unknown;
}

/** Page size when the webview omits `maxResults`. */
export const SEARCH_FILES_DEFAULT_MAX_RESULTS = 50;
/** Hard ceiling the webview can never exceed regardless of what it asks for
 * (§7 B9: "`maxResults` clamped ≤ 200"). */
export const SEARCH_FILES_HARD_CAP = 200;

/**
 * Build the `context.searchFiles` response:
 * 1. Coerce the webview-supplied (therefore untrusted-TYPED — it crosses
 *    `postMessage` as `unknown`-shaped JSON) `query`/`maxResults` to safe
 *    primitives — never `as`-cast, never trust the wire shape.
 * 2. Clamp `maxResults` into `[0, SEARCH_FILES_HARD_CAP]`; `0` short-circuits
 *    WITHOUT calling the port at all (nothing was asked for).
 * 3. Call the injected port, then filter every secret-classified path out of
 *    the RESULTS before they ever reach the webview (§2d point 1's egress
 *    floor, applied here even though this control never sends file
 *    CONTENTS — a compromised webview must still get no free secret-path
 *    ENUMERATION, §7 B9).
 */
export async function buildSearchFilesResponse(
  findFiles: FindFilesFn,
  params: SearchFilesParams,
): Promise<string[]> {
  const query = typeof params.query === 'string' ? params.query : '';
  const requested =
    typeof params.maxResults === 'number' && Number.isFinite(params.maxResults)
      ? params.maxResults
      : SEARCH_FILES_DEFAULT_MAX_RESULTS;
  const maxResults = Math.max(0, Math.min(Math.floor(requested), SEARCH_FILES_HARD_CAP));
  if (maxResults === 0) return [];

  const raw = await findFiles(query, maxResults);
  return raw.filter((path) => !isSecretForCompletion(path));
}
