// SPDX-License-Identifier: AGPL-3.0-only
// The database pages' rules of 1.2 (ADR-245) without a server: "far slower than usual", the
// blocking tree's order, the tables a statement names, the missing-index hint, the period
// the Waits tab looks at, and the clients' names.
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  clientOf,
  dominantWait,
  missingIndex,
  MY,
  periodOf,
  PG,
  slowerOf,
  tablesIn,
  type TreeSession,
} from '../src/modules/integrations/pages/db-deep.js';
import type { PageContext } from '../src/modules/integrations/pages/types.js';

describe('slowerOf', () => {
  it('flags a statement 3× slower with no rise in calls', () => {
    // 60 ms against 10 ms, 1 call a second now and before: 6×.
    expect(slowerOf(0.06, 0.01, 1, 1)).toBeCloseTo(6, 5);
  });
  it('says nothing when it is load, small, rare or new', () => {
    expect(slowerOf(0.06, 0.01, 2, 1)).toBeNull(); // calls doubled: load, not a regression
    expect(slowerOf(0.003, 0.001, 1, 1)).toBeNull(); // 3× but only 2 ms slower
    expect(slowerOf(0.06, 0.01, 0.01, 0.01)).toBeNull(); // 9 calls in 15 minutes
    expect(slowerOf(0.06, null, 1, 0)).toBeNull(); // no usual yet
    expect(slowerOf(0.02, 0.01, 1, 1)).toBeNull(); // 2×
  });
});

describe('buildTree', () => {
  const s = (id: string, blockedBy: string[], seconds = 10): TreeSession => ({
    id,
    blockedBy,
    addr: `10.0.0.${id}`,
    app: '',
    state: blockedBy.length ? 'active' : 'idle in transaction',
    wait: '',
    seconds,
    xact: 100,
    query: null,
  });
  it('puts the root blocker first and each blocked session under its blocker', () => {
    const tree = buildTree([s('3', ['2'], 5), s('2', ['1'], 30), s('1', []), s('4', ['1'], 60)]);
    expect(tree.map((x) => [x.s.id, x.depth])).toEqual([
      ['1', 0],
      ['4', 1],
      ['2', 1],
      ['3', 2],
    ]);
  });
  it('shows a cycle with no root, and a session blocked by two once', () => {
    const tree = buildTree([s('1', ['2']), s('2', ['1']), s('3', ['1', '2'])]);
    expect(tree.map((x) => x.s.id).sort()).toEqual(['1', '2', '3']);
  });
  it('leaves out sessions that block nobody and wait on nobody', () => {
    expect(buildTree([s('1', [])])).toEqual([]);
  });
});

describe('tablesIn', () => {
  it('reads the tables a normalised statement names', () => {
    expect(tablesIn('select count(*) from shop.events where created_at > $1')).toEqual([
      'shop.events',
    ]);
    expect(tablesIn('UPDATE `stock` SET `qty` = `qty` - ? WHERE `sku` = ?')).toEqual(['stock']);
    expect(tablesIn('select * from orders o join order_items i on i.order_id = o.id')).toEqual([
      'orders',
      'order_items',
    ]);
    expect(tablesIn('INSERT INTO a.b (x) SELECT x FROM generate_series($1, $2)')).toEqual(['a.b']);
  });
});

describe('missingIndex', () => {
  const scans = new Map([['events', 5_400_000]]);
  it('MySQL: no index and 100 rows examined or more for each one sent', () => {
    expect(
      missingIndex(
        MY,
        {
          id: 'd',
          text: 'SELECT COUNT ( * ) FROM EVENTS WHERE `created_at` > ?',
          examined: 5_400_000,
          sent: 27,
          noIndex: 27,
        },
        scans,
      ),
    ).toEqual({ table: 'events' });
    // Before the first catalog scan: the statement's table, never in the digest's capitals.
    expect(
      missingIndex(
        MY,
        { id: 'd', text: 'SELECT COUNT ( * ) FROM EVENTS', examined: 5_000, sent: 1, noIndex: 1 },
        new Map(),
      ),
    ).toEqual({ table: 'events' });
    expect(
      missingIndex(
        MY,
        { id: 'd', text: 'SELECT * FROM stock WHERE sku = ?', examined: 10, sent: 10, noIndex: 0 },
        scans,
      ),
    ).toBeNull();
  });
  it('PostgreSQL: 100 blocks or more per row returned, on a table read by full scans', () => {
    const pg = new Map([['shop.events', 3_800_000]]);
    expect(
      missingIndex(
        PG,
        {
          id: 'q',
          text: 'select count(*) from shop.events where created_at > now() - interval $1',
          blocks: 289_198,
          rows: 227,
        },
        pg,
      ),
    ).toEqual({
      table: 'shop.events',
    });
    // Reads a lot per row, but none of its tables is scanned in full: no guess.
    expect(
      missingIndex(
        PG,
        { id: 'q', text: 'select * from shop.orders', blocks: 100_000, rows: 10 },
        pg,
      ),
    ).toBeNull();
  });
});

describe('periodOf', () => {
  const ctx = (params?: Record<string, string>) =>
    ({ now: 1_800_000_000_000, range: 3600, params }) as unknown as PageContext;
  it('is the page range by default, the chosen period when one is given', () => {
    expect(periodOf(ctx())).toEqual({ end: 1_800_000_000, dur: 3600 });
    expect(periodOf(ctx({ from: '1799999000', to: '1799999600' }))).toEqual({
      end: 1_799_999_600,
      dur: 600,
    });
  });
  it('ignores a period in the future or backwards', () => {
    expect(periodOf(ctx({ from: '1800000000', to: '1700000000' }))).toEqual({
      end: 1_800_000_000,
      dur: 3600,
    });
    expect(periodOf(ctx({ from: '1800000000', to: '1900000000' }))).toEqual({
      end: 1_800_000_000,
      dur: 3600,
    });
  });
});

describe('dominantWait', () => {
  it('is the class with most of the time', () => {
    const by = { cpu: 0.5, io: 0.1, lock: 2.8, client: 0.4, other: 0.2 };
    expect(dominantWait({ by, total: 4 })).toEqual({ wait: 'lock', share: 0.7 });
    expect(
      dominantWait({ by: { cpu: 0, io: 0, lock: 0, client: 0, other: 0 }, total: 0 }),
    ).toBeNull();
  });
});

describe('clientOf', () => {
  const owners = new Map([
    [
      '10.0.0.5',
      { kind: 'workload' as const, name: 'shop/checkout', id: 'shop/Deployment/checkout' },
    ],
    ['172.18.0.4', { kind: 'container' as const, name: 'shop-report-1' }],
  ]);
  it('names a workload with its link, a container, an address, or the application', () => {
    expect(clientOf(owners, '10.0.0.5')).toEqual({
      name: 'shop/checkout',
      link: { kind: 'workload', id: 'shop/Deployment/checkout', name: 'shop/checkout' },
    });
    expect(clientOf(owners, '172.18.0.4')).toEqual({ name: 'shop-report-1' });
    expect(clientOf(owners, '10.9.9.9')).toEqual({ name: '10.9.9.9' });
    expect(clientOf(owners, '', 'psql')).toEqual({ name: 'psql' });
  });
});
