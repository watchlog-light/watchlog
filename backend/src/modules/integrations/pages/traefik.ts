// SPDX-License-Identifier: AGPL-3.0-only
// The Traefik page (SPEC §4.12, v0.5 slice 3, ADR-165): Overview, Services, Entrypoints
// and TLS. Traefik's own Prometheus series, which the collector reads with promtext and
// labels service=<id> (Traefik's service label becomes traefik_service). Without them
// (metrics off), requests, errors and latency come from the node agents' eBPF HTTP stats
// (ADR-139) on Traefik's pods or containers, and the page gives the setting.
// Measured on 3.6: a request Traefik answers itself because no server is up ("no
// available server", 503) is counted on the entrypoint and never on a service.
import { sql } from 'kysely';
import { sourceMatchers } from '../../query/nginx.js';
import {
  backendIndex,
  isInternal,
  noServerUp,
  resolveTraefikService,
  type TraefikBackend,
} from '../traefik-backends.js';
import { genericPage } from './generic.js';
import { ago } from './owners.js';
import { instant, one, pointsOf, range } from './query.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.traefik.panels';
const RATE = '2m';
const DAY = 86_400;
/** The metrics and API entrypoints are Traefik's own traffic. */
const EP = 'entrypoint!~"metrics|traefik"';

export interface TraefikExtra {
  metrics?: boolean;
  /** Where the metrics were found (":9100/metrics"). */
  metrics_at?: string;
  /** What each place answered when none served them. */
  tried?: string;
  routers?: boolean;
  health_checks?: boolean;
  major?: string;
}
/** What the collector says about this Traefik: one row of its status's extra.traefik. */
export const traefikExtra = (row: { status_details: unknown }): TraefikExtra =>
  (row.status_details as { extra?: { traefik?: TraefikExtra[] } } | null)?.extra?.traefik?.[0] ??
  {};

/** Where the numbers come from: Traefik's series, or eBPF on its pods or containers. */
function source(ctx: PageContext) {
  const s = one(ctx.row.id);
  const metricsOff = traefikExtra(ctx.row).metrics === false;
  const ebpf = metricsOff ? sourceMatchers(ctx.row.target as never) : null;
  if (ebpf) {
    return {
      traefik: false,
      req: (m = '') => `watchlog_http_server_requests_total{${ebpf}${m && `,${m}`}}`,
      fiveXX: 'class="5xx"',
      byClass: (w: string) =>
        `sum by (class) (rate(watchlog_http_server_requests_total{${ebpf}}[${w}]))`,
      bucket: `watchlog_http_server_request_duration_seconds_bucket{${ebpf}}`,
    };
  }
  return {
    traefik: true,
    req: (m = '') => `traefik_entrypoint_requests_total{${s},${EP}${m && `,${m}`}}`,
    fiveXX: 'code=~"5.."',
    byClass: (w: string) =>
      `sum by (class) (label_replace(rate(traefik_entrypoint_requests_total{${s},${EP}}[${w}]), "class", "\${1}xx", "code", "([1-5])..")) `,
    bucket: `traefik_entrypoint_request_duration_seconds_bucket{${s},${EP}}`,
  };
}

const val = (rows: QuerySeries[]) => rows[0]?.points[0]?.[1] ?? null;
const ms = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);
const quantile = (q: number, bucket: string, by = '', w = RATE) =>
  `histogram_quantile(${q}, sum by (${by ? `${by}, ` : ''}le) (rate(${bucket}[${w}])))`;
const svcSel = (ctx: PageContext, m = '') =>
  `{${one(ctx.row.id)},traefik_service!~".*@internal"${m && `,${m}`}}`;

export interface TraefikService {
  name: string;
  backend: TraefikBackend;
  /** Max of traefik_service_server_up (health checks only). */
  up?: number;
  serversUp?: number;
  servers?: number;
  down: boolean;
}

/**
 * The services Traefik served in the last hour (and those with server_up series), each
 * with its backend and whether it has no server up.
 */
