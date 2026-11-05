// SPDX-License-Identifier: AGPL-3.0-only
// The overview page's words and rules (ADR-110): period
// comparisons, change markers, warning events (hidden ones explained, fix hints), the
// pod heatmap and where each problem leads.
import type {
  KubeOverview,
  OverviewEvent,
  OverviewMarker,
  OverviewProblem,
} from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';

export type Overview = KubeOverview;

export interface Comparison {
  change: number | null;
  ratio: number | null;
  direction: 'up' | 'down' | 'flat' | null;
}

/**
 * A KPI against the previous period of the same length: up, down or flat (a change
 * under `unit`, or under 5 %, is flat).
 */
export function comparison(current: number | null, previous: number | null, unit = 1): Comparison {
  if (current === null || previous === null) return { change: null, ratio: null, direction: null };
  const change = current - previous;
  const ratio = previous !== 0 ? change / previous : null;
  const flat = Math.abs(change) < unit || (ratio !== null && Math.abs(ratio) < 0.05);
  return { change, ratio, direction: flat ? 'flat' : change > 0 ? 'up' : 'down' };
}

/** The last segment of a marker target: Deployment/shop/cart → cart. */
export const markerName = (m: Pick<OverviewMarker, 'target'>) =>
  m.target.split('/').pop() ?? m.target;

/** Colour per kind of change, from the design tokens. */
export const MARKER_TOKEN: Record<string, string> = {
  rollout: '--ok',
  image: '--info',
  scale: '--warning',
  node: '--text-subtle',
  namespace: '--chart-4',
  recreate: '--chart-5',
  compose: '--chart-4',
};

type T = (key: string, values?: Record<string, unknown>) => string;

/** "Rollout · cart", "Scaled 2 → 0 · catalog", "Namespace created · wl-demo". */
export function markerLabel(m: OverviewMarker, t: T): string {
  const d = m.details as Record<string, unknown>;
  const name = markerName(m);
  switch (m.kind) {
    case 'scale':
      return t('overview.changes.scale', { name, from: d.from ?? '?', to: d.to ?? '?' });
    case 'node':
      return t(`overview.changes.node.${d.action === 'removed' ? 'removed' : 'added'}`, { name });
    case 'compose':
      return t(`overview.changes.compose.${d.action === 'down' ? 'down' : 'up'}`, { name });
    case 'rollout':
    case 'image':
    case 'namespace':
    case 'recreate':
      return t(`overview.changes.${m.kind}`, { name });
    default:
      return `${m.kind} · ${name}`;
  }
}

/** Where a change leads: the workload, the node or the namespace's workloads. */
export function markerLink(m: OverviewMarker): RouteLocationRaw | undefined {
  const parts = m.target.split('/');
  if (m.kind === 'node') return { name: 'node', params: { name: parts[1] ?? '' } };
  if (m.kind === 'namespace') return { name: 'workloads', query: { ns: parts[1] ?? '' } };
  // Docker: Container/<host>/<name>, Compose/<host>/<project>.
  if (parts[0] === 'Container' && parts.length === 3)
    return { name: 'docker-container', params: { host: parts[1], name: parts[2] } };
  if (parts[0] === 'Compose' && parts.length === 3)
    return { name: 'containers', query: { project: parts[2] } };
  if (parts.length === 3)
    return {
      name: 'workloads',
      query: { view: 'pods', wkind: parts[0], wns: parts[1], wname: parts[2] },
    };
  return undefined;
}

/** Where a problem leads: its alert, else its object. */
export function problemLink(p: OverviewProblem): RouteLocationRaw {
  if (p.alertId) return { name: 'alert', params: { id: p.alertId } };
  const o = p.object;
  if (o?.kind === 'Pod' && o.namespace)
    return { name: 'pod', params: { namespace: o.namespace, name: o.name } };
  if (o?.kind === 'Node') return { name: 'node', params: { name: o.name } };
  if (o?.kind === 'Container' && o.namespace)
    return { name: 'docker-container', params: { host: o.namespace, name: o.name } };
  return { name: 'workloads', query: o?.namespace ? { ns: o.namespace } : {} };
}

/**
 * The warning events to show: never those already in Needs attention; WatchLog's own
 * pods unless asked for. What was hidden is counted by reason, for the "+ N hidden" row.
 */
export function visibleEvents(events: OverviewEvent[], hideOwn: boolean) {
  const shown: OverviewEvent[] = [];
  const hidden = { covered: 0, own: 0, total: 0 };
  for (const e of events) {
    if (e.covered) hidden.covered++;
    else if (hideOwn && e.watchlog) hidden.own++;
    else {
      shown.push(e);
      continue;
    }
    hidden.total++;
  }
  return { shown, hidden };
}

/** Well-known reasons with a short fix hint (i18n `overview.events.hints.<reason>`). */
export const EVENT_HINTS = new Set([
  'FailedGetResourceMetric',
  'FailedComputeMetricsReplicas',
  'FailedScheduling',
  'FailedMount',
  'FailedAttachVolume',
  'Unhealthy',
  'BackOff',
  'ErrImagePull',
  'ImagePullBackOff',
  'FailedCreatePodSandBox',
  'Evicted',
  'OOMKilling',
  'FailedToCreateEndpoint',
  'ClusterIPNotAllocated',
  'DNSConfigForming',
  'NodeNotReady',
]);

/** Problem type → its chip's colour and the Alerts page filter. */
export function chipLink(t: { type: string; ruleId: string | null }): RouteLocationRaw {
  return t.ruleId ? { name: 'alerts', query: { rule: t.ruleId } } : { name: 'alerts' };
}

/** The values of a series, for sparklines. */
export const values = (points: (number | null)[][]): (number | null)[] =>
  points.map((p) => p[1] ?? null);
