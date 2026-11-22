// SPDX-License-Identifier: AGPL-3.0-only
// What changed after the learning week (0.14.0, ADR-231), in the page's words and shapes: the
// live map's grouping (workloads; servers with their services), its order and folding, the
// own-parts toggle; the story's sentence for each kind of change and for no clear cause; the
// episode label; the checks' order; the sparkline; the chart's bands and markers.
import type { WhatChangedClause, WhatChangedLive } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { createAppI18n } from '@/i18n';
import { checkedAgo, liveMap, MAP_GROUPS, MAP_GROUPS_PHONE } from '@/lib/what-changed-live';
import {
  changeCauseText,
  chartBands,
  chartMarkers,
  labelSpan,
  episodeLabel,
  factorText,
  foundChecks,
  orderedChecks,
  sortedMoved,
  sparkOf,
  storyText,
} from '@/lib/what-changed-story';

const i18n = createAppI18n();
const tr = (k: string, v?: Record<string, unknown>, n?: number) =>
  n === undefined ? i18n.global.t(k, v ?? {}) : i18n.global.t(k, v ?? {}, n);
type S = WhatChangedLive['series'][number];
const s = (id: string, object: S['object'], state: S['state'] = 'inside', own = false): S => ({
  id,
  key: 'workload.cpu.usage',
  unit: 'cores',
  object,
  peer: null,
  value: 1,
  usualLow: 0.1,
  usualHigh: 0.5,
  score: 1,
  state,
  shade: 1,
  own,
});
const wl = (ns: string, name: string) => ({ kind: 'workload' as const, namespace: ns, name });

describe('the live map', () => {
  it('Kubernetes: by workload, the ones with something outside first, then near the edge', () => {
    const m = liveMap(
      [
        s('1', wl('shop', 'frontend')),
        s('2', wl('shop', 'backend'), 'outside'),
        s('3', wl('shop', 'backend')),
        s('4', wl('shop', 'redis'), 'near'),
        s('5', { kind: 'node', name: 'k3d-0' }),
      ],
      'kubernetes',
      true,
    );
    expect(m.groups.map((g) => [g.name, g.outside, g.near, g.cells.length])).toEqual([
      ['shop/backend', 1, 0, 2],
      ['shop/redis', 0, 1, 1],
      ['k3d-0', 0, 0, 1],
      ['shop/frontend', 0, 0, 1],
    ]);
    // The outside square leads its group.
    expect(m.groups[0]!.cells[0]!.state).toBe('outside');
    expect(m.counts).toEqual({ inside: 3, near: 1, outside: 1 });
  });

  it('a Server fleet: by server, each server’s services right after it, in the fleet’s words', () => {
    const m = liveMap(
      [
        s('1', { kind: 'host', name: 'app-1' }),
        s(
          '2',
          { kind: 'workload', name: 'postgres', workloadKind: 'Service', host: 'db-1' },
          'outside',
        ),
        s('3', { kind: 'host', name: 'db-1' }),
        s('4', { kind: 'container', name: 'shop-api-1', composeService: 'api', host: 'app-1' }),
        s('5', { kind: 'workload', name: 'nginx', workloadKind: 'Service', host: 'app-1' }),
      ],
      'server',
      true,
    );
    expect(m.groups.map((g) => g.name)).toEqual([
      'db-1',
      'postgres · db-1',
      'app-1',
      'api · app-1',
      'nginx · app-1',
    ]);
  });

  it('WatchLog’s own parts: hidden by default and counted for the toggle; shown when off', () => {
    const series = [
      s('1', wl('shop', 'api')),
      s('2', wl('watchlog', 'watchlog-backend'), 'outside', true),
    ];
    const hidden = liveMap(series, 'kubernetes', true);
    expect(hidden.own).toBe(1);
    expect(hidden.total).toBe(1);
    expect(hidden.counts.outside).toBe(0);
    const shown = liveMap(series, 'kubernetes', false);
    expect(shown.groups[0]!.name).toBe('watchlog/watchlog-backend');
  });

  it('past 14 groups the rest fold with their squares', () => {
    const many = Array.from({ length: MAP_GROUPS + 4 }, (_, i) =>
      s(String(i), wl('shop', `svc-${String(i).padStart(2, '0')}`)),
    );
    const m = liveMap(many, 'kubernetes', true);
    expect(m.groups).toHaveLength(MAP_GROUPS);
    expect(m.folded).toEqual({ groups: 4, cells: expect.any(Array) });
    expect(m.folded!.cells).toHaveLength(4);
    // On a phone it folds after 6.
    const phone = liveMap(many, 'kubernetes', true, MAP_GROUPS_PHONE);
    expect(phone.groups).toHaveLength(6);
    expect(phone.folded!.groups).toBe(MAP_GROUPS + 4 - 6);
  });

  it('"checked 12 s ago" from the worker’s last minute', () => {
    expect(checkedAgo('2026-11-22T14:00:00Z', Date.parse('2026-11-22T14:00:12Z'))).toBe(12);
    expect(checkedAgo(null, 0)).toBeNull();
  });
});

