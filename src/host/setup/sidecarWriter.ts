/** CA-18 (OD-C, non-frozen half): the sidecar-write policy lifted OUT of the
 *  frozen ggufIngest call site into the (non-frozen) writeSidecar binding.
 *  Retries a TRANSIENT failure once; a symlink refusal (ELOOP from
 *  writeFileNoFollow) is NEVER retried or re-labelled (H3b invariant); a
 *  persistent transient failure rejects with an honest kept-file error. */
export class GgufSidecarWriteError extends Error {
  constructor(options?: { cause?: unknown }) {
    // I-16: honest about the COST, no path (presence is sidecar-only; a
    // re-download renames OVER the kept file and retries the record).
    super(
      'The model file was downloaded and verified, but not recorded — Setup will show it as absent; downloading again replaces the file and retries the record.',
      options,
    );
    this.name = 'GgufSidecarWriteError';
  }
}

function isEloopRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ELOOP';
}

export function makeSidecarWriter(
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>,
): (sidecarPath: string, content: string) => Promise<void> {
  return async (sidecarPath, content) => {
    const bytes = Buffer.from(content, 'utf8');
    try {
      await writeFile(sidecarPath, bytes);
    } catch (first) {
      if (isEloopRefusal(first)) throw first; // refusal: never retried, never re-labelled (H3b)
      try {
        await writeFile(sidecarPath, bytes); // ONE retry for a transient failure
      } catch (second) {
        if (isEloopRefusal(second)) throw second; // a refusal on the retry is still a refusal
        throw new GgufSidecarWriteError({ cause: second });
      }
    }
  };
}
