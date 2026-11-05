// SPDX-License-Identifier: AGPL-3.0-only
// Warning events for the overview (ADR-110): grouped by
// object and reason, with counts; pod UIDs stripped from the messages; flagged when
// the object is already a problem in "Needs attention" or one of WatchLog's own pods,
// so the page can hide them and say what it hid.
import { isClusterScoped } from '../kubernetes/events.js';

export interface EventRow {
  involvedKind: string;
  namespace: string;
  name: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: Date;
}

export interface EventGroup {
  kind: string;
  namespace: string | null;
  name: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: string;
  /** The object (or its workload) is already listed in Needs attention. */
  covered: boolean;
  /** One of WatchLog's own pods or workloads. */
  watchlog: boolean;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Kubernetes writes pods as `<name>_<namespace>(<uid>)`; that becomes
 * `<namespace>/<name>`. Any other UID, with its parentheses, is removed.
 */
export function stripUids(message: string): string {
  return message
    .replace(new RegExp(`([a-z0-9][-a-z0-9.]*)_([a-z0-9][-a-z0-9]*)\\(${UUID}\\)`, 'gi'), '$2/$1')
    .replace(new RegExp(`\\s*\\((uid:?\\s*)?${UUID}\\)`, 'gi'), '')
    .replace(new RegExp(`\\b(uid:?\\s*)?${UUID}\\b`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface Coverage {
  /** "namespace/pod" of pods in Needs attention. */
  pods: Set<string>;
  /** "namespace/workload" of workloads in Needs attention. */
  workloads: Set<string>;
  nodes: Set<string>;
  /** "namespace/pod" → the pod's workload name. */
  podWorkload: Map<string, string>;
  /** "namespace/name" of WatchLog's own workloads. */
  ownWorkloads: Set<string>;
}

const WORKLOADS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
]);

/**
 * The workload of a pod that no longer exists (events outlive pods), from the names
 * controllers give: `<deployment>-<replicaset hash>-<suffix>`, `<daemonset>-<suffix>`,
 * `<statefulset>-<ordinal>`. Only names of known workloads are returned.
 */
export function workloadFromPodName(
  pod: string,
  known: (name: string) => boolean,
): string | undefined {
  return [
    pod.replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, ''),
    pod.replace(/-[a-z0-9]{5}$/, ''),
    pod.replace(/-\d+$/, ''),
  ].find((n) => n !== pod && known(n));
}

export function groupEvents(rows: EventRow[], c: Coverage, limit = 30): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const r of rows) {
    const key = `${r.involvedKind}/${r.namespace}/${r.name}/${r.reason}`;
    const g = groups.get(key);
    if (g) {
      g.count += r.count;
      if (r.lastSeen.toISOString() > g.lastSeen) {
        g.lastSeen = r.lastSeen.toISOString();
        g.message = stripUids(r.message);
      }
      continue;
    }
    const nsName = `${r.namespace}/${r.name}`;
    const known = (w: string) =>
      c.ownWorkloads.has(`${r.namespace}/${w}`) || c.workloads.has(`${r.namespace}/${w}`);
    const workload =
      r.involvedKind === 'Pod'
        ? (c.podWorkload.get(nsName) ?? workloadFromPodName(r.name, known))
        : WORKLOADS.has(r.involvedKind)
          ? r.name
          : undefined;
    const nsWorkload = workload ? `${r.namespace}/${workload}` : null;
    groups.set(key, {
      kind: r.involvedKind,
      // Cluster-scoped objects (nodes) have no namespace, whatever the event's own says.
      namespace: isClusterScoped(r.involvedKind) ? null : r.namespace || null,
      name: r.name,
      reason: r.reason,
      message: stripUids(r.message),
      count: r.count,
      lastSeen: r.lastSeen.toISOString(),
      covered:
        (r.involvedKind === 'Pod' && c.pods.has(nsName)) ||
        (!!nsWorkload && c.workloads.has(nsWorkload)) ||
        (r.involvedKind === 'Node' && c.nodes.has(r.name)),
      watchlog: !!nsWorkload && c.ownWorkloads.has(nsWorkload),
    });
  }
  return [...groups.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, limit);
}
