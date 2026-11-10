// SPDX-License-Identifier: AGPL-3.0-only
// The Nginx page (SPEC §4.12, v0.3 slice 10): Overview, Errors, Latency and Connections.
// Requests, errors and latency come from ingress-nginx's own metrics when it serves
// them, else from the node agents' eBPF HTTP stats (ADR-139), with nothing to set up;
// connections from ingress-nginx or stub_status. Upstreams are the backend Services
// (ingress-nginx) or the edges Nginx opens (eBPF). Reasons: 5xx, an upstream without
// endpoints, latency, dropped connections, an expiring certificate, and the hints for
// stub_status and ingress-nginx's metrics.
import { sql } from 'kysely';
import { nginxExpr, nginxSource, type NginxSource } from '../../query/nginx.js';
import { genericPage } from './generic.js';
import { ago } from './owners.js';
import { instant, one, pointsOf, range, windowOf, type Window } from './query.js';
import type { QuerySeries } from '../../../lib/victoria.js';
import type { IntegrationPage, PageContext, Panel, Reason, RowMetrics, Severity } from './types.js';

const P = 'integrations.nginx.panels';
const RATE = '2m';
const BURST_RATIO = 0.05;
const DAY = 86_400;

interface Extra {
  flavour?: 'ingress' | 'plain';
  metrics?: boolean;
  stub_status?: string;
  stub_missing?: number;
  /** What each place answered when none was stub_status (":8080/stub_status: 404"). */
  stub_tried?: string;
}
/** What the collector says this Nginx is: one row of its status's extra.nginx. */
const extra = (ctx: PageContext): Extra =>
  (ctx.row.status_details as { extra?: { nginx?: Extra[] } } | null)?.extra?.nginx?.[0] ?? {};

/** The expressions of one service, whichever source it has. */
interface Q {
  src: NginxSource;
  /** Requests (a counter), with an extra matcher: 5xx, 4xx or none. */
  req(m?: '5xx' | '4xx'): string | null;
  /** By status class (label class: 2xx…5xx) over a window. */
  byClass(w: string): string | null;
  /** By exact code (label code) over a window. */
  byCode(w: string): string | null;
  bucket: string | null;
  /** Upstream requests and their labels. */
  upReq(m?: '5xx'): string | null;
  upBucket: string | null;
  upBy: string;
  bytesOut: string | null;
  /** Connections by state (active, reading, writing, waiting). */
  conns: string | null;
  accepted: string | null;
  handled: string | null;
}

function queries(ctx: PageContext): Q {
  const src = nginxSource(ctx.row);
  const s = one(ctx.row.id);
  // Plain Nginx's connections: only once its stub_status was found.
  const stub = extra(ctx).flavour !== 'ingress' && !!extra(ctx).stub_status;
  if (src.ingress) {
    const st = (m?: '5xx' | '4xx') =>
      m === '5xx' ? ',status=~"5.."' : m === '4xx' ? ',status=~"4.."' : '';
    return {
      src,
      req: (m) => `nginx_ingress_controller_requests{${s}${st(m)}}`,
      byClass: (w) =>
        `sum by (class) (label_replace(rate(nginx_ingress_controller_requests{${s}}[${w}]), "class", "\${1}xx", "status", "([1-5]).."))`,
      byCode: (w) =>
        `sum by (code) (label_replace(increase(nginx_ingress_controller_requests{${s}}[${w}]), "code", "$1", "status", "(.+)"))`,
      bucket: `nginx_ingress_controller_request_duration_seconds_bucket{${s}}`,
      upReq: (m) => `nginx_ingress_controller_requests{${s}${st(m)}}`,
      upBucket: `nginx_ingress_controller_request_duration_seconds_bucket{${s}}`,
      upBy: 'ingress_namespace, backend',
      bytesOut: `nginx_ingress_controller_response_size_sum{${s}}`,
      conns: `nginx_ingress_controller_nginx_process_connections{${s}}`,
      accepted: `nginx_ingress_controller_nginx_process_connections_total{${s},state="accepted"}`,
      handled: `nginx_ingress_controller_nginx_process_connections_total{${s},state="handled"}`,
    };
  }
  const cl = (m?: '5xx' | '4xx') => (m ? `,class="${m}"` : '');
  const T = src.server;
  const C = src.client;
  return {
    src,
    req: (m) => (T ? `watchlog_http_server_requests_total{${T}${cl(m)}}` : null),
    byClass: (w) =>
      T ? `sum by (class) (rate(watchlog_http_server_requests_total{${T}}[${w}]))` : null,
    byCode: (w) =>
      T ? `sum by (code) (increase(watchlog_http_server_requests_total{${T}}[${w}]))` : null,
    bucket: T ? `watchlog_http_server_request_duration_seconds_bucket{${T}}` : null,
    upReq: (m) => (C ? `watchlog_http_requests_total{${C}${cl(m)}}` : null),
    upBucket: C ? `watchlog_http_request_duration_seconds_bucket{${C}}` : null,
    upBy: 'dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst_service, dst, dst_port',
    bytesOut: null,
    conns: stub
      ? `label_replace(watchlog_nginx_connections_active{${s}}, "state", "active", "", "") or watchlog_nginx_connections{${s}}`
      : null,
    accepted: stub ? `watchlog_nginx_connections_accepted_total{${s}}` : null,
    handled: stub ? `watchlog_nginx_connections_handled_total{${s}}` : null,
  };
}

