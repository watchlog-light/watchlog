// SPDX-License-Identifier: AGPL-3.0-only
// list_clusters (ADR-128): the clusters a token can see, to pick one for the other tools.
import { Type } from 'typebox';
import { listClusters } from '../clusters.js';
import { name } from '../output.js';
import { defineTool, describe } from './common.js';

const MAX_CLUSTERS = 50;

export const listClustersTool = defineTool({
  name: 'list_clusters',
  title: 'List clusters',
  description: describe(
    'List the clusters this API token can see. WatchLog watches two kinds: Kubernetes clusters (nodes, namespaces, workloads, pods) and Docker fleets (Docker hosts running containers, often grouped in Compose projects).',
    'Call it first when you do not know a cluster: the other tools take its name or id in `cluster`, and can leave it out when there is only one.',
    `Returns for each cluster: id, name, kind (kubernetes or docker), status (active: reporting; inactive: its agents stopped reporting; pending: never reported), nodes (Kubernetes nodes or Docker hosts), lastSeenAt and ingestFailing. At most ${MAX_CLUSTERS}.`,
    'Example question: "Which of my clusters stopped reporting?"',
  ),
  input: Type.Object({}, { additionalProperties: false }),
  summarize: () => '',
  async run(_args, { api }) {
    const clusters = await listClusters(api);
    return {
      body: {},
      list: {
        key: 'clusters',
        items: clusters.slice(0, MAX_CLUSTERS).map((c) => ({
          id: c.id,
          name: name(c.name),
          kind: c.kind,
          status: c.status,
          nodes: c.nodeCount,
          lastSeenAt: c.lastSeenAt,
          ingestFailing: c.ingestFailure !== null,
        })),
        total: clusters.length,
        noun: 'clusters',
        narrow: 'Ask about one cluster by name with the other tools.',
      },
    };
  },
});