export async function traefikServices(ctx: PageContext): Promise<TraefikService[]> {
  const [seen, ups, idx] = await Promise.all([
    instant(
      ctx,
      `sum by (traefik_service) (increase(traefik_service_requests_total${svcSel(ctx)}[1h])) > 0`,
    ),
    instant(
      ctx,
      `sum by (traefik_service) (max by (traefik_service, url) (traefik_service_server_up${svcSel(ctx)}))`,
    ),
    backendIndex(ctx.db, ctx.row.cluster_id),
  ]);
  const servers = await instant(
    ctx,
    `max by (traefik_service, url) (traefik_service_server_up${svcSel(ctx)})`,
  );
  const ipsOf = new Map<string, string[]>();
  const totalOf = new Map<string, number>();
  for (const x of servers) {
    const n = x.labels.traefik_service ?? '';
    totalOf.set(n, (totalOf.get(n) ?? 0) + 1);
    const ip = urlHost(x.labels.url ?? '');
    if (ip) ipsOf.set(n, [...(ipsOf.get(n) ?? []), ip]);
  }
  const t = ctx.row.target as { kind: string; compose_project?: string };
  const projects = t.kind === 'compose' ? [t.compose_project ?? null] : [];
  const names = new Set<string>();
  for (const x of [...seen, ...ups]) {
    const n = x.labels.traefik_service;
    if (n && !isInternal(n)) names.add(n);
  }
  const upOf = new Map(ups.map((x) => [x.labels.traefik_service ?? '', val([x]) ?? 0]));
  return [...names].sort().map((name) => {
    const backend = resolveTraefikService(name, idx, { ips: ipsOf.get(name), projects });
    const serversUp = upOf.get(name);
    const up = serversUp === undefined ? undefined : serversUp > 0 ? 1 : 0;
    return {
      name,
      backend,
      up,
      serversUp,
      servers: totalOf.get(name),
      down: noServerUp(backend, up),
    };
  });
}

/** The address of a server URL ("http://172.24.0.3:9898" → "172.24.0.3"). */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '') || null;
  } catch {
    return null;
  }
}

/** Requests Traefik answered itself (503 on an entrypoint, none on a service), per second. */
async function answered(ctx: PageContext, w = '5m'): Promise<number> {
  const s = one(ctx.row.id);
  const rows = await instant(
    ctx,
    `(sum(rate(traefik_entrypoint_requests_total{${s},code="503"}[${w}])) or vector(0)) - (sum(rate(traefik_service_requests_total{${s},code="503"}[${w}])) or vector(0))`,
  );
  return Math.max(0, val(rows) ?? 0);
}

function backendLink(b: TraefikBackend): Reason['links'] {
  if (b.kind === 'workload' && b.namespace && b.workloadKind && b.name)
    return [{ kind: 'workload', id: `${b.namespace}/${b.workloadKind}/${b.name}`, name: b.name }];
  if (b.kind === 'container' && b.name) return [{ kind: 'container', id: b.name, name: b.name }];
  return undefined;
}

const CLASS_SEVERITY: Record<string, Severity | undefined> = {
  '2xx': 'ok',
  '4xx': 'warning',
  '5xx': 'critical',
};
function classOrder(rows: QuerySeries[]) {
  return ['2xx', '3xx', '4xx', '5xx', '1xx']
    .map((c) => rows.find((r) => r.labels.class === c))
    .filter((r): r is QuerySeries => !!r)
    .map((r) => ({
      name: r.labels.class!,
      points: pointsOf(r),
      severity: CLASS_SEVERITY[r.labels.class!],
    }));
}