const maybe = (ctx: PageContext, expr: string | null, ranged = false) =>
  expr ? (ranged ? range(ctx, expr) : instant(ctx, expr)) : Promise.resolve([] as QuerySeries[]);
const val = (rows: QuerySeries[]) => rows[0]?.points[0]?.[1] ?? null;

/** An upstream's name from its labels: namespace/Service, else the workload, else dst. */
export function upstreamName(l: Record<string, string>): string {
  if (l.backend) return l.ingress_namespace ? `${l.ingress_namespace}/${l.backend}` : l.backend;
  if (l.dst_service) return l.dst_namespace ? `${l.dst_namespace}/${l.dst_service}` : l.dst_service;
  if (l.dst_workload)
    return l.dst_namespace ? `${l.dst_namespace}/${l.dst_workload}` : l.dst_workload;
  // A container, or an address: which port matters (one may answer, another refuse).
  const dst = l.dst ?? '?';
  return l.dst_port ? `${dst}:${l.dst_port}` : dst;
}

interface Upstream {
  name: string;
  /** null: not known (no Service object, no connection tried). */
  ready: boolean | null;
  readyEndpoints?: number;
  /** Its workload, for links and rollouts. */
  workload?: { kind: string; namespace: string; name: string };
}

/**
 * The upstreams of the last hour, and whether each is ready: a Service with ready
 * endpoints (Kubernetes, from the cluster-agent's Service status), or one whose
 * connections don't all fail (Docker, from the flow series).
 */
async function upstreams(ctx: PageContext, q: Q): Promise<Upstream[]> {
  const up = q.upReq();
  if (!up) return [];
  const docker = ctx.row.target.kind === 'compose' || ctx.row.target.kind === 'container';
  const seen = await instant(ctx, `sum by (${q.upBy}) (increase(${up}[1h])) > 0`);
  if (docker) {
    if (!q.src.client) return [];
    const by = q.upBy;
    const [failed, tried] = await Promise.all([
      instant(
        ctx,
        `sum by (${by}) (increase(watchlog_flow_connect_failed_total{${q.src.client}}[5m]))`,
      ),
      instant(
        ctx,
        `sum by (${by}) (increase(watchlog_flow_connections_total{${q.src.client}}[5m]))`,
      ),
    ]);
    const key = (l: Record<string, string>) => upstreamName(l);
    const f = new Map(failed.map((x) => [key(x.labels), x.points[0]?.[1] ?? 0]));
    const t = new Map(tried.map((x) => [key(x.labels), x.points[0]?.[1] ?? 0]));
    const names = new Set([...seen.map((x) => key(x.labels)), ...f.keys()]);
    return [...names].map((name) => {
      const fails = f.get(name) ?? 0;
      const tries = t.get(name) ?? 0;
      return { name, ready: tries === 0 && fails === 0 ? null : !(fails > 0 && fails >= tries) };
    });
  }
  // Kubernetes: the Services behind them.
  const pairs = new Map<string, { namespace: string; service: string }>();
  for (const x of seen) {
    const l = x.labels;
    const ns = l.ingress_namespace ?? l.dst_namespace;
    const svc = l.backend ?? l.dst_service;
    if (ns && svc) pairs.set(`${ns}/${svc}`, { namespace: ns, service: svc });
  }
  if (!pairs.size) return [];
  const rows = await ctx.db
    .selectFrom('objects')
    .select(['namespace', 'name', 'status_summary'])
    .where('cluster_id', '=', ctx.row.cluster_id)
    .where('kind', '=', 'Service')
    .where('deleted_at', 'is', null)
    .where(
      'namespace',
      'in',
      [...pairs.values()].map((p) => p.namespace),
    )
    .execute();
  const byName = new Map(rows.map((r) => [`${r.namespace}/${r.name}`, r]));
  return [...pairs.entries()].map(([name, p]) => {
    const r = byName.get(name);
    if (!r) return { name, ready: null };
    const st = r.status_summary as {
      ready_endpoints?: number;
      workloads?: { kind: string; name: string }[];
    };
    const w = st.workloads?.[0];
    return {
      name,
      ready: (st.ready_endpoints ?? 0) > 0,
      readyEndpoints: st.ready_endpoints ?? 0,
      workload: w ? { kind: w.kind, namespace: p.namespace, name: w.name } : undefined,
    };
  });
}

