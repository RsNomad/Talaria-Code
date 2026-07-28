import { describe, it, expect } from 'vitest';
import { isHttpUrl } from './url';

describe('isHttpUrl', () => {
  it('accepts loopback http/https URLs', () => {
    expect(isHttpUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isHttpUrl('https://localhost:8080/v1')).toBe(true);
  });

  it('accepts REMOTE http/https URLs (the runner is legitimately remote — no host filtering)', () => {
    expect(isHttpUrl('https://runner.internal.example.com:8000')).toBe(true);
    expect(isHttpUrl('http://10.1.2.3:8000')).toBe(true);
    expect(isHttpUrl('https://codestral.mistral.ai')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('data:text/plain,hi')).toBe(false);
    expect(isHttpUrl('ftp://host/x')).toBe(false);
  });

  it('rejects garbage / non-URLs', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('127.0.0.1:11434')).toBe(false); // no scheme
  });
});
