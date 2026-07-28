/*
 * A total (never-undefined) lookup over a small `Record<Enum, X>` map.
 *
 * UI-I1: `bridge.ts` only checks a host->webview message's `.type` — the rest
 * of the payload is trusted structurally, unvalidated. Several render sites
 * index a `Record<Enum, X>` by a host-supplied field typed as that enum at
 * compile time (`item.status`, `d.status`, `srv.status`, `t.kind`,
 * `sk.provenance`) — but nothing proves the WIRE value is actually one of
 * the enum's members. A malformed/forward-incompatible value (an older/newer
 * host, a bug, a corrupted message) makes `map[key]` `undefined` at runtime
 * even though TypeScript believes it is always present, and dereferencing a
 * field off that (`.tone`) throws mid-render — with no error boundary that
 * blanks the whole webview (see `.superpowers/sdd/reports/final-3way-2-ui.md`
 * finding I1).
 *
 * `totalLookup` makes every such access TOTAL: an unrecognized key falls
 * back to a caller-supplied safe default instead of `undefined`, without a
 * cast — `isOwnKey`'s type predicate narrows `key` to `K` inside the branch.
 * `hasOwnProperty` (not `key in map`) so inherited `Object.prototype` members
 * (`toString`, `constructor`, ...) are never mistaken for a real map entry.
 */
export function totalLookup<K extends string, V>(map: Record<K, V>, key: string, fallback: V): V {
  return isOwnKey(map, key) ? map[key] : fallback;
}

function isOwnKey<K extends string>(map: Record<K, unknown>, key: string): key is K {
  return Object.prototype.hasOwnProperty.call(map, key);
}