const quantile = (q: number, bucket: string, by = '', w = RATE) =>
  `histogram_quantile(${q}, sum by (${by ? `${by}, ` : ''}le) (rate(${bucket}[${w}])))`;

async function overview(ctx: PageContext): Promise<Panel[]> {
  const q = queries(ctx);
  const req = q.req();
  const [rps, peak, ratio5xx, p95, p50, bytes, classes, p50s, p95s, p99s, busiest, ups, connNow] =
    await Promise.all([
      maybe(ctx, req && `sum(rate(${req}[${RATE}]))`),
      maybe(ctx, req && `max_over_time(sum(rate(${req}[${RATE}]))[${ctx.range}s:1m])`),
      maybe(
        ctx,
        req &&
          `(sum(increase(${q.req('5xx')}[15m])) or vector(0)) / (sum(increase(${req}[15m])) > 0)`,
      ),
      maybe(ctx, q.bucket && quantile(0.95, q.bucket, '', '5m')),
      maybe(ctx, q.bucket && quantile(0.5, q.bucket, '', '5m')),
      maybe(ctx, q.bytesOut && `sum(rate(${q.bytesOut}[${RATE}]))`),
      maybe(ctx, q.byClass(RATE), true),
      maybe(ctx, q.bucket && quantile(0.5, q.bucket), true),
      maybe(ctx, q.bucket && quantile(0.95, q.bucket), true),
      maybe(ctx, q.bucket && quantile(0.99, q.bucket), true),
      maybe(ctx, q.upReq() && `topk(10, sum by (${q.upBy}) (rate(${q.upReq()}[${ctx.range}s])))`),
      upstreams(ctx, q),
      connectionsNow(ctx, q),
    ]);
  const r5 = val(ratio5xx);
  const readyN = ups.filter((u) => u.ready === true).length;
  const known = ups.filter((u) => u.ready !== null).length;
  const empty = val(rps) === null && connNow.active === null;
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: empty ? 'empty' : 'ok',
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
        {
          id: 'connections',
          labelKey: `${P}.connections`,
          value: connNow.active,
          unit: 'count',
          sub:
            connNow.waiting !== null
              ? { key: `${P}.waitingSub`, values: { n: connNow.waiting } }
              : { key: `${P}.noConnections` },
        },
        {
          id: 'upstreams',
          labelKey: `${P}.upstreams`,
          value: ups.length ? `${readyN}/${known || ups.length}` : null,
          severity: known && readyN < known ? 'critical' : known ? 'ok' : undefined,
        },
        {
          id: 'bandwidth',
          labelKey: `${P}.bandwidth`,
          value: val(bytes),
          unit: 'bytes_per_second',
          sub: q.bytesOut ? undefined : { key: `${P}.bandwidthIngressOnly` },
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
      note: q.src.ingress ? undefined : { key: `${P}.ebpfNote` },
      series: classOrder(classes),
    },
    {
      id: 'latency',
      title: `${P}.latency`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: p95s.length ? 'ok' : 'empty',
      note: q.src.ingress ? undefined : { key: `${P}.ttfbNote` },
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
        .map((x) => ({
          label: upstreamName(x.labels),
          value: x.points[0]?.[1] ?? 0,
          severity:
            ups.find((u) => u.name === upstreamName(x.labels))?.ready === false
              ? ('critical' as Severity)
              : undefined,
        }))
        .sort((a, b) => b.value - a.value),
    },
  ];
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

