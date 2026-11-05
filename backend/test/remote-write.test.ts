// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { compressSync, uncompressSync } from 'snappy';
import { describe, expect, it } from 'vitest';
import {
  inspectWriteRequest,
  RemoteWriteError,
  snappyDeclaredLength,
} from '../src/modules/ingest/remote-write.js';
import { encode, marshal } from './support/remote-write.js';

const LIMITS = { maxDecodedBytes: 32 << 20, maxSeries: 20_000 };
// Produced by the agent's Go encoder (agent/internal/remotewrite, ADR-021).
const golden = readFileSync(
  new URL('../../agent/internal/remotewrite/testdata/write-request.snappy', import.meta.url),
);
const goldenDescription = JSON.parse(
  readFileSync(
    new URL('../../agent/internal/remotewrite/testdata/write-request.json', import.meta.url),
    'utf8',
  ),
) as unknown[];

function rejects(body: Uint8Array, status: number, message: RegExp) {
  try {
    inspectWriteRequest(body, LIMITS);
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteWriteError);
    expect((err as RemoteWriteError).status).toBe(status);
    expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected a RemoteWriteError');
}

describe('inspectWriteRequest', () => {
  it('reads the Go agent golden fixture', () => {
    const summary = inspectWriteRequest(golden, LIMITS);
    expect(summary.series).toBe(goldenDescription.length);
    expect(summary.samples).toBe(goldenDescription.length);
  });

  it('counts series and samples of a valid request', () => {
    const body = encode([
      { labels: { __name__: 'a', host: 'h' }, value: 1, timestampMs: 1 },
      { labels: { __name__: 'b' }, value: 2, timestampMs: 2 },
    ]);
    expect(inspectWriteRequest(body, LIMITS)).toMatchObject({ series: 2, samples: 2 });
  });

  it.each(['cluster_id', 'tenant_id'])('rejects the reserved label %s', (label) => {
    const body = encode([
      { labels: { __name__: 'a', [label]: 'spoofed' }, value: 1, timestampMs: 1 },
    ]);
    rejects(body, 400, /reserved/);
  });

  it('rejects too many series with 413', () => {
    const series = Array.from({ length: 21 }, (_, i) => ({
      labels: { __name__: `m${i}` },
      value: i,
      timestampMs: 1,
    }));
    try {
      inspectWriteRequest(encode(series), { ...LIMITS, maxSeries: 20 });
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as RemoteWriteError).status).toBe(413);
    }
  });

  it('rejects a body whose declared decoded size is too large, before decompressing', () => {
    // Snappy block header claiming 64 MiB followed by garbage.
    const header = [0x80, 0x80, 0x80, 0x20];
    const body = Uint8Array.from([...header, 1, 2, 3]);
    expect(snappyDeclaredLength(body)).toBe(64 << 20);
    rejects(body, 413, /decoded body/);
  });

  it('rejects malformed input with 400', () => {
    rejects(new Uint8Array(), 400, /empty/);
    rejects(Uint8Array.from([0x05, 1, 2, 3]), 400, /snappy/);
    rejects(compressSync(Buffer.from([0x0a, 0x05, 0x01])), 400, /truncated/);
    // Series without __name__.
    rejects(encode([{ labels: { host: 'h' }, value: 1, timestampMs: 1 }]), 400, /__name__/);
  });

  it('never throws anything but RemoteWriteError on random input', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const raw = Uint8Array.from({ length: Math.floor(rand() * 64) }, () =>
        Math.floor(rand() * 256),
      );
      for (const body of [raw, compressSync(Buffer.from(raw))]) {
        try {
          inspectWriteRequest(body, LIMITS);
        } catch (err) {
          expect(err).toBeInstanceOf(RemoteWriteError);
        }
      }
    }
  });

  it('test encoder matches the Go encoder byte for byte', () => {
    const fromTs = marshal([
      {
        labels: { __name__: 'watchlog_node_load1', host: 'web-01' },
        value: 0.26,
        timestampMs: 1793404800000,
      },
    ]);
    const goldenRaw = uncompressSync(golden) as Buffer;
    expect(goldenRaw.subarray(0, fromTs.length).equals(Buffer.from(fromTs))).toBe(true);
  });
});
