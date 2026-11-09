// SPDX-License-Identifier: AGPL-3.0-only
// What a collector reads (ADR-131): its cluster's integrations with the addresses of
// their members, resolved from what the agents reported. The configuration is
// versioned by a hash so a collector long-polls for changes (ETag / If-None-Match).
import { createHash } from 'node:crypto';
import type { Database } from '../../db/index.js';

export const INTEGRATION_TYPES = [
  'redis',
  'postgres',
  'nginx',
  'rabbitmq',
  'mongodb',
  'elasticsearch',
] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** Where a service runs and how to reach it, with the names the agents saw. */
export type IntegrationTarget =
  | { kind: 'workload'; namespace: string; workload_kind: string; workload: string; port: number }
  | {
      kind: 'compose';
      host: string;
      compose_project: string;
      compose_service: string;
      port: number;
    }
  | { kind: 'container'; host: string; container: string; port: number }
  | { kind: 'address'; address: string };

export interface CollectorMember {
  /** Pod or container name; the address for an added-by-hand service. */
  name: string;
  /** host:port the collector connects to. */
  address: string;
}

export interface CollectorTarget {
  id: string;
  type: IntegrationType;
  name: string;
  members: CollectorMember[];
  settings: { query_text: boolean };
}

export interface CollectorConfig {
  version: string;
  scrape: { interval_s: number; heavy_every: number };
  targets: CollectorTarget[];
}

/** Scrape tiers (ADR-131): 15 s, heavy views (tables, statements, queues) every 30 s. */
export const SCRAPE_INTERVAL_S = 15;
export const HEAVY_EVERY = 2;
/** Members per target the collector connects to (replicas of one service). */
export const MAX_MEMBERS = 16;

interface PodRow {
  namespace: string;
  name: string;
  spec_summary: unknown;
  status_summary: unknown;
}
interface ContainerRow {
  namespace: string;
  name: string;
  node: string | null;
  spec_summary: unknown;
}

function joinHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Pods of the workload that have an IP, by name. */
function podMembers(
  pods: PodRow[],
  t: Extract<IntegrationTarget, { kind: 'workload' }>,
): CollectorMember[] {
  return pods
    .filter((p) => {
      const w = (p.spec_summary as { workload?: { kind?: string; name?: string } }).workload;
      return p.namespace === t.namespace && w?.kind === t.workload_kind && w?.name === t.workload;
    })
    .flatMap((p) => {
      const ip = (p.status_summary as { pod_ip?: string }).pod_ip;
      return ip ? [{ name: p.name, address: joinHostPort(ip, t.port) }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A container's address as seen from its host's network: its own IP on a bridge
 * network when the agent reported one (`ips`), else a port it publishes on the host.
 */
export function containerAddress(spec: unknown, port: number): string | null {
  const s = spec as {
    ips?: string[];
    ports?: { ip?: string; public_port: number; private_port: number }[];
  };
  const ip = s.ips?.find((x) => x);
  if (ip) return joinHostPort(ip, port);
  const published = s.ports?.find((p) => p.private_port === port && p.public_port > 0);
  if (published) return joinHostPort('127.0.0.1', published.public_port);
  return null;
}

function containerMembers(rows: ContainerRow[], t: IntegrationTarget): CollectorMember[] {
  if (t.kind !== 'compose' && t.kind !== 'container') return [];
  return rows
    .filter((c) => {
      if (c.node !== t.host) return false;
      if (t.kind === 'container') return c.name === t.container;
      const svc = (c.spec_summary as { compose_service?: string }).compose_service;
      return c.namespace === t.compose_project && svc === t.compose_service;
    })
    .flatMap((c) => {
      const address = containerAddress(c.spec_summary, t.port);
      return address ? [{ name: c.name, address }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The configuration of one collector: on Kubernetes host '', on Docker its host name. */
export async function buildCollectorConfig(
  db: Database,
  clusterId: string,
  host: string,
): Promise<CollectorConfig> {
  const rows = await db
    .selectFrom('integrations')
    .select(['id', 'type', 'name', 'target', 'settings', 'status'])
    .where('cluster_id', '=', clusterId)
    .where('collector_host', '=', host)
    .where('status', '<>', 'paused')
    .orderBy('id')
    .execute();
  const targets = rows.map((r) => ({ ...r, target: r.target as IntegrationTarget }));
  const needsPods = targets.some((t) => t.target.kind === 'workload');
  const needsContainers = targets.some(
    (t) => t.target.kind === 'compose' || t.target.kind === 'container',
  );
  const [pods, containers] = await Promise.all([
    needsPods
      ? db
          .selectFrom('objects')
          .select(['namespace', 'name', 'spec_summary', 'status_summary'])
          .where('cluster_id', '=', clusterId)
          .where('kind', '=', 'Pod')
          .where('deleted_at', 'is', null)
          .where(
            'namespace',
            'in',
            targets.flatMap((t) => (t.target.kind === 'workload' ? [t.target.namespace] : [])),
          )
          .execute()
      : Promise.resolve([] as PodRow[]),
    needsContainers
      ? db
          .selectFrom('objects')
          .select(['namespace', 'name', 'node', 'spec_summary'])
          .where('cluster_id', '=', clusterId)
          .where('kind', '=', 'DockerContainer')
          .where('deleted_at', 'is', null)
          .where('node', '=', host)
          .execute()
      : Promise.resolve([] as ContainerRow[]),
  ]);

  const out: CollectorTarget[] = targets.map((t) => {
    let members: CollectorMember[];
    switch (t.target.kind) {
      case 'workload':
        members = podMembers(pods as PodRow[], t.target);
        break;
      case 'address':
        members = [{ name: t.target.address, address: t.target.address }];
        break;
      default:
        members = containerMembers(containers as ContainerRow[], t.target);
    }
    const settings = t.settings as { query_text?: boolean };
    return {
      id: t.id,
      type: t.type as IntegrationType,
      name: t.name,
      members: members.slice(0, MAX_MEMBERS),
      settings: { query_text: settings.query_text !== false },
    };
  });
  const body = {
    scrape: { interval_s: SCRAPE_INTERVAL_S, heavy_every: HEAVY_EVERY },
    targets: out,
  };
  const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
  return { version, ...body };
}