const ms = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);

async function connectionsNow(ctx: PageContext, q: Q) {
  if (!q.conns) return { active: null as number | null, waiting: null as number | null };
  const rows = await instant(ctx, `sum by (state) (${q.conns})`);
  const of = (s: string) => rows.find((r) => r.labels.state === s)?.points[0]?.[1] ?? null;
  return { active: of('active'), waiting: of('waiting') };
}

/** Periods where an upstream's 5xx share was ≥ 5 %, from the page's window. */
export function bursts(
  series: { name: string; points: [number, number | null][] }[],
  w: Window,
  rollouts: Map<string, number[]>,
): { upstream: string; start: number; end: number; peak: number; rollout: boolean }[] {
  const out: { upstream: string; start: number; end: number; peak: number; rollout: boolean }[] =
    [];
  for (const s of series) {
    let cur: { start: number; end: number; peak: number } | null = null;
    const close = () => {
      if (!cur) return;
      const times = rollouts.get(s.name) ?? [];
      const rollout = times.some((t) => t >= cur!.start - 10 * 60 && t <= cur!.end);
      out.push({ upstream: s.name, ...cur, rollout });
      cur = null;
    };
    for (const [t, v] of s.points) {
      if (v !== null && v >= BURST_RATIO) {
        if (cur) {
          cur.end = t + w.step;
          cur.peak = Math.max(cur.peak, v);
        } else cur = { start: t, end: t + w.step, peak: v };
      } else close();
    }
    close();
  }
  return out.sort((a, b) => b.start - a.start).slice(0, 20);
}

async function rolloutTimes(ctx: PageContext, ups: Upstream[]): Promise<Map<string, number[]>> {
  const targets = new Map<string, string>();
  for (const u of ups) {
    if (u.workload)
      targets.set(`${u.workload.kind}/${u.workload.namespace}/${u.workload.name}`, u.name);
  }
  const out = new Map<string, number[]>();
  if (!targets.size) return out;
  const rows = await ctx.db
    .selectFrom('change_markers')
    .select(['target', 'ts'])
    .where('cluster_id', '=', ctx.row.cluster_id)
    .where('kind', 'in', ['rollout', 'image'])
    .where('target', 'in', [...targets.keys()])
    .where('ts', '>', new Date(ctx.now - Math.max(ctx.range, DAY) * 1000))
    .execute();
  for (const r of rows) {
    const name = targets.get(r.target)!;
    out.set(name, [...(out.get(name) ?? []), new Date(r.ts).getTime() / 1000]);
  }
  return out;
}

async function errors(ctx: PageContext): Promise<Panel[]> {
  const q = queries(ctx);
  const up5 = q.upReq('5xx');
  const up = q.upReq();
  const [byUpstream, codes, ratios, ups] = await Promise.all([
    maybe(ctx, up5 && `sum by (${q.upBy}) (rate(${up5}[${RATE}])) > 0`, true),
    maybe(ctx, q.byCode('1h')),
    maybe(
      ctx,
      up5 &&
        up &&
        `sum by (${q.upBy}) (rate(${up5}[1m])) / (sum by (${q.upBy}) (rate(${up}[1m])) > 0)`,
      true,
    ),
    upstreams(ctx, q),
  ]);
  const w = windowOf(ctx.range, ctx.now);
  const found = bursts(
    ratios.map((x) => ({ name: upstreamName(x.labels), points: pointsOf(x) })),
    w,
    await rolloutTimes(ctx, ups),
  );
  return [
    {
      id: 'by-upstream',
      title: `${P}.errorsByUpstream`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: byUpstream.length ? 'ok' : 'empty',
      series: byUpstream.map((x) => ({ name: upstreamName(x.labels), points: pointsOf(x) })),
    },
    {
      id: 'codes',
      title: `${P}.codes`,
      kind: 'bars',
      span: 1,
      unit: 'count',
      state: codes.some((c) => (c.points[0]?.[1] ?? 0) > 0) ? 'ok' : 'empty',
      note: { key: q.src.ingress ? `${P}.codesIngressNote` : `${P}.codesEbpfNote` },
      items: codes
        .map((c) => ({
          label: c.labels.code ?? '',
          value: Math.round(c.points[0]?.[1] ?? 0),
          severity: (c.labels.code ?? '').startsWith('5')
            ? ('critical' as Severity)
            : (c.labels.code ?? '').startsWith('4')
              ? ('warning' as Severity)
              : undefined,
        }))
        .filter((c) => c.value > 0)
        .sort((a, b) => b.value - a.value),
    },
    {
      id: 'bursts',
      title: `${P}.bursts`,
      kind: 'table',
      span: 1,
      state: found.length ? 'ok' : 'empty',
      note: { key: `${P}.burstsNote` },
      columns: [`${P}.cols.upstream`, `${P}.cols.when`, `${P}.cols.duration`, `${P}.cols.peak`],
      rows: found.map((b) => ({
        cells: [
          b.rollout ? `${b.upstream} · during rollout` : b.upstream,
          ago(b.start, ctx.now),
          `${Math.max(1, Math.round((b.end - b.start) / 60))} min`,
          `${Math.round(b.peak * 100)} %`,
        ],
        severity: b.peak >= 0.05 ? 'critical' : 'warning',
      })),
    },
  ];
}

