import { describe, it, expect } from 'vitest';

import { RingBuffer } from './ringBuffer';

describe('RingBuffer — pure line ring (headless, zero vscode)', () => {
  it('starts empty: tail(n) is "" for any n', () => {
    const rb = new RingBuffer(10);
    expect(rb.tail(5)).toBe('');
    expect(rb.tail(0)).toBe('');
  });

  it('tail(0) or negative is always "" even with data', () => {
    const rb = new RingBuffer(10);
    rb.push('a\nb\n');
    expect(rb.tail(0)).toBe('');
    expect(rb.tail(-1)).toBe('');
  });

  it('a single push with embedded newlines splits into lines', () => {
    const rb = new RingBuffer(10);
    rb.push('line1\nline2\nline3\n');
    expect(rb.tail(10)).toBe('line1\nline2\nline3');
  });

  it('a chunk with no trailing newline is kept as a pending partial line', () => {
    const rb = new RingBuffer(10);
    rb.push('partial');
    expect(rb.tail(10)).toBe('partial');
  });

  it('stitches a line split across two push() calls (execution.read() chunk boundaries are arbitrary)', () => {
    const rb = new RingBuffer(10);
    rb.push('hel');
    rb.push('lo world\n');
    expect(rb.tail(10)).toBe('hello world');
  });

  it('a completed pending line plus a new pending tail both surface correctly', () => {
    const rb = new RingBuffer(10);
    rb.push('foo\nbar');
    expect(rb.tail(10)).toBe('foo\nbar');
    rb.push('baz\nqux');
    expect(rb.tail(10)).toBe('foo\nbarbaz\nqux');
  });

  it('tail(maxLines) returns only the most recent N lines, oldest first among those kept', () => {
    const rb = new RingBuffer(10);
    rb.push('a\nb\nc\nd\ne\n');
    expect(rb.tail(2)).toBe('d\ne');
    expect(rb.tail(3)).toBe('c\nd\ne');
  });

  it('evicts the OLDEST completed line once capLines is exceeded (the ring behavior)', () => {
    const rb = new RingBuffer(3);
    rb.push('a\nb\nc\nd\ne\n');
    // Only the last 3 completed lines survive internally.
    expect(rb.tail(10)).toBe('c\nd\ne');
  });

  it('cap eviction happens incrementally across multiple push() calls, not just in one big chunk', () => {
    const rb = new RingBuffer(2);
    rb.push('a\n');
    rb.push('b\n');
    rb.push('c\n');
    expect(rb.tail(10)).toBe('b\nc');
  });

  it('a pending (no-newline) tail is never evicted by the completed-lines cap — it always surfaces in tail()', () => {
    const rb = new RingBuffer(1);
    rb.push('a\nb\nc\nunterminated');
    expect(rb.tail(10)).toBe('c\nunterminated');
  });

  it('tail(maxLines) larger than what has been captured returns everything captured', () => {
    const rb = new RingBuffer(100);
    rb.push('only\ntwo\n');
    expect(rb.tail(1000)).toBe('only\ntwo');
  });

  it('caps an un-terminated pending fragment at PENDING_MAX_CHARS, keeping only the trailing chars (unbounded \\r-only progress spam bounded)', () => {
    const rb = new RingBuffer(10);
    const chunk = 'x'.repeat(8_192 + 100);
    rb.push(chunk);
    const text = rb.tail(10);
    expect(text.length).toBe(8_192);
    expect(text).toBe(chunk.slice(-8_192));
  });
});
