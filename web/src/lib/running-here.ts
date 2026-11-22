// SPDX-License-Identifier: AGPL-3.0-only
// The Overview's "Running here" row (0.13.0, ADR-230): three cards (Services, Certificates,
// Scheduled jobs), each with its count and its problems in the header, up to three rows and a
// footer with one fact. In each platform's words: on a Server fleet "nginx :443 on app-1",
// "systemd timer on worker-1", "cron on db-1 · 0 4 * * *"; on Kubernetes Ingresses, Services
// and CronJobs. Pure: the cards give the lists.
import type { Application, ScheduledJob, TlsCertificate } from '@watchlog/api-types';
import {
  jobKind,
  jobNeedsAttention,
  jobProblem,
  scheduleWords,
  type Tone,
  type Words,
} from './certs-jobs';

export const ROWS = 3;

export interface RowLine {
  words: Words[];
  tone: Tone;
}

// ---- Services ----------------------------------------------------------------------------

const HEALTH_ORDER: Record<Application['health'], number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  ok: 3,
};
export const serviceProblem = (a: Application) => a.health === 'critical' || a.health === 'warning';

/** This cluster's or fleet's services, problems first, then by name. */
export function servicesHere(apps: Application[], clusterId: string): Application[] {
  return apps
    .filter((a) => a.cluster.id === clusterId)
    .sort(
      (a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name),
    );
}

// ---- Certificates ------------------------------------------------------------------------

/** The soonest to expire first; a certificate problem counts as soon as 14 days. */
export function soonestCerts(list: TlsCertificate[], n = ROWS): TlsCertificate[] {
  const rank = (c: TlsCertificate) =>
    c.status === 'problem' ? Math.min(c.daysLeft, 14) : c.daysLeft;
  return [...list]
    .sort((a, b) => rank(a) - rank(b) || a.names[0]!.localeCompare(b.names[0]!))
    .slice(0, n);
}

/** Where it is served: "nginx :443 on app-1", "Ingress shop/api", "Service ops/grafana :443". */
export function certWhere(c: TlsCertificate): Words {
  const e = c.endpoints[0];
  if (!e) return { key: 'certs.served.nowhere' };
  if (c.node)
    return {
      key: 'runningHere.certs.server',
      values: { name: e.workload, port: e.port, server: c.node },
    };
  if (e.kind === 'Ingress')
    return { key: 'runningHere.certs.ingress', values: { name: e.workload } };
  return { key: 'runningHere.certs.service', values: { name: e.workload, port: e.port } };
}

/**
 * The row's second line: where, then the renewal. A failing renewal job is said first and in
 * red ("certbot.timer is failing"); otherwise whether it renews itself.
 */
export function certLine(c: TlsCertificate): RowLine {
  const where = certWhere(c);
  if (c.renewalJob?.state === 'failed')
    return {
      words: [where, { key: 'runningHere.certs.jobFailing', values: { job: c.renewalJob.name } }],
      tone: 'crit',
    };
  if (c.nameMismatch.length > 0 || c.chain === 'incomplete')
    return {
      words: [
        where,
        { key: c.chain === 'incomplete' ? 'runningHere.certs.chain' : 'runningHere.certs.name' },
      ],
      tone: 'warn',
    };
  const renew: Words =
    c.renewedAt !== null
      ? { key: 'runningHere.certs.renews' }
      : c.chain === 'private'
        ? { key: 'runningHere.certs.private' }
        : c.chain === 'self-signed'
          ? { key: 'runningHere.certs.selfSigned' }
          : { key: 'runningHere.certs.notSeen' };
  return { words: [where, renew], tone: 'muted' };
}

/** The header's problem count: "1 expiring", "2 need attention", or nothing. */
export function certHeader(list: TlsCertificate[]): { words: Words; tone: Tone } | null {
  const expired = list.filter((c) => c.status === 'expired').length;
  const expiring = list.filter((c) => c.status === 'expiring' || c.status === 'expires_soon');
  const other = list.filter((c) => c.status === 'problem').length;
  const soon = expiring.filter((c) => c.status === 'expires_soon').length;
  if (expired + expiring.length + other === 0) return null;
  if (expired === 0 && other === 0)
    return {
      words: { key: 'runningHere.certs.expiring', values: { n: expiring.length } },
      tone: soon > 0 ? 'crit' : 'warn',
    };
  const n = expired + expiring.length + other;
  return {
    words: { key: 'runningHere.attention', values: { n } },
    tone: expired + soon > 0 ? 'crit' : 'warn',
  };
}

// ---- Scheduled jobs ----------------------------------------------------------------------

const JOB_ORDER: Record<string, number> = { failed: 0, missed: 1, slow: 2 };

/** Problems first (failing, missed, slow), then the soonest next run. */
export function topJobs(list: ScheduledJob[], n = ROWS): ScheduledJob[] {
  return [...list]
    .sort(
      (a, b) =>
        (JOB_ORDER[a.state] ?? 9) - (JOB_ORDER[b.state] ?? 9) ||
        (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, n);
}

/**
 * The row's second line. A problem in its words (red or amber); otherwise where and when:
 * "systemd timer on worker-1 · daily at 03:00", "cron on db-1 · 0 4 * * *", "CronJob in shop ·
 * every hour at :20".
 */
export function jobLine(j: ScheduledJob): RowLine {
  if (jobNeedsAttention(j)) {
    const p = jobProblem(j);
    return { words: [p.words], tone: p.tone };
  }
  const schedule =
    j.kind === 'cron' && j.node
      ? { key: 'runningHere.jobs.spec', values: { spec: j.schedule } }
      : scheduleWords(j.schedule);
  const where: Words =
    j.kind === 'timer'
      ? j.node
        ? { key: 'runningHere.jobs.timerOn', values: { server: j.node } }
        : { key: 'jobs.kind.timer' }
      : j.kind === 'cron'
        ? j.node
          ? { key: 'runningHere.jobs.cronOn', values: { server: j.node } }
          : { key: 'runningHere.jobs.cron' }
        : jobKind(j);
  return { words: [where, schedule], tone: 'muted' };
}

/** The header's problem count: "1 failing", "2 need attention", or nothing. */
export function jobHeader(list: ScheduledJob[]): { words: Words; tone: Tone } | null {
  const failing = list.filter((j) => j.state === 'failed').length;
  const other = list.filter((j) => j.state === 'missed' || j.state === 'slow').length;
  if (failing + other === 0) return null;
  if (other === 0)
    return { words: { key: 'runningHere.jobs.failing', values: { n: failing } }, tone: 'crit' };
  return {
    words: { key: 'runningHere.attention', values: { n: failing + other } },
    tone: failing > 0 ? 'crit' : 'warn',
  };
}
