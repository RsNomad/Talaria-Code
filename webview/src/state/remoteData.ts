/*
 * RemoteData — a type-safe ADT for the four states of an async data source
 * (Part X2). It makes impossible states impossible: a panel is EITHER idle,
 * loading, showing data, OR showing an error — never a data-less "spinner
 * forever".
 *
 * Grounding: the ADT is the well-worn `devexperts/remote-data-ts`
 * (initial|pending|failure|success) shape, and the state names line up with
 * TanStack Query's `status: 'pending' | 'error' | 'success'` (v5) — a query
 * with cached data that is silently re-fetching stays `success` (see
 * `panels.ts`'s no-flash loading), which is why loading is a distinct state
 * from "no data yet".
 */

/** The error surfaced by a failed fetch. `retryable` gates the Retry affordance. */
export interface RemoteError {
  readonly message: string;
  /** Whether re-invoking might succeed (transient RPC/connection errors are). */
  readonly retryable: boolean;
}

/** One of the four disjoint states of a remotely-fetched value of type `T`. */
export type RemoteData<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly error: RemoteError };

// --- constructors ------------------------------------------------------------

/** Never fetched. */
export const idle: RemoteData<never> = { status: 'idle' };

/** Fetch in flight, no data yet. */
export const loading: RemoteData<never> = { status: 'loading' };

/** Resolved with data. */
export function success<T>(data: T): RemoteData<T> {
  return { status: 'success', data };
}

/** Rejected with an error. */
export function failure(error: RemoteError): RemoteData<never> {
  return { status: 'error', error };
}

// --- guards (narrow the union) -----------------------------------------------

export function isIdle<T>(rd: RemoteData<T>): rd is { status: 'idle' } {
  return rd.status === 'idle';
}
export function isLoading<T>(rd: RemoteData<T>): rd is { status: 'loading' } {
  return rd.status === 'loading';
}
export function isSuccess<T>(rd: RemoteData<T>): rd is { status: 'success'; data: T } {
  return rd.status === 'success';
}
export function isError<T>(rd: RemoteData<T>): rd is { status: 'error'; error: RemoteError } {
  return rd.status === 'error';
}
