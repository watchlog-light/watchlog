// SPDX-License-Identifier: AGPL-3.0-only
// What changed's story and live map (0.14.0, ADR-231), on generated rows and an injected
// clock: episodes, the linked change and its window, the chain's order and edges ("no calls
// between them"), the story's clauses for a change, a scheduled run and no clear cause,
// "changed around then", the live states and the own-parts flag.
import { describe, expect, it } from 'vitest';
import {
  chainOf,
  changeCause,
  changesAround,
  episodesOf,
  factorOf,
  linkedChange,
  pickEpisode,
  storyOf,
  whoOf,
  type Change,
  type Related,
  type StoryRow,
} from '../src/modules/causes/story.js';
import { isOwnPod, isOwnSeries, stateOf } from '../src/modules/anomaly/live.js';
import { markerTarget, relatedBy } from '../src/modules/anomaly/story-read.js';

const T0 = Date.UTC(2026, 10, 22, 14, 31);
const MIN = 60_000;
const backend = {
  kind: 'workload' as const,
  name: 'backend',
  namespace: 'shop',
  workloadKind: 'Deployment',
};
const postgres = {
  kind: 'workload' as const,
  name: 'postgres',
  namespace: 'shop',
  workloadKind: 'StatefulSet',
};
const api = {
  kind: 'workload' as const,
  name: 'api',
  namespace: 'shop',
  workloadKind: 'Deployment',
};
const row = (
  id: string,
  object: StoryRow['object'],
  since: number,
  over: Partial<StoryRow> = {},
): StoryRow => ({
  id,
  since,
  until: since + 30 * MIN,
  key: 'workload.cpu',
  object,
  peer: null,
  value: 410,
  usualLow: 12,
  usualHigh: 30,
  peakScore: 9,
  ...over,
});
// backend calls postgres; api calls backend (the board's story).
const calls: [string, string][] = [
  ['backend', 'postgres'],
  ['api', 'backend'],
];
const related: Related = (a, b) =>
  calls.some(([x, y]) => (a.name === x && b.name === y) || (a.name === y && b.name === x));
const none: Related = () => false;

describe('episodes', () => {
  it('merge periods that overlap or are less than 5 minutes apart; ongoing ones stay open', () => {
    const now = T0 + 120 * MIN;
    const eps = episodesOf(
      [
        { id: 'a', since: T0, until: T0 + 20 * MIN },
        { id: 'b', since: T0 + 22 * MIN, until: T0 + 40 * MIN }, // 2 min gap: same
        { id: 'c', since: T0 + 60 * MIN, until: T0 + 70 * MIN }, // 20 min gap: new
        { id: 'd', since: T0 + 90 * MIN, until: null },
      ],
      now,
    );
    expect(eps).toEqual([
      { from: T0, to: T0 + 40 * MIN, rowIds: ['a', 'b'] },
      { from: T0 + 60 * MIN, to: T0 + 70 * MIN, rowIds: ['c'] },
      { from: T0 + 90 * MIN, to: null, rowIds: ['d'] },
    ]);
  });

  it('the switcher: the newest by default, or the one asked for', () => {
    const eps = episodesOf(
      [
        { id: 'a', since: T0, until: T0 + MIN },
        { id: 'b', since: T0 + 60 * MIN, until: T0 + 61 * MIN },
      ],
      T0 + 90 * MIN,
    );
    expect(pickEpisode(eps)).toBe(1);
    expect(pickEpisode(eps, T0)).toBe(0);
    expect(pickEpisode(eps, T0 + 5)).toBe(1); // unknown: the newest
    expect(pickEpisode([], T0)).toBe(-1);
  });
});

describe('the linked change', () => {
  const first = row('a', backend, T0 + 2 * MIN);
  const rollout: Change = {
    at: T0,
    kind: 'rollout',
    name: 'backend',
    namespace: 'shop',
    facts: { from: '2.14.0', to: '2.15.0' },
  };
  it('the first series’ own rollout 2 minutes before', () => {
    expect(linkedChange(first, [rollout], none)).toBe(rollout);
  });
  it('not one more than 15 minutes before, nor after the first move', () => {
    expect(linkedChange(first, [{ ...rollout, at: T0 - 20 * MIN }], none)).toBeNull();
    expect(linkedChange(first, [{ ...rollout, at: T0 + 3 * MIN }], none)).toBeNull();
  });
  it('a change elsewhere links only through calls or a shared server', () => {
    const other: Change = { ...rollout, name: 'frontend' };
    expect(linkedChange(first, [other], none)).toBeNull();
    const pg: Change = { ...rollout, name: 'postgres' };
    expect(linkedChange(first, [pg], related)).toBe(pg);
  });
  it('a scheduled run on the server of the first series (the fleet board)', () => {
    const disk = row('d', { kind: 'host', name: 'db-1' }, T0 + 2 * MIN);
    const pgOnDb = row(
      'p',
      { kind: 'workload', name: 'postgres', workloadKind: 'Service', host: 'db-1' },
      T0 + 4 * MIN,
    );
    const backup: Change = {
      at: T0,
      kind: 'job_run',
      name: 'backup.timer',
      host: 'worker-1',
      facts: { jobKind: 'timer' },
    };
    // worker-1 isn't db-1; the backup reads from postgres on db-1 (calls on the map).
    const rel: Related = (a, b) =>
      (a.name === 'db-1' && b.name === 'backup.timer') ||
      (a.name === 'backup.timer' && b.name === 'db-1');
    expect(linkedChange(disk, [backup], rel)).toBe(backup);
    expect(linkedChange(pgOnDb, [{ ...backup, host: 'db-1' }], none)).not.toBeNull();
  });
});

