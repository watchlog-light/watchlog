// SPDX-License-Identifier: AGPL-3.0-only
// Writes the funnel's events to funnel_events (ADR-179), Cloud only. Each write runs inside
// withOrg on the request path's connection, so Row-Level Security holds for it like for
// any other tenant row. A one-time event carries its once_key and the unique index keeps
// the first one (ON CONFLICT DO NOTHING): the database is the rule, also across replicas.
// Recording never fails the request that triggered it: a lost event is a lost count.
import type { Database } from '../../db/index.js';
import { isReadOnlyScope, withOrg } from '../../db/org-context.js';
import { onceOf, type FunnelEventName } from './events.js';

export interface FunnelEvent {
  name: FunnelEventName;
  orgId: string;
  userId?: string | null;
  /** The cluster a once-per-cluster event is about. */
  clusterId?: string;
  props?: Record<string, string>;
  at?: Date;
}

interface Log {
  warn(obj: object, msg: string): void;
}

/** The unique key of a one-time event, or null for one that may repeat. */
export function onceKey(e: FunnelEvent): string | null {
  switch (onceOf(e.name)) {
    case 'org':
      return '';
    case 'user':
      return e.userId ? `user:${e.userId}` : null;
    case 'cluster':
      return e.clusterId ? `cluster:${e.clusterId}` : null;
    default:
      return null;
  }
}

export class FunnelRecorder {
  /**
   * One-time events this process already wrote or found, so the hot paths (every heartbeat,
   * every remote write) don't ask PostgreSQL again. Only a shortcut: the unique index decides.
   */
  private readonly known = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly log: Log,
  ) {}

  /** True when this one-time event is already recorded as far as this process knows. */
  seen(e: Pick<FunnelEvent, 'name' | 'orgId' | 'userId' | 'clusterId'>): boolean {
    const key = onceKey(e as FunnelEvent);
    return key !== null && this.known.has(`${e.orgId}:${e.name}:${key}`);
  }

  /** Records the event; resolves to true when a row was written. Never throws. */
  async record(e: FunnelEvent): Promise<boolean> {
    // Support mode reads only (ADR-179): staff looking around isn't the customer's funnel.
    if (isReadOnlyScope()) return false;
    const key = onceKey(e);
    const memo = key === null ? null : `${e.orgId}:${e.name}:${key}`;
    if (memo && this.known.has(memo)) return false;
    try {
      const row = await withOrg(e.orgId, () =>
        this.db
          .insertInto('funnel_events')
          .values({
            org_id: e.orgId,
            user_id: e.userId ?? null,
            name: e.name,
            props: JSON.stringify(e.props ?? {}),
            once_key: key,
            ...(e.at ? { ts: e.at } : {}),
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst(),
      );
      if (memo) {
        if (this.known.size > 50_000) this.known.clear();
        this.known.add(memo);
      }
      return !!row;
    } catch (err) {
      this.log.warn(
        { funnel: e.name, orgId: e.orgId, err: (err as Error).message.slice(0, 200) },
        'funnel event not recorded',
      );
      return false;
    }
  }

  /** Fire and forget, for request handlers: the answer never waits on the funnel. */
  emit(e: FunnelEvent): void {
    void this.record(e);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Cloud's funnel (ADR-179); null in Community, which records none. */
    funnel: FunnelRecorder | null;
  }
}

/** Records a funnel event from a request handler (Cloud; a no-op in Community). */
export async function recordFunnelEvent(
  server: { funnel: FunnelRecorder | null },
  e: Omit<FunnelEvent, 'orgId'> & { orgId: string | null },
): Promise<void> {
  if (!server.funnel || !e.orgId) return;
  await server.funnel.record({ ...e, orgId: e.orgId });
}
