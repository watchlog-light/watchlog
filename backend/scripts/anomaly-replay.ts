// SPDX-License-Identifier: AGPL-3.0-only
// What changed (0.8.0), slice 7: does the live demo's hourly chaos stay out of its baselines,
// and how many anomaly alerts a day would it raise? (ADR-196, ADR-200, ADR-203.) Nothing here
// is product code: it reads a demo kit's stored past minutes and replays them as 14 days
// through the anomaly-worker's own jobs on an injectable clock, at full speed (no waiting).
//
//   capture: VM_URL=http://127.0.0.1:<port> PG_URL=postgres://… \
//            RANGES=<ISO from>/<ISO to>,… OUT=capture.json npx tsx scripts/anomaly-replay.ts capture
//     Past ranges only (whatever the kit's VictoriaMetrics still keeps): every scored key of
//     every cluster (the worker's own queries, 60 s step), the alerts that fired, the change
//     markers and the Docker container list, from the demo's VictoriaMetrics and PostgreSQL
//     (read only). The ranges need not be whole hours: replay builds one hour from them.
//   replay:  IN=capture.json DATABASE_URL=postgres://…/scratch npx tsx scripts/anomaly-replay.ts replay
//     A scratch database (the migrations are applied; its rows are replaced). One hour is
//     built from the stored minutes, each minute of the hour from the latest range that has
//     it (the demo's chaos is hourly: each scenario keeps its minute), and repeated over 14
//     days, alerts and markers with it. Days 0–6 learn
//     (runAnomalyHour every hour, firing-alert exclusion included), days 7–13 also score
//     every minute (runAnomalyMinute). Prints the periods and the anomaly alerts per cluster
//     and day (ADR-200's aim: fewer than 3) for the default WATCHLOG_ANOMALY_ALERT_KEYS and
//     with no filter, split into alerts that duplicate an alert already firing on the subject
//     and new information, with the 30-minute quiet after a rollout applied, and how many
//     remain with slice 7b's rule (none while another alert fires on the subject); per chaos
//     scenario (SCENARIOS, below), whether its minutes are left out of the baselines.
//     NO_ALERTS=1 replays without the alerts (no exclusion), for comparison; MINUTES=n scores
//     with WATCHLOG_ANOMALY_MINUTES=n instead of 10; SCENARIOS_ONLY=1
//     prints only the scenarios' table (no 14 days).
//   showcase: DATABASE_URL=postgres://…/scratch [DAYS=21] npx tsx scripts/anomaly-replay.ts showcase
//     Slice 7b: the demo kit's What changed showcase (manifests/drift.yaml, the Docker host's
//     search and search-client) on generated data, both platforms: its periods per drift,
//     how long each is unusual, the anomaly alerts per drift, and whether the second and
//     third weeks still list it (not learned as normal).
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createDb } from '../src/db/index.js';
import { migrateUp } from '../src/db/migrate.js';
import { newId } from '../src/lib/ids.js';
import {
  VictoriaQueryClient,
  authorisedScope,
  type ClusterScope,
  type QuerySeries,
} from '../src/lib/victoria.js';
import {
  ANOMALY_RULE_KEY,
  DEFAULT_ALERT_KEYS,
  ROLLOUT_QUIET_MS,
  QUIET_MARKER_KINDS,
  anomalyLabels,
  inQuiet,
  parseAlertKeys,
} from '../src/modules/anomaly/alerts.js';
import {
  alertTokens,
  type ComposeOf,
  excluded,
  seriesTokens,
  type Firing,
} from '../src/modules/anomaly/exclusion.js';
import { runAnomalyHour, runAnomalyMinute, type AnomalyDeps } from '../src/modules/anomaly/jobs.js';
import { queriesFor, subjectOf, unitOf, type ClusterKind } from '../src/modules/anomaly/keys.js';
import { DEFAULT_RULE, medianAndMad, scoreOf } from '../src/modules/anomaly/stats.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface CapturedAlert {
  rule: string;
  labels: Record<string, string>;
  /** When its condition first held (before the rule's "for"), and when it fired. */
  started: number;
  fired: number;
  resolved: number | null;
}
interface CapturedCluster {
  id: string;
  name: string;
  kind: ClusterKind;
  types: string[];
  /** key → series (labels, [unix s, value][]). */
  series: Record<string, QuerySeries[]>;
  alerts: CapturedAlert[];
  markers: { kind: string; target: string; ts: number }[];
  containers: { name: string; node: string; project: string | null; service: string | null }[];
  /** Monitored services: integration id → name (series and alerts say `service=<id>`). */
  services: Record<string, string>;
}
interface Capture {
  /** The stored ranges read, [from, to) in ms, in the order given (later ones win). */
  ranges: [number, number][];
  clusters: CapturedCluster[];
}

// ------------------------------------------------------------------------------ capture

