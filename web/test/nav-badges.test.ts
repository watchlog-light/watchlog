// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's Certificates and Scheduled jobs badges (0.13.0, ADR-230): only when something
// needs a look; amber for certificates expiring within 14 days, red for expired, under 3 days,
// a certificate problem, or a job failing, missed or slow; the count is the items.
import { describe, expect, it } from 'vitest';
import { certBadge, jobBadge } from '@/lib/certs-jobs';

const c = (status: string) => ({ status }) as never;
const j = (state: string) => ({ state }) as never;

describe('certBadge', () => {
  it('none when every certificate is fine', () => {
    expect(certBadge([c('ok'), c('ok')])).toBeNull();
    expect(certBadge([])).toBeNull();
  });
  it('amber for expiring ones only', () => {
    expect(certBadge([c('ok'), c('expiring')])).toEqual({
      count: 1,
      tone: 'warn',
      words: { key: 'nav.badge.certsExpiring', values: { n: 1 } },
    });
  });
  it('red for expired, under 3 days or a problem; the count takes the expiring ones too', () => {
    for (const s of ['expired', 'expires_soon', 'problem']) {
      expect(certBadge([c(s)])!.tone).toBe('crit');
    }
    expect(certBadge([c('expired'), c('expiring'), c('expiring'), c('ok')])).toEqual({
      count: 3,
      tone: 'crit',
      words: { key: 'nav.badge.certsAttention', values: { n: 3 } },
    });
  });
});

describe('jobBadge', () => {
  it('none for working, running, new or disabled jobs', () => {
    expect(jobBadge([j('working'), j('running'), j('new'), j('disabled')])).toBeNull();
  });
  it('red for failing, missed or slow; "failing" when all of them fail', () => {
    expect(jobBadge([j('failed'), j('working')])).toEqual({
      count: 1,
      tone: 'crit',
      words: { key: 'nav.badge.jobsFailing', values: { n: 1 } },
    });
    expect(jobBadge([j('failed'), j('missed'), j('slow')])).toEqual({
      count: 3,
      tone: 'crit',
      words: { key: 'nav.badge.jobsAttention', values: { n: 3 } },
    });
  });
});
