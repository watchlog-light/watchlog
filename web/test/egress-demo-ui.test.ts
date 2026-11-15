// SPDX-License-Identifier: AGPL-3.0-only
// Egress watch in the public demo: the backend answers at most the last 24 hours there
// ("The demo shows at most the last 24 hours."), so the Egress page offers 1 h and 24 h only,
// and the source and alert cards read the last day instead of 30 days, on a Kubernetes
// cluster and a Docker fleet. A request for longer is not mocked here, so it would fail the
// read and show the error state.
import type { AlertDetail, Egress, EgressRow } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EgressAlertCard from '@/components/egress/EgressAlertCard.vue';
import TalksToInternet from '@/components/egress/TalksToInternet.vue';
import { EGRESS_RANGES, egressHistoryRange, egressPath, egressRanges } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import EgressPage from '@/views/EgressPage.vue';
import { FLEET } from './docker-fixtures';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2026, 10, 15, 21, 0, 0);
const H = 3_600_000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K8S = {
  ...FLEET,
  id: '01a1de8d-e52d-7188-9878-62ee5fd5309d',
  name: 'sample-cluster',
  kind: 'kubernetes',
};

const k8sRow: EgressRow = {
  destination: 'mirror-20261115-2012.1-0-0-1.sslip.io',
  port: 443,
  kind: 'name',
  class: 'name',
  private: false,
  sources: [
    {
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'updater',
      firstSeen: iso(H),
      lastSeen: iso(H),
      new: true,
    },
  ],
  firstSeen: iso(H),
  firstSeenBefore: false,
  lastSeen: iso(H),
  sent: 1_200,
  received: 4_800,
  connections: 1,
  failed: 0,
  failedRatio: 0,
  badges: ['new'],
} as unknown as EgressRow;
const dockerRow: EgressRow = {
  ...k8sRow,
  destination: '1.1.1.0/24',
  kind: 'network',
  class: 'public_network',
  badges: ['raw_ip'],
  sources: [
    { host: 'docker-01', container: 'ip-beacon', firstSeen: iso(H), lastSeen: iso(H), new: true },
  ],
} as unknown as EgressRow;

const answer = (rows: EgressRow[], id: string, kind: string): Egress =>
  ({
    cluster: { id, kind },
    range: { from: iso(24 * H), to: iso(0) },
    learning: {
      since: iso(2 * H),
      until: iso(-4 * H),
      learning: true,
      days: 5,
      firstSeenPending: false,
    },
    traffic: true,
    summary: { destinations: rows.length, sources: 1, new: 1, rawIp: 0, failing: 0 },
    rows,
    total: rows.length,
    truncated: false,
  }) as unknown as Egress;

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountDemo(component: object, path: string, props: object = {}) {
  const plugins = await createPlugins(path);
  const auth = useAuthStore();
  auth.user = { ...USER, role: 'viewer' };
  auth.demoMode = true;
  const w = mount(component, {
    props,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return { w, plugins };
}

const day = (cluster: string, q: Record<string, string> = {}) =>
  `GET /api/v1${egressPath(cluster, q, '24h', NOW)}`;

describe('the demo’s ranges', () => {
  it('offers 1 h and 24 h in the demo, up to 30 days elsewhere; the cards read 24 h there', () => {
    expect(egressRanges(true)).toEqual(['1h', '24h']);
    expect(egressRanges(false)).toEqual(EGRESS_RANGES);
    expect(egressHistoryRange(true)).toBe('24h');
    expect(egressHistoryRange(false)).toBe('30d');
  });
});

describe('the Egress page in the demo', () => {
  it('Kubernetes: two ranges, and a 7-day link opens the last 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [K8S] } },
      [day(K8S.id)]: { status: 200, body: answer([k8sRow], K8S.id, 'kubernetes') },
    });
    const { w } = await mountDemo(EgressPage, `/egress?cluster=${K8S.id}&range=7d`);
    expect(w.findAll('[data-testid="egress-range"] button')).toHaveLength(2);
    expect(calls.some((c) => c.path.includes('from='))).toBe(false);
    expect(w.findAll('[data-testid="egress-row"]')).toHaveLength(1);
  });

  it('Docker: two ranges, and the fleet’s rows load', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { calls } = mockFetch({
      'GET /api/v1/clusters': { status: 200, body: { clusters: [FLEET] } },
      [day(FLEET.id)]: { status: 200, body: answer([dockerRow], FLEET.id, 'docker') },
    });
    const { w } = await mountDemo(EgressPage, `/egress?cluster=${FLEET.id}&range=30d`);
    expect(w.findAll('[data-testid="egress-range"] button')).toHaveLength(2);
    expect(calls.some((c) => c.path.includes('from='))).toBe(false);
    expect(w.findAll('[data-testid="egress-row"]')).toHaveLength(1);
  });
});

