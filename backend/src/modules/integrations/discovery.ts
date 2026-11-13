// SPDX-License-Identifier: AGPL-3.0-only
// Discovery (ADR-132): services the agents already see, by image first and port second,
// that aren't monitored yet. Read-only: nothing is contacted until someone presses
// Monitor. Computed on read from the stored objects, so it is always current.
import type { Database } from '../../db/index.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { clusterFlows, containerKey, looksLikeClient, workloadKey } from './clients.js';
import type { IntegrationTarget, IntegrationType } from './collector-config.js';

export interface ServiceKind {
  type: IntegrationType;
  /** Matches the image's repository path (without registry tag or digest). */
  image: RegExp;
  /** Images that look like it but aren't it (exporters, sidecars, proxies). */
  not?: RegExp;
  /** Ports, the first one being where the collector connects. */
  ports: number[];
  /** Shipped in this version; the others are discovered later (ADR-141). */
  available: boolean;
}

/** ADR-132's table. Image paths are matched after the registry host is removed. */
export const SERVICE_KINDS: ServiceKind[] = [
  {
    type: 'redis',
    image: /(^|\/)(redis|redis-stack-server|redis-stack|valkey)$/,
    not: /(exporter|sentinel|commander|insight)/,
    ports: [6379],
    available: true,
  },
  {
    type: 'postgres',
    image: /(^|\/)(postgres|postgresql|postgis|timescaledb|timescaledb-ha|postgresql-repmgr)$/,
    not: /(exporter|pgbouncer|pgpool|operator|backup)/,
    ports: [5432],
    available: true,
  },
  {
    // ingress-nginx is matched first: its metrics port tells it apart from plain Nginx.
    type: 'nginx',
    image:
      /(^|\/)(ingress-nginx\/controller|nginx-ingress-controller|nginx|nginx-unprivileged|openresty)$/,
    not: /(exporter)/,
    ports: [80, 8080, 443],
    available: true,
  },
  {
    type: 'rabbitmq',
    image: /(^|\/)rabbitmq$/,
    not: /(exporter|operator)/,
    ports: [5672, 15692],
    available: true,
  },
  {
    // MySQL, MariaDB and Percona Server; the Oracle operator's server image is
    // mysql/community-server (ADR-163).
    type: 'mysql',
    image:
      /(^|\/)(mysql|mysql-server|community-server|enterprise-server|mariadb|percona|percona-server|mariadb-galera)$/,
    not: /(exporter|router|operator|backup|sidecar|xtrabackup|maxscale|proxysql|adminer|phpmyadmin)/,
    ports: [3306],
    available: true,
  },
  {
    // The official image, MongoDB's community and enterprise server images (the community
    // operator's), Bitnami's and Percona's (ADR-164).
    type: 'mongodb',
    image:
      /(^|\/)(mongo|mongodb|mongodb-community-server|mongodb-enterprise-server|percona-server-mongodb)$/,
    not: /(exporter|express|operator|agent|backup|sidecar|compass)/,
    ports: [27017],
    available: true,
  },
  {
    // Traefik, k3s's default ingress (its bundled image is rancher/mirrored-library-traefik)
    // and the official image (ADR-165). Port 80 comes first so a port alone never makes a
    // Traefik (Nginx, listed before, owns 80); k3s and the Helm chart declare 8000.
    type: 'traefik',
    image: /(^|\/)(traefik|mirrored-library-traefik)$/,
    not: /(exporter|mesh|forward-auth|certs-dumper)/,
    ports: [80, 8000, 443, 8443, 8080, 9100],
    available: true,
  },
  {
    // Kafka (ADR-166): Apache's JVM and native images, Bitnami's, Confluent's and Strimzi's
    // (quay.io/strimzi/kafka). Every broker is a member; the collector reads the others
    // from Metadata.
    type: 'kafka',
    image: /(^|\/)(kafka|kafka-native|cp-kafka|cp-server)$/,
    not: /(exporter|operator|ui|connect|rest|schema-registry|zookeeper|bridge|mirror|cruise|kafdrop|akhq)/,
    ports: [9092],
    available: true,
  },
  {
    type: 'elasticsearch',
    image: /(^|\/)elasticsearch$/,
    not: /(exporter|operator)/,
    ports: [9200],
    available: false,
  },
];

/** The repository path of an image reference: no registry host, tag or digest. */
export function imagePath(ref: string): string {
  let path = ref.split('@')[0]!;
  const slash = path.lastIndexOf('/');
  const colon = path.lastIndexOf(':');
  if (colon > slash) path = path.slice(0, colon);
  const parts = path.split('/');
  // The first part is a registry when it looks like a host (has a dot or a port, or is localhost).
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) parts.shift();
  return parts.join('/').toLowerCase();
}

/** A compatible server that isn't the type's own: Valkey answers as Redis. */
export function productOfImage(ref: string): string | null {
  const path = imagePath(ref);
  if (/(^|\/)valkey$/.test(path)) return 'valkey';
  if (/(^|\/)(mariadb|mariadb-galera)$/.test(path)) return 'mariadb';
  if (/(^|\/)(ingress-nginx\/controller|nginx-ingress-controller)$/.test(path))
    return 'ingress-nginx';
  return null;
}

