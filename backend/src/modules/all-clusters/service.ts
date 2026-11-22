// SPDX-License-Identifier: AGPL-3.0-only
// "All clusters and fleets" (ADR-226): every Kubernetes cluster and Server fleet of an org on
// one page, from data WatchLog already stores. Database reads are one query per table for the
// whole org, and metrics one VictoriaMetrics query per metric grouped by `cluster_id`
// (clustersForOrg's scope), so the answer costs the same for 2 clusters or 50.
import { sql } from 'kysely';
import { updateAvailable } from '../clusters/agent-update.js';
import type { Database } from '../../db/index.js';
import { OrgQueriesBusy } from '../../lib/org-queries.js';
import type { QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { CLUSTER_STALE_MS, clustersForOrg } from '../clusters/service.js';
import { buildProblems, type FiringAlert, type Problem } from '../overview/problems.js';
import { kubernetesProblems, serverProblems, type PvcUsage } from '../overview/cluster-problems.js';
import { BOOT_RECENT_S, hostBoots, type HostBoot } from '../docker/host-restart.js';
import type { ObjectRow } from '../kubernetes/views.js';
import { sparkStep } from '../overview/step.js';
import { learningOf } from '../anomaly/learning.js';
import { composeMap } from '../anomaly/exclusion.js';
import {
  nameServices,
  oncePerSeries,
  rowView,
  sortRows,
  type PeriodRow,
  type RowView,
} from '../anomaly/read.js';
import { mergeProblems, type ClusterKind, type PlacedProblem } from './merge.js';

/** The ranges the page offers, in seconds: 1h, 6h, 24h, 7d, 30d. */
export const RANGES = [3600, 21_600, 86_400, 604_800, 2_592_000] as const;
/** What changed's window on this page: the last 24 hours, its own longest window. */
export const WHAT_CHANGED_WINDOW_MS = 86_400_000;
/** What changed rows the page shows. */
export const TOP_CHANGES = 5;
/** An agent seen within this window still counts (a removed host drops out after it). */
export const AGENT_WINDOW_MS = 7 * 86_400_000;
/** The rule of an agent that stopped reporting (alerts/defaults.ts). */
export const NOT_REPORTING = 'agent.not_reporting';

export type Kind = 'all' | ClusterKind;
export type Status = 'critical' | 'warning' | 'healthy' | 'waiting';

export interface ClusterRef {
  id: string;
  name: string;
  kind: ClusterKind;
}

export interface Place {
  cluster: ClusterRef;
  /** The problem's id on that cluster's own Overview (`alert:<id>`). */
  problemId: string;
  alertId: string | null;
}

/** One row of "Needs attention, everywhere": a problem, in one or more places. */
export interface ProblemRow extends Omit<Problem, 'id' | 'related'> {
  id: string;
  places: Place[];
}

export interface ClusterRow extends ClusterRef {
  status: Status;
  /** Kubernetes: the kubelet version the cluster reports; null for fleets. */
  version: string | null;
  /** Nodes (Kubernetes) or servers (fleets) whose agent reported within 7 days. */
  hosts: number;
  /** Their agents now reporting, of `hosts`. */
  reporting: { live: number; total: number };
  /**
   * Servers only: how many of each source run there (systemd services, process groups,
   * containers), and the applications WatchLog monitors there (integration types).
   */
  sources: {
    services: number;
    processGroups: number;
    containers: number;
    applications: string[];
  } | null;
  cpu: { now: number | null; points: [number, number | null][] };
  memory: number | null;
  problems: { critical: number; warning: number };
  /** What changed in the last 24 hours; null while the cluster is still learning. */
  whatChanged: number | null;
  alerts: number;
  /** Its certificates, and how many expire within 14 days (or have; 0.13.0). */
  certificates: { total: number; expiring: number };
  /** Its scheduled jobs, and how many are failing (0.13.0). */
  jobs: { total: number; failing: number };
}

export interface Summary {
  range: number;
  step: number;
  ranges: number[];
  kind: Kind;
  counts: { all: number; kubernetes: number; server: number };
  hosts: { nodes: number; servers: number; notReporting: number };
  clusters: ClusterRow[];
  problems: ProblemRow[];
  lastResolved: {
    title: string;
    cluster: ClusterRef;
    resolvedAt: string;
    durationSeconds: number;
  } | null;
  resolvedThisWeek: number;
  /** Certificates that expire within 14 days (or have), and where (0.13.0). */
  certificatesExpiring: { count: number; places: (ClusterRef & { count: number })[] };
  /** Scheduled jobs failing now, the first few by name, and where (0.13.0). */
  jobsFailing: {
    count: number;
    jobs: { name: string; node: string; cluster: ClusterRef }[];
  };
  whatChanged: {
    rows: (RowView & { cluster: ClusterRef })[];
    total: number;
    learning: (ClusterRef & { until: string | null })[];
  };
  alertsSent: {
    total: number;
    channels: { id: string; name: string; type: string; sent: number; failed: number }[];
  };
  housekeeping: {
    latestVersion: string;
    oldAgents: { cluster: ClusterRef; count: number; versions: string[] }[];
    failingChannels: {
      id: string;
      name: string;
      type: string;
      since: string;
      error: string | null;
    }[];
    deliveringChannels: { id: string; name: string; type: string }[];
    noChannel: ClusterRef[];
    ebpfOff: { cluster: ClusterRef; count: number; reasons: string[] }[];
  };
}

/** Whether version `a` is older than `b` (numeric parts; a pre-release before its release). */
export function olderVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return x.pre !== null && y.pre === null;
}

