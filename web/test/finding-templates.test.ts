// SPDX-License-Identifier: AGPL-3.0-only
// Every finding of "What WatchLog sees", for Redis, PostgreSQL, Nginx and RabbitMQ, with
// the facts the backend sends (and the ones it may send as null): the sentence exists,
// every placeholder in it has a value, and nothing renders as a raw key, `{name}`, null
// or undefined. The live demo once showed "orders has no consumers since and grows…".
import type { ApplicationReason } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import { createAppI18n } from '@/i18n';
import { reasonLine } from '@/lib/applications';

const NOW = Date.UTC(2026, 10, 10, 9, 58, 30);
const MIN = 60;
const at = (minutesAgo: number) => NOW / 1000 - minutesAgo * MIN;

type Facts = Record<string, string | number | null>;
const FINDINGS: Record<string, [string, Facts][]> = {
  redis: [
    ['memory_near_max', { pct: 95, member: 'redis-0' }],
    ['memory_near_max', { pct: 95, member: null }],
    ['evicting', { n: 120 }],
    ['no_maxmemory', {}],
    ['slow_keys_command', { n: 2 }],
    ['replica_down', {}],
    ['save_failed', {}],
    ['clients_rejected', { n: 4 }],
    ['clients_blocked', { n: 2 }],
  ],
  postgres: [
    ['connections_near_max', { n: 92, max: 100, pct: 92, top: 'shop/nightly-export (85)' }],
    ['long_query', { duration: '6 min' }],
    ['idle_in_transaction', { n: 2, duration: '12 min' }],
    ['lock_waits', { n: 3, who: 'shop/orders' }],
    ['deadlocks', { n: 1 }],
    ['replica_lag', { duration: '45 s' }],
    ['slot_retains_wal', { slot: 'old_replica', size: '2.1 GB' }],
    ['wraparound_risk', { db: 'shop', n: '1600 M' }],
    ['cache_hit_low', { pct: 81 }],
    ['autovacuum_not_finishing', { n: 3, table: 'orders' }],
    ['autovacuum_not_finishing', { n: 3, table: null }],
    ['statements_unavailable', {}],
  ],
  nginx: [
    ['errors_high', { pct: 12.5, upstream: 'shop/api', upstreamPct: 80, rollout: '12 min ago' }],
    ['errors_high', { pct: 12.5, upstream: 'shop/api', upstreamPct: 80, rollout: null }],
    ['errors_high', { pct: 2, upstream: null, upstreamPct: null, rollout: null }],
    ['upstream_no_endpoints', { upstream: 'shop/cart' }],
    ['latency_high', { p95: '1.40 s' }],
    ['connections_dropped', { n: 12 }],
    ['certificate_expiring', { host: 'shop.example.com', days: 5 }],
    ['ingress_metrics_off', { command: 'helm upgrade …' }],
    ['stub_status_missing', { command: 'server { … }', tried: ':8080/stub_status: 404' }],
    ['stub_status_missing', { command: 'server { … }', tried: null }],
    ['no_http_source', {}],
  ],
  rabbitmq: [
    // since known / more than 6 hours × the consumer, with or without its time, or none
    ...([at(3), null] as const).flatMap((sinceAt): [string, Facts][] =>
      (
        [
          ['shop/consumer', 'OOMKilled, CrashLoopBackOff', '3 min ago'],
          ['shop/consumer', 'gone', null],
          [null, null, null],
        ] as const
      ).map(([consumer, how, when]) => [
        'queue_no_consumers',
        {
          queue: 'orders',
          queues: 1,
          ready: 540,
          perMin: 181,
          sinceAt,
          since: sinceAt ? '3 min ago' : null,
          consumer,
          how,
          when,
        },
      ]),
    ),
    ['queue_growing', { queue: 'emails', perMin: 40 }],
    ['memory_alarm', { member: 'rabbitmq-0' }],
    ['memory_alarm', { member: null }],
    ['disk_alarm', { member: 'rabbitmq-1' }],
    ['disk_alarm', { member: null }],
    ['unacked_high', { n: 12_000 }],
    ['dead_letters_growing', { n: 30 }],
    ['dead_letters_growing', { n: null, queue: 'orders.dlq' }],
    [
      'prometheus_plugin_off',
      { n: 1, command: 'docker exec rabbit-1 rabbitmq-plugins enable rabbitmq_prometheus' },
    ],
  ],
};

const cluster = { id: 'c', name: 'prod', kind: 'kubernetes' as const };
const raw = (key: string): string | undefined =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as
    string | undefined;

describe('finding sentences', () => {
  const { global: i18n } = createAppI18n();
  for (const [type, findings] of Object.entries(FINDINGS)) {
    it(`${type}: every placeholder has a value`, () => {
      const problems: string[] = [];
      for (const [code, facts] of findings) {
        const r = { severity: 'warning', code, facts } as ApplicationReason;
        const { key, values } = reasonLine(r, cluster, (iso) => iso, NOW);
        const template = raw(key);
        const label = `${code} ${JSON.stringify(facts)}`;
        if (typeof template !== 'string') {
          problems.push(`${label}: no sentence at ${key}`);
          continue;
        }
        for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
          const v = values[name!];
          if (v === null || v === undefined || v === '')
            problems.push(`${label}: {${name}} would render empty in "${template}"`);
        }
        const text = i18n.t(key, values as Record<string, unknown>);
        if (/\{\w+\}|\bnull\b|\bundefined\b|integrations\.reasons\./.test(text))
          problems.push(`${label}: rendered "${text}"`);
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  it('says since when in the reader time, and how long ago', () => {
    const r = {
      severity: 'critical',
      code: 'queue_no_consumers',
      facts: FINDINGS.rabbitmq![0]![1],
    } as ApplicationReason;
    const { key, values } = reasonLine(r, cluster, (iso) => iso, NOW);
    const text = i18n.t(key, values as Record<string, unknown>);
    expect(text).toMatch(
      /^orders has had no consumers since \d\d:\d\d \(3 min ago\) and grows by 181 a minute/,
    );
  });
});
