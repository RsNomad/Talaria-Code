import { describe, it, expect } from 'vitest';
import { refusePinnedOllamaPreconditions, NEXT_DOWNLOAD_UNAVAILABLE, NEXT_REMOTE_ENDPOINT_REFUSAL } from './provisionRunner';

/**
 * WS-F8 F8-4 (FI-22 setup-half, `[SEC]`-adjacent): `refusePinnedOllamaPreconditions`
 * single-sources the pinned-Ollama fail-closed ladder shared by
 * `handleVettedIngest` and `provisionOllama`'s pinned arm. The behavioural
 * test files (`SetupController.provisionModel.test.ts` /
 * `.fixtures.test.ts`) each trigger only ONE of the two checks at a time, so
 * neither pins which reason wins when BOTH fail — this file's ORDER case
 * does: the EXACT beta.5 vetted order is empty-pin BEFORE loopback, so an
 * empty pin against a non-loopback endpoint must still refuse with
 * `NEXT_DOWNLOAD_UNAVAILABLE`, never the endpoint reason.
 */

const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434/';
const NON_LOOPBACK_ENDPOINT = 'http://10.0.0.5:11434/';
const PIN = 'a'.repeat(64);

describe('refusePinnedOllamaPreconditions', () => {
  it('empty pin + loopback endpoint → NEXT_DOWNLOAD_UNAVAILABLE', () => {
    expect(refusePinnedOllamaPreconditions('', LOOPBACK_ENDPOINT)).toEqual({
      ok: false,
      reason: NEXT_DOWNLOAD_UNAVAILABLE,
    });
  });

  it('non-empty pin + non-loopback endpoint → NEXT_REMOTE_ENDPOINT_REFUSAL', () => {
    expect(refusePinnedOllamaPreconditions(PIN, NON_LOOPBACK_ENDPOINT)).toEqual({
      ok: false,
      reason: NEXT_REMOTE_ENDPOINT_REFUSAL,
    });
  });

  it('ORDER: empty pin + non-loopback endpoint → NEXT_DOWNLOAD_UNAVAILABLE (empty-pin wins)', () => {
    expect(refusePinnedOllamaPreconditions('', NON_LOOPBACK_ENDPOINT)).toEqual({
      ok: false,
      reason: NEXT_DOWNLOAD_UNAVAILABLE,
    });
  });

  it('non-empty pin + loopback endpoint → ok', () => {
    expect(refusePinnedOllamaPreconditions(PIN, LOOPBACK_ENDPOINT)).toEqual({ ok: true });
  });
});
