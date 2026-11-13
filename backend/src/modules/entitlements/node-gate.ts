// SPDX-License-Identifier: AGPL-3.0-only
// The node limit at ingest (ADR-177, ADR-027's 402), Cloud only. An agent instance (a
// Kubernetes node's agent or a Docker host's, named by X-WatchLog-Agent within its
// cluster) that the org saw in the last 24 hours always passes; a new one passes while the
// org has room, and gets 402 once it hasn't. After a downgrade's 14-day grace, the oldest
// instances up to the limit pass and the newest beyond it get 402.
//
// The hot path never queries PostgreSQL per write: each org's set is loaded once and
// refreshed every 60 seconds in the background (the stale set answers meanwhile). A
// refusal is recorded once an hour per instance (plan_limit_hits), for the banner and
// the Owners' email. The cluster-agent, integrations collectors and logs on demand aren't
// nodes and are never checked.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { SEEN_WINDOW_MS, type Entitlement } from './plans.js';
import type { EntitlementsService } from './service.js';

export const NODE_GATE_TTL_MS = 60_000;
const RECORD_EVERY_MS = 3_600_000;
const MAX_RECORDED = 100_000;

interface OrgNodes {
  /** null: no node limit (Pro), nothing is checked. */
  limit: number | null;
  allowed: Set<string>;
  loadedAt: number;
  refreshing: boolean;
}

/** The agent ids that aren't nodes: the cluster-agent and integrations collectors. */
export function isNodeAgent(agentId: string): boolean {
  return agentId !== 'cluster-agent' && !agentId.startsWith('integrations');
}

export interface GateLogger {
  warn(obj: object, msg: string): void;
}

export class NodeGate {
  private readonly orgs = new Map<string, OrgNodes>();
  private readonly loading = new Map<string, Promise<OrgNodes>>();
  private readonly recorded = new Map<string, number>();
  /** PostgreSQL reads made (tests and the hot-path measurement). */
  loads = 0;

  constructor(
    private readonly systemDb: Database,
    private readonly entitlements: EntitlementsService,
    private readonly log: GateLogger,
    private readonly now: () => number = Date.now,
  ) {
    entitlements.onChange((orgId) => this.orgs.delete(orgId));
  }

  /**
   * True when the instance may send. Only the org's first request (and one after
   * `forget`) waits for PostgreSQL; later ones answer from memory.
   */
  async admit(orgId: string, clusterId: string, agentId: string): Promise<boolean> {
    let state = this.orgs.get(orgId);
    if (!state) state = await this.load(orgId);
    else if (this.now() - state.loadedAt > NODE_GATE_TTL_MS && !state.refreshing) {
      state.refreshing = true;
      void this.load(orgId).catch((err: Error) => {
        state!.refreshing = false;
        this.log.warn({ err: err.message, orgId }, 'node limit refresh failed');
      });
    }
    if (state.limit === null) return true;
    const key = `${clusterId}\u0000${agentId}`;
    if (state.allowed.has(key)) return true;
    if (state.allowed.size < state.limit) {
      state.allowed.add(key);
      return true;
    }
    this.refused(orgId, clusterId, agentId);
    return false;
  }

  /** Drops an org's set (its entitlements changed here). */
  forget(orgId: string): void {
    this.orgs.delete(orgId);
  }

  private load(orgId: string): Promise<OrgNodes> {
    const running = this.loading.get(orgId);
    if (running) return running;
    const p = this.read(orgId).finally(() => this.loading.delete(orgId));
    this.loading.set(orgId, p);
    return p;
  }

  private async read(orgId: string): Promise<OrgNodes> {
    this.loads++;
    const ent = await this.entitlements.get(orgId);
    const nowMs = this.now();
    let allowed: Set<string>;
    if (ent.nodes === null) {
      allowed = new Set();
    } else {
      const rows = await this.systemDb
        .selectFrom('agent_instances')
        .select(['cluster_id', 'node'])
        .where('org_id', '=', orgId)
        .where('mode', '<>', 'cluster')
        .where('last_seen_at', '>', new Date(nowMs - SEEN_WINDOW_MS))
        .orderBy('created_at')
        .orderBy('node')
        .execute();
      const keys = rows.map((r) => `${r.cluster_id}\u0000${r.node}`);
      allowed = new Set(graceOver(ent, nowMs) ? keys.slice(0, ent.nodes) : keys);
    }
    const state: OrgNodes = { limit: ent.nodes, allowed, loadedAt: nowMs, refreshing: false };
    this.orgs.set(orgId, state);
    return state;
  }

  /** Records the refusal once an hour per instance; never fails the request. */
  private refused(orgId: string, clusterId: string, agentId: string): void {
    const key = `${orgId}\u0000${clusterId}\u0000${agentId}`;
    const nowMs = this.now();
    const last = this.recorded.get(key);
    if (last !== undefined && nowMs - last < RECORD_EVERY_MS) return;
    if (this.recorded.size >= MAX_RECORDED) this.recorded.clear();
    this.recorded.set(key, nowMs);
    void recordLimitHit(
      this.systemDb,
      orgId,
      'nodes',
      `${clusterId}/${agentId}`,
      new Date(nowMs),
    ).catch((err: Error) => this.log.warn({ err: err.message, orgId }, 'limit hit not recorded'));
  }
}

/** After a downgrade's grace: only the oldest instances up to the limit keep sending. */
export function graceOver(ent: Entitlement, nowMs: number): boolean {
  return ent.graceUntil !== null && ent.graceUntil.getTime() <= nowMs;
}

/** One row per limit, subject and day; later hits move `last_at`. */
export async function recordLimitHit(
  db: Database,
  orgId: string,
  kind: 'nodes' | 'clusters' | 'users',
  subject: string,
  at: Date,
): Promise<void> {
  await db
    .insertInto('plan_limit_hits')
    .values({
      org_id: orgId,
      kind,
      subject: subject.slice(0, 400),
      day: sql<Date>`(${at.toISOString()}::timestamptz at time zone 'UTC')::date`,
      first_at: at,
      last_at: at,
    })
    .onConflict((oc) =>
      oc.columns(['org_id', 'kind', 'day', 'subject']).doUpdateSet({ last_at: at }),
    )
    .execute();
}
