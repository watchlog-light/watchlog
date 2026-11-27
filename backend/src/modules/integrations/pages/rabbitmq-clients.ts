// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's clients (1.1.0, ADR-243): every workload or container that opened a connection
// to the broker in the last 24 hours, from the agents' network flows: where it runs, the
// connections it opened, the bytes each way now, and how it ended when it did. Its role is a
// guess from the traffic's direction ("Mostly publishes"), given only when one way clearly
// dominates; RabbitMQ's metrics don't say which client publishes to or consumes which queue.
import { destination, ownComponents, SOURCE } from './connected.js';
import { endedOf } from './rabbitmq.js';
import type { ClientsPanel, PageContext, Severity, Text } from './types.js';

type Row = ClientsPanel['rows'][number];

/** One way at least this many times the other, over the day, names a role. */
export const DOMINANT = 4;
/** Too little traffic over the day to tell anything from its direction (bytes). */
export const ROLE_MIN_BYTES = 64 * 1024;

/**
 * A client's role from 24 hours of bytes each way: it sends far more than it receives
 * (publishes), or the other way round (consumes); null when neither clearly dominates.
 */
export function mostlyOf(sent: number, received: number): Row['mostly'] {
  if (sent + received < ROLE_MIN_BYTES) return null;
  if (sent >= DOMINANT * received) return 'publishes';
  if (received >= DOMINANT * sent) return 'consumes';
  return null;
}

const keyOf = (l: Record<string, string>) =>
  [l.namespace, l.workload_kind, l.workload, l.container, l.compose_project, l.compose_service]
    .map((v) => v ?? '')
    .join('\u0000');

export async function clientRows(ctx: PageContext): Promise<Row[]> {
  if (!ctx.vm) return [];
  const dst = await destination(ctx);
  if (!dst) return [];
  const port = 'port' in ctx.row.target ? ctx.row.target.port : null;
  const sel = `${dst}${port ? `,dst_port="${port}"` : ''}`;
  const at = Math.floor(ctx.now / 1000);
  const q = (e: string) => ctx.vm!.query(ctx.scope, e, at);
  const [conns, day, now, own, hosts] = await Promise.all([
    q(`sum by (${SOURCE}) (increase(watchlog_flow_connections_total{${sel}}[24h]))`),
    q(`sum by (${SOURCE}, dir) (increase(watchlog_flow_bytes_total{${sel}}[24h]))`),
    q(`sum by (${SOURCE}, dir) (rate(watchlog_flow_bytes_total{${sel}}[5m]))`),
    ownComponents(ctx),
    // A container's page is under its host.
    q(
      `max by (container, host) (present_over_time(watchlog_flow_connections_total{${sel},container!=""}[24h]))`,
    ),
  ]);
  const hostOf = new Map(hosts.map((h) => [h.labels.container ?? '', h.labels.host ?? '']));
  const bytes = (rows: typeof day) => {
    const m = new Map<string, { sent: number; received: number }>();
    for (const r of rows) {
      const k = keyOf(r.labels);
      const v = m.get(k) ?? { sent: 0, received: 0 };
      if (r.labels.dir === 'sent') v.sent += r.points[0]?.[1] ?? 0;
      else if (r.labels.dir === 'received') v.received += r.points[0]?.[1] ?? 0;
      m.set(k, v);
    }
    return m;
  };
  const dayBy = bytes(day);
  const nowBy = bytes(now);
  // Who connected in the day: by connections opened, or by traffic (a long-lived connection
  // opened earlier still moves bytes).
  const who = new Map<string, Record<string, string>>();
  for (const r of [...conns, ...day]) who.set(keyOf(r.labels), r.labels);
  const opened = new Map(conns.map((c) => [keyOf(c.labels), c.points[0]?.[1] ?? 0]));
  const rows: Row[] = [];
  for (const [k, l] of who) {
    if (l.workload && own.workloads.has(`${l.namespace}/${l.workload}`)) continue;
    if (!l.workload && l.container && own.containers.has(l.container)) continue;
    if (!l.workload && !l.container) continue;
    const d = dayBy.get(k) ?? { sent: 0, received: 0 };
    const n = nowBy.get(k);
    const ended = l.workload
      ? await endedOf(
          ctx,
          { namespace: l.namespace ?? '', workload: l.workload, workload_kind: l.workload_kind },
          null,
        )
      : await endedOf(ctx, { container: l.container! }, null);
    const quiet = !n || n.sent + n.received < 1;
    let state: Text = { key: quiet ? 'quiet' : 'running' };
    let severity: Severity | undefined;
    if (ended) {
      state = { key: 'ended', values: { how: ended.how, at: ended.at } };
      severity = /OOM|CrashLoop|gone|Exited \((?!0\))/.test(ended.how) ? 'critical' : 'warning';
    }
    const where: Text = l.workload
      ? {
          key: 'whereWorkload',
          values: { namespace: l.namespace ?? '', kind: l.workload_kind ?? '' },
        }
      : { key: 'whereContainer', values: { project: l.compose_project ?? '' } };
    rows.push({
      name: l.workload ? `${l.namespace ? `${l.namespace}/` : ''}${l.workload}` : l.container!,
      link: l.workload
        ? {
            kind: 'workload',
            id: `${l.namespace ?? ''}/${l.workload_kind ?? ''}/${l.workload}`,
            name: l.workload,
          }
        : {
            kind: 'container',
            // host/name: the container's page; the name alone when the host isn't known.
            id: hostOf.get(l.container!)
              ? `${hostOf.get(l.container!)}/${l.container!}`
              : l.container!,
            name: l.container!,
          },
      where,
      connections: Math.round(opened.get(k) ?? 0),
      sends: n ? Math.round(n.sent) : null,
      receives: n ? Math.round(n.received) : null,
      mostly: mostlyOf(d.sent, d.received),
      state,
      ...(severity ? { severity } : {}),
    });
  }
  const sev = (r: Row) => (r.severity === 'critical' ? 0 : r.severity === 'warning' ? 1 : 2);
  return rows.sort(
    (a, b) =>
      sev(a) - sev(b) ||
      (b.sends ?? 0) + (b.receives ?? 0) - ((a.sends ?? 0) + (a.receives ?? 0)) ||
      a.name.localeCompare(b.name),
  );
}