/** The image's tag, as a version hint ("16.4" from "postgres:16.4-alpine"). */
export function imageVersion(ref: string): string | null {
  const noDigest = ref.split('@')[0]!;
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon <= slash) return null;
  const tag = noDigest.slice(colon + 1);
  const m = /^v?(\d+(?:\.\d+){0,2})/.exec(tag);
  return m ? m[1]! : null;
}

export function kindOfImage(ref: string): ServiceKind | undefined {
  const path = imagePath(ref);
  return SERVICE_KINDS.find((k) => k.image.test(path) && !(k.not && k.not.test(path)));
}

export function kindOfPorts(ports: number[]): ServiceKind | undefined {
  return SERVICE_KINDS.find((k) => k.ports.slice(0, 1).some((p) => ports.includes(p)));
}

export interface Discovered {
  /** Stable key of the candidate, for the web's lists. */
  key: string;
  clusterId: string;
  clusterName: string;
  clusterKind: 'kubernetes' | 'docker';
  type: IntegrationType;
  name: string;
  image: string | null;
  version: string | null;
  /** "valkey" when the image is Valkey (read by the Redis integration), else null. */
  product: string | null;
  port: number;
  /** image: the image says what it is; port: only a well-known port does. */
  confidence: 'image' | 'port';
  /** Pods or containers behind it. */
  members: number;
  /** Docker: the host the collector runs on. */
  host: string | null;
  /** Kubernetes namespace or Compose project. */
  group: string;
  target: IntegrationTarget;
}

interface Container {
  image?: string;
  ports?: { port?: number; protocol?: string }[];
}

interface Published {
  private_port?: number;
  public_port?: number;
}

/** The port to connect to: one the container declares, else the kind's default. */
function pickPort(kind: ServiceKind, declared: number[]): number {
  return kind.ports.find((p) => declared.includes(p)) ?? kind.ports[0]!;
}

/** The identity of an integration's target, to tell monitored services apart. */
export function targetKey(clusterId: string, type: string, t: IntegrationTarget): string {
  switch (t.kind) {
    case 'workload':
      return `${clusterId}/${type}/w/${t.namespace}/${t.workload_kind}/${t.workload}`;
    case 'compose':
      return `${clusterId}/${type}/c/${t.host}/${t.compose_project}/${t.compose_service}`;
    case 'container':
      return `${clusterId}/${type}/k/${t.host}/${t.container}`;
    case 'address':
      return `${clusterId}/${type}/a/${t.address}`;
  }
}

/** A pod in phase Running, or a running container. */
export function isRunning(kind: string, status: unknown): boolean {
  const st = (status ?? {}) as { phase?: string; state?: string };
  return kind === 'Pod' ? st.phase === 'Running' : st.state === 'running';
}

