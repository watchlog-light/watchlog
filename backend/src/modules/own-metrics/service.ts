// SPDX-License-Identifier: AGPL-3.0-only
// The one way in for a user's own metrics (1.0.0, ADR-236), whichever way they arrive: a scrape
// by the collector, a Prometheus remote write, or a push. Each series is judged on its own:
//
//   - a name starting `watchlog_`, or one that isn't a metric name, is refused;
//   - a label with more than 100 values on one metric makes that metric refused, with the
//     label named ("too many values for `user_id`");
//   - a series already known keeps flowing; a new one is admitted only under the source's cap
//     and the org's cap, and only when its source is within the plan's number of sources;
//   - what is admitted is stored under the label `wl_own` (the source's id) and the labels of
//     what it belongs to (`wl_ns`, `wl_wkind`, `wl_workload` or `wl_server`), which the server
//     sets and no sender can.
//
// The registry (sources, metrics, the known series) is in PostgreSQL and kept in memory per
// cluster; the values go to VictoriaMetrics in the cluster's own scope, so tenancy, the
// retention tier and the org's export and deletion work as for every other series. WatchLog's
// own monitoring never passes through here: no cap of this file can touch it.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import { newId } from '../../lib/ids.js';
import { authorisedScope, type VictoriaClient } from '../../lib/victoria.js';
import {
  OWN_LABEL_VALUES,
  sourceSeriesCap,
  type OwnMetricLimits,
} from '../entitlements/own-metrics.js';
import {
  cleanLabels,
  familiesOf,
  hiddenByDefault,
  METRIC_NAME,
  MAX_NAME,
  OWN_LABEL,
  RESERVED_PREFIX,
  unitFromName,
  type OwnType,
} from './naming.js';
import { encodeWrite, type StoredSeries } from './wire.js';

/** A series not seen for this long no longer counts against the caps. */
export const ACTIVE_MS = 60 * 60_000;
/** Its row is removed after this long; its values age out with the retention. */
export const FORGET_MS = 24 * 60 * 60_000;
const FLUSH_MS = 30_000;
/** Labels that never count as "too many values": a histogram's and a summary's own. */
const STRUCTURAL = new Set(['le', 'quantile']);

export interface Owner {
  kind: '' | 'workload' | 'server';
  /** A Kubernetes workload's namespace. */
  namespace: string;
  /** Deployment, StatefulSet, … */
  workloadKind: string;
  /** The workload's name, or the server's. */
  name: string;
}
export const NO_OWNER: Owner = { kind: '', namespace: '', workloadKind: '', name: '' };

export type SourceKind = 'scrape_pod' | 'scrape_address' | 'remote_write' | 'push';

export interface SourceRef {
  kind: SourceKind;
  /** Names the source within its cluster. */
  key: string;
  /** How the sources table shows it: "orders :8080/metrics", `token "ci and cron"`. */
  label: string;
  /** What its series belong to unless a series says otherwise. */
  owner: Owner;
  tokenId?: string;
  config?: Record<string, unknown>;
}

export interface Incoming {
  name: string;
  labels: Record<string, string>;
  /** [unix milliseconds, value] */
  samples: readonly (readonly [number, number])[];
  /** This series' own owner (remote write's labels, a push's field). */
  owner?: Owner;
  /** Labels the server adds after the sender's are cleaned (a scraped pod's name). */
  extra?: Record<string, string>;
  /** A pushed counter: the value is added to the series' running total. */
  add?: boolean;
}

export interface Dropped {
  /** Names starting `watchlog_`. */
  reserved: number;
  /** Not a metric name, a bad label, or no sample. */
  invalid: number;
  /** Metrics refused for a label with too many values. */
  cardinality: { metric: string; label: string }[];
  /** New series over what one source may bring. */
  sourceCap: number;
  /** New series over the org's allowance. */
  orgCap: number;
  /** The whole source is over the plan's number of sources. */
  sources: boolean;
}

export interface IngestInput {
  orgId: string;
  clusterId: string;
  source: SourceRef;
  series: readonly Incoming[];
  /** Declared types by family (a scrape's TYPE lines, remote write's metadata). */
  types?: ReadonlyMap<string, OwnType>;
  help?: ReadonlyMap<string, string>;
  /** Why the scrape failed, when it did (nothing is stored then). */
  error?: string;
  /** A later part of one report (a large scrape): its drops add to the first part's. */
  append?: boolean;
}