async function overview(ctx: PageContext): Promise<Panel[]> {
  const q = source(ctx);
  const s = one(ctx.row.id);
  const [rps, peak, ratio, p95, p50, conns, certs, classes, p50s, p95s, p99s, busiest, svcs] =
    await Promise.all([
      instant(ctx, `sum(rate(${q.req()}[${RATE}]))`),
      instant(ctx, `max_over_time(sum(rate(${q.req()}[${RATE}]))[${ctx.range}s:1m])`),
      instant(
        ctx,
        `(sum(increase(${q.req(q.fiveXX)}[15m])) or vector(0)) / (sum(increase(${q.req()}[15m])) > 0)`,
      ),
      instant(ctx, quantile(0.95, q.bucket, '', '5m')),
      instant(ctx, quantile(0.5, q.bucket, '', '5m')),
      q.traefik
        ? instant(ctx, `sum(traefik_open_connections{${s},${EP}})`)
        : Promise.resolve([] as QuerySeries[]),
      q.traefik
        ? instant(ctx, `min(traefik_tls_certs_not_after{${s}}) - time()`)
        : Promise.resolve([] as QuerySeries[]),
      range(ctx, q.byClass(RATE)),
      range(ctx, quantile(0.5, q.bucket)),
      range(ctx, quantile(0.95, q.bucket)),
      range(ctx, quantile(0.99, q.bucket)),
      q.traefik
        ? instant(
            ctx,
            `topk(10, sum by (traefik_service) (rate(traefik_service_requests_total${svcSel(ctx)}[${ctx.range}s])))`,
          )
        : Promise.resolve([] as QuerySeries[]),
      q.traefik ? traefikServices(ctx) : Promise.resolve([] as TraefikService[]),
    ]);
  const r5 = val(ratio);
  const cert = val(certs);
  const upN = svcs.filter((x) => !x.down).length;
  const labelOf = (name: string) => svcs.find((x) => x.name === name)?.backend.label ?? name;
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: val(rps) === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'rps',
          labelKey: `${P}.requests`,
          value: val(rps),
          unit: 'per_second',
          sub: { key: `${P}.peak`, values: { peak: Math.round((val(peak) ?? 0) * 10) / 10 } },
        },
        {
          id: '5xx',
          labelKey: `${P}.errors15m`,
          value: r5,
          unit: 'ratio',
          severity:
            r5 === null ? undefined : r5 >= 0.05 ? 'critical' : r5 >= 0.01 ? 'warning' : 'ok',
        },
        {
          id: 'p95',
          labelKey: `${P}.p95`,
          value: val(p95),
          unit: 'seconds',
          sub:
            val(p50) !== null ? { key: `${P}.p50Sub`, values: { p50: ms(val(p50)!) } } : undefined,
          severity: (val(p95) ?? 0) > 1 ? 'warning' : undefined,
        },
        { id: 'connections', labelKey: `${P}.connections`, value: val(conns), unit: 'count' },
        {
          id: 'services',
          labelKey: `${P}.servicesUp`,
          value: svcs.length ? `${upN} / ${svcs.length}` : null,
          severity: svcs.length && upN < svcs.length ? 'critical' : undefined,
        },
        {
          id: 'cert',
          labelKey: `${P}.certExpiry`,
          value: cert === null ? null : Math.max(0, cert),
          unit: 'seconds',
          severity:
            cert === null
              ? undefined
              : cert < 3 * DAY
                ? 'critical'
                : cert < 14 * DAY
                  ? 'warning'
                  : undefined,
        },
      ],
    },
    {
      id: 'classes',
      title: `${P}.byClass`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: classes.length ? 'ok' : 'empty',
      note: q.traefik ? undefined : { key: `${P}.ebpfNote` },
      series: classOrder(classes),
    },
    {
      id: 'latency',
      title: `${P}.latency`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: p95s.length ? 'ok' : 'empty',
      note: q.traefik ? undefined : { key: `${P}.ttfbNote` },
      series: [
        { nameKey: `${P}.series.p50`, points: pointsOf(p50s[0]) },
        { nameKey: `${P}.series.p95`, points: pointsOf(p95s[0]) },
        { nameKey: `${P}.series.p99`, points: pointsOf(p99s[0]), severity: 'warning' },
      ],
    },
    {
      id: 'busiest',
      title: `${P}.busiest`,
      kind: 'bars',
      span: 2,
      unit: 'per_second',
      state: busiest.length ? 'ok' : 'empty',
      items: busiest
        .map((x) => {
          const name = x.labels.traefik_service ?? '';
          return {
            label: labelOf(name),
            value: x.points[0]?.[1] ?? 0,
            severity: svcs.find((v) => v.name === name)?.down
              ? ('critical' as Severity)
              : undefined,
          };
        })
        .sort((a, b) => b.value - a.value),
    },
  ];
}

