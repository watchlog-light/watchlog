// SPDX-License-Identifier: AGPL-3.0-only
// Applications' Certificates and Scheduled jobs tabs (0.10, ADR-221): what each row, tile and
// sentence says, as i18n keys with their values. Pure, so the words are tested once here.
import type { JobRun, ScheduledJob, TlsCertificate } from '@watchlog/api-types';

/** A job as the list and its own page both have it (the list adds its last 14 runs). */
export type JobBase = Omit<ScheduledJob, 'recent'>;

export interface Words {
  key: string;
  values?: Record<string, string | number>;
}

export type Tone = 'crit' | 'warn' | 'ok' | 'info' | 'muted';

const DAY = 86_400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "17 Nov 2026": a day, in the reader's time zone. */
export const day = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** "4 s", "6 min 12 s", "2 h 5 min": a run's duration. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const m = Math.round(s / 60);
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

// ------------------------------------------------------------------------- certificates

export const CERT_TONE: Record<TlsCertificate['status'], Tone> = {
  expired: 'crit',
  expires_soon: 'crit',
  expiring: 'warn',
  problem: 'warn',
  ok: 'ok',
};

/** "Expired 2 days ago", "6 days left", "Expires today". */
export function certDays(c: TlsCertificate): Words {
  const d = c.daysLeft;
  if (c.status === 'expired')
    return d === 0
      ? { key: 'certs.days.expiredToday' }
      : { key: 'certs.days.expired', values: { n: -d } };
  if (d === 0) return { key: 'certs.days.today' };
  return { key: 'certs.days.left', values: { n: d } };
}

/** How much of its lifetime a certificate has used, 0–100 (the bar under its days). */
export function lifetimeUsed(c: TlsCertificate, now = Date.now()): number {
  const life = c.notAfter - c.notBefore;
  if (life <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((now / 1000 - c.notBefore) / life) * 100)));
}

/** Its other names: "www.shop.acme.io", "+3 names", or "1 name". */
export function otherNames(c: TlsCertificate): Words {
  const rest = c.names.slice(1);
  if (rest.length === 0) return { key: 'certs.names.one' };
  if (rest.length === 1) return { key: 'certs.names.also', values: { name: rest[0]! } };
  return { key: 'certs.names.more', values: { name: rest[0]!, n: rest.length - 1 } };
}

/**
 * Where it is served, for its row: "nginx.service on app-1 :443" (Servers), "Ingress shop/web",
 * "Service shop/api :443" (Kubernetes); "+2 more" when it is served in several places.
 */
export function servedBy(c: TlsCertificate): Words {
  const e = c.endpoints[0];
  if (!e) return { key: 'certs.served.nowhere' };
  const more = c.endpoints.length - 1;
  const base: Words =
    e.kind === 'Ingress'
      ? { key: 'certs.served.ingress', values: { name: e.workload, host: e.sni ?? '' } }
      : c.node
        ? { key: 'certs.served.server', values: { name: e.workload, server: c.node, port: e.port } }
        : { key: 'certs.served.service', values: { name: e.workload, port: e.port } };
  return more > 0 ? { key: `${base.key}More`, values: { ...base.values, n: more } } : base;
}