/** A development build has no release to compare with. */
const isRelease = (v: string) => /^v?\d+\.\d+\.\d+$/.test(v);

/** The status of a cluster or fleet: its worst open problem, or waiting for its first agent. */
export function statusOf(p: { critical: number; warning: number }, seen: boolean): Status {
  if (p.critical > 0) return 'critical';
  if (p.warning > 0) return 'warning';
  return seen ? 'healthy' : 'waiting';
}

const STATUS_ORDER: Record<Status, number> = { critical: 0, warning: 1, waiting: 2, healthy: 3 };

export interface SummaryInput {
  db: Database;
  victoria?: VictoriaQueryClient;
  orgId: string;
  range: number;
  kind: Kind;
  nowMs: number;
  /** The backend's version: agents older than it are listed. */
  version: string;
  /** The longest range this org may read (its retention; the demo's 24 hours). */
  maxRange: number;
  /**
   * The read-only demo (ADR-122): "sends alerts nowhere" is left out, since a visitor can't
   * add a channel (ADR-229). Real orgs still see it.
   */
  demo?: boolean;
  log: { warn(obj: object, msg: string): void };
}

export async function buildSummary(input: SummaryInput): Promise<Summary> {
  const { db, orgId, range, nowMs } = input;
  const step = sparkStep(range);
  const end = Math.floor(nowMs / 1000 / step) * step;
  const start = end - range;
  const { rows: all, scope, scopeOf } = await clustersForOrg(db, orgId);
  const ref = (c: { id: string; name: string; kind: string }): ClusterRef => ({
    id: c.id,
    name: c.name,
    kind: c.kind === 'server' ? 'server' : 'kubernetes',
  });
  const refs = new Map(all.map((c) => [c.id, ref(c)]));
  const ids = all.map((c) => c.id);
  const counts = {
    all: all.length,
    kubernetes: all.filter((c) => c.kind !== 'server').length,
    server: all.filter((c) => c.kind === 'server').length,
  };
  const ranges = RANGES.filter((r) => r <= input.maxRange);

  const metric = (q: Promise<QuerySeries[]>) =>
    q.catch((err: Error) => {
      if (err instanceof OrgQueriesBusy) throw err; // the org's cap: 429 (SR-9)
      input.log.warn({ err: err.message }, 'all-clusters query failed');
      return [] as QuerySeries[];
    });
  const cpuExpr =
    'sum by (cluster_id) (rate(watchlog_node_cpu_seconds_total{mode!="idle"}[' +
    `${Math.max(60, 2 * step)}s])) / sum by (cluster_id) (rate(watchlog_node_cpu_seconds_total[` +
    `${Math.max(60, 2 * step)}s]))`;
  const memExpr =
    'sum by (cluster_id) (watchlog_node_memory_bytes{state="total"}) - sum by (cluster_id) ' +
    '(watchlog_node_memory_bytes{state="available"})';
  const memTotalExpr = 'sum by (cluster_id) (watchlog_node_memory_bytes{state="total"})';

  const whatChangedFrom = new Date(nowMs - WHAT_CHANGED_WINDOW_MS);
  // Each cluster's own Needs attention, as its Overview builds it (ADR-227): the nodes, pods
  // and volumes of every Kubernetes cluster, the containers of every fleet, and recent host
  // reboots, one query each for the whole org.
  const kubeIds = all.filter((c) => c.kind !== 'server').map((c) => c.id);
  const serverIds = all.filter((c) => c.kind === 'server').map((c) => c.id);
  const extras = Promise.all([
    kubeIds.length
      ? (db
          .selectFrom('objects')
          .select([
            'cluster_id',
            'kind',
            'namespace',
            'name',
            'node',
            'spec_summary',
            'status_summary',
          ])
          .where('cluster_id', 'in', kubeIds)
          .where('source', '=', 'kubernetes')
          .where('kind', 'in', ['Node', 'Pod'])
          .where('deleted_at', 'is', null)
          .execute() as Promise<(ObjectRow & { cluster_id: string })[]>)
      : [],
    serverIds.length
      ? db
          .selectFrom('objects')
          .select(['cluster_id', 'node', 'name', 'namespace', 'spec_summary', 'status_summary'])
          .where('cluster_id', 'in', serverIds)
          .where('kind', '=', 'DockerContainer')
          .where('deleted_at', 'is', null)
          .execute()
      : [],
    scope && input.victoria && kubeIds.length
      ? metric(
          input.victoria.query(
            scope,
            'max by (cluster_id, namespace, persistentvolumeclaim) (watchlog_pod_volume_bytes{state="used"}) / max by (cluster_id, namespace, persistentvolumeclaim) (watchlog_pod_volume_bytes{state="capacity"})',
          ),
        )
      : [],
    scope && input.victoria && serverIds.length
      ? metric(
          input.victoria.query(
            scope,
            'max by (cluster_id, host) (watchlog_node_boot_time_seconds)',
          ),
        )
      : [],
  ] as const);
  const [
    agents,
    alertRows,
    resolved,
    notifications,
    channels,
    rules,
    periods,
    learning,
    sources,
    nodeVersions,
    cpuSeries,
    memUsed,
    memTotal,
    unitCounts,
    groupCounts,
  ] = await Promise.all([
    ids.length
      ? db
          .selectFrom('agent_instances')
          .select(['cluster_id', 'node', 'mode', 'agent_version', 'capabilities', 'last_seen_at'])
          .where('cluster_id', 'in', ids)
          .where('last_seen_at', '>=', new Date(nowMs - AGENT_WINDOW_MS))
          .execute()
      : [],
    ids.length ? firingAlertsOf(db, ids) : [],
    ids.length
      ? db
          .selectFrom('alert_states')
          .innerJoin('alert_rules', 'alert_rules.id', 'alert_states.rule_id')
          .select([
            'alert_states.cluster_id',
            'alert_rules.rule_key',
            'alert_rules.name',
            'alert_states.labels',
            'alert_states.details',
            'alert_states.started_at',
            'alert_states.resolved_at',
          ])
          .where('alert_states.cluster_id', 'in', ids)
          .where('alert_states.state', '=', 'resolved')
          .where('alert_states.resolved_at', '>=', new Date(nowMs - 7 * 86_400_000))
          .orderBy('alert_states.resolved_at', 'desc')
          .limit(500)
          .execute()
      : [],
    ids.length
      ? db
          .selectFrom('notifications')
          .select(['channel_id', 'cluster_id', 'status'])
          .where('org_id', '=', orgId)
          .where('cluster_id', 'in', ids)
          .where('status', 'in', ['sent', 'failed'])
          .where('created_at', '>=', new Date(start * 1000))
          .execute()
      : [],
    db
      .selectFrom('alert_channels')
      .select(['id', 'name', 'type', 'last_error', 'last_error_at', 'last_sent_at'])
      .where('org_id', '=', orgId)
      .orderBy('name')
      .execute(),
    db
      .selectFrom('alert_rules')
      .select(['cluster_id', 'channel_ids'])
      .where('org_id', '=', orgId)
      .where('enabled', '=', true)
      .execute(),
    ids.length
      ? (db
          .selectFrom('anomaly_periods')
          .select([
            'id',
            'cluster_id',
            'metric',
            'subject',
            'started_at',
            'ended_at',
            'usual_low',
            'usual_high',
            'peak_score',
            'peak_value',
            'peak_at',
            'last_value',
          ])
          .where('org_id', '=', orgId)
          .where('cluster_id', 'in', ids)
          .where('started_at', '<', new Date(nowMs))
          .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', whatChangedFrom)]))
          .orderBy('peak_score', 'desc')
          .limit(2000)
          .execute() as Promise<(PeriodRow & { cluster_id: string })[]>)
      : [],
    Promise.all(
      all.map((c) =>
        learningOf(db, orgId, c.id, nowMs).then(
          (l) => [c.id, l] as const,
          () => [c.id, null] as const,
        ),
      ),
    ),
    serverSources(
      db,
      all.filter((c) => c.kind === 'server').map((c) => c.id),
    ),
    kubeletVersions(
      db,
      all.filter((c) => c.kind !== 'server').map((c) => c.id),
    ),
    scope && input.victoria
      ? metric(input.victoria.queryRange(scope, cpuExpr, start, end, step))
      : [],
    scope && input.victoria ? metric(input.victoria.query(scope, memExpr)) : [],
    scope && input.victoria ? metric(input.victoria.query(scope, memTotalExpr)) : [],
    scope && input.victoria && counts.server
      ? metric(
          input.victoria.query(
            scope,
            'count by (cluster_id) (max by (cluster_id, host, unit) (last_over_time(watchlog_service_state[5m])))',
          ),
        )
      : [],
    scope && input.victoria && counts.server
      ? metric(
          input.victoria.query(
            scope,
            'count by (cluster_id) (max by (cluster_id, host, group) (last_over_time(watchlog_process_group_instances{group!="other processes"}[5m]) > 0))',
          ),
        )
      : [],
  ]);

  // Agents: the hosts each cluster has (node agents, server agents), and who reports.
  const hostAgents = agents.filter((a) => a.mode === 'node' || a.mode === 'docker');
  const byCluster = <T extends { cluster_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.cluster_id, [...(m.get(r.cluster_id) ?? []), r]);
    return m;
  };
  const agentsOf = byCluster(hostAgents);
  const live = (a: { last_seen_at: Date }) => nowMs - a.last_seen_at.getTime() <= CLUSTER_STALE_MS;

  // Problems: each cluster's firing alerts as its own Overview lists them, then merged.
  const alertsOf = byCluster(alertRows.map((a) => ({ ...a, cluster_id: a.clusterId })));
  const [kubeObjects, containerRows, pvcSeries, bootSeries] = await extras;
  const objectsOf = byCluster(kubeObjects);
  const containersOf = byCluster(containerRows);
  const pvcOf = new Map<string, PvcUsage[]>();
  for (const s of pvcSeries) {
    const v = s.points[0]?.[1];
    const id = s.labels.cluster_id ?? '';
    if (v == null || !id) continue;
    pvcOf.set(id, [
      ...(pvcOf.get(id) ?? []),
      {
        namespace: s.labels.namespace ?? '',
        name: s.labels.persistentvolumeclaim ?? '',
        ratio: v,
      },
    ]);
  }
  // Recent reboots: only the fleets with one ask again, each on its own (ADR-159's window).
  const rebooted = new Set(
    bootSeries
      .filter((b) => {
        const at = b.points[0]?.[1];
        return at != null && nowMs / 1000 - at <= BOOT_RECENT_S;
      })
      .map((b) => b.labels.cluster_id ?? ''),
  );
  const bootsOf = new Map<string, Map<string, HostBoot>>();
  await Promise.all(
    serverIds
      .filter((id) => rebooted.has(id))
      .map(async (id) => {
        const one = scopeOf(id);
        if (!one || !input.victoria) return;
        const victoria = input.victoria;
        bootsOf.set(id, await hostBoots((e) => metric(victoria.query(one, e)), nowMs / 1000));
      }),
  );
  const placed: (PlacedProblem & { problem: Problem; cluster: ClusterRef })[] = [];
  const perCluster = new Map<string, { critical: number; warning: number }>();
  for (const c of all) {
    const alerts = alertsOf.get(c.id) ?? [];
    const objs = objectsOf.get(c.id) ?? [];
    const built =
      c.kind === 'server'
        ? serverProblems({
            alerts,
            containers: containersOf.get(c.id) ?? [],
            liveHosts: new Set(
              (agentsOf.get(c.id) ?? [])
                .filter((a) => a.mode === 'docker' && live(a))
                .map((a) => a.node),
            ),
            boots: bootsOf.get(c.id) ?? new Map(),
            clusterName: c.name,
            now: nowMs,
          })
        : kubernetesProblems({
            alerts,
            nodes: objs.filter((o) => o.kind === 'Node'),
            pods: objs.filter((o) => o.kind === 'Pod'),
            pvc: pvcOf.get(c.id) ?? [],
            clusterName: c.name,
            now: nowMs,
          });
    perCluster.set(c.id, { critical: built.critical, warning: built.warning });
    for (const problem of built.items) {
      const a = alerts.find((x) => x.id === problem.alertId);
      placed.push({
        clusterId: c.id,
        clusterKind: refs.get(c.id)!.kind,
        ruleKey: a?.ruleKey ?? null,
        ruleId: a?.ruleId ?? null,
        labels: a?.labels ?? {},
        since: problem.since,
        problem,
        cluster: refs.get(c.id)!,
      });
    }
  }
  const problemRows: ProblemRow[] = mergeProblems(placed).map((members) => {
    const head = members[0]!.problem;
    const rest: Omit<Problem, 'id' | 'related'> & Partial<Pick<Problem, 'id' | 'related'>> = {
      ...head,
    };
    delete rest.id;
    delete rest.related;
    return {
      ...rest,
      id: `${members[0]!.clusterId}:${head.id}`,
      severity: members.some((m) => m.problem.severity === 'critical') ? 'critical' : 'warning',
      since: members[0]!.problem.since,
      places: members.map((m) => ({
        cluster: m.cluster,
        problemId: m.problem.id,
        alertId: m.problem.alertId,
      })),
    };
  });
  // Critical first, then the most recent first (the design's order).
  problemRows.sort(
    (a, b) =>
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      (b.since ?? '').localeCompare(a.since ?? ''),
  );

  // What changed: the last 24 hours of every cluster that has finished learning.
  const learningOfCluster = new Map(learning);
  const learned = (id: string) => learningOfCluster.get(id)?.learning === false;
  const changePeriods = periods.filter(
    (p) =>
      learned(p.cluster_id) &&
      (p.ended_at ? p.ended_at.getTime() : nowMs) > whatChangedFrom.getTime(),
  );
  const changesPerCluster = new Map<string, number>();
  for (const p of changePeriods)
    changesPerCluster.set(p.cluster_id, (changesPerCluster.get(p.cluster_id) ?? 0) + 1);
  const topPeriods = changePeriods.slice(0, TOP_CHANGES * 4);
  const changeRows: (RowView & { cluster: ClusterRef })[] = [];
  for (const [clusterId, list] of byCluster(topPeriods)) {
    const c = refs.get(clusterId)!;
    const compose = c.kind === 'server' ? await composeMap(db, clusterId) : new Map();
    const views = list.map((p) => rowView(p, compose));
    await nameServices(db, orgId, clusterId, views);
    changeRows.push(...views.map((v) => ({ ...v, cluster: c })));
  }

  // Alerts sent in the range, per channel.
  const sentPerChannel = new Map<string, { sent: number; failed: number }>();
  const alertsPerCluster = new Map<string, number>();
  for (const n of notifications) {
    const s = sentPerChannel.get(n.channel_id) ?? { sent: 0, failed: 0 };
    if (n.status === 'sent') s.sent++;
    else s.failed++;
    sentPerChannel.set(n.channel_id, s);
    if (n.cluster_id)
      alertsPerCluster.set(n.cluster_id, (alertsPerCluster.get(n.cluster_id) ?? 0) + 1);
  }

  // Metrics, by cluster_id.
  const lastOf = (pts: [number, number | null][]) => {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i]![1] !== null) return pts[i]![1];
    return null;
  };
  const cpuBy = new Map(cpuSeries.map((s) => [s.labels.cluster_id ?? '', s.points]));
  const memUsedBy = new Map(memUsed.map((s) => [s.labels.cluster_id ?? '', s.points[0]?.[1]]));
  const memTotalBy = new Map(memTotal.map((s) => [s.labels.cluster_id ?? '', s.points[0]?.[1]]));
  const unitsBy = new Map(unitCounts.map((s) => [s.labels.cluster_id ?? '', s.points[0]?.[1]]));
  const groupsBy = new Map(groupCounts.map((s) => [s.labels.cluster_id ?? '', s.points[0]?.[1]]));

  // Certificates and scheduled jobs (0.13.0): counts per cluster, from the stored inventory.
  const [certCounts, jobCounts, failingJobs] = ids.length
    ? await Promise.all([
        db
          .selectFrom('certificates')
          .select((eb) => [
            'cluster_id',
            eb.fn.countAll<string>().as('total'),
            eb.fn
              .count<string>(
                sql`CASE WHEN not_after < ${new Date(nowMs + 14 * 86_400_000)} THEN 1 END`,
              )
              .as('expiring'),
          ])
          .where('cluster_id', 'in', ids)
          .where('current', '=', true)
          .groupBy('cluster_id')
          .execute(),
        db
          .selectFrom('scheduled_jobs')
          .select((eb) => [
            'cluster_id',
            eb.fn.countAll<string>().as('total'),
            eb.fn.count<string>(sql`CASE WHEN state = 'failed' THEN 1 END`).as('failing'),
          ])
          .where('cluster_id', 'in', ids)
          .where('gone_at', 'is', null)
          .groupBy('cluster_id')
          .execute(),
        db
          .selectFrom('scheduled_jobs')
          .select(['cluster_id', 'name', 'node'])
          .where('cluster_id', 'in', ids)
          .where('gone_at', 'is', null)
          .where('state', '=', 'failed')
          .orderBy('name')
          .limit(10)
          .execute(),
      ])
    : [[], [], []];
  const certsBy = new Map(
    certCounts.map((r) => [r.cluster_id, { total: Number(r.total), expiring: Number(r.expiring) }]),
  );
  const jobsBy = new Map(
    jobCounts.map((r) => [r.cluster_id, { total: Number(r.total), failing: Number(r.failing) }]),
  );

  const clusterRows: ClusterRow[] = all.map((c) => {
    const r = refs.get(c.id)!;
    const hosts = agentsOf.get(c.id) ?? [];
    const p = perCluster.get(c.id) ?? { critical: 0, warning: 0 };
    const points = cpuBy.get(c.id) ?? [];
    const used = memUsedBy.get(c.id);
    const total = memTotalBy.get(c.id);
    const l = learningOfCluster.get(c.id);
    return {
      ...r,
      status: statusOf(p, c.first_seen_at !== null || hosts.length > 0),
      version: r.kind === 'kubernetes' ? (nodeVersions.get(c.id) ?? c.k8s_version ?? null) : null,
      hosts: hosts.length,
      reporting: { live: hosts.filter(live).length, total: hosts.length },
      sources:
        r.kind === 'server'
          ? {
              services: Number(unitsBy.get(c.id) ?? 0),
              processGroups: Number(groupsBy.get(c.id) ?? 0),
              containers: sources.get(c.id)?.containers ?? 0,
              applications: sources.get(c.id)?.applications ?? [],
            }
          : null,
      cpu: { now: lastOf(points), points },
      memory: used != null && total ? used / total : null,
      problems: p,
      whatChanged: l && l.learning === false ? (changesPerCluster.get(c.id) ?? 0) : null,
      alerts: alertsPerCluster.get(c.id) ?? 0,
      certificates: certsBy.get(c.id) ?? { total: 0, expiring: 0 },
      jobs: jobsBy.get(c.id) ?? { total: 0, failing: 0 },
    };
  });
  clusterRows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );

  // Housekeeping.
  const oldAgents = isRelease(input.version)
    ? all.flatMap((c) => {
        const old = (agentsOf.get(c.id) ?? []).filter((a) =>
          updateAvailable(a.agent_version, input.version),
        );
        return old.length
          ? [
              {
                cluster: refs.get(c.id)!,
                count: old.length,
                versions: [...new Set(old.map((a) => a.agent_version.replace(/^v/, '')))].sort(),
              },
            ]
          : [];
      })
    : [];
  const failingChannels = channels
    .filter((ch) => ch.last_error_at !== null)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      since: ch.last_error_at!.toISOString(),
      error: ch.last_error,
    }));
  const deliveringChannels = channels
    .filter((ch) => ch.last_error_at === null && ch.last_sent_at !== null)
    .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type }));
  const noChannel = input.demo
    ? []
    : all
        .filter(
          (c) =>
            !rules.some(
              (r) =>
                (r.cluster_id === null || r.cluster_id === c.id) &&
                (r.channel_ids?.length ?? 0) > 0,
            ),
        )
        .map((c) => refs.get(c.id)!);
  const ebpfOff = all.flatMap((c) => {
    const off = (agentsOf.get(c.id) ?? []).filter(
      (a) => live(a) && (a.capabilities as { ebpf?: string } | null)?.ebpf !== 'enabled',
    );
    if (!off.length) return [];
    const reasons = [
      ...new Set(
        off
          .map((a) => (a.capabilities as { ebpf_reason?: string } | null)?.ebpf_reason)
          .filter((x): x is string => !!x),
      ),
    ].slice(0, 3);
    return [{ cluster: refs.get(c.id)!, count: off.length, reasons }];
  });

  const last = resolved[0];
  const nodes = clusterRows.filter((c) => c.kind === 'kubernetes').reduce((n, c) => n + c.hosts, 0);
  const servers = clusterRows.filter((c) => c.kind === 'server').reduce((n, c) => n + c.hosts, 0);
  return {
    range,
    step,
    ranges,
    kind: input.kind,
    counts,
    hosts: {
      nodes,
      servers,
      notReporting: clusterRows.reduce((n, c) => n + c.reporting.total - c.reporting.live, 0),
    },
    clusters: clusterRows,
    problems: problemRows,
    lastResolved: last
      ? {
          title: resolvedTitle(last, refs.get(last.cluster_id)!, nowMs),
          cluster: refs.get(last.cluster_id)!,
          resolvedAt: last.resolved_at!.toISOString(),
          durationSeconds: Math.max(
            0,
            Math.round((last.resolved_at!.getTime() - last.started_at.getTime()) / 1000),
          ),
        }
      : null,
    resolvedThisWeek: resolved.length,
    certificatesExpiring: {
      count: clusterRows.reduce((n, c) => n + c.certificates.expiring, 0),
      places: clusterRows
        .filter((c) => c.certificates.expiring > 0)
        .map((c) => ({ ...refs.get(c.id)!, count: c.certificates.expiring })),
    },
    jobsFailing: {
      count: clusterRows.reduce((n, c) => n + c.jobs.failing, 0),
      jobs: failingJobs.map((j) => ({
        name: j.name,
        node: j.node,
        cluster: refs.get(j.cluster_id)!,
      })),
    },
    whatChanged: {
      // One row per series (ADR-229), the cluster part of the series.
      rows: sortRows(
        oncePerSeries(changeRows, (r) => r.cluster.id),
        'furthest',
      ).slice(0, TOP_CHANGES),
      total: changePeriods.length,
      learning: all
        .filter((c) => learningOfCluster.get(c.id)?.learning !== false)
        .map((c) => ({ ...refs.get(c.id)!, until: learningOfCluster.get(c.id)?.until ?? null })),
    },
    alertsSent: {
      total: notifications.length,
      channels: channels.flatMap((ch) => {
        const s = sentPerChannel.get(ch.id);
        return s ? [{ id: ch.id, name: ch.name, type: ch.type, ...s }] : [];
      }),
    },
    housekeeping: {
      latestVersion: input.version.replace(/^v/, ''),
      oldAgents,
      failingChannels,
      deliveringChannels,
      noChannel,
      ebpfOff,
    },
  };
}

