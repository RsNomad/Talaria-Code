import { describe, it, expect } from 'vitest';
import { createStdoutByteCapTransform } from './stdoutByteCap';

const MIB = 1024 * 1024;

function collect(transform: ReturnType<typeof createStdoutByteCapTransform>): () => Buffer {
  const chunks: Buffer[] = [];
  transform.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks);
}

describe('createStdoutByteCapTransform (WS-AC CA-01)', () => {
  it('passes newline-framed chunks through byte-identical, across straddled boundaries', () => {
    const t = createStdoutByteCapTransform(4 * MIB, () => {
      throw new Error('must not trip');
    });
    const out = collect(t);
    t.write(Buffer.from('{"a":1}\n{"b"'));
    t.write(Buffer.from(':2}\n'));
    t.end();
    expect(out().toString('utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('the counter resets at every newline — many large TERMINATED frames never trip', () => {
    let tripped = 0;
    const t = createStdoutByteCapTransform(4 * MIB, () => {
      tripped++;
    });
    const out = collect(t);
    for (let i = 0; i < 3; i++) t.write(Buffer.concat([Buffer.alloc(3 * MIB, 0x78), Buffer.from('\n')]));
    t.end();
    expect(tripped).toBe(0);
    expect(out().length).toBe(3 * (3 * MIB + 1));
  });

  it('a single unterminated line over the cap trips ONCE and forwards nothing after the trip', () => {
    const trips: number[] = [];
    const t = createStdoutByteCapTransform(4 * MIB, (n) => trips.push(n));
    const out = collect(t);
    const chunk = Buffer.alloc(64 * 1024, 0x78); // 64 KiB, no newline
    const before = 64; // 64 × 64 KiB = 4 MiB exactly — not yet over
    for (let i = 0; i < before; i++) t.write(chunk);
    expect(trips).toEqual([]);
    t.write(chunk); // 4 MiB + 64 KiB — over
    expect(trips).toEqual([4 * MIB + 64 * 1024]);
    const lenAtTrip = out().length;
    t.write(chunk); // post-trip data must be dropped, no second callback
    t.end();
    expect(trips.length).toBe(1);
    expect(out().length).toBe(lenAtTrip);
  });
});
