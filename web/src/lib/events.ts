// SPDX-License-Identifier: AGPL-3.0-only
// The Events page's rules (ADR-111): messages without
// UIDs and boot IDs, object names without a namespace for cluster-scoped objects, the
// grouping of one reason across several objects, routine node start-up events folded
// into one row, and day separators.
import type { KubeEvent } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * A message for the list: pods written as `<name>_<namespace>(<uid>)` become
 * `<namespace>/<name>`; boot IDs and other UIDs are removed. The full text stays in the
 * expanded row.
 */
export function trimIds(message: string): string {
  return message
    .replace(new RegExp(`([\\w.-]+)_([\\w.-]+)\\((?:uid:?\\s*)?${UUID}\\)`, 'gi'), '$2/$1')
    .replace(new RegExp(`[,;]?\\s*boot id:?\\s*${UUID}`, 'gi'), '')
    .replace(new RegExp(`\\s*\\((?:uid:?\\s*)?${UUID}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*\\buid:?\\s*${UUID}`, 'gi'), '')
    .replace(new RegExp(UUID, 'gi'), '…')
    .trim();
}

const SHORT: Record<string, string> = {
  HorizontalPodAutoscaler: 'HPA',
  PersistentVolumeClaim: 'PVC',
  PersistentVolume: 'PV',
};
export const shortKind = (kind: string) => SHORT[kind] ?? kind;

/**
 * "Pod wl-test/crashloop", "Node worker-2": cluster-scoped objects have no namespace.
 * Docker containers and images go by their name (the host is shown beside it).
 */
export function objectName(e: Pick<KubeEvent, 'namespace' | 'involvedName' | 'host'>): string {
  if (e.host) return e.involvedName;
  return e.namespace ? `${e.namespace}/${e.involvedName}` : e.involvedName;
}

/** Where an event's object can be opened. */
export function objectLink(e: KubeEvent): RouteLocationRaw | undefined {
  if (e.involvedKind === 'Pod' && e.namespace)
    return { name: 'pod', params: { namespace: e.namespace, name: e.involvedName } };
  if (e.involvedKind === 'Node') return { name: 'node', params: { name: e.involvedName } };
  if (e.involvedKind === 'Container' && e.host)
    return { name: 'docker-container', params: { host: e.host, name: e.involvedName } };
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(e.involvedKind))
    return {
      name: 'workloads',
      query: { view: 'pods', wkind: e.involvedKind, wns: e.namespace, wname: e.involvedName },
    };
  return undefined;
}

/** Events of one reason on several objects within this time are one row. */
export const GROUP_WINDOW_MS = 10 * 60_000;

/** What a node reports when it starts: folded into one "reported healthy" row. */
export const ROUTINE_NODE_REASONS = new Set([
  'Starting',
  'NodeHasSufficientMemory',
  'NodeHasNoDiskPressure',
  'NodeHasSufficientPID',
  'NodeReady',
  'NodeAllocatableEnforced',
  'RegisteredNode',
  'NodeSchedulable',
]);

export type EventItem =
  | { type: 'event'; key: string; event: KubeEvent }
  | {
      type: 'group';
      key: string;
      /** routine: node start-up events; else one reason on several objects. */
      routine: boolean;
      reason: string;
      eventType: string;
      kind: string;
      namespace: string | null;
      events: KubeEvent[];
      objects: string[];
      count: number;
      lastSeen: string;
    };

const keyOf = (e: KubeEvent) =>
  `${e.involvedKind}/${e.namespace ?? '-'}/${e.involvedName}/${e.reason}/${e.lastSeen}`;
const ms = (iso: string) => Date.parse(iso);

/**
 * Newest first, events of one reason on two or more objects of one kind and namespace
 * within GROUP_WINDOW_MS of the newest become one group; routine node start-up events
 * within the window fold into one group whatever their reason. Order is kept by each
 * row's newest event.
 */
