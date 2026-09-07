import { describe, it, expect, vi } from 'vitest';
import { makeSidecarWriter, GgufSidecarWriteError } from './sidecarWriter';

/** A stub `writeFile` matching `writeFileNoFollow`'s `(string, Uint8Array)`
 *  signature, driven by a queue of outcomes — each call shifts the next
 *  outcome off the queue ('ok' resolves, an `Error` rejects with it). */
function stubWriteFile(outcomes: Array<'ok' | Error>): {
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  calls: Array<{ path: string; bytes: Uint8Array }>;
} {
  const calls: Array<{ path: string; bytes: Uint8Array }> = [];
  const writeFile = vi.fn(async (path: string, bytes: Uint8Array): Promise<void> => {
    calls.push({ path, bytes });
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error('stubWriteFile: no more scripted outcomes');
    if (outcome === 'ok') return;
    throw outcome;
  });
  return { writeFile, calls };
}

function eio(): Error {
  return Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
}

function eloop(): Error {
  return Object.assign(new Error('ELOOP: refusing to write through a symlink'), { code: 'ELOOP' });
}

describe('makeSidecarWriter — WS-R2 R2-3 (L2-CA-18, OD-C non-frozen half)', () => {
  it('(i) a transient failure then success: RESOLVES, writeFile called 2x', async () => {
    const { writeFile, calls } = stubWriteFile([eio(), 'ok']);
    const writer = makeSidecarWriter(writeFile);

    await expect(writer('/store/model.gguf.talaria.json', '{"a":1}')).resolves.toBeUndefined();

    expect(calls.length).toBe(2);
    expect(calls[0]?.path).toBe('/store/model.gguf.talaria.json');
    expect(calls[1]?.path).toBe('/store/model.gguf.talaria.json');
  });

  it('(ii) two transient failures: REJECTS with GgufSidecarWriteError, cause = the SECOND error, called 2x, message has no path', async () => {
    const first = eio();
    const second = eio();
    const { writeFile, calls } = stubWriteFile([first, second]);
    const writer = makeSidecarWriter(writeFile);

    let caught: unknown;
    try {
      await writer('/store/model.gguf.talaria.json', '{"a":1}');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GgufSidecarWriteError);
    expect((caught as GgufSidecarWriteError).cause).toBe(second);
    expect((caught as GgufSidecarWriteError).cause).not.toBe(first);
    expect(calls.length).toBe(2);
    expect((caught as Error).message).toContain('downloaded and verified, but not recorded');
    expect((caught as Error).message).not.toContain('/store/model.gguf.talaria.json');
  });

  it('(iii) an ELOOP symlink refusal REJECTS IMMEDIATELY with the ORIGINAL error, called 1x — never retried, never re-labelled (H3b)', async () => {
    const refusal = eloop();
    const { writeFile, calls } = stubWriteFile([refusal, 'ok']);
    const writer = makeSidecarWriter(writeFile);

    let caught: unknown;
    try {
      await writer('/store/model.gguf.talaria.json', '{"a":1}');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(refusal);
    expect(caught).not.toBeInstanceOf(GgufSidecarWriteError);
    expect((caught as { code?: unknown }).code).toBe('ELOOP');
    expect(calls.length).toBe(1);
  });
});