const LE_LABEL = (le: number) => (le < 1 ? `≤${Math.round(le * 1000)} ms` : `≤${+le.toFixed(1)} s`);

async function latency(ctx: PageContext): Promise<Panel[]> {
  const q = queries(ctx);
  const [buckets, slowest, p95by] = await Promise.all([
    maybe(ctx, q.bucket && `sum by (le) (increase(${q.bucket}[${ctx.range}s]))`),
    maybe(
      ctx,
      q.upBucket && `topk(10, ${quantile(0.95, q.upBucket, q.upBy, `${ctx.range}s`)} > 0)`,
    ),
    maybe(ctx, q.upBucket && `topk(8, ${quantile(0.95, q.upBucket, q.upBy, '5m')})`, true),
  ]);
  const sorted = buckets
    .map((b) => ({ le: Number(b.labels.le), n: b.points[0]?.[1] ?? 0 }))
    .filter((b) => Number.isFinite(b.le))
    .sort((a, b) => a.le - b.le);
  const total =
    buckets.find((b) => b.labels.le === '+Inf')?.points[0]?.[1] ?? sorted.at(-1)?.n ?? 0;
  const hist = sorted.map((b, i) => ({
    label: LE_LABEL(b.le),
    share: total ? Math.max(0, b.n - (sorted[i - 1]?.n ?? 0)) / total : 0,
  }));
  return [
    {
      id: 'duration',
      title: `${P}.duration`,
      kind: 'hist',
      span: 1,
      state: total > 0 ? 'ok' : 'empty',
      note: { key: q.src.ingress ? `${P}.durationIngressNote` : `${P}.ttfbNote` },
      buckets: hist,
    },
    {
      id: 'slowest',
      title: `${P}.slowest`,
      kind: 'bars',
      span: 1,
      unit: 'seconds',
      state: slowest.length ? 'ok' : 'empty',
      items: slowest
        .map((x) => ({
          label: upstreamName(x.labels),
          value: x.points[0]?.[1] ?? 0,
          severity: (x.points[0]?.[1] ?? 0) > 1 ? ('warning' as Severity) : undefined,
        }))
        .sort((a, b) => b.value - a.value),
    },
    {
      id: 'p95-by-upstream',
      title: `${P}.p95ByUpstream`,
      kind: 'line',
      span: 2,
      unit: 'seconds',
      state: p95by.length ? 'ok' : 'empty',
      series: p95by.map((x) => ({ name: upstreamName(x.labels), points: pointsOf(x) })),
    },
  ];
}

