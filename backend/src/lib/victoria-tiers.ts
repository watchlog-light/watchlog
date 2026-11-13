// SPDX-License-Identifier: AGPL-3.0-only
// The two retention tiers in Cloud (ADR-177, SPEC §5.4): one VictoriaMetrics with 3 days
// (Free) and one with 30 days (Pro). The client still takes only a ClusterScope (ADR-174),
// so every caller keeps going through clusterForOrg or the allow-listed authorisedScope;
// the tier is chosen here, from the cluster's org:
//   - writes go to the org's current tier;
//   - after a plan change, reads ask both tiers until the old tier's retention has run out,
//     and merge the series by their labels, the current tier's point winning where both
//     have one at the same time (otherwise the old tier's fills the gap).
// With one VictoriaMetrics (Community, or Cloud without the two URLs) this class isn't used.
import { VictoriaQueryClient, type ClusterScope, type QuerySeries } from './victoria.js';

export type Tier = '3d' | '30d';

export interface TierPlacement {
  current: Tier;
  previous: Tier | null;
}

/** The cluster's placement; null for a cluster that doesn't exist (the 3-day tier). */
export type TierResolver = (clusterId: string) => Promise<TierPlacement | null>;

export interface TierLogger {
  warn(obj: object, msg: string): void;
}

const keyOf = (labels: Record<string, string>) =>
  JSON.stringify(
    Object.keys(labels)
      .sort()
      .map((k) => [k, labels[k]]),
  );

/**
 * Merges two answers by series labels. For each series and timestamp the current tier's
 * point wins when it has a value; the old tier's fills timestamps (or whole series) the
 * current one lacks.
 */
export function mergeSeries(current: QuerySeries[], previous: QuerySeries[]): QuerySeries[] {
  const out = new Map<string, QuerySeries>();
  for (const s of previous) out.set(keyOf(s.labels), { labels: s.labels, points: s.points });
  for (const s of current) {
    const k = keyOf(s.labels);
    const old = out.get(k);
    if (!old) {
      out.set(k, s);
      continue;
    }
    const byTs = new Map<number, number | null>(old.points);
    for (const [t, v] of s.points) {
      if (v !== null || !byTs.has(t)) byTs.set(t, v);
    }
    out.set(k, {
      labels: s.labels,
      points: [...byTs.entries()].sort((a, b) => a[0] - b[0]),
    });
  }
  return [...out.values()];
}

export class TieredVictoriaClient extends VictoriaQueryClient {
  private readonly tiers: Record<Tier, VictoriaQueryClient>;

  constructor(
    urls: Record<Tier, string>,
    private readonly resolve: TierResolver,
    private readonly log: TierLogger,
    timeoutMs = 10_000,
    queryTimeoutMs = 15_000,
  ) {
    super(urls['3d'], timeoutMs, queryTimeoutMs);
    this.tiers = {
      '3d': new VictoriaQueryClient(urls['3d'], timeoutMs, queryTimeoutMs),
      '30d': new VictoriaQueryClient(urls['30d'], timeoutMs, queryTimeoutMs),
    };
  }

  private async placement(scope: ClusterScope): Promise<TierPlacement> {
    return (await this.resolve(scope.clusterId)) ?? { current: '3d', previous: null };
  }

  override async write(scope: ClusterScope, body: Uint8Array): Promise<void> {
    const p = await this.placement(scope);
    await this.tiers[p.current].write(scope, body);
  }

  /** Both tiers, whatever the plan: an old tier may still hold the org's data (ADR-181). */
  override async exportSeries(scope: ClusterScope, start: number, end: number) {
    const out: Response[] = [];
    for (const tier of ['30d', '3d'] as const) {
      out.push(...(await this.tiers[tier].exportSeries(scope, start, end)));
    }
    return out;
  }

  /** Deletes the cluster's series in both tiers (ADR-181). */
  override async deleteSeries(scope: ClusterScope, now = Date.now()) {
    const out: Record<string, number> = {};
    for (const tier of ['3d', '30d'] as const) {
      out[tier] = (await this.tiers[tier].deleteSeries(scope, now)).all!;
    }
    return out;
  }

  /** The current tier's answer, merged with the old tier's while it still holds data. */
  private async read(
    scope: ClusterScope,
    ask: (c: VictoriaQueryClient) => Promise<QuerySeries[]>,
  ): Promise<QuerySeries[]> {
    const p = await this.placement(scope);
    if (!p.previous) return ask(this.tiers[p.current]);
    const [current, previous] = await Promise.allSettled([
      ask(this.tiers[p.current]),
      ask(this.tiers[p.previous]),
    ]);
    if (current.status === 'rejected') throw current.reason;
    if (previous.status === 'rejected') {
      // The old tier only adds history: its failure leaves the current tier's answer.
      this.log.warn(
        { err: (previous.reason as Error).message, tier: p.previous },
        'previous metrics tier unavailable; answering from the current one',
      );
      return current.value;
    }
    return mergeSeries(current.value, previous.value);
  }

  override query(scope: ClusterScope, expr: string, time?: number): Promise<QuerySeries[]> {
    return this.read(scope, (c) => c.query(scope, expr, time));
  }

  override queryRange(
    scope: ClusterScope,
    expr: string,
    start: number,
    end: number,
    step: number,
  ): Promise<QuerySeries[]> {
    return this.read(scope, (c) => c.queryRange(scope, expr, start, end, step));
  }
}
