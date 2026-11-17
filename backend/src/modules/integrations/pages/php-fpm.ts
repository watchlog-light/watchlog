// SPDX-License-Identifier: AGPL-3.0-only
// The PHP-FPM page (ADR-212): a pool's workers, its queue, how often it ran out of workers
// (pm.max_children), request rate and durations, from the status page the collector reads
// over FastCGI (agent/internal/integrations/phpfpm). The status page must be on
// (pm.status_path); without it the page says how to turn it on.
import { instant, one, pointsOf, range, some, SPARK_RANGE, valueOf } from './query.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics } from './types.js';

const P = 'integrations.php-fpm.panels';
const T = 'integrations.php-fpm.tiles';

/** The status page isn't on: the collector reports pm.status_path as missing (phpfpm.go). */
function statusOff(ctx: PageContext): boolean {
  const d = (ctx.row.status_details ?? {}) as {
    permissions?: { missing?: string }[];
  };
  return (d.permissions ?? []).some((p) => p.missing === 'pm.status_path');
}

const missing = {
  key: 'integrations.php-fpm.missing.overview',
  values: { missing: 'pm.status_path' },
};

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [active, idle, queue, reached, slow, rps, workers, queueR, rpsR] = await Promise.all([
    instant(ctx, `sum(watchlog_phpfpm_processes{${s},state="active"})`),
    instant(ctx, `sum(watchlog_phpfpm_processes{${s},state="idle"})`),
    instant(ctx, `sum(watchlog_phpfpm_listen_queue{${s}})`),
    instant(ctx, `sum(increase(watchlog_phpfpm_max_children_reached_total{${s}}[24h]))`),
    instant(ctx, `sum(increase(watchlog_phpfpm_slow_requests_total{${s}}[24h]))`),
    instant(ctx, `sum(rate(watchlog_phpfpm_accepted_connections_total{${s}}[5m]))`),
    range(ctx, `sum by (state) (watchlog_phpfpm_processes{${s}})`),
    range(ctx, `sum(watchlog_phpfpm_listen_queue{${s}})`),
    range(ctx, `sum(rate(watchlog_phpfpm_accepted_connections_total{${s}}[5m]))`),
  ]);
  const off = statusOff(ctx);
  const a = valueOf(active);
  const i = valueOf(idle);
  const total = a === null && i === null ? null : (a ?? 0) + (i ?? 0);
  const q = valueOf(queue);
  const r = valueOf(reached);
  const state = (has: boolean) =>
    (off ? 'needs_permission' : has ? 'ok' : 'empty') as Panel['state'];
  const series = (st: string) => pointsOf(workers.find((w) => w.labels.state === st));
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: state(total !== null),
      ...(off ? { missing } : {}),
      tiles: [
        {
          id: 'busy',
          labelKey: `${T}.busy`,
          value: total === null ? null : `${a ?? 0}/${total}`,
          severity: total && (a ?? 0) / total >= 0.9 ? 'warning' : undefined,
        },
        {
          id: 'queue',
          labelKey: `${T}.queue`,
          value: q,
          unit: 'count',
          severity: (q ?? 0) > 0 ? 'warning' : undefined,
        },
        { id: 'rps', labelKey: `${T}.rps`, value: valueOf(rps), unit: 'per_second' },
        {
          id: 'reached',
          labelKey: `${T}.reached`,
          value: r === null ? null : Math.round(r),
          unit: 'count',
          severity: (r ?? 0) > 0 ? 'warning' : undefined,
        },
        {
          id: 'slow',
          labelKey: `${T}.slow`,
          value: valueOf(slow) === null ? null : Math.round(valueOf(slow)!),
          unit: 'count',
        },
      ],
    },
    {
      id: 'workers',
      title: `${P}.workers`,
      kind: 'stack',
      span: 1,
      unit: 'count',
      state: state(workers.length > 0),
      ...(off ? { missing } : {}),
      series: [
        { nameKey: `${P}.series.active`, points: series('active'), severity: 'warning' },
        { nameKey: `${P}.series.idle`, points: series('idle'), severity: 'ok' },
      ],
    },
    {
      id: 'queue',
      title: `${P}.queue`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: state(queueR.length > 0),
      ...(off ? { missing } : {}),
      series: [{ nameKey: `${P}.series.queue`, points: pointsOf(queueR[0]) }],
    },
    {
      id: 'requests',
      title: `${P}.requests`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: state(rpsR.length > 0),
      ...(off ? { missing } : {}),
      series: [{ nameKey: `${P}.series.requests`, points: pointsOf(rpsR[0]) }],
    },
  ];
}

