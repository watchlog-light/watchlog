// SPDX-License-Identifier: AGPL-3.0-only
// get_service_map (ADR-128): who talks to whom, and which connections fail.
import { Type } from 'typebox';
import { clusterField, resolveCluster } from '../clusters.js';
import { name, ToolError } from '../output.js';
import { ClusterArg, defineTool, describe, NamespaceArg, round, summary } from './common.js';

const MAX_EDGES = 30;
const MAX_DNS = 10;
/** DNS errors are listed from this share of failed lookups, without a `workload`. */
const DNS_ERROR_RATIO = 0.05;

interface MapNode {
  id: string;
  kind: string;
  name: string;
  namespace: string | null;
  workloadKind: string | null;
}

interface MapEdge {
  source: string;
  target: string;
  port: number;
  service: string | null;
  connectionsPerSecond: number | null;
  failedRatio: number | null;
  latencyP95Seconds: number | null;
  failedLastMinute: number | null;
  health: string;
}

interface Dns {
  node: string;
  requestsPerSecond: number | null;
  nxdomainPerSecond: number | null;
  servfailPerSecond: number | null;
  timeoutPerSecond: number | null;
  errorRatio: number | null;
}

interface ServiceMap {
  mode: 'flows' | 'topology';
  agents: { ebpf: string }[];
  nodes: MapNode[];
  edges: MapEdge[];
  dns: Dns[];
}

const SEVERITY: Record<string, number> = { critical: 0, warning: 1, ok: 2, idle: 3, unknown: 4 };

export const getServiceMapTool = defineTool({
  name: 'get_service_map',
  title: 'Get the service map',
  description: describe(
    'Who talks to whom, from the network flows WatchLog sees with eBPF: connections per second, failed connections, connect latency (p95) and DNS errors, for workloads on Kubernetes and containers on Docker.',
    `Without \`workload\`: only the connections that fail or are slow, cluster-wide. With \`workload\` (a workload name or namespace/name on Kubernetes; a container or Compose service name on Docker): every connection to and from it, and its DNS errors. Returns up to ${MAX_EDGES} connections, worst first: from, to, port, service, connectionsPerSecond, failedRatio, latencyP95Ms, health (ok, warning, critical, idle).`,
    'When no agent has eBPF, the map only shows which services can reach each other (Kubernetes Services, Compose networks), without traffic numbers; `note` says so.',
    'Example question: "Which services fail to connect to the database?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      workload: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 300,
          description:
            'A workload (name or namespace/name) on Kubernetes, or a container or Compose service on Docker.',
        }),
      ),
      namespace: NamespaceArg('Kubernetes: only connections to or from this namespace.'),
      onlyProblems: Type.Optional(
        Type.Boolean({
          description:
            'Only failing or slow connections (default: true without `workload`, false with it).',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.namespace, a.workload, a.onlyProblems && 'problems'),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'docker' && args.namespace) {
      throw new ToolError(
        'Namespaces are a Kubernetes notion; this cluster is a Docker fleet.',
        'Pass a container or Compose service as `workload` instead.',
        { cluster: clusterField(cluster) },
      );
    }
    const map = await api.get<ServiceMap>(`/clusters/${cluster.id}/service-map`, {
      namespaces: args.namespace,
      range: 3600,
    });
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    const ref = (id: string) => {
      const n = byId.get(id);
      if (!n) return { name: name(id) };
      return {
        kind: n.workloadKind ?? n.kind,
        ...(n.namespace
          ? { [cluster.kind === 'docker' ? 'project' : 'namespace']: name(n.namespace) }
          : {}),
        name: name(cluster.kind === 'docker' && n.kind === 'container' ? n.id.slice(2) : n.name),
      };
    };

    let selected: Set<string> | null = null;
    if (args.workload) {
      const w = args.workload;
      const matches = map.nodes.filter(
        (n) =>
          n.name === w ||
          n.id === `c:${w}` ||
          `${n.namespace}/${n.name}` === w ||
          `${n.namespace}/${n.workloadKind}/${n.name}` === w,
      );
      if (matches.length === 0) {
        throw new ToolError(
          'Nothing on the service map has this name.',
          'Pass a workload name or namespace/name, or a running container or Compose service (stopped containers are not on the map); or leave `workload` out to see the failing connections.',
          { workload: name(w) },
        );
      }
      // A Compose service with several containers is all of them.
      const kinds = new Set(matches.map((n) => `${n.namespace}/${n.name}`));
      if (cluster.kind === 'kubernetes' && kinds.size > 1) {
        throw new ToolError(
          'Several workloads have this name: say which as namespace/name.',
          'Pass one of the workloads listed.',
          { workloads: matches.slice(0, 20).map((n) => ref(n.id)) },
        );
      }
      selected = new Set(matches.map((n) => n.id));
    }
    const onlyProblems = args.onlyProblems ?? !selected;
    const edges = map.edges
      .filter((e) => !selected || selected.has(e.source) || selected.has(e.target))
      .filter((e) => !onlyProblems || e.health === 'critical' || e.health === 'warning')
      .sort(
        (a, b) =>
          (SEVERITY[a.health] ?? 9) - (SEVERITY[b.health] ?? 9) ||
          (b.failedRatio ?? 0) - (a.failedRatio ?? 0) ||
          (b.connectionsPerSecond ?? 0) - (a.connectionsPerSecond ?? 0),
      );
    const dns = map.dns
      .filter((d) => (selected ? selected.has(d.node) : (d.errorRatio ?? 0) >= DNS_ERROR_RATIO))
      .sort((a, b) => (b.errorRatio ?? 0) - (a.errorRatio ?? 0))
      .slice(0, MAX_DNS)
      .map((d) => ({
        of: ref(d.node),
        lookupsPerSecond: round(d.requestsPerSecond),
        errorRatio: round(d.errorRatio),
        nxdomainPerSecond: round(d.nxdomainPerSecond),
        servfailPerSecond: round(d.servfailPerSecond),
        timeoutPerSecond: round(d.timeoutPerSecond),
      }));
    const ebpf = map.agents.filter((a) => a.ebpf === 'enabled').length;
    return {
      body: {
        cluster: clusterField(cluster),
        mode: map.mode,
        ebpf: { enabled: ebpf, agents: map.agents.length },
        ...(map.mode === 'topology'
          ? {
              note: 'No agent has eBPF: the map shows which services can reach each other, without traffic numbers.',
            }
          : {}),
        ...(selected ? { workload: ref([...selected][0]!) } : {}),
        onlyProblems,
        dns,
      },
      list: {
        key: 'connections',
        items: edges.slice(0, MAX_EDGES).map((e) => ({
          from: ref(e.source),
          to: ref(e.target),
          port: e.port,
          ...(e.service ? { service: name(e.service) } : {}),
          connectionsPerSecond: round(e.connectionsPerSecond),
          failedRatio: round(e.failedRatio),
          latencyP95Ms: e.latencyP95Seconds === null ? null : round(e.latencyP95Seconds * 1000),
          health: e.health,
          ...(e.failedLastMinute ? { failedLastMinute: e.failedLastMinute } : {}),
        })),
        total: edges.length,
        noun: 'connections',
        narrow: selected
          ? 'Pass `onlyProblems: true` to see only the failing ones.'
          : 'Pass `workload` or `namespace` to narrow them.',
      },
    };
  },
});
