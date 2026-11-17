// SPDX-License-Identifier: AGPL-3.0-only
// An anomaly alert's page (ADR-200; v0.8 slice 4), the screen Anomaly: the hero (now, the usual
// range at this hour, the series against each hour's band), then What changed around it and the
// probable cause, then "Was this worth an alert?". Kubernetes and Docker in their own words;
// Owners and Admins answer and undo, Viewers see no buttons; a downgraded org sees the page as
// for any rule.
import type { AlertDetail, AnomalyAlert, WhatChanged } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfig } from '@/api/cloud';
import AnomalyAlertView from '@/components/what-changed/AnomalyAlertView.vue';
import { bucketWords, heroGeometry, isAnomalyAlert, localHourWords } from '@/lib/anomaly';
import { whatChangedPath } from '@/lib/what-changed';
import { useAuthStore } from '@/stores/auth';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2026, 10, 17, 14, 12, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K8S = {
  ...FLEET,
  id: '01a1de8d-e52d-7188-9878-62ee5fd5309d',
  name: 'acme-prod',
  kind: 'kubernetes',
};
const ALERT_ID = '01a19300-0000-7000-8000-000000000042';
const CONFIG: CloudConfig = {
  signup: true,
  signupMode: 'public',
  providers: { github: false, google: false },
  turnstileSiteKey: null,
  passwordMinLength: 10,
  verifyGraceDays: 7,
  supportEmail: 'support@watchlog.io',
  sampleUrl: 'https://demo.watchlog.io',
};

function hero(cluster: typeof K8S, over: Partial<AnomalyAlert> = {}): AnomalyAlert {
  const docker = cluster.kind === 'server';
  const from = NOW - 6 * HOUR;
  const points: [number, number | null][] = [];
  for (let t = from; t <= NOW; t += 2 * MIN) {
    const v = t < NOW - 10 * MIN ? (docker ? 230 : 0.15) : docker ? 900 : 2.4;
    points.push([t / 1000, docker ? v * 2 ** 20 : v]);
  }
  const band = [];
  for (let h = Math.floor(from / HOUR) * HOUR; h < NOW; h += HOUR) {
    band.push({
      from: new Date(h).toISOString(),
      low: docker ? 200 * 2 ** 20 : 0.12,
      high: docker ? 260 * 2 ** 20 : 0.18,
    });
  }
  return {
    alert: { id: ALERT_ID, state: 'firing', startedAt: iso(10 * MIN), resolvedAt: null },
    cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind as 'kubernetes' },
    key: docker ? 'container.memory.working_set' : 'workload.http.latency.p95',
    unit: docker ? 'bytes' : 'seconds',
    subject: {},
    object: docker
      ? {
          kind: 'container',
          name: 'shop-web-1',
          host: 'docker-01',
          composeProject: 'shop',
          composeService: 'web',
        }
      : { kind: 'workload', name: 'checkout', namespace: 'shop', workloadKind: 'Deployment' },
    peer: null,
    bucket: 2 * 24 + 14,
    usualLow: docker ? 200 * 2 ** 20 : 0.12,
    usualHigh: docker ? 260 * 2 ** 20 : 0.18,
    value: docker ? 900 * 2 ** 20 : 2.4,
    peakValue: docker ? 900 * 2 ** 20 : 2.4,
    peakScore: 40,
    since: iso(10 * MIN),
    until: null,
    chart: { from: new Date(from).toISOString(), to: iso(0), step: 120, points, band },
    feedback: null,
    ...over,
  } as AnomalyAlert;
}

const alertOf = (cluster: typeof K8S) =>
  ({
    id: ALERT_ID,
    title:
      cluster.kind === 'server'
        ? 'web (shop): memory unusual for a Tuesday at 14:00 UTC'
        : 'checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC',
    why: 'usual for Tuesday 14:00 UTC: 120–180 ms; now 2.4 s',
    state: 'firing',
    severity: 'warning',
    startedAt: iso(10 * MIN),
    rule: { id: 'r', key: 'anomaly.unusual', name: 'Unusual for this hour' },
    cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind },
    labels: {},
  }) as unknown as AlertDetail['alert'];