async function capture() {
  const ranges = (process.env.RANGES ?? '').split(',').map((r) => {
    const [a, b] = r.split('/').map((x) => Math.floor(Date.parse(x) / MIN) * MIN);
    if (!(a! < b!) || b! > Date.now()) throw new Error(`RANGES: past ranges from/to, not ${r}`);
    return [a!, b!] as [number, number];
  });
  const from = Math.min(...ranges.map((r) => r[0]));
  const to = Math.max(...ranges.map((r) => r[1]));
  const vm = new VictoriaQueryClient(process.env.VM_URL!, 60_000, 60_000);
  const db = new pg.Client({ connectionString: process.env.PG_URL });
  await db.connect();
  const out: Capture = { ranges, clusters: [] };
  const clusters = await db.query<{ id: string; name: string; kind: ClusterKind }>(
    `SELECT id, name, kind FROM clusters WHERE kind IN ('kubernetes','docker') ORDER BY kind DESC`,
  );
  for (const c of clusters.rows) {
    const types = (
      await db.query<{ type: string }>(
        'SELECT DISTINCT type FROM integrations WHERE cluster_id = $1',
        [c.id],
      )
    ).rows.map((r) => r.type);
    const series: Record<string, QuerySeries[]> = {};
    for (const q of queriesFor(c.kind, types)) {
      const byLabels = new Map<string, QuerySeries>();
      for (const [a, b] of ranges) {
        for (const s of await vm.queryRange(
          authorisedScope(c.id),
          q.expr,
          a / 1000,
          (b - MIN) / 1000,
          60,
        )) {
          const k = JSON.stringify(subjectOf(s.labels));
          const had = byLabels.get(k);
          if (had) had.points.push(...s.points);
          else byLabels.set(k, { labels: s.labels, points: [...s.points] });
        }
      }
      series[q.key] = [...byLabels.values()];
    }
    const alerts = (
      await db.query<{
        rule: string;
        labels: Record<string, string>;
        started_at: Date;
        fired_at: Date;
        resolved_at: Date | null;
      }>(
        `SELECT coalesce(r.rule_key, r.name) AS rule, s.labels, s.started_at, s.fired_at, s.resolved_at
           FROM alert_states s JOIN alert_rules r ON r.id = s.rule_id
          WHERE s.cluster_id = $1 AND s.fired_at IS NOT NULL AND s.started_at < $3
            AND (s.resolved_at IS NULL OR s.resolved_at > $2)`,
        [c.id, new Date(from), new Date(to)],
      )
    ).rows.map((r) => ({
      rule: r.rule,
      labels: r.labels ?? {},
      started: Math.min(r.started_at.getTime(), r.fired_at.getTime()),
      fired: r.fired_at.getTime(),
      resolved: r.resolved_at?.getTime() ?? null,
    }));
    const markers = (
      await db.query<{ kind: string; target: string; ts: Date }>(
        `SELECT kind, target, ts FROM change_markers WHERE cluster_id = $1 AND ts >= $2 AND ts < $3`,
        [c.id, new Date(from - ROLLOUT_QUIET_MS), new Date(to)],
      )
    ).rows.map((r) => ({ kind: r.kind, target: r.target, ts: r.ts.getTime() }));
    const containers = (
      await db.query<{ name: string; node: string; namespace: string; svc: string | null }>(
        `SELECT name, node, namespace, spec_summary->>'compose_service' AS svc FROM objects
          WHERE cluster_id = $1 AND kind = 'DockerContainer' AND deleted_at IS NULL`,
        [c.id],
      )
    ).rows.map((r) => ({
      name: r.name,
      node: r.node,
      project: r.namespace || null,
      service: r.svc,
    }));
    const services = Object.fromEntries(
      (
        await db.query<{ id: string; name: string }>(
          'SELECT id, name FROM integrations WHERE cluster_id = $1',
          [c.id],
        )
      ).rows.map((r) => [r.id, r.name]),
    );
    const n = Object.values(series).reduce((a, s) => a + s.length, 0);
    console.log(
      `${c.kind} ${c.name}: ${n} series, ${alerts.length} alerts, ${markers.length} markers`,
    );
    out.clusters.push({ ...c, types, series, alerts, markers, containers, services });
  }
  await db.end();
  writeFileSync(process.env.OUT ?? 'capture.json', JSON.stringify(out));
}

// ------------------------------------------------------------------------------ the chaos

/**
 * The demo kit's scenarios (deploy/demo: chaos.yaml, shop.yaml, egress.yaml, the Docker
 * host's compose.yaml), by subject token (exclusion.ts) and minutes of the hour, UTC.
 */
