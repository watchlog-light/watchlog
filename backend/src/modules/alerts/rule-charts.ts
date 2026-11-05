// SPDX-License-Identifier: AGPL-3.0-only
// What each rule charts (alert detail page and the rule editor's preview), next to the
// rule catalog (defaults.ts, metric-rules.ts). Metric and custom threshold rules chart
// their own metric with the warning and critical thresholds. State rules have no
// threshold metric, so each has a defined chart:
//
//   crash loop / Docker restarting  restart count (step line) + CPU and memory
//   OOMKilled                       memory working set, the limit as the threshold line,
//                                   OOM kills as markers
//   node NotReady / pressure        node condition timeline + CPU and memory
//   Pending / ImagePull             phase timeline of the affected pods
//   Deployment unavailable          desired vs ready replicas (two step lines)
//   Docker unhealthy                health check results (✓/✕ strip) + CPU and memory
//   agent / cluster not reporting   samples received per minute, the silent gap marked
//
// Every query is scoped to the alert's object (node, pod, workload, container), one
// series per object, at most MAX_SERIES with the rest counted.
import type { QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import {
  buildQuery,
  chooseStep,
  metricUnit,
  selector,
  type MetricKey,
  type QueryScope,
  type Unit,
} from '../query/catalog.js';
import type { Condition } from './defaults.js';

export const MAX_SERIES = 10;

export type PanelId =
  | 'metric'
  | 'restarts'
  | 'cpu'
  | 'memory'
  | 'conditions'
  | 'phases'
  | 'replicas'
  | 'health'
  | 'samples';
export type Tone = 'ok' | 'warning' | 'critical' | 'neutral';

export interface ChartLine {
  name: string;
  /** [unix seconds, value]; a missing step is null, so gaps stay gaps. */
  points: [number, number | null][];
  /** Drawn as steps (counts, replicas). */
  step?: boolean;
}
export interface ChartThreshold {
  kind: 'warning' | 'critical' | 'limit';
  value: number;
}
export interface BandSegment {
  from: number;
  to: number;
  state: string;
  tone: Tone;
}
export interface BandRow {
  name: string;
  segments: BandSegment[];
}
export interface ChartPanel {
  id: PanelId;
  kind: 'line' | 'bands';
  /** The catalog metric of a `metric` panel. */
  metric: string | null;
  unit: Unit | null;
  lines: ChartLine[];
  thresholds: ChartThreshold[];
  rows: BandRow[];
  /** Objects beyond MAX_SERIES ("and N more"). */
  more: number;
}
export interface ChartMark {
  ts: number;
  kind: 'oom' | 'lastData';
}

/** What a chart is about: the alert's rule, object and thresholds. */
export interface ChartTarget {
  ruleKey: string | null;
  /** The catalog metric for this cluster kind (default metric rules and custom rules). */
  metric: string | null;
  clusterKind: 'kubernetes' | 'docker';
  labels: Record<string, string>;
  details: Record<string, unknown>;
  condition: Condition | null;
  severity: string;
}

export interface ChartRange {
  victoria: VictoriaQueryClient;
  clusterId: string;
  from: number;
  to: number;
}

interface Ctx extends ChartRange {
  step: number;
  range(expr: string, step?: number): Promise<QuerySeries[]>;
}

export interface ChartResult {
  panels: ChartPanel[];
  marks: ChartMark[];
  /** Agent rules: from the last data until it came back (or the window's end). */
  silent: { from: number; to: number } | null;
}

// ------------------------------------------------------------------ helpers

/** Labels that say where a series is, in the order a chart names it. */
const NAME_ORDER = ['node', 'host', 'namespace', 'workload', 'pod', 'container'];

/** "watchlog-worker2 · /var": where first, then the rest in the series' order. */
export function seriesName(labels: Record<string, string>, fallback = ''): string {
  const rank = (k: string) => {
    const i = NAME_ORDER.indexOf(k);
    return i < 0 ? NAME_ORDER.length : i;
  };
  return (
    Object.entries(labels)
      .filter(([k]) => k !== '__name__' && k !== 'cluster_id')
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([, v]) => v)
      .join(' · ') || fallback
  );
}

