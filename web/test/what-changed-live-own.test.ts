// SPDX-License-Identifier: AGPL-3.0-only
// A watched own metric on What changed's live map (1.0.1; ADR-238): the answer the backend
// gives for one (test/fixtures/what-changed-live-own.json, which the backend's worker test
// holds its real answer against) lands in its workload's or its server's group like every
// other series there, and is named in the metric's own words. If the backend changes the key
// or the object's shape, its test fails on the fixture; if the fixture changes, this one says
// whether the map still places and names it.
import { describe, expect, it } from 'vitest';
import { liveMap, type LiveSeries } from '@/lib/what-changed-live';
import { metricText } from '@/lib/what-changed';
import fixture from './fixtures/what-changed-live-own.json';

const tr = (key: string) => key;
const cell = (
  id: string,
  part: Pick<LiveSeries, 'key' | 'unit' | 'object' | 'peer'>,
  state: LiveSeries['state'] = 'outside',
): LiveSeries => ({
  id,
  ...part,
  value: 400,
  usualLow: 30,
  usualHigh: 52,
  score: 30,
  state,
  shade: 1,
  own: false,
});

describe('a watched own metric on the live map', () => {
  it('Kubernetes: one more square of its workload, next to the workload’s own series', () => {
    const own = cell('a1', fixture.kubernetes as never);
    const cpu = cell(
      'b2',
      {
        key: 'workload.cpu.usage',
        unit: 'cores',
        object: { kind: 'workload', name: 'worker', namespace: 'shop', workloadKind: 'Deployment' },
        peer: null,
      } as never,
      'inside',
    );
    const other = cell(
      'c3',
      {
        key: 'workload.cpu.usage',
        unit: 'cores',
        object: {
          kind: 'workload',
          name: 'postgres',
          namespace: 'shop',
          workloadKind: 'StatefulSet',
        },
        peer: null,
      } as never,
      'inside',
    );
    const map = liveMap([cpu, other, own], 'kubernetes', true);
    // Its group is the workload's, first because something in it is outside its range.
    expect(map.groups.map((g) => [g.key, g.cells.map((c) => c.id)])).toEqual([
      ['shop/worker', ['a1', 'b2']],
      ['shop/postgres', ['c3']],
    ]);
    expect(map.groups[0]).toMatchObject({ outside: 1, host: '' });
    // It is the user's metric, not one of WatchLog's own parts: hiding those keeps it.
    expect(map.own).toBe(0);
    expect(map.total).toBe(3);
    expect(metricText(own, tr)).toBe('queue jobs waiting');
  });

  it('a Server fleet: a square of its server, before the server’s services', () => {
    const own = cell('a1', fixture.server as never);
    const service = cell(
      'b2',
      {
        key: 'workload.memory.rss',
        unit: 'bytes',
        object: { kind: 'workload', name: 'postgres', workloadKind: 'Service', host: 'db-1' },
        peer: null,
      } as never,
      'inside',
    );
    const map = liveMap([service, own], 'server', true);
    expect(map.groups.map((g) => [g.key, g.host, g.cells.map((c) => c.id)])).toEqual([
      ['db-1', 'db-1', ['a1']],
      ['postgres · db-1', 'db-1', ['b2']],
    ]);
    expect(metricText(own, tr)).toBe('queue jobs waiting');
  });

  it('the key is the one the page’s words are read from: "own:<unit>:<name>"', () => {
    for (const part of [fixture.kubernetes, fixture.server]) {
      expect(part.key).toMatch(/^own:[a-z_]+:[a-zA-Z_:][a-zA-Z0-9_:]*$/);
      expect(part.key.split(':')[1]).toBe(part.unit);
    }
  });
});