interface Scenario {
  name: string;
  kind: ClusterKind;
  tokens: string[];
  /** [from, to) minutes of the hour; `every` repeats from 0 (report-builder, worker). */
  minutes: [number, number][];
}
const w = (name: string, kind = 'Deployment') => `w:shop/${kind}/${name}`;
const SCENARIOS: Scenario[] = [
  {
    name: 'api-outage (:00, :30)',
    kind: 'kubernetes',
    tokens: [w('api'), 'svc:traefik/traefik', 'svc:ingress-nginx/ingress-nginx-controller'],
    minutes: [
      [0, 8],
      [30, 38],
    ],
  },
  {
    name: 'analytics (:05)',
    kind: 'kubernetes',
    tokens: [w('analytics', 'CronJob'), 'svc:shop/mongodb'],
    minutes: [[5, 11]],
  },
  { name: 'updater (:12)', kind: 'kubernetes', tokens: [w('updater')], minutes: [[12, 14]] },
  { name: 'slow-backend (:15)', kind: 'kubernetes', tokens: [w('backend')], minutes: [[15, 22]] },
  {
    name: 'nightly-export (:20)',
    kind: 'kubernetes',
    tokens: [w('nightly-export', 'CronJob'), 'svc:shop/postgres'],
    minutes: [[20, 29]],
  },
  { name: 'busy-backend (:41)', kind: 'kubernetes', tokens: [w('backend')], minutes: [[41, 48]] },
  {
    name: 'ip-beacon (:47)',
    kind: 'kubernetes',
    tokens: [w('ip-beacon', 'CronJob')],
    minutes: [[47, 49]],
  },
  {
    name: 'inventory-lock (:50)',
    kind: 'kubernetes',
    tokens: [w('inventory'), w('inventory-lock', 'CronJob'), 'svc:shop/mariadb'],
    minutes: [[50, 56]],
  },
  {
    name: 'report-builder OOM (every 10 min)',
    kind: 'kubernetes',
    tokens: [w('report-builder', 'CronJob')],
    minutes: [0, 10, 20, 30, 40, 50].map((m) => [m, m + 2] as [number, number]),
  },
  {
    name: 'legacy-importer (crash loop, always)',
    kind: 'kubernetes',
    tokens: [w('legacy-importer')],
    minutes: [[0, 60]],
  },
  {
    name: 'audit (Kafka consumer, 47-min OOM)',
    kind: 'kubernetes',
    tokens: [w('audit'), 'svc:shop/kafka'],
    minutes: [[0, 60]],
  },
  {
    name: 'consumer (RabbitMQ, 31-min OOM)',
    kind: 'kubernetes',
    tokens: [w('consumer'), 'svc:shop/rabbitmq'],
    minutes: [[0, 60]],
  },
  { name: 'dns-typo (always)', kind: 'kubernetes', tokens: [w('dns-typo')], minutes: [[0, 60]] },
  {
    name: 'Docker worker OOM (every 20 min)',
    kind: 'docker',
    tokens: ['s:storefront/worker'],
    minutes: [0, 20, 40].map((m) => [m, m + 3] as [number, number]),
  },
  {
    name: 'Docker updater (:12)',
    kind: 'docker',
    tokens: ['s:storefront/updater'],
    minutes: [[12, 14]],
  },
  {
    name: 'Docker ip-beacon (:47)',
    kind: 'docker',
    tokens: ['s:storefront/ip-beacon'],
    minutes: [[47, 49]],
  },
];
/** Docker: each container's Compose project and service (exclusion.ts composeMap). */
const composeOf = (c: CapturedCluster): ComposeOf =>
  new Map(
    c.containers
      .filter((k) => k.project && k.service)
      .map((k) => [k.name, { project: k.project!, service: k.service! }]),
  );
/** A scenario's tokens on a cluster: `svc:<name>` is a monitored service, by its id. */
const tokensOf = (sc: Scenario, c: CapturedCluster) =>
  sc.tokens.map((t) => {
    if (!t.startsWith('svc:')) return t;
    const id = Object.entries(c.services).find(([, n]) => n === t.slice(4))?.[0];
    return id ? `i:${id}` : t;
  });
const inScenario = (s: Scenario, t: number) => {
  const m = new Date(t).getUTCMinutes();
  return s.minutes.some(([a, b]) => m >= a && m < b);
};

// ------------------------------------------------------------------------------ replay

