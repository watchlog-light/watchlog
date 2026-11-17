// SPDX-License-Identifier: AGPL-3.0-only
// The egress alerts in the dashboard (ADR-187, v0.7 slice 5): the alert detail's "Where it
// talks" card (the destination as code, first connection, connections, bytes, other sources,
// "Mark expected" for the source or every source, the Egress page filtered to the source and
// destination, why "New" is quiet), the Egress row's "View alert", and the helpers that read an
// egress alert's labels. Kubernetes and Docker.
import type { AlertDetail, Egress, EgressRow } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EgressAlertCard from '@/components/egress/EgressAlertCard.vue';
import EgressTable from '@/components/egress/EgressTable.vue';
import {
  alertScope,
  alertTarget,
  alertTargetName,
  alertWhere,
  egressQueryOf,
  egressSourceOf,
  isEgressAlert,
} from '@/lib/alerts';
import { egressPath } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2026, 10, 15, 11, 15, 0);
const H = 3_600_000;
const D = 24 * H;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K8S = { id: '01a1de8d-e52d-7188-9878-62ee5fd5309d', name: 'acme-prod', kind: 'kubernetes' };
const FLEET = { id: '01a1de8d-e52d-7188-9878-62ee5fd5309e', name: 'edge-fleet', kind: 'server' };

type Alert = AlertDetail['alert'];
function alert(over: Partial<Alert> & Pick<Alert, 'labels' | 'cluster'>): Alert {
  return {
    id: '01a19300-0000-7000-8000-000000000005',
    title: 'orders started talking to cdn-update-check.xyz:443',
    why: 'first connection at 08:12 UTC · nothing else in the cluster talks to it',
    state: 'firing',
    severity: 'warning',
    rule: { id: 'r-new', key: 'egress.new_destination', name: 'New external destination' },
    summary: null,
    pods: [],
    podCount: 0,
    startedAt: iso(3 * H),
    firedAt: iso(3 * H - 60_000),
    resolvedAt: null,
    silenced: false,
    flapping: false,
    held: false,
    deliveries: [],
    ...over,
  } as Alert;
}
const KUBE_LABELS = {
  namespace: 'shop',
  workload_kind: 'Deployment',
  workload: 'orders',
  destination: 'cdn-update-check.xyz',
  port: '443',
};
const COMPOSE_LABELS = {
  compose_project: 'storefront',
  compose_service: 'api',
  destination: 'example.org',
  port: '443',
};

const k8sSource = (workload: string) => ({
  namespace: 'shop',
  workloadKind: 'Deployment',
  workload,
  firstSeen: iso(3 * H),
  lastSeen: iso(0),
  new: true,
});

