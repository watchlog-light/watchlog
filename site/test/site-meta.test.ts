// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PAGES, site, siteMeta } from '../site.config';

describe('site config', () => {
  it('keeps the meta description within the length search engines display', () => {
    expect(siteMeta.description.length).toBeGreaterThan(50);
    expect(siteMeta.description.length).toBeLessThanOrEqual(160);
  });

  it('uses the approved landing design headline', () => {
    expect(`${siteMeta.headline} ${siteMeta.headlineAccent}`).toBe(
      'See everything in your Kubernetes cluster in 5 minutes.',
    );
  });

  it('starts private (no repository links) with the Cloud waitlist on, posting same-origin', () => {
    expect(site.repoPublic).toBe(false);
    expect(site.cloudWaitlist).toBe(true);
    expect(site.waitlistAction).toBe('/api/waitlist');
    expect(site.url).toBe('https://watchlog.io');
  });

  it('lists every page with a trailing slash (each is <path>/index.html)', () => {
    expect(PAGES.every((p) => p.endsWith('/'))).toBe(true);
  });
});
