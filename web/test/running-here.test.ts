// SPDX-License-Identifier: AGPL-3.0-only
// The Overview's "Running here" row (0.13.0, ADR-230): each platform's words, the soonest
// certificates, a failing renewal job on the certificate's row, problems first, the headers.
import type { Application, ScheduledJob, TlsCertificate } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import {
  certHeader,
  certLine,
  certWhere,
  jobHeader,
  jobLine,
  servicesHere,
  soonestCerts,
  topJobs,
} from '@/lib/running-here';

const cert = (name: string, daysLeft: number, over: Partial<TlsCertificate> = {}) =>
  ({
    id: `${name}-id`,
    names: [name],
    subject: name,
    node: '',
    daysLeft,
    status:
      daysLeft < 0 ? 'expired' : daysLeft < 3 ? 'expires_soon' : daysLeft < 14 ? 'expiring' : 'ok',
    endpoints: [{ kind: 'Ingress', workload: 'shop/api', port: 443, sni: name }],
    renewedAt: null,
    renewalJob: null,
    chain: 'public',
    nameMismatch: [],
    ...over,
  }) as unknown as TlsCertificate;
const job = (name: string, state: string, over: Partial<ScheduledJob> = {}) =>
  ({
    id: `${name}-id`,
    name,
    node: 'worker-1',
    kind: 'timer',
    state,
    schedule: 'daily',
    nextAt: null,
    failedStreak: 1,
    lastGoodAt: null,
    recent: [],
    ...over,
  }) as unknown as ScheduledJob;

describe('certificates', () => {
  it('says where in each platform’s words', () => {
    const server = cert('api.acme.com', 40, {
      node: 'app-1',
      endpoints: [{ kind: 'Process', workload: 'nginx', port: 443, sni: null }],
    } as Partial<TlsCertificate>);
    expect(certWhere(server)).toEqual({
      key: 'runningHere.certs.server',
      values: { name: 'nginx', port: 443, server: 'app-1' },
    });
    expect(certWhere(cert('shop.acme.com', 40)).key).toBe('runningHere.certs.ingress');
  });

  it('says a failing renewal job on the certificate’s row, in red', () => {
    const c = cert('api.acme.com', 9, {
      renewalJob: { id: 'x', name: 'certbot.timer', state: 'failed' },
    } as Partial<TlsCertificate>);
    const line = certLine(c);
    expect(line.tone).toBe('crit');
    // Amber while the certificate has time left.
    const later = cert('www.acme.com', 60, {
      renewalJob: { id: 'x', name: 'certbot.timer', state: 'failed' },
    } as Partial<TlsCertificate>);
    expect(certLine(later).tone).toBe('warn');
    expect(line.words[1]).toEqual({
      key: 'runningHere.certs.jobFailing',
      values: { job: 'certbot.timer' },
    });
  });

  it('lists the three soonest, a certificate problem as if 14 days', () => {
    const list = [
      cert('a', 80),
      cert('b', 9),
      cert('c', 60, { status: 'problem' } as Partial<TlsCertificate>),
      cert('d', 30),
    ];
    expect(soonestCerts(list).map((c) => c.names[0])).toEqual(['b', 'c', 'd']);
  });

  it('headers: "N expiring" in amber, red under 3 days, "need attention" once anything else', () => {
    expect(certHeader([cert('a', 9), cert('b', 50)])).toEqual({
      words: { key: 'runningHere.certs.expiring', values: { n: 1 } },
      tone: 'warn',
    });
    expect(certHeader([cert('a', 2)])!.tone).toBe('crit');
    expect(certHeader([cert('a', -1), cert('b', 9)])!.words.key).toBe('runningHere.attention');
    expect(certHeader([cert('a', 50)])).toBeNull();
  });
});

describe('scheduled jobs', () => {
  it('problems first, then the soonest next run', () => {
    const list = [
      job('later', 'working', { nextAt: 2000 }),
      job('soon', 'working', { nextAt: 1000 }),
      job('slow', 'slow'),
      job('broken', 'failed'),
    ];
    expect(topJobs(list).map((j) => j.name)).toEqual(['broken', 'slow', 'soon']);
  });

  it('says a fine job in each platform’s words: timer on a server, cron with its line', () => {
    expect(jobLine(job('backup.timer', 'working')).words[0]).toEqual({
      key: 'runningHere.jobs.timerOn',
      values: { server: 'worker-1' },
    });
    const cron = jobLine(
      job('pg_dump', 'working', { kind: 'cron', node: 'db-1', schedule: '0 4 * * *' }),
    );
    expect(cron.words).toEqual([
      { key: 'runningHere.jobs.cronOn', values: { server: 'db-1' } },
      { key: 'runningHere.jobs.spec', values: { spec: '0 4 * * *' } },
    ]);
    expect(jobLine(job('report', 'failed')).tone).toBe('crit');
  });

  it('headers: "N failing", or "need attention" with missed or slow ones', () => {
    expect(jobHeader([job('a', 'failed')])!.words).toEqual({
      key: 'runningHere.jobs.failing',
      values: { n: 1 },
    });
    expect(jobHeader([job('a', 'missed')])!.tone).toBe('warn');
    expect(jobHeader([job('a', 'working')])).toBeNull();
  });
});

describe('services', () => {
  it('only this cluster’s, problems first', () => {
    const app = (name: string, health: string, cluster = 'c1') =>
      ({ id: name, name, health, cluster: { id: cluster } }) as unknown as Application;
    const list = [
      app('b', 'ok'),
      app('a', 'warning'),
      app('z', 'critical'),
      app('x', 'critical', 'c2'),
    ];
    expect(servicesHere(list, 'c1').map((a) => a.name)).toEqual(['z', 'a', 'b']);
  });
});
