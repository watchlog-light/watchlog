// SPDX-License-Identifier: AGPL-3.0-only
// Grouping and holding (alerts redesign item 5, ADR-094). When every agent of a cluster
// or fleet is silent, one alert stands for the cluster and its other alerts are held:
// kept as they are, neither notified nor resolved, because their data is stale. Pod
// alerts whose pod runs on a NotReady node are held under that node's alert.
import type { NodeCondition } from '../kubernetes/views.js';
import type { EvalContext } from './engine.js';

/** Fingerprint of the one "cluster stopped reporting" alert. */
export const CLUSTER_FINGERPRINT = 'cluster';
/** No heartbeat for this long: the agent is not reporting (SPEC §4.7). */
export const AGENT_SILENT_MS = 3 * 60_000;

export interface SilentAgent {
  node: string;
  mode: string;
  lastSeen: number;
}

export interface ClusterReporting {
  /** Agents that count: a node agent whose node is gone (scaled down) does not. */
  agents: number;
  silent: SilentAgent[];
  /** Every agent is silent: the cluster as a whole stopped reporting. */
  allSilent: boolean;
  /** The newest heartbeat of any agent. */
  lastSeen: number | null;
  notReadyNodes: Set<string>;
}

/** Once per cluster and cycle, shared by the agent rule and the engine. */
export function clusterReporting(ctx: Pick<EvalContext, 'db' | 'cluster' | 'now' | 'memo'>) {
  return ctx.memo(`reporting:${ctx.cluster.id}`, async (): Promise<ClusterReporting> => {
    const [agents, nodes] = await Promise.all([
      ctx.db
        .selectFrom('agent_instances')
        .select(['node', 'mode', 'last_seen_at'])
        .where('cluster_id', '=', ctx.cluster.id)
        .execute(),
      ctx.cluster.kind === 'kubernetes'
        ? ctx.db
            .selectFrom('objects')
            .select(['name', 'status_summary'])
            .where('cluster_id', '=', ctx.cluster.id)
            .where('kind', '=', 'Node')
            .where('deleted_at', 'is', null)
            .execute()
        : Promise.resolve([]),
    ]);
    const liveNodes = new Set(nodes.map((n) => n.name));
    const counted = agents.filter((a) => a.mode !== 'node' || liveNodes.has(a.node));
    const silent = counted
      .map((a) => ({ node: a.node, mode: a.mode, lastSeen: new Date(a.last_seen_at).getTime() }))
      .filter((a) => ctx.now - a.lastSeen >= AGENT_SILENT_MS);
    const seen = counted.map((a) => new Date(a.last_seen_at).getTime());
    const notReadyNodes = new Set(
      nodes
        .filter((n) =>
          ((n.status_summary as { conditions?: NodeCondition[] }).conditions ?? []).some(
            (c) => c.type === 'Ready' && c.status !== 'True',
          ),
        )
        .map((n) => n.name),
    );
    return {
      agents: counted.length,
      silent,
      allSilent: counted.length > 0 && silent.length === counted.length,
      lastSeen: seen.length ? Math.max(...seen) : null,
      notReadyNodes,
    };
  });
}

/**
 * Which alerts of a rule are held in a cluster this cycle. The agent rule keeps its
 * cluster-wide alert going and holds the per-agent ones; other rules are held
 * entirely while the cluster is silent; pod alerts are held on NotReady nodes.
 */
export function holdFor(
  ruleKey: string | null,
  r: ClusterReporting,
): ((fingerprint: string, labels: Record<string, string>) => boolean) | null {
  if (ruleKey === 'agent.not_reporting') {
    return r.allSilent ? (fp) => fp !== CLUSTER_FINGERPRINT : null;
  }
  // Failing ingest is why a cluster may look silent: never held (ADR-117).
  if (ruleKey === 'watchlog.ingest.failing') return null;
  if (r.allSilent) return () => true;
  if (r.notReadyNodes.size === 0) return null;
  return (_fp, labels) => !!labels.pod && !!labels.node && r.notReadyNodes.has(labels.node);
}