/** Narrows a summary to one kind: every list, the counts and the hosts. */
export function filterKind(s: Summary, kind: Kind): Summary {
  if (kind === 'all') return s;
  const keep = new Set(s.clusters.filter((c) => c.kind === kind).map((c) => c.id));
  const has = (c: ClusterRef) => keep.has(c.id);
  const clusters = s.clusters.filter((c) => keep.has(c.id));
  return {
    ...s,
    kind,
    clusters,
    hosts: {
      nodes: kind === 'kubernetes' ? s.hosts.nodes : 0,
      servers: kind === 'server' ? s.hosts.servers : 0,
      notReporting: clusters.reduce((n, c) => n + c.reporting.total - c.reporting.live, 0),
    },
    problems: s.problems.filter((p) => p.places.some((pl) => has(pl.cluster))),
    lastResolved: s.lastResolved && has(s.lastResolved.cluster) ? s.lastResolved : null,
    certificatesExpiring: {
      count: clusters.reduce((n, c) => n + c.certificates.expiring, 0),
      places: s.certificatesExpiring.places.filter(has),
    },
    jobsFailing: {
      count: clusters.reduce((n, c) => n + c.jobs.failing, 0),
      jobs: s.jobsFailing.jobs.filter((j) => has(j.cluster)),
    },
    whatChanged: {
      rows: s.whatChanged.rows.filter((r) => has(r.cluster)),
      total: s.whatChanged.rows.filter((r) => has(r.cluster)).length,
      learning: s.whatChanged.learning.filter(has),
    },
    housekeeping: {
      ...s.housekeeping,
      oldAgents: s.housekeeping.oldAgents.filter((o) => has(o.cluster)),
      noChannel: s.housekeeping.noChannel.filter(has),
      ebpfOff: s.housekeeping.ebpfOff.filter((o) => has(o.cluster)),
    },
  };
}