async function services(ctx: PageContext): Promise<Panel[]> {
  const sel = svcSel(ctx);
  const sel5 = svcSel(ctx, 'code=~"5.."');
  const [rps, r5, p95, retries, byService5, slowest, svcs] = await Promise.all([
    instant(ctx, `sum by (traefik_service) (rate(traefik_service_requests_total${sel}[5m]))`),
    instant(
      ctx,
      `sum by (traefik_service) (rate(traefik_service_requests_total${sel5}[5m])) / (sum by (traefik_service) (rate(traefik_service_requests_total${sel}[5m])) > 0)`,
    ),
    instant(
      ctx,
      quantile(
        0.95,
        `traefik_service_request_duration_seconds_bucket${sel}`,
        'traefik_service',
        '5m',
      ),
    ),
    instant(ctx, `sum by (traefik_service) (rate(traefik_service_retries_total${sel}[5m]))`),
    range(
      ctx,
      `sum by (traefik_service) (rate(traefik_service_requests_total${sel5}[${RATE}])) > 0`,
    ),
    instant(
      ctx,
      `topk(10, ${quantile(0.95, `traefik_service_request_duration_seconds_bucket${sel}`, 'traefik_service', `${ctx.range}s`)})`,
    ),
    traefikServices(ctx),
  ]);
  const by = (rows: QuerySeries[]) =>
    new Map(rows.map((x) => [x.labels.traefik_service ?? '', val([x])]));
  const [rpsOf, r5Of, p95Of, retriesOf] = [by(rps), by(r5), by(p95), by(retries)];
  const labelOf = (name: string) => svcs.find((x) => x.name === name)?.backend.label ?? name;
  const round = (v: number | null | undefined, d = 100) =>
    v === null || v === undefined ? null : Math.round(v * d) / d;
  return [
    {
      id: 'services',
      title: `${P}.services`,
      kind: 'table',
      span: 2,
      state: svcs.length ? 'ok' : 'empty',
      note: traefikExtra(ctx.row).routers ? undefined : { key: `${P}.routersNote` },
      columns: [
        `${P}.col.service`,
        `${P}.col.backend`,
        `${P}.col.rps`,
        `${P}.col.errors`,
        `${P}.col.p95`,
        `${P}.col.servers`,
        `${P}.col.retries`,
      ],
      rows: svcs.map((x) => {
        const e5 = r5Of.get(x.name) ?? null;
        const p = p95Of.get(x.name) ?? null;
        return {
          cells: [
            x.name,
            x.backend.kind === 'unknown' ? null : x.backend.label,
            round(rpsOf.get(x.name)),
            e5 === null ? null : `${Math.round(e5 * 1000) / 10}%`,
            p === null || Number.isNaN(p) ? null : ms(p),
            x.servers !== undefined
              ? `${x.serversUp ?? 0} / ${x.servers}`
              : x.backend.readyEndpoints !== undefined && x.backend.readyEndpoints !== null
                ? `${x.backend.readyEndpoints} ready`
                : null,
            round(retriesOf.get(x.name)),
          ],
          severity: x.down ? 'critical' : (e5 ?? 0) >= 0.05 ? 'warning' : undefined,
        };
      }),
    },
    {
      id: 'errors-by-service',
      title: `${P}.errorsByService`,
      kind: 'line',
      span: 1,
      unit: 'per_second',
      state: byService5.length ? 'ok' : 'empty',
      series: byService5.map((x) => ({
        name: labelOf(x.labels.traefik_service ?? ''),
        points: pointsOf(x),
        severity: 'critical' as Severity,
      })),
    },
    {
      id: 'slowest',
      title: `${P}.slowest`,
      kind: 'bars',
      span: 1,
      unit: 'seconds',
      state: slowest.length ? 'ok' : 'empty',
      items: slowest
        .filter((x) => !Number.isNaN(x.points[0]?.[1] ?? NaN))
        .map((x) => ({
          label: labelOf(x.labels.traefik_service ?? ''),
          value: x.points[0]?.[1] ?? 0,
          severity: (x.points[0]?.[1] ?? 0) > 1 ? ('warning' as Severity) : undefined,
        }))
        .sort((a, b) => b.value - a.value),
    },
  ];
}

