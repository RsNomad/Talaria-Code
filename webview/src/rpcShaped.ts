/*
 * WS-F1 F1-4 (FI-04 god-component close): the invoke+shape RPC-wrapper
 * helpers, split out of App.tsx into their own module. `globalActions.ts`'s
 * 18 connection-global actions AND App.tsx's own staying checkpoint
 * handlers (`restoreCheckpoint`/`redoCheckpoint`/`redoAllCheckpoint`) both
 * call `requestShaped`/`requestShapedOptional` — a shared dependency that
 * cannot live in either caller's own file without the other importing back
 * from it (a circular import), hence this third, dependency-free module.
 */
import { bridge } from './bridge';
import { asShape } from './shapeGuards';
import type { ControlRequestMethod } from './protocol';

/**
 * WS-BG: guard-or-throw for correlated RPC results. A refused shape rejects
 * with an honest method-named Error — the same rejected-promise path every
 * caller already handles for RPC timeouts (panel error rendering /
 * optimistic rollback). Message names the METHOD only, never the payload.
 */
const requireShape = <T,>(raw: unknown, guard: (x: unknown) => x is T, method: string): T => {
  const shaped = asShape(raw, guard);
  if (shaped === undefined) throw new Error(`${method} returned an unrecognized result shape`);
  return shaped;
};

/**
 * WS-F1 F1-1 (FI-35): folds the invoke+shape tail every ALWAYS-SHAPE
 * correlated RPC call site repeated — `await bridge.request(method, params[,
 * tag])` then `requireShape(result, guard, method)`. `method` is passed ONCE
 * here (used for both the request and the `requireShape` error label),
 * removing the doubled literal every call site carried before. `bridge` is
 * this module's own top-level singleton (see `bridge.ts`'s `export const
 * bridge = new Bridge()`), already in scope at module level exactly like
 * `requireShape` above — no new module global introduced. Omitting `tag`
 * (the 8 mcp/skills call sites) is IDENTICAL to passing `tag === undefined`
 * here: `RpcClient.request` (`rpc.ts`) only ever spreads `tag` onto the
 * pending entry `...(tag !== undefined ? { tag } : {})`, so a bare pass-
 * through (no branch needed) preserves both call shapes untouched.
 */
export async function requestShaped<T>(
  method: ControlRequestMethod,
  params: Record<string, unknown>,
  guard: (x: unknown) => x is T,
  tag?: string,
): Promise<T> {
  const result = await bridge.request(method, params, tag);
  return requireShape(result, guard, method);
}

/**
 * Same fold as {@link requestShaped}, for the 3 `checkpoint.*` call sites
 * whose host refusal paths can resolve a bare `undefined` (see
 * `requireShape`'s own doc above) — that passthrough must survive UNSHAPED,
 * never routed through `requireShape` (which would instead throw an
 * "unrecognized result shape" error, a different failure than the panel's
 * own honest "the host returned no result" handling expects — see
 * `CheckpointsPanel.tsx`'s T-C2/V-17 branch).
 */
export async function requestShapedOptional<T>(
  method: ControlRequestMethod,
  params: Record<string, unknown>,
  guard: (x: unknown) => x is T,
  tag?: string,
): Promise<T | undefined> {
  const result = await bridge.request(method, params, tag);
  return result === undefined ? undefined : requireShape(result, guard, method);
}