async function replay() {
  const cap: Capture = JSON.parse(readFileSync(process.env.IN ?? 'capture.json', 'utf8'));
  const url = process.env.DATABASE_URL!;
  const noAlerts = process.env.NO_ALERTS === '1';
  const days = Number(process.env.DAYS ?? 14);
  await migrateUp(url);
  const db = createDb(url);
  // MINUTES=5: WATCHLOG_ANOMALY_MINUTES=5 instead of ADR-196's 10, to compare.
  const rule = { ...DEFAULT_RULE, minutes: Number(process.env.MINUTES ?? DEFAULT_RULE.minutes) };
  /** Replay starts on a Monday 00:00 UTC; minutes of the hour match the stored ones. */
  const R0 = Date.UTC(2026, 9, 5);
  /** Each minute of the hour: the stored minute it comes from (the latest range's wins). */
  const src: (number | null)[] = Array(60).fill(null);
  for (const [a, b] of cap.ranges) {
    for (let t = a; t < b; t += MIN) src[new Date(t).getUTCMinutes()] = t;
  }
  const minuteOf = (t: number) => new Date(t).getUTCMinutes();
  const toCap = (t: number) => src[minuteOf(t)] ?? -1;
  const coverage = cap.ranges
    .map(
      ([a, b]) =>
        `${new Date(a).toISOString().slice(0, 16)}–${new Date(b).toISOString().slice(11, 16)}`,
    )
    .join(', ');
  /** The minutes of the hour whose stored minute lies in [from, to). */
  const minutesIn = (from: number, to: number) =>
    src.map((t, m) => (t !== null && t >= from && t < to ? m : -1)).filter((m) => m >= 0);
  await db.deleteFrom('anomaly_periods').execute();
  await db.deleteFrom('anomaly_baselines').execute();
  await db.deleteFrom('anomaly_orgs').execute();
  const orgId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: 'Replay', slug: `replay-${orgId.slice(-8)}`, plan: 'community' })
    .execute();
  const ruleIds = new Map<string, string>();
  const ruleId = async (key: string) => {
    let id = ruleIds.get(key);
    if (!id) {
      id = newId();
      await db
        .insertInto('alert_rules')
        .values({
          id,
          org_id: orgId,
          name: key,
          type: 'default',
          rule_key: key,
          severity: 'warning',
        })
        .execute();
      ruleIds.set(key, id);
    }
    return id;
  };
  /** A stored interval as replay intervals: its minutes of the hour, every hour. */
  const tile = (from: number, to: number) => {
    const runs: [number, number][] = [];
    for (const m of minutesIn(from, to)) {
      const last = runs.at(-1);
      if (last && last[1] === m) last[1] = m + 1;
      else runs.push([m, m + 1]);
    }
    const out: [number, number][] = [];
    for (let h = R0; h < R0 + days * DAY; h += HOUR) {
      for (const [a, b] of runs) out.push([h + a * MIN, h + b * MIN]);
    }
    return out;
  };
  const replayed = new Map<
    string,
    { firing: Firing[]; markers: { target: string; kind: string; ts: Date }[] }
  >();
  const ids = new Map<string, string>();
  for (const c of cap.clusters) {
    const id = newId();
    ids.set(c.id, id);
    await db
      .insertInto('clusters')
      .values({ id, org_id: orgId, name: c.name, kind: c.kind })
      .execute();
    for (const type of c.types) {
      await db
        .insertInto('integrations')
        .values({
          id: newId(),
          org_id: orgId,
          cluster_id: id,
          type,
          name: type,
          target: JSON.stringify({ kind: 'address', port: 1 }),
        })
        .execute();
    }
    for (const k of c.containers) {
      await db
        .insertInto('objects')
        .values({
          id: newId(),
          org_id: orgId,
          cluster_id: id,
          source: 'docker',
          kind: 'DockerContainer',
          namespace: k.project ?? '',
          name: k.name,
          node: k.node,
          uid: newId(),
          spec_summary: JSON.stringify(k.service ? { compose_service: k.service } : {}),
          status_summary: JSON.stringify({}),
        })
        .execute();
    }
    const firing: Firing[] = [];
    const rows: object[] = [];
    for (const a of c.alerts) {
      if (a.rule === ANOMALY_RULE_KEY) continue;
      const rid = await ruleId(a.rule);
      for (const [f, r] of tile(a.started, a.resolved ?? Infinity)) {
        firing.push({ from: f, to: r, tokens: alertTokens(c.kind, a.labels, composeOf(c)) });
        rows.push({
          id: newId(),
          org_id: orgId,
          rule_id: rid,
          cluster_id: id,
          fingerprint: `${rid}:${f}:${rows.length}`,
          state: 'resolved',
          severity: 'warning',
          labels: JSON.stringify(a.labels),
          started_at: new Date(f),
          fired_at: new Date(f),
          resolved_at: new Date(r),
        });
      }
    }
    if (!noAlerts) {
      for (let i = 0; i < rows.length; i += 500) {
        await db
          .insertInto('alert_states')
          .values(rows.slice(i, i + 500) as never)
          .execute();
      }
    }
    const markers = c.markers
      .filter((m) => (QUIET_MARKER_KINDS as readonly string[]).includes(m.kind))
      .flatMap((m) =>
        tile(m.ts, m.ts + 1).map(([t]) => ({
          kind: m.kind,
          target: m.target,
          ts: new Date(t + (m.ts % MIN)),
        })),
      );
    replayed.set(id, { firing, markers });
  }

  // The fake VictoriaMetrics: each scored key's captured series, at the captured minute.
  const keyOf = new Map<string, string>();
  for (const c of cap.clusters)
    for (const q of queriesFor(c.kind, c.types)) keyOf.set(q.expr, q.key);
  const byCluster = new Map<
    string,
    Map<string, { labels: Record<string, string>; at: Map<number, number> }[]>
  >();
  for (const c of cap.clusters) {
    const keys = new Map<string, { labels: Record<string, string>; at: Map<number, number> }[]>();
    for (const [key, list] of Object.entries(c.series)) {
      keys.set(
        key,
        list.map((s) => ({
          labels: s.labels,
          at: new Map(
            s.points.filter(([, v]) => v !== null).map(([t, v]) => [t * 1000, v as number]),
          ),
        })),
      );
    }
    byCluster.set(ids.get(c.id)!, keys);
  }
  const victoria = {
    async queryRange(scope: ClusterScope, expr: string, start: number, end: number, step: number) {
      const list = byCluster.get(scope.clusterId)?.get(keyOf.get(expr) ?? '') ?? [];
      const out: QuerySeries[] = [];
      for (const s of list) {
        const points: [number, number | null][] = [];
        for (let t = start; t <= end; t += step) {
          const v = s.at.get(toCap(t * 1000));
          if (v !== undefined) points.push([t, v]);
        }
        if (points.length) out.push({ labels: s.labels, points });
      }
      return out;
    },
  };
  const deps: AnomalyDeps = {
    db,
    systemDb: db,
    victoria,
    orgs: async () => [orgId],
    rule,
    log: { warn: (o, m) => console.warn(m, o) },
  };
  const began = Date.now();
  await runAnomalyMinute(deps, R0);
  // SCENARIOS_ONLY=1: only the per-scenario table, from the stored minutes (seconds).
  const span = process.env.SCENARIOS_ONLY === '1' ? 0 : days * DAY;
  for (let h = R0; h < R0 + span; h += HOUR) {
    if (h >= R0 + 7 * DAY) for (let m = h; m < h + HOUR; m += MIN) await runAnomalyMinute(deps, m);
    await runAnomalyHour(deps, h + HOUR + 5 * MIN);
    if ((h - R0) % DAY === 0)
      console.error(`day ${(h - R0) / DAY} (${Math.round((Date.now() - began) / 1000)} s)`);
  }

  // ---------------------------------------------------------------------------- the counts
  const periods = await db
    .selectFrom('anomaly_periods')
    .select(['cluster_id', 'metric', 'subject', 'started_at', 'ended_at', 'peak_score'])
    .orderBy('started_at')
    .execute();
  const filters = { default: parseAlertKeys(DEFAULT_ALERT_KEYS), none: parseAlertKeys('*') };
  if (process.env.KEYS) Object.assign(filters, { custom: parseAlertKeys(process.env.KEYS) });
  const scoreDays = days - 7;
  console.log(
    `\nreplay (past ${rule.score} for ${rule.minutes} min) ${days} days from ${new Date(R0).toISOString()}, scored days 7–${days - 1}` +
      `${noAlerts ? ' (NO alerts: no exclusion)' : ''}; one hour from the stored minutes of ${coverage}` +
      ` (${src.filter((t) => t !== null).length} of 60 minutes)`,
  );
  for (const c of cap.clusters) {
    const id = ids.get(c.id)!;
    const { firing, markers } = replayed.get(id)!;
    const containers = new Map(
      c.containers.map((k) => [k.name, { host: k.node, project: k.project, service: k.service }]),
    );
    const mine = periods.filter((p) => p.cluster_id === id);
    console.log(
      `\n== ${c.kind} ${c.name}: ${mine.length} periods (${(mine.length / scoreDays).toFixed(1)} a day)`,
    );
    const byKey = new Map<string, number>();
    for (const p of mine) byKey.set(p.metric, (byKey.get(p.metric) ?? 0) + 1);
    console.log(
      '   periods by key:',
      [...byKey]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(', '),
    );
    for (const [fname, allow] of Object.entries(filters)) {
      let dup = 0;
      let fresh = 0;
      let quiet = 0;
      let held = 0;
      let late = 0;
      const subjects = new Map<string, number>();
      for (const p of mine) {
        if (!allow(p.metric)) continue;
        const subject = p.subject as Record<string, string>;
        const labels = anomalyLabels(c.kind, p.metric, subject, containers);
        const start = p.started_at.getTime() + rule.minutes * MIN;
        const end = p.ended_at?.getTime() ?? start;
        // The alert opens at the first minute of the period outside a rollout's quiet.
        let at: number | null = null;
        for (let t = start; t <= Math.max(start, end); t += MIN) {
          const recent = markers.filter(
            (m) => m.ts.getTime() <= t && m.ts.getTime() > t - ROLLOUT_QUIET_MS,
          );
          if (!inQuiet(c.kind, labels, containers, recent)) {
            at = t;
            break;
          }
        }
        if (at === null) {
          quiet++;
          continue;
        }
        const tokens = seriesTokens(c.kind, subject, composeOf(c));
        if (excluded(at, tokens, firing)) dup++;
        else fresh++;
        // Slice 7b: no new alert while another alert fires on the subject; it opens at the
        // first minute of the period outside the quiet with none firing, if there is one.
        let opened: number | null = null;
        for (let t = at; t <= Math.max(at, end); t += MIN) {
          const recent = markers.filter(
            (m) => m.ts.getTime() <= t && m.ts.getTime() > t - ROLLOUT_QUIET_MS,
          );
          if (!inQuiet(c.kind, labels, containers, recent) && !excluded(t, tokens, firing)) {
            opened = t;
            break;
          }
        }
        if (opened === null) held++;
        else if (opened > at) late++;
        const name = `${p.metric} ${Object.values(subject).join('/')}`;
        subjects.set(name, (subjects.get(name) ?? 0) + 1);
      }
      const total = dup + fresh;
      console.log(
        `   alerts, filter ${fname}: ${(total / scoreDays).toFixed(1)} a day ` +
          `(${(dup / scoreDays).toFixed(1)} duplicate an alert firing on the subject, ` +
          `${(fresh / scoreDays).toFixed(1)} new); ${quiet} kept quiet by a rollout in ${scoreDays} days`,
      );
      console.log(
        `   with slice 7b (none while another alert fires on the subject): ` +
          `${((total - held) / scoreDays).toFixed(1)} a day; ${(held / scoreDays).toFixed(1)} a day held ` +
          `back for the whole period, ${(late / scoreDays).toFixed(1)} a day opened after the other alert resolved`,
      );
      for (const [n, k] of [...subjects].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`      ${(k / scoreDays).toFixed(1)}/day  ${n}`);
      }
    }
  }

  // ---------------------------------------------------------------------------- the scenarios
  console.log('\n== scenarios: their minutes in the baselines, and what scores past 4');
  for (const sc of SCENARIOS) {
    const c = cap.clusters.find((x) => x.kind === sc.kind);
    if (!c) continue;
    const id = ids.get(c.id)!;
    const scTokens = tokensOf(sc, c);
    const { firing } = replayed.get(id)!;
    const capFiring: Firing[] = noAlerts
      ? []
      : c.alerts
          .filter((a) => a.rule !== ANOMALY_RULE_KEY)
          .map((a) => ({
            from: a.started,
            to: a.resolved ?? Infinity,
            tokens: alertTokens(c.kind, a.labels, composeOf(c)),
          }));
    void firing;
    let series = 0;
    let short = 0;
    let all = 0;
    let allOut = 0;
    let minutes = 0;
    let out = 0;
    let past = 0;
    let pastClean = 0;
    let longest = 0;
    const rules = new Set<string>();
    for (const a of c.alerts) {
      const t = alertTokens(c.kind, a.labels, composeOf(c));
      if (!scTokens.some((x) => t.has(x)) || a.rule === ANOMALY_RULE_KEY) continue;
      // Only the alerts firing during one of the scenario's minutes.
      if (minutesIn(a.started, a.resolved ?? Infinity).some((m) => inScenario(sc, m * MIN))) {
        rules.add(a.rule);
      }
    }
    for (const [key, list] of Object.entries(c.series)) {
      for (const s of list) {
        const tokens = seriesTokens(c.kind, subjectOf(s.labels), composeOf(c));
        if (!scTokens.some((x) => tokens.has(x))) continue;
        series++;
        // The replayed hour: the bucket as the worker learns it (exclusion applied), and as
        // it would be without the scenario's minutes at all. Points as [stored s, value],
        // in the order of the minutes of the hour.
        const at = new Map(s.points.filter(([, v]) => v !== null).map(([t, v]) => [t * 1000, v!]));
        {
          const pts = src
            .map((t) => (t !== null && at.has(t) ? [t / 1000, at.get(t)!] : null))
            .filter((p): p is [number, number] => p !== null);
          const kept = pts
            .filter(([t]) => !excluded(t * 1000, tokens, capFiring))
            .map(([, v]) => v);
          const clean = pts.filter(([t]) => !inScenario(sc, t * 1000)).map(([, v]) => v);
          for (const [t] of pts) {
            if (!inScenario(sc, t * 1000)) continue;
            all++;
            if (excluded(t * 1000, tokens, capFiring)) allOut++;
          }
          if (kept.length < 30) {
            short++;
            continue;
          }
          const b = medianAndMad(kept);
          // A scenario that lasts all hour has no minutes without it: compare with itself.
          const bc = clean.length >= 10 ? medianAndMad(clean) : b;
          let run = 0;
          for (const [t, v] of pts) {
            if (!inScenario(sc, t * 1000)) {
              run = 0;
              continue;
            }
            minutes++;
            if (excluded(t * 1000, tokens, capFiring)) out++;
            const sc1 = scoreOf(v, b.median, b.mad, unitOf(key), rule);
            if (sc1 > rule.score) past++;
            if (scoreOf(v, bc.median, bc.mad, unitOf(key), rule) > rule.score) pastClean++;
            run = sc1 > rule.score ? run + 1 : 0;
            longest = Math.max(longest, run);
          }
        }
      }
    }
    const listed = periods.filter((p) => {
      if (p.cluster_id !== id) return false;
      const t = seriesTokens(c.kind, p.subject as Record<string, string>, composeOf(c));
      return scTokens.some((x) => t.has(x));
    });
    const pct = (n: number, of = minutes) => (of ? `${Math.round((n / of) * 100)} %` : '–');
    void out;
    console.log(
      `   ${sc.name}: ${series} series (${short} never scored: under 30 minutes an hour once ` +
        `alerts are left out, or a job's own); its minutes left out ${pct(allOut, all)} of ${all}; ` +
        `past 4 against the learned bucket ${pct(past)} (without its minutes ${pct(pastClean)}), ` +
        `longest run ${longest} min; periods on it ${(listed.length / scoreDays).toFixed(1)} a day; ` +
        `alerts on it: ${[...rules].join(', ') || 'none'}`,
    );
  }
  await db.destroy();
}

