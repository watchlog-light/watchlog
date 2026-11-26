// SPDX-License-Identifier: AGPL-3.0-only
// The words of an alert (alerts redesign item 6, ADR-095): a title that says what is
// wrong in plain language ("payments-api is crash-looping", "Disk on worker-07 is 88%
// full") and a "why" line with the facts behind it ("last exit: Error (code 1) · 9
// restarts", "threshold 85% · full in ~6 h"). The web and every channel use the same
// text. Built from the evaluators' facts at read time, so relative times stay true.
import { isModuleRule } from './module-rules.js';
import { metricUnit } from '../query/catalog.js';
import {
  ANOMALY_RULE_KEY,
  bucketWords,
  metricWords,
  rangeWords,
  subjectWords,
  valueWords,
} from '../anomaly/alerts.js';
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
  /**
   * Strings in the title and why that are names from outside (an egress destination: DNS
   * answers anyone can register, ADR-187). The channels set them as code, never as links.
   */
  code?: string[];
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
  if (a.ruleKey?.startsWith('egress.')) return egressText(a) ?? fallback;
  if (a.ruleKey === ANOMALY_RULE_KEY) return anomalyText(a) ?? fallback;
  // An alert on a user's own metric (ADR-236) carries its sentence: the metric's words, its
  // owner and its value as the page writes it.
  if (d.own === true && str(d.title)) return { title: str(d.title)!, why: str(d.why) };
  // A module's rule (ADR-233) writes its own sentence from fixed templates.
  if (isModuleRule(a.ruleKey) && str(d.title)) return { title: str(d.title)!, why: str(d.why) };
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
    // Certificates and scheduled jobs (0.10, ADR-225): what, where, since when, what to do.
    case 'cert.expiring': {
      const left = num(d.value) ?? 0;
      const days = Math.round(Math.abs(left) / 86_400);
      const when = str(d.notAfter) ? new Date(str(d.notAfter)!).toUTCString().slice(5, 16) : null;
      return {
        title:
          left < 0
            ? `The certificate for ${l.certificate} expired${days >= 1 ? ` ${plural(days, '1 day', '{n} days')} ago` : ''}`
            : `The certificate for ${l.certificate} expires in ${plural(days, '1 day', '{n} days')}`,
        why: join(
          when && `${left < 0 ? 'expired' : 'expires'} ${when}`,
          Array.isArray(d.servedAt) && d.servedAt.length > 0
            ? `served at ${(d.servedAt as string[]).join(', ')}`
            : null,
          str(d.issuer) && `issued by ${str(d.issuer)}`,
          'renew it, or check the job that renews it',
        ),
      };
    }
    case 'cert.problem':
      return l.problem === 'name'
        ? {
            title: `The certificate for ${l.certificate} doesn't cover a name it is served for`,
            why: join(
              Array.isArray(d.mismatch) && d.mismatch.length > 0
                ? `asked for ${(d.mismatch as string[]).join(', ')}`
                : null,
              'browsers refuse it for that name',
            ),
          }
        : {
            title: `The certificate chain for ${l.certificate} is incomplete`,
            why: join(
              "the intermediate certificate isn't sent",
              'some clients and browsers refuse it: serve the full chain',
            ),
          };
    case 'job.failed': {
      const job = l.job ?? l.workload ?? '';
      const n = num(d.streak) ?? Math.round(num(d.value) ?? 1);
      const where = l.node ? ` on ${l.node}` : l.namespace ? ` in ${l.namespace}` : '';
      return {
        title: n > 1 ? `${job} failed ${n} times in a row${where}` : `${job} failed${where}`,
        why: join(
          num(d.exitCode) !== null && `exit code ${num(d.exitCode)}`,
          str(d.lastGood) ? `last good run ${ago(d.lastGood, a.now)}` : 'no good run seen yet',
          "its runs are on the job's page",
        ),
      };
    }
    case 'job.missed': {
      const job = l.job ?? l.workload ?? '';
      const where = l.node ? ` on ${l.node}` : l.namespace ? ` in ${l.namespace}` : '';
      return {
        title: `${job} missed its run${where}`,
        why: join(
          str(d.expectedAt) && `expected ${ago(d.expectedAt, a.now)}`,
          str(d.schedule) && `schedule ${str(d.schedule)}`,
          l.node ? 'the server and the agent were up' : null,
        ),
      };
    }
    case 'job.slow': {
      const job = l.job ?? l.workload ?? '';
      const where = l.node ? ` on ${l.node}` : l.namespace ? ` in ${l.namespace}` : '';
      return {
        title: d.running
          ? `${job} is running far longer than usual${where}`
          : `${job} ran far longer than usual${where}`,
        why: join(
          num(d.seconds) !== null &&
            `${d.running ? 'running for' : 'took'} ${humanDuration(num(d.seconds)!)}`,
          num(d.usualSeconds) !== null && `usually ${humanDuration(num(d.usualSeconds)!)}`,
        ),
      };
    }
    // Servers (ADR-208): a systemd service (unit) or a process group (group), on l.node.
    case 'server.unit.failed':
      return {
        title: `${l.unit} failed on ${l.node}`,
        why: join('systemd marked it failed', str(d.reason)),
      };
    case 'server.unit.crashloop':
    case 'server.process.crashloop': {
      const who = a.ruleKey === 'server.unit.crashloop' ? l.unit : l.group;
      return {
        title: `${who} is crash-looping on ${l.node}`,
        why: join(
          a.ruleKey === 'server.unit.crashloop'
            ? `${Math.round(num(d.value) ?? 0)} crashes or restarts in 10 min`
            : `${Math.round(num(d.value) ?? 0)} failed exits in 10 min`,
          a.ruleKey === 'server.process.crashloop' && l.unit ? `in ${l.unit}` : null,
        ),
      };
    }
    case 'server.unit.oom':
    case 'server.process.oom': {
      const who = a.ruleKey === 'server.unit.oom' ? l.unit : l.group;
      return {
        title: `${who} was killed for using too much memory on ${l.node}`,
        why: plural(
          Math.round(num(d.value) ?? 1),
          '1 OOM kill in 10 min',
          '{n} OOM kills in 10 min',
        ),
      };
    }
    case 'server.process.gone':
      return {
        title: `${l.group} has no process left on ${l.node}`,
        why: join(
          'every instance exited',
          l.unit ? `in ${l.unit}` : 'not under systemd: nothing restarts it',
        ),
      };
    case 'server.unit.memory':
      return {
        title: `${l.unit} is near its memory limit on ${l.node}`,
        why: join(`${pct(d.value)} of MemoryMax`, `threshold ${pct(d.threshold)}`),
      };
    case 'server.unit.throttling':
      return {
        title: `${l.unit} is CPU-throttled on ${l.node}`,
        why: join(
          `throttled ${pct(Math.min(1, num(d.value) ?? 0))} of the time at its CPUQuota`,
          `threshold ${pct(d.threshold)}`,
        ),
      };
    case 'server.memory.high':
      return {
        title: `Memory on ${l.node} is at ${pct(d.value)}`,
        why: join(
          `threshold ${pct(d.threshold)}`,
          num(d.forSeconds) ? `for ${humanDuration(num(d.forSeconds)!)}` : null,
        ),
      };
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
          `${l.container}: throttled ${pct(Math.min(1, num(d.value) ?? 0))} of the time`,
          `threshold ${pct(d.threshold)}`,
        ),
      };
    case 'docker.container.throttling':
      return {
        title: `${l.container} is CPU-throttled`,
        why: join(
          `throttled ${pct(Math.min(1, num(d.value) ?? 0))} of the time`,
          `threshold ${pct(d.threshold)}`,
        ),
      };
  }
  if (a.metric && num(d.value) !== null) {
    const unit = metricUnit(a.metric);
    const who =
      l.service_name ??
      l.workload ??
      l.pod ??
      l.container ??
      l.node ??
      l.pvc ??
      l.namespace ??
      a.cluster.name;
    return {
      title: `${a.ruleName}: ${who} at ${formatMetricValue(num(d.value)!, unit)}`,
      why: join(
        num(d.threshold) !== null &&
          `${d.op === '<' ? 'below' : 'above'} ${formatMetricValue(num(d.threshold)!, unit)}`,
        num(d.forSeconds) ? `for ${humanDuration(num(d.forSeconds)!)}` : null,
        // A service: what its collector last said (ADR-137).
        str(d.reason),
      ),
    };
  }
  return fallback;
}