describe('the chain', () => {
  const rows = [
    row('pg', postgres, T0 + 10 * MIN, { value: 84, usualLow: 18, usualHigh: 25 }),
    row('be', backend, T0 + 2 * MIN),
    row('api', api, T0 + 31 * MIN, { value: 4.1, usualLow: 0.05, usualHigh: 0.2 }),
  ];
  const change: Change = { at: T0, kind: 'rollout', name: 'backend', namespace: 'shop', facts: {} };

  it('the change, then each series by first move, with the minutes between and the calls', () => {
    const c = chainOf(rows, change, related);
    expect(c.nodes.map((n) => [n.kind, n.who, n.gapMin, n.linked])).toEqual([
      ['change', 'backend', null, false],
      ['first', 'shop/backend', 2, true],
      ['then', 'shop/postgres', 8, true],
      ['then', 'shop/api', 21, false], // api calls backend, not postgres
    ]);
    expect(c.linked).toBe(true);
    expect(c.more).toBe(0);
  });

  it('no calls between them: no arrows', () => {
    const c = chainOf(rows, null, none);
    expect(c.linked).toBe(false);
    expect(c.nodes.every((n) => !n.linked)).toBe(true);
  });

  it('at most 6 boxes, the rest "and N more"', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      row(`r${i}`, { ...api, name: `svc-${i}` }, T0 + i * MIN),
    );
    const c = chainOf(many, change, none);
    expect(c.nodes).toHaveLength(6);
    expect(c.more).toBe(4);
  });
});

describe('the story', () => {
  const rows = [
    row('be', backend, T0 + 2 * MIN),
    row('pg', postgres, T0 + 10 * MIN, { value: 84, usualLow: 18, usualHigh: 25 }),
    row('api', api, T0 + 31 * MIN, { value: 4.1, usualLow: 0.05, usualHigh: 0.2 }),
  ];
  const change: Change = {
    at: T0,
    kind: 'rollout',
    name: 'backend',
    namespace: 'shop',
    facts: { from: '2.14.0', to: '2.15.0' },
  };

  it('after a rollout: the first, then the next along the calls, and the last at the same time', () => {
    const s = storyOf(rows, change, chainOf(rows, change, related));
    expect(s.map((c) => c.code)).toEqual(['after_change', 'then', 'same_time']);
    expect(s[0]!.facts).toMatchObject({
      who: 'shop/backend',
      x: 14,
      dir: 'up',
      gap: 2,
      change: 'rollout',
      target: 'backend',
      to: '2.15.0',
    });
    expect(s[2]!.facts).toMatchObject({ who: 'shop/api', and: 1 });
  });

  it('no clear cause: the first moved first; more than three: "and N more"', () => {
    const more = [...rows, row('x', { ...api, name: 'cart' }, T0 + 40 * MIN)];
    const s = storyOf(more, null, chainOf(more, null, related));
    expect(s.map((c) => c.code)).toEqual(['first', 'then', 'same_time', 'more']);
    expect(s[3]!.facts).toEqual({ n: 1 });
    expect(changeCause(rows[0], null)).toBeNull();
  });

  it('every kind of change words its cause box', () => {
    for (const kind of [
      'rollout',
      'image',
      'scale',
      'compose',
      'recreate',
      'node',
      'service_start',
      'service_restart',
      'service_failed',
      'unit_changed',
      'release',
      'job_run',
    ] as const) {
      const c = changeCause(rows[0], { at: T0, kind, name: 'x', facts: {} });
      expect(c).toMatchObject({
        code: 'change',
        facts: { change: kind, gap: 2, who: 'shop/backend' },
      });
    }
  });

  it('a drop reads as ÷, a rise as ×, against the band’s edge', () => {
    expect(factorOf({ value: 410, usualLow: 12, usualHigh: 30 })).toEqual({ x: 14, dir: 'up' });
    expect(factorOf({ value: 10, usualLow: 15, usualHigh: 30 })).toEqual({ x: 1.5, dir: 'down' });
    expect(factorOf({ value: 0, usualLow: 15, usualHigh: 30 })).toEqual({ x: 999, dir: 'down' });
  });

  it('names things in the platform’s words', () => {
    expect(whoOf(backend)).toBe('shop/backend');
    expect(
      whoOf({ kind: 'workload', name: 'postgres', workloadKind: 'Service', host: 'db-1' }),
    ).toBe('postgres · db-1');
    expect(
      whoOf({ kind: 'container', name: 'shop-api-1', composeService: 'api', host: 'app-1' }),
    ).toBe('api · app-1');
    expect(whoOf({ kind: 'host', name: 'db-1' })).toBe('db-1');
  });
});

