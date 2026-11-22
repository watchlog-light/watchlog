// SPDX-License-Identifier: AGPL-3.0-only
// Applications' Certificates and Scheduled jobs tabs (0.10): the words each row, tile and
// sentence says, for Servers and Kubernetes, and every key they use exists in en.json.
import type { JobRun, ScheduledJob, TlsCertificate } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { createAppI18n } from '@/i18n';
import {
  certDays,
  certStatusLine,
  jobStatusLine,
  certTiles,
  duration,
  filterCerts,
  filterJobs,
  jobKind,
  jobName,
  jobProblem,
  jobTiles,
  lastRunWords,
  lifetimeUsed,
  otherNames,
  renewal,
  runBars,
  scheduleWords,
  servedBy,
  type Words,
} from '@/lib/certs-jobs';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const S = NOW / 1000;
const DAY = 86_400;

const cert = (over: Partial<TlsCertificate> = {}): TlsCertificate => ({
  id: 'aaaaaaaaaaaaaaaa',
  node: 'app-1',
  names: ['shop.acme.io', 'www.shop.acme.io'],
  subject: 'shop.acme.io',
  issuer: 'R11',
  issuerOrg: "Let's Encrypt",
  notBefore: S - 88 * DAY,
  notAfter: S + 2 * DAY,
  daysLeft: 2,
  status: 'expires_soon',
  chain: 'complete',
  nameMismatch: [],
  keyType: 'ECDSA',
  keyBits: 256,
  fingerprint: 'a'.repeat(64),
  endpoints: [{ kind: 'Service', workload: 'nginx.service', port: 443, proto: 'tls', sni: null }],
  firstSeen: S - 60 * DAY,
  renewedDaysBefore: null,
  renewedAt: null,
  renewalJob: null,
  ...over,
});

const run = (over: Partial<JobRun> = {}): JobRun => ({
  startedAt: S - 3600,
  endedAt: S - 3596,
  seconds: 4,
  code: 0,
  result: 'success',
  ...over,
});

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: '1111111111111111',
  node: 'worker-1',
  kind: 'timer',
  name: 'backup.timer',
  unit: 'backup.service',
  schedule: '*-*-* 03:00:00',
  source: '',
  enabled: true,
  persistent: true,
  randomDelaySec: 0,
  nextAt: S + 3600,
  everySec: DAY,
  state: 'working',
  failedStreak: 0,
  lastGoodAt: S - DAY,
  missedRuns: 0,
  missedWhy: null,
  missedAt: null,
  usualSeconds: 4,
  frequent: false,
  lastRun: run(),
  updatedAt: S,
  recent: [run()],
  ...over,
});

