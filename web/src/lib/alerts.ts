// SPDX-License-Identifier: AGPL-3.0-only
// What an alert is about, where to look, and how long it lasted (ADR-075, ADR-081).
import type { Alert } from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';
import type { Tone } from './kube';

/** "wl-test/web (Deployment)", "node worker-1", "host-1/redis" — like the messages. */
export function alertWhere(a: Pick<Alert, 'labels'>): string {
  const l = a.labels;
  if (l.pvc) return `${l.namespace}/${l.pvc} (PVC)`;
  if (l.workload) {
    const base = `${l.namespace}/${l.workload} (${l.workload_kind})`;
    return l.container && !l.pod ? `${base} · ${l.container}` : base;
  }
  // Agent alerts: the agent itself, never "cluster-agent on cluster-agent".
  if (l.agent === 'all') return 'all agents';
  if (l.agent === 'cluster') return 'cluster-agent';
  if (l.agent) return `${l.agent === 'docker' ? 'host' : 'node'} ${l.node}`;
  if (l.container) return `${l.node}/${l.container}`;
  if (l.mount) return `${l.node} ${l.mount}`;
  if (l.node) return l.condition ? `node ${l.node} (${l.condition})` : `node ${l.node}`;
  return Object.values(l).join(' ');
}

/** The page of the object an alert is about, if there is one. */
export function alertTarget(a: Pick<Alert, 'labels' | 'cluster'>): RouteLocationRaw | null {
  const l = a.labels;
  // A silent cluster or its cluster-agent: the cluster's page lists its agents.
  if (l.agent === 'all' || l.agent === 'cluster') {
    return { name: 'cluster-settings', params: { id: a.cluster.id } };
  }
  if (a.cluster.kind === 'docker') {
    if (l.container && l.node) {
      return { name: 'docker-container', params: { host: l.node, name: l.container } };
    }
    return l.node ? { name: 'docker-host', params: { host: l.node } } : null;
  }
  if (l.pod && l.namespace) return { name: 'pod', params: { namespace: l.namespace, name: l.pod } };
  if (l.workload && l.namespace) {
    return {
      name: 'workloads',
      query: { view: 'pods', wkind: l.workload_kind, wname: l.workload, wns: l.namespace },
    };
  }
  if (l.pvc && l.namespace) return { name: 'workloads', query: { ns: l.namespace } };
  if (l.node) return { name: 'node', params: { name: l.node } };
  return null;
}

/** The name of that object, for "Open …". */
export function alertTargetName(a: Pick<Alert, 'labels' | 'cluster'>): string {
  const l = a.labels;
  if (l.agent === 'all' || l.agent === 'cluster') return a.cluster.name;
  return l.pod ?? l.workload ?? l.container ?? l.pvc ?? l.node ?? a.cluster.name;
}

export function severityTone(severity: string): Tone {
  return severity === 'critical' ? 'critical' : 'warning';
}

/** The tone of an alert's state: resolved is fine, pending not yet. */
export function stateTone(a: Pick<Alert, 'state' | 'severity'>): Tone {
  if (a.state === 'resolved') return 'ok';
  if (a.state === 'pending') return 'neutral';
  return severityTone(a.severity);
}

