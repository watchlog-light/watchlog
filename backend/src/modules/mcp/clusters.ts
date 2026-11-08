// SPDX-License-Identifier: AGPL-3.0-only
// The `cluster` argument every cluster tool takes: a name or an id. It may be left out when
// the token sees exactly one cluster.
import { name, ToolError } from './output.js';
import type { ApiReader } from './reader.js';

export interface ApiCluster {
  id: string;
  name: string;
  kind: 'kubernetes' | 'docker';
  status: 'pending' | 'active' | 'inactive';
  nodeCount: number;
  lastSeenAt: string | null;
  ingestFailure: unknown;
}

export interface ClusterRef {
  id: string;
  name: string;
  kind: 'kubernetes' | 'docker';
}

export async function listClusters(api: ApiReader): Promise<ApiCluster[]> {
  return (await api.get<{ clusters: ApiCluster[] }>('/clusters')).clusters;
}

/** The cluster an argument names, or a ToolError that lists the choices. */
export async function resolveCluster(api: ApiReader, arg: string | undefined): Promise<ClusterRef> {
  const clusters = await listClusters(api);
  const choices = () => ({
    clusters: clusters.slice(0, 20).map((c) => ({ name: name(c.name), kind: c.kind })),
  });
  if (clusters.length === 0) {
    throw new ToolError(
      'This token sees no clusters.',
      'Add a Kubernetes cluster or a Docker fleet in WatchLog (Settings → Clusters).',
    );
  }
  const pick = (c: ApiCluster): ClusterRef => ({ id: c.id, name: c.name, kind: c.kind });
  const wanted = arg?.trim();
  if (!wanted) {
    if (clusters.length === 1) return pick(clusters[0]!);
    throw new ToolError(
      `This token sees ${clusters.length} clusters: say which one with \`cluster\`.`,
      'Pass a cluster name or id from list_clusters.',
      choices(),
    );
  }
  const found =
    clusters.find((c) => c.id === wanted || c.name === wanted) ??
    clusters.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!found) {
    throw new ToolError(
      'No cluster with this name or id.',
      'Pass a cluster name or id from list_clusters.',
      { cluster: name(wanted), ...choices() },
    );
  }
  return pick(found);
}

/** The cluster as tools show it. */
export const clusterField = (c: ClusterRef) => ({ id: c.id, name: name(c.name), kind: c.kind });
