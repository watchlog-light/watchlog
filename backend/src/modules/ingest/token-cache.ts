// SPDX-License-Identifier: AGPL-3.0-only
// 60-second cache in front of verifyClusterToken (ADR-025). Only successful lookups
// are cached, so a newly issued token works immediately; revocation clears entries
// on this instance at once and elsewhere within the TTL.
import type { Database } from '../../db/index.js';
import { sha256 } from '../../lib/tokens.js';
import { verifyClusterToken, type TokenOwner } from '../clusters/tokens.js';
import { isMetricToken, verifyMetricToken, type MetricTokenOwner } from '../own-metrics/tokens.js';

export const TOKEN_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 50_000;

export class TokenCache {
  private readonly entries = new Map<string, { owner: TokenOwner; expiresAt: number }>();

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(token: string): Promise<TokenOwner | null> {
    const key = sha256(token).toString('base64');
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.owner;
    if (hit) this.entries.delete(key);

    const owner = await verifyClusterToken(this.db, token);
    if (owner) {
      if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
      this.entries.set(key, { owner, expiresAt: this.now() + TOKEN_CACHE_TTL_MS });
    }
    return owner;
  }

  /**
   * An own-metrics token (`wl_mt_`, ADR-236), in a cache of its own: it is never an agent's
   * token, and the ingest routes that take it ask for it by name.
   */
  private readonly metricEntries = new Map<
    string,
    { owner: MetricTokenOwner; expiresAt: number }
  >();

  async verifyMetric(token: string): Promise<MetricTokenOwner | null> {
    if (!isMetricToken(token)) return null;
    const key = sha256(token).toString('base64');
    const hit = this.metricEntries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.owner;
    if (hit) this.metricEntries.delete(key);
    const owner = await verifyMetricToken(this.db, token);
    if (owner) {
      if (this.metricEntries.size >= MAX_ENTRIES) this.metricEntries.clear();
      this.metricEntries.set(key, { owner, expiresAt: this.now() + TOKEN_CACHE_TTL_MS });
    }
    return owner;
  }

  invalidateMetricToken(tokenId: string): void {
    for (const [key, { owner }] of this.metricEntries)
      if (owner.tokenId === tokenId) this.metricEntries.delete(key);
  }

  invalidateToken(tokenId: string): void {
    for (const [key, { owner }] of this.entries)
      if (owner.tokenId === tokenId) this.entries.delete(key);
  }

  invalidateCluster(clusterId: string): void {
    for (const [key, { owner }] of this.entries)
      if (owner.clusterId === clusterId) this.entries.delete(key);
    for (const [key, { owner }] of this.metricEntries)
      if (owner.clusterId === clusterId) this.metricEntries.delete(key);
  }
}
