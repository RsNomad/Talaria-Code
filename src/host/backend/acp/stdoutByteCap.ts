import { Transform } from 'node:stream';

/**
 * CA-01 (WS-AC): a byte-counting PASS-THROUGH between the ACP child's stdout
 * and the SDK's `ndJsonStream`. The SDK buffers a physical line unboundedly
 * (any JSON-RPC message is ONE line — string escaping keeps newlines out of
 * payloads), and ACP is the higher-volume channel; its sibling
 * `JsonRpcStdio` has capped its own stdout since B-4 (SEC-6).
 *
 * Contract (frozen-adjacent care): this Transform NEVER reframes and NEVER
 * silently truncates — chunks pass through byte-identical until the trip.
 * On trip it (a) reports the buffered byte count once, (b) forwards nothing
 * further. It does NOT own teardown: the caller kills the child, and the
 * existing crash machinery (child 'exit' → `terminate()` → termination-pair
 * rejection → exitHandlers → supervisor respawn) settles everything —
 * cap-then-teardown+respawn, exactly the `JsonRpcStdio` model
 * (`JsonRpcStdio.ts` `onStdout`'s oversized-frame teardown). `ndJsonStream`
 * itself (SDK) and `transportSecurity` are untouched.
 *
 * Byte semantics are exact by construction: the stream carries raw Buffers
 * (no setEncoding on the ACP stdout), so `chunk.length` IS bytes — the
 * CA-M01 UTF-16-unit undercount cannot occur here.
 *
 * Residual accepted (documented): a trip mid-chunk drops any complete
 * frames sharing that same chunk — immaterial, the connection is dying and
 * every in-flight request is rejected by `terminate()`.
 */
export function createStdoutByteCapTransform(
  maxLineBytes: number,
  onExceeded: (bufferedBytes: number) => void,
): Transform {
  let bytesSinceNewline = 0;
  let tripped = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (tripped) {
        callback(); // post-trip: drop — the child is already being killed
        return;
      }
      const lastNewline = chunk.lastIndexOf(0x0a);
      bytesSinceNewline = lastNewline >= 0 ? chunk.length - lastNewline - 1 : bytesSinceNewline + chunk.length;
      if (bytesSinceNewline > maxLineBytes) {
        tripped = true;
        const buffered = bytesSinceNewline;
        bytesSinceNewline = 0;
        onExceeded(buffered);
        callback(); // never forward a line we won't deliver whole
        return;
      }
      callback(null, chunk);
    },
  });
}
