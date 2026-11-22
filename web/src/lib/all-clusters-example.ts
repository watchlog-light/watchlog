// SPDX-License-Identifier: AGPL-3.0-only
// The upgrade page's example (ADR-226, the design's Upgrade board): the page's own layout with
// made-up data, blurred and hidden from screen readers behind the card. Static: never another
// org's data, and nothing is asked of the server for it.
import type { AllClusters } from '@watchlog/api-types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cpu = (vals: number[]) => vals.map((v, i) => [i * 3600, v / 100]);
const ref = (n: number, name: string, kind: 'kubernetes' | 'server') => ({ id: id(n), name, kind });

const PROD = ref(1, 'acme-prod', 'kubernetes');
const STAGING = ref(2, 'acme-staging', 'kubernetes');
const OFFICE = ref(3, 'office-tools', 'server');
const DB = ref(4, 'db-servers', 'server');
const SHOP = ref(5, 'shop-servers', 'server');
const EDGE = ref(6, 'eu-edge', 'kubernetes');

const row = (
  r: typeof PROD,
  status: 'critical' | 'warning' | 'healthy',
  hosts: number,
  live: number,
  vals: number[],
  mem: number,
  problems: number,
  changes: number | null,
  alerts: number,
  extra: Partial<AllClusters['clusters'][number]> = {},
) => ({
  ...r,
  // Certificates and jobs (0.13.0): a few made-up counts, an expiring one on the critical rows.
  certificates: { total: hosts * 2, expiring: status === 'critical' ? 1 : 0 },
  jobs: { total: hosts + 3, failing: status === 'critical' ? 1 : 0 },
  status,
  version: r.kind === 'kubernetes' ? '1.34' : null,
  hosts,
  reporting: { live, total: hosts },
  sources:
    r.kind === 'server'
      ? { services: 4, processGroups: 2, containers: 0, applications: [] as string[] }
      : null,
  cpu: { now: vals[vals.length - 1]! / 100, points: cpu(vals) },
  memory: mem / 100,
  problems: {
    critical: status === 'critical' ? problems : 0,
    warning: status === 'warning' ? problems : 0,
  },
  whatChanged: changes,
  alerts,
  ...extra,
});

const since = (min: number) => new Date(Date.UTC(2026, 10, 21, 10, 0) - min * 60_000).toISOString();
const problem = (
  title: string,
  why: string,
  severity: 'critical' | 'warning',
  min: number,
  places: (typeof PROD)[],
) => ({
  id: `${places[0]!.id}:alert:${title}`,
  source: 'alert' as const,
  severity,
  type: 'other' as const,
  title,
  why,
  since: since(min),
  alertId: null,
  object: null,
  places: places.map((cluster) => ({ cluster, problemId: `alert:${title}`, alertId: null })),
});

export const EXAMPLE: AllClusters = {
  range: 86_400,
  step: 1800,
  ranges: [3600, 21_600, 86_400, 604_800, 2_592_000],
  kind: 'all',
  counts: { all: 6, kubernetes: 3, server: 3 },
  hosts: { nodes: 19, servers: 11, notReporting: 1 },
  clusters: [
    row(PROD, 'critical', 12, 12, [38, 41, 47, 55, 61, 62, 66, 64, 63, 65, 64, 64], 71, 1, 2, 4),
    row(STAGING, 'critical', 4, 4, [12, 15, 20, 19, 24, 20, 25, 22, 20, 22, 23, 22], 48, 1, 1, 2),
    row(OFFICE, 'critical', 2, 1, [8, 9, 8, 10, 8, 9, 8, 6, 4, 3, 3, 3], 35, 1, null, 1),
    row(DB, 'warning', 3, 3, [30, 33, 52, 61, 44, 36, 34, 35, 34, 36, 35, 35], 82, 1, 1, 1, {
      sources: { services: 6, processGroups: 1, containers: 0, applications: ['postgres'] },
    }),
    row(SHOP, 'warning', 6, 6, [22, 19, 18, 24, 38, 45, 44, 48, 43, 40, 44, 40], 64, 2, 1, 1),
    row(EDGE, 'healthy', 3, 3, [15, 14, 17, 16, 17, 18, 15, 16, 15, 16, 17, 16], 39, 0, 0, 0),
  ],
  problems: [
    problem(
      'payments-api is crash-looping',
      'OOMKilled: memory hits its 512 MiB limit about 40 s after start.',
      'critical',
      12,
      [STAGING, PROD],
    ),
    problem(
      'mail-01 stopped reporting',
      'No data for 18 min and no shutdown event.',
      'critical',
      18,
      [OFFICE],
    ),
    problem(
      'Disk /var/lib/postgresql on pg-02 is 91% full',
      'Grows about 2.1 GB a day.',
      'warning',
      120,
      [DB],
    ),
    problem('backup-nightly.service failed', 'Exit code 1 on web-03.', 'warning', 180, [SHOP]),
    problem(
      'Certificate for shop.example expires in 6 days',
      'The last two renewals failed.',
      'warning',
      1440,
      [SHOP],
    ),
  ],
  lastResolved: null,
  resolvedThisWeek: 3,
  certificatesExpiring: {
    count: 3,
    places: [
      { ...PROD, count: 1 },
      { ...STAGING, count: 1 },
      { ...OFFICE, count: 1 },
    ],
  },
  jobsFailing: {
    count: 3,
    jobs: [
      { name: 'shop/report-builder', node: '', cluster: PROD },
      { name: 'shop/report-builder', node: '', cluster: STAGING },
      { name: 'backup.service', node: 'mail-01', cluster: OFFICE },
    ],
  },
  whatChanged: {
    rows: [
      {
        id: id(101),
        since: since(30),
        until: null,
        key: 'workload.http.latency.p95',
        unit: 'seconds',
        subject: {},
        object: { kind: 'workload', name: 'checkout', namespace: 'shop' },
        peer: null,
        usualLow: 0.12,
        usualHigh: 0.18,
        value: 0.61,
        peakScore: 34,
        peakAt: since(28),
        cluster: PROD,
      },
      {
        id: id(102),
        since: since(400),
        until: null,
        key: 'host.memory.utilization',
        unit: 'ratio',
        subject: {},
        object: { kind: 'host', name: 'pg-02' },
        peer: null,
        usualLow: 0.3,
        usualHigh: 0.4,
        value: 0.91,
        peakScore: 28,
        peakAt: since(390),
        cluster: DB,
      },
    ],
    total: 4,
    learning: [],
  },
  alertsSent: {
    total: 9,
    channels: [
      { id: id(201), name: 'Telegram', type: 'telegram', sent: 5, failed: 0 },
      { id: id(202), name: 'Slack', type: 'slack', sent: 0, failed: 3 },
      { id: id(203), name: 'Email', type: 'email', sent: 1, failed: 0 },
    ],
  },
  housekeeping: {
    latestVersion: '0.11.0',
    oldAgents: [{ cluster: SHOP, count: 4, versions: ['0.10.1'] }],
    failingChannels: [
      {
        id: id(202),
        name: 'Slack',
        type: 'slack',
        since: since(2000),
        error: 'The webhook answers 404',
      },
    ],
    deliveringChannels: [
      { id: id(201), name: 'Telegram', type: 'telegram' },
      { id: id(203), name: 'Email', type: 'email' },
    ],
    noChannel: [STAGING],
    ebpfOff: [{ cluster: EDGE, count: 2, reasons: ['kernel 5.4 without BTF'] }],
  },
};
