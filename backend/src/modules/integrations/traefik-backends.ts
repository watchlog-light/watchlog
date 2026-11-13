// SPDX-License-Identifier: AGPL-3.0-only
// Traefik's service names to the backends behind them (ADR-165), shared by the Traefik
// page and the service map. Measured on Traefik 3.6 (kind and Docker 29):
//   - Ingress (provider kubernetes): `<namespace>-<service>-<port>@kubernetes`;
//   - IngressRoute (kubernetescrd): `<namespace>-<route>-<hash>@kubernetescrd`, a hash in
//     place of the Service, so only the namespace and the route's name can be read;
//   - Docker: `<compose service>-<project>@docker` unless a label names the service
//     (`traefik.http.services.<name>...`), then `<name>@docker`.
// Namespaces and Services contain dashes, so the split is decided against the objects
// the cluster-agent reports, never guessed.
import type { Database } from '../../db/index.js';

export interface TraefikBackend {
  /** What the page shows: "shop/api", "IngressRoute shop/web", "api (Compose storefront)". */
  label: string;
  kind: 'workload' | 'service' | 'container' | 'route' | 'unknown';
  namespace: string | null;
  /** The workload's or container's name; the route's for an IngressRoute. */
  name: string | null;
  workloadKind?: string;
  /** The Kubernetes Service, when known. */
  service?: string;
  /** The Service's ready endpoints (Kubernetes); null when not known. */
  readyEndpoints?: number | null;
  /** The container's state (Docker): running, exited… */
  state?: string;
  /** The service map's node id of the backend, when there is one. */
  mapNode: string | null;
}

interface ServiceRow {
  namespace: string;
  name: string;
  workloads: { kind: string; name: string }[];
  readyEndpoints: number | null;
}

interface ContainerRow {
  name: string;
  ips: string[];
  project: string | null;
  composeService: string | null;
  state: string | null;
}

export interface BackendIndex {
  /** Kubernetes Services by "namespace/name". */
  services: Map<string, ServiceRow>;
  namespaces: Set<string>;
  containers: ContainerRow[];
  /** Deployments, StatefulSets and DaemonSets by "namespace/name": their kind. */
  workloads: Map<string, string>;
}

/** What else is known about a name: its servers' addresses, the Traefik's Compose project. */
export interface ResolveHint {
  /** The addresses of its servers (traefik_service_server_up's url). */
  ips?: string[];
  /** The Compose projects of the Traefik itself: a label's name is looked for there first. */
  projects?: (string | null)[];
}

const WORKLOAD_ORDER = ['Deployment', 'StatefulSet', 'DaemonSet'];

export async function backendIndex(db: Database, clusterId: string): Promise<BackendIndex> {
  const rows = await db
    .selectFrom('objects')
    .select(['kind', 'namespace', 'name', 'spec_summary', 'status_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', 'in', ['Service', 'DockerContainer', ...WORKLOAD_ORDER])
    .where('deleted_at', 'is', null)
    .execute();
  const idx: BackendIndex = {
    services: new Map(),
    namespaces: new Set(),
    containers: [],
    workloads: new Map(),
  };
  for (const r of rows) {
    if (WORKLOAD_ORDER.includes(r.kind)) {
      const key = `${r.namespace}/${r.name}`;
      const had = idx.workloads.get(key);
      if (!had || WORKLOAD_ORDER.indexOf(r.kind) < WORKLOAD_ORDER.indexOf(had))
        idx.workloads.set(key, r.kind);
    } else if (r.kind === 'Service') {
      const st = (r.status_summary ?? {}) as {
        ready_endpoints?: number;
        workloads?: { kind: string; name: string }[];
      };
      idx.namespaces.add(r.namespace);
      idx.services.set(`${r.namespace}/${r.name}`, {
        namespace: r.namespace,
        name: r.name,
        workloads: st.workloads ?? [],
        readyEndpoints: st.ready_endpoints ?? null,
      });
    } else {
      const spec = (r.spec_summary ?? {}) as { compose_service?: string; ips?: string[] };
      const st = (r.status_summary ?? {}) as { state?: string };
      idx.containers.push({
        name: r.name,
        ips: spec.ips ?? [],
        project: r.namespace || null,
        composeService: spec.compose_service || null,
        state: st.state ?? null,
      });
    }
  }
  return idx;
}

/** Splits "a-b-c" at each dash: [["a", "b-c"], ["a-b", "c"]]. */
function splits(s: string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = s.indexOf('-'); i > 0; i = s.indexOf('-', i + 1))
    out.push([s.slice(0, i), s.slice(i + 1)]);
  return out;
}

