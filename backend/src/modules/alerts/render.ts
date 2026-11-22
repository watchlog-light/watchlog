// SPDX-License-Identifier: AGPL-3.0-only
// Alert messages (ADR-081, ADR-095): what, why, where, since when and a link, readable
// on a phone, with the same words as the web. One renderer builds the parts; each
// channel lays them out.
import { MAX_ITEMS, type MessageItem, type MessagePayload } from './outbox.js';
import { alertText } from './text.js';
import { ANOMALY_RULE_KEY } from '../anomaly/exclusion.js';

export interface RenderedItem {
  /** "payments-api is crash-looping" */
  title: string;
  /** "last exit: Error (code 1) · 9 restarts" */
  why: string | null;
  /** Names from outside in the title and why (an egress destination): code in the channels. */
  code?: string[];
  /** "wl-test/web (Deployment)", "node worker-1", "host-1/redis". */
  where: string;
  /** "wl-test/web (Deployment) · cluster prod · since 12:04 UTC (5 min)" */
  context: string;
  /**
   * The likely cause it had when it fired (ADR-157): "Likely cause: web fails because api was
   * scaled to 0: nothing answers its calls." on a firing message, "Was likely: …" on the
   * resolve; null without one.
   */
  cause: string | null;
  link: string | null;
}

export interface RenderedMessage {
  /** "🔴 CRITICAL · payments-api is crash-looping"; a batch names the rule and the count. */
  title: string;
  /**
   * "[Critical] payments-api is crash-looping in prod" (ADR-220): the tag, then the thing and
   * the place; a resolve keeps the stem ("[Resolved] …"), so its email threads under it.
   */
  subject: string;
  /** True when the message is about one alert, whose title is then the headline. */
  single: boolean;
  items: RenderedItem[];
  /** "and 3 more" when the message lists only the first MAX_ITEMS. */
  more: string | null;
  /** The alerts page for this rule and cluster (the "and N more" link). */
  alertsLink: string | null;
  /** Plain text: title, lines, links. */
  text: string;
}

const HEADER: Record<MessagePayload['kind'], (sev: string) => string> = {
  firing: (s) => `${s === 'critical' ? '🔴' : '🟠'} ${s.toUpperCase()}`,
  escalated: (s) => `${s === 'critical' ? '🔴' : '🟠'} ${s.toUpperCase()} (escalated)`,
  renotify: (s) => `${s === 'critical' ? '🔴' : '🟠'} STILL ${s.toUpperCase()}`,
  flapping: () => '⚠️ FLAPPING',
  resolved: () => '✅ RESOLVED',
  test: () => '🧪 TEST',
};

/** The words in front of the cause's line (ADR-148): when it fires, and on the resolve. */
export const CAUSE_LIKELY = 'Likely cause:';
export const CAUSE_WAS = 'Was likely:';