const wcEmpty = (cluster: typeof K8S): WhatChanged =>
  ({
    cluster: { id: cluster.id, name: cluster.name, kind: cluster.kind },
    window: { from: iso(70 * MIN), to: iso(0), alert: { id: ALERT_ID, startedAt: iso(10 * MIN) } },
    sort: 'first',
    chart: { from: iso(130 * MIN), to: iso(0), step: 60, counts: [] },
    rows: [],
    total: 0,
    truncated: false,
    learning: { learning: false, since: iso(10 * 86_400_000), until: iso(3 * 86_400_000) },
    cause: { subject: `alert:${ALERT_ID}`, likely: null },
  }) as unknown as WhatChanged;

function routes(cluster: typeof K8S, page: unknown, extra: Routes = {}): Routes {
  return {
    [`GET /api/v1/alerts/${ALERT_ID}/anomaly`]: { status: 200, body: page },
    [`GET /api/v1${whatChangedPath(cluster.id, { window: 'alert', alert: ALERT_ID }, NOW)}`]: {
      status: 200,
      body: wcEmpty(cluster),
    },
    [`GET /api/v1/causes?cluster=${encodeURIComponent(cluster.id)}&subject=${encodeURIComponent(`alert:${ALERT_ID}`)}`]:
      { status: 503, body: { type: 'about:blank', title: 'x', status: 503 } },
    ...extra,
  };
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open(cluster: typeof K8S, role: 'owner' | 'admin' | 'viewer') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const plugins = await createPlugins('/alerts');
  const auth = useAuthStore();
  auth.user = { ...USER, role };
  auth.cloud = CONFIG;
  const w = mount(AnomalyAlertView, {
    props: { alert: alertOf(cluster) },
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return w;
}

describe('the lib', () => {
  it('the rule, the bucket in UTC words, the hero geometry', () => {
    expect(isAnomalyAlert({ rule: { key: 'anomaly.unusual' } })).toBe(true);
    expect(isAnomalyAlert({ rule: { key: 'k8s.pod.crashloop' } })).toBe(false);
    expect(bucketWords(2 * 24 + 14)).toEqual({ day: 'Tuesday', hour: '14:00' });
    expect(bucketWords(0)).toEqual({ day: 'Sunday', hour: '00:00' });
    const g = heroGeometry(hero(K8S), 1000, 200);
    expect(g.empty).toBe(false);
    // One band step per hour (two points high, two low), the line split at the start.
    expect(g.band.split(' ')).toHaveLength(4 * 7);
    expect(g.before.split(' ').length).toBeGreaterThan(150);
    expect(g.after.split(' ').length).toBeGreaterThan(4);
    expect(g.unusual!.x).toBeGreaterThan(950);
    expect(g.ticks.length).toBeGreaterThanOrEqual(3);
    expect(
      heroGeometry({ ...hero(K8S), chart: { ...hero(K8S).chart, points: [], band: [] } }, 1000, 200)
        .empty,
    ).toBe(true);
  });
});

describe('an anomaly alert’s page', () => {
  it('Kubernetes: now, the usual range at this hour, the band, then What changed and the cause, then the feedback', async () => {
    mockFetch(routes(K8S, hero(K8S)));
    const w = await open(K8S, 'owner');
    // The bucket in the viewer's local time (ADR-196); messages say UTC.
    const local = localHourWords(iso(10 * MIN));
    expect(w.get('[data-testid="anomaly-when"]').text()).toBe(
      `Anomaly · unusual for a ${local.day} at ${local.hour}`,
    );
    expect(w.get('[data-testid="anomaly-what"]').text()).toBe('checkout · p95 response time');
    expect(w.get('[data-testid="anomaly-now"]').text()).toBe('2.4 s');
    expect(w.get('[data-testid="anomaly-usual"]').text()).toBe('120–180 ms');
    expect(w.get('[data-testid="anomaly-chart"]').attributes('aria-label')).toContain('120–180 ms');
    // The order of the screen: hero, What changed around it, probable cause, feedback.
    const html = w.html();
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at('anomaly-hero')).toBeLessThan(at('wc-card'));
    expect(at('wc-card')).toBeLessThan(at('wc-cause'));
    expect(at('wc-cause')).toBeLessThan(at('anomaly-feedback'));
    expect(w.get('[data-testid="anomaly-message"]').text()).toContain(
      'checkout (shop): p95 response time unusual for a Tuesday at 14:00 UTC',
    );
  });

  it('Docker: the Compose service named, the bytes in their unit', async () => {
    mockFetch(routes(FLEET, hero(FLEET)));
    const w = await open(FLEET, 'admin');
    expect(w.get('[data-testid="anomaly-what"]').text()).toBe('web · memory');
    expect(w.get('[data-testid="anomaly-now"]').text()).toBe('900 MiB');
    expect(w.get('[data-testid="anomaly-usual"]').text()).toBe('200–260 MiB');
  });

  for (const c of [K8S, FLEET]) {
    it(`${c.kind}: "No, this is normal for us" widens it, says by whom, and can be undone`, async () => {
      const at = iso(0);
      const { calls } = mockFetch(
        routes(c, hero(c), {
          [`POST /api/v1/alerts/${ALERT_ID}/anomaly-feedback`]: {
            status: 201,
            body: {
              feedback: {
                id: 'f1',
                answer: 'normal',
                at,
                by: 'Ada Admin',
                widenedLow: c.kind === 'server' ? 0 : 0,
                widenedHigh: c.kind === 'server' ? 565 * 2 ** 20 : 1.27,
              },
            },
          },
          [`DELETE /api/v1/alerts/${ALERT_ID}/anomaly-feedback`]: { status: 204 },
        }),
      );
      const w = await open(c, 'admin');
      await w.get('[data-testid="anomaly-feedback-no"]').trigger('click');
      await flushPromises();
      expect(calls.find((x) => x.method === 'POST')!.body).toEqual({ answer: 'normal' });
      expect(w.get('[data-testid="anomaly-feedback-answer"]').text()).toContain(
        c.kind === 'server' ? 'is now 0 B–565 MiB' : 'is now 0 ms–1.27 s',
      );
      expect(w.get('[data-testid="anomaly-feedback-by"]').text()).toMatch(
        /^Widened on .+ by Ada Admin\.$/,
      );
      await w.get('[data-testid="anomaly-feedback-undo"]').trigger('click');
      await flushPromises();
      expect(calls.some((x) => x.method === 'DELETE')).toBe(true);
      expect(w.find('[data-testid="anomaly-feedback-answer"]').exists()).toBe(false);
      expect(w.find('[data-testid="anomaly-feedback-no"]').exists()).toBe(true);
    });
  }

  it('"Yes, keep alerting" is thanked', async () => {
    mockFetch(
      routes(K8S, hero(K8S), {
        [`POST /api/v1/alerts/${ALERT_ID}/anomaly-feedback`]: {
          status: 201,
          body: { feedback: { id: 'f2', answer: 'useful', at: iso(0), by: 'Ada Admin' } },
        },
      }),
    );
    const w = await open(K8S, 'owner');
    await w.get('[data-testid="anomaly-feedback-yes"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="anomaly-feedback-answer"]').text()).toBe(
      'Thanks. This kind of change keeps alerting.',
    );
  });

  it('a Viewer sees the answer and no buttons', async () => {
    for (const fb of [
      null,
      {
        id: 'f',
        answer: 'normal',
        at: iso(MIN),
        by: 'Ada Admin',
        widenedLow: 0,
        widenedHigh: 1.27,
      },
    ]) {
      const { calls } = mockFetch(
        routes(K8S, hero(K8S, { feedback: fb as AnomalyAlert['feedback'] })),
      );
      const w = await open(K8S, 'viewer');
      expect(w.find('[data-testid="anomaly-feedback-yes"]').exists()).toBe(false);
      expect(w.find('[data-testid="anomaly-feedback-no"]').exists()).toBe(false);
      expect(w.find('[data-testid="anomaly-feedback-undo"]').exists()).toBe(false);
      if (fb) expect(w.get('[data-testid="anomaly-feedback-by"]').text()).toContain('Ada Admin');
      else
        expect(w.get('[data-testid="anomaly-feedback-hint"]').text()).toContain(
          'Owners and Admins',
        );
      expect(calls.every((x) => x.method === 'GET')).toBe(true);
      mounted!.unmount();
      mounted = null;
    }
  });

  it('without What changed (a downgrade): the page as for any rule, no hero', async () => {
    mockFetch({
      ...routes(K8S, null),
      [`GET /api/v1/alerts/${ALERT_ID}/anomaly`]: {
        status: 403,
        body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
      },
      [`GET /api/v1${whatChangedPath(K8S.id, { window: 'alert', alert: ALERT_ID }, NOW)}`]: {
        status: 403,
        body: { type: 'urn:watchlog:problem:pro-feature', title: 'Forbidden', status: 403 },
      },
    });
    const w = await open(K8S, 'owner');
    expect(w.find('[data-testid="anomaly-hero"]').exists()).toBe(false);
    expect(w.find('[data-testid="anomaly-feedback"]').exists()).toBe(false);
  });
});