async function requests(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [p95, max, mem, reached, slow, maxActive] = await Promise.all([
    range(ctx, `max(watchlog_phpfpm_request_duration_seconds{${s},quantile="0.95"})`),
    range(ctx, `max(watchlog_phpfpm_request_duration_seconds{${s},quantile="1"})`),
    range(ctx, `max(watchlog_phpfpm_request_memory_bytes_max{${s}})`),
    range(ctx, `sum(increase(watchlog_phpfpm_max_children_reached_total{${s}}[5m]))`),
    range(ctx, `sum(increase(watchlog_phpfpm_slow_requests_total{${s}}[5m]))`),
    range(ctx, `max(watchlog_phpfpm_processes_max_active{${s}})`),
  ]);
  const off = statusOff(ctx);
  const st = (has: boolean) => (off ? 'needs_permission' : has ? 'ok' : 'empty') as Panel['state'];
  return [
    {
      id: 'duration',
      title: `${P}.duration`,
      kind: 'line',
      span: 2,
      unit: 'seconds',
      state: st(p95.length > 0 || max.length > 0),
      ...(off ? { missing } : {}),
      note: { key: `${P}.durationNote` },
      series: [
        { nameKey: `${P}.series.p95`, points: pointsOf(p95[0]) },
        { nameKey: `${P}.series.max`, points: pointsOf(max[0]), dashed: true },
      ],
    },
    {
      id: 'reached',
      title: `${P}.reached`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: st(reached.length > 0),
      ...(off ? { missing } : {}),
      series: [
        { nameKey: `${P}.series.reached`, points: pointsOf(reached[0]), severity: 'warning' },
        { nameKey: `${P}.series.slow`, points: pointsOf(slow[0]) },
      ],
    },
    {
      id: 'memory',
      title: `${P}.memory`,
      kind: 'line',
      span: 1,
      unit: 'bytes',
      state: st(mem.length > 0),
      ...(off ? { missing } : {}),
      series: [{ nameKey: `${P}.series.memory`, points: pointsOf(mem[0]) }],
    },
    {
      id: 'maxActive',
      title: `${P}.maxActive`,
      kind: 'line',
      span: 2,
      unit: 'count',
      state: st(maxActive.length > 0),
      ...(off ? { missing } : {}),
      series: [{ nameKey: `${P}.series.maxActive`, points: pointsOf(maxActive[0]) }],
    },
  ];
}

async function reasons(ctx: PageContext): Promise<Reason[]> {
  if (statusOff(ctx)) return [{ severity: 'info', code: 'phpfpm_status_off', facts: {} }];
  const s = one(ctx.row.id);
  const [reached, queue, busy, slow] = await Promise.all([
    instant(ctx, `sum(increase(watchlog_phpfpm_max_children_reached_total{${s}}[10m]))`),
    instant(ctx, `sum(watchlog_phpfpm_listen_queue{${s}})`),
    instant(
      ctx,
      `sum(watchlog_phpfpm_processes{${s},state="active"}) / (sum(watchlog_phpfpm_processes{${s}}) > 0)`,
    ),
    instant(ctx, `sum(increase(watchlog_phpfpm_slow_requests_total{${s}}[10m]))`),
  ]);
  const out: Reason[] = [];
  const r = valueOf(reached) ?? 0;
  const q = valueOf(queue) ?? 0;
  const b = valueOf(busy);
  if (r >= 1) {
    out.push({
      severity: 'warning',
      code: 'phpfpm_max_children',
      facts: { times: Math.round(r), queue: q },
    });
  }
  if (q > 0 && r < 1) out.push({ severity: 'warning', code: 'phpfpm_queue', facts: { queue: q } });
  if (b !== null && b >= 0.9 && r < 1) {
    out.push({ severity: 'info', code: 'phpfpm_busy', facts: { busy: Math.round(b * 100) } });
  }
  const sl = valueOf(slow) ?? 0;
  if (sl >= 1) {
    out.push({ severity: 'info', code: 'phpfpm_slow', facts: { slow: Math.round(sl) } });
  }
  return out;
}

export const phpFpmPage: IntegrationPage = {
  id: 'php-fpm',
  tabs: [
    { id: 'overview', title: 'integrations.tabs.overview', panels: overview },
    { id: 'requests', title: 'integrations.php-fpm.tabs.requests', panels: requests },
  ],

  async listMetrics({ vm, scope, ids, now }) {
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const [busy, rps, queue, spark] = await Promise.all([
      vm.query(
        scope,
        `sum by (service) (watchlog_phpfpm_processes{${s},state="active"}) / (sum by (service) (watchlog_phpfpm_processes{${s}}) > 0)`,
      ),
      vm.query(
        scope,
        `sum by (service) (rate(watchlog_phpfpm_accepted_connections_total{${s}}[5m]))`,
      ),
      vm.query(scope, `sum by (service) (watchlog_phpfpm_listen_queue{${s}})`),
      vm.queryRange(
        scope,
        `sum by (service) (rate(watchlog_phpfpm_accepted_connections_total{${s}}[5m]))`,
        end - SPARK_RANGE,
        end,
        300,
      ),
    ]);
    const at = (rows: typeof busy, id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const b = at(busy, id);
      const q = at(queue, id);
      out.set(id, {
        keyMetrics: [
          {
            id: 'busy',
            labelKey: `${T}.busyShare`,
            value: b,
            unit: 'ratio',
            severity: (b ?? 0) >= 0.9 ? 'warning' : undefined,
          },
          { id: 'rps', labelKey: `${T}.rps`, value: at(rps, id), unit: 'per_second' },
          {
            id: 'queue',
            labelKey: `${T}.queue`,
            value: q,
            unit: 'count',
            severity: (q ?? 0) > 0 ? 'warning' : undefined,
          },
        ],
        spark: spark.find((r) => r.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  reasons,
};