async function entrypoints(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [byEp, tls, conns, certs, reloads, lastOk, lastFail] = await Promise.all([
    range(
      ctx,
      `sum by (entrypoint) (rate(traefik_entrypoint_requests_total{${s},${EP}}[${RATE}]))`,
    ),
    instant(ctx, `sum by (entrypoint) (rate(traefik_entrypoint_requests_tls_total{${s}}[5m]))`),
    range(ctx, `sum by (entrypoint) (traefik_open_connections{${s},${EP}})`),
    instant(ctx, `min by (cn) (traefik_tls_certs_not_after{${s}})`),
    instant(ctx, `sum(increase(traefik_config_reloads_total{${s}}[${ctx.range}s]))`),
    instant(ctx, `max(traefik_config_last_reload_success{${s}})`),
    instant(ctx, `max(traefik_config_last_reload_failure{${s}})`),
  ]);
  const tlsOf = new Map(tls.map((x) => [x.labels.entrypoint ?? '', val([x]) ?? 0]));
  const ok = val(lastOk);
  const fail = val(lastFail);
  const failed = fail !== null && ok !== null && fail > ok;
  const now = ctx.now / 1000;
  return [
    {
      id: 'by-entrypoint',
      title: `${P}.byEntrypoint`,
      kind: 'stack',
      span: 1,
      unit: 'per_second',
      state: byEp.length ? 'ok' : 'empty',
      note: tls.length
        ? {
            key: `${P}.tlsNote`,
            values: {
              eps: [...tlsOf.entries()]
                .filter(([, v]) => v > 0)
                .map(([k]) => k)
                .join(', '),
            },
          }
        : undefined,
      series: byEp.map((x) => ({ name: x.labels.entrypoint ?? '', points: pointsOf(x) })),
    },
    {
      id: 'connections',
      title: `${P}.openConnections`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: conns.length ? 'ok' : 'empty',
      series: conns.map((x) => ({ name: x.labels.entrypoint ?? '', points: pointsOf(x) })),
    },
    {
      id: 'certificates',
      title: `${P}.certificates`,
      kind: 'table',
      span: 1,
      state: certs.length ? 'ok' : 'empty',
      note: certs.length ? undefined : { key: `${P}.noCertificates` },
      columns: [`${P}.col.cn`, `${P}.col.expires`],
      rows: certs
        .map((x) => ({ cn: x.labels.cn ?? '', at: val([x]) ?? 0 }))
        .sort((a, b) => a.at - b.at)
        .slice(0, 50)
        .map((c) => {
          const left = c.at - now;
          return {
            cells: [c.cn, new Date(c.at * 1000).toISOString().slice(0, 10)],
            severity: left < 3 * DAY ? 'critical' : left < 14 * DAY ? 'warning' : undefined,
          };
        }),
    },
    {
      id: 'reloads',
      title: `${P}.reloads`,
      kind: 'stat',
      span: 1,
      state: ok === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'reloads',
          labelKey: `${P}.reloadsInRange`,
          value: val(reloads) === null ? null : Math.round(val(reloads)!),
          unit: 'count',
        },
        {
          id: 'last',
          labelKey: `${P}.lastReload`,
          value: ok === null ? null : ago(ok, ctx.now),
          severity: failed ? 'warning' : undefined,
          sub: failed
            ? { key: `${P}.lastReloadFailed`, values: { at: ago(fail, ctx.now) } }
            : fail === null && ok !== null
              ? { key: `${P}.reloadFailureV3` }
              : undefined,
        },
      ],
    },
  ];
}

