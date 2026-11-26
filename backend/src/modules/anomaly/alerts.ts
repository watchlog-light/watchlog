// SPDX-License-Identifier: AGPL-3.0-only
// Anomaly alerts (ADR-200): the default rule "Unusual for this hour" (`anomaly.unusual`),
// warning, added only to orgs with What changed (Pro, and the demo, ADR-203) by the alert
// worker's default-rule upkeep. It is evaluated through the existing alert pipeline from the
// anomaly-worker's open unusual periods:
//   - one alert per subject and metric (fingerprint `anomaly:<subject>:<key>`), opened once a
//     period exists (the period has already lasted 10 minutes, ADR-196) and ended when it ends;
//   - quiet for 30 minutes after a change to the subject, its workload or Compose service: on
//     Kubernetes a rollout or an image change, on Docker a re-created container, a new image or
//     a Compose change (the change markers probable cause reads). An alert already open stays;
//     the page still lists the period during the quiet;
//   - only the keys the alert-key setting allows may alert (ADR-200's narrowing; the page
//     still lists every key), with no daily cap;
//   - no new alert while another alert (not an anomaly alert) is firing on the same subject:
//     the workload, the container or its Compose service, the monitored service, matched as
//     the baselines' exclusion matches them (exclusion.ts). The incident already has its
//     alert; the page and the alert's "What changed around it" card still list the period,
//     and the anomaly alert may open once the other alert resolves (ADR-200, slice 7b). An
//     alert already open stays.
// The labels name the subject in its platform's words, as the other rules do, so silences,
// links and probable cause read them (`node` is Docker's host).
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import type { DefaultRule } from '../alerts/defaults.js';
import type { EvalContext, RuleEvaluator } from '../alerts/engine.js';
import type { Observation, Severity } from '../alerts/state-machine.js';
import {
  ANOMALY_RULE_KEY,
  type ComposeOf,
  excluded,
  firingAlerts,
  seriesTokens,
} from './exclusion.js';
import { ownKeyParts, unitOf } from './keys.js';
import { wordsOf } from '../own-metrics/naming.js';
import { labelsOf } from './read.js';

export { ANOMALY_RULE_KEY };

/** No anomaly alert opens on a subject this long after a change to it (ADR-200). */
export const ROLLOUT_QUIET_MS = 30 * 60_000;
/** The change markers that count as a rollout of the subject (probable cause's VERSION_KINDS). */
export const QUIET_MARKER_KINDS = ['rollout', 'image', 'recreate', 'compose'] as const;

/**
 * Which keys may alert (ADR-200: "narrows which keys may alert before anything else"). A
 * comma list of patterns; `*` at the end matches any rest, `!` in front leaves keys out. The
 * default leaves the service map's edges out: they are 41 % of a Kubernetes node's scored
 * series and 31 % of a Docker host's (slice 1), the flattest of the scored kinds (connections
 * flat in 42–60 % of buckets), and a change on an edge shows on its destination's own HTTP
 * keys, which alert. The page lists edges as before.
 */
export const DEFAULT_ALERT_KEYS = '*,!edge.*';

export type KeyFilter = (key: string) => boolean;

/** Parses the alert-key setting; throws on an empty or malformed list. */
export function parseAlertKeys(raw: string | undefined): KeyFilter {
  const text = raw?.trim() || DEFAULT_ALERT_KEYS;
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Invalid WATCHLOG_ANOMALY_ALERT_KEYS: empty');
  const rx = (p: string) => {
    if (!/^[a-z0-9_.*]+$/.test(p)) throw new Error(`Invalid WATCHLOG_ANOMALY_ALERT_KEYS: ${p}`);
    return new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
  };
  const include = parts.filter((p) => !p.startsWith('!')).map(rx);
  const exclude = parts.filter((p) => p.startsWith('!')).map((p) => rx(p.slice(1)));
  return (key) => include.some((r) => r.test(key)) && !exclude.some((r) => r.test(key));
}

let alertKeys: KeyFilter = parseAlertKeys(undefined);
/** The alert worker sets the alert-key setting at start (WATCHLOG_ANOMALY_ALERT_KEYS). */
export function setAnomalyAlertKeys(filter: KeyFilter): void {
  alertKeys = filter;
}

