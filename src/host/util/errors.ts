/**
 * Small host-layer error helpers.
 *
 * `notImplemented()` is used by the stub backends (`AcpBackend`,
 * `ControlChannel`) so their method bodies stay honest — the *shape* is real
 * and type-checks, but calling into unimplemented behaviour fails loudly
 * instead of silently returning `undefined`.
 */

/** Marker error thrown by not-yet-wired real-backend code paths. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}. This lands when the real Hermes ` +
      `backend is wired on Fedora (see docs/arch-host.md §"Real wiring").`);
    this.name = 'NotImplementedError';
  }
}

/** Convenience thrower so call sites read `throw notImplemented('AcpBackend.start')`. */
export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
