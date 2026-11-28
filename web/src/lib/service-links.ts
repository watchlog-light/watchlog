// SPDX-License-Identifier: AGPL-3.0-only
// Where a service page's links go (1.1.0, ADR-243): a workload or a container, a RabbitMQ
// queue's own page, a tab of the page (with a filter), or the docs.
import type { RouteLocationRaw } from 'vue-router';

export type PanelLink =
  | { kind: 'workload' | 'container'; id: string; name: string }
  | { kind: 'queue'; vhost: string; queue: string; name: string }
  | { kind: 'tab'; tab: string; filter?: string; name: string }
  | { kind: 'docs'; href: string; name: string }
  /** A database's statement or table page (1.2). */
  | { kind: 'statement' | 'table'; id: string; name: string }
  /** Another item page (1.4: a Redis key prefix, command or stream group). */
  | { kind: 'item'; tab: string; id: string; name: string };

/** A RabbitMQ queue's page: /applications/:id/queues/:queue, ?vhost= outside the default. */
export function queueRoute(appId: string, vhost: string, queue: string): RouteLocationRaw {
  return {
    name: 'application-queue',
    params: { id: appId, queue },
    query: vhost && vhost !== '/' ? { vhost } : {},
  };
}

/** A database statement's page (1.2): /applications/:id/statements/:statement. */
export function statementRoute(appId: string, statement: string): RouteLocationRaw {
  return { name: 'application-statement', params: { id: appId, statement } };
}

/** A database table's page (1.2): /applications/:id/tables/:db/:table. */
export function tableRoute(appId: string, id: string): RouteLocationRaw {
  const slash = id.indexOf('/');
  return {
    name: 'application-table',
    params: { id: appId, db: id.slice(0, slash), table: id.slice(slash + 1) },
  };
}

/** Another item page (1.4): /applications/:id/items/:tab/:item. */
export function itemRoute(appId: string, tab: string, item: string): RouteLocationRaw {
  return { name: 'application-item', params: { id: appId, tab, item } };
}

/** The route of a link, or null for the docs (an external href) and unknowable places. */
export function linkRoute(l: PanelLink, appId: string, clusterId: string): RouteLocationRaw | null {
  const cluster = { cluster: clusterId };
  switch (l.kind) {
    case 'queue':
      return queueRoute(appId, l.vhost, l.queue);
    case 'tab':
      return {
        name: 'application',
        params: { id: appId },
        query: { tab: l.tab, ...(l.filter ? { filter: l.filter } : {}) },
      };
    case 'workload': {
      // namespace/Kind/name; a server's unit or process group has its server as namespace.
      const [ns, kind, ...rest] = l.id.split('/');
      const name = rest.join('/');
      if ((kind === 'Service' || kind === 'ProcessGroup') && ns)
        return { name: 'server', params: { server: ns }, query: cluster };
      return {
        name: 'workloads',
        query: { ...cluster, view: 'pods', wns: ns, wkind: kind, wname: name },
      };
    }
    case 'container': {
      const slash = l.id.indexOf('/');
      return slash > 0
        ? {
            name: 'docker-container',
            params: { host: l.id.slice(0, slash), name: l.id.slice(slash + 1) },
            query: cluster,
          }
        : { name: 'containers', query: { ...cluster, q: l.id } };
    }
    case 'statement':
      return statementRoute(appId, l.id);
    case 'table':
      return l.id.includes('/') ? tableRoute(appId, l.id) : null;
    case 'item':
      return itemRoute(appId, l.tab, l.id);
    case 'docs':
      return null;
  }
}
