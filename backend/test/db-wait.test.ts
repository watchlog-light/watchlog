// SPDX-License-Identifier: AGPL-3.0-only
// ADR-118: processes wait for PostgreSQL on a fresh install instead of crash-looping.
import { describe, expect, it } from 'vitest';
import { waitForDatabase } from '../src/db/index.js';

const fail = (code: string) => Object.assign(new Error(code), { code });

function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe('waitForDatabase', () => {
  it('retries while PostgreSQL starts and the migrations run, then succeeds', async () => {
    const c = clock();
    const errors = ['EAI_AGAIN', 'ECONNREFUSED', '57P03', '42P01', '42P01'];
    const logs: string[] = [];
    const got = await waitForDatabase(
      async () => {
        const e = errors.shift();
        if (e) throw fail(e);
        return 'ok';
      },
      { ...c, log: (m) => logs.push(m) },
    );
    expect(got).toBe('ok');
    expect(c.slept).toEqual([1000, 2000, 4000, 8000, 10000]); // backoff, capped at 10 s
    // Logged once, then every 30 s at most: 25 s of retries here is one line.
    expect(logs).toEqual(['waiting for database (not accepting connections yet); retrying']);
  });

  it('fails at once on a misconfiguration (wrong password, missing database)', async () => {
    const c = clock();
    for (const code of ['28P01', '3D000']) {
      await expect(waitForDatabase(async () => Promise.reject(fail(code)), c)).rejects.toThrow(
        code,
      );
    }
    expect(c.slept).toEqual([]);
  });

  it('gives up after the timeout with the last error', async () => {
    const c = clock();
    await expect(
      waitForDatabase(async () => Promise.reject(fail('ECONNREFUSED')), {
        ...c,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(c.now()).toBeGreaterThanOrEqual(30_000);
  });
});
