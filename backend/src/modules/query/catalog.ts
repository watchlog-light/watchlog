// SPDX-License-Identifier: AGPL-3.0-only
// Curated metrics for POST /query/range (ADR-028). Templates are fixed MetricsQL;
// user input only ever becomes escaped label values. cluster_id is enforced by
// VictoriaMetrics (extra_label), never by these templates.

export type Unit = 'ratio' | 'bytes' | 'bytes_per_second' | 'cores' | 'load' | 'count';
export type Agg = 'sum' | 'avg' | 'max' | 'min';

export interface QueryScope {
  host?: string;
  container?: string;
  composeProject?: string;
  /** Kubernetes scope (ADR-062): node agents label host series with `node`. */
  node?: string;
  namespace?: string;
  /** Namespace filter of the top bar (any of these). */
  namespaces?: string[];
  pod?: string;
  workloadKind?: string;
  workload?: string;
  /** Exactly these pods (a resolved label selector, ADR-085). */
  pods?: string[];
}

interface Entry {
  unit: Unit;
  /** Aggregation used when the request does not choose one. */
  agg: Agg;
  expr: (sel: (...extra: string[]) => string, rate: string, agg: Agg) => string;
}

const ENTRIES = {
  'host.cpu.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host) (rate(watchlog_node_cpu_seconds_total${s('mode!="idle"')}[${r}])) / ${a} by (host) (rate(watchlog_node_cpu_seconds_total${s()}[${r}]))`,
  },
  'host.memory.used': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (host) (watchlog_node_memory_bytes${s('state="total"')}) - ${a} by (host) (watchlog_node_memory_bytes${s('state="available"')})`,
  },
  'host.memory.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, _r, a) =>
      `1 - ${a} by (host) (watchlog_node_memory_bytes${s('state="available"')}) / ${a} by (host) (watchlog_node_memory_bytes${s('state="total"')})`,
  },
  'host.load1': {
    unit: 'load',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host) (watchlog_node_load1${s()})`,
  },
  'host.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (host, dir) (rate(watchlog_node_network_bytes_total${s()}[${r}]))`,
  },
  'host.disk.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (host, dir) (rate(watchlog_node_disk_io_bytes_total${s()}[${r}]))`,
  },
  'host.filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (host, mount) (watchlog_node_filesystem_bytes${s('state="avail"')}) / ${a} by (host, mount) (watchlog_node_filesystem_bytes${s('state="size"')})`,
  },
  'host.root_filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (host) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="avail"')}) / ${a} by (host) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="size"')})`,
  },
  'container.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container) (rate(watchlog_container_cpu_seconds_total${s()}[${r}]))`,
  },
  'container.cpu.throttled': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container) (rate(watchlog_container_cpu_throttled_seconds_total${s()}[${r}]))`,
  },
  'container.cpu.limit': {
    unit: 'cores',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_cpu_limit_cores${s()})`,
  },
  'container.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (host, container) (watchlog_container_memory_working_set_bytes${s()})`,
  },
  'container.memory.limit': {
    unit: 'bytes',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_memory_limit_bytes${s()})`,
  },
  'container.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container, dir) (rate(watchlog_container_network_bytes_total${s()}[${r}]))`,
  },
  'container.fs.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (host, container, dir) (rate(watchlog_container_fs_io_bytes_total${s()}[${r}]))`,
  },
  'container.restarts': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (host, container) (watchlog_container_restarts_total${s()})`,
  },
  /** Restarts within the last 10 minutes (the Docker restart rule, ADR-072). */
  'container.restarts.increase': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (host, container) (increase(watchlog_container_restarts_total${s()}[10m]))`,
  },
  // Kubernetes nodes: the node agent's host series carry `node` instead of `host`.
  'node.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (node) (rate(watchlog_node_cpu_seconds_total${s('mode!="idle"')}[${r}]))`,
  },
  'node.cpu.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (node) (rate(watchlog_node_cpu_seconds_total${s('mode!="idle"')}[${r}])) / ${a} by (node) (rate(watchlog_node_cpu_seconds_total${s()}[${r}]))`,
  },
  'node.memory.used': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (node) (watchlog_node_memory_bytes${s('state="total"')}) - ${a} by (node) (watchlog_node_memory_bytes${s('state="available"')})`,
  },
  'node.memory.utilization': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, _r, a) =>
      `1 - ${a} by (node) (watchlog_node_memory_bytes${s('state="available"')}) / ${a} by (node) (watchlog_node_memory_bytes${s('state="total"')})`,
  },
  'node.load1': {
    unit: 'load',
    agg: 'max',
    expr: (s, _r, a) => `${a} by (node) (watchlog_node_load1${s()})`,
  },
  'node.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (node, dir) (rate(watchlog_node_network_bytes_total${s()}[${r}]))`,
  },
  'node.disk.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) => `${a} by (node, dir) (rate(watchlog_node_disk_io_bytes_total${s()}[${r}]))`,
  },
  'node.filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (node, mount) (watchlog_node_filesystem_bytes${s('state="avail"')}) / ${a} by (node, mount) (watchlog_node_filesystem_bytes${s('state="size"')})`,
  },
  'node.root_filesystem.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `1 - ${a} by (node) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="avail"')}) / ${a} by (node) (watchlog_node_filesystem_bytes${s('mount="/"', 'state="size"')})`,
  },
  /**
   * 1 while a node condition is True, 0 otherwise. Only the current status has a
   * series (measured on kind: DiskPressure has status="false" only), so the other
   * statuses count as 0.
   */
  'node.condition': {
    unit: 'count',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (node, condition) (watchlog_kube_node_condition${s('status="true"')} or watchlog_kube_node_condition${s('status!="true"')} * 0)`,
  },
  // Kubernetes pods and their containers (container names are unique per pod only).
  'pod.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'pod.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'pod.network.bytes': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, dir) (rate(watchlog_pod_network_bytes_total${s()}[${r}]))`,
  },
  'pod.restarts': {
    unit: 'count',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod) (watchlog_kube_pod_container_restarts_total${s()})`,
  },
  'pod.container.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, container) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'pod.container.cpu.throttled': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, container) (rate(watchlog_container_cpu_throttled_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'pod.container.cpu.limit': {
    unit: 'cores',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod, container) (watchlog_container_cpu_limit_cores${s('pod!=""')})`,
  },
  'pod.container.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod, container) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'pod.container.memory.limit': {
    unit: 'bytes',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (namespace, pod, container) (watchlog_container_memory_limit_bytes${s('pod!=""')})`,
  },
  'pod.container.fs.io': {
    unit: 'bytes_per_second',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, pod, container, dir) (rate(watchlog_container_fs_io_bytes_total${s('pod!=""')}[${r}]))`,
  },
  /**
   * Throttled CPU time per CPU time used (ADR-072): there is no CFS period counter, so
   * this is the share of a workload container's run time it spent throttled.
   */
  'workload.container.cpu.throttling': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, workload_kind, workload, container) (rate(watchlog_container_cpu_throttled_seconds_total${s('pod!=""')}[${r}])) / ${a} by (namespace, workload_kind, workload, container) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'workload.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace, workload_kind, workload) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'workload.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace, workload_kind, workload) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'namespace.cpu.usage': {
    unit: 'cores',
    agg: 'sum',
    expr: (s, r, a) =>
      `${a} by (namespace) (rate(watchlog_container_cpu_seconds_total${s('pod!=""')}[${r}]))`,
  },
  'namespace.memory.working_set': {
    unit: 'bytes',
    agg: 'sum',
    expr: (s, _r, a) =>
      `${a} by (namespace) (watchlog_container_memory_working_set_bytes${s('pod!=""')})`,
  },
  'pvc.utilization': {
    unit: 'ratio',
    agg: 'max',
    expr: (s, _r, a) =>
      `${a} by (namespace, persistentvolumeclaim) (watchlog_pod_volume_bytes${s('state="used"')}) / ${a} by (namespace, persistentvolumeclaim) (watchlog_pod_volume_bytes${s('state="capacity"')})`,
  },
  /**
   * Share of TCP connections that failed, per source and destination (Phase 4,
   * ADR-102). Only edges with at least 3 connections a minute count, so one refused
   * connection on an idle edge is not 100 %.
   */
  'flow.failed.ratio': {
    unit: 'ratio',
    agg: 'sum',
    expr: (s, r) => {
      const by =
        'namespace, workload_kind, workload, container, dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst_service, dst';
      return `sum by (${by}) (rate(watchlog_flow_connect_failed_total${s()}[${r}])) / (sum by (${by}) (rate(watchlog_flow_connections_total${s()}[${r}])) > 0.05)`;
    },
  },
} satisfies Record<string, Entry>;

export type MetricKey = keyof typeof ENTRIES;
export const METRIC_KEYS = Object.keys(ENTRIES) as MetricKey[];

export function metricUnit(key: string): Unit | null {
  return key in ENTRIES ? (ENTRIES as Record<string, Entry>)[key]!.unit : null;
}

/** Escapes a value for a double-quoted MetricsQL label matcher. */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** A regex alternation matching exactly these values (metacharacters escaped). */
export function anyOf(values: string[]): string {
  return values.map((v) => escapeLabelValue(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('|');
}

function matchers(scope: QueryScope): string[] {
  const out: string[] = [];
  if (scope.host !== undefined) out.push(`host="${escapeLabelValue(scope.host)}"`);
  if (scope.container !== undefined) out.push(`container="${escapeLabelValue(scope.container)}"`);
  if (scope.composeProject !== undefined) {
    out.push(`compose_project="${escapeLabelValue(scope.composeProject)}"`);
  }
  const k8s: [keyof QueryScope, string][] = [
    ['node', 'node'],
    ['namespace', 'namespace'],
    ['pod', 'pod'],
    ['workloadKind', 'workload_kind'],
    ['workload', 'workload'],
  ];
  for (const [key, label] of k8s) {
    const v = scope[key];
    if (typeof v === 'string') out.push(`${label}="${escapeLabelValue(v)}"`);
  }
  if (scope.namespaces?.length) out.push(`namespace=~"${anyOf(scope.namespaces)}"`);
  if (scope.pods?.length) out.push(`pod=~"${anyOf(scope.pods)}"`);
  return out;
}

/** A series selector with the scope's matchers, for fixed expressions outside the catalog. */
export function selector(scope: QueryScope, ...extra: string[]): string {
  return `{${[...extra, ...matchers(scope)].join(',')}}`;
}

export const MIN_STEP_S = 15;
export const MAX_POINTS = 1000;

/** Step in seconds: at least 15 s and at most ~1,000 points, a multiple of 15 s. */
export function chooseStep(rangeS: number, requested?: number): number {
  const needed = Math.ceil(rangeS / MAX_POINTS);
  const step = Math.max(MIN_STEP_S, requested ?? 0, needed);
  return Math.ceil(step / MIN_STEP_S) * MIN_STEP_S;
}

/** Rate window: at least four 15 s scrapes, and at least two steps. */
export function rateWindow(step: number): string {
  return `${Math.max(60, 2 * step)}s`;
}

export interface BuiltQuery {
  expr: string;
  unit: Unit;
}

export function buildQuery(
  metric: MetricKey,
  scope: QueryScope,
  step: number,
  agg?: Agg,
): BuiltQuery {
  const entry: Entry = ENTRIES[metric];
  const base = matchers(scope);
  const sel = (...extra: string[]) => `{${[...extra, ...base].join(',')}}`;
  return { expr: entry.expr(sel, rateWindow(step), agg ?? entry.agg), unit: entry.unit };
}