const HASH = /^(.+)-[0-9a-f]{20}$/;

/** The backend behind one of Traefik's service names. */
export function resolveTraefikService(
  full: string,
  idx: BackendIndex,
  hint: ResolveHint = {},
): TraefikBackend {
  const at = full.lastIndexOf('@');
  const name = at > 0 ? full.slice(0, at) : full;
  const provider = at > 0 ? full.slice(at + 1) : '';
  const unknown: TraefikBackend = {
    label: full,
    kind: 'unknown',
    namespace: null,
    name: null,
    mapNode: null,
  };
  if (provider === 'kubernetes' || provider === 'kubernetescrd') {
    // <namespace>-<service>-<port>: the port is the last part.
    const dash = name.lastIndexOf('-');
    const head = dash > 0 ? name.slice(0, dash) : name;
    for (const [ns, svc] of splits(head)) {
      const s = idx.services.get(`${ns}/${svc}`);
      if (!s) continue;
      // A Service whose pods are all gone lists no workload (scaled to 0, measured): the
      // workload of the same name in its namespace, the usual convention, stands in.
      const same = idx.workloads.get(`${ns}/${svc}`);
      const w = s.workloads[0] ?? (same ? { kind: same, name: svc } : undefined);
      return {
        label: `${ns}/${svc}`,
        kind: w ? 'workload' : 'service',
        namespace: ns,
        name: w?.name ?? null,
        workloadKind: w?.kind,
        service: svc,
        readyEndpoints: s.readyEndpoints,
        mapNode: w ? `w:${ns}/${w.kind}/${w.name}` : `s:${ns}/${svc}`,
      };
    }
    // An IngressRoute: <namespace>-<route>-<hash>.
    const m = HASH.exec(name);
    if (m) {
      for (const [ns, route] of splits(m[1]!)) {
        if (!idx.namespaces.has(ns)) continue;
        return {
          label: `IngressRoute ${ns}/${route}`,
          kind: 'route',
          namespace: ns,
          name: route,
          mapNode: null,
        };
      }
    }
    return unknown;
  }
  if (provider === 'docker') {
    const byIp = (hint.ips ?? []).length
      ? idx.containers.find((x) => x.ips.some((ip) => hint.ips!.includes(ip)))
      : undefined;
    // A label's own name ("api") can be several projects' Compose service: Traefik's own
    // project first, then a running one (measured: an exited causes-e2e api was picked).
    const named = idx.containers
      .filter((x) => x.name === name || x.composeService === name)
      .sort(
        (a, b) =>
          Number((hint.projects ?? []).includes(b.project)) -
            Number((hint.projects ?? []).includes(a.project)) ||
          Number(b.state === 'running') - Number(a.state === 'running') ||
          Number(b.name === name) - Number(a.name === name),
      );
    const c =
      byIp ??
      // <compose service>-<project>
      idx.containers.find(
        (x) => x.project && x.composeService && `${x.composeService}-${x.project}` === name,
      ) ??
      named[0];
    if (!c) return unknown;
    return {
      label: c.project ? `${c.composeService ?? c.name} (${c.project})` : c.name,
      kind: 'container',
      namespace: c.project,
      name: c.name,
      state: c.state ?? undefined,
      mapNode: `c:${c.name}`,
    };
  }
  return unknown;
}

/** Traefik's own services (dashboard, API, ping, metrics): never a backend. */
export const isInternal = (full: string) => full.endsWith('@internal');

/**
 * Whether a backend has no server up: Traefik's health checks first (`up` is the max of
 * traefik_service_server_up), else its objects: a Service with no ready endpoint, a
 * container that isn't running.
 */
export function noServerUp(b: TraefikBackend, up: number | undefined): boolean {
  if (up !== undefined) return up === 0;
  if (b.kind === 'container') return b.state !== undefined && b.state !== 'running';
  return b.readyEndpoints === 0;
}
