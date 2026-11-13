// SPDX-License-Identifier: AGPL-3.0-only
// The live connection checklist (ADR-176, SPEC §10.2 step 4), from data the backend
// already has: the agents' heartbeats (agent_instances), the first series in
// VictoriaMetrics, eBPF as each agent reports it (ADR-107), and the service map's first
// edges. Nothing is invented while waiting: a step is `waiting` until its data is there.
import type { Database } from '../../db/index.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { CLUSTER_STALE_MS, type ClusterKind } from '../clusters/service.js';
import { agentEbpf, type AgentCapabilities, type EbpfCause } from '../servicemap/ebpf-fix.js';
import { buildGraph, EDGE_LABELS } from '../servicemap/graph.js';

export type StepId = 'agent' | 'clusterAgent' | 'metrics' | 'ebpf' | 'map';
/** waiting: no data yet; done; off: eBPF isn't running (and so no flows for the map). */
export type StepState = 'waiting' | 'done' | 'off';

export interface OnboardingStep {
  id: StepId;
  state: StepState;
  /** When the step's data first appeared, where the backend knows it. */
  since: string | null;
  /** agent: nodes or hosts reporting; metrics: nodes or hosts with series. */
  nodes?: number;
  /** metrics: containers with series. */
  containers?: number;
  /** ebpf: agents with eBPF on, of all node or host agents. */
  enabled?: number;
  agents?: number;
  /** ebpf off: the first agent without it, why (the agent's words), the cause and a fix. */
  node?: string | null;
  reason?: string | null;
  cause?: EbpfCause | null;
  fix?: string | null;
  /** map: nodes and edges drawn so far. */
  services?: number;
  connections?: number;
}

export interface OnboardingStatus {
  clusterId: string;
  kind: ClusterKind;
  createdAt: string;
  /** The server's clock when this was computed. */
  now: string;
  steps: OnboardingStep[];
  /** First metrics are in: "Open dashboard" becomes the primary action. */
  ready: boolean;
  /** No step is waiting any more; the stream ends. */
  complete: boolean;
}

export interface StatusCluster {
  id: string;
  kind: string;
  created_at: Date;
  scope: ClusterScope;
}

export interface StatusDeps {
  db: Database;
  victoria: VictoriaQueryClient | null;
  /** For the eBPF fix command (the same as the service map's). */
  install: { endpoint: string; image: string; version?: string };
}

/** Edges whose flows had any connection or bytes in the last 10 minutes. */
const SEEN_WINDOW = '10m';
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function count(
  victoria: VictoriaQueryClient,
  scope: ClusterScope,
  expr: string,
): Promise<number> {
  const r = await victoria.query(scope, `count(${expr})`);
  return r[0]?.points[0]?.[1] ?? 0;
}

/** The checklist for one cluster, already authorised by clusterForOrg. */
export async function onboardingStatus(
  deps: StatusDeps,
  cluster: StatusCluster,
  now = new Date(),
): Promise<OnboardingStatus> {
  const kind = cluster.kind as ClusterKind;
  const fresh = new Date(now.getTime() - CLUSTER_STALE_MS);
  const rows = await deps.db
    .selectFrom('agent_instances')
    .select(['node', 'mode', 'capabilities', 'created_at', 'last_seen_at'])
    .where('cluster_id', '=', cluster.id)
    .where('last_seen_at', '>', fresh)
    .orderBy('node')
    .execute();
  const nodes = rows.filter((r) => r.mode === 'node' || r.mode === 'docker');
  const clusterAgent = rows.find((r) => r.mode === 'cluster');
  const first = (list: typeof rows) =>
    list.reduce<Date | null>((m, r) => (!m || r.created_at < m ? r.created_at : m), null);

  const steps: OnboardingStep[] = [
    {
      id: 'agent',
      state: nodes.length ? 'done' : 'waiting',
      since: iso(first(nodes)),
      nodes: nodes.length,
    },
  ];
  if (kind === 'kubernetes') {
    steps.push({
      id: 'clusterAgent',
      state: clusterAgent ? 'done' : 'waiting',
      since: iso(clusterAgent?.created_at),
    });
  }

  // Metrics: asked only once an agent reports, so a waiting wizard costs no queries.
  let metricNodes = 0;
  let containers = 0;
  if (rows.length && deps.victoria) {
    try {
      [metricNodes, containers] = await Promise.all([
        count(deps.victoria, cluster.scope, 'watchlog_node_cpu_count'),
        count(deps.victoria, cluster.scope, 'watchlog_container_memory_working_set_bytes'),
      ]);
    } catch {
      // VictoriaMetrics unreachable: the step keeps waiting; the next poll asks again.
    }
  }
  const metricsDone = metricNodes > 0 || containers > 0;
  steps.push({
    id: 'metrics',
    state: metricsDone ? 'done' : 'waiting',
    since: null,
    nodes: metricNodes,
    containers,
  });

  // eBPF: each node or host agent says at start whether its programs loaded (ADR-107).
  const states = nodes.map((r) =>
    agentEbpf(r.node, r.mode, (r.capabilities ?? {}) as AgentCapabilities, {
      ...deps.install,
      name: undefined,
    }),
  );
  const enabled = states.filter((s) => s.ebpf === 'enabled').length;
  const without = states.find((s) => s.ebpf !== 'enabled');
  steps.push({
    id: 'ebpf',
    state: !nodes.length ? 'waiting' : without ? 'off' : 'done',
    since: null,
    enabled,
    agents: nodes.length,
    node: without?.node ?? null,
    reason: without?.reason ?? null,
    cause: without?.cause ?? null,
    fix: without?.fix ?? null,
  });

  // The service map: its first edges, counted as the map draws them.
  let services = 0;
  let connections = 0;
  if (enabled && deps.victoria) {
    const by = EDGE_LABELS.join(', ');
    try {
      const seen = await deps.victoria.query(
        cluster.scope,
        `(sum by (${by}) (increase(watchlog_flow_connections_total[${SEEN_WINDOW}])) > 0) or (sum by (${by}) (increase(watchlog_flow_bytes_total[${SEEN_WINDOW}])) > 0)`,
      );
      const none: QuerySeries[] = [];
      const graph = buildGraph({
        seen,
        connections: none,
        failed: none,
        latencySum: none,
        latencyCount: none,
        latencyP95: none,
        bytes: none,
        retransmits: none,
      });
      services = graph.nodes.length;
      connections = graph.edges.length;
    } catch {
      // As for metrics: keep waiting.
    }
  }
  steps.push({
    id: 'map',
    state: connections > 0 ? 'done' : nodes.length && !enabled ? 'off' : 'waiting',
    since: null,
    services,
    connections,
  });

  return {
    clusterId: cluster.id,
    kind,
    createdAt: cluster.created_at.toISOString(),
    now: now.toISOString(),
    steps,
    ready: metricsDone,
    complete: steps.every((s) => s.state !== 'waiting'),
  };
}
