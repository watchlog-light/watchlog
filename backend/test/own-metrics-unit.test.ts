// SPDX-License-Identifier: AGPL-3.0-only
// Own metrics without a database (1.0.0, ADR-236): names, types, units, the hidden list, the
// remote-write wire format, addresses and scrape ports, and each edition's numbers.
import { describe, expect, it } from 'vitest';
import {
  ownMetricLimits,
  OWN_SELF_HOSTED_SERIES,
} from '../src/modules/entitlements/own-metrics.js';
import {
  cleanLabels,
  familiesOf,
  hiddenByDefault,
  resolveType,
  shownAs,
  typeFromName,
  unitFromName,
  wordsOf,
} from '../src/modules/own-metrics/naming.js';
import { normaliseAddress, scrapePort } from '../src/modules/own-metrics/targets.js';
import { isMetricToken } from '../src/modules/own-metrics/tokens.js';
import { decodeWrite, encodeWrite, WireError } from '../src/modules/own-metrics/wire.js';
import { encode } from './support/remote-write.js';

const LIMITS = { maxDecodedBytes: 32 << 20, maxSeries: 20_000, maxSamples: 100_000 };

describe('types from names', () => {
  it.each([
    ['orders_created_total', 'counter'],
    ['jobs_waiting', 'gauge'],
    ['backup_last_success_timestamp', 'timestamp'],
    ['backup_last_success_timestamp_seconds', 'timestamp'],
    ['checkout_duration_seconds', 'gauge'],
  ] as const)('%s is a %s', (name, type) => {
    expect(typeFromName(name)).toBe(type);
  });

  it('a declared gauge named like a timestamp is a timestamp; other declarations win', () => {
    expect(resolveType('backup_last_success_timestamp_seconds', 'gauge')).toBe('timestamp');
    expect(resolveType('orders_total', 'gauge')).toBe('gauge');
    expect(resolveType('queue_depth', 'counter')).toBe('counter');
    expect(resolveType('queue_depth', undefined)).toBe('gauge');
  });

  it('a histogram is one family: its buckets (with le), sum and count', () => {
    const f = familiesOf([
      { name: 'checkout_duration_seconds_bucket', labels: { le: '0.5' } },
      { name: 'checkout_duration_seconds_sum', labels: {} },
      { name: 'checkout_duration_seconds_count', labels: {} },
      { name: 'orders_created_total', labels: {} },
      { name: 'items_count', labels: {} },
    ]);
    expect(f.get('checkout_duration_seconds_bucket')).toEqual({
      name: 'checkout_duration_seconds',
      type: 'histogram',
    });
    expect(f.get('checkout_duration_seconds_sum')!.name).toBe('checkout_duration_seconds');
    expect(f.get('checkout_duration_seconds_count')!.name).toBe('checkout_duration_seconds');
    expect(f.get('orders_created_total')).toEqual({
      name: 'orders_created_total',
      type: 'counter',
    });
    // `_count` without buckets is just a gauge of that name.
    expect(f.get('items_count')).toEqual({ name: 'items_count', type: 'gauge' });
  });

  it('TYPE lines decide; a known family keeps its parts when a batch has only the sum', () => {
    const declared = new Map([
      ['rpc_duration_seconds', 'summary' as const],
      ['queue_depth', 'counter' as const],
    ]);
    const f = familiesOf(
      [
        { name: 'rpc_duration_seconds', labels: { quantile: '0.5' } },
        { name: 'rpc_duration_seconds_sum', labels: {} },
        { name: 'queue_depth', labels: {} },
      ],
      declared,
    );
    expect(f.get('rpc_duration_seconds_sum')).toEqual({
      name: 'rpc_duration_seconds',
      type: 'summary',
    });
    expect(f.get('queue_depth')!.type).toBe('counter');
    const later = familiesOf(
      [{ name: 'checkout_seconds_sum', labels: {} }],
      new Map(),
      new Map([['checkout_seconds', 'histogram' as const]]),
    );
    expect(later.get('checkout_seconds_sum')).toEqual({
      name: 'checkout_seconds',
      type: 'histogram',
    });
  });

  it('shows a counter as a rate, a histogram as p95, a timestamp as time since', () => {
    expect(shownAs('counter')).toBe('rate');
    expect(shownAs('histogram')).toBe('p95');
    expect(shownAs('timestamp')).toBe('time_since');
    expect(shownAs('gauge')).toBe('as_is');
    expect(shownAs('summary')).toBe('as_is');
  });
});