/** Compact duration between two ISO timestamps, e.g. "12m", "3h 5m", "2d 4h". */
export function duration(fromIso: string, toIso: string): string {
  const s = Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Silence matchers for an alert: its rule and cluster plus its scope (ADR-077). */
export function silenceMatchersFor(a: Alert): Record<string, string> {
  const m: Record<string, string> = { rule: a.rule.id, cluster: a.cluster.id };
  if (a.labels.namespace) m.namespace = a.labels.namespace;
  if (a.labels.workload) m.workload = a.labels.workload;
  else if (a.labels.node) m.node = a.labels.node;
  return m;
}

/** A threshold for display: ratios as percent, counts as they are. */
export function formatThreshold(value: number, unit: string | null): string {
  return unit === 'ratio' ? `${Math.round(value * 1000) / 10} %` : String(value);
}

export function formatSeconds(s: number): string {
  if (s === 0) return '0';
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** What an alert is about, as "Deployment" + "payments/payments-api" (the design's where line). */
export function alertScope(a: Pick<Alert, 'labels' | 'cluster' | 'podCount'>): {
  kind: string;
  name: string;
  extra: string | null;
} {
  const l = a.labels;
  if (l.agent === 'all') return { kind: a.cluster.kind, name: a.cluster.name, extra: null };
  if (l.pvc) return { kind: 'PVC', name: `${l.namespace}/${l.pvc}`, extra: null };
  if (l.workload) {
    return {
      kind: l.workload_kind ?? 'Pod',
      name: `${l.namespace}/${l.workload}`,
      extra: l.container && !l.pod ? l.container : null,
    };
  }
  if (a.cluster.kind === 'docker') {
    return { kind: 'host', name: l.node ?? '', extra: l.container ?? null };
  }
  if (l.agent === 'cluster') return { kind: 'cluster-agent', name: a.cluster.name, extra: null };
  return { kind: 'node', name: l.node ?? '', extra: l.mount ?? l.condition ?? null };
}

export type DeliveryTone = 'ok' | 'critical' | 'neutral';
export function deliveryTone(status: string): DeliveryTone {
  return status === 'sent' ? 'ok' : status === 'failed' ? 'critical' : 'neutral';
}

/** Alerts grouped by cluster, clusters with critical alerts first. */
export function byCluster<T extends Pick<Alert, 'cluster' | 'severity'>>(alerts: T[]) {
  const groups = new Map<string, { cluster: T['cluster']; alerts: T[] }>();
  for (const a of alerts) {
    const g = groups.get(a.cluster.id) ?? { cluster: a.cluster, alerts: [] as T[] };
    g.alerts.push(a);
    groups.set(a.cluster.id, g);
  }
  const crit = (g: { alerts: T[] }) => g.alerts.filter((a) => a.severity === 'critical').length;
  return [...groups.values()].sort(
    (a, b) => crit(b) - crit(a) || a.cluster.name.localeCompare(b.cluster.name),
  );
}

/** "**bold** text" → segments; translations mark the values to stress with ** (no HTML). */
export function boldParts(text: string): { text: string; bold: boolean }[] {
  return text
    .split('**')
    .map((t, i) => ({ text: t, bold: i % 2 === 1 }))
    .filter((p) => p.text);
}

/** "2 min", "10 min", "1 h", "30 s" */
export function humanSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  return `${Math.round(s / 60)} min`;
}

/** A threshold in the unit people read: 85%, 512 MiB, 0.5 cores, 3. */
export function formatValueIn(value: number, unit: string | null): string {
  if (unit === 'ratio') return `${Math.round(value * 1000) / 10}%`;
  if (unit === 'bytes') {
    return value >= 2 ** 30
      ? `${Math.round((value / 2 ** 30) * 10) / 10} GiB`
      : `${Math.round(value / 2 ** 20)} MiB`;
  }
  if (unit === 'cores') return `${Math.round(value * 100) / 100} cores`;
  if (unit === 'seconds') {
    return value < 1 ? `${Math.round(value * 1000)} ms` : `${Math.round(value * 100) / 100} s`;
  }
  return String(Math.round(value * 100) / 100);
}

export type RuleGroup = 'pods' | 'nodes' | 'docker' | 'watchlog' | 'custom';
const GROUP_OF: Record<string, RuleGroup> = {
  'k8s.pod.crashloop': 'pods',
  'k8s.container.oomkilled': 'pods',
  'k8s.pod.pending': 'pods',
  'k8s.pod.imagepull': 'pods',
  'k8s.deployment.unavailable': 'pods',
  'k8s.container.throttling': 'pods',
  'network.connections.failed': 'pods',
  'k8s.pvc.usage': 'pods',
  'node.disk.usage': 'nodes',
  'node.cpu.high': 'nodes',
  'k8s.node.notready': 'nodes',
  'k8s.node.pressure': 'nodes',
  'docker.container.unhealthy': 'docker',
  'docker.container.restarts': 'docker',
  'docker.container.throttling': 'docker',
  'agent.not_reporting': 'watchlog',
};
export const RULE_GROUPS: RuleGroup[] = ['pods', 'nodes', 'docker', 'watchlog', 'custom'];
export function ruleGroup(rule: { type: string; ruleKey: string | null }): RuleGroup {
  if (rule.type === 'threshold' || !rule.ruleKey) return 'custom';
  return GROUP_OF[rule.ruleKey] ?? (rule.ruleKey.startsWith('docker.') ? 'docker' : 'pods');
}
/** Position within its group: built-in rules in GROUP_OF order (most urgent first), then the rest. */
const ORDER = Object.keys(GROUP_OF);
export function ruleOrder(rule: { ruleKey: string | null }): number {
  const i = rule.ruleKey ? ORDER.indexOf(rule.ruleKey) : -1;
  return i < 0 ? ORDER.length : i;
}

/** Metrics offered for custom rules, per cluster kind (the API accepts any catalog key). */
export const CUSTOM_METRICS: Record<'kubernetes' | 'docker', { key: string; unit: string }[]> = {
  kubernetes: [
    { key: 'node.cpu.utilization', unit: 'ratio' },
    { key: 'node.memory.utilization', unit: 'ratio' },
    { key: 'node.filesystem.utilization', unit: 'ratio' },
    { key: 'node.load1', unit: 'load' },
    { key: 'pod.cpu.usage', unit: 'cores' },
    { key: 'pod.memory.working_set', unit: 'bytes' },
    { key: 'pod.restarts', unit: 'count' },
    { key: 'workload.cpu.usage', unit: 'cores' },
    { key: 'workload.memory.working_set', unit: 'bytes' },
    { key: 'workload.container.cpu.throttled_share', unit: 'ratio' },
    // Throttled ÷ used (ADR-072), kept so the custom rules made on it stay editable (ADR-160).
    { key: 'workload.container.cpu.throttling', unit: 'ratio' },
    { key: 'namespace.cpu.usage', unit: 'cores' },
    { key: 'namespace.memory.working_set', unit: 'bytes' },
    { key: 'pvc.utilization', unit: 'ratio' },
  ],
  docker: [
    { key: 'host.cpu.utilization', unit: 'ratio' },
    { key: 'host.memory.utilization', unit: 'ratio' },
    { key: 'host.filesystem.utilization', unit: 'ratio' },
    { key: 'host.load1', unit: 'load' },
    { key: 'container.cpu.usage', unit: 'cores' },
    { key: 'container.cpu.throttled_share', unit: 'ratio' },
    { key: 'container.memory.working_set', unit: 'bytes' },
    { key: 'container.restarts.increase', unit: 'count' },
  ],
};

/** A monitored service's metrics (SPEC §4.12), the same on both kinds of cluster. */
export const SERVICE_METRICS: {
  key: string;
  unit: string;
  /** Where a new rule starts: below 100 % reachable, above 500 ms to connect. */
  start: { op: '>' | '<'; value: number };
}[] = [
  { key: 'service.reachable.ratio', unit: 'ratio', start: { op: '<', value: 1 } },
  { key: 'service.connect.time', unit: 'seconds', start: { op: '>', value: 0.5 } },
];

/** Each integration's own metrics, after the generic ones (SPEC §4.12). */
export const SERVICE_METRICS_BY_TYPE: Record<string, typeof SERVICE_METRICS> = {
  redis: [
    { key: 'redis.memory.ratio', unit: 'ratio', start: { op: '>', value: 0.9 } },
    { key: 'redis.memory.used', unit: 'bytes', start: { op: '>', value: 2 ** 30 } },
    { key: 'redis.hit.ratio', unit: 'ratio', start: { op: '<', value: 0.8 } },
    { key: 'redis.ops.rate', unit: 'per_second', start: { op: '>', value: 10_000 } },
    { key: 'redis.evicted.rate', unit: 'per_second', start: { op: '>', value: 0 } },
    { key: 'redis.connected_clients', unit: 'count', start: { op: '>', value: 1000 } },
    { key: 'redis.blocked_clients', unit: 'count', start: { op: '>', value: 0 } },
    { key: 'redis.replica.down', unit: 'count', start: { op: '>', value: 0 } },
    { key: 'redis.save.failed', unit: 'count', start: { op: '>', value: 0 } },
  ],
  postgres: [
    { key: 'postgres.connections.ratio', unit: 'ratio', start: { op: '>', value: 0.9 } },
    { key: 'postgres.connections', unit: 'count', start: { op: '>', value: 100 } },
    { key: 'postgres.transactions.rate', unit: 'per_second', start: { op: '>', value: 5000 } },
    { key: 'postgres.cache_hit.ratio', unit: 'ratio', start: { op: '<', value: 0.9 } },
    { key: 'postgres.query.longest', unit: 'seconds', start: { op: '>', value: 300 } },
    {
      key: 'postgres.idle_in_transaction.longest',
      unit: 'seconds',
      start: { op: '>', value: 300 },
    },
    { key: 'postgres.replication.lag', unit: 'seconds', start: { op: '>', value: 30 } },
    { key: 'postgres.xid.age', unit: 'count', start: { op: '>', value: 1_500_000_000 } },
    { key: 'postgres.deadlocks.rate', unit: 'per_second', start: { op: '>', value: 0 } },
    { key: 'postgres.database.size', unit: 'bytes', start: { op: '>', value: 50 * 2 ** 30 } },
    { key: 'postgres.lock_waits', unit: 'count', start: { op: '>', value: 0 } },
  ],
  mysql: [
    { key: 'mysql.connections.ratio', unit: 'ratio', start: { op: '>', value: 0.9 } },
    { key: 'mysql.connections', unit: 'count', start: { op: '>', value: 100 } },
    { key: 'mysql.queries.rate', unit: 'per_second', start: { op: '>', value: 5000 } },
    { key: 'mysql.slow_queries.rate', unit: 'per_second', start: { op: '>', value: 1 } },
    { key: 'mysql.buffer_pool_hit.ratio', unit: 'ratio', start: { op: '<', value: 0.9 } },
    { key: 'mysql.query.longest', unit: 'seconds', start: { op: '>', value: 300 } },
    { key: 'mysql.replication.lag', unit: 'seconds', start: { op: '>', value: 30 } },
    { key: 'mysql.replication.stopped', unit: 'count', start: { op: '>', value: 0 } },
    { key: 'mysql.deadlocks.rate', unit: 'per_second', start: { op: '>', value: 0 } },
    { key: 'mysql.lock_waits', unit: 'count', start: { op: '>', value: 0 } },
  ],
  nginx: [
    { key: 'nginx.5xx.ratio', unit: 'ratio', start: { op: '>', value: 0.05 } },
    { key: 'nginx.latency.p95', unit: 'seconds', start: { op: '>', value: 1 } },
    { key: 'nginx.requests.rate', unit: 'per_second', start: { op: '>', value: 1000 } },
    { key: 'nginx.upstream.down', unit: 'count', start: { op: '>', value: 0 } },
    { key: 'nginx.certificate.expiry', unit: 'seconds', start: { op: '<', value: 14 * 86_400 } },
  ],
  rabbitmq: [
    { key: 'rabbitmq.queue.unconsumed', unit: 'count', start: { op: '>', value: 0 } },
    { key: 'rabbitmq.messages.ready', unit: 'count', start: { op: '>', value: 10_000 } },
    { key: 'rabbitmq.messages.unacked', unit: 'count', start: { op: '>', value: 10_000 } },
    { key: 'rabbitmq.publish.rate', unit: 'per_second', start: { op: '>', value: 1000 } },
    { key: 'rabbitmq.deliver.rate', unit: 'per_second', start: { op: '<', value: 1 } },
    { key: 'rabbitmq.consumers', unit: 'count', start: { op: '<', value: 1 } },
    { key: 'rabbitmq.memory.ratio', unit: 'ratio', start: { op: '>', value: 0.8 } },
    { key: 'rabbitmq.alarms', unit: 'count', start: { op: '>', value: 0 } },
    { key: 'rabbitmq.dead_lettered.rate', unit: 'per_second', start: { op: '>', value: 0 } },
  ],
};
export const serviceMetrics = (type?: string) => [
  ...SERVICE_METRICS,
  ...(type ? (SERVICE_METRICS_BY_TYPE[type] ?? []) : []),
];

/** Thresholds are typed in the unit people read: percent, MiB and milliseconds. */
export const INPUT_FACTOR: Record<string, number> = { ratio: 0.01, bytes: 2 ** 20, seconds: 0.001 };
export const toInput = (v: number, unit: string | null) =>
  Math.round((v / (INPUT_FACTOR[unit ?? ''] ?? 1)) * 100) / 100;
/** Percent back to a ratio by division (95 / 100 is 0.95; 95 * 0.01 is not). */
export const fromInput = (v: number, unit: string | null) =>
  unit === 'ratio' ? v / 100 : v * (INPUT_FACTOR[unit ?? ''] ?? 1);