function row(destination: string, over: Partial<EgressRow> = {}): EgressRow {
  return {
    destination,
    port: 443,
    kind: 'name',
    class: 'name',
    private: false,
    sources: [k8sSource('orders')],
    firstSeen: iso(3 * H),
    firstSeenBefore: false,
    lastSeen: iso(0),
    sent: 48 * 1024,
    received: 2 * 1024,
    connections: 37,
    failed: 0,
    failedRatio: 0,
    badges: ['new'],
    expected: null,
    alertId: null,
    ...over,
  };
}
function answer(rows: EgressRow[], kind = 'kubernetes'): Egress {
  return {
    cluster: { id: kind === 'server' ? FLEET.id : K8S.id, kind },
    range: { from: iso(30 * D), to: iso(0) },
    learning: {
      since: iso(41 * D),
      until: iso(34 * D),
      learning: false,
      days: 41,
      firstSeenPending: false,
    },
    traffic: true,
    summary: { destinations: rows.length, new: 1, rawIp: 0, failing: 0, sources: 1 },
    rows,
    total: rows.length,
    truncated: false,
  } as unknown as Egress;
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(component: object, props: object, role = USER.role as string) {
  const plugins = await createPlugins('/alerts');
  useAuthStore().user = { ...USER, role: role as typeof USER.role };
  const w = mount(component, {
    props,
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return w;
}

const get = (cluster: string, q: Record<string, string>) =>
  `GET /api/v1${egressPath(cluster, q, '30d', NOW)}`;

describe('the labels of an egress alert', () => {
  it('Kubernetes: the workload is the subject; its query and source in the Egress words', () => {
    const a = alert({ labels: KUBE_LABELS, cluster: K8S });
    expect(isEgressAlert(a)).toBe(true);
    expect(alertWhere(a)).toBe('shop/orders (Deployment)');
    expect(alertTargetName(a)).toBe('orders');
    expect(egressQueryOf(a)).toEqual({ namespace: 'shop', kind: 'Deployment', workload: 'orders' });
    expect(egressSourceOf(a)).toEqual({
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'orders',
    });
  });

  it('Docker: a Compose service and a plain container', () => {
    const c = alert({ labels: COMPOSE_LABELS, cluster: FLEET });
    expect(alertWhere(c)).toBe('storefront/api (Compose service)');
    expect(alertTargetName(c)).toBe('storefront/api');
    expect(alertTarget(c)).toEqual({
      name: 'containers',
      query: { project: 'storefront', service: 'api' },
    });
    expect(egressQueryOf(c)).toEqual({ project: 'storefront', service: 'api' });
    expect(alertScope(c)).toEqual({ kind: 'compose', name: 'storefront/api', extra: null });
    const p = alert({
      labels: { node: 'docker-01', container: 'redis', destination: '8.8.8.0/24', port: '53' },
      cluster: FLEET,
    });
    expect(egressSourceOf(p)).toEqual({ host: 'docker-01', container: 'redis' });
    expect(alertTarget(p)).toEqual({
      name: 'docker-container',
      params: { host: 'docker-01', name: 'redis' },
    });
    expect(
      isEgressAlert(
        alert({ labels: {}, cluster: K8S, rule: { id: 'x', key: 'k8s.pod.crashloop', name: 'x' } }),
      ),
    ).toBe(false);
  });
});

describe('Where it talks, on the alert detail', () => {
  it('Kubernetes: the facts, nothing else uses it, Mark expected for orders, the Egress link, the quiet note', async () => {
    const { calls } = mockFetch({
      [get(K8S.id, {
        namespace: 'shop',
        kind: 'Deployment',
        workload: 'orders',
        q: 'cdn-update-check.xyz',
      })]: { status: 200, body: answer([row('cdn-update-check.xyz')]) },
      [get(K8S.id, { q: 'cdn-update-check.xyz' })]: {
        status: 200,
        body: answer([row('cdn-update-check.xyz'), row('cdn-update-check.xyz', { port: 80 })]),
      },
      'POST /api/v1/egress/expected': { status: 201, body: { expectation: {}, updated: 1 } },
    });
    const w = await mountWith(EgressAlertCard, {
      alert: alert({ labels: KUBE_LABELS, cluster: K8S }),
      now: NOW,
    });
    expect(w.get('[data-testid="egress-alert-destination"]').element.tagName).toBe('CODE');
    expect(w.get('[data-testid="egress-alert-destination"]').text()).toBe(
      'cdn-update-check.xyz:443',
    );
    const facts = w.get('[data-testid="egress-alert-facts"]').text();
    expect(facts).toContain('First connection');
    expect(w.get('[data-testid="egress-alert-connections"]').text()).toBe('37');
    expect(w.get('[data-testid="egress-alert-bytes"]').text()).toBe('48 KiB / 2 KiB');
    expect(facts).toContain('Other workloads using it');
    expect(w.get('[data-testid="egress-alert-others"]').text()).toBe('none');
    expect(w.get('[data-testid="egress-alert-open"]').attributes('href')).toBe(
      `/egress?cluster=${K8S.id}&namespace=shop&kind=Deployment&workload=orders&q=cdn-update-check.xyz`,
    );
    expect(w.get('[data-testid="egress-alert-quiet"]').text()).toBe(
      'Why this alert is quiet most of the time: it waited 7 days to learn what acme-prod normally talks to, and stays silent for anything marked expected. One alert per workload and destination.',
    );

    // Mark expected for this workload only (the alert's source is the only one offered).
    await w.get('[data-testid="expected-mark"]').trigger('click');
    await flushPromises();
    const dialog = document.querySelector('[role="dialog"]')!;
    const labels = [...dialog.querySelectorAll('label')].map((l) => l.textContent!.trim());
    expect(labels).toEqual(expect.arrayContaining(['Only shop / orders', 'Every workload']));
    (dialog.querySelector('[data-testid="expected-save"]') as HTMLElement).click();
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      cluster: K8S.id,
      pattern: 'cdn-update-check.xyz',
      port: 443,
      source: { namespace: 'shop', workloadKind: 'Deployment', workload: 'orders' },
    });
  });

  it('Kubernetes: another workload uses it; an expected row says the alert resolves', async () => {
    const mine = row('cdn-update-check.xyz', {
      expected: { pattern: '*.xyz.example', at: iso(H), by: 'Ada', ids: ['e1'] },
      failedRatio: 0.25,
    });
    mockFetch({
      [get(K8S.id, {
        namespace: 'shop',
        kind: 'Deployment',
        workload: 'orders',
        q: 'cdn-update-check.xyz',
      })]: { status: 200, body: answer([mine]) },
      [get(K8S.id, { q: 'cdn-update-check.xyz' })]: {
        status: 200,
        body: answer([
          { ...mine, sources: [k8sSource('orders'), k8sSource('billing'), k8sSource('cart')] },
        ]),
      },
    });
    const w = await mountWith(EgressAlertCard, {
      alert: alert({ labels: KUBE_LABELS, cluster: K8S }),
      now: NOW,
    });
    expect(w.get('[data-testid="egress-alert-others"]').text()).toBe('2');
    expect(w.get('[data-testid="egress-alert-connections"]').text()).toContain('25 % failed');
    expect(w.get('[data-testid="egress-alert-expected"]').text()).toBe(
      'Expected · *.xyz.example. The alert resolves at the next check.',
    );
    expect(w.find('[data-testid="expected-undo"]').exists()).toBe(true);
  });

  it('Docker: a Compose service’s raw IP alert in the fleet’s words; a Viewer sees no button', async () => {
    const labels = { ...COMPOSE_LABELS, destination: '1.1.1.0/24' };
    const r = row('1.1.1.0/24', {
      kind: 'network',
      class: 'public_network',
      badges: ['raw_ip'],
      sources: [
        {
          composeProject: 'storefront',
          composeService: 'api',
          firstSeen: iso(H),
          lastSeen: iso(0),
          new: true,
        },
      ],
    });
    mockFetch({
      [get(FLEET.id, { project: 'storefront', service: 'api', q: '1.1.1.0/24' })]: {
        status: 200,
        body: answer([r], 'docker'),
      },
      [get(FLEET.id, { q: '1.1.1.0/24' })]: { status: 200, body: answer([r], 'docker') },
    });
    const w = await mountWith(
      EgressAlertCard,
      {
        alert: alert({
          labels,
          cluster: FLEET,
          rule: { id: 'r-raw', key: 'egress.raw_ip', name: 'Raw IP egress' },
        }),
        now: NOW,
      },
      'viewer',
    );
    expect(w.text()).toContain('Other containers and Compose services using it');
    expect(w.get('[data-testid="egress-alert-open"]').attributes('href')).toBe(
      `/egress?cluster=${FLEET.id}&project=storefront&service=api&q=1.1.1.0/24`,
    );
    expect(w.find('[data-testid="expected-mark"]').exists()).toBe(false);
    expect(w.find('[data-testid="egress-alert-quiet"]').exists()).toBe(false);
    expect(w.text()).toContain(
      "Marking a destination expected doesn't silence Raw IP or Large upload",
    );
  });

  it('a failed read says so, with Retry', async () => {
    mockFetch({});
    const w = await mountWith(EgressAlertCard, {
      alert: alert({ labels: KUBE_LABELS, cluster: K8S }),
      now: NOW,
    });
    expect(w.get('[data-testid="egress-alert-error"]').text()).toContain(
      "Couldn't load the traffic for this destination.",
    );
  });
});

describe('View alert on the Egress page', () => {
  it('a row with a firing alert links to it, on the table and the phone cards', async () => {
    const rows = [
      row('cdn-update-check.xyz', { alertId: '01a19300-0000-7000-8000-000000000005' }),
      row('quiet.example.org'),
    ];
    const w = await mountWith(EgressTable, { rows, clusterId: K8S.id, kind: 'kubernetes' });
    const links = w.findAll('[data-testid="egress-view-alert"]');
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.attributes('href'))).toEqual([
      '/alerts/01a19300-0000-7000-8000-000000000005',
      '/alerts/01a19300-0000-7000-8000-000000000005',
    ]);
    expect(links[0]!.text()).toBe('View alert');
  });
});