/** Firing alerts of several clusters at once, as overview/problems.ts's firingAlerts. */
async function firingAlertsOf(
  db: Database,
  clusterIds: string[],
): Promise<(FiringAlert & { clusterId: string })[]> {
  const rows = await db
    .selectFrom('alert_states')
    .innerJoin('alert_rules', 'alert_rules.id', 'alert_states.rule_id')
    .select([
      'alert_states.id',
      'alert_states.cluster_id',
      'alert_states.rule_id',
      'alert_rules.rule_key',
      'alert_rules.name',
      'alert_states.severity',
      'alert_states.silenced',
      'alert_states.labels',
      'alert_states.details',
      'alert_states.started_at',
      'alert_states.fired_at',
    ])
    .where('alert_states.cluster_id', 'in', clusterIds)
    .where('alert_states.state', '=', 'firing')
    .where('alert_states.held', '=', false)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    clusterId: r.cluster_id,
    ruleId: r.rule_id,
    ruleKey: r.rule_key,
    ruleName: r.name,
    severity: r.severity,
    silenced: r.silenced,
    labels: r.labels as Record<string, string>,
    details: r.details as Record<string, unknown>,
    startedAt: r.started_at,
    firedAt: r.fired_at,
  }));
}

/** The last resolved problem's title, as its alert names it. */
function resolvedTitle(
  r: {
    rule_key: string | null;
    name: string;
    labels: unknown;
    details: unknown;
    cluster_id: string;
  },
  cluster: ClusterRef,
  nowMs: number,
): string {
  const built = buildProblems({
    alerts: [
      {
        id: 'resolved',
        ruleId: 'resolved',
        ruleKey: r.rule_key,
        ruleName: r.name,
        severity: 'warning',
        silenced: false,
        labels: r.labels as Record<string, string>,
        details: r.details as Record<string, unknown>,
        startedAt: new Date(nowMs),
        firedAt: null,
      },
    ],
    attention: [],
    podWorkload: new Map(),
    clusterName: cluster.name,
    now: nowMs,
  });
  return built.items[0]?.title ?? r.name;
}

