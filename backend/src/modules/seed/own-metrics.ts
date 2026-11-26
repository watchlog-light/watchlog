// SPDX-License-Identifier: AGPL-3.0-only
// The seed's own-metrics section (1.0.0, ADR-236 to ADR-238): how a read-only demo, which
// refuses every change, gets a write-only token for its CI and scripts (by its SHA-256, as a
// seeded cluster's token: the value stays with the sender), a dashboard, pins, watched metrics
// and alert rules on its own metrics. Each is made once, matched by name, and never
// overwritten. Pins, watching and alerts need their metric to have reported: they are tried
// again until it has.
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { OWN_PINS_PER_PAGE } from '../entitlements/own-metrics.js';
import { OWN_IS, OWN_RULE_TYPE, type OwnSpec } from '../own-metrics/alerts.js';
import { SHAPES, WIDTHS, type Widget } from '../own-metrics/dashboard-routes.js';
import { METRIC_NAME, wordsOf } from '../own-metrics/naming.js';

const lits = <T extends readonly (string | number)[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v))) as unknown as ReturnType<
    typeof Type.Unsafe<T[number]>
  >;
const ClusterName = Type.String({ minLength: 1, maxLength: 63 });
const Metric = Type.String({ minLength: 1, maxLength: 200 });

export const SeedOwnMetricsSchema = Type.Object(
  {
    tokens: Type.Optional(
      Type.Array(
        Type.Object(
          {
            cluster: ClusterName,
            name: Type.String({ minLength: 1, maxLength: 64 }),
            /** The token's SHA-256, 64 hex characters; the token stays with its sender. */
            tokenSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
            /** The 8 characters after `wl_mt_`, which find the token. */
            tokenPrefix: Type.String({ pattern: '^[A-Za-z0-9_-]{8}$' }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
    dashboards: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 80 }),
            widgets: Type.Array(
              Type.Object(
                {
                  cluster: ClusterName,
                  metric: Metric,
                  title: Type.Optional(Type.String({ maxLength: 80 })),
                  shape: lits(SHAPES),
                  by: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
                  w: lits(WIDTHS),
                },
                { additionalProperties: false },
              ),
              { maxItems: 24 },
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
    pins: Type.Optional(
      Type.Array(
        Type.Object(
          {
            cluster: ClusterName,
            metric: Metric,
            /** In a cluster: "namespace/name" of the workload whose page it is pinned to. */
            workload: Type.Optional(Type.String({ maxLength: 400 })),
            /** On a fleet: the server whose page it is pinned to. */
            server: Type.Optional(Type.String({ maxLength: 253 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 60 },
      ),
    ),
    /** Metrics watched with What changed (Pro). */
    watched: Type.Optional(
      Type.Array(
        Type.Object({ cluster: ClusterName, metric: Metric }, { additionalProperties: false }),
        {
          maxItems: 50,
        },
      ),
    ),
    alerts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            cluster: ClusterName,
            name: Type.String({ minLength: 1, maxLength: 200 }),
            metric: Metric,
            is: lits(OWN_IS),
            /** above, below: as the metric is shown (a rate per second); absent, older: seconds. */
            value: Type.Optional(Type.Number()),
            per: Type.Optional(lits(['s', 'min', 'h'] as const)),
            forSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
            severity: Type.Optional(lits(['warning', 'critical'] as const)),
          },
          { additionalProperties: false },
        ),
        { maxItems: 50 },
      ),
    ),
  },
  { additionalProperties: false },
);
export type SeedOwnMetrics = Static<typeof SeedOwnMetricsSchema>;

export interface SeedOwnLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Applies what can be applied now; `pending` while something still waits for a cluster or a
 * metric to exist. Safe to run again and again.
 */
export async function applySeedOwnMetrics(
  db: Database,
  seed: SeedOwnMetrics,
  log: SeedOwnLogger,
): Promise<{ pending: boolean }> {
  const org = await db
    .selectFrom('orgs')
    .select('id')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!org) return { pending: true };
  const clusters = new Map(
    (
      await db.selectFrom('clusters').select(['id', 'name']).where('org_id', '=', org.id).execute()
    ).map((c) => [c.name, c.id]),
  );
  let pending = false;
  const clusterOf = (name: string) => {
    const id = clusters.get(name);
    if (!id) pending = true;
    return id;
  };

  for (const t of seed.tokens ?? []) {
    const clusterId = clusterOf(t.cluster);
    if (!clusterId) continue;
    const made = await db
      .insertInto('own_metric_tokens')
      .values({
        id: newId(),
        org_id: org.id,
        cluster_id: clusterId,
        name: t.name,
        token_hash: Buffer.from(t.tokenSha256, 'hex'),
        prefix: t.tokenPrefix,
      })
      .onConflict((oc) => oc.column('prefix').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (made) log.info({ cluster: t.cluster, name: t.name }, 'seed: own-metrics token added');
  }

  for (const d of seed.dashboards ?? []) {
    const exists = await db
      .selectFrom('own_dashboards')
      .select('id')
      .where('org_id', '=', org.id)
      .where((eb) => eb(eb.fn('lower', ['name']), '=', d.name.toLowerCase()))
      .executeTakeFirst();
    if (exists) continue;
    const widgets: Widget[] = [];
    let missing = false;
    for (const [i, w] of d.widgets.entries()) {
      const clusterId = clusterOf(w.cluster);
      if (!clusterId) {
        missing = true;
        continue;
      }
      if (!METRIC_NAME.test(w.metric) || w.metric.startsWith('watchlog_')) continue;
      widgets.push({
        id: `seed${i + 1}`,
        clusterId,
        metric: w.metric,
        title: w.title?.trim() || wordsOf(w.metric),
        shape: w.shape,
        by: w.by ?? null,
        w: w.w,
      });
    }
    // A dashboard is made whole: it waits for every cluster it names.
    if (missing) continue;
    await db
      .insertInto('own_dashboards')
      .values({ id: newId(), org_id: org.id, name: d.name, widgets: JSON.stringify(widgets) })
      .execute();
    log.info({ name: d.name, widgets: widgets.length }, 'seed: dashboard added');
  }

  /** A metric's id once it has reported. */
  const metricOf = async (clusterId: string, name: string) => {
    const row = await db
      .selectFrom('own_metrics')
      .select(['id', 'type', 'watched_at'])
      .where('cluster_id', '=', clusterId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (!row) pending = true;
    return row;
  };

  for (const p of seed.pins ?? []) {
    const clusterId = clusterOf(p.cluster);
    if (!clusterId) continue;
    const m = await metricOf(clusterId, p.metric);
    if (!m) continue;
    // The owner as the metric's own series name it (its workload's kind comes from there).
    let q = db
      .selectFrom('own_series')
      .select(['owner_kind', 'owner_namespace', 'owner_workload_kind', 'owner_name'])
      .where('cluster_id', '=', clusterId)
      .where('metric_id', '=', m.id);
    if (p.server) q = q.where('owner_kind', '=', 'server').where('owner_name', '=', p.server);
    else if (p.workload) {
      const slash = p.workload.indexOf('/');
      q = q
        .where('owner_kind', '=', 'workload')
        .where('owner_namespace', '=', p.workload.slice(0, Math.max(0, slash)))
        .where('owner_name', '=', p.workload.slice(slash + 1));
    } else continue;
    const owner = await q.limit(1).executeTakeFirst();
    if (!owner) {
      pending = true;
      continue;
    }
    const page = await db
      .selectFrom('own_pins')
      .select(['metric_id', 'position'])
      .where('cluster_id', '=', clusterId)
      .where('owner_kind', '=', owner.owner_kind)
      .where('owner_namespace', '=', owner.owner_namespace)
      .where('owner_workload_kind', '=', owner.owner_workload_kind)
      .where('owner_name', '=', owner.owner_name)
      .execute();
    if (page.some((x) => x.metric_id === m.id) || page.length >= OWN_PINS_PER_PAGE) continue;
    await db
      .insertInto('own_pins')
      .values({
        id: newId(),
        org_id: org.id,
        cluster_id: clusterId,
        metric_id: m.id,
        owner_kind: owner.owner_kind,
        owner_namespace: owner.owner_namespace,
        owner_workload_kind: owner.owner_workload_kind,
        owner_name: owner.owner_name,
        position: Math.max(-1, ...page.map((x) => x.position)) + 1,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    log.info({ metric: p.metric, owner: owner.owner_name }, 'seed: metric pinned');
  }

  for (const w of seed.watched ?? []) {
    const clusterId = clusterOf(w.cluster);
    if (!clusterId) continue;
    const m = await metricOf(clusterId, w.metric);
    if (!m || m.watched_at || m.type === 'timestamp') continue;
    await db
      .updateTable('own_metrics')
      .set({ watched_at: new Date() })
      .where('id', '=', m.id)
      .execute();
    log.info({ metric: w.metric }, 'seed: metric watched');
  }

  for (const a of seed.alerts ?? []) {
    const clusterId = clusterOf(a.cluster);
    if (!clusterId) continue;
    const exists = await db
      .selectFrom('alert_rules')
      .select('id')
      .where('org_id', '=', org.id)
      .where('type', '=', OWN_RULE_TYPE)
      .where('name', '=', a.name)
      .executeTakeFirst();
    if (exists) continue;
    if (a.is !== 'unusual' && (a.value === undefined || !Number.isFinite(a.value))) {
      log.warn({ rule: a.name }, 'seed: an alert on an own metric needs a value');
      continue;
    }
    const spec: OwnSpec = { metric: a.metric, is: a.is, ...(a.per ? { per: a.per } : {}) };
    await db
      .insertInto('alert_rules')
      .values({
        id: newId(),
        org_id: org.id,
        cluster_id: clusterId,
        name: a.name,
        type: OWN_RULE_TYPE,
        scope: JSON.stringify({ own: spec }),
        condition: JSON.stringify(
          a.is === 'unusual' ? {} : { op: a.is === 'below' ? '<' : '>', value: a.value },
        ),
        for_seconds: a.is === 'absent' || a.is === 'older' ? 0 : (a.forSeconds ?? 300),
        severity: a.severity ?? 'warning',
      })
      .execute();
    log.info({ rule: a.name }, 'seed: alert rule on an own metric added');
  }
  return { pending };
}