// ------------------------------------------------------------------------------ showcase

/**
 * Slice 7b: the demo kit's What changed showcase (deploy/demo manifests/drift.yaml and the
 * Docker host's compose.yaml), on generated data. `search` answers a request a second in
 * 8–12 ms; every 2 hours, at :50 past every odd UTC hour (01:50 … 23:50; 03:50, 11:50 and
 * 19:50 before the kit's 2026-11-16 change, DRIFT_EVERY=28800), its response time climbs to 800 ms in 10 minutes,
 * to 1 s in 10 more, and back to 10 ms in 8 (the kit's CGI script, to the millisecond).
 */
/** The drift's period in seconds (DRIFT_EVERY; the kit's 7200: :50 past every odd UTC hour). */
const DRIFT_EVERY = Number(process.env.DRIFT_EVERY ?? 7_200);

export function driftMs(t: number, every = DRIFT_EVERY): number {
  const s = Math.floor(t / 1000);
  const into = (((s - 13_800) % every) + every) % every;
  if (into < 600) return 10 + Math.floor((into * 790) / 600);
  if (into < 1200) return 800 + Math.floor((into - 600) / 3);
  if (into < 1680) return 1000 - Math.floor(((into - 1200) * 99) / 48);
  // The quiet answer: 8–12 ms (a fixed pseudo-random sequence).
  return 8 + (((s * 2_654_435_761) >>> 0) % 5);
}