/** The renewal column: a failing renewal job first, then what was seen. */
export function renewal(c: TlsCertificate, now = Date.now()): { words: Words; tone: Tone } {
  if (c.renewalJob && c.renewalJob.state === 'failed')
    return {
      words: { key: 'certs.renewal.jobFailing', values: { job: c.renewalJob.name } },
      // Red while it matters now (it expires within 14 days), amber before.
      tone: c.status === 'ok' || c.status === 'problem' ? 'warn' : 'crit',
    };

  if (c.renewedAt !== null && c.renewedDaysBefore !== null)
    return {
      words: {
        key: 'certs.renewal.renews',
        values: {
          n: Math.max(0, Math.round((now / 1000 - c.renewedAt) / DAY)),
          before: Math.round(c.renewedDaysBefore),
        },
      },
      tone: 'muted',
    };
  if (c.chain === 'private' || c.chain === 'self-signed')
    return {
      words: { key: `certs.renewal.${c.chain === 'private' ? 'private' : 'selfSigned'}` },
      tone: 'muted',
    };
  if (c.renewalJob)
    return {
      words: { key: 'certs.renewal.byJob', values: { job: c.renewalJob.name } },
      tone: 'muted',
    };
  if (c.status === 'expiring' || c.status === 'expires_soon')
    return { words: { key: 'certs.renewal.notYet' }, tone: 'warn' };
  return { words: { key: 'certs.renewal.notSeen' }, tone: 'muted' };
}

/** What is wrong besides its expiry, for its page and its row's title. */
export function certProblems(c: TlsCertificate): Words[] {
  const out: Words[] = [];
  if (c.nameMismatch.length > 0)
    out.push({ key: 'certs.problem.name', values: { names: c.nameMismatch.join(', ') } });
  if (c.chain === 'incomplete') out.push({ key: 'certs.problem.chain' });
  return out;
}

export interface CertTiles {
  total: number;
  servers: number;
  expired: TlsCertificate[];
  expiring: TlsCertificate[];
  renewing: number;
}

export function certTiles(list: TlsCertificate[]): CertTiles {
  return {
    total: list.length,
    servers: new Set(list.map((c) => c.node).filter(Boolean)).size,
    expired: list.filter((c) => c.status === 'expired'),
    expiring: list.filter((c) => c.status === 'expires_soon' || c.status === 'expiring'),
    renewing: list.filter((c) => c.renewedAt !== null).length,
  };
}

export type CertFilter = 'all' | 'attention' | 'ok';
export const certNeedsAttention = (c: TlsCertificate) => c.status !== 'ok';

export function filterCerts(list: TlsCertificate[], f: CertFilter, term: string): TlsCertificate[] {
  const q = term.trim().toLowerCase();
  return list.filter(
    (c) =>
      (f === 'all' || (f === 'attention') === certNeedsAttention(c)) &&
      (!q ||
        c.names.some((n) => n.toLowerCase().includes(q)) ||
        c.node.toLowerCase().includes(q) ||
        c.endpoints.some((e) => e.workload.toLowerCase().includes(q))),
  );
}

// ------------------------------------------------------------------------- scheduled jobs

export const JOB_TONE: Record<string, Tone> = {
  failed: 'crit',
  missed: 'warn',
  slow: 'warn',
  running: 'info',
  working: 'ok',
  new: 'info',
  disabled: 'muted',
};

