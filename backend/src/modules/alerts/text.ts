// SPDX-License-Identifier: AGPL-3.0-only
// The words of an alert (alerts redesign item 6, ADR-095): a title that says what is
// wrong in plain language ("payments-api is crash-looping", "Disk on worker-07 is 88%
// full") and a "why" line with the facts behind it ("last exit: Error (code 1) · 9
// restarts", "threshold 85% · full in ~6 h"). The web and every channel use the same
// text. Built from the evaluators' facts at read time, so relative times stay true.
import { metricUnit } from '../query/catalog.js';
import { formatMetricValue } from './threshold.js';

export interface AlertTextInput {
  ruleKey: string | null;
  ruleName: string;
  metric?: string | null;
  labels: Record<string, string>;
  details: Record<string, unknown>;
  cluster: { name: string };
  now: number;
}

export interface AlertText {
  title: string;
  why: string | null;
}

const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '');
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const join = (...parts: (string | null | false | undefined)[]) =>
  parts.filter(Boolean).join(' · ') || null;
const plural = (n: number, one: string, many: string) =>
  n === 1 ? one : many.replace('{n}', String(n));

/** "10 min", "6 h", "2 d" */
export function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
function ago(iso: unknown, now: number): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : `${humanDuration(Math.max(0, (now - t) / 1000))} ago`;
}

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;

/** A summary written before the structured facts, with its ISO times made relative. */
function legacy(summary: unknown, now: number): string | null {
  const s = str(summary);
  return s ? s.replace(ISO, (m) => ago(m, now) ?? m) : null;
}

/** The workload, else the pod, else the container or node the alert is about. */
function subject(l: Record<string, string>): string {
  return l.workload ?? l.pod ?? l.container ?? l.pvc ?? l.node ?? '';
}