async function connections(ctx: PageContext): Promise<Panel[]> {
  const q = queries(ctx);
  const e = extra(ctx);
  if (!q.conns) {
    // ingress-nginx without its metrics, or plain Nginx without stub_status.
    const missing =
      e.flavour === 'ingress'
        ? { key: `${P}.missingIngressMetrics` }
        : { key: `${P}.missingStubStatus` };
    return [
      {
        id: 'states',
        title: `${P}.connectionStates`,
        kind: 'stack',
        span: 2,
        unit: 'count',
        state: 'needs_permission',
        missing,
        series: [],
      },
    ];
  }
  const [states, accepted, handled] = await Promise.all([
    range(ctx, `sum by (state) (${q.conns})`),
    maybe(ctx, q.accepted && `sum(rate(${q.accepted}[${RATE}]))`, true),
    maybe(ctx, q.handled && `sum(rate(${q.handled}[${RATE}]))`, true),
  ]);
  const acc = pointsOf(accepted[0]);
  const han = pointsOf(handled[0]);
  const dropped = acc.map(([t, v], i) => {
    const h = han[i]?.[1];
    return [t, v !== null && h !== null && h !== undefined ? Math.max(0, v - h) : null] as [
      number,
      number | null,
    ];
  });
  const of = (s: string) => states.find((x) => x.labels.state === s);
  return [
    {
      id: 'states',
      title: `${P}.connectionStates`,
      kind: 'stack',
      span: 2,
      unit: 'count',
      state: states.length ? 'ok' : 'empty',
      series: ['waiting', 'reading', 'writing']
        .filter((s) => of(s))
        .map((s) => ({ nameKey: `${P}.series.${s}`, points: pointsOf(of(s)) })),
    },
    {
      id: 'accepted',
      title: `${P}.acceptedDropped`,
      kind: 'line',
      span: 2,
      unit: 'per_second',
      state: acc.length ? 'ok' : 'empty',
      note: { key: `${P}.droppedNote` },
      series: [
        { nameKey: `${P}.series.accepted`, points: acc },
        { nameKey: `${P}.series.dropped`, points: dropped, severity: 'critical' },
      ],
    },
  ];
}

/** ingress-nginx's command to serve its metrics: Helm's when the chart installed it. */
async function metricsCommand(ctx: PageContext): Promise<string> {
  const t = ctx.row.target;
  if (t.kind !== 'workload') return '';
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
  const labels =
    (pod?.spec_summary as { labels?: Record<string, string> } | undefined)?.labels ?? {};
  const release = labels['app.kubernetes.io/instance'];
  if (release && labels['app.kubernetes.io/managed-by'] === 'Helm') {
    return `helm upgrade ${release} ingress-nginx/ingress-nginx -n ${t.namespace} --reuse-values --set controller.metrics.enabled=true`;
  }
  return `kubectl -n ${t.namespace} patch ${t.workload_kind.toLowerCase()} ${t.workload} --type json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--enable-metrics=true"}]'`;
}

export const STUB_SNIPPET = `server {
    listen 8080;
    location = /stub_status {
        stub_status;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        allow 127.0.0.1;
        deny all;
    }
}`;