describe('units and words', () => {
  it.each([
    ['checkout_duration_seconds', 'histogram', 'seconds'],
    ['upload_bytes_total', 'counter', 'bytes'],
    ['oven_temperature_celsius', 'gauge', 'celsius'],
    ['cache_hit_ratio', 'gauge', 'ratio'],
    ['disk_used_percent', 'gauge', 'percent'],
    ['orders_created_total', 'counter', 'count'],
    ['backup_last_success_timestamp', 'timestamp', 'seconds'],
  ] as const)('%s (%s) is in %s', (name, type, unit) => {
    expect(unitFromName(name, type)).toBe(unit);
  });

  it('makes a few words of a name', () => {
    expect(wordsOf('orders_created_total')).toBe('Orders created');
    expect(wordsOf('checkout_duration_seconds')).toBe('Checkout duration');
    expect(wordsOf('backup_last_success_timestamp_seconds')).toBe('Backup last success');
    expect(wordsOf('total')).toBe('Total');
  });
});

describe('the hidden list', () => {
  it('hides the runtime, process and scrape metrics, nothing of the user’s', () => {
    for (const n of [
      'go_goroutines',
      'process_cpu_seconds_total',
      'promhttp_metric_handler_requests_total',
      'scrape_duration_seconds',
      'up',
    ])
      expect(hiddenByDefault(n), n).toBe(true);
    for (const n of [
      'orders_created_total',
      'golang_version',
      'processed_jobs_total',
      'upload_bytes',
    ])
      expect(hiddenByDefault(n), n).toBe(false);
  });
});

describe('labels from a sender', () => {
  it('keeps the server’s own labels apart and drops empty and internal ones', () => {
    expect(
      cleanLabels({
        method: 'card',
        cluster_id: 'spoofed',
        wl_own: 'x',
        wl_workload: 'y',
        __replica__: 'a',
        empty: '',
      }),
    ).toEqual({
      method: 'card',
      exported_cluster_id: 'spoofed',
      exported_wl_own: 'x',
      exported_wl_workload: 'y',
    });
  });

  it('refuses a bad label name or too many labels', () => {
    expect(cleanLabels({ 'bad-name': 'x' })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`l${i}`, 'v']));
    expect(cleanLabels(many)).toBeNull();
  });
});

describe('addresses and ports', () => {
  it('reads an address as it is typed', () => {
    expect(normaliseAddress('localhost:9400/metrics')).toBe('http://localhost:9400/metrics');
    expect(normaliseAddress('localhost:9400')).toBe('http://localhost:9400/metrics');
    expect(normaliseAddress('https://10.0.0.5:8443/stats/prometheus')).toBe(
      'https://10.0.0.5:8443/stats/prometheus',
    );
    expect(normaliseAddress(' 127.0.0.1:9100/ ')).toBe('http://127.0.0.1:9100/');
  });

  it('refuses credentials, other schemes and nonsense', () => {
    expect(normaliseAddress('http://user:secret@localhost:9400/metrics')).toBeNull();
    expect(normaliseAddress('file:///etc/passwd')).toBeNull();
    expect(normaliseAddress('ftp://host/metrics')).toBeNull();
    expect(normaliseAddress('two words')).toBeNull();
    expect(normaliseAddress('')).toBeNull();
  });

  it('picks the annotated port: a number, a name, else the first named port, else the first', () => {
    const containers = [{ ports: [{ port: 8080 }, { name: 'metrics', port: 9102 }] }];
    expect(scrapePort({ containers, scrape: { by: 'watchlog', port: 9000 } })).toBe(9000);
    expect(scrapePort({ containers, scrape: { by: 'watchlog', port_name: 'metrics' } })).toBe(9102);
    expect(scrapePort({ containers, scrape: { by: 'watchlog', port_name: 'nope' } })).toBeNull();
    expect(scrapePort({ containers, scrape: { by: 'watchlog' } })).toBe(9102);
    expect(scrapePort({ containers: [{ ports: [{ port: 8080 }] }], scrape: {} })).toBe(8080);
    expect(scrapePort({ containers: [{}], scrape: {} })).toBeNull();
  });
});

