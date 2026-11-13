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
  kind: 'workload' | 'container' | 'route' | 'unknown';
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
  project: string | null;
  composeService: string | null;
  state: string | null;
}

export interface BackendIndex {
  /** Kubernetes Services by "namespace/name". */
  services: Map<string, ServiceRow>;
  namespaces: Set<string>;
  containers: ContainerRow[];
}

export async function backendIndex(db: Database, clusterId: string): Promise<BackendIndex> {
  const rows = await db
    .selectFrom('objects')
    .select(['kind', 'namespace', 'name', 'spec_summary', 'status_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', 'in', ['Service', 'DockerContainer'])
    .where('deleted_at', 'is', null)
    .execute();
  const idx: BackendIndex = { services: new Map(), namespaces: new Set(), containers: [] };
  for (const r of rows) {
    if (r.kind === 'Service') {
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
      const spec = (r.spec_summary ?? {}) as { compose_service?: string };
      const st = (r.status_summary ?? {}) as { state?: string };
      idx.containers.push({
        name: r.name,
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
export function resolveTraefikService(full: string, idx: BackendIndex): TraefikBackend {
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
      const w = s.workloads[0];
      return {
        label: `${ns}/${svc}`,
        kind: w ? 'workload' : 'unknown',
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
    const c =
      // <compose service>-<project>
      idx.containers.find(
        (x) => x.project && x.composeService && `${x.composeService}-${x.project}` === name,
      ) ??
      // a label's own name: the container, or a Compose service of that name
      idx.containers.find((x) => x.name === name) ??
      idx.containers.find((x) => x.composeService === name);
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