async function reasons(ctx: PageContext): Promise<Reason[]> {
  const q = queries(ctx);
  const e = extra(ctx);
  const up5 = q.upReq('5xx');
  const req = q.req();
  const [ratio, topUp, p95, accepted, handled, certs, orphans, ups] = await Promise.all([
    maybe(
      ctx,
      req && `(sum(increase(${q.req('5xx')}[5m])) or vector(0)) / (sum(increase(${req}[5m])) > 0)`,
    ),
    // The upstream sending the most 5xx, and its share of them.
    maybe(
      ctx,
      up5 &&
        `topk(1, sum by (${q.upBy}) (increase(${up5}[5m])) / scalar(sum(increase(${up5}[5m])) > 0))`,
    ),
    maybe(ctx, q.bucket && quantile(0.95, q.bucket, '', '5m')),
    maybe(ctx, q.accepted && `sum(increase(${q.accepted}[15m]))`),
    maybe(ctx, q.handled && `sum(increase(${q.handled}[15m]))`),
    q.src.ingress
      ? instant(
          ctx,
          `min by (tls_host) (nginx_ingress_controller_ssl_expire_time_seconds{${one(ctx.row.id)}}) - time() < ${14 * DAY}`,
        )
      : Promise.resolve([] as QuerySeries[]),
    q.src.ingress
      ? instant(
          ctx,
          `max by (ingress_namespace, ingress) (nginx_ingress_controller_orphan_ingress{${one(ctx.row.id)},type="no-endpoint"}) > 0`,
        )
      : Promise.resolve([] as QuerySeries[]),
    upstreams(ctx, q),
  ]);
  const out: Reason[] = [];
  const r = val(ratio);
  if (r !== null && r >= 0.01) {
    const top = topUp[0];
    const name = top ? upstreamName(top.labels) : null;
    const u = ups.find((x) => x.name === name);
    const rollouts = u ? await rolloutTimes(ctx, [u]) : new Map<string, number[]>();
    const last = name ? (rollouts.get(name) ?? []).sort((a, b) => b - a)[0] : undefined;
    out.push({
      severity: r >= 0.05 ? 'critical' : 'warning',
      code: 'errors_high',
      facts: {
        pct: Math.round(r * 1000) / 10,
        upstream: name,
        upstreamPct: top ? Math.round((top.points[0]?.[1] ?? 0) * 1000) / 10 : null,
        rollout: last ? ago(last, ctx.now) : null,
      },
      links: u?.workload
        ? [
            {
              kind: 'workload',
              id: `${u.workload.namespace}/${u.workload.kind}/${u.workload.name}`,
              name: u.workload.name,
            },
          ]
        : undefined,
    });
  }
  const down = ups.filter((u) => u.ready === false);
  for (const o of orphans) {
    const name = `${o.labels.ingress_namespace}/${o.labels.ingress}`;
    if (!down.some((d) => d.name.startsWith(`${o.labels.ingress_namespace}/`)))
      out.push({ severity: 'critical', code: 'upstream_no_endpoints', facts: { upstream: name } });
  }
  for (const u of down.slice(0, 5)) {
    out.push({
      severity: 'critical',
      code: 'upstream_no_endpoints',
      facts: { upstream: u.name },
      links: u.workload
        ? [
            {
              kind: 'workload',
              id: `${u.workload.namespace}/${u.workload.kind}/${u.workload.name}`,
              name: u.workload.name,
            },
          ]
        : ctx.row.target.kind !== 'workload'
          ? [{ kind: 'container', id: u.name.replace(/:\d+$/, ''), name: u.name }]
          : undefined,
    });
  }
  const p = val(p95);
  if (p !== null && p > 1)
    out.push({ severity: 'warning', code: 'latency_high', facts: { p95: ms(p) } });
  const a = val(accepted);
  const h = val(handled);
  if (a !== null && h !== null && a - h >= 1)
    out.push({ severity: 'warning', code: 'connections_dropped', facts: { n: Math.round(a - h) } });
  for (const c of certs.slice(0, 5)) {
    const left = c.points[0]?.[1] ?? 0;
    out.push({
      severity: left < 3 * DAY ? 'critical' : 'warning',
      code: 'certificate_expiring',
      facts: { host: c.labels.tls_host ?? null, days: Math.max(0, Math.floor(left / DAY)) },
    });
  }
  if (e.flavour === 'ingress' && e.metrics === false) {
    out.push({
      severity: 'info',
      code: 'ingress_metrics_off',
      facts: { command: await metricsCommand(ctx) },
    });
  } else if (e.flavour === 'plain' && !e.stub_status && (e.stub_missing ?? 0) > 0) {
    out.push({
      severity: 'info',
      code: 'stub_status_missing',
      facts: { command: STUB_SNIPPET, tried: e.stub_tried ?? null },
    });
  }
  if (!q.src.ingress && !q.src.server)
    out.push({ severity: 'info', code: 'no_http_source', facts: {} });
  return out;
}

export const nginxPage: IntegrationPage = {
  id: 'nginx',
  tabs: [
    { id: 'overview', title: 'integrations.nginx.tabs.overview', panels: overview },
    { id: 'errors', title: 'integrations.nginx.tabs.errors', panels: errors },
    { id: 'latency', title: 'integrations.nginx.tabs.latency', panels: latency },
    { id: 'connections', title: 'integrations.nginx.tabs.connections', panels: connections },
    {
      id: 'connection',
      title: 'integrations.tabs.connection',
      panels: genericPage.tabs[0]!.panels,
    },
  ],

  async listMetrics({ vm, clusterId, ids, rows, now }) {
    const scope = { clusterId };
    const sources = (rows ?? []).filter((r) => ids.includes(r.id)).map(nginxSource);
    const sel = (...extra: string[]) =>
      `{${[...extra, `service=~"${ids.map((i) => i.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')).join('|')}"`].join(',')}}`;
    const end = Math.floor(now / 1000 / 300) * 300;
    const [rps, r5, p95, spark] = await Promise.all([
      vm.query(scope, nginxExpr('requests', sources, sel, '5m')),
      vm.query(scope, nginxExpr('5xx_ratio', sources, sel, '15m')),
      vm.query(scope, nginxExpr('p95', sources, sel, '5m')),
      vm.queryRange(scope, nginxExpr('requests', sources, sel, '5m'), end - 21_600, end, 300),
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
