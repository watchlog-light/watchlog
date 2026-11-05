// SPDX-License-Identifier: AGPL-3.0-only
// Test-only Remote-Write encoder (the agent's Go encoder is the production one).
import { compressSync } from 'snappy';

export interface TestSeries {
  labels: Record<string, string>;
  value: number;
  timestampMs: number;
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

function bytesField(field: number, data: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(data.length), ...data];
}

const enc = new TextEncoder();

export function marshal(series: TestSeries[]): Uint8Array {
  const out: number[] = [];
  for (const s of series) {
    const ts: number[] = [];
    const names = Object.keys(s.labels).sort((a, b) =>
      a === '__name__' ? -1 : b === '__name__' ? 1 : a.localeCompare(b),
    );
    for (const name of names) {
      const label = [
        ...bytesField(1, enc.encode(name)),
        ...bytesField(2, enc.encode(s.labels[name]!)),
      ];
      ts.push(...bytesField(1, Uint8Array.from(label)));
    }
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, s.value, true);
    const sample = [0x09, ...value, ...varint((2 << 3) | 0), ...varint(s.timestampMs)];
    ts.push(...bytesField(2, Uint8Array.from(sample)));
    out.push(...bytesField(1, Uint8Array.from(ts)));
  }
  return Uint8Array.from(out);
}

export function encode(series: TestSeries[]): Buffer {
  return compressSync(Buffer.from(marshal(series)));
}
