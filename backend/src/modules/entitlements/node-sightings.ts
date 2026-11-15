// SPDX-License-Identifier: AGPL-3.0-only
// The nodes and Docker hosts ingest sees, for the bill (ADR-194, SR-8), Cloud only. A
// stored write names them in its series' `node` and `host` labels: a node agent's own name
// on every series, and on Kubernetes the cluster-agent's state series name every Node the
// API lists. Each one is recorded once per cluster and hour in `node_sightings`; the usage
// job counts them next to the heartbeats' count and bills the higher (usage.ts).
//
// Not per write: this process remembers what it recorded in the current hour, so a node
// costs one row insert an hour. The insert runs off the request, under the cluster's org
// (Row-Level Security); a failure is logged and retried on the next write.
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import type { GateLogger } from './node-gate.js';
import { hourOf } from './usage.js';

/** More nodes than a Kubernetes cluster can have; past it a cluster's hour isn't recorded. */
export const MAX_SIGHTINGS_PER_CLUSTER_HOUR = 10_000;

export class NodeSightings {
  private hour = 0;
  /** Per cluster, the nodes recorded (or being recorded) in the current hour. */
  private readonly seen = new Map<string, Set<string>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly log: GateLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records the nodes not yet recorded this hour; never fails or delays the request. */
  see(orgId: string, clusterId: string, nodes: Iterable<string>): void {
    const hour = hourOf(this.now()).getTime();
    if (hour !== this.hour) {
      this.hour = hour;
      this.seen.clear();
    }
    let mine = this.seen.get(clusterId);
    if (!mine) this.seen.set(clusterId, (mine = new Set()));
    const fresh: string[] = [];
    for (const node of nodes) {
      if (mine.has(node)) continue;
      if (mine.size >= MAX_SIGHTINGS_PER_CLUSTER_HOUR) {
        this.log.warn({ orgId, clusterId }, 'too many nodes in one cluster and hour; not recorded');
        break;
      }
      mine.add(node);
      fresh.push(node);
    }
    if (fresh.length === 0) return;
    const at = new Date(hour);
    const p = withOrg(orgId, () =>
      this.db
        .insertInto('node_sightings')
        .values(fresh.map((node) => ({ org_id: orgId, cluster_id: clusterId, hour: at, node })))
        .onConflict((oc) => oc.doNothing())
        .execute(),
    )
      .then(() => undefined)
      .catch((err: Error) => {
        for (const node of fresh) mine.delete(node);
        this.log.warn({ err: err.message, orgId, clusterId }, 'node sightings not recorded');
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Waits for the inserts in flight (tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