describe('the story in words', () => {
  const after: WhatChangedClause = {
    code: 'after_change',
    facts: {
      who: 'shop/backend',
      key: 'workload.cpu.usage',
      peer: null,
      x: 14,
      dir: 'up',
      gap: 2,
      change: 'rollout',
      target: 'backend',
      host: null,
      namespace: 'shop',
    },
  };
  it('after a rollout, then along the calls, and the last at the same time', () => {
    const text = storyText(
      [
        after,
        {
          code: 'then',
          facts: {
            who: 'shop/postgres',
            key: 'workload.cpu.usage',
            peer: null,
            x: 3.4,
            dir: 'up',
            and: 0,
          },
        },
        {
          code: 'same_time',
          facts: {
            who: 'shop/api',
            key: 'workload.cpu.usage',
            peer: null,
            x: 1.5,
            dir: 'down',
            and: 1,
          },
        },
      ],
      tr,
    );
    expect(text).toMatch(
      /^shop\/backend's .+ went to 14× usual 2 minutes after the rollout of backend; shop\/postgres's .+ then went to 3\.4× usual, and at the same time shop\/api's .+ went to ÷1\.5 usual\.$/,
    );
  });

  it('every kind of change reads as a phrase, and in the cause box', () => {
    for (const change of [
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
    ]) {
      const c = {
        code: 'change',
        facts: {
          change,
          target: 'backup.timer',
          host: 'db-1',
          from: '2',
          to: '4',
          at: '2026-11-22T02:00:00Z',
          gap: 2,
          who: 'db-1',
        },
      };
      const box = changeCauseText(c, tr, () => '02:00');
      expect(box, change).toMatch(/^.+ at 02:00\. The first move came 2 minutes later, on db-1\.$/);
      expect(box).not.toContain('{');
      if (change === 'job_run') expect(box).toMatch(/^backup\.timer running on db-1/);
      if (change === 'rollout') expect(box).toMatch(/^The rollout of backup\.timer/);
    }
  });

  it('no clear cause: "moved first", and "and N more"', () => {
    const text = storyText(
      [
        {
          code: 'first',
          facts: { who: 'db-1', key: 'host.cpu.utilization', peer: null, x: 9, dir: 'up' },
        },
        { code: 'more', facts: { n: 4 } },
      ],
      tr,
    );
    expect(text).toMatch(/^db-1's .+ moved first, to 9× usual, and 4 more things moved\.$/);
  });

  it('the chip: × for a rise, ÷ for a drop, capped', () => {
    expect([
      factorText(14, 'up', tr),
      factorText(1.5, 'down', tr),
      factorText(999, 'up', tr),
    ]).toEqual(['14× usual', '÷1.5 usual', '999+× usual']);
  });

  it('the episode’s label: today, a range or since, how many moved', () => {
    const now = new Date(2026, 10, 22, 16, 0).getTime();
    const at = (h: number, m: number) => new Date(2026, 10, 22, h, m).toISOString();
    const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
    expect(episodeLabel({ from: at(14, 31), to: at(15, 39), count: 3 }, now, tr, clock)).toBe(
      'Today 14:31 – 15:39 · 3 things moved',
    );
    expect(episodeLabel({ from: at(15, 50), to: null, count: 1 }, now, tr, clock)).toBe(
      'Today since 15:50 · 1 thing moved',
    );
    const yesterday = new Date(2026, 10, 21, 2, 0).toISOString();
    expect(episodeLabel({ from: yesterday, to: yesterday, count: 2 }, now, tr, clock)).toMatch(
      /^Yesterday /,
    );
  });

  it('the checks: found something first; "No clear cause" lists those by name', () => {
    const checks = [
      { result: 'ok', code: 'a' },
      { result: 'possible', code: 'b' },
      { result: 'not_applicable', code: 'c' },
      { result: 'explains', code: 'd' },
      { result: 'not_run', code: 'e' },
    ];
    expect(orderedChecks(checks).map((c) => c.code)).toEqual(['d', 'b', 'a', 'e']);
    expect(foundChecks(checks).map((c) => c.code)).toEqual(['b', 'd']);
  });

  it('What moved sorts by first move or furthest out', () => {
    const rows = [
      { id: 'a', since: '2026-11-22T14:33:00Z', peakScore: 9 },
      { id: 'b', since: '2026-11-22T14:31:00Z', peakScore: 4 },
    ];
    expect(sortedMoved(rows, 'first').map((r) => r.id)).toEqual(['b', 'a']);
    expect(sortedMoved(rows, 'furthest').map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('the shapes', () => {
  it('the sparkline: its band, its line, the dashed exit where it left', () => {
    const sp = sparkOf(
      { from: '2026-11-22T14:00:00Z', step: 60, values: [20, 22, null, 400, 410] },
      12,
      30,
      '2026-11-22T14:03:00Z',
    )!;
    expect(sp.path.startsWith('M0.0 ')).toBe(true);
    expect(sp.path.split('M')).toHaveLength(3); // the gap breaks the line
    expect(sp.exitX).toBeCloseTo((3 / 4) * 210, 5);
    expect(sp.band.h).toBeGreaterThan(0);
    expect(
      sparkOf(
        { from: '2026-11-22T14:00:00Z', step: 60, values: [1] },
        0,
        1,
        '2026-11-22T14:00:00Z',
      ),
    ).toBeNull();
  });

  it('the chart: episodes shaded, the selected one marked; changes as markers in range', () => {
    const range = { from: '2026-11-22T10:00:00Z', to: '2026-11-22T16:00:00Z' };
    const bands = chartBands(
      [
        { from: '2026-11-22T11:00:00Z', to: '2026-11-22T11:30:00Z' },
        { from: '2026-11-22T14:00:00Z', to: null },
      ],
      1,
      range,
      Date.parse('2026-11-22T16:00:00Z'),
    );
    expect(bands.map((b) => [Math.round(b.left), Math.round(b.width), b.selected])).toEqual([
      [17, 8, false],
      [67, 33, true],
    ]);
    const markers = chartMarkers(
      [
        { at: '2026-11-22T13:58:00Z', kind: 'rollout', name: 'backend', facts: {} },
        { at: '2026-11-22T09:00:00Z', kind: 'scale', name: 'api', facts: { from: 2, to: 4 } },
        {
          at: '2026-11-22T14:10:00Z',
          kind: 'job_run',
          name: 'backup.timer',
          host: 'db-1',
          facts: {},
        },
      ],
      range,
      tr,
    );
    expect(markers.map((m) => m.label)).toEqual(['rollout backend', 'backup.timer ran']);
    // A busy place: a run every 10 minutes and scaling every 15 over 6 hours. Labels only
    // where they fit, deployments first; every change still a line.
    const busy = [
      ...Array.from({ length: 36 }, (_, i) => ({
        at: new Date(Date.parse(range.from) + i * 10 * 60_000).toISOString(),
        kind: 'job_run' as const,
        name: 'report-builder',
        facts: {},
      })),
      ...Array.from({ length: 24 }, (_, i) => ({
        at: new Date(Date.parse(range.from) + i * 15 * 60_000 + 60_000).toISOString(),
        kind: 'scale' as const,
        name: 'api',
        facts: { from: 2, to: 3 },
      })),
    ];
    const m2 = chartMarkers(busy, range, tr);
    expect(m2).toHaveLength(60);
    const labelled = m2.filter((m) => m.lane !== null);
    expect(labelled.length).toBeGreaterThan(3);
    expect(labelled.length).toBeLessThan(20);
    // No two labels in a lane overlap, on either side of the flip near the right end.
    for (let lane = 0; lane < 3; lane++) {
      const spans = labelled
        .filter((m) => m.lane === lane)
        .map((m) => labelSpan(m.left, m.label))
        .sort((p, q) => p[0] - q[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThan(spans[i - 1]![1]);
    }
    expect(labelled.filter((m) => m.label.startsWith('scaled')).length).toBeGreaterThan(
      labelled.filter((m) => m.label.startsWith('report-builder')).length,
    );
  });
});
