// SPDX-License-Identifier: AGPL-3.0-only
// Egress watch in the dashboard (ADR-188): the API's rows in each platform's words (ADR-124),
// the request paths, and the short "3 h ago" times. Destination names come from DNS answers
// that anyone can register: they are shown as text in their own cells, never as links.
import type { Egress, EgressRow, EgressSource } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';

export type EgressRange = '1h' | '24h' | '7d' | '30d';
export const EGRESS_RANGES: EgressRange[] = ['1h', '24h', '7d', '30d'];
export const EGRESS_RANGE_SECONDS: Record<EgressRange, number> = {
  '1h': 3600,
  '24h': 86_400,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
};
export const EGRESS_BADGE_FILTERS = ['new', 'raw_ip', 'failing', 'not_expected'] as const;
export type EgressBadgeFilter = (typeof EGRESS_BADGE_FILTERS)[number];

/** The API's filters (Kubernetes: namespace, kind, workload; Docker: host, project, ...). */
export type EgressQuery = Partial<
  Record<
    | 'namespace'
    | 'kind'
    | 'workload'
    | 'host'
    | 'project'
    | 'service'
    | 'container'
    | 'badge'
    | 'q',
    string
  >
>;

/** GET /egress for a cluster, its filters and a range ending now (24 h is the default). */
export function egressPath(
  clusterId: string,
  query: EgressQuery,
  range: EgressRange = '24h',
  now = Date.now(),
): string {
  const p = new URLSearchParams({ cluster: clusterId });
  for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
  if (range !== '24h') {
    p.set('from', String(Math.floor(now / 1000) - EGRESS_RANGE_SECONDS[range]));
  }
  return `/egress?${p.toString()}`;
}

/** A source in its platform's words: "shop / orders", "storefront · api", "cron on h2". */
export function sourceName(s: EgressSource): string {
  if (s.workload !== undefined) return `${s.namespace} / ${s.workload}`;
  if (s.composeService !== undefined) return `${s.composeProject} · ${s.composeService}`;
  return `${s.container} (${s.host})`;
}

/** Where a source's own page is: the workload's pods, the Compose service, the container. */
export function sourceLink(s: EgressSource, clusterId: string): RouteLocationRaw {
  if (s.workload !== undefined) {
    return {
      name: 'workloads',
      query: {
        cluster: clusterId,
        view: 'pods',
        wkind: s.workloadKind,
        wname: s.workload,
        wns: s.namespace,
      },
    };
  }
  if (s.composeService !== undefined) {
    return {
      name: 'containers',
      query: { cluster: clusterId, project: s.composeProject, service: s.composeService },
    };
  }
  return {
    name: 'docker-container',
    params: { host: s.host!, name: s.container! },
    query: { cluster: clusterId },
  };
}

/** The label under a destination: what it is, when it isn't a plain DNS name. */
export function classLabel(r: Pick<EgressRow, 'class'>): string | null {
  switch (r.class) {
    case 'local_name':
      return 'egress.class.localName';
    case 'private_network':
      return 'egress.class.privateNetwork';
    case 'public_network':
      return 'egress.class.publicNetwork';
    case 'internet':
      return 'egress.class.internet';
    default:
      return null;
  }
}

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string;

/** "now", "4 min ago", "3 h ago", "41 days ago". */
export function ago(iso: string, t: Translate, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 120) return t('egress.ago.now');
  if (s < 5400) return t('egress.ago.minutes', { n: Math.round(s / 60) });
  if (s < 172_800) return t('egress.ago.hours', { n: Math.round(s / 3600) });
  const d = Math.round(s / 86_400);
  return t('egress.ago.days', { n: d }, d);
}

/** The first-seen cell: "3 h ago", or "before Nov 1" when the history starts there. */
export function firstSeenText(
  r: Pick<EgressRow, 'firstSeen' | 'firstSeenBefore'>,
  t: Translate,
  now = Date.now(),
) {
  if (r.firstSeenBefore) {
    const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
      new Date(r.firstSeen),
    );
    return t('egress.before', { day });
  }
  return ago(r.firstSeen, t, now);
}

/** "0 %", "0.2 %", "34 %"; a dash when there were no connections in the range. */
export function percent(ratio: number | null): string {
  if (ratio === null) return '–';
  const p = ratio * 100;
  if (p === 0) return '0 %';
  if (p < 1) return `${Math.max(0.1, Math.round(p * 10) / 10)} %`;
  return `${Math.round(p)} %`;
}

/** The header's "learned from 41 days of traffic" or "learning until Nov 22". */
export function learningText(l: Egress['learning'], t: Translate): string {
  if (l.learning) {
    const until = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
      new Date(l.until),
    );
    return t('egress.learningUntil', { until });
  }
  return t('egress.learnedFrom', { n: l.days }, l.days);
}

/** The API's source for an expectation, from a row's source (ADR-186). */
export function sourceInput(s: EgressSource): Record<string, string> {
  if (s.workload !== undefined) {
    return { namespace: s.namespace!, workloadKind: s.workloadKind!, workload: s.workload };
  }
  if (s.composeService !== undefined) {
    return { composeProject: s.composeProject!, composeService: s.composeService };
  }
  return { host: s.host!, container: s.container! };
}

/**
 * The pattern "Mark expected" offers first: `*.` and the name's last two labels for a name of
 * three or more (`s3.eu-central-1.amazonaws.com` → `*.amazonaws.com`), otherwise the
 * destination itself (a two-label name, a local name, a raw network).
 */
export function suggestPattern(r: Pick<EgressRow, 'destination' | 'class'>): string {
  if (r.class !== 'name') return r.destination;
  const labels = r.destination.split('.');
  return labels.length >= 3 ? `*.${labels.slice(-2).join('.')}` : r.destination;
}

/** Whether an expectation's label needs its pattern ("Expected · *.amazonaws.com"). */
export function showsPattern(r: Pick<EgressRow, 'destination' | 'expected'>): boolean {
  return !!r.expected && r.expected.pattern !== r.destination.toLowerCase();
}