/** How to turn the metrics on, for this Traefik: k3s, Helm, or the three flags. */
export async function metricsSetting(
  ctx: PageContext,
): Promise<{ how: 'k3s' | 'helm' | 'flags'; command: string }> {
  const flags =
    '--entrypoints.metrics.address=:9100 --metrics.prometheus=true --metrics.prometheus.entrypoint=metrics';
  const t = ctx.row.target;
  if (t.kind !== 'workload') return { how: 'flags', command: flags };
  const pod = await ctx.db
    .selectFrom('objects')
    .select(['spec_summary'])
    .where('cluster_id', '=', ctx.row.cluster_id)
    .where('kind', '=', 'Pod')
    .where('namespace', '=', t.namespace)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`spec_summary->'workload'->>'name' = ${t.workload}`)
    .limit(1)
    .executeTakeFirst();
  const spec = (pod?.spec_summary ?? {}) as {
    labels?: Record<string, string>;
    containers?: { image?: string }[];
  };
  const labels = spec.labels ?? {};
  const k3s = (spec.containers ?? []).some((c) => /mirrored-library-traefik/.test(c.image ?? ''));
  if (k3s && t.namespace === 'kube-system') {
    return {
      how: 'k3s',
      command: `apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    metrics:
      prometheus:
        entryPoint: metrics`,
    };
  }
  const release = labels['app.kubernetes.io/instance'];
  if (release && labels['app.kubernetes.io/managed-by'] === 'Helm') {
    return {
      how: 'helm',
      command: `helm upgrade ${release} traefik/traefik -n ${t.namespace} --reuse-values --set metrics.prometheus.entryPoint=metrics`,
    };
  }
  return { how: 'flags', command: flags };
}

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const q = source(ctx);
  const s = one(ctx.row.id);
  const e = traefikExtra(ctx.row);
  const out: Reason[] = [];
  if (e.metrics === false) {
    const how = await metricsSetting(ctx);
    out.push({
      severity: 'info',
      code: 'metrics_off',
      facts: { how: how.how, command: how.command, tried: e.tried ?? null },
    });
  }
  if (!q.traefik) return out;
  const [ratio, top5, p95, certs, reloadOk, reloadFail, svcs, ans] = await Promise.all([
    instant(
      ctx,
      `(sum(increase(${q.req(q.fiveXX)}[5m])) or vector(0)) / (sum(increase(${q.req()}[5m])) > 0)`,
    ),
    // The service sending the most 5xx, and its share of the entrypoints' 5xx.
    instant(
      ctx,
      `topk(1, sum by (traefik_service) (increase(traefik_service_requests_total${svcSel(ctx, 'code=~"5.."')}[5m])) / scalar(sum(increase(${q.req(q.fiveXX)}[5m])) > 0))`,
    ),
    instant(ctx, quantile(0.95, q.bucket, '', '5m')),
    instant(ctx, `min by (cn) (traefik_tls_certs_not_after{${s}}) - time() < ${14 * DAY}`),
    instant(ctx, `max(traefik_config_last_reload_success{${s}})`),
    instant(ctx, `max(traefik_config_last_reload_failure{${s}})`),
    traefikServices(ctx),
    answered(ctx),
  ]);
  // No server up: the outage case, each backend linked so probable cause follows it.
  const down = svcs.filter((x) => x.down);
  for (const d of down.slice(0, 5)) {
    out.push({
      severity: 'critical',
      code: 'no_server_up',
      facts: {
        service: d.name,
        backend: d.backend.kind === 'unknown' ? null : d.backend.label,
        answered: Math.round(ans * 10) / 10,
        servers: d.servers ?? null,
        ready: d.backend.readyEndpoints ?? null,
        state: d.backend.state ?? null,
      },
      links: backendLink(d.backend),
    });
  }
  // Traefik answers 503 itself but no service is known to be down (a route whose backend
  // left the configuration): say so without a backend.
  if (!down.length && ans >= 0.05)
    out.push({
      severity: 'critical',
      code: 'no_server_up',
      facts: { service: null, backend: null, answered: Math.round(ans * 10) / 10 },
    });
  const r = val(ratio);
  if (r !== null && r >= 0.01) {
    const top = top5[0];
    const name = top?.labels.traefik_service ?? null;
    const svc = name ? svcs.find((x) => x.name === name) : undefined;
    let rollout: string | null = null;
    if (svc?.backend.kind === 'workload' && svc.backend.workloadKind) {
      const row = await ctx.db
        .selectFrom('change_markers')
        .select(['ts'])
        .where('cluster_id', '=', ctx.row.cluster_id)
        .where('kind', 'in', ['rollout', 'image'])
        .where(
          'target',
          '=',
          `${svc.backend.workloadKind}/${svc.backend.namespace}/${svc.backend.name}`,
        )
        .where('ts', '>', new Date(ctx.now - DAY * 1000))
        .orderBy('ts', 'desc')
        .executeTakeFirst();
      if (row) rollout = ago(new Date(row.ts).getTime() / 1000, ctx.now);
    }
    out.push({
      severity: r >= 0.05 ? 'critical' : 'warning',
      code: 'errors_high',
      facts: {
        pct: Math.round(r * 1000) / 10,
        // An outage's 503s have no service: the top service is then the one down.
        upstream: svc?.backend.label ?? name ?? down[0]?.backend.label ?? null,
        upstreamPct: top ? Math.round((top.points[0]?.[1] ?? 0) * 1000) / 10 : null,
        rollout,
      },
      links: svc ? backendLink(svc.backend) : undefined,
    });
  }
  const p = val(p95);
  if (p !== null && p > 1)
    out.push({ severity: 'warning', code: 'latency_high', facts: { p95: ms(p) } });
  for (const c of certs.slice(0, 5)) {
    const left = c.points[0]?.[1] ?? 0;
    out.push({
      severity: left < 3 * DAY ? 'critical' : 'warning',
      code: 'certificate_expiring',
      facts: { host: c.labels.cn ?? null, days: Math.max(0, Math.floor(left / DAY)) },
    });
  }
  const ok = val(reloadOk);
  const fail = val(reloadFail);
  if (ok !== null && fail !== null && fail > ok)
    out.push({
      severity: 'warning',
      code: 'config_reload_failed',
      facts: { at: ago(fail, ctx.now), lastOk: ago(ok, ctx.now) },
    });
  return out;
}

