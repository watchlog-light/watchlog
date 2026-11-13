// SPDX-License-Identifier: AGPL-3.0-only
// Alert messages (ADR-081, ADR-095): what, why, where, since when and a link, readable
// on a phone, with the same words as the web. One renderer builds the parts; each
// channel lays them out.
import { MAX_ITEMS, type MessageItem, type MessagePayload } from './outbox.js';
import { alertText } from './text.js';

export interface RenderedItem {
  /** "payments-api is crash-looping" */
  title: string;
  /** "last exit: Error (code 1) · 9 restarts" */
  why: string | null;
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
  /** "[CRITICAL] payments-api is crash-looping (prod)" */
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
  elasticsearch: 'Elasticsearch',
};

function where(l: Record<string, string>): string {
  if (l.service_name)
    return `${SERVICE_NAMES[l.service_type ?? ''] ?? l.service_type ?? 'service'} ${l.service_name}`;
  if (l.pvc) return `${l.namespace}/${l.pvc} (PVC)`;
  if (l.workload) {
    const base = `${l.namespace}/${l.workload} (${l.workload_kind})`;
    return l.container && !l.pod ? `${base} · ${l.container}` : base;
  }
  if (l.agent) return `${l.agent === 'cluster' ? 'cluster-agent' : 'agent'} on ${l.node}`;
  // A Docker edge's alert names its container but not the host.
  if (l.container) return l.node ? `${l.node}/${l.container}` : l.container;
  if (l.mount) return `${l.node} ${l.mount}`;
  if (l.node) return l.condition ? `node ${l.node} (${l.condition})` : `node ${l.node}`;
  return Object.values(l).join(' ');
}

function link(
  base: string | undefined,
  item: MessageItem,
  cluster: MessagePayload['cluster'],
): string | null {
  if (!base) return null;
  const l = item.labels;
  const q = `?cluster=${encodeURIComponent(cluster.id)}`;
  const e = encodeURIComponent;
  let path: string;
  if (l.service) path = `/applications/${e(l.service)}`;
  else if (l.pod) path = `/pods/${e(l.namespace!)}/${e(l.pod)}`;
  else if (l.workload || l.pvc) path = `/workloads${q}&ns=${e(l.namespace!)}`;
  else if (cluster.kind === 'docker' && l.container)
    path = l.node ? `/docker/hosts/${e(l.node)}/containers/${e(l.container)}` : '/containers';
  else if (cluster.kind === 'docker' && l.node) path = `/docker/hosts/${e(l.node)}`;
  else if (l.node && l.agent !== 'cluster') path = `/nodes/${e(l.node)}`;
  else path = '/';
  return `${base.replace(/\/+$/, '')}${path}${path.includes('?') ? '' : q}`;
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
      link: link(publicUrl, it, p.cluster),
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
  const tag =
    p.kind === 'resolved' ? 'RESOLVED' : p.kind === 'test' ? 'TEST' : p.severity.toUpperCase();
  const subject = single
    ? `[${tag}] ${items[0]!.title} (${p.cluster.name})`
    : `[${tag}] ${p.rule.name}: ${p.total} alerts (${p.cluster.name})`;
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