describe('remote write, read and written again', () => {
  it('reads every series with its labels and samples', () => {
    const body = encode([
      { labels: { __name__: 'orders_created_total', method: 'card' }, value: 7, timestampMs: 1000 },
      { labels: { __name__: 'jobs_waiting' }, value: 3.5, timestampMs: 2000 },
    ]);
    const { series, types } = decodeWrite(body, LIMITS);
    expect(series).toEqual([
      { name: 'orders_created_total', labels: { method: 'card' }, samples: [[1000, 7]] },
      { name: 'jobs_waiting', labels: {}, samples: [[2000, 3.5]] },
    ]);
    expect(types.size).toBe(0);
  });

  it('what it writes reads back the same, labels in name order', () => {
    const stored = [
      {
        name: 'orders_created_total',
        labels: { wl_own: 'src', method: 'card', wl_ns: 'shop' },
        samples: [
          [1_700_000_000_000, 12],
          [1_700_000_030_000, 15.25],
        ] as [number, number][],
      },
    ];
    const back = decodeWrite(encodeWrite(stored), LIMITS);
    expect(back.series).toEqual(stored);
  });

  it('refuses too many series (413) and a series without a name (400)', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      labels: { __name__: `m${i}` },
      value: 1,
      timestampMs: 1,
    }));
    expect(() => decodeWrite(encode(many), { ...LIMITS, maxSeries: 2 })).toThrowError(WireError);
    try {
      decodeWrite(encode([{ labels: { job: 'x' }, value: 1, timestampMs: 1 }]), LIMITS);
      throw new Error('expected a WireError');
    } catch (err) {
      expect((err as WireError).status).toBe(400);
    }
    expect(() => decodeWrite(Uint8Array.from([1, 2, 3]), LIMITS)).toThrowError(WireError);
  });
});

describe('each edition’s numbers', () => {
  it('Cloud Free: 200 series, 100 a source, 3 sources, one dashboard of 8, no alerts', () => {
    expect(ownMetricLimits({ edition: 'cloud', plan: 'free', pro: false })).toEqual({
      series: 200,
      seriesPerSource: 100,
      sources: 3,
      dashboards: 1,
      widgetsPerDashboard: 8,
      pin: true,
      alerts: 'none',
      usualRange: false,
      watched: 0,
    });
  });

  it('Cloud Pro: 200 per billed node or server, at least 1,000; everything else on', () => {
    const at = (billedNodes: number) =>
      ownMetricLimits({ edition: 'cloud', plan: 'pro', pro: true, billedNodes });
    expect(at(0).series).toBe(1000);
    expect(at(5).series).toBe(1000);
    expect(at(6).series).toBe(1200);
    expect(at(40).series).toBe(8000);
    expect(at(6)).toMatchObject({
      seriesPerSource: 500,
      sources: null,
      dashboards: 50,
      widgetsPerDashboard: 24,
      alerts: 'all',
      usualRange: true,
      watched: 50,
    });
    // A Cloud Enterprise contract is Pro here.
    expect(
      ownMetricLimits({ edition: 'cloud', plan: 'enterprise', pro: true, billedNodes: 10 }).series,
    ).toBe(2000);
  });

  it('Community: the installation’s cap, threshold alerts, no usual range', () => {
    expect(ownMetricLimits({ edition: 'community', pro: false })).toMatchObject({
      series: OWN_SELF_HOSTED_SERIES,
      seriesPerSource: 500,
      sources: null,
      dashboards: 50,
      widgetsPerDashboard: 24,
      alerts: 'threshold',
      usualRange: false,
      watched: 0,
    });
    expect(
      ownMetricLimits({ edition: 'community', pro: false, installationSeries: 300 }).series,
    ).toBe(300);
  });

  it('a licence with pro: the same cap, every alert, the usual range and What changed', () => {
    expect(ownMetricLimits({ edition: 'community', pro: true })).toMatchObject({
      series: OWN_SELF_HOSTED_SERIES,
      alerts: 'all',
      usualRange: true,
      watched: 50,
    });
  });
});

describe('tokens', () => {
  it('knows its own prefix', () => {
    expect(isMetricToken('wl_mt_abc')).toBe(true);
    expect(isMetricToken('wl_abc')).toBe(false);
  });
});