export function alertText(a: AlertTextInput): AlertText {
  const l = a.labels;
  const d = a.details;
  const fallback = { title: a.ruleName, why: legacy(d.summary, a.now) };
  // Agent alerts written before `lastSeen` carry the time in their summary only.
  const lastSeen = str(d.lastSeen) ?? str(d.summary)?.match(ISO)?.[0] ?? null;
  const wl = subject(l);
  switch (a.ruleKey) {
    case 'k8s.pod.crashloop':
      return {
        title: `${wl} is crash-looping`,
        why:
          join(
            str(d.reason) &&
              `last exit: ${str(d.reason)}${num(d.exitCode) !== null ? ` (code ${num(d.exitCode)})` : ''}`,
            num(d.restarts) !== null && plural(num(d.restarts)!, '1 restart', '{n} restarts'),
          ) ?? fallback.why,
      };
    case 'k8s.container.oomkilled':
      return {
        title: `${wl} was killed for using too much memory`,
        why: join(
          d.killedAt ? `OOMKilled ${ago(d.killedAt, a.now)}` : 'OOMKilled',
          str(d.limit) && `limit ${str(d.limit)}`,
          num(d.restarts) !== null && plural(num(d.restarts)!, '1 restart', '{n} restarts'),
        ),
      };
    case 'k8s.pod.pending':
      return {
        title: `${wl} is stuck in Pending`,
        why: [str(d.reason), str(d.message)].filter(Boolean).join(': ') || 'not scheduled yet',
      };
    case 'k8s.pod.imagepull':
      return { title: `${wl} cannot pull its image`, why: join(str(d.image), str(d.reason)) };
    case 'k8s.node.notready':
      return {
        title: `Node ${l.node} is not ready`,
        why: join(str(d.status) && `Ready: ${str(d.status)}`, str(d.reason), str(d.message)),
      };
    case 'k8s.node.pressure':
      return {
        title: `Node ${l.node} is under ${l.condition === 'DiskPressure' ? 'disk' : 'memory'} pressure`,
        why: str(d.message) ?? str(d.reason),
      };
    case 'k8s.deployment.unavailable': {
      const ready = num(d.ready) ?? 0;
      const desired = num(d.desired) ?? 0;
      return {
        title: `${wl} has ${ready} of ${desired} replicas ready`,
        why: plural(desired - ready, '1 replica unavailable', '{n} replicas unavailable'),
      };
    }
    case 'docker.container.unhealthy':
      return {
        title: `${l.container} container is unhealthy`,
        why:
          join(num(d.streak) !== null && `health check failing ${num(d.streak)}×`, str(d.output)) ??
          fallback.why,
      };
    // Docker object problems on the overview and Containers page (no rule of their own).
    case 'docker.container.restarting':
      return {
        title: `${l.container} keeps restarting`,
        why: join(
          num(d.exitCode) !== null && `exited with code ${num(d.exitCode)}`,
          num(d.restarts) !== null && plural(num(d.restarts)!, '1 restart', '{n} restarts'),
        ),
      };
    case 'docker.container.oom':
      return {
        title: `${l.container} was killed for using too much memory`,
        why: join(
          'OOMKilled',
          str(d.limit) && `limit ${str(d.limit)}`,
          num(d.restarts) !== null && plural(num(d.restarts)!, '1 restart', '{n} restarts'),
        ),
      };
    case 'docker.container.exited':
      return {
        title: `${l.container} exited with code ${num(d.exitCode) ?? '?'}`,
        why: join(d.finishedAt ? `stopped ${ago(d.finishedAt, a.now)}` : null, str(d.error)),
      };
    case 'docker.container.restarts':
      return {
        title: `${l.container} keeps restarting`,
        why: `${Math.round(num(d.value) ?? 0)} restarts in 10 min`,
      };
    case 'agent.not_reporting':
      if (l.agent === 'all') {
        return {
          title: `${a.cluster.name} stopped reporting`,
          why: join(
            plural(num(d.agents) ?? 0, 'its agent is silent', 'all {n} agents are silent'),
            lastSeen ? `last data ${ago(lastSeen, a.now)}` : null,
          ),
        };
      }
      return {
        title:
          l.agent === 'cluster'
            ? 'The cluster-agent stopped reporting'
            : `The agent on ${l.agent === 'docker' ? 'host' : 'node'} ${l.node} stopped reporting`,
        why: lastSeen ? `last heartbeat ${ago(lastSeen, a.now)}` : null,
      };
    case 'watchlog.ingest.failing': {
      const eps = Array.isArray(d.endpoints)
        ? (d.endpoints as { endpoint?: string; status?: number }[])
        : [];
      return {
        title: `WatchLog cannot store data from ${a.cluster.name}`,
        why: join(
          eps.map((e) => `${e.endpoint ?? '?'} answered ${e.status ?? '?'}`).join(', ') || null,
          str(d.since) && !Number.isNaN(Date.parse(str(d.since)!))
            ? `failing for ${humanDuration(Math.max(0, (a.now - Date.parse(str(d.since)!)) / 1000))}`
            : null,
        ),
      };
    }
    case 'node.cpu.high':
      return {
        title: `CPU on ${l.node} is at ${pct(d.value)}`,
        why: join(
          `threshold ${pct(d.threshold)}`,
          num(d.forSeconds) ? `for ${humanDuration(num(d.forSeconds)!)}` : null,
        ),
      };
    case 'node.disk.usage':
    case 'k8s.pvc.usage':
      return {
        title:
          a.ruleKey === 'k8s.pvc.usage'
            ? `Volume ${l.namespace}/${l.pvc} is ${pct(d.value)} full`
            : `Disk on ${l.node} is ${pct(d.value)} full`,
        why: join(
          `threshold ${pct(d.threshold)}`,
          l.mount && l.mount !== '/' ? `mount ${l.mount}` : null,
          num(d.risePerHour) !== null && `rising ${num(d.risePerHour)}% per hour`,
          num(d.fullInSeconds) !== null && `full in ~${humanDuration(num(d.fullInSeconds)!)}`,
        ),
      };
    case 'network.connections.failed': {
      const dst =
        l.dst_workload ??
        l.dst_service ??
        l.dst ??
        (l.dst_kind === 'internet' ? 'the Internet' : '');
      return {
        title: `${l.workload ?? l.container} cannot reach ${dst}`,
        why: join(`${pct(d.value)} of connections failed`, `threshold ${pct(d.threshold)}`),
      };
    }
    case 'k8s.container.throttling':
      return {
        title: `${wl} is CPU-throttled`,
        why: join(
          `${l.container}: throttled ${pct(d.value)} of its CPU time`,
          `threshold ${pct(d.threshold)}`,
        ),
      };
  }
  if (a.metric && num(d.value) !== null) {
    const unit = metricUnit(a.metric);
    const who =
      l.workload ?? l.pod ?? l.container ?? l.node ?? l.pvc ?? l.namespace ?? a.cluster.name;
    return {
      title: `${a.ruleName}: ${who} at ${formatMetricValue(num(d.value)!, unit)}`,
      why: join(
        num(d.threshold) !== null &&
          `${d.op === '<' ? 'below' : 'above'} ${formatMetricValue(num(d.threshold)!, unit)}`,
        num(d.forSeconds) ? `for ${humanDuration(num(d.forSeconds)!)}` : null,
      ),
    };
  }
  return fallback;
}