/** Points on every step of [from, to]; steps without a value become null. */
export function densify(
  points: [number, number | null][],
  from: number,
  to: number,
  step: number,
): [number, number | null][] {
  const at = new Map(points.map(([t, v]) => [Math.round(t), v]));
  const out: [number, number | null][] = [];
  const first = Math.ceil(from / step) * step;
  for (let t = first; t <= to; t += step) out.push([t, at.get(t) ?? null]);
  return out;
}

const peak = (s: QuerySeries) => Math.max(-Infinity, ...s.points.map(([, v]) => v ?? -Infinity));

/** The MAX_SERIES busiest series as lines; the rest are counted. */
function lines(
  c: Ctx,
  series: QuerySeries[],
  opts: { step?: boolean; name?: (l: Record<string, string>) => string } = {},
): { lines: ChartLine[]; more: number } {
  const sorted = [...series].sort((a, b) => peak(b) - peak(a));
  return {
    lines: sorted.slice(0, MAX_SERIES).map((s) => ({
      name: opts.name?.(s.labels) ?? seriesName(s.labels, 'total'),
      points: densify(s.points, c.from, c.to, c.step),
      ...(opts.step ? { step: true } : {}),
    })),
    more: Math.max(0, sorted.length - MAX_SERIES),
  };
}

function linePanel(
  id: PanelId,
  unit: Unit | null,
  l: { lines: ChartLine[]; more: number },
  extra: Partial<ChartPanel> = {},
): ChartPanel {
  return { id, kind: 'line', metric: null, unit, thresholds: [], rows: [], ...l, ...extra };
}

/**
 * Timelines from "one series per state" metrics (pod phase, node condition, health):
 * only the current state has a series, so at each step the state whose last sample is
 * newest wins (the query returns tlast_over_time per state).
 */