/** A job's short name: a CronJob's without its namespace (shown beside it). */
export function jobName(j: Pick<ScheduledJob, 'kind' | 'name'>): {
  name: string;
  namespace: string | null;
} {
  if (j.kind === 'cronjob' && j.name.includes('/')) {
    const [ns, name] = j.name.split('/', 2);
    return { name: name!, namespace: ns! };
  }
  return { name: j.name, namespace: null };
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_NAMES: Record<string, string> = {
  '0': 'sun',
  '7': 'sun',
  '1': 'mon',
  '2': 'tue',
  '3': 'wed',
  '4': 'thu',
  '5': 'fri',
  '6': 'sat',
  sun: 'sun',
  mon: 'mon',
  tue: 'tue',
  wed: 'wed',
  thu: 'thu',
  fri: 'fri',
  sat: 'sat',
};

/**
 * A schedule in words, for cron's five fields and systemd's normalised OnCalendar; the
 * schedule as written when it says something these don't cover.
 */
export function scheduleWords(spec: string): Words {
  const s = spec.trim().replace(/^(CRON_TZ|TZ)=\S+\s+/, '');
  const macro: Record<string, string> = {
    '@hourly': 'hourly',
    '@daily': 'daily',
    '@midnight': 'daily',
    '@weekly': 'weekly',
    '@monthly': 'monthly',
    '@yearly': 'yearly',
    '@annually': 'yearly',
    hourly: 'hourly',
    daily: 'daily',
    weekly: 'weekly',
    monthly: 'monthly',
  };
  if (macro[s]) return { key: `jobs.schedule.${macro[s]}` };
  const f = s.split(/\s+/);
  if (f.length === 5) {
    const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
    const every = /^\*\/(\d+)$/;
    if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
      return { key: 'jobs.schedule.everyMinute' };
    if (every.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
      return { key: 'jobs.schedule.everyMinutes', values: { n: Number(every.exec(min)![1]) } };
    if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
      return { key: 'jobs.schedule.hourlyAt', values: { min: pad(Number(min)) } };
    if (/^\d+$/.test(min) && every.test(hour) && dom === '*' && mon === '*' && dow === '*')
      return {
        key: 'jobs.schedule.everyHours',
        values: { n: Number(every.exec(hour)![1]), min: pad(Number(min)) },
      };
    if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
      const at = `${pad(Number(hour))}:${pad(Number(min))}`;
      if (dom === '*' && mon === '*' && dow === '*')
        return { key: 'jobs.schedule.dailyAt', values: { at } };
      if (dom === '*' && mon === '*' && DAY_NAMES[dow.toLowerCase()])
        return { key: `jobs.schedule.weekly.${DAY_NAMES[dow.toLowerCase()]}`, values: { at } };
      if (dom === '*' && mon === '*' && /^(1-5|mon-fri)$/i.test(dow))
        return { key: 'jobs.schedule.weekdaysAt', values: { at } };
      if (/^\d+$/.test(dom) && mon === '*' && dow === '*')
        return { key: 'jobs.schedule.monthlyAt', values: { day: Number(dom), at } };
    }
    return { key: 'jobs.schedule.raw', values: { spec: s } };
  }
  // systemd: "*-*-* 03:00:00", "*-*-* *:00:00", "*-*-* *:0/15:00", "Mon *-*-* 00:00:00"
  const m = /^(?:(\w{3}) )?\*-\*-\* (\*|[\d,]+):(\d+|0\/\d+|\*):\d+$/.exec(s);
  if (m) {
    const [, wd, h, mi] = m as unknown as [string, string | undefined, string, string];
    if (h === '*' && mi.startsWith('0/') && !wd)
      return { key: 'jobs.schedule.everyMinutes', values: { n: Number(mi.slice(2)) } };
    if (h === '*' && /^\d+$/.test(mi) && !wd)
      return { key: 'jobs.schedule.hourlyAt', values: { min: pad(Number(mi)) } };
    if (/^\d+$/.test(h) && /^\d+$/.test(mi)) {
      const at = `${pad(Number(h))}:${pad(Number(mi))}`;
      if (!wd) return { key: 'jobs.schedule.dailyAt', values: { at } };
      if (DAY_NAMES[wd.toLowerCase()])
        return { key: `jobs.schedule.weekly.${DAY_NAMES[wd.toLowerCase()]}`, values: { at } };
    }
    if (/^\d+(,\d+)+$/.test(h) && /^\d+$/.test(mi) && !wd)
      return {
        key: 'jobs.schedule.timesADay',
        values: {
          n: h.split(',').length,
          at: h
            .split(',')
            .map((x) => `${pad(Number(x))}:${pad(Number(mi))}`)
            .join(', '),
        },
      };
  }
  return { key: 'jobs.schedule.raw', values: { spec: s } };
}

/** Its kind as the row says it: "systemd timer", "cron · /etc/cron.d/backup", "CronJob". */
export function jobKind(j: JobBase): Words {
  if (j.kind === 'timer') return { key: 'jobs.kind.timer' };
  if (j.kind === 'cronjob')
    return { key: 'jobs.kind.cronjob', values: { namespace: jobName(j).namespace ?? '' } };
  return j.source === 'user crontab'
    ? { key: 'jobs.kind.cronUser' }
    : { key: 'jobs.kind.cron', values: { file: j.source } };
}

/** The last run, for its row: "Failed, exit code 2", "Running for 41 min", "Succeeded". */
export function lastRunWords(j: JobBase, now = Date.now()): Words {
  const r = j.lastRun;
  if (!r)
    return j.state === 'disabled' ? { key: 'jobs.last.disabled' } : { key: 'jobs.last.never' };
  if (r.result === 'running')
    return { key: 'jobs.last.running', values: { d: duration(now / 1000 - r.startedAt) } };
  if (r.result === 'failed')
    return r.code !== null
      ? { key: 'jobs.last.failedCode', values: { code: r.code } }
      : { key: 'jobs.last.failed' };
  if (r.result === 'unknown') return { key: 'jobs.last.ran' };
  return { key: 'jobs.last.ok' };
}

/** What needs attention, for its row and its page. */
export function jobProblem(j: JobBase): { words: Words; tone: Tone } {
  switch (j.state) {
    case 'failed':
      return {
        words:
          j.failedStreak > 1
            ? j.lastGoodAt
              ? {
                  key: 'jobs.problem.failedStreakGood',
                  values: { n: j.failedStreak, date: day(j.lastGoodAt) },
                }
              : { key: 'jobs.problem.failedStreak', values: { n: j.failedStreak } }
            : { key: 'jobs.problem.failedOnce' },
        tone: 'crit',
      };
    case 'missed':
      return {
        words: {
          key: `jobs.problem.missed.${j.missedWhy ?? 'not-run'}`,
          values: { n: Math.max(1, j.missedRuns) },
        },
        tone: 'warn',
      };
    case 'slow': {
      const ran =
        j.lastRun?.seconds ?? (j.lastRun ? Date.now() / 1000 - j.lastRun.startedAt : null);
      const times = j.usualSeconds && ran ? Math.max(2, Math.round(ran / j.usualSeconds)) : null;
      return {
        words: times
          ? { key: 'jobs.problem.slowTimes', values: { n: times } }
          : { key: 'jobs.problem.slow' },
        tone: 'warn',
      };
    }
    case 'disabled':
      return { words: { key: 'jobs.problem.disabled' }, tone: 'muted' };
    case 'new':
      return { words: { key: 'jobs.problem.new' }, tone: 'muted' };
    default:
      return { words: { key: 'jobs.problem.none' }, tone: 'muted' };
  }
}

export interface RunBar {
  x: number;
  y: number;
  h: number;
  tone: 'ok' | 'crit' | 'warn' | 'info' | 'muted';
}

/**
 * The last 14 runs as small bars, oldest on the left: a good run full height green, a failed
 * one red, a slow one (3 times its usual) taller amber, a running one blue, an unknown result
 * (cron's log) grey.
 */
export function runBars(runs: JobRun[], usual: number | null, slots = 14): RunBar[] {
  const ordered = [...runs].slice(0, slots).reverse();
  return ordered.map((r, i) => {
    const slow =
      usual !== null && r.seconds !== null && r.seconds > 3 * usual && r.seconds > usual + 300;
    const tone: RunBar['tone'] =
      r.result === 'failed'
        ? 'crit'
        : r.result === 'running'
          ? 'info'
          : r.result === 'unknown'
            ? 'muted'
            : slow
              ? 'warn'
              : 'ok';
    return { x: i * 10.6, y: slow ? 0 : 4, h: slow ? 18 : 14, tone };
  });
}

export interface JobTiles {
  total: number;
  timers: number;
  cron: number;
  cronjobs: number;
  failing: ScheduledJob[];
  missedOrSlow: ScheduledJob[];
}

export function jobTiles(list: ScheduledJob[]): JobTiles {
  return {
    total: list.length,
    timers: list.filter((j) => j.kind === 'timer').length,
    cron: list.filter((j) => j.kind === 'cron').length,
    cronjobs: list.filter((j) => j.kind === 'cronjob').length,
    failing: list.filter((j) => j.state === 'failed'),
    missedOrSlow: list.filter((j) => j.state === 'missed' || j.state === 'slow'),
  };
}

export type JobFilter = 'all' | 'attention' | 'timer' | 'cron' | 'cronjob';
export const jobNeedsAttention = (j: ScheduledJob) =>
  ['failed', 'missed', 'slow'].includes(j.state);

export function filterJobs(list: ScheduledJob[], f: JobFilter, term: string): ScheduledJob[] {
  const q = term.trim().toLowerCase();
  return list.filter(
    (j) =>
      (f === 'all' || (f === 'attention' ? jobNeedsAttention(j) : j.kind === f)) &&
      (!q || j.name.toLowerCase().includes(q) || j.node.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------- sidebar badges (ADR-230)

export interface NavBadge {
  /** How many items need a look. */
  count: number;
  tone: 'crit' | 'warn';
  /** Its accessible name, as Words ("1 certificate expiring"). */
  words: Words;
}

/**
 * The Certificates entry's badge (0.13.0): red when one is expired, expires within 3 days or
 * has a problem (a name mismatch, an incomplete chain); amber when one expires within 14 days;
 * none otherwise. The count is every certificate that needs a look.
 */
export function certBadge(list: Pick<TlsCertificate, 'status'>[]): NavBadge | null {
  const red = list.filter(
    (c) => c.status === 'expired' || c.status === 'expires_soon' || c.status === 'problem',
  ).length;
  const amber = list.filter((c) => c.status === 'expiring').length;
  if (red + amber === 0) return null;
  return red > 0
    ? {
        count: red + amber,
        tone: 'crit',
        words: { key: 'nav.badge.certsAttention', values: { n: red + amber } },
      }
    : {
        count: amber,
        tone: 'warn',
        words: { key: 'nav.badge.certsExpiring', values: { n: amber } },
      };
}

/** The Scheduled jobs entry's badge (0.13.0): red for every job failing, missed or slow. */
export function jobBadge(list: Pick<ScheduledJob, 'state'>[]): NavBadge | null {
  const n = list.filter(
    (j) => j.state === 'failed' || j.state === 'missed' || j.state === 'slow',
  ).length;
  if (n === 0) return null;
  const failing = list.filter((j) => j.state === 'failed').length;
  return {
    count: n,
    tone: 'crit',
    words:
      failing === n
        ? { key: 'nav.badge.jobsFailing', values: { n } }
        : { key: 'nav.badge.jobsAttention', values: { n } },
  };
}

/**
 * A certificate's status line in search (0.13.0): "expires in 9 days · Ingress shop/api", "expired
 * 2 days ago · nginx on app-1 :443"; its colour when it needs attention.
 */
export function certStatusLine(c: TlsCertificate): { words: Words[]; tone?: 'warn' | 'crit' } {
  const d = c.daysLeft;
  const expiry: Words =
    d < 0
      ? { key: 'palette.status.expired', values: { n: -d } }
      : d === 0
        ? { key: 'palette.status.expiresToday' }
        : { key: 'palette.status.expires', values: { n: d } };
  const tone = CERT_TONE[c.status];
  return {
    words: [expiry, servedBy(c)],
    tone: tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : undefined,
  };
}

/** A scheduled job's status line in search: "Failing · daily at 03:00 · worker-1". */
export function jobStatusLine(j: ScheduledJob): { words: Words[]; tone?: 'warn' | 'crit' } {
  const tone = JOB_TONE[j.state];
  const words: Words[] = [{ key: `jobs.status.${j.state}` }, scheduleWords(j.schedule)];
  return { words, tone: tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : undefined };
}