/** Each fleet's containers (Docker's objects) and the applications monitored there. */
async function serverSources(
  db: Database,
  clusterIds: string[],
): Promise<Map<string, { containers: number; applications: string[] }>> {
  const out = new Map<string, { containers: number; applications: string[] }>();
  if (!clusterIds.length) return out;
  const get = (id: string) => {
    const s = out.get(id) ?? { containers: 0, applications: [] };
    out.set(id, s);
    return s;
  };
  const [containers, apps] = await Promise.all([
    db
      .selectFrom('objects')
      .select('cluster_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('cluster_id', 'in', clusterIds)
      .where('kind', '=', 'DockerContainer')
      .where('deleted_at', 'is', null)
      .groupBy('cluster_id')
      .execute(),
    db
      .selectFrom('integrations')
      .select(['cluster_id', 'type'])
      .where('cluster_id', 'in', clusterIds)
      .execute(),
  ]);
  for (const r of containers) get(r.cluster_id).containers = Number(r.n);
  for (const r of apps) {
    const s = get(r.cluster_id);
    if (!s.applications.includes(r.type)) s.applications.push(r.type);
  }
  for (const s of out.values()) s.applications.sort();
  return out;
}

/** Each Kubernetes cluster's kubelet version, from its nodes' status. */
async function kubeletVersions(db: Database, clusterIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!clusterIds.length) return out;
  const rows = await db
    .selectFrom('objects')
    .select(['cluster_id', 'status_summary'])
    .where('cluster_id', 'in', clusterIds)
    .where('source', '=', 'kubernetes')
    .where('kind', '=', 'Node')
    .where('deleted_at', 'is', null)
    .execute();
  for (const r of rows) {
    if (out.has(r.cluster_id)) continue;
    const v = (r.status_summary as { info?: { kubelet_version?: string } } | null)?.info
      ?.kubelet_version;
    if (v) out.set(r.cluster_id, v.replace(/^v/, '').replace(/^(\d+\.\d+).*$/, '$1'));
  }
  return out;
}
