// SPDX-License-Identifier: AGPL-3.0-only
// The overview's problems (ADR-110): one list that the status
// strip counts and "Needs attention" shows, so the two always agree. Firing alerts
// first, one item per object (an OOM alert and a crash-loop alert on the same pod are
// one problem); then object problems no alert covers, one per workload. Silenced
// alerts are counted, not listed. Titles and "why" lines come from the alert texts.
import type { Database } from '../../db/index.js';
import type { AttentionItem } from '../kubernetes/views.js';
import { alertText } from '../alerts/text.js';

export type ProblemType = 'crashloop' | 'oom' | 'connections' | 'nodes' | 'other';
export type Severity = 'critical' | 'warning';

export interface FiringAlert {
  id: string;
  ruleId: string;
  ruleKey: string | null;
  ruleName: string;
  severity: string;
  silenced: boolean;
  labels: Record<string, string>;
  details: Record<string, unknown>;
  startedAt: Date;
  firedAt: Date | null;
}

export interface Problem {
  id: string;
  source: 'alert' | 'object';
  severity: Severity;
  type: ProblemType;
  title: string;
  why: string | null;
  since: string | null;
  /** The alert to open; object problems open the object. */
  alertId: string | null;
  object: { kind: string; namespace: string | null; name: string } | null;
  /** Other firing alerts about the same object, merged into this item. */
  related: number;
}

export interface Problems {
  items: Problem[];
  critical: number;
  warning: number;
  /** One chip per problem type, with the rule to filter the Alerts page by when single. */
  types: { type: ProblemType; count: number; severity: Severity; ruleId: string | null }[];
  silenced: number;
  oldestSince: string | null;
}

export function problemType(ruleKey: string | null): ProblemType {
  if (
    ruleKey === 'k8s.pod.crashloop' ||
    ruleKey === 'docker.container.restarts' ||
    ruleKey === 'docker.container.restarting'
  )
    return 'crashloop';
  if (ruleKey === 'k8s.container.oomkilled' || ruleKey === 'docker.container.oom') return 'oom';
  if (ruleKey === 'network.connections.failed') return 'connections';
  if (ruleKey?.startsWith('k8s.node.') || ruleKey?.startsWith('node.')) return 'nodes';
  return 'other';
}

/** Rules about a pod's health: one problem per object, the most specific alert first. */
const POD_RULES = [
  'k8s.container.oomkilled',
  'k8s.pod.crashloop',
  'k8s.pod.imagepull',
  'k8s.pod.pending',
  'k8s.deployment.unavailable',
  'docker.container.unhealthy',
  'docker.container.restarts',
];

const sev = (s: string): Severity => (s === 'critical' ? 'critical' : 'warning');
const subject = (l: Record<string, string>) =>
  `${l.namespace ?? ''}/${l.workload ?? l.pod ?? l.container ?? ''}`;

const KIND_RULE: Record<AttentionItem['kind'], string> = {
  CrashLoopBackOff: 'k8s.pod.crashloop',
  OOMKilled: 'k8s.container.oomkilled',
  ImagePull: 'k8s.pod.imagepull',
  PendingPod: 'k8s.pod.pending',
  NodeNotReady: 'k8s.node.notready',
  PVCFull: 'k8s.pvc.usage',
};

/** Whether an alert (firing or silenced) already says this object has a problem. */
function covers(a: FiringAlert, item: AttentionItem, workload: string | undefined): boolean {
  const l = a.labels;
  if (item.objectKind === 'Node') return l.node === item.name && !l.pod && !l.workload;
  if (item.objectKind === 'PersistentVolumeClaim')
    return l.pvc === item.name && (l.namespace ?? null) === item.namespace;
  return (
    l.namespace === item.namespace &&
    (l.pod === item.name || (!!workload && l.workload === workload))
  );
}