describe('"Talks to the internet" in the demo', () => {
  it('Kubernetes workload: reads the last day, not 30 days', async () => {
    const q = { namespace: 'shop', kind: 'Deployment', workload: 'updater' };
    const { calls } = mockFetch({
      [day(K8S.id, q)]: { status: 200, body: answer([k8sRow], K8S.id, 'kubernetes') },
    });
    const { w } = await mountDemo(TalksToInternet, '/workloads', {
      clusterId: K8S.id,
      kind: 'kubernetes',
      query: q,
      now: NOW,
    });
    expect(calls.some((c) => c.path.includes('from='))).toBe(false);
    expect(w.find('[data-testid="talks-error"]').exists()).toBe(false);
    expect(w.findAll('[data-testid="talks-row"]')).toHaveLength(1);
  });

  it('Docker container: reads the last day, not 30 days', async () => {
    const q = { host: 'docker-01', container: 'ip-beacon' };
    mockFetch({
      [day(FLEET.id, q)]: { status: 200, body: answer([dockerRow], FLEET.id, 'docker') },
    });
    const { w } = await mountDemo(TalksToInternet, '/containers/docker-01/ip-beacon', {
      clusterId: FLEET.id,
      kind: 'docker',
      query: q,
      now: NOW,
    });
    expect(w.find('[data-testid="talks-error"]').exists()).toBe(false);
    expect(w.text()).toContain('1.1.1.0/24:443');
  });
});

describe('an egress alert’s card in the demo', () => {
  const alert = (labels: Record<string, string>, cluster: object, key: string) =>
    ({
      id: '01a19300-0000-7000-8000-000000000009',
      title: 'x',
      why: 'x',
      state: 'firing',
      severity: 'warning',
      rule: { id: 'r', key, name: 'x' },
      summary: null,
      pods: [],
      podCount: 0,
      startedAt: iso(H),
      firedAt: iso(H),
      resolvedAt: null,
      silenced: false,
      flapping: false,
      held: false,
      deliveries: [],
      labels,
      cluster,
    }) as unknown as AlertDetail['alert'];

  it('Kubernetes: a New alert reads the last day', async () => {
    const dest = k8sRow.destination;
    mockFetch({
      [day(K8S.id, { namespace: 'shop', kind: 'Deployment', workload: 'updater', q: dest })]: {
        status: 200,
        body: answer([k8sRow], K8S.id, 'kubernetes'),
      },
      [day(K8S.id, { q: dest })]: { status: 200, body: answer([k8sRow], K8S.id, 'kubernetes') },
    });
    const labels = {
      namespace: 'shop',
      workload_kind: 'Deployment',
      workload: 'updater',
      destination: dest,
      port: '443',
    };
    const { w } = await mountDemo(EgressAlertCard, '/alerts', {
      alert: alert(labels, K8S, 'egress.new_destination'),
      now: NOW,
    });
    expect(w.find('[data-testid="egress-alert-error"]').exists()).toBe(false);
    expect(w.text()).toContain(`${dest}:443`);
  });

  it('Docker: a Raw IP alert reads the last day', async () => {
    mockFetch({
      [day(FLEET.id, { host: 'docker-01', container: 'ip-beacon', q: '1.1.1.0/24' })]: {
        status: 200,
        body: answer([dockerRow], FLEET.id, 'docker'),
      },
      [day(FLEET.id, { q: '1.1.1.0/24' })]: {
        status: 200,
        body: answer([dockerRow], FLEET.id, 'docker'),
      },
    });
    const labels = {
      node: 'docker-01',
      container: 'ip-beacon',
      destination: '1.1.1.0/24',
      port: '443',
    };
    const { w } = await mountDemo(EgressAlertCard, '/alerts', {
      alert: alert(labels, FLEET, 'egress.raw_ip'),
      now: NOW,
    });
    expect(w.find('[data-testid="egress-alert-error"]').exists()).toBe(false);
    expect(w.text()).toContain('1.1.1.0/24');
  });
});