function hhmm(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

const SERVICE_NAMES: Record<string, string> = {
  redis: 'Redis',
  postgres: 'PostgreSQL',
  nginx: 'Nginx',
  rabbitmq: 'RabbitMQ',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  traefik: 'Traefik',
  kafka: 'Kafka',
  'php-fpm': 'PHP-FPM',
  elasticsearch: 'Elasticsearch',
};

export function where(l: Record<string, string>): string {
  if (l.service_name)
    return `${SERVICE_NAMES[l.service_type ?? ''] ?? l.service_type ?? 'service'} ${l.service_name}`;
  if (l.pvc) return `${l.namespace}/${l.pvc} (PVC)`;
  if (l.workload) {
    const base = `${l.namespace}/${l.workload} (${l.workload_kind})`;
    return l.container && !l.pod ? `${base} · ${l.container}` : base;
  }
  // A pod metric's rule: the pod, never "node" (ADR-229).
  if (l.pod && l.namespace) return `${l.namespace}/${l.pod} (Pod)`;
  if (l.agent) return `${l.agent === 'cluster' ? 'cluster-agent' : 'agent'} on ${l.node}`;
  if (l.compose_service) return `${l.compose_project}/${l.compose_service} (Compose service)`;
  // A Docker edge's alert names its container but not the host.
  if (l.container) return l.node ? `${l.node}/${l.container}` : l.container;
  if (l.mount) return `${l.node} ${l.mount}`;
  // A server's systemd service or process group (ADR-208).
  if (l.group && l.node) return `${l.node} › ${l.group} (process group)`;
  if (l.unit && l.node) return `${l.node} › ${l.unit}`;
  if (l.node) return l.condition ? `node ${l.node} (${l.condition})` : `node ${l.node}`;
  if (l.namespace) return `namespace ${l.namespace}`;
  return Object.values(l).join(' ');
}

export type SubjectKind =
  | 'service'
  | 'pvc'
  | 'workload'
  | 'pod'
  | 'agent'
  | 'compose-service'
  | 'container'
  | 'unit'
  | 'process-group'
  | 'node'
  | 'namespace'
  | 'cluster';

/**
 * What an alert is about, for MCP and the API (ADR-229): its kind, the product of a monitored
 * service ("Traefik"), the workload kind, and a name. Sentences are built by `where`.
 */
export function alertSubject(l: Record<string, string>): {
  kind: SubjectKind;
  name: string;
  type?: string;
} {
  if (l.service_name) {
    return {
      kind: 'service',
      name: l.service_name,
      type: SERVICE_NAMES[l.service_type ?? ''] ?? l.service_type,
    };
  }
  if (l.pvc) return { kind: 'pvc', name: `${l.namespace}/${l.pvc}` };
  if (l.workload)
    return { kind: 'workload', name: `${l.namespace}/${l.workload}`, type: l.workload_kind };
  if (l.pod && l.namespace) return { kind: 'pod', name: `${l.namespace}/${l.pod}` };
  if (l.agent) return { kind: 'agent', name: l.node ?? l.agent };
  if (l.compose_service)
    return { kind: 'compose-service', name: `${l.compose_project}/${l.compose_service}` };
  if (l.container)
    return { kind: 'container', name: l.node ? `${l.node}/${l.container}` : l.container };
  if (l.group && l.node) return { kind: 'process-group', name: `${l.node}/${l.group}` };
  if (l.unit && l.node) return { kind: 'unit', name: `${l.node}/${l.unit}` };
  if (l.node) return { kind: 'node', name: l.node };
  if (l.namespace) return { kind: 'namespace', name: l.namespace };
  return { kind: 'cluster', name: '' };
}

function link(
  base: string | undefined,
  item: MessageItem,
  cluster: MessagePayload['cluster'],
  ruleKey: string | null = null,
): string | null {
  if (!base) return null;
  const l = item.labels;
  // An anomaly alert: its own page, the series against its usual band (ADR-200).
  if (ruleKey === ANOMALY_RULE_KEY && item.alertId) {
    return `${base.replace(/\/+$/, '')}/alerts/${encodeURIComponent(item.alertId)}`;
  }
  const q = `?cluster=${encodeURIComponent(cluster.id)}`;
  const e = encodeURIComponent;
  let path: string;
  // An egress alert: the Egress page, filtered to its source and destination (ADR-187).
  if (l.destination) return egressLink(base, l, cluster.id);
  if (l.service) path = `/applications/${e(l.service)}`;
  else if (l.pod) path = `/pods/${e(l.namespace!)}/${e(l.pod)}`;
  else if (l.workload || l.pvc) path = `/workloads${q}&ns=${e(l.namespace!)}`;
  else if (cluster.kind === 'server' && l.container)
    path = l.node ? `/docker/hosts/${e(l.node)}/containers/${e(l.container)}` : '/containers';
  else if (cluster.kind === 'server' && l.node) path = `/docker/hosts/${e(l.node)}`;
  else if (l.node && l.agent !== 'cluster') path = `/nodes/${e(l.node)}`;
  else path = '/';
  return `${base.replace(/\/+$/, '')}${path}${path.includes('?') ? '' : q}`;
}

/** The Egress page for one source and destination, in the page's own query words. */
export function egressLink(base: string, l: Record<string, string>, clusterId: string): string {
  const q = new URLSearchParams({ cluster: clusterId });
  if (l.workload) {
    q.set('namespace', l.namespace ?? '');
    q.set('kind', l.workload_kind ?? '');
    q.set('workload', l.workload);
  } else if (l.compose_service) {
    q.set('project', l.compose_project ?? '');
    q.set('service', l.compose_service);
  } else {
    if (l.node) q.set('host', l.node);
    if (l.container) q.set('container', l.container);
  }
  q.set('q', l.destination ?? '');
  return `${base.replace(/\/+$/, '')}/egress?${q.toString()}`;
}

export function renderMessage(p: MessagePayload, publicUrl?: string): RenderedMessage {
  const at = Date.parse(p.at);
  const items = p.items.map((it): RenderedItem => {
    const text = alertText({
      ruleKey: p.rule.key,
      ruleName: p.rule.name,
      metric: p.rule.metric ?? null,
      labels: it.labels,
      details: it.details,
      cluster: p.cluster,
      now: at,
    });
    const w = where(it.labels);
    const when =
      p.kind === 'resolved' && it.resolvedAt
        ? `after ${duration(Date.parse(it.resolvedAt) - Date.parse(it.firedAt ?? it.startedAt))}`
        : `since ${hhmm(it.startedAt)} (${duration(at - Date.parse(it.startedAt))})`;
    const lc = it.likelyCause?.text;
    return {
      ...text,
      cause:
        lc && p.kind !== 'flapping' && p.kind !== 'test'
          ? `${p.kind === 'resolved' ? CAUSE_WAS : CAUSE_LIKELY} ${lc}`
          : null,
      where: w,
      context: [w, `cluster ${p.cluster.name}`, when].join(' · '),
      link: link(publicUrl, it, p.cluster, p.rule.key),
    };
  });
  const single = p.total === 1 && items.length === 1;
  const headline = single ? items[0]!.title : `${p.rule.name} (${p.total})`;
  const title = `${HEADER[p.kind](p.severity)} · ${headline}`;
  const rest = p.total - Math.min(p.items.length, MAX_ITEMS);
  const more = rest > 0 ? `and ${rest} more` : null;
  const alertsLink = publicUrl
    ? `${publicUrl.replace(/\/+$/, '')}/alerts?rule=${encodeURIComponent(p.rule.id)}&cluster=${encodeURIComponent(p.cluster.id)}`
    : null;
  const subject = `[${subjectTag(p)}] ${subjectStem(p, single ? items[0]!.title : null)}`;
  const lines = [title];
  for (const it of items) {
    lines.push('');
    if (!single) lines.push(it.title);
    if (it.why) lines.push(it.why);
    lines.push(it.context);
    if (it.cause) lines.push(it.cause);
    if (it.link) lines.push(it.link);
  }
  if (more) lines.push('', alertsLink ? `${more}: ${alertsLink}` : more);
  return { title, subject, single, items, more, alertsLink, text: lines.join('\n') };
}

/** "in prod" for a cluster, "on app-1" for a server's alert, "in acme-servers" otherwise. */
export function placeOf(item: MessageItem, cluster: MessagePayload['cluster'], title: string) {
  const node = item.labels.node;
  if (cluster.kind === 'server' && node && !title.includes(node)) return `on ${node}`;
  return `in ${cluster.name}`;
}

/** The subject's stem, the same for every message about one alert (so they thread). */
export function subjectStem(p: MessagePayload, singleTitle: string | null): string {
  if (p.kind === 'test') return `WatchLog alert channel for ${p.cluster.name}`;
  if (singleTitle === null) return `${p.rule.name}: ${p.total} alerts in ${p.cluster.name}`;
  return `${singleTitle} ${placeOf(p.items[0]!, p.cluster, singleTitle)}`;
}

/** [Critical], [Warning], [Resolved], [Flapping], [Test]. */
export function subjectTag(p: MessagePayload): string {
  if (p.kind === 'resolved') return 'Resolved';
  if (p.kind === 'test') return 'Test';
  if (p.kind === 'flapping') return 'Flapping';
  return p.severity === 'critical' ? 'Critical' : 'Warning';
}

/** The payload of a "send test" message (ADR-080). */
export function testPayload(
  cluster = { id: 'test', name: 'test', kind: 'kubernetes' },
): MessagePayload {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: 'test',
    severity: 'warning',
    rule: { id: 'test', key: null, name: 'WatchLog test message' },
    cluster,
    items: [
      {
        alertId: 'test',
        severity: 'warning',
        labels: { node: 'example' },
        details: { summary: 'This channel is connected. No action needed.' },
        startedAt: now,
        firedAt: now,
        resolvedAt: null,
      },
    ],
    total: 1,
    at: now,
  };
}