/** Discovered services of the org's clusters that aren't monitored yet. */
export async function discover(
  db: Database,
  orgId: string,
  clusterId?: string,
  /** With it, client pods and containers that run a server's image are left out (clients.ts). */
  vm?: VictoriaQueryClient,
): Promise<Discovered[]> {
  let q = db.selectFrom('clusters').select(['id', 'name', 'kind']).where('org_id', '=', orgId);
  if (clusterId) q = q.where('id', '=', clusterId);
  const clusters = await q.execute();
  if (clusters.length === 0) return [];
  const ids = clusters.map((c) => c.id);
  const [objects, monitored, ignores] = await Promise.all([
    db
      .selectFrom('objects')
      .select(['cluster_id', 'kind', 'namespace', 'name', 'node', 'spec_summary', 'status_summary'])
      .where('cluster_id', 'in', ids)
      .where('kind', 'in', ['Pod', 'DockerContainer'])
      .where('deleted_at', 'is', null)
      .execute(),
    db
      .selectFrom('integrations')
      .select(['cluster_id', 'type', 'target'])
      .where('cluster_id', 'in', ids)
      .execute(),
    db
      .selectFrom('discovery_ignores')
      .select(['cluster_id', 'service_key', 'group_name'])
      .where('cluster_id', 'in', ids)
      .execute(),
  ]);
  const ignoredKeys = new Set(ignores.flatMap((i) => (i.service_key ? [i.service_key] : [])));
  const ignoredGroups = new Set(
    ignores.flatMap((i) => (i.group_name !== null ? [`${i.cluster_id}/${i.group_name}`] : [])),
  );
  const taken = new Set(
    monitored.map((m) => targetKey(m.cluster_id, m.type, m.target as IntegrationTarget)),
  );
  const byCluster = new Map(clusters.map((c) => [c.id, c]));
  const flows = vm
    ? await clusterFlows(
        vm,
        ids,
        SERVICE_KINDS.flatMap((k) => (k.available ? k.ports : [])),
      )
    : new Map();
  const found = new Map<string, Discovered>();

  for (const o of objects) {
    // Only what runs now: a stopped container or a finished pod isn't a service to offer.
    if (!isRunning(o.kind, o.status_summary)) continue;
    const cluster = byCluster.get(o.cluster_id)!;
    const spec = o.spec_summary as Record<string, unknown>;
    let image: string | undefined;
    let declared: number[] = [];
    let target: IntegrationTarget | undefined;
    let name: string;
    let group: string;
    let host: string | null = null;
    let kind: ServiceKind | undefined;
    let confidence: Discovered['confidence'] = 'image';
    // Who it is in the eBPF flows, and the ports it declares or publishes (it listens there).
    let who: string;
    let listens: number[];

    if (o.kind === 'Pod') {
      const workload = spec.workload as { kind?: string; name?: string } | undefined;
      if (!workload?.kind || !workload.name) continue;
      const containers = (spec.containers as Container[] | undefined) ?? [];
      for (const c of containers) {
        const k = c.image ? kindOfImage(c.image) : undefined;
        if (k) {
          kind = k;
          image = c.image;
          declared = (c.ports ?? []).flatMap((p) => (p.port ? [p.port] : []));
          break;
        }
      }
      if (!kind) {
        const ports = containers.flatMap((c) =>
          (c.ports ?? []).flatMap((p) => (p.port ? [p.port] : [])),
        );
        kind = kindOfPorts(ports);
        if (!kind) continue;
        confidence = 'port';
        declared = ports;
        image = containers[0]?.image;
      }
      const port = pickPort(kind, declared);
      target = {
        kind: 'workload',
        namespace: o.namespace,
        workload_kind: workload.kind,
        workload: workload.name,
        port,
      };
      name = `${o.namespace}/${workload.name}`;
      group = o.namespace;
      who = workloadKey(o.namespace, workload.kind, workload.name);
      listens = declared;
    } else {
      image = spec.image as string | undefined;
      declared = (spec.exposed as number[] | undefined) ?? [];
      kind = image ? kindOfImage(image) : undefined;
      if (!kind) {
        kind = kindOfPorts(declared);
        if (!kind) continue;
        confidence = 'port';
      }
      host = o.node ?? '';
      const port = pickPort(kind, declared);
      const service = spec.compose_service as string | undefined;
      if (o.namespace && service) {
        target = {
          kind: 'compose',
          host,
          compose_project: o.namespace,
          compose_service: service,
          port,
        };
        name = `${o.namespace}/${service}`;
      } else {
        target = { kind: 'container', host, container: o.name, port };
        name = o.name;
      }
      group = o.namespace;
      who = containerKey(o.name);
      listens = ((spec.ports as Published[] | undefined) ?? []).flatMap((p) =>
        p.public_port && p.private_port ? [p.private_port] : [],
      );
    }
    if (!kind.available) continue;
    const sides = flows.get(o.cluster_id);
    if (sides && looksLikeClient(sides, who, kind.ports, listens)) continue;
    const key = targetKey(o.cluster_id, kind.type, target);
    if (taken.has(key) || ignoredKeys.has(key)) continue;
    if (group && ignoredGroups.has(`${o.cluster_id}/${group}`)) continue;
    const seen = found.get(key);
    if (seen) {
      seen.members++;
      continue;
    }
    found.set(key, {
      key,
      clusterId: o.cluster_id,
      clusterName: cluster.name,
      clusterKind: cluster.kind as 'kubernetes' | 'docker',
      type: kind.type,
      name,
      image: image ?? null,
      version: image ? imageVersion(image) : null,
      product: image ? productOfImage(image) : null,
      port: target.port,
      confidence,
      members: 1,
      host,
      group,
      target,
    });
  }
  // The image tells more than a port: image matches first, then by name.
  return [...found.values()].sort(
    (a, b) =>
      (a.confidence === b.confidence ? 0 : a.confidence === 'image' ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
}

export interface Ignored {
  id: string;
  clusterId: string;
  clusterName: string;
  clusterKind: 'kubernetes' | 'docker';
  /** One candidate (by its key) or a namespace or Compose project. */
  scope: 'service' | 'group';
  label: string;
  createdAt: Date;
}

/** What the org's people chose to ignore, newest first, for the restore list. */
export async function listIgnored(
  db: Database,
  orgId: string,
  clusterId?: string,
): Promise<Ignored[]> {
  let q = db
    .selectFrom('discovery_ignores as d')
    .innerJoin('clusters as c', 'c.id', 'd.cluster_id')
    .select([
      'd.id',
      'd.cluster_id',
      'c.name',
      'c.kind',
      'd.service_key',
      'd.label',
      'd.created_at',
    ])
    .where('d.org_id', '=', orgId);
  if (clusterId) q = q.where('d.cluster_id', '=', clusterId);
  const rows = await q.orderBy('d.created_at', 'desc').execute();
  return rows.map((r) => ({
    id: r.id,
    clusterId: r.cluster_id,
    clusterName: r.name,
    clusterKind: r.kind as 'kubernetes' | 'docker',
    scope: r.service_key ? 'service' : 'group',
    label: r.label,
    createdAt: r.created_at,
  }));
}
