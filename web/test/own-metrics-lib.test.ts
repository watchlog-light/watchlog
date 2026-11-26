// SPDX-License-Identifier: AGPL-3.0-only
import type { OwnMetric } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { metricText, ownWords } from '@/lib/what-changed';
import {
  chartPer,
  chipsOf,
  droppedCount,
  filterMetrics,
  num,
  ownerLink,
  ownerQuery,
  ownerText,
  ratePer,
  sinceWords,
  wayOf,
  written,
  writtenText,
} from '@/lib/own-metrics';

const metric = (over: Partial<OwnMetric>): OwnMetric => ({
  id: over.name ?? 'm',
  name: 'orders_created_total',
  words: 'Orders created',
  type: 'counter',
  detectedType: 'counter',
  unit: 'count',
  detectedUnit: 'count',
  shown: 'rate',
  help: '',
  hidden: false,
  labels: [],
  refused: null,
  firstSeenAt: 0,
  lastSeenAt: 0,
  series: 1,
  sources: [{ id: 's', label: 'orders :8080/metrics', kind: 'scrape_pod' }],
  owners: [{ kind: 'workload', namespace: 'shop', workloadKind: 'Deployment', name: 'orders' }],
  ownerCount: 1,
  untied: false,
  pushed: false,
  watched: false,
  value: 1,
  ...over,
});

describe('how a value is written', () => {
  it('a rate reads per second, per minute or per hour, whichever has a whole number', () => {
    expect(ratePer(12)).toBe('s');
    expect(ratePer(0.07)).toBe('min');
    expect(ratePer(0.0004)).toBe('h');
    expect(ratePer(0)).toBe('s');
    expect(writtenText(0.07, { unit: 'count', shown: 'rate' })).toBe('4.2 /min');
    expect(writtenText(86, { unit: 'count', shown: 'rate' })).toBe('86 /s');
    expect(writtenText(0.001, { unit: 'count', shown: 'rate' })).toBe('3.6 /h');
    // A chart has one scale for all its points.
    expect(writtenText(2, { unit: 'count', shown: 'rate' }, 'min')).toBe('120 /min');
    expect(writtenText(2048, { unit: 'bytes', shown: 'rate' })).toBe('2 KiB /s');
  });

  it('durations, sizes, temperatures and shares take their unit', () => {
    expect(written(0.38, { unit: 'seconds', shown: 'p95' })).toEqual({
      value: '380',
      unit: 'ms',
      ago: false,
    });
    expect(writtenText(4.25, { unit: 'seconds', shown: 'as_is' })).toBe('4.25 s');
    expect(writtenText(600, { unit: 'seconds', shown: 'as_is' })).toBe('10 min');
    expect(writtenText(5 * 1024 * 1024, { unit: 'bytes', shown: 'as_is' })).toBe('5 MiB');
    expect(writtenText(85.26, { unit: 'celsius', shown: 'as_is' })).toBe('85.3 °C');
    expect(writtenText(0.7, { unit: 'ratio', shown: 'as_is' })).toBe('70%');
    expect(writtenText(12.5, { unit: 'percent', shown: 'as_is' })).toBe('12.5%');
    expect(writtenText(612, { unit: 'count', shown: 'as_is' })).toBe('612');
    expect(writtenText(null, { unit: 'count', shown: 'as_is' })).toBe('–');
  });

  it('a timestamp is the time since, in one unit', () => {
    expect(written(3 * 3600, { unit: 'seconds', shown: 'time_since' })).toEqual({
      value: '3 h',
      unit: '',
      ago: true,
    });
    expect(sinceWords(45)).toBe('45 s');
    expect(sinceWords(12 * 60)).toBe('12 min');
    expect(sinceWords(26 * 3600)).toBe('26 h');
    expect(sinceWords(4 * 86400)).toBe('4 d');
  });

  it('numbers keep few digits', () => {
    expect(num(12400.4)).toBe('12,400');
    expect(num(380.4)).toBe('380');
    expect(num(42.26)).toBe('42.3');
    expect(num(4.204)).toBe('4.2');
    expect(num(0.0342)).toBe('0.034');
    expect(num(0)).toBe('0');
  });

  it('a chart’s scale comes from its highest point', () => {
    expect(
      chartPer([
        {
          points: [
            [1, 0.01],
            [2, 0.07],
          ],
        },
        { points: [[1, null]] },
      ]),
    ).toBe('min');
    expect(chartPer([{ points: [] }])).toBe('s');
  });
});

