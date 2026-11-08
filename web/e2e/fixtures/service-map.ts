// SPDX-License-Identifier: AGPL-3.0-only
// Service maps for the responsive suite, so its service map checks don't depend on a
// cluster reporting at that moment. The shape is GET /clusters/:id/service-map as
// measured on a dev install (2026-11-08): node and edge ids, every field, flows mode;
// the names are the demo shop on Kubernetes and a Compose storefront on a Docker host.

type Health = 'ok' | 'warning' | 'critical' | 'idle' | 'unknown';
type Kind = 'workload' | 'service' | 'node' | 'container' | 'external';

interface MapNode {
  id: string;
  kind: Kind;
  name: string;
  namespace: string | null;
  workloadKind: string | null;
  watchlog: boolean;
}

const node = (
  id: string,
  kind: Kind,
  name: string,
  namespace: string | null = null,
  workloadKind: string | null = null,
): MapNode => ({ id, kind, name, namespace, workloadKind, watchlog: false });

const workload = (ns: string, name: string, kind = 'Deployment') =>
  node(`w:${ns}/${kind}/${name}`, 'workload', name, ns, kind);
const container = (name: string, project: string | null = null) =>
  node(`c:${name}`, 'container', name, project);
const external = (name: string) => node(`x:${name}`, 'external', name);

/** An edge with traffic: connections a second, failures and p95 latency set its health. */
function edge(
  source: MapNode,
  target: MapNode,
  port: number,
  cps: number,
  opts: { failed?: number; p95?: number; service?: string; health?: Health } = {},
) {
  const failed = opts.failed ?? 0;
  const p95 = opts.p95 ?? 0.004;
  return {
    id: `${source.id}>${target.id}:${port}`,
    source: source.id,
    target: target.id,
    port,
    service: opts.service ?? null,
    connectionsPerSecond: cps,
    failedPerSecond: failed,
    failedRatio: cps + failed > 0 ? failed / (cps + failed) : null,
    latencyMeanSeconds: p95 / 2,
    latencyP95Seconds: p95,
    bytesSentPerSecond: cps * 900,
    bytesReceivedPerSecond: cps * 4200,
    retransmitsPerSecond: 0,
    health: opts.health ?? (failed > 0 ? 'critical' : p95 > 0.25 ? 'warning' : 'ok'),
    failedLastMinute: Math.round(failed * 60),
  };
}

const agent = (name: string) => ({
  node: name,
  ebpf: 'enabled',
  reason: null,
  cause: null,
  fix: null,
});

function kubernetesMap() {
  const ns = 'shop';
  const [frontend, catalog, cart, orders, sessions, loadgen] = [
    'frontend',
    'catalog',
    'cart',
    'orders',
    'sessions',
    'loadgen',
  ].map((n) => workload(ns, n));
  const redis = workload(ns, 'redis', 'StatefulSet');
  const postgres = workload(ns, 'postgres', 'StatefulSet');
  const payments = external('payments.example.com:443');
  const nodes = [
    loadgen!,
    frontend!,
    catalog!,
    cart!,
    orders!,
    sessions!,
    redis,
    postgres,
    payments,
  ];
  const edges = [
    edge(loadgen!, frontend!, 8080, 24, { service: 'frontend' }),
    edge(frontend!, catalog!, 8080, 18, { service: 'catalog' }),
    edge(frontend!, cart!, 8080, 9, { service: 'cart', p95: 0.41 }),
    edge(frontend!, sessions!, 8080, 12, { service: 'sessions' }),
    edge(cart!, redis, 6379, 30, { service: 'redis' }),
    edge(frontend!, orders!, 8080, 3, { service: 'orders', failed: 0.6 }),
    edge(orders!, postgres, 5432, 6, { service: 'postgres' }),
    edge(catalog!, postgres, 5432, 8, { service: 'postgres' }),
    edge(orders!, payments, 443, 1.5),
  ];
  return {
    mode: 'flows',
    agents: ['kind-control-plane', 'kind-worker', 'kind-worker2'].map(agent),
    nodes,
    edges,
    dns: [],
  };
}

function dockerMap() {
  const project = 'storefront';
  const [web, api, worker, db, cache] = ['web-1', 'api-1', 'worker-1', 'db-1', 'cache-1'].map((n) =>
    container(`${project}-${n}`, project),
  );
  const proxy = container('edge-proxy');
  const registry = external('registry.example.com:443');
  const nodes = [proxy, web!, api!, worker!, db!, cache!, registry];
  const edges = [
    edge(proxy, web!, 80, 20),
    edge(web!, api!, 8080, 15),
    edge(api!, db!, 5432, 11, { p95: 0.32 }),
    edge(api!, cache!, 6379, 25),
    edge(worker!, db!, 5432, 2, { failed: 0.4 }),
    edge(worker!, registry, 443, 0.2),
  ];
  return { mode: 'flows', agents: ['docker-01', 'docker-02'].map(agent), nodes, edges, dns: [] };
}

export const SERVICE_MAPS = { kubernetes: kubernetesMap(), docker: dockerMap() } as const;