export function buildProblems(input: {
  alerts: FiringAlert[];
  attention: AttentionItem[];
  /** "namespace/pod" → the pod's workload name. */
  podWorkload: Map<string, string>;
  clusterName: string;
  now: number;
  /** Object problems found by the caller (Docker containers), already worded. */
  objects?: Problem[];
}): Problems {
  const { alerts, attention, podWorkload, clusterName, now } = input;
  const items: Problem[] = [];
  const active = alerts.filter((a) => !a.silenced);

  // Firing alerts, merged per object for pod-health rules.
  const groups = new Map<string, FiringAlert[]>();
  for (const a of active) {
    const key =
      a.ruleKey && POD_RULES.includes(a.ruleKey) && subject(a.labels) !== '/'
        ? `pod:${subject(a.labels)}`
        : `alert:${a.id}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const list of groups.values()) {
    // The most specific alert names the problem (OOM over crash loop); the item takes
    // the highest severity of the group.
    list.sort(
      (a, b) =>
        rank(a.ruleKey) - rank(b.ruleKey) ||
        Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
        a.startedAt.getTime() - b.startedAt.getTime(),
    );
    const a = list[0]!;
    const text = alertText({
      ruleKey: a.ruleKey,
      ruleName: a.ruleName,
      labels: a.labels,
      details: a.details,
      cluster: { name: clusterName },
      now,
    });
    const since = new Date(Math.min(...list.map((x) => (x.firedAt ?? x.startedAt).getTime())));
    items.push({
      id: `alert:${a.id}`,
      source: 'alert',
      severity: list.some((x) => x.severity === 'critical') ? 'critical' : sev(a.severity),
      type: problemType(a.ruleKey),
      title: text.title,
      why: [a.labels.namespace, text.why].filter(Boolean).join(' · ') || null,
      since: since.toISOString(),
      alertId: a.id,
      object: null,
      related: list.length - 1,
    });
  }

  // Object problems no alert covers (silenced ones included: the user chose to mute
  // them), one per workload.
  const seen = new Set<string>();
  for (const item of attention) {
    const workload =
      item.objectKind === 'Pod' ? podWorkload.get(`${item.namespace}/${item.name}`) : undefined;
    if (alerts.some((a) => covers(a, item, workload))) continue;
    const name = workload ?? item.name;
    const key = `${item.objectKind}:${item.namespace ?? ''}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A crash loop whose last exit was an OOM kill is named for the OOM, as alerts are.
    const kind =
      item.kind === 'CrashLoopBackOff' && /OOMKilled/.test(item.detail) ? 'OOMKilled' : item.kind;
    const ruleKey = KIND_RULE[kind];
    const labels: Record<string, string> =
      item.objectKind === 'Node'
        ? { node: item.name }
        : item.objectKind === 'PersistentVolumeClaim'
          ? { pvc: item.name, namespace: item.namespace ?? '' }
          : { namespace: item.namespace ?? '', workload: name, pod: item.name };
    const text = alertText({
      ruleKey,
      ruleName: item.kind,
      labels,
      details: { summary: item.detail },
      cluster: { name: clusterName },
      now,
    });
    items.push({
      id: `object:${key}`,
      source: 'object',
      severity: item.severity,
      type: problemType(ruleKey),
      title: text.title,
      why: [item.namespace, item.detail].filter(Boolean).join(' · ') || null,
      since: item.since,
      alertId: null,
      object: { kind: item.objectKind, namespace: item.namespace, name: item.name },
      related: 0,
    });
  }

  items.push(...(input.objects ?? []));

  // Firing alerts first, then object problems; critical before warning; oldest first.
  items.sort(
    (a, b) =>
      Number(a.source === 'object') - Number(b.source === 'object') ||
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      (a.since ?? '9').localeCompare(b.since ?? '9'),
  );

  const byType = new Map<ProblemType, { count: number; severity: Severity; rules: Set<string> }>();
  for (const p of items) {
    const t = byType.get(p.type) ?? { count: 0, severity: 'warning', rules: new Set<string>() };
    t.count++;
    if (p.severity === 'critical') t.severity = 'critical';
    const a = p.alertId ? active.find((x) => x.id === p.alertId) : undefined;
    t.rules.add(a ? a.ruleId : `object:${p.type}`);
    byType.set(p.type, t);
  }
  const ORDER: ProblemType[] = ['crashloop', 'oom', 'connections', 'nodes', 'other'];
  const sinces = items.map((p) => p.since).filter((s): s is string => !!s);
  return {
    items,
    critical: items.filter((p) => p.severity === 'critical').length,
    warning: items.filter((p) => p.severity === 'warning').length,
    types: ORDER.flatMap((type) => {
      const t = byType.get(type);
      if (!t) return [];
      const rules = [...t.rules];
      return [
        {
          type,
          count: t.count,
          severity: t.severity,
          ruleId: rules.length === 1 && !rules[0]!.startsWith('object:') ? rules[0]! : null,
        },
      ];
    }),
    silenced: alerts.filter((a) => a.silenced).length,
    oldestSince: sinces.length ? sinces.sort()[0]! : null,
  };
}

export function rank(ruleKey: string | null): number {
  const i = POD_RULES.indexOf(ruleKey ?? '');
  return i < 0 ? POD_RULES.length : i;
}

/** Firing alerts of a cluster, silenced ones included (flagged), held ones left out. */
export async function firingAlerts(db: Database, clusterId: string): Promise<FiringAlert[]> {
  const rows = await db
    .selectFrom('alert_states')
    .innerJoin('alert_rules', 'alert_rules.id', 'alert_states.rule_id')
    .select([
      'alert_states.id',
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
    .where('alert_states.cluster_id', '=', clusterId)
    .where('alert_states.state', '=', 'firing')
    .where('alert_states.held', '=', false)
    .execute();
  return rows.map((r) => ({
    id: r.id,
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
