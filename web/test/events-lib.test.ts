// SPDX-License-Identifier: AGPL-3.0-only
// The Events page's rules (ADR-111): UID and boot-ID
// trimming, cluster-scoped names, grouping windows, routine node events, day labels.
import type { KubeEvent } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WINDOW_MS,
  dayOf,
  groupEvents,
  groupTitle,
  objectLink,
  objectName,
  trimIds,
  type EventItem,
} from '@/lib/events';

const T0 = Date.parse('2026-11-01T21:12:00Z');
const ev = (
  name: string,
  reason: string,
  minutesAgo: number,
  over: Partial<KubeEvent> = {},
): KubeEvent => ({
  type: 'Warning',
  reason,
  message: 'm',
  count: 1,
  firstSeen: new Date(T0 - minutesAgo * 60_000).toISOString(),
  lastSeen: new Date(T0 - minutesAgo * 60_000).toISOString(),
  namespace: 'wl-test',
  involvedKind: 'Pod',
  involvedName: name,
  reportingController: null,
  host: null,
  ...over,
});
const node = (name: string, reason: string, minutesAgo: number, type = 'Normal') =>
  ev(name, reason, minutesAgo, { involvedKind: 'Node', namespace: null, type });
const t = (k: string, v?: Record<string, unknown>) => `${k} ${JSON.stringify(v ?? {})}`;
const shape = (items: EventItem[]) =>
  items.map((i) =>
    i.type === 'event'
      ? `${i.event.involvedName}:${i.event.reason}`
      : `${i.routine ? 'routine' : i.reason}[${i.objects.join(',')}]`,
  );

describe('event messages and names', () => {
  it('trims boot IDs and UIDs, keeping pods as namespace/name', () => {
    expect(
      trimIds('Node worker has been rebooted, boot id: 963e6014-1c5a-4b7e-9d1f-0c4c1c7a2abc'),
    ).toBe('Node worker has been rebooted');
    expect(
      trimIds(
        'Back-off restarting failed container main in pod crashloop_wl-test(1d4c5622-c34e-4beb-9c6c-f266104c9d31)',
      ),
    ).toBe('Back-off restarting failed container main in pod wl-test/crashloop');
    expect(trimIds('Deleted pod: web-1 (uid: 1d4c5622-c34e-4beb-9c6c-f266104c9d31) for good')).toBe(
      'Deleted pod: web-1 for good',
    );
    expect(trimIds('volume 1d4c5622-c34e-4beb-9c6c-f266104c9d31 attached')).toBe(
      'volume … attached',
    );
  });

  it('names cluster-scoped objects without a namespace', () => {
    expect(objectName(node('worker-2', 'Rebooted', 0))).toBe('worker-2');
    expect(objectName(ev('web-1', 'BackOff', 0))).toBe('wl-test/web-1');
  });
});

describe('event grouping', () => {
  it('groups one reason on several objects within the window, newest first', () => {
    const items = groupEvents([
      ev('oom', 'BackOff', 0),
      ev('crashloop', 'BackOff', 3),
      ev('web', 'FailedGetResourceMetric', 4, { involvedKind: 'HorizontalPodAutoscaler' }),
      ev('wl-oom-chart', 'BackOff', 4),
      // Outside the window of the group above: a row of its own.
      ev('late', 'BackOff', 4 + GROUP_WINDOW_MS / 60_000 + 1),
      // Same reason in another namespace: not in the group.
      ev('other', 'BackOff', 1, { namespace: 'shop' }),
    ]);
    expect(shape(items)).toEqual([
      'BackOff[wl-test/oom,wl-test/crashloop,wl-test/wl-oom-chart]',
      'web:FailedGetResourceMetric',
      'late:BackOff',
      'other:BackOff',
    ]);
    const g = items[0] as Extract<EventItem, { type: 'group' }>;
    expect(g.count).toBe(3);
    expect(groupTitle(g, t)).toBe('kube.events.group.backOff {"n":3,"ns":"wl-test"}');
  });

  it('says "all nodes" when every node rebooted, and folds routine start-up events', () => {
    const items = groupEvents([
      node('n1', 'Rebooted', 0, 'Warning'),
      node('n2', 'Rebooted', 0, 'Warning'),
      node('n3', 'Rebooted', 1, 'Warning'),
      node('n1', 'NodeReady', 1),
      node('n2', 'NodeHasSufficientMemory', 1),
      node('n3', 'Starting', 2),
      node('n1', 'NodeHasNoDiskPressure', 2),
      // Not routine: stays its own row.
      node('n2', 'CIDRNotAvailable', 2),
    ]);
    expect(shape(items)).toEqual([
      'Rebooted[n1,n2,n3]',
      'routine[n1,n2,n3]',
      'n2:CIDRNotAvailable',
    ]);
    const [reboot, routine] = items as Extract<EventItem, { type: 'group' }>[];
    expect(groupTitle(reboot!, t, 3)).toBe('kube.events.group.allRebooted {"n":3}');
    expect(groupTitle(reboot!, t, 5)).toBe('kube.events.group.rebooted {"n":3}');
    expect(routine!.events).toHaveLength(4);
    expect(groupTitle(routine!, t)).toBe('kube.events.group.routine {"n":3}');
  });

  it('groups Docker containers dying in one Compose project, named without the host', () => {
    const c = (name: string, minutesAgo: number, ns: string | null = 'demo', host = 'h1') =>
      ev(name, 'Died', minutesAgo, { involvedKind: 'Container', namespace: ns, host });
    const items = groupEvents([
      c('demo-web-1', 0),
      c('demo-db-1', 2, 'demo', 'h2'),
      c('solo', 1, null),
    ]);
    expect(shape(items)).toEqual(['Died[demo-web-1,demo-db-1]', 'solo:Died']);
    const g = items[0] as Extract<EventItem, { type: 'group' }>;
    expect(groupTitle(g, t)).toBe('kube.events.group.docker.Died {"n":2,"ns":"demo"}');
    const solo = groupEvents([c('a', 0, null), c('b', 1, null)])[0] as Extract<
      EventItem,
      { type: 'group' }
    >;
    expect(groupTitle(solo, t)).toBe('kube.events.group.docker.DiedStandalone {"n":2}');
    expect(objectName(c('demo-web-1', 0))).toBe('demo-web-1');
    expect(objectLink(c('demo-web-1', 0))).toEqual({
      name: 'docker-container',
      params: { host: 'h1', name: 'demo-web-1' },
    });
  });

  it('labels days as today, yesterday or the date', () => {
    const now = new Date(2026, 10, 1, 21, 0);
    expect(dayOf(new Date(2026, 10, 1, 1, 0).toISOString(), now).label).toBe('today');
    expect(dayOf(new Date(2026, 9, 31, 23, 0).toISOString(), now).label).toBe('yesterday');
    expect(dayOf(new Date(2026, 9, 29, 23, 0).toISOString(), now).label).toBeNull();
  });
});