describe('what a metric belongs to', () => {
  it('names and links a workload or a server; nothing for an untied metric', () => {
    const w = {
      kind: 'workload' as const,
      namespace: 'shop',
      workloadKind: 'Deployment',
      name: 'orders',
    };
    const s = { kind: 'server' as const, namespace: '', workloadKind: '', name: 'gpu-1' };
    const none = { kind: '' as const, namespace: '', workloadKind: '', name: '' };
    expect(ownerText(w)).toBe('shop/orders');
    expect(ownerText(s)).toBe('gpu-1');
    expect(ownerText(none)).toBeNull();
    expect(ownerLink(w, 'c1')).toEqual({
      name: 'workloads',
      query: { cluster: 'c1', view: 'pods', wkind: 'Deployment', wname: 'orders', wns: 'shop' },
    });
    expect(ownerLink(s, 'c1')).toEqual({
      name: 'server',
      params: { server: 'gpu-1' },
      query: { cluster: 'c1' },
    });
    expect(ownerLink(none, 'c1')).toBeNull();
    expect(ownerQuery(w)).toBe(
      'ownerKind=workload&owner=orders&namespace=shop&workloadKind=Deployment',
    );
    expect(ownerQuery(s)).toBe('ownerKind=server&owner=gpu-1');
  });
});

describe('the list’s filters', () => {
  const list = [
    metric({ name: 'orders_created_total' }),
    metric({ name: 'payment_failures_total', words: 'Payment failures' }),
    metric({
      name: 'gpu_temperature_celsius',
      words: 'Gpu temperature',
      owners: [{ kind: 'server', namespace: '', workloadKind: '', name: 'gpu-1' }],
      sources: [{ id: 'g', label: 'gpu-1 :9400/metrics', kind: 'scrape_address' }],
    }),
    metric({
      name: 'backup_last_success_timestamp',
      words: 'Backup last success',
      owners: [],
      untied: true,
      pushed: true,
    }),
  ];

  it('offers All, each place, Pushed and Not tied, with counts', () => {
    expect(chipsOf(list)).toEqual([
      { key: 'all', label: '', count: 4 },
      { key: 'ns:shop', label: 'shop', count: 2 },
      { key: 'server:gpu-1', label: 'gpu-1', count: 1 },
      { key: 'pushed', label: '', count: 1 },
      { key: 'untied', label: '', count: 1 },
    ]);
  });

  it('filters by chip and by what is typed (name, words, source, owner)', () => {
    expect(filterMetrics(list, '', 'ns:shop').map((m) => m.name)).toEqual([
      'orders_created_total',
      'payment_failures_total',
    ]);
    expect(filterMetrics(list, 'payment', 'all')).toHaveLength(1);
    expect(filterMetrics(list, 'Backup last', 'all')).toHaveLength(1);
    expect(filterMetrics(list, ':9400', 'all')).toHaveLength(1);
    expect(filterMetrics(list, 'shop/orders', 'all')).toHaveLength(2);
    expect(filterMetrics(list, 'payment', 'server:gpu-1')).toEqual([]);
    expect(filterMetrics(list, '', 'pushed')).toHaveLength(1);
  });
});

describe('sources and snippets', () => {
  it('groups a source by how it arrives and counts what was dropped', () => {
    expect(wayOf('scrape_pod')).toBe('scrape');
    expect(wayOf('scrape_address')).toBe('scrape');
    expect(wayOf('remote_write')).toBe('prometheus');
    expect(wayOf('push')).toBe('push');
    expect(
      droppedCount({
        reserved: 1,
        invalid: 2,
        cardinality: [],
        sourceCap: 30,
        orgCap: 5,
        sources: false,
      }),
    ).toBe(38);
  });

});

describe('a watched metric in What changed', () => {
  it('reads as a few words from its name, never as its key', () => {
    const tr = (key: string) => key;
    expect(metricText({ key: 'own:per_second:orders_created_total', peer: null }, tr)).toBe(
      'orders created',
    );
    expect(metricText({ key: 'own:seconds:checkout_duration_seconds', peer: null }, tr)).toBe(
      'checkout duration',
    );
    expect(ownWords('gpu_temperature_celsius')).toBe('gpu temperature');
  });
});
