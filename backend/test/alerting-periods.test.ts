// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alertingGaps, recordCycle } from '../src/modules/alerts/periods.js';
import type { AlertWorker } from '../src/modules/alerts/worker.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';
import { T0, testWorker } from './support/alerts.js';

let ctx: TestContext;
let worker: AlertWorker | undefined;
const clock = { now: T0 };
const min = 60_000;
const at = (m: number) => new Date(T0 + m * min);
const periods = () =>
  ctx.db
    .selectFrom('alerting_periods')
    .select(['started_at', 'ended_at'])
    .orderBy('started_at')
    .execute();

beforeEach(async () => {
  ctx = await createTestContext();
  clock.now = T0;
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await closeTestContext(ctx);
});

describe('when alerting ran (alert detail timeline)', () => {
  it('extends one period per run of the worker and starts another after a stop', async () => {
    worker = testWorker(ctx.db, clock, () => undefined);
    for (let i = 0; i < 4; i++) {
      await worker.runCycle();
      clock.now += 30_000;
    }
    await worker.stop();
    expect(await periods()).toEqual([{ started_at: at(0), ended_at: at(1.5) }]);

    // The worker was down from 1.5 min to 4 h 35 min (a laptop asleep, a crash).
    clock.now = +at(275);
    worker = testWorker(ctx.db, clock, () => undefined);
    await worker.runCycle();
    expect(await periods()).toHaveLength(2);
    expect(await alertingGaps(ctx.db, at(0), at(300), +at(276))).toEqual([
      { from: at(1.5), to: at(275) },
    ]);
  });

  it('merges cycles of two workers and says when alerting is still not running', async () => {
    await recordCycle(ctx.db, at(0));
    await recordCycle(ctx.db, at(1));
    await recordCycle(ctx.db, at(0.5)); // a second worker, a little behind
    await recordCycle(ctx.db, at(2.5));
    expect(await periods()).toEqual([{ started_at: at(0), ended_at: at(2.5) }]);
    // 30 minutes later nothing ran since 2.5 min: an open gap.
    expect(await alertingGaps(ctx.db, at(0), at(30), +at(30))).toEqual([
      { from: at(2.5), to: null },
    ]);
    // A short pause (under 2 min) is not a gap.
    expect(await alertingGaps(ctx.db, at(0), at(3), +at(3))).toEqual([]);
  });

  it('claims nothing before the first recorded period and only gaps that overlap', async () => {
    await recordCycle(ctx.db, at(60));
    await recordCycle(ctx.db, at(61));
    await recordCycle(ctx.db, at(120));
    expect(await alertingGaps(ctx.db, at(0), at(59), +at(121))).toEqual([]);
    expect(await alertingGaps(ctx.db, at(0), at(90), +at(121))).toEqual([
      { from: at(61), to: at(120) },
    ]);
    // A window entirely inside the gap still shows it.
    expect(await alertingGaps(ctx.db, at(70), at(80), +at(121))).toEqual([
      { from: at(61), to: at(120) },
    ]);
  });
});