export interface IngestResult {
  stored: number;
  dropped: Dropped;
  /** The series the source has active after this report. */
  sourceSeries: number;
}

interface SourceState {
  id: string;
  kind: SourceKind;
  key: string;
  label: string;
  owner: Owner;
  refused: boolean;
  series: Set<string>;
  dropped: Dropped;
  error: string | null;
  lastReportedAt: number;
  dirty: boolean;
}

interface MetricState {
  id: string;
  name: string;
  type: OwnType;
  typeOverride: OwnType | null;
  labelNames: Set<string>;
  /** Each sender label's values among the active series, with how many series have each. */
  values: Map<string, Map<string, number>>;
  refused: { label: string } | null;
  lastSeen: number;
  dirty: boolean;
}

interface SeriesState {
  metric: string;
  source: string;
  lastSeen: number;
  flushed: number;
  total: number | null;
  /** The sender's labels that count towards the metric's label values. */
  pairs: [string, string][];
}

interface ClusterState {
  orgId: string;
  clusterId: string;
  sources: Map<string, SourceState>;
  metrics: Map<string, MetricState>;
  series: Map<string, SeriesState>;
}

const noDrops = (): Dropped => ({
  reserved: 0,
  invalid: 0,
  cardinality: [],
  sourceCap: 0,
  orgCap: 0,
  sources: false,
});

/** A series' identity: its stored name and labels, in name order. */
export function fingerprint(name: string, labels: Readonly<Record<string, string>>): string {
  const h = createHash('sha1').update(name);
  for (const k of Object.keys(labels).sort())
    h.update('\0').update(k).update('\0').update(labels[k]!);
  return h.digest('hex').slice(0, 24);
}

/** The labels that say what a series belongs to. */
export function ownerLabels(o: Owner): Record<string, string> {
  if (o.kind === 'workload')
    return { wl_ns: o.namespace, wl_wkind: o.workloadKind, wl_workload: o.name };
  if (o.kind === 'server') return { wl_server: o.name };
  return {};
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Your metrics (1.0.0, ADR-236): the registry and the caps, shared by ingest and the API. */
    ownMetrics: OwnMetrics;
  }
}

export interface OwnMetricsOptions {
  db: Database;
  victoria: VictoriaClient | null;
  /** The org's limits now (its plan, its billed nodes, the installation's cap). */
  limits: (orgId: string) => Promise<OwnMetricLimits>;
  log: FastifyBaseLogger;
  now?: () => number;
}

