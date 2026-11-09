// SPDX-License-Identifier: AGPL-3.0-only
// Where an Nginx service's numbers come from (SPEC §4.12, v0.3 slice 10), for its page,
// its list row, its alert rules and MCP alike:
//   - ingress-nginx with its metrics on: the controller's own series, which the
//     collector labels service=<id> (ingress_namespace, ingress, backend, status);
//   - anything else (plain Nginx, or ingress-nginx without --enable-metrics): the node
//     agents' eBPF HTTP series (ADR-139), which carry the workload or container, not the
//     service: they are selected by the service's target and port, and given its id
//     with label_set so a rule or a list sees one series per service.
import type { Database } from '../../db/index.js';

/** As catalog.ts escapes label values (kept here: catalog.ts imports this file). */
const escapeLabelValue = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** One Nginx service as its expressions need it. */
export interface NginxSource {
  id: string;
  /** true: ingress-nginx's own metrics; false: eBPF. */
  ingress: boolean;
  /** The eBPF server series' matchers (workload or container, and port); null: none. */
  server: string | null;
  /** The eBPF client series' matchers (its upstream edges); null: none. */
  client: string | null;
}

type Target =
  | { kind: 'workload'; namespace: string; workload_kind: string; workload: string; port: number }
  | { kind: 'compose'; compose_project: string; compose_service: string; port: number }
  | { kind: 'container'; container: string; port: number }
  | { kind: 'address'; address: string };

const m = (label: string, v: string) => `${label}="${escapeLabelValue(v)}"`;

/** The eBPF source labels of a service's target (the node agents' Source labels). */
export function sourceMatchers(t: Target): string | null {
  switch (t.kind) {
    case 'workload':
      return [
        m('namespace', t.namespace),
        m('workload_kind', t.workload_kind),
        m('workload', t.workload),
      ].join(',');
    case 'compose':
      return [
        m('compose_project', t.compose_project),
        m('compose_service', t.compose_service),
      ].join(',');
    case 'container':
      return m('container', t.container);
    default:
      return null;
  }
}

/** What the collector last said about it: ingress-nginx with metrics, or not. */
export function nginxSource(row: {
  id: string;
  target: unknown;
  status_details: unknown;
}): NginxSource {
  const extra = (
    row.status_details as { extra?: { nginx?: { flavour?: string; metrics?: boolean }[] } } | null
  )?.extra?.nginx?.[0];
  const t = row.target as Target;
  const src = sourceMatchers(t);
  const port = 'port' in t ? t.port : null;
  return {
    id: row.id,
    ingress: extra?.flavour === 'ingress' && extra.metrics === true,
    server: src && port ? `${src},${m('port', String(port))}` : null,
    client: src,
  };
}

/** Kinds of numbers the alert catalog asks for. */
export type NginxMetric = 'requests' | '5xx_ratio' | 'p95' | 'upstream_down' | 'cert_expiry';

const ID = (s: NginxSource, expr: string) =>
  `label_set(${expr}, "service", "${escapeLabelValue(s.id)}", "service_type", "nginx")`;

/**
 * One expression for several services, one series each (labels service and
 * service_type): ingress-nginx's own series by service, the others' eBPF series given
 * their id. `sel` adds the request's scope to the collector's series.
 */
export function nginxExpr(
  metric: NginxMetric,
  sources: NginxSource[],
  sel: (...extra: string[]) => string,
  r: string,
): string {
  const BY = 'service, service_type';
  const parts: string[] = [];
  const ing = (x: string) => parts.push(x);
  switch (metric) {
    case 'requests':
      ing(`sum by (${BY}) (rate(nginx_ingress_controller_requests${sel()}[${r}]))`);
      break;
    case '5xx_ratio':
      ing(
        `sum by (${BY}) (rate(nginx_ingress_controller_requests${sel('status=~"5.."')}[${r}])) / (sum by (${BY}) (rate(nginx_ingress_controller_requests${sel()}[${r}])) > 0)`,
      );
      break;
    case 'p95':
      ing(
        `histogram_quantile(0.95, sum by (${BY}, le) (rate(nginx_ingress_controller_request_duration_seconds_bucket${sel()}[${r}])))`,
      );
      break;
    case 'upstream_down':
      // An Ingress whose backend Service has no ready endpoint (the controller says so).
      ing(
        `max by (${BY}, ingress_namespace, ingress) (nginx_ingress_controller_orphan_ingress${sel('type="no-endpoint"')})`,
      );
      break;
    case 'cert_expiry':
      ing(
        `min by (${BY}, tls_host) (nginx_ingress_controller_ssl_expire_time_seconds${sel()}) - time()`,
      );
      break;
  }
  for (const s of sources) {
    if (s.ingress) continue;
    if (metric === 'requests' && s.server) {
      parts.push(ID(s, `sum(rate(watchlog_http_server_requests_total{${s.server}}[${r}]))`));
    } else if (metric === '5xx_ratio' && s.server) {
      parts.push(
        ID(
          s,
          `sum(rate(watchlog_http_server_requests_total{${s.server},class="5xx"}[${r}])) / (sum(rate(watchlog_http_server_requests_total{${s.server}}[${r}])) > 0)`,
        ),
      );
    } else if (metric === 'p95' && s.server) {
      parts.push(
        ID(
          s,
          `histogram_quantile(0.95, sum by (le) (rate(watchlog_http_server_request_duration_seconds_bucket{${s.server}}[${r}])))`,
        ),
      );
    } else if (metric === 'upstream_down' && s.client) {
      // An upstream every connection to which failed (no endpoint, or none answering).
      const by =
        'dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst_service, dst, dst_port';
      const failed = `sum by (${by}) (increase(watchlog_flow_connect_failed_total{${s.client}}[5m]))`;
      const tried = `sum by (${by}) (increase(watchlog_flow_connections_total{${s.client}}[5m]))`;
      parts.push(ID(s, `(${failed} >= ${tried}) and (${failed} > 0)`));
    }
  }
  return parts.length ? parts.map((p) => `(${p})`).join(' or ') : 'vector(0) < 0';
}

/** A cluster's Nginx services (or one of them) as expression sources. */
export async function nginxSources(
  db: Database,
  clusterId: string,
  serviceId?: string,
): Promise<NginxSource[]> {
  let q = db
    .selectFrom('integrations')
    .select(['id', 'target', 'status_details'])
    .where('cluster_id', '=', clusterId)
    .where('type', '=', 'nginx');
  if (serviceId) q = q.where('id', '=', serviceId);
  return (await q.execute()).map(nginxSource);
}
