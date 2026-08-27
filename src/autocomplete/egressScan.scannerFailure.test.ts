import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// CA-06 R2: a scanner ERROR is a BLOCK (fail-closed). The frozen scanner is
// total in practice; this file proves the wrapper's contract by substituting
// a throwing module — production code is untouched (no DI seam added).
vi.mock('./context/secretScanner', () => ({
  scanSnippetForSecrets: () => {
    throw new Error('injected scanner failure');
  },
}));

import { scanFimEgressTexts, makeFimEgressGuard } from './egressScan';

describe('CA-06 fail-closed on scanner error', () => {
  it('a throwing scanner blocks egress', () => {
    expect(scanFimEgressTexts(['anything'])).toBe('block');
  });

  it('…including through a non-loopback guard', () => {
    expect(makeFimEgressGuard('https://remote.example')(['x'])).toBe('block');
  });

  it('…but the loopback guard still allows (it never consults the scanner)', () => {
    expect(makeFimEgressGuard('http://localhost:11434')(['x'])).toBe('allow');
  });
});