export const traefikPage: IntegrationPage = {
  id: 'traefik',
  tabs: [
    { id: 'overview', title: 'integrations.traefik.tabs.overview', panels: overview },
    { id: 'services', title: 'integrations.traefik.tabs.services', panels: services },
    { id: 'entrypoints', title: 'integrations.traefik.tabs.entrypoints', panels: entrypoints },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, clusterId, ids, now }) {
    const scope = { clusterId };
    const sel = `service=~"${ids.map((i) => i.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')).join('|')}",${EP}`;
    const req = `traefik_entrypoint_requests_total{${sel}}`;
    const end = Math.floor(now / 1000 / 300) * 300;
    const [rps, r5, p95, spark] = await Promise.all([
      vm.query(scope, `sum by (service) (rate(${req}[5m]))`),
      vm.query(
        scope,
        `(sum by (service) (rate(traefik_entrypoint_requests_total{${sel},code=~"5.."}[15m])) or sum by (service) (rate(${req}[15m])) * 0) / (sum by (service) (rate(${req}[15m])) > 0)`,
      ),
      vm.query(
        scope,
        `histogram_quantile(0.95, sum by (service, le) (rate(traefik_entrypoint_request_duration_seconds_bucket{${sel}}[5m])))`,
      ),
      vm.queryRange(scope, `sum by (service) (rate(${req}[5m]))`, end - 21_600, end, 300),
    ]);
    const at = (rows: QuerySeries[], id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const ratio = at(r5, id);
      out.set(id, {
        keyMetrics: [
          { id: 'rps', labelKey: `${P}.requests`, value: at(rps, id), unit: 'per_second' },
          {
            id: '5xx',
            labelKey: `${P}.errors15m`,
            value: ratio,
            unit: 'ratio',
            severity:
              ratio === null
                ? undefined
                : ratio >= 0.05
                  ? 'critical'
                  : ratio >= 0.01
                    ? 'warning'
                    : undefined,
          },
          { id: 'p95', labelKey: `${P}.p95`, value: at(p95, id), unit: 'seconds' },
        ],
        spark: spark.find((r) => r.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  reasons,
};