/** The agent's HTTP buckets (agent/internal/ebpf/types.go HTTPBuckets), in seconds. */
const HTTP_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * The minute's p95 and request rate as the catalog reads them: histogram_quantile(0.95) over
 * a 2-minute rate window of a sequential client (a request, its answer, a second's sleep).
 */
function httpAt(t: number): { p95: number; rate: number } {
  const durations: number[] = [];
  for (let at = t - 120_000; at < t;) {
    const d = driftMs(at);
    durations.push(d / 1000);
    at += d + 1000;
  }
  const counts = HTTP_BUCKETS.map((le) => durations.filter((d) => d <= le).length);
  const rank = 0.95 * durations.length;
  const i = counts.findIndex((c) => c >= rank);
  const lo = i > 0 ? HTTP_BUCKETS[i - 1]! : 0;
  const below = i > 0 ? counts[i - 1]! : 0;
  const p95 = lo + ((HTTP_BUCKETS[i]! - lo) * (rank - below)) / (counts[i]! - below);
  return { p95, rate: durations.length / 120 };
}

async function showcase() {
  const url = process.env.DATABASE_URL!;
  const days = Number(process.env.DAYS ?? 21);
  await migrateUp(url);
  const db = createDb(url);
  const rule = DEFAULT_RULE;
  const R0 = Date.UTC(2026, 9, 5);
  for (const t of ['anomaly_periods', 'anomaly_baselines', 'anomaly_orgs'] as const) {
    await db.deleteFrom(t).execute();
  }
  const orgId = newId();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: 'Showcase', slug: `showcase-${orgId.slice(-8)}`, plan: 'community' })
    .execute();
  const noise = (t: number, k: number) => ((((t / MIN) * 7919 + k * 104_729) >>> 0) % 1000) / 1000;
  // Per platform: the server's and client's names, and the generated series by key.
  const platforms = {
    kubernetes: {
      server: {
        dst_kind: 'workload',
        dst_namespace: 'shop',
        dst_workload_kind: 'Deployment',
        dst_workload: 'search',
      },
      edge: { namespace: 'shop', workload_kind: 'Deployment', workload: 'search-client' },
      own: { namespace: 'shop', workload_kind: 'Deployment', workload: 'search' },
      cpu: 'workload.cpu.usage',
      mem: 'workload.memory.working_set',
      host: { node: 'k3d-watchlog-demo-agent-0' },
      hostMem: 'node.memory.utilization',
    },
    docker: {
      server: { dst_kind: 'container', dst: 'storefront-search-1' },
      edge: {
        container: 'storefront-search-client-1',
        compose_project: 'storefront',
        compose_service: 'search-client',
      },
      own: { container: 'storefront-search-1', host: 'demo-docker-host' },
      cpu: 'container.cpu.usage',
      mem: 'container.memory.working_set',
      host: { host: 'demo-docker-host' },
      hostMem: 'host.memory.utilization',
    },
  } as const;
  const ids = new Map<string, ClusterKind>();
  for (const kind of ['kubernetes', 'docker'] as const) {
    const id = newId();
    ids.set(id, kind);
    await db
      .insertInto('clusters')
      .values({ id, org_id: orgId, name: `showcase-${kind}`, kind })
      .execute();
    if (kind === 'docker') {
      for (const name of ['storefront-search-1', 'storefront-search-client-1']) {
        await db
          .insertInto('objects')
          .values({
            id: newId(),
            org_id: orgId,
            cluster_id: id,
            source: 'docker',
            kind: 'DockerContainer',
            namespace: 'storefront',
            name,
            node: 'demo-docker-host',
            uid: newId(),
            spec_summary: JSON.stringify({ compose_service: name.slice(11, -2) }),
            status_summary: JSON.stringify({}),
          })
          .execute();
      }
    }
  }
  const keyOf = new Map<string, string>();
  for (const kind of ['kubernetes', 'docker'] as const) {
    for (const q of queriesFor(kind, [])) keyOf.set(q.expr, q.key);
  }
  /** One generated value of a key at minute t, or null when the showcase has no such series. */
  const valueOf = (
    kind: ClusterKind,
    key: string,
    t: number,
  ): [Record<string, string>, number] | null => {
    const p = platforms[kind];
    const http = () => httpAt(t);
    switch (key) {
      case 'workload.http.latency.p95':
        return [p.server, http().p95];
      case 'workload.http.requests.rate':
        return [p.server, http().rate];
      case 'workload.http.errors.ratio':
        return [p.server, 0];
      case 'edge.http.latency.p95':
        return [{ ...p.edge, ...p.server, dst_port: '8080' }, http().p95];
      case 'edge.http.requests.rate':
        return [{ ...p.edge, ...p.server, dst_port: '8080' }, http().rate];
      case p.cpu:
        // A CGI script per request: a little CPU, the same at 10 ms or 1 s.
        return [p.own, 0.004 + 0.002 * noise(t, 1)];
      case p.mem:
        // One more sleeping shell at the peak: about 1 MiB.
        return [p.own, (3 + noise(t, 2) + (driftMs(t) > 100 ? 1 : 0)) * 2 ** 20];
      case p.hostMem:
        return [p.host, 0.5 + 0.02 * noise(t, 3)];
      default:
        return null;
    }
  };
  const victoria = {
    async queryRange(scope: ClusterScope, expr: string, start: number, end: number, step: number) {
      const kind = ids.get(scope.clusterId);
      const key = keyOf.get(expr);
      if (!kind || !key) return [];
      let labels: Record<string, string> | null = null;
      const points: [number, number | null][] = [];
      for (let t = start; t <= end; t += step) {
        const v = valueOf(kind, key, t * 1000);
        if (!v) return [];
        labels = v[0];
        points.push([t, v[1]]);
      }
      return labels ? [{ labels, points }] : [];
    },
  };
  const deps: AnomalyDeps = {
    db,
    systemDb: db,
    victoria,
    orgs: async () => [orgId],
    rule,
    log: { warn: (o, m) => console.warn(m, o) },
  };
  const began = Date.now();
  await runAnomalyMinute(deps, R0);
  for (let h = R0; h < R0 + days * DAY; h += HOUR) {
    if (h >= R0 + 7 * DAY) for (let m = h; m < h + HOUR; m += MIN) await runAnomalyMinute(deps, m);
    await runAnomalyHour(deps, h + HOUR + 5 * MIN);
    if ((h - R0) % DAY === 0)
      console.error(`day ${(h - R0) / DAY} (${Math.round((Date.now() - began) / 1000)} s)`);
  }

  const periods = await db
    .selectFrom('anomaly_periods')
    .select([
      'cluster_id',
      'metric',
      'started_at',
      'ended_at',
      'usual_high',
      'peak_value',
      'peak_score',
    ])
    .orderBy('started_at')
    .execute();
  const allow = parseAlertKeys(DEFAULT_ALERT_KEYS);
  // The drifts that are still unusual in the scored days (one that starts up to 30 minutes
  // before them included) and are listed before the replay ends (about 12 minutes after a
  // drift starts): every DRIFT_EVERY seconds from 03:50 UTC.
  const everyMs = DRIFT_EVERY * 1000;
  const starts: number[] = [];
  const first = R0 + 7 * DAY - 30 * MIN;
  for (
    let t = first + ((((13_800_000 - first) % everyMs) + everyMs) % everyMs);
    t + 15 * MIN <= R0 + days * DAY;
    t += everyMs
  )
    starts.push(t);
  const scored = starts.length;
  console.log(
    `\nshowcase: ${days} days from ${new Date(R0).toISOString()} (days 0–6 learn, 7–${days - 1} scored: ` +
      `${scored} drifts a platform, every ${DRIFT_EVERY / 3600} h from 03:50 UTC), past ${rule.score} for ${rule.minutes} min`,
  );
  for (const [id, kind] of ids) {
    const mine = periods.filter((p) => p.cluster_id === id);
    const alerting = mine.filter((p) => allow(p.metric));
    const byKey = new Map<string, number>();
    for (const p of mine) byKey.set(p.metric, (byKey.get(p.metric) ?? 0) + 1);
    // Each drift: its periods (listed when they last 10 minutes past the score) by key.
    const perDrift = starts.map(
      (s) => alerting.filter((p) => Math.abs(p.started_at.getTime() - s) < 30 * MIN).length,
    );
    const fmt = (ms: number) => `+${Math.round(ms / MIN)} min`;
    const p95 = mine.filter((p) => p.metric === 'workload.http.latency.p95');
    const lengths = p95.map((p) => ((p.ended_at?.getTime() ?? 0) - p.started_at.getTime()) / MIN);
    const offsets = p95.map((p) => {
      const s = starts.find((x) => Math.abs(p.started_at.getTime() - x) < 30 * MIN);
      return s === undefined ? null : p.started_at.getTime() - s;
    });
    const inDays = (t: number, from: number, to: number) =>
      t >= R0 + from * DAY && t < R0 + to * DAY;
    const week = (from: number, to: number) =>
      p95.filter((p) => inDays(p.started_at.getTime(), from, to)).length;
    const drifts = (from: number, to: number) => starts.filter((t) => inDays(t, from, to)).length;
    console.log(
      `\n== ${kind}: ${mine.length} periods; by key: ${[...byKey].map(([k, n]) => `${k} ${n}`).join(', ')}`,
    );
    console.log(
      `   anomaly alerts (default keys ${DEFAULT_ALERT_KEYS}): ${alerting.length} for ${scored} drifts; ` +
        `per drift: ${[...new Set(perDrift)].join(' or ')}; outside a drift: ${alerting.length - perDrift.reduce((a, b) => a + b, 0)}`,
    );
    console.log(
      `   p95 periods: start ${[...new Set(offsets.map((o) => (o === null ? 'outside' : fmt(o))))].join(', ')} after the drift's start; ` +
        `${Math.min(...lengths)}–${Math.max(...lengths)} min unusual (listed: 10 or more); ` +
        `usual up to ${[...new Set(p95.map((p) => `${Math.round(p.usual_high * 1000)} ms`))].slice(0, 6).join(', ')}; ` +
        `peak ${Math.round(Math.max(...p95.map((p) => p.peak_value)) * 1000)} ms`,
    );
    console.log(
      `   learned as normal? drifts listed in days 7–13: ${week(7, 14)} of ${drifts(7, 14)}, in days 14–${days - 1}: ${week(14, days)} of ${drifts(14, days)}`,
    );
  }
  await db.destroy();
}

const mode = process.argv[2];
if (mode === 'capture') await capture();
else if (mode === 'replay') await replay();
else if (mode === 'showcase') await showcase();
else {
  console.error('usage: anomaly-replay.ts capture|replay|showcase (see the header)');
  process.exit(2);
}