describe('changed around then', () => {
  it('from 30 minutes before the episode to 5 after it, oldest first', () => {
    const ep = { from: T0, to: T0 + 60 * MIN, rowIds: [] };
    const c = (m: number, name: string): Change => ({
      at: T0 + m * MIN,
      kind: 'scale',
      name,
      facts: {},
    });
    const got = changesAround(
      [
        c(64, 'in-after'),
        c(-45, 'too-early'),
        c(-29, 'in-before'),
        c(20, 'during'),
        c(70, 'too-late'),
      ],
      ep,
      T0 + 120 * MIN,
    );
    expect(got.map((x) => x.name)).toEqual(['in-before', 'during', 'in-after']);
  });
});

describe('the live map', () => {
  it('thresholds on the worker’s score: inside in three shades, near the edge, outside', () => {
    expect([0.5, 1, 1.9].map((score) => stateOf({ score, open: false }))).toEqual([
      { state: 'inside', shade: 0 },
      { state: 'inside', shade: 1 },
      { state: 'inside', shade: 2 },
    ]);
    // Past the band without an open period: near (within a quarter, or not 10 minutes yet).
    expect(stateOf({ score: 2.5, open: false }).state).toBe('near');
    expect(stateOf({ score: 7, open: false }).state).toBe('near');
    // An open period is outside, even on a minute back inside.
    expect(stateOf({ score: 1, open: true }).state).toBe('outside');
    expect(stateOf({ score: null, open: false }).state).toBe('inside');
  });

  it('WatchLog’s own parts: its charts’ pods, its images’ containers, its agent’s units', () => {
    expect(isOwnPod({ 'app.kubernetes.io/name': 'watchlog' })).toBe(true);
    expect(isOwnPod({ 'helm.sh/chart': 'watchlog-agent-0.2.0' })).toBe(true);
    expect(isOwnPod({ 'app.kubernetes.io/name': 'shop' })).toBe(false);
    const own = {
      workloads: new Set(['watchlog/watchlog-backend']),
      containers: new Set(['watchlog-web-1']),
    };
    expect(isOwnSeries({ namespace: 'watchlog', workload: 'watchlog-backend' }, own)).toBe(true);
    expect(isOwnSeries({ namespace: 'shop', workload: 'backend' }, own)).toBe(false);
    expect(isOwnSeries({ container: 'watchlog-web-1', host: 'app-1' }, own)).toBe(true);
    expect(isOwnSeries({ unit: 'watchlog-agent.service', host: 'db-1' }, own)).toBe(true);
    expect(isOwnSeries({ group: 'watchlog-agent', host: 'db-1' }, own)).toBe(true);
    expect(isOwnSeries({ unit: 'postgresql.service', host: 'db-1' }, own)).toBe(false);
  });
});

describe('the reads’ pure parts', () => {
  it('reads marker targets', () => {
    expect(markerTarget('Deployment/shop/api')).toEqual({
      kind: 'Deployment',
      namespace: 'shop',
      name: 'api',
    });
    expect(markerTarget('Container/app-1/shop-api-1')).toEqual({
      kind: 'Container',
      host: 'app-1',
      name: 'shop-api-1',
    });
    expect(markerTarget('Node/k3d-0')).toEqual({ kind: 'Node', name: 'k3d-0' });
  });

  it('related: calls on the map either way, a shared server, a shared node', () => {
    const map = {
      nodes: [
        { id: 'w:shop/Deployment/backend', name: 'backend', namespace: 'shop' },
        { id: 'w:shop/StatefulSet/postgres', name: 'postgres', namespace: 'shop' },
      ],
      edges: [{ source: 'w:shop/Deployment/backend', target: 'w:shop/StatefulSet/postgres' }],
    };
    const nodes = new Map([
      ['shop/api', new Set(['n1'])],
      ['shop/cart', new Set(['n1'])],
    ]);
    const r = relatedBy('kubernetes', map, nodes);
    expect(r(postgres, backend)).toBe(true);
    expect(r(api, { ...api, name: 'cart' })).toBe(true); // same node
    expect(r(api, postgres)).toBe(false);
    const s = relatedBy('server', null, new Map());
    expect(
      s({ kind: 'host', name: 'db-1' }, { kind: 'workload', name: 'postgres', host: 'db-1' }),
    ).toBe(true);
    expect(
      s(
        { kind: 'workload', name: 'api', host: 'app-1' },
        { kind: 'workload', name: 'postgres', host: 'db-1' },
      ),
    ).toBe(false);
  });
});