/** Whether an org has What changed now. Off until the alert worker sets it (Community: never). */
let gate: (orgId: string) => Promise<boolean> = async () => false;
export function setAnomalyGate(fn: (orgId: string) => Promise<boolean>): void {
  gate = fn;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tuesday", "14:00": an hour-of-week bucket (UTC) in words. */
export function bucketWords(bucket: number): { day: string; hour: string } {
  const b = ((Math.trunc(bucket) % 168) + 168) % 168;
  return { day: DAYS[Math.floor(b / 24)]!, hour: `${String(b % 24).padStart(2, '0')}:00` };
}

/** What each scored key reads as in a message ("p95 response time", "connections to db"). */
const KEY_WORDS: Record<string, string> = {
  'node.cpu.utilization': 'CPU',
  'node.memory.utilization': 'memory',
  'node.network.bytes': 'network',
  'node.disk.io': 'disk I/O',
  'host.cpu.utilization': 'CPU',
  'host.memory.utilization': 'memory',
  'host.network.bytes': 'network',
  'host.disk.io': 'disk I/O',
  'workload.cpu.usage': 'CPU',
  'workload.memory.working_set': 'memory',
  'container.cpu.usage': 'CPU',
  'container.memory.working_set': 'memory',
  'container.network.bytes': 'network',
  'workload.http.requests.rate': 'requests',
  'workload.http.errors.ratio': 'errors',
  'workload.http.latency.p95': 'p95 response time',
  'edge.connections.rate': 'connections to {peer}',
  'edge.http.requests.rate': 'requests to {peer}',
  'edge.http.latency.p95': 'p95 of calls to {peer}',
};

export function metricWords(key: string, peer?: string | null): string {
  // A watched own metric: a few words from its name ("orders created").
  const own = ownKeyParts(key);
  if (own) return wordsOf(own.name).toLowerCase();
  const w = KEY_WORDS[key];
  if (w) return w.replace('{peer}', peer ?? '?');
  // An integration's key: "redis.ops.rate" → "ops rate".
  return key.split('.').slice(1).join(' ').replace(/_/g, ' ') || key;
}

const UNITS: Record<string, (v: number) => [string, string]> = {
  ratio: (v) => [String(Math.round(v * 1000) / 10), '%'],
  bytes: (v) =>
    v >= 2 ** 30
      ? [(v / 2 ** 30).toFixed(2), 'GiB']
      : v >= 2 ** 20
        ? [String(Math.round(v / 2 ** 20)), 'MiB']
        : [String(Math.round(v / 2 ** 10)), 'KiB'],
  bytes_per_second: (v) =>
    v >= 2 ** 20 ? [(v / 2 ** 20).toFixed(1), 'MiB/s'] : [String(Math.round(v / 2 ** 10)), 'KiB/s'],
  cores: (v) => [v < 0.1 ? v.toFixed(3) : v.toFixed(2), 'cores'],
  seconds: (v) =>
    v < 1 ? [String(Math.round(v * 1000)), 'ms'] : [String(Math.round(v * 10) / 10), 's'],
  per_second: (v) => [String(v < 10 ? Math.round(v * 100) / 100 : Math.round(v)), '/s'],
};

function parts(v: number, unit: string): [string, string] {
  return UNITS[unit]?.(v) ?? [String(Math.round(v * 100) / 100), ''];
}
const glue = ([n, u]: [string, string]) => (!u ? n : u.startsWith('/') ? `${n}${u}` : `${n} ${u}`);

/** "2.4 s", "512 MiB", "35 %", "0.25 cores". */
export function valueWords(v: number, unit: string): string {
  return glue(parts(v, unit));
}

/** "120–180 ms": the unit once when both ends share it. */
export function rangeWords(low: number, high: number, unit: string): string {
  const a = parts(low, unit);
  const b = parts(high, unit);
  if (a[0] === b[0] && a[1] === b[1]) return glue(a);
  if (a[1] === b[1]) return glue([`${a[0]}–${b[0]}`, b[1]]);
  return `${glue(a)}–${glue(b)}`;
}

/** Containers of a Docker fleet: host, Compose project and service, by container name. */
type Containers = Map<string, { host: string; project: string | null; service: string | null }>;

/** The containers' Compose project and service, as the exclusion reads them. */
function composeOfContainers(containers: Containers): ComposeOf {
  const out: ComposeOf = new Map();
  for (const [name, c] of containers) {
    if (c.project && c.service) out.set(name, { project: c.project, service: c.service });
  }
  return out;
}

async function containersOf(db: Database, clusterId: string): Promise<Containers> {
  const rows = await db
    .selectFrom('objects')
    .select(['name', 'node', 'namespace', 'spec_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', '=', 'DockerContainer')
    .where('deleted_at', 'is', null)
    .execute();
  const out: Containers = new Map();
  for (const r of rows) {
    const svc = (r.spec_summary as { compose_service?: string } | null)?.compose_service;
    out.set(r.name, { host: r.node, project: r.namespace || null, service: svc ?? null });
  }
  return out;
}

/**
 * An unusual series' alert labels, in its platform's words: a Kubernetes workload
 * (`namespace, workload_kind, workload`) or node; a Docker container (`node` = its host,
 * `container`, with its Compose project and service) or host (`node`); a monitored service
 * (`service`, `service_type`); a map edge keeps its source and destination labels. `metric`
 * is the key, so a silence can name it.
 */
export function anomalyLabels(
  kind: 'kubernetes' | 'server',
  key: string,
  subject: Record<string, string>,
  containers: Containers = new Map(),
): Record<string, string> {
  const l = subject;
  const out: Record<string, string> = {};
  const container = (name: string, host?: string) => {
    const c = containers.get(name);
    const h = host ?? c?.host;
    if (h) out.node = h;
    out.container = name;
    if (c?.project && c.service) {
      out.compose_project = c.project;
      out.compose_service = c.service;
    }
  };
  if (key.startsWith('workload.http.')) {
    if (l.dst_kind === 'container' && l.dst) container(l.dst);
    else {
      if (l.dst_namespace) out.namespace = l.dst_namespace;
      if (l.dst_workload_kind) out.workload_kind = l.dst_workload_kind;
      out.workload = l.dst_workload ?? l.dst ?? '';
    }
  } else if (key.startsWith('edge.')) {
    for (const [k, v] of Object.entries(l)) out[k === 'host' ? 'node' : k] = v;
  } else if (key.startsWith('node.')) out.node = l.node ?? '';
  else if (key.startsWith('host.')) out.node = l.host ?? '';
  else if (key.startsWith('workload.')) {
    out.namespace = l.namespace ?? '';
    out.workload_kind = l.workload_kind ?? '';
    out.workload = l.workload ?? '';
  } else if (key.startsWith('container.')) container(l.container ?? '', l.host);
  else {
    // An integration's series: the collector labels them service=<integration id>.
    if (l.service) out.service = l.service;
    if (l.service_type) out.service_type = l.service_type;
  }
  if (kind === 'server' && out.container && !out.compose_service && l.compose_service) {
    out.compose_project = l.compose_project ?? '';
    out.compose_service = l.compose_service;
  }
  out.metric = key;
  return out;
}

/** `anomaly:<subject>:<key>`: the subject's label values, by label name (jsonb reorders). */
export function anomalyFingerprint(key: string, subject: Record<string, string>): string {
  const values = Object.keys(subject)
    .sort()
    .map((k) => subject[k]);
  return `anomaly:${values.join('/')}:${key}`;
}

/** The change-marker targets that quiet a subject's alert (ADR-200), as target patterns. */
export function quietTargets(
  kind: 'kubernetes' | 'server',
  labels: Record<string, string>,
  containers: Containers,
): { exact: Set<string>; containerNames: Set<string>; projects: Set<string> } {
  const exact = new Set<string>();
  const containerNames = new Set<string>();
  const projects = new Set<string>();
  if (kind === 'kubernetes') {
    if (labels.namespace && labels.workload_kind && labels.workload) {
      exact.add(`${labels.workload_kind}/${labels.namespace}/${labels.workload}`);
    }
    // An edge's destination workload: its rollout moves the edge too.
    if (labels.dst_namespace && labels.dst_workload_kind && labels.dst_workload) {
      exact.add(`${labels.dst_workload_kind}/${labels.dst_namespace}/${labels.dst_workload}`);
    }
    return { exact, containerNames, projects };
  }
  const name = labels.container;
  if (name) {
    containerNames.add(name);
    // The other containers of its Compose service (a scaled service re-creates them all).
    const own = containers.get(name);
    const service = labels.compose_service ?? own?.service;
    const project = labels.compose_project ?? own?.project;
    if (project) projects.add(project);
    if (project && service) {
      for (const [n, c] of containers) {
        if (c.project === project && c.service === service) containerNames.add(n);
      }
    }
  }
  return { exact, containerNames, projects };
}

interface Marker {
  target: string;
  ts: Date;
}

/** Whether a change to the subject came within the quiet before `now` (ADR-200). */
export function inQuiet(
  kind: 'kubernetes' | 'server',
  labels: Record<string, string>,
  containers: Containers,
  markers: Marker[],
): boolean {
  if (!markers.length) return false;
  const t = quietTargets(kind, labels, containers);
  return markers.some((m) => {
    if (t.exact.has(m.target)) return true;
    const [k, , ...rest] = m.target.split('/');
    const last = rest.join('/');
    if (k === 'Container') return t.containerNames.has(last);
    if (k === 'Compose') return t.projects.has(last);
    return false;
  });
}

/** The integrations' names and types, by id (a monitored service's alert names it). */
async function servicesOf(db: Database, clusterId: string) {
  const rows = await db
    .selectFrom('integrations')
    .select(['id', 'name', 'type'])
    .where('cluster_id', '=', clusterId)
    .execute();
  return new Map(rows.map((r) => [r.id, { name: r.name, type: r.type }]));
}

/** "checkout (shop)", "node worker-1", "web (shop)", "host docker-01", "Redis cache". */
export function subjectWords(labels: Record<string, string>, serviceName?: string | null): string {
  const l = labels;
  if (l.service_type || l.service) {
    return serviceName ?? l.service_name ?? l.service ?? l.service_type ?? '';
  }
  if (l.workload) return l.namespace ? `${l.workload} (${l.namespace})` : l.workload;
  if (l.compose_service) {
    return l.compose_project ? `${l.compose_service} (${l.compose_project})` : l.compose_service;
  }
  if (l.container) return l.container;
  if (l.node) return l.metric?.startsWith('host.') ? `host ${l.node}` : `node ${l.node}`;
  return Object.values(l).filter((v) => v !== l.metric)[0] ?? '';
}

/** An edge's destination, as the map names it. */
function peerOf(labels: Record<string, string>, containers: Containers): string | null {
  if (!labels.metric?.startsWith('edge.')) return null;
  const dstService = labels.dst ? containers.get(labels.dst)?.service : undefined;
  return labels.dst_workload ?? labels.dst_service ?? dstService ?? labels.dst ?? null;
}

const anomalyEvaluator: RuleEvaluator = {
  kinds: ['kubernetes', 'server'],
  async evaluate(ctx: EvalContext): Promise<Observation[]> {
    const orgId = ctx.rule.org_id;
    // Only orgs with What changed (ADR-195): a downgrade's open alerts end with the upkeep.
    if (!(await ctx.memo(`anomaly-gate:${orgId}`, () => gate(orgId)))) return [];
    const periods = await ctx.db
      .selectFrom('anomaly_periods')
      .select([
        'id',
        'metric',
        'subject',
        'started_at',
        'bucket',
        'median',
        'usual_low',
        'usual_high',
        'peak_score',
        'peak_value',
        'peak_at',
        'last_value',
      ])
      .where('cluster_id', '=', ctx.cluster.id)
      .where('ended_at', 'is', null)
      .orderBy('started_at')
      .execute();
    const allowed = periods.filter((p) => alertKeys(p.metric));
    if (!allowed.length) return [];
    const kind = ctx.cluster.kind;
    const [open, markers, containers, services] = await Promise.all([
      ctx.db
        .selectFrom('alert_states')
        .select('fingerprint')
        .where('rule_id', '=', ctx.rule.id)
        .where('cluster_id', '=', ctx.cluster.id)
        .where('state', '<>', 'resolved')
        .execute()
        .then((rows) => new Set(rows.map((r) => r.fingerprint))),
      ctx.db
        .selectFrom('change_markers')
        .select(['target', 'ts'])
        .where('cluster_id', '=', ctx.cluster.id)
        .where('kind', 'in', [...QUIET_MARKER_KINDS])
        .where('ts', '>', new Date(ctx.now - ROLLOUT_QUIET_MS))
        .execute(),
      kind === 'server' ? containersOf(ctx.db, ctx.cluster.id) : Promise.resolve(new Map()),
      servicesOf(ctx.db, ctx.cluster.id),
    ]);
    // The other alerts firing now on the cluster (slice 7b): read only when a new alert
    // could open, as the baselines' exclusion reads them (from the condition's start).
    const composeOf = composeOfContainers(containers as Containers);
    const firing = allowed.some((p) => !open.has(anomalyFingerprint(p.metric, labelsOf(p.subject))))
      ? await firingAlerts(ctx.db, kind, ctx.cluster.id, ctx.now, ctx.now + 1, composeOf)
      : [];
    const out: Observation[] = [];
    for (const p of allowed) {
      const subject = labelsOf(p.subject);
      const fingerprint = anomalyFingerprint(p.metric, subject);
      const labels = anomalyLabels(kind, p.metric, subject, containers as Containers);
      if (!open.has(fingerprint)) {
        // Quiet after a rollout: a new alert waits; one already open stays (ADR-200).
        if (inQuiet(kind, labels, containers as Containers, markers)) continue;
        // Another alert already firing on the subject: it is the incident's alert (slice 7b).
        if (excluded(ctx.now, seriesTokens(kind, subject, composeOf), firing)) continue;
      }
      const svc = labels.service ? services.get(labels.service) : undefined;
      if (svc) labels.service_name = svc.name;
      const words = subjectWords(labels, svc?.name);
      // A container's alert is about the container on its host (the message's "where"); its
      // Compose service names it in the title and stays in the details.
      const compose =
        labels.container && labels.compose_service
          ? { project: labels.compose_project ?? '', service: labels.compose_service }
          : null;
      if (labels.container) {
        delete labels.compose_project;
        delete labels.compose_service;
      }
      out.push({
        fingerprint,
        severity: ctx.rule.severity as Severity,
        labels,
        details: {
          ...(compose ? { compose } : {}),
          key: p.metric,
          unit: unitOf(p.metric),
          period: p.id,
          bucket: p.bucket,
          median: p.median,
          usualLow: p.usual_low,
          usualHigh: p.usual_high,
          value: p.last_value,
          peakValue: p.peak_value,
          peakScore: Math.round(p.peak_score * 10) / 10,
          peer: peerOf(labels, containers as Containers),
          subject: words,
        },
        since: p.started_at.getTime(),
      });
    }
    return out;
  },
};

/** The default rule (ADR-200), added only for orgs with What changed (`ensureAnomalyRule`). */
export const ANOMALY_RULE: DefaultRule = {
  key: ANOMALY_RULE_KEY,
  name: 'Unusual for this hour',
  severity: 'warning',
  forSeconds: 0,
  evaluator: anomalyEvaluator,
};

/**
 * The anomaly rule's upkeep, each cycle beside the other defaults (ADR-084, ADR-200, ADR-204):
 * an org with What changed gets the rule (enabled, no channels) the first time, and gets it
 * back on if the upkeep had turned it off for a downgrade; an org without it keeps no running
 * rule: an existing one is turned off (its open alerts end without a message, as for every
 * disabled rule) and marked, so Pro again turns it back on. Orgs that never had Pro never get
 * the row.
 */
export async function ensureAnomalyRule(
  db: Database,
  orgId: string,
  entitled: boolean,
): Promise<void> {
  if (entitled) {
    await db
      .insertInto('alert_rules')
      .values({
        id: newId(),
        org_id: orgId,
        name: ANOMALY_RULE.name,
        type: 'default',
        rule_key: ANOMALY_RULE.key,
        metric: null,
        condition: JSON.stringify({}),
        for_seconds: ANOMALY_RULE.forSeconds,
        severity: ANOMALY_RULE.severity,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'rule_key']).where('rule_key', 'is not', null).doNothing(),
      )
      .execute();
    await db
      .updateTable('alert_rules')
      .set({ enabled: true, plan_paused: false })
      .where('org_id', '=', orgId)
      .where('rule_key', '=', ANOMALY_RULE_KEY)
      .where('plan_paused', '=', true)
      .execute();
    return;
  }
  await db
    .updateTable('alert_rules')
    .set({ enabled: false, plan_paused: true })
    .where('org_id', '=', orgId)
    .where('rule_key', '=', ANOMALY_RULE_KEY)
    .where('enabled', '=', true)
    .execute();
}