export function bandRows(
  series: QuerySeries[],
  row: (l: Record<string, string>) => string,
  state: (l: Record<string, string>) => string,
  tone: (row: string, state: string) => Tone,
  step: number,
  order?: string[],
): BandRow[] {
  const byRow = new Map<string, Map<number, { state: string; at: number }>>();
  for (const s of series) {
    const r = row(s.labels);
    const st = state(s.labels);
    const steps = byRow.get(r) ?? new Map<number, { state: string; at: number }>();
    byRow.set(r, steps);
    for (const [t, v] of s.points) {
      if (v === null) continue;
      const cur = steps.get(t);
      if (!cur || v > cur.at) steps.set(t, { state: st, at: v });
    }
  }
  const rows: BandRow[] = [];
  for (const [name, steps] of byRow) {
    const segments: BandSegment[] = [];
    for (const t of [...steps.keys()].sort((a, b) => a - b)) {
      const st = steps.get(t)!.state;
      const last = segments.at(-1);
      // Contiguous steps of one state are one segment; a missing step breaks it.
      if (last && last.state === st && t - last.to <= step) last.to = t + step;
      else segments.push({ from: t, to: t + step, state: st, tone: tone(name, st) });
    }
    rows.push({ name, segments });
  }
  const rank = (n: string) => (order?.includes(n) ? order.indexOf(n) : (order?.length ?? 0));
  return rows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The query scope of an alert's object, from its labels and facts. */
export function objectScope(t: ChartTarget): QueryScope {
  const l = t.labels;
  if (t.clusterKind === 'docker') {
    return {
      ...(l.node ? { host: l.node } : {}),
      ...(l.container ? { container: l.container } : {}),
    };
  }
  const s: QueryScope = {};
  if (l.namespace) s.namespace = l.namespace;
  const pods = Array.isArray(t.details.pods)
    ? (t.details.pods as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  if (l.workload) {
    s.workload = l.workload;
    if (l.workload_kind) s.workloadKind = l.workload_kind;
    if (pods.length) s.pods = pods;
  } else if (l.pod) {
    s.pod = l.pod;
  }
  if (!l.namespace && l.node) s.node = l.node;
  return s;
}

/** Labels a catalog query cannot scope by, compared on the result (mount, PVC). */
function sameObject(t: ChartTarget, series: Record<string, string>): boolean {
  const l = t.labels;
  // Flow alerts: the same destination (Phase 4).
  for (const k of ['dst_kind', 'dst_namespace', 'dst_workload', 'dst_service', 'dst']) {
    if (l[k] !== undefined && series[k] !== undefined && series[k] !== l[k]) return false;
  }
  if (l.mount !== undefined && series.mount !== undefined && series.mount !== l.mount) return false;
  if (l.pvc !== undefined && series.persistentvolumeclaim !== l.pvc) return false;
  if (
    l.container !== undefined &&
    series.container !== undefined &&
    series.container !== l.container
  )
    return false;
  return true;
}

export function thresholdsOf(cond: Condition | null, severity: string): ChartThreshold[] {
  if (!cond) return [];
  const out: ChartThreshold[] = [
    {
      kind: severity === 'critical' && cond.critical === undefined ? 'critical' : 'warning',
      value: cond.value,
    },
  ];
  if (cond.critical !== undefined) out.push({ kind: 'critical', value: cond.critical });
  return out;
}

async function catalogPanel(
  c: Ctx,
  id: PanelId,
  key: MetricKey,
  scope: QueryScope,
  opts: { step?: boolean; filter?: (l: Record<string, string>) => boolean } = {},
): Promise<ChartPanel> {
  const { expr, unit } = buildQuery(key, scope, c.step);
  const series = (await c.range(expr)).filter((s) => opts.filter?.(s.labels) ?? true);
  return linePanel(id, unit, lines(c, series, { step: opts.step }));
}

const k8s = (t: ChartTarget) => t.clusterKind === 'kubernetes';

/** CPU and memory of the alert's pods, Docker container or node. */
async function cpuMemory(c: Ctx, t: ChartTarget): Promise<ChartPanel[]> {
  const scope = objectScope(t);
  const l = t.labels;
  let keys: [MetricKey, MetricKey];
  if (!k8s(t)) keys = ['container.cpu.usage', 'container.memory.working_set'];
  else if (!l.namespace && l.node) keys = ['node.cpu.utilization', 'node.memory.utilization'];
  else keys = ['pod.cpu.usage', 'pod.memory.working_set'];
  return Promise.all([
    catalogPanel(c, 'cpu', keys[0], scope),
    catalogPanel(c, 'memory', keys[1], scope),
  ]);
}

// ------------------------------------------------------------------ definitions

type Definition = (
  c: Ctx,
  t: ChartTarget,
) => Promise<Omit<ChartResult, 'silent'> & { silent?: ChartResult['silent'] }>;

const PHASE_TONE: Record<string, Tone> = {
  Running: 'ok',
  Succeeded: 'ok',
  Pending: 'warning',
  ContainerCreating: 'warning',
  PodInitializing: 'warning',
};
const phaseTone = (_row: string, state: string): Tone => PHASE_TONE[state] ?? 'critical';

/** Window of tlast_over_time: at least a minute, so a 15 s scrape is never missed. */
const lastWindow = (c: Ctx) => `${Math.max(60, c.step)}s`;

/** The last heartbeat of a silent agent, also from summaries written before lastSeen. */
export function lastSeenOf(details: Record<string, unknown>): number | null {
  const raw =
    typeof details.lastSeen === 'string'
      ? details.lastSeen
      : typeof details.summary === 'string'
        ? (/\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(details.summary)?.[0] ?? null)
        : null;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const restartsAndUsage: Definition = async (c, t) => {
  const scope = objectScope(t);
  const [restarts, usage] = await Promise.all([
    k8s(t)
      ? catalogPanel(c, 'restarts', 'pod.restarts', scope, { step: true })
      : catalogPanel(c, 'restarts', 'container.restarts', scope, { step: true }),
    cpuMemory(c, t),
  ]);
  return { panels: [restarts, ...usage], marks: [] };
};

export const RULE_CHARTS: Record<string, Definition> = {
  'k8s.pod.crashloop': restartsAndUsage,

  'k8s.container.oomkilled': async (c, t) => {
    const container = typeof t.details.container === 'string' ? t.details.container : undefined;
    const scope = { ...objectScope(t), ...(container ? { container } : {}) };
    const sel = selector(scope);
    const [memory, limit, kills] = await Promise.all([
      catalogPanel(c, 'memory', 'pod.container.memory.working_set', scope),
      c.range(buildQuery('pod.container.memory.limit', scope, c.step).expr),
      // A restart while the last termination says OOMKilled is an OOM kill.
      c.range(
        `sum(increase(watchlog_kube_pod_container_restarts_total${sel}[${c.step}s]) > 0 ` +
          `and on (namespace, pod, container) watchlog_kube_pod_container_last_termination_reason${selector(scope, 'reason="OOMKilled"')})`,
      ),
    ]);
    const limits = limit.flatMap((s) => s.points.map(([, v]) => v)).filter((v) => v !== null);
    if (limits.length)
      memory.thresholds = [{ kind: 'limit', value: Math.min(...(limits as number[])) }];
    const marks = (kills[0]?.points ?? [])
      .filter(([, v]) => v !== null && v > 0)
      .map(([ts]) => ({ ts, kind: 'oom' as const }));
    return { panels: [memory], marks };
  },

  'k8s.node.notready': nodeConditions,
  'k8s.node.pressure': nodeConditions,

  'k8s.pod.pending': podPhases,
  'k8s.pod.imagepull': podPhases,

  'k8s.deployment.unavailable': async (c, t) => {
    const l = t.labels;
    const sel = selector(
      { namespace: l.namespace, workload: l.workload },
      'state=~"desired|ready"',
    );
    const series = await c.range(`max by (state) (watchlog_kube_deployment_replicas${sel})`);
    const panel = linePanel(
      'replicas',
      'count',
      lines(c, series, { step: true, name: (s) => s.state ?? '' }),
    );
    // Desired first, then ready, whatever their values.
    panel.lines.sort((a, b) => (a.name === 'desired' ? -1 : b.name === 'desired' ? 1 : 0));
    return { panels: [panel], marks: [] };
  },

  'docker.container.unhealthy': async (c, t) => {
    const scope = objectScope(t);
    const [health, usage] = await Promise.all([
      c.range(
        `max by (status) (tlast_over_time(watchlog_container_health${selector(scope)}[${lastWindow(c)}]))`,
      ),
      cpuMemory(c, t),
    ]);
    const rows = bandRows(
      health,
      () => t.labels.container ?? '',
      (l) => l.status ?? 'unknown',
      (_r, s) => (s === 'healthy' ? 'ok' : s === 'unhealthy' ? 'critical' : 'neutral'),
      c.step,
    );
    return {
      panels: [
        { ...linePanel('health', null, { lines: [], more: 0 }), kind: 'bands', rows },
        ...usage,
      ],
      marks: [],
    };
  },

  'agent.not_reporting': async (c, t) => {
    const l = t.labels;
    // The cluster-agent's own series carry neither node nor host.
    const sel =
      l.agent === 'cluster'
        ? selector({}, 'node=""', 'host=""')
        : l.agent === 'node'
          ? selector({ node: l.node })
          : l.agent === 'docker'
            ? selector({ host: l.node })
            : selector({});
    // Each scrape reports how many series the agent sends: summed over a minute, that
    // is the samples it delivered per minute.
    const step = Math.max(60, c.step);
    const series = await c.range(
      `sum by (node, host) (sum_over_time(watchlog_agent_series${sel}[${step}s])) / ${step / 60}`,
      step,
    );
    const wide = { ...c, step };
    const panel = linePanel(
      'samples',
      'count',
      lines(wide, series, { name: (s) => s.node || s.host || 'cluster-agent' }),
    );
    const seen = lastSeenOf(t.details);
    return {
      panels: [panel],
      marks: seen ? [{ ts: seen, kind: 'lastData' }] : [],
      silent: seen ? { from: seen, to: c.to } : null,
    };
  },

  'docker.container.restarts': async (c, t) => {
    const [metric, usage] = await Promise.all([metricPanel(c, t, { step: true }), cpuMemory(c, t)]);
    return { panels: [metric, ...usage], marks: [] };
  },
};

async function nodeConditions(c: Ctx, t: ChartTarget) {
  const node = t.labels.node ?? '';
  const [cond, usage] = await Promise.all([
    c.range(
      `max by (condition, status) (tlast_over_time(watchlog_kube_node_condition${selector({ node })}[${lastWindow(c)}]))`,
    ),
    cpuMemory(c, t),
  ]);
  const rows = bandRows(
    cond,
    (l) => l.condition ?? '',
    (l) => (l.status === 'true' ? 'True' : l.status === 'false' ? 'False' : 'Unknown'),
    (row, state) =>
      state === 'Unknown'
        ? 'neutral'
        : (row === 'Ready') === (state === 'True')
          ? 'ok'
          : 'critical',
    c.step,
    ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure'],
  );
  return {
    panels: [
      { ...linePanel('conditions', null, { lines: [], more: 0 }), kind: 'bands' as const, rows },
      ...usage,
    ],
    marks: [],
  };
}

async function podPhases(c: Ctx, t: ChartTarget) {
  const sel = selector(objectScope(t));
  const w = lastWindow(c);
  const [phases, waiting] = await Promise.all([
    c.range(`max by (pod, phase) (tlast_over_time(watchlog_kube_pod_status_phase${sel}[${w}]))`),
    c.range(
      `max by (pod, reason) (tlast_over_time(watchlog_kube_pod_container_status_waiting_reason${sel}[${w}]))`,
    ),
  ]);
  // A waiting reason (ImagePullBackOff, ContainerCreating) says more than "Pending":
  // it wins at the steps where it has a sample.
  const lift = waiting.map((s) => ({
    labels: { pod: s.labels.pod ?? '', phase: s.labels.reason ?? '' },
    points: s.points.map(([ts, v]) => [ts, v === null ? null : v + 1e9] as [number, number | null]),
  }));
  const rows = bandRows(
    [...phases, ...lift],
    (l) => l.pod ?? '',
    (l) => l.phase ?? '',
    phaseTone,
    c.step,
  );
  const shown = rows.slice(0, MAX_SERIES);
  return {
    panels: [
      {
        ...linePanel('phases', null, { lines: [], more: Math.max(0, rows.length - MAX_SERIES) }),
        kind: 'bands' as const,
        rows: shown,
      },
    ],
    marks: [],
  };
}

/** The rule's own metric, scoped to the alert's object, with its thresholds. */
async function metricPanel(
  c: Ctx,
  t: ChartTarget,
  opts: { step?: boolean } = {},
): Promise<ChartPanel> {
  const key = t.metric as MetricKey;
  const panel = await catalogPanel(c, 'metric', key, objectScope(t), {
    step: opts.step,
    filter: (l) => sameObject(t, l),
  });
  return {
    ...panel,
    metric: key,
    unit: metricUnit(key),
    thresholds: thresholdsOf(t.condition, t.severity),
  };
}

/** The chart of one alert's object over [from, to]. */
export async function ruleChart(r: ChartRange, t: ChartTarget): Promise<ChartResult> {
  const step = chooseStep(r.to - r.from);
  const c: Ctx = {
    ...r,
    step,
    range: (expr, s = step) =>
      r.victoria.queryRange({ clusterId: r.clusterId }, expr, r.from, r.to, s),
  };
  const def = t.ruleKey ? RULE_CHARTS[t.ruleKey] : undefined;
  if (def) {
    const res = await def(c, t);
    return { silent: null, ...res };
  }
  if (t.metric && metricUnit(t.metric)) {
    return { panels: [await metricPanel(c, t)], marks: [], silent: null };
  }
  return { panels: [], marks: [], silent: null };
}