export class OwnMetrics {
  private readonly clusters = new Map<string, ClusterState>();
  private readonly loading = new Map<string, Promise<ClusterState>>();
  /** Active series and sources of an org's clusters that aren't loaded here, by org. */
  private readonly elsewhere = new Map<string, { at: number; series: number; sources: number }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly o: OwnMetricsOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Starts the periodic flush (the server calls it; tests flush by hand). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => this.o.log.warn({ err }, 'own metrics: flush failed'));
    }, FLUSH_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Forgets what is in memory (a source was removed, a metric's type corrected). */
  async forget(clusterId: string): Promise<void> {
    await this.flush();
    this.clusters.delete(clusterId);
  }

  private async cluster(orgId: string, clusterId: string): Promise<ClusterState> {
    const hit = this.clusters.get(clusterId);
    if (hit) return hit;
    let p = this.loading.get(clusterId);
    if (!p) {
      p = this.load(orgId, clusterId).finally(() => this.loading.delete(clusterId));
      this.loading.set(clusterId, p);
    }
    return p;
  }

  private async load(orgId: string, clusterId: string): Promise<ClusterState> {
    const { db } = this.o;
    const since = new Date(this.now() - ACTIVE_MS);
    const state: ClusterState = {
      orgId,
      clusterId,
      sources: new Map(),
      metrics: new Map(),
      series: new Map(),
    };
    await withOrg(orgId, async () => {
      const [sources, metrics, series] = await Promise.all([
        db.selectFrom('own_sources').selectAll().where('cluster_id', '=', clusterId).execute(),
        db.selectFrom('own_metrics').selectAll().where('cluster_id', '=', clusterId).execute(),
        db
          .selectFrom('own_series')
          .select(['fingerprint', 'metric_id', 'source_id', 'labels', 'last_seen', 'total'])
          .where('cluster_id', '=', clusterId)
          .where('last_seen', '>', since)
          .execute(),
      ]);
      const sourceKey = new Map<string, string>();
      for (const s of sources) {
        sourceKey.set(s.id, s.key);
        state.sources.set(s.key, {
          id: s.id,
          kind: s.kind as SourceKind,
          key: s.key,
          label: s.label,
          owner: { ...NO_OWNER, ...(s.owner as Partial<Owner>) },
          refused: s.refused,
          series: new Set(),
          dropped: { ...noDrops(), ...(s.dropped as Partial<Dropped>) },
          error: s.error,
          lastReportedAt: s.last_reported_at ? s.last_reported_at.getTime() : 0,
          dirty: false,
        });
      }
      const metricName = new Map<string, string>();
      for (const m of metrics) {
        metricName.set(m.id, m.name);
        state.metrics.set(m.name, {
          id: m.id,
          name: m.name,
          type: m.type as OwnType,
          typeOverride: (m.type_override as OwnType | null) ?? null,
          labelNames: new Set(m.label_names),
          values: new Map(),
          refused: (m.refused as { label: string } | null) ?? null,
          lastSeen: m.last_seen.getTime(),
          dirty: false,
        });
      }
      for (const r of series) {
        const metric = metricName.get(r.metric_id);
        const source = sourceKey.get(r.source_id);
        if (!metric || !source) continue;
        const at = r.last_seen.getTime();
        const src = state.sources.get(source)!;
        // The label the server added to a scraped series isn't the sender's.
        const added =
          src.kind === 'scrape_pod' ? 'pod' : src.kind === 'scrape_address' ? 'instance' : '';
        const pairs = Object.entries(r.labels as Record<string, string>).filter(
          ([k]) => !STRUCTURAL.has(k) && !k.startsWith('wl_') && k !== added,
        );
        state.series.set(r.fingerprint, {
          metric,
          source,
          lastSeen: at,
          flushed: at,
          total: r.total,
          pairs,
        });
        src.series.add(r.fingerprint);
        countValues(state.metrics.get(metric)!, pairs, 1);
      }
    });
    this.clusters.set(clusterId, state);
    this.elsewhere.delete(orgId);
    return state;
  }

  /** The org's active series and counted sources, in every cluster. */
  private async orgUsage(orgId: string): Promise<{ series: number; sources: number }> {
    let series = 0;
    let sources = 0;
    const loaded: string[] = [];
    for (const c of this.clusters.values()) {
      if (c.orgId !== orgId) continue;
      loaded.push(c.clusterId);
      series += c.series.size;
      for (const s of c.sources.values()) if (!s.refused) sources++;
    }
    let other = this.elsewhere.get(orgId);
    if (!other || this.now() - other.at > 60_000) {
      const since = new Date(this.now() - ACTIVE_MS);
      const { db } = this.o;
      other = await withOrg(orgId, async () => {
        let q = db
          .selectFrom('own_series')
          .select(sql<string>`count(*)`.as('n'))
          .where('org_id', '=', orgId)
          .where('last_seen', '>', since);
        let s = db
          .selectFrom('own_sources')
          .select(sql<string>`count(*)`.as('n'))
          .where('org_id', '=', orgId)
          .where('refused', '=', false);
        if (loaded.length) {
          q = q.where('cluster_id', 'not in', loaded);
          s = s.where('cluster_id', 'not in', loaded);
        }
        const [a, b] = await Promise.all([q.executeTakeFirst(), s.executeTakeFirst()]);
        return { at: this.now(), series: Number(a?.n ?? 0), sources: Number(b?.n ?? 0) };
      });
      this.elsewhere.set(orgId, other);
    }
    return { series: series + other.series, sources: sources + other.sources };
  }

  /** What the org uses now and may use: the page's "412 of 2,000 series". */
  async usage(
    orgId: string,
  ): Promise<{ series: number; sources: number; limits: OwnMetricLimits }> {
    const [u, limits] = await Promise.all([this.orgUsage(orgId), this.o.limits(orgId)]);
    return { ...u, limits };
  }

  private async source(c: ClusterState, ref: SourceRef, limits: OwnMetricLimits) {
    let s = c.sources.get(ref.key);
    if (s) {
      if (s.label !== ref.label || JSON.stringify(s.owner) !== JSON.stringify(ref.owner)) {
        s.label = ref.label;
        s.owner = ref.owner;
        s.dirty = true;
      }
      // A source refused for the plan's number of sources is admitted once there is room.
      if (s.refused && limits.sources !== null) {
        const used = await this.orgUsage(c.orgId);
        if (used.sources < limits.sources) {
          s.refused = false;
          s.dirty = true;
        }
      } else if (s.refused && limits.sources === null) {
        s.refused = false;
        s.dirty = true;
      }
      return s;
    }
    const used = limits.sources === null ? null : await this.orgUsage(c.orgId);
    const refused = used !== null && limits.sources !== null && used.sources >= limits.sources;
    const id = newId();
    const { db } = this.o;
    const row = await withOrg(c.orgId, () =>
      db
        .insertInto('own_sources')
        .values({
          id,
          org_id: c.orgId,
          cluster_id: c.clusterId,
          kind: ref.kind,
          key: ref.key,
          label: ref.label,
          owner: JSON.stringify(ref.owner),
          config: JSON.stringify(ref.config ?? {}),
          token_id: ref.tokenId ?? null,
          refused,
        })
        .onConflict((oc) => oc.columns(['cluster_id', 'key']).doUpdateSet({ label: ref.label }))
        .returning(['id', 'refused'])
        .executeTakeFirstOrThrow(),
    );
    s = {
      id: row.id,
      kind: ref.kind,
      key: ref.key,
      label: ref.label,
      owner: ref.owner,
      refused: row.refused,
      series: new Set(),
      dropped: noDrops(),
      error: null,
      lastReportedAt: 0,
      dirty: false,
    };
    c.sources.set(ref.key, s);
    return s;
  }

  private async metric(
    c: ClusterState,
    name: string,
    type: OwnType,
    help: string,
  ): Promise<MetricState> {
    const hit = c.metrics.get(name);
    if (hit) return hit;
    const { db } = this.o;
    const row = await withOrg(c.orgId, () =>
      db
        .insertInto('own_metrics')
        .values({
          id: newId(),
          org_id: c.orgId,
          cluster_id: c.clusterId,
          name,
          type,
          unit: unitFromName(name, type),
          help: help.slice(0, 500),
          hidden: hiddenByDefault(name),
        })
        .onConflict((oc) =>
          oc.columns(['cluster_id', 'name']).doUpdateSet({ last_seen: sql`now()` }),
        )
        .returning(['id', 'type', 'type_override', 'refused', 'label_names'])
        .executeTakeFirstOrThrow(),
    );
    const m: MetricState = {
      id: row.id,
      name,
      type: row.type as OwnType,
      typeOverride: (row.type_override as OwnType | null) ?? null,
      labelNames: new Set(row.label_names),
      values: new Map(),
      refused: (row.refused as { label: string } | null) ?? null,
      lastSeen: this.now(),
      dirty: false,
    };
    c.metrics.set(name, m);
    return m;
  }

  /** Takes one report of one source: judges each series, stores what is admitted. */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const { orgId, clusterId } = input;
    const now = this.now();
    const limits = await this.o.limits(orgId);
    const c = await this.cluster(orgId, clusterId);
    const src = await this.source(c, input.source, limits);
    const dropped = noDrops();
    src.lastReportedAt = now;
    src.error = input.error ?? null;
    src.dirty = true;
    if (src.refused) {
      dropped.sources = true;
      src.dropped = dropped;
      return { stored: 0, dropped, sourceSeries: 0 };
    }
    if (input.error) {
      // A failed scrape reports nothing: the last report's drops stay as they were.
      return { stored: 0, dropped: src.dropped, sourceSeries: src.series.size };
    }

    const known = new Map<string, OwnType>();
    for (const m of c.metrics.values()) known.set(m.name, m.typeOverride ?? m.type);
    const candidates = input.series.filter((s) => {
      if (!METRIC_NAME.test(s.name) || s.name.length > MAX_NAME || s.samples.length === 0) {
        dropped.invalid++;
        return false;
      }
      if (s.name.startsWith(RESERVED_PREFIX)) {
        dropped.reserved++;
        return false;
      }
      return true;
    });
    const families = familiesOf(candidates, input.types, known);
    let used = (await this.orgUsage(orgId)).series;
    const out: StoredSeries[] = [];
    const fresh: {
      fp: string;
      metric: MetricState;
      name: string;
      labels: Record<string, string>;
      owner: Owner;
    }[] = [];
    const refusedNow = new Map<string, string>();

    for (const s of candidates) {
      const sender = cleanLabels(s.labels);
      if (!sender) {
        dropped.invalid++;
        continue;
      }
      const family = families.get(s.name)!;
      const m = await this.metric(c, family.name, family.type, input.help?.get(family.name) ?? '');
      // A TYPE line (or remote write's metadata) knows better than the name's suffix did.
      if (input.types?.has(family.name) && family.type !== m.type) {
        m.type = family.type;
        m.dirty = true;
      }
      if (m.refused) {
        refusedNow.set(m.name, m.refused.label);
        continue;
      }
      // Too many values for one label among the active series: the metric is refused from
      // here on (until someone asks to check it again), the label named.
      const pairs = Object.entries(sender).filter(([k]) => !STRUCTURAL.has(k));
      let over: string | null = null;
      for (const [k, v] of pairs) {
        const values = m.values.get(k);
        if (values && !values.has(v) && values.size >= OWN_LABEL_VALUES) {
          over = k;
          break;
        }
      }
      if (over) {
        m.refused = { label: over };
        m.dirty = true;
        refusedNow.set(m.name, over);
        continue;
      }
      const owner = s.owner ?? src.owner;
      const labels = {
        ...sender,
        ...cleanExtra(s.extra),
        ...ownerLabels(owner),
        [OWN_LABEL]: src.id,
      };
      const fp = fingerprint(s.name, labels);
      let st = c.series.get(fp);
      if (!st) {
        const cap = sourceSeriesCap(src.kind, limits);
        if (cap !== null && src.series.size >= cap) {
          dropped.sourceCap++;
          continue;
        }
        if (used >= limits.series) {
          dropped.orgCap++;
          continue;
        }
        used++;
        st = { metric: m.name, source: src.key, lastSeen: now, flushed: 0, total: null, pairs };
        c.series.set(fp, st);
        countValues(m, pairs, 1);
        src.series.add(fp);
        fresh.push({ fp, metric: m, name: s.name, labels, owner });
      }
      st.lastSeen = now;
      m.lastSeen = now;
      for (const k of Object.keys(sender)) {
        if (!m.labelNames.has(k) && !STRUCTURAL.has(k)) {
          m.labelNames.add(k);
          m.dirty = true;
        }
      }
      let samples = s.samples;
      if (s.add) {
        // A pushed counter: each push adds to the series' running total.
        let total = st.total ?? 0;
        samples = s.samples.map(([at, v]) => [at, (total += Math.max(0, v))] as const);
        st.total = total;
      }
      out.push({ name: s.name, labels, samples });
    }
    for (const [metric, label] of refusedNow) dropped.cardinality.push({ metric, label });
    if (input.append) {
      const before = src.dropped;
      dropped.reserved += before.reserved;
      dropped.invalid += before.invalid;
      dropped.sourceCap += before.sourceCap;
      dropped.orgCap += before.orgCap;
      for (const c of before.cardinality)
        if (!dropped.cardinality.some((x) => x.metric === c.metric)) dropped.cardinality.push(c);
    }
    src.dropped = dropped;

    if (fresh.length) await this.insertSeries(c, src, fresh, now);
    if (out.length && this.o.victoria) {
      await this.o.victoria.write(authorisedScope(clusterId), encodeWrite(out));
    }
    return { stored: out.length, dropped, sourceSeries: src.series.size };
  }

  private async insertSeries(
    c: ClusterState,
    src: SourceState,
    fresh: {
      fp: string;
      metric: MetricState;
      name: string;
      labels: Record<string, string>;
      owner: Owner;
    }[],
    now: number,
  ): Promise<void> {
    const { db } = this.o;
    const at = new Date(now);
    await withOrg(c.orgId, async () => {
      for (let i = 0; i < fresh.length; i += 500) {
        await db
          .insertInto('own_series')
          .values(
            fresh.slice(i, i + 500).map((f) => ({
              org_id: c.orgId,
              cluster_id: c.clusterId,
              fingerprint: f.fp,
              metric_id: f.metric.id,
              source_id: src.id,
              series_name: f.name,
              labels: JSON.stringify(f.labels),
              owner_kind: f.owner.kind,
              owner_namespace: f.owner.namespace,
              owner_workload_kind: f.owner.workloadKind,
              owner_name: f.owner.name,
              last_seen: at,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['cluster_id', 'fingerprint']).doUpdateSet((eb) => ({
              last_seen: eb.ref('excluded.last_seen'),
              source_id: eb.ref('excluded.source_id'),
              metric_id: eb.ref('excluded.metric_id'),
              owner_kind: eb.ref('excluded.owner_kind'),
              owner_namespace: eb.ref('excluded.owner_namespace'),
              owner_workload_kind: eb.ref('excluded.owner_workload_kind'),
              owner_name: eb.ref('excluded.owner_name'),
            })),
          )
          .execute();
      }
    });
    for (const f of fresh) c.series.get(f.fp)!.flushed = now;
  }

  /**
   * Writes what changed in memory: when each series last reported, the pushed totals, each
   * source's count and drops, each metric's labels; and lets go of series not seen for an hour
   * (rows not seen for a day are removed).
   */
  async flush(): Promise<void> {
    const now = this.now();
    const { db } = this.o;
    for (const c of [...this.clusters.values()]) {
      const seen: string[] = [];
      const totals: [string, number][] = [];
      for (const [fp, s] of c.series) {
        if (now - s.lastSeen > ACTIVE_MS) {
          c.series.delete(fp);
          const src = c.sources.get(s.source);
          if (src) {
            src.series.delete(fp);
            src.dirty = true;
          }
          const m = c.metrics.get(s.metric);
          if (m) countValues(m, s.pairs, -1);
          continue;
        }
        if (s.lastSeen > s.flushed) {
          seen.push(fp);
          if (s.total !== null) totals.push([fp, s.total]);
          s.flushed = s.lastSeen;
        }
      }
      const sources = [...c.sources.values()].filter((s) => s.dirty);
      const metrics = [...c.metrics.values()].filter(
        (m) => m.dirty || m.lastSeen > now - FLUSH_MS * 2,
      );
      if (!seen.length && !sources.length && !metrics.length) continue;
      try {
        await withOrg(c.orgId, async () => {
          for (let i = 0; i < seen.length; i += 2000) {
            await db
              .updateTable('own_series')
              .set({ last_seen: new Date(now) })
              .where('cluster_id', '=', c.clusterId)
              .where('fingerprint', 'in', seen.slice(i, i + 2000))
              .execute();
          }
          for (const [fp, total] of totals) {
            await db
              .updateTable('own_series')
              .set({ total })
              .where('cluster_id', '=', c.clusterId)
              .where('fingerprint', '=', fp)
              .execute();
          }
          for (const s of sources) {
            await db
              .updateTable('own_sources')
              .set({
                label: s.label,
                owner: JSON.stringify(s.owner),
                series: s.series.size,
                dropped: JSON.stringify(s.dropped),
                error: s.error ? s.error.slice(0, 512) : null,
                refused: s.refused,
                last_reported_at: s.lastReportedAt ? new Date(s.lastReportedAt) : null,
              })
              .where('id', '=', s.id)
              .execute();
            s.dirty = false;
          }
          for (const m of metrics) {
            await db
              .updateTable('own_metrics')
              .set({
                type: m.type,
                last_seen: new Date(m.lastSeen),
                label_names: [...m.labelNames].sort(),
                refused: m.refused ? JSON.stringify(m.refused) : null,
              })
              .where('id', '=', m.id)
              .execute();
            m.dirty = false;
          }
          await db
            .deleteFrom('own_series')
            .where('cluster_id', '=', c.clusterId)
            .where('last_seen', '<', new Date(now - FORGET_MS))
            .execute();
        });
      } catch (err) {
        this.o.log.warn({ err, clusterId: c.clusterId }, 'own metrics: flushing a cluster failed');
      }
    }
  }
}

/** Adds a series' label values to its metric's count (or takes them away when it ages out). */
function countValues(m: MetricState, pairs: readonly [string, string][], by: 1 | -1): void {
  for (const [k, v] of pairs) {
    let values = m.values.get(k);
    if (!values) {
      if (by < 0) continue;
      m.values.set(k, (values = new Map()));
    }
    const n = (values.get(v) ?? 0) + by;
    if (n > 0) values.set(v, n);
    else values.delete(v);
  }
}

/** Labels the server adds to a scraped series (the pod, the instance): names checked. */
function cleanExtra(extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) if (v) out[k] = v.slice(0, 253);
  return out;
}