export function groupEvents(events: KubeEvent[], window = GROUP_WINDOW_MS): EventItem[] {
  const open = new Map<string, { anchor: number; members: KubeEvent[] }>();
  const order: { key: string; members: KubeEvent[] }[] = [];
  for (const e of events) {
    const routine =
      e.involvedKind === 'Node' && e.type === 'Normal' && ROUTINE_NODE_REASONS.has(e.reason);
    const key = routine
      ? 'routine'
      : `${e.type}/${e.reason}/${e.involvedKind}/${e.namespace ?? '-'}`;
    const g = open.get(key);
    if (g && g.anchor - ms(e.lastSeen) <= window) {
      g.members.push(e);
      continue;
    }
    const fresh = { anchor: ms(e.lastSeen), members: [e] };
    open.set(key, fresh);
    order.push({ key: `${key}@${e.lastSeen}`, members: fresh.members });
  }
  return order.map(({ key, members }): EventItem => {
    const first = members[0]!;
    if (members.length === 1) return { type: 'event', key: keyOf(first), event: first };
    return {
      type: 'group',
      key,
      routine: key.startsWith('routine@'),
      reason: first.reason,
      eventType: first.type,
      kind: first.involvedKind,
      namespace: first.namespace,
      events: members,
      objects: [...new Set(members.map(objectName))],
      count: members.reduce((s, e) => s + e.count, 0),
      lastSeen: first.lastSeen,
    };
  });
}

/** One event per row, for the ungrouped list. */
export const ungrouped = (events: KubeEvent[]): EventItem[] =>
  events.map((e) => ({ type: 'event', key: keyOf(e), event: e }));

export const lastSeenOf = (item: EventItem) =>
  item.type === 'event' ? item.event.lastSeen : item.lastSeen;

/** "today", "yesterday" or the date, in local time. */
export function dayOf(
  iso: string,
  now = new Date(),
): { key: string; label: 'today' | 'yesterday' | null; date: Date } {
  const d = new Date(iso);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return {
    key: day(d),
    label: day(d) === day(now) ? 'today' : day(d) === day(yesterday) ? 'yesterday' : null,
    date: d,
  };
}

type T = (key: string, values?: Record<string, unknown>, plural?: number) => string;

/** A group's title: "All 3 nodes rebooted", "3 pods in wl-test keep failing to restart". */
export function groupTitle(
  item: Extract<EventItem, { type: 'group' }>,
  t: T,
  nodes?: number,
): string {
  const n = item.objects.length;
  const ns = item.namespace;
  if (item.routine) return t('kube.events.group.routine', { n }, n);
  if (item.objects.length === 1)
    return t('kube.events.group.repeated', { object: item.objects[0], n: item.events.length });
  switch (`${item.kind}/${item.reason}`) {
    case 'Node/Rebooted':
      return nodes !== undefined && n === nodes
        ? t('kube.events.group.allRebooted', { n })
        : t('kube.events.group.rebooted', { n });
    case 'Node/NodeNotReady':
      return t('kube.events.group.notReady', { n });
    case 'Pod/BackOff':
      return t('kube.events.group.backOff', { n, ns });
    case 'Pod/Unhealthy':
      return t('kube.events.group.unhealthy', { n, ns });
    case 'Pod/FailedScheduling':
      return t('kube.events.group.unschedulable', { n, ns });
    case 'Pod/Evicted':
      return t('kube.events.group.evicted', { n, ns });
    case 'Container/Died':
    case 'Container/OOMKilled':
    case 'Container/Unhealthy':
      return ns
        ? t(`kube.events.group.docker.${item.reason}`, { n, ns })
        : t(`kube.events.group.docker.${item.reason}Standalone`, { n });
    default:
      return ns
        ? t('kube.events.group.generic', { reason: item.reason, n, kind: shortKind(item.kind), ns })
        : t('kube.events.group.genericCluster', {
            reason: item.reason,
            n,
            kind: shortKind(item.kind),
          });
  }
}