/** "orders", "shop/api" (a Compose service), "redis": the source of an egress alert. */
export function egressSource(l: Record<string, string>): string {
  if (l.workload) return l.workload;
  if (l.compose_service)
    return l.compose_project ? `${l.compose_project}/${l.compose_service}` : l.compose_service;
  return l.container ?? '';
}

/** "08:12 UTC": messages write times in UTC, as the alert's other facts do. */
function utcClock(iso: unknown): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(11, 16)} UTC`;
}

const mib = (b: number) => `${Math.round(b / 2 ** 20)} MiB`;

/**
 * The egress alerts' words (ADR-187, ADR-095): what, where, since when. The destination is the
 * `dst` label (a DNS name or a raw network) with its port; it is data, so it goes in `code`.
 */
function egressText(a: AlertTextInput): AlertText | null {
  const l = a.labels;
  const d = a.details;
  const who = egressSource(l);
  const dest = str(d.destination) ?? l.destination;
  if (!who || !dest) return null;
  const port = num(d.port) ?? (l.port ? Number(l.port) : null);
  const target = port ? `${dest}:${port}` : dest;
  const docker = !l.workload;
  switch (a.ruleKey) {
    case 'egress.new_destination': {
      const others = num(d.others);
      const count = num(d.count) ?? 1;
      // One alert per source (ADR-229): "updater started talking to 24 new destinations".
      if (count > 1) {
        const added = (Array.isArray(d.added) ? d.added : []).filter(
          (x): x is string => typeof x === 'string',
        );
        // A repeat message names what joined since the last one (at most 5, then a count).
        const shown = added.slice(0, 5);
        const rest = added.length - shown.length;
        return {
          title: `${who} started talking to ${count} new destinations`,
          why: join(
            utcClock(d.firstSeen) && `newest ${target} at ${utcClock(d.firstSeen)}`,
            shown.length > 0 &&
              `new since the last message: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
          ),
          code: [...new Set([target, ...shown])],
        };
      }
      return {
        title: `${who} started talking to ${target}`,
        why: join(
          utcClock(d.firstSeen) && `first connection at ${utcClock(d.firstSeen)}`,
          others === 0
            ? `nothing else in the ${docker ? 'fleet' : 'cluster'} talks to it`
            : others !== null &&
                plural(
                  others,
                  `1 other ${docker ? 'container' : 'workload'} talks to it`,
                  `{n} other ${docker ? 'containers' : 'workloads'} talk to it`,
                ),
        ),
        code: [target],
      };
    }
    case 'egress.raw_ip':
      return {
        title: `${who} connects to ${target} by IP address`,
        why: join(
          num(d.connections) !== null &&
            plural(num(d.connections)!, '1 connection in 10 min', '{n} connections in 10 min'),
          'no DNS name behind it',
        ),
        code: [target],
      };
    case 'egress.large_upload_new':
      return {
        title: `${who} sent ${mib(num(d.sentBytes) ?? 0)} to ${target}`,
        why: join(
          'in the last hour',
          num(d.threshold) !== null && `threshold ${mib(num(d.threshold)!)}`,
          utcClock(d.firstSeen) && `first seen at ${utcClock(d.firstSeen)}`,
        ),
        code: [target],
      };
  }
  return null;
}

