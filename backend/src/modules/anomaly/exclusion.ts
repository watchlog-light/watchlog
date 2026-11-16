// SPDX-License-Identifier: AGPL-3.0-only
// Learning leaves incidents out (ADR-196): a minute is left out of a series' baseline when an
// alert other than an anomaly alert was firing on its subject, the subject's workload or
// Compose service, or a pod or container of it. Anomaly alerts' own minutes stay in, so a
// lasting change becomes the new normal.
//
// Alerts and series name their subjects differently (slice 1, ADR-196's as-built note):
//   Kubernetes alerts: `namespace, workload_kind, workload` (pod alerts add `pod, node`);
//     a node alert has `node` and no workload or pod;
//   Docker alerts: `container` with the host as `node` (series say `host`); Compose-level
//     alerts `compose_project, compose_service`; a host alert `node` (and `mount`) alone;
//   integration alerts: `service`; failed connections add their destination (`dst_*`).
// Both sides become subject tokens; a minute is left out when they share one.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { ClusterKind } from './keys.js';

/** The default rule key of anomaly alerts (ADR-200); built in slice 4. */
export const ANOMALY_RULE_KEY = 'anomaly.unusual';

/** Docker: the Compose project and service of each container, by container name. */
export type ComposeOf = Map<string, { project: string; service: string }>;

const workload = (ns?: string, kind?: string, name?: string) =>
  ns && kind && name ? `w:${ns}/${kind}/${name}` : null;
const container = (name?: string) => (name ? `c:${name}` : null);
const compose = (project?: string, service?: string) =>
  project && service ? `s:${project}/${service}` : null;

function withCompose(out: (string | null)[], name: string | undefined, of: ComposeOf) {
  const c = name ? of.get(name) : undefined;
  if (c) out.push(compose(c.project, c.service));
}

/**
 * The subjects a series belongs to. A container is named by its name alone: a Compose
 * re-create keeps it (ADR-029), and an edge's destination container has no host label.
 */
export function seriesTokens(
  kind: ClusterKind,
  subject: Record<string, string>,
  composeOf: ComposeOf = new Map(),
): Set<string> {
  const l = subject;
  const out: (string | null)[] = [];
  if (l.service) out.push(`i:${l.service}`);
  if (kind === 'kubernetes') {
    out.push(workload(l.namespace, l.workload_kind, l.workload));
    if (l.dst_kind === 'workload') {
      out.push(workload(l.dst_namespace, l.dst_workload_kind, l.dst_workload));
    }
    if (l.node && !l.workload) out.push(`n:${l.node}`);
  } else {
    out.push(container(l.container), compose(l.compose_project, l.compose_service));
    withCompose(out, l.container, composeOf);
    if (l.dst_kind === 'container') {
      out.push(container(l.dst));
      withCompose(out, l.dst, composeOf);
    }
    if (l.host && !l.container) out.push(`h:${l.host}`);
  }
  return new Set(out.filter((t): t is string => t !== null));
}

/** The subjects an alert is about, from its labels. */
export function alertTokens(
  kind: ClusterKind,
  labels: Record<string, string>,
  composeOf: ComposeOf = new Map(),
): Set<string> {
  const l = labels;
  const out: (string | null)[] = [];
  if (l.service) out.push(`i:${l.service}`);
  if (kind === 'kubernetes') {
    out.push(workload(l.namespace, l.workload_kind, l.workload));
    // Failed connections name their destination too (ADR-203): an outage of the destination
    // is its own incident, so the destination's minutes are left out as well as the caller's.
    if (l.dst_kind === 'workload') {
      out.push(workload(l.dst_namespace, l.dst_workload_kind, l.dst_workload));
    }
    if (l.node && !l.workload && !l.pod) out.push(`n:${l.node}`);
  } else {
    out.push(container(l.container), compose(l.compose_project, l.compose_service));
    withCompose(out, l.container, composeOf);
    if (l.dst_kind === 'container') {
      out.push(container(l.dst));
      withCompose(out, l.dst, composeOf);
    }
    // The host is `node` in alerts: a host alert names no container or Compose service.
    if (l.node && !l.container && !l.compose_service) out.push(`h:${l.node}`);
  }
  return new Set(out.filter((t): t is string => t !== null));
}

/** An alert's firing time on a set of subjects, [from, to) in ms. */
export interface Firing {
  from: number;
  to: number;
  tokens: Set<string>;
}

/**
 * The alerts of a cluster that fired in [from, to), other than anomaly alerts, with the
 * time each was on: from `started_at` (the condition first held, before the rule's "for")
 * to `resolved_at`. Alerts that never fired don't count. Runs inside the org (RLS);
 * `resolved_at` null is still firing.
 */
export async function firingAlerts(
  db: Database,
  kind: ClusterKind,
  clusterId: string,
  from: number,
  to: number,
  composeOf: ComposeOf,
): Promise<Firing[]> {
  const rows = await db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .select(['s.labels', 's.started_at', 's.fired_at', 's.resolved_at'])
    .where('s.cluster_id', '=', clusterId)
    .where('s.fired_at', 'is not', null)
    .where(sql<boolean>`coalesce(s.started_at, s.fired_at) < ${new Date(to)}`)
    .where((eb) =>
      eb.or([eb('s.resolved_at', 'is', null), eb('s.resolved_at', '>', new Date(from))]),
    )
    .where(sql<boolean>`coalesce(r.rule_key, '') <> ${ANOMALY_RULE_KEY}`)
    .execute();
  return rows.map((r) => ({
    // From when its condition first held: the rule's "for" (often 5 minutes) only delays the
    // notification, and a 7-minute incident would otherwise teach its first 5 (ADR-203).
    from: Math.min(r.started_at?.getTime() ?? Infinity, r.fired_at!.getTime()),
    to: r.resolved_at?.getTime() ?? Number.POSITIVE_INFINITY,
    tokens: alertTokens(kind, (r.labels ?? {}) as Record<string, string>, composeOf),
  }));
}

/** Whether minute `t` of a series with these subjects falls in a firing alert on one. */
export function excluded(t: number, tokens: Set<string>, firing: Firing[]): boolean {
  for (const f of firing) {
    if (t < f.from || t >= f.to) continue;
    for (const tok of f.tokens) if (tokens.has(tok)) return true;
  }
  return false;
}

/** Docker: each container's Compose project and service, from the container list. */
export async function composeMap(db: Database, clusterId: string): Promise<ComposeOf> {
  const rows = await db
    .selectFrom('objects')
    .select(['name', 'namespace', sql<string | null>`spec_summary->>'compose_service'`.as('svc')])
    .where('cluster_id', '=', clusterId)
    .where('kind', '=', 'DockerContainer')
    .execute();
  const out: ComposeOf = new Map();
  for (const r of rows) {
    if (r.namespace && r.svc) out.set(r.name, { project: r.namespace, service: r.svc });
  }
  return out;
}
