import { describe, it, expect } from 'vitest';
import {
  isLoopbackFimEndpoint,
  makeFimEgressGuard,
  scanFimEgressTexts,
} from './egressScan';

/** AWS's own canonical docs-example access key id — a positive-test input for
 *  the frozen scanner's `aws-akia` detector, assembled by concatenation so
 *  repo-level secret scanners don't flag this test file. */
const AWS_EXAMPLE_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

describe('isLoopbackFimEndpoint — exact-host loopback classifier (CA-06, fail-TOWARD-scan)', () => {
  it.each([
    'http://localhost:11434',
    'HTTP://LOCALHOST:1', // WHATWG URL lowercases hostnames
    'http://127.0.0.1:8000',
    'http://127.0.0.2:9999', // 127.0.0.0/8 per the finding
    'http://127.255.255.255',
    'http://[::1]:8080',
    'https://localhost',
  ])('exempts genuine loopback: %s', (endpoint) => {
    expect(isLoopbackFimEndpoint(endpoint)).toBe(true);
  });

  it.each([
    // THE hole this classifier exists to close (rev-2 Opus fail-OPEN): a
    // substring/startsWith host check would exempt all three of these.
    'http://localhost.evil.com:11434',
    'http://127.0.0.1.evil.com',
    'not a url',
    '',
    'http://0.0.0.0:8000',
    'http://[::ffff:127.0.0.1]', // IPv6 alias — scans per the pinned spec
    'http://localhost./', // trailing dot is not the exact literal — fail-toward-scan
    'http://127.0.0.1@evil.com/', // userinfo trick — hostname is evil.com
    'https://codestral.mistral.ai',
    'http://128.0.0.1',
    'http://126.255.255.255',
  ])('MUST-scan (not loopback): %s', (endpoint) => {
    expect(isLoopbackFimEndpoint(endpoint)).toBe(false);
  });

  it('rejects an IPv4-shaped host with an out-of-range octet (fail-toward-scan)', () => {
    expect(isLoopbackFimEndpoint('http://127.0.0.999')).toBe(false);
  });
});

describe('scanFimEgressTexts — frozen-scanner verdict over the exact egressing strings', () => {
  it('allows benign code', () => {
    expect(scanFimEgressTexts(['const x = 1;\n', 'return x;\n'])).toBe('allow');
  });

  it('blocks when ANY text carries a provider-pattern secret', () => {
    expect(scanFimEgressTexts(['const key = "' + AWS_EXAMPLE_KEY + '";', 'clean'])).toBe('block');
    expect(scanFimEgressTexts(['clean', '-----BEGIN PRIVATE KEY-----'])).toBe('block');
  });

  it('blocks oversize content (the frozen scanner MAX_SCAN_CONTENT bound is a BLOCK here — fail-closed)', () => {
    expect(scanFimEgressTexts(['x'.repeat(17_000)])).toBe('block');
  });
});

describe('makeFimEgressGuard — classify once per build', () => {
  it('a loopback guard NEVER scans: it allows even a text the scanner would block (zero scan work on the default path)', () => {
    const guard = makeFimEgressGuard('http://127.0.0.1:11434');
    expect(guard(['-----BEGIN PRIVATE KEY-----'])).toBe('allow');
  });

  it('a non-loopback guard scans and blocks a secret', () => {
    const guard = makeFimEgressGuard('https://gpu.corp.example:8000');
    expect(guard(['api_key = "' + AWS_EXAMPLE_KEY + '"'])).toBe('block');
    expect(guard(['const x = 1;'])).toBe('allow');
  });

  it('an unparseable endpoint yields a SCANNING guard (fail-toward-scan)', () => {
    const guard = makeFimEgressGuard('not a url');
    expect(guard(['-----BEGIN PRIVATE KEY-----'])).toBe('block');
  });
});