const i18n = createAppI18n();
const say = (w: Words) => {
  expect(i18n.global.te(w.key), w.key).toBe(true);
  const out = i18n.global.t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
  expect(out).not.toMatch(/\{|undefined|null/);
  return out;
};

describe('certificates', () => {
  it('days, names, where it is served (Servers and Kubernetes) and its lifetime', () => {
    expect(say(certDays(cert()))).toBe('2 days left');
    expect(say(certDays(cert({ status: 'expired', daysLeft: -2 })))).toBe('Expired 2 days ago');
    expect(say(certDays(cert({ status: 'expired', daysLeft: 0 })))).toBe('Expired today');
    expect(say(otherNames(cert()))).toBe('www.shop.acme.io');
    expect(say(otherNames(cert({ names: ['a', 'b', 'c', 'd'] })))).toBe('b and 2 more');
    expect(say(otherNames(cert({ names: ['a'] })))).toBe('1 name');
    expect(say(servedBy(cert()))).toBe('nginx.service on app-1 :443');
    expect(
      say(
        servedBy(
          cert({
            node: '',
            endpoints: [
              {
                kind: 'Ingress',
                workload: 'shop/web',
                port: 443,
                proto: 'tls',
                sni: 'shop.acme.io',
              },
              { kind: 'Service', workload: 'shop/web', port: 443, proto: 'tls', sni: null },
            ],
          }),
        ),
      ),
    ).toBe('Ingress shop/web (shop.acme.io), +1 more');
    expect(
      say(
        servedBy(
          cert({
            node: '',
            endpoints: [
              {
                kind: 'Service',
                workload: 'default/kubernetes',
                port: 443,
                proto: 'tls',
                sni: null,
              },
            ],
          }),
        ),
      ),
    ).toBe('Service default/kubernetes :443');
    expect(lifetimeUsed(cert(), NOW)).toBe(98);
  });

  it('renewal: a failing job first, then a renewal seen, a private CA, not yet', () => {
    const failing = renewal(
      cert({ renewalJob: { id: 'x', name: 'certbot.timer', state: 'failed' } }),
      NOW,
    );
    expect([say(failing.words), failing.tone]).toEqual([
      'Its renewal job certbot.timer is failing',
      'crit',
    ]);
    expect(
      say(
        renewal(cert({ status: 'ok', renewedAt: S - 32 * DAY, renewedDaysBefore: 30 }), NOW).words,
      ),
    ).toBe('Renews itself; last time 32 days ago, 30 days before expiry');
    expect(say(renewal(cert({ chain: 'private', status: 'ok' }), NOW).words)).toBe(
      'Private CA: renewed by whoever runs it',
    );
    expect(renewal(cert(), NOW).tone).toBe('warn');
  });

  it('tiles and filters', () => {
    const list = [
      cert(),
      cert({ id: 'b', status: 'expired', names: ['old.acme.io'], node: 'app-2' }),
      cert({ id: 'c', status: 'ok', names: ['ok.acme.io'], renewedAt: S, renewedDaysBefore: 30 }),
    ];
    const t = certTiles(list);
    expect([t.total, t.servers, t.expired.length, t.expiring.length, t.renewing]).toEqual([
      3, 2, 1, 1, 1,
    ]);
    expect(filterCerts(list, 'attention', '').map((c) => c.id)).toEqual(['aaaaaaaaaaaaaaaa', 'b']);
    expect(filterCerts(list, 'all', 'app-2').map((c) => c.id)).toEqual(['b']);
  });
});

describe('scheduled jobs', () => {
  it('schedules in words: cron, systemd, macros; as written when not covered', () => {
    const cases: [string, string][] = [
      ['*/5 * * * *', 'Every 5 minutes'],
      ['* * * * *', 'Every minute'],
      ['15 * * * *', 'Every hour at :15'],
      ['0 */6 * * *', 'Every 6 hours at :00'],
      ['30 2 * * *', 'Every day at 02:30'],
      ['0 4 * * sun', 'Every Sunday at 04:00'],
      ['0 9 * * 1-5', 'Weekdays at 09:00'],
      ['0 5 1 * *', 'Every month on day 1 at 05:00'],
      ['@daily', 'Every day at midnight'],
      ['*-*-* 03:00:00', 'Every day at 03:00'],
      ['*-*-* *:00:00', 'Every hour at :00'],
      ['*-*-* *:0/15:00', 'Every 15 minutes'],
      ['Mon *-*-* 00:00:00', 'Every Monday at 00:00'],
      ['*-*-* 06,18:00:00', '2 times a day (06:00, 18:00)'],
      ['CRON_TZ=Europe/Berlin 0 3 * * *', 'Every day at 03:00'],
      ['after boot or its last run', 'after boot or its last run'],
      ['0 0 29 2 *', '0 0 29 2 *'],
    ];
    for (const [spec, want] of cases) expect(say(scheduleWords(spec)), spec).toBe(want);
  });

  it('kinds, names, last runs and what needs attention', () => {
    expect(say(jobKind(job()))).toBe('systemd timer');
    expect(say(jobKind(job({ kind: 'cron', source: '/etc/cron.d/backup' })))).toBe(
      'cron · /etc/cron.d/backup',
    );
    expect(say(jobKind(job({ kind: 'cronjob', name: 'shop/nightly' })))).toBe('CronJob in shop');
    expect(jobName(job({ kind: 'cronjob', name: 'shop/nightly' }))).toEqual({
      name: 'nightly',
      namespace: 'shop',
    });
    expect(say(lastRunWords(job({ lastRun: run({ result: 'failed', code: 2 }) })))).toBe(
      'Failed, exit code 2',
    );
    expect(
      say(
        lastRunWords(
          job({
            lastRun: run({
              result: 'running',
              endedAt: null,
              seconds: null,
              startedAt: S - 41 * 60,
            }),
          }),
          NOW,
        ),
      ),
    ).toBe('Running for 41 min');
    const failed = jobProblem(
      job({
        state: 'failed',
        failedStreak: 3,
        lastGoodAt: Date.parse('2026-11-16T03:00:00') / 1000,
      }),
    );
    expect([say(failed.words), failed.tone]).toEqual([
      'Failed 3 times in a row. Last good run: 16 Nov 2026',
      'crit',
    ]);
    expect(
      say(jobProblem(job({ state: 'missed', missedRuns: 2, missedWhy: 'timer-off' })).words),
    ).toBe('Missed 2 runs: the timer is disabled');
    expect(
      say(jobProblem(job({ state: 'missed', missedRuns: 1, missedWhy: 'not-run' })).words),
    ).toBe("Missed a run: it didn't start");
    expect(say(jobProblem(job()).words)).toBe('Nothing');
  });

  it('the last 14 runs as bars, oldest first; tiles and filters', () => {
    const bars = runBars(
      [
        run({ result: 'failed' }),
        run({ seconds: 4000 }),
        run(),
        run({ result: 'running', seconds: null }),
      ],
      60,
    );
    expect(bars.map((b) => b.tone)).toEqual(['info', 'ok', 'warn', 'crit']);
    expect(bars[2]!.h).toBeGreaterThan(bars[1]!.h);
    const list = [
      job(),
      job({ id: '2', state: 'failed', name: 'a.timer' }),
      job({ id: '3', kind: 'cron', state: 'slow', name: 'x.php' }),
    ];
    const t = jobTiles(list);
    expect([t.total, t.timers, t.cron, t.failing.length, t.missedOrSlow.length]).toEqual([
      3, 2, 1, 1, 1,
    ]);
    expect(filterJobs(list, 'attention', '').map((j) => j.id)).toEqual(['2', '3']);
    expect(filterJobs(list, 'cron', '').map((j) => j.id)).toEqual(['3']);
    expect(duration(372)).toBe('6 min 12 s');
    expect(duration(7500)).toBe('2 h 5 min');
  });
});

describe('search status lines (0.13.0)', () => {
  it('a certificate: when it expires and where, coloured when it needs attention', () => {
    const s = certStatusLine(cert());
    expect(s.words.map(say)).toEqual(['expires in 2 days', 'nginx.service on app-1 :443']);
    expect(s.tone).toBe('crit');
    expect(certStatusLine(cert({ daysLeft: 50, status: 'ok' })).tone).toBeUndefined();
    s.words.forEach(say);
  });

  it('a scheduled job: its status and its schedule', () => {
    const s = jobStatusLine(job({ state: 'failed' }));
    expect(s.tone).toBe('crit');
    s.words.forEach(say);
  });
});