/**
 * An anomaly alert's words (ADR-200, ADR-095): the title "checkout (shop): p95 response time
 * unusual for a Tuesday at 14:00 UTC" and the line "usual for Tuesday 14:00 UTC: 120–180 ms;
 * now 2.4 s". Docker names the container (or its Compose service) here and the host in the
 * message's "where". The buckets are UTC hours, so the words say UTC (ADR-196).
 */
function anomalyText(a: AlertTextInput): AlertText | null {
  const d = a.details;
  const key = str(d.key) ?? a.labels.metric;
  const bucket = num(d.bucket);
  const low = num(d.usualLow);
  const high = num(d.usualHigh);
  const value = num(d.value);
  if (!key || bucket === null || low === null || high === null || value === null) return null;
  const unit = str(d.unit) ?? metricUnit(key) ?? 'count';
  const who = str(d.subject) ?? subjectWords(a.labels);
  const { day, hour } = bucketWords(bucket);
  return {
    title: `${who}: ${metricWords(key, str(d.peer))} unusual for a ${day} at ${hour} UTC`,
    why: `usual for ${day} ${hour} UTC: ${rangeWords(low, high, unit)}; now ${valueWords(value, unit)}`,
  };
}

/**
 * One row of What changed around an alert, as the alert email's line (ADR-220): "api:
 * memory 1.2 GiB, usually 300–400 MiB, since 14:01 UTC". Names are the cluster's data.
 */
export function changeLine(row: {
  subject: Record<string, string>;
  key: string;
  unit?: string | null;
  peer?: string | null;
  usualLow: number;
  usualHigh: number;
  value: number;
  since: string;
}): string {
  const unit = row.unit || metricUnit(row.key) || 'count';
  return `${subjectWords(row.subject)}: ${metricWords(row.key, row.peer)} ${valueWords(row.value, unit)}, usually ${rangeWords(row.usualLow, row.usualHigh, unit)}, since ${row.since.slice(11, 16)} UTC`;
}
