// SPDX-License-Identifier: AGPL-3.0-only
// The overview's rules (ADR-110): period comparison, change
// markers, which warning events are shown, and the pod heatmap.
import type { OverviewEvent, OverviewMarker } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import {
  EVENT_HINTS,
  comparison,
  markerLabel,
  markerLink,
  problemLink,
  visibleEvents,
} from '@/lib/overview';
import { heatTone } from '@/lib/resources';
import { niceStep } from '@/lib/units';

const t = (k: string, v?: Record<string, unknown>) => `${k} ${JSON.stringify(v ?? {})}`;

describe('period comparison', () => {
  it('says up, down or flat against the previous period', () => {
    expect(comparison(36, 8)).toMatchObject({ change: 28, direction: 'up' });
    expect(comparison(3, 12)).toMatchObject({ change: -9, direction: 'down' });
    expect(comparison(12, 12)).toMatchObject({ change: 0, direction: 'flat' });
    // Under one unit, or under 5 %, is flat.
    expect(comparison(100.4, 100)).toMatchObject({ direction: 'flat' });
    expect(comparison(102, 100)).toMatchObject({ direction: 'flat' });
    expect(comparison(0.5, 0.4, 0.01)).toMatchObject({ direction: 'up' });
    // From zero there is no ratio, but there is a direction.
    expect(comparison(5, 0)).toEqual({ change: 5, ratio: null, direction: 'up' });
    expect(comparison(null, 3)).toEqual({ change: null, ratio: null, direction: null });
    expect(comparison(3, null).direction).toBeNull();
  });
});

describe('change markers', () => {
  const m = (
    kind: string,
    target: string,
    details: Record<string, unknown> = {},
  ): OverviewMarker => ({
    kind,
    target,
    namespace: target.split('/')[1] ?? null,
    details,
    ts: '2026-11-01T19:21:00Z',
  });
  it('labels each kind of change and links to what changed', () => {
    expect(markerLabel(m('rollout', 'Deployment/watchlog/backend'), t)).toBe(
      'overview.changes.rollout {"name":"backend"}',
    );
    expect(markerLabel(m('scale', 'Deployment/wl-demo/catalog', { from: 2, to: 0 }), t)).toBe(
      'overview.changes.scale {"name":"catalog","from":2,"to":0}',
    );
    expect(markerLabel(m('node', 'Node/worker-3', { action: 'removed' }), t)).toBe(
      'overview.changes.node.removed {"name":"worker-3"}',
    );
    expect(markerLabel(m('namespace', 'Namespace/wl-demo'), t)).toBe(
      'overview.changes.namespace {"name":"wl-demo"}',
    );
    expect(markerLink(m('rollout', 'Deployment/watchlog/backend'))).toEqual({
      name: 'workloads',
      query: { view: 'pods', wkind: 'Deployment', wns: 'watchlog', wname: 'backend' },
    });
    expect(markerLink(m('node', 'Node/worker-3'))).toEqual({
      name: 'node',
      params: { name: 'worker-3' },
    });
    expect(markerLink(m('namespace', 'Namespace/wl-demo'))).toEqual({
      name: 'workloads',
      query: { ns: 'wl-demo' },
    });
  });
});

describe('warning events', () => {
  const e = (reason: string, over: Partial<OverviewEvent> = {}): OverviewEvent => ({
    kind: 'Pod',
    namespace: 'wl-test',
    name: reason.toLowerCase(),
    reason,
    message: 'm',
    count: 1,
    lastSeen: '2026-11-01T19:00:00Z',
    covered: false,
    watchlog: false,
    ...over,
  });
  const events = [
    e('BackOff', { covered: true }),
    e('BackOff', { name: 'oom', covered: true }),
    e('Unhealthy', { watchlog: true }),
    e('FailedGetResourceMetric', { kind: 'HorizontalPodAutoscaler' }),
  ];
  it('never shows events already in Needs attention; hides WatchLog pods unless asked', () => {
    const on = visibleEvents(events, true);
    expect(on.shown.map((x) => x.reason)).toEqual(['FailedGetResourceMetric']);
    expect(on.hidden).toEqual({ covered: 2, own: 1, total: 3 });
    const off = visibleEvents(events, false);
    expect(off.shown.map((x) => x.reason)).toEqual(['Unhealthy', 'FailedGetResourceMetric']);
    expect(off.hidden).toEqual({ covered: 2, own: 0, total: 2 });
  });
  it('has fix hints for well-known reasons', () => {
    expect(EVENT_HINTS.has('FailedGetResourceMetric')).toBe(true);
    expect(EVENT_HINTS.has('SomethingNew')).toBe(false);
  });
});

describe('heatmap and links', () => {
  it('colours pods by CPU against the request (<25 %, 25–75 %, 75–100 %, over), failing first', () => {
    const h = (cpuRatio: number | null, failing: string | null = null) =>
      heatTone({ cpuRatio, failing });
    expect(h(0.1, 'CrashLoopBackOff')).toBe('fail');
    expect(h(null)).toBe('none');
    expect(h(1.4)).toBe('over');
    expect(h(0.9)).toBe('high');
    expect(h(0.75)).toBe('mid');
    expect(h(0.3)).toBe('mid');
    expect(h(0.25)).toBe('low');
    expect(h(0.05)).toBe('low');
  });
  it('gives the chart round y-axis steps', () => {
    // 12 allocatable cores: ticks 0, 5, 10, 15, never a "13.20" over "12.00".
    expect(niceStep(12.6)).toBe(5);
    expect(niceStep(0.8)).toBe(0.2);
    expect(niceStep(0)).toBe(1);
  });
  it('opens the alert, else the object', () => {
    const base = {
      id: 'x',
      source: 'alert' as const,
      severity: 'critical' as const,
      type: 'crashloop' as const,
      title: '',
      why: null,
      since: null,
      related: 0,
    };
    expect(problemLink({ ...base, alertId: 'a1', object: null })).toEqual({
      name: 'alert',
      params: { id: 'a1' },
    });
    expect(
      problemLink({
        ...base,
        source: 'object',
        alertId: null,
        object: { kind: 'Pod', namespace: 'shop', name: 'cart-1' },
      }),
    ).toEqual({
      name: 'pod',
      params: { namespace: 'shop', name: 'cart-1' },
    });
  });
});
