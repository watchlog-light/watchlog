// SPDX-License-Identifier: AGPL-3.0-only
// Applications (SPEC §4.12): what the list shows for each monitored or discovered service.
import type { Application, ApplicationHealth, DiscoveredService } from '@watchlog/api-types';

export type Family = 'databases' | 'caches' | 'queues' | 'proxies' | 'search';

/** Each type's name, its family (the list's filters) and the one-word kind under the name. */
export const SERVICE_TYPES: Record<string, { name: string; family: Family }> = {
  postgres: { name: 'PostgreSQL', family: 'databases' },
  mongodb: { name: 'MongoDB', family: 'databases' },
  redis: { name: 'Redis', family: 'caches' },
  rabbitmq: { name: 'RabbitMQ', family: 'queues' },
  nginx: { name: 'Nginx', family: 'proxies' },
  elasticsearch: { name: 'Elasticsearch', family: 'search' },
};
export const FAMILIES: Family[] = ['databases', 'caches', 'queues', 'proxies', 'search'];

export const serviceName = (type: string) => SERVICE_TYPES[type]?.name ?? type;
export const familyOf = (type: string): Family => SERVICE_TYPES[type]?.family ?? 'databases';

/** Types that need a read-only user before WatchLog can read them (ADR-134). */
export const NEEDS_USER = new Set(['postgres']);

const ORDER: Record<ApplicationHealth, number> = { critical: 0, warning: 1, unknown: 2, ok: 3 };

export type SortKey = 'problems' | 'name' | 'cluster';

export function sortApplications(list: Application[], by: SortKey): Application[] {
  const byName = (a: Application, b: Application) => a.name.localeCompare(b.name);
  return [...list].sort((a, b) => {
    if (by === 'name') return byName(a, b);
    if (by === 'cluster') return a.cluster.name.localeCompare(b.cluster.name) || byName(a, b);
    return ORDER[a.health] - ORDER[b.health] || byName(a, b);
  });
}

/** Counts per family, for the filter chips (only families with services). */
export function familyCounts(list: Application[]): { family: Family; n: number }[] {
  const n = new Map<Family, number>();
  for (const a of list) n.set(familyOf(a.type), (n.get(familyOf(a.type)) ?? 0) + 1);
  return FAMILIES.filter((f) => n.has(f)).map((f) => ({ family: f, n: n.get(f)! }));
}

/** The one-line reason as an i18n key and its values. */
export function reasonText(
  a: Pick<Application, 'reason' | 'cluster'>,
  formatTime: (iso: string) => string,
): { key: string; values: Record<string, unknown> } {
  const f = a.reason.facts;
  switch (a.reason.code) {
    case 'collector_missing':
      return f.host
        ? { key: 'applications.reason.collectorMissingHost', values: { host: f.host } }
        : { key: 'applications.reason.collectorMissing', values: { cluster: a.cluster.name } };
    case 'collector_silent':
      return {
        key: 'applications.reason.collectorSilent',
        values: { since: formatTime(String(f.since)) },
      };
    case 'unreachable':
      return f.error
        ? { key: 'applications.reason.unreachableError', values: { error: f.error } }
        : { key: 'applications.reason.unreachable', values: {} };
    case 'connected':
      return Number(f.up) < Number(f.members)
        ? { key: 'applications.reason.someDown', values: { up: f.up, members: f.members } }
        : { key: 'applications.reason.connected', values: {} };
    case 'paused':
      return { key: 'applications.reason.paused', values: {} };
    default:
      return { key: 'applications.reason.waiting', values: {} };
  }
}

/** "staging/postgres" with the cluster's words for where it runs. */
export function whereText(a: Pick<Application, 'cluster' | 'where'>): string {
  const parts = [a.cluster.name];
  if (a.where.host && a.cluster.kind === 'docker') parts.push(a.where.host);
  if (a.where.group) parts.push(a.where.group);
  if (a.where.address) parts.push(a.where.address);
  return parts.join(' · ');
}

/** What a discovered service's row says about how it was found. */
export function discoveredHint(d: DiscoveredService): {
  key: string;
  values: Record<string, unknown>;
} {
  if (d.confidence === 'port')
    return { key: 'applications.discovered.byPort', values: { port: d.port } };
  return d.cluster.kind === 'docker' && d.group
    ? {
        key: 'applications.discovered.byImageCompose',
        values: { image: d.image, project: d.group, port: d.port },
      }
    : { key: 'applications.discovered.byImage', values: { image: d.image, port: d.port } };
}
