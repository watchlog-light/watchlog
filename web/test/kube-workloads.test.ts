// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NamespaceFilter from '@/components/kube/NamespaceFilter.vue';
import { markerLabel } from '@/composables/useChangeMarkers';
import { useAuthStore } from '@/stores/auth';
import EventsPage from '@/views/EventsPage.vue';
import PodDetailPage from '@/views/PodDetailPage.vue';
import WorkloadsPage from '@/views/WorkloadsPage.vue';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { chooseOption, createPlugins, listedOptions } from './helpers';
// Responses of the Kubernetes read API on the kind test cluster (captured in slice 7).
import FIX from './kube-fixtures.json';

afterEach(() => vi.unstubAllGlobals());

const base = `/api/v1/clusters/${FIX.cluster.id}`;
const clusters = { 'GET /api/v1/clusters': { status: 200, body: { clusters: [FIX.cluster] } } };

async function mountPage(component: object, path: string) {
  const plugins = await createPlugins(path);
  useAuthStore().user = USER;
  const wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [plugins.router, plugins.i18n, plugins.pinia],
      stubs: {
        TimeSeriesChart: {
          props: ['title', 'series', 'markers', 'note'],
          template:
            '<div class="chart-stub" :data-markers="(markers ?? []).length" :data-note="note">{{ title }}|{{ (series ?? []).map((s) => s.name + (s.dotted ? ":dotted" : s.dashed ? ":dashed" : "")).join(",") }}</div>',
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, router: plugins.router };
}

// Two workloads with problems, for the grouping and the badges.
const WL = structuredClone(FIX.workloads);
const find = (name: string) => WL.workloads.find((x) => x.name === name)!;
Object.assign(find('db'), {
  problem: {
    severity: 'critical',
    reason: 'last exit: Error (code 1) · 9 restarts',
    alertId: null,
  },
  podStates: ['failing'],
  ready: 0,
  restartsInRange: 40,
});
Object.assign(find('coredns'), {
  problem: { severity: 'warning', reason: '1 replica unavailable', alertId: null },
});

const listRoutes = (ns = ''): Routes => ({
  ...clusters,
  [`GET ${base}/workloads?range=3600${ns}`]: { status: 200, body: WL },
  [`GET ${base}/pods${ns ? `?${ns.slice(1)}` : ''}`]: { status: 200, body: FIX.pods },
  [`GET ${base}/pods?namespaces=wl-test&workloadKind=StatefulSet&workload=db`]: {
    status: 200,
    body: { pods: FIX.pods.pods.filter((p) => p.workload === 'db'), systemNamespaces: [] },
  },
});
const rowText = (w: { findAll: (s: string) => { text: () => string }[] }, sel: string) =>
  w.findAll(sel).map((r) => r.text().replace(/\s+/g, ' '));

describe('Workloads and pods', () => {
  it('groups by namespace with problems first and hides system namespaces by default', async () => {
    mockFetch(listRoutes());
    const { wrapper: w, router } = await mountPage(WorkloadsPage, '/workloads');
    // wl-test has a failing workload: first; system namespaces hidden.
    const groups = rowText(w, '[data-testid="ns-row"]');
    expect(groups).toEqual([expect.stringMatching(/^wl-test · 5 workloads ✕ 2 need attention$/)]);
    const rows = w.findAll('[data-testid="workload-row"]');
    expect(rows[0]!.text()).toContain('db');
    expect(rows[0]!.classes()).toContain('attn');
    expect(rows[0]!.get('[data-testid="problem-reason"]').text()).toBe(
      'last exit: Error (code 1) · 9 restarts',
    );
    expect(rows[0]!.get('[data-testid="health-badge"]').text()).toBe('✕ Failing');
    expect(rows[0]!.text()).toContain('0/1');
    expect(rows[0]!.text()).toContain('▲ 40');
    // A warning: amber badge and the reason (an HPA without metrics, from the API).
    expect(rows[1]!.text()).toContain('webDeployment');
    expect(rows[1]!.get('[data-testid="health-badge"]').text()).toBe('▲ Degraded');
    expect(rows[1]!.get('[data-testid="problem-reason"]').text()).toBe(
      "HPA web can't read its metrics",
    );
    // Healthy rows: a dot only, no badge.
    const perNode = rows.find((r) => r.text().includes('per-nodeDaemonSet'))!;
    expect(perNode.find('[data-testid="health-badge"]').exists()).toBe(false);
    expect(perNode.find('[data-testid="health-dot"]').exists()).toBe(true);
    expect(perNode.text()).toContain('3/3');
    // CronJobs: the schedule and the last run instead of 0/–.
    expect(w.get('[data-testid="cron"]').text()).toMatch(/^every minute · last run ✓ .+ ago$/);
    // Finished Jobs say so instead of showing their (gone) pods.
    expect(w.get('[data-testid="job"]').text()).toBe('✓ 1/1 completed');
    expect(w.get('[data-testid="summary"]').text().replace(/\s+/g, ' ')).toMatch(
      /^5 workloads · 10 in system namespaces hidden \(edit list\) · 2 need attention/,
    );

    await w.get('[data-testid="hide-system"] input').setValue(false);
    await flushPromises();
    expect(router.currentRoute.value.query.system).toBe('show');
    expect(rowText(w, '[data-testid="ns-row"]').map((g) => g.split(' ')[0])).toEqual([
      'wl-test',
      'kube-system',
      'local-path-storage',
      'watchlog',
    ]);
    w.unmount();
  });

  it('filters by several kinds, by failing, and by search', async () => {
    mockFetch(listRoutes());
    const { wrapper: w, router } = await mountPage(WorkloadsPage, '/workloads?system=show');
    expect(w.get('[data-testid="kind-DaemonSet"]').text()).toBe('DaemonSet 4');
    await w.get('[data-testid="kind-DaemonSet"]').trigger('click');
    await flushPromises();
    await w.get('[data-testid="kind-StatefulSet"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.kind).toBe('DaemonSet,StatefulSet');
    const kinds = () => w.findAll('[data-testid="workload-row"] .kd').map((k) => k.text());
    expect(new Set(kinds())).toEqual(new Set(['DaemonSet', 'StatefulSet']));
    expect(w.get('[data-testid="failing-chip"]').text()).toBe('✕ Failing 1');
    await w.get('[data-testid="failing-chip"]').trigger('click');
    await flushPromises();
    expect(kinds()).toEqual(['StatefulSet']);
    w.unmount();
  });

  it('opens a row to show its pods and a link to the workload', async () => {
    const { calls } = mockFetch(listRoutes());
    const { wrapper: w } = await mountPage(WorkloadsPage, '/workloads');
    const db = w.findAll('[data-testid="workload-row"]')[0]!;
    await db.trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.path.includes('workloadKind=StatefulSet&workload=db'))).toBe(true);
    const pod = w.get('[data-testid="expanded-pod"]').text();
    expect(pod).toContain('db-0');
    expect(pod).toMatch(/node watchlog-worker/);
    expect(w.get('[data-testid="open-workload"]').attributes('href')).toBe(
      '/workloads?view=pods&wkind=StatefulSet&wns=wl-test&wname=db',
    );
    await db.trigger('click');
    expect(w.find('[data-testid="expanded-pod"]').exists()).toBe(false);
    w.unmount();
  });

  it('lists pods failing first, with node and last termination', async () => {
    mockFetch(listRoutes());
    const p = await mountPage(WorkloadsPage, '/workloads?view=pods');
    const rows = rowText(p.wrapper, '[data-testid="pod-row"]');
    expect(rows[0]).toContain('wl-test/crashloop');
    expect(rows[0]).toContain('✕ CrashLoopBackOff');
    expect(rows[0]).toContain('last: Error (1)');
    expect(rows[1]).toContain('wl-test/oom');
    expect(rows.some((r) => r.includes('kube-system/'))).toBe(false);
    p.wrapper.unmount();

    mockFetch(listRoutes());
    const f = await mountPage(WorkloadsPage, '/workloads?view=pods&problems=1');
    expect(f.wrapper.findAll('[data-testid="pod-row"] a').map((a) => a.text())).toEqual([
      'wl-test/crashloop',
      'wl-test/oom',
    ]);
    expect(f.wrapper.find('a[href="/pods/wl-test/crashloop"]').exists()).toBe(true);
    f.wrapper.unmount();
  });

  it('passes the namespace filter, and loads pods only for the Pods level', async () => {
    const { calls } = mockFetch(listRoutes('&namespaces=wl-test'));
    const { wrapper: w, router } = await mountPage(WorkloadsPage, '/workloads?ns=wl-test');
    expect(calls.map((c) => c.path).filter((p) => p.includes('namespaces=wl-test'))).toEqual([
      `${base}/workloads?range=3600&namespaces=wl-test`,
    ]);
    await router.replace({ query: { ...router.currentRoute.value.query, view: 'pods' } });
    await flushPromises();
    expect(calls.at(-1)?.path).toBe(`${base}/pods?namespaces=wl-test`);
    expect(w.findAll('[data-testid="pod-row"]').length).toBeGreaterThan(0);
    w.unmount();
  });
});

describe('Pod detail', () => {
  it('shows the OOMKilled termination, containers, request and limit lines and markers', async () => {
    const oom = FIX.pod;
    const withWorkload = {
      ...oom,
      pod: { ...oom.pod, workloadKind: 'Deployment', workload: 'web' },
      containers: oom.containers.map((c) => ({ ...c, cpuRequestCores: 0.1 })),
    };
    const now = Date.now();
    const { calls } = mockFetch({
      ...clusters,
      [`GET ${base}/pods/wl-test/oom`]: { status: 200, body: withWorkload },
    });
    // Range queries and markers: answer whatever the page asks.
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/v1/query/range') {
        const body = JSON.parse(String(init?.body));
        const unit = String(body.metric).includes('memory') ? 'bytes' : 'cores';
        return new Response(
          JSON.stringify({
            metric: body.metric,
            unit,
            step: 15,
            series: [{ labels: { container: 'main' }, points: [[now / 1000 - 60, 1]] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.includes('/change-markers?')) {
        calls.push({ method: 'GET', path });
        return new Response(
          JSON.stringify({
            markers: [
              {
                kind: 'rollout',
                target: 'Deployment/wl-test/web',
                namespace: 'wl-test',
                details: { from: '1', to: '2' },
                ts: new Date(now - 120_000).toISOString(),
              },
            ],
            truncated: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return real(input, init);
    });

    const { wrapper: w } = await mountPage(PodDetailPage, '/pods/wl-test/oom');
    await flushPromises();
    expect(w.get('h2').text()).toBe('oom');
    expect(w.get('[data-testid="termination"]').text()).toContain(
      'Container main last terminated: OOMKilled (exit 137)',
    );
    expect(w.get('[data-testid="termination"]').text()).toContain('more memory than its limit');
    const row = w.get('[data-testid="container-row"]').text();
    expect(row).toContain('OOMKilled');
    expect(row).toContain('exit 137');
    const charts = w.findAll('.chart-stub');
    const memory = charts.find((c) => c.text().startsWith('Memory per container'))!;
    expect(memory.text()).toContain('main limit:dashed');
    const cpu = charts.find((c) => c.text().startsWith('CPU per container'))!;
    expect(cpu.text()).toContain('main request:dotted');
    expect(cpu.attributes('data-markers')).toBe('1');
    expect(calls.some((c) => c.path.includes('target=Deployment%2Fwl-test%2Fweb'))).toBe(true);
    expect(w.findAll('[data-testid="event-list"] li').length).toBe(oom.events.length);
    w.unmount();
  });

  it('explains exit code 137 when Kubernetes did not say OOMKilled', async () => {
    const pod = {
      ...FIX.pod,
      pod: {
        ...FIX.pod.pod,
        lastTermination: { container: 'main', reason: 'Error', exitCode: 137, finishedAt: null },
      },
    };
    mockFetch({
      ...clusters,
      [`GET ${base}/pods/wl-test/oom`]: { status: 200, body: pod },
      'POST /api/v1/query/range': Array(4).fill({ status: 503 }),
    } as Routes);
    const { wrapper: w } = await mountPage(PodDetailPage, '/pods/wl-test/oom');
    expect(w.get('[data-testid="termination"]').text()).toContain('Error (exit 137)');
    expect(w.get('[data-testid="sigkill-hint"]').text()).toContain('SIGKILL');
    w.unmount();
  });

  it('labels change markers', () => {
    const t = (key: string, args?: object) => `${key}${JSON.stringify(args ?? {})}`;
    const m = (kind: string, target: string, details: Record<string, unknown>) => ({
      kind,
      target,
      namespace: null,
      details,
      ts: '',
    });
    expect(markerLabel(m('scale', 'Deployment/wl-test/web', { from: 2, to: 3 }), t)).toBe(
      'kube.markers.scale{"kind":"Deployment","name":"web","from":"2","to":"3"}',
    );
    expect(markerLabel(m('node', 'Node/worker', { action: 'removed' }), t)).toBe(
      'kube.markers.node.removed{"name":"worker"}',
    );
    expect(
      markerLabel(m('image', 'Deployment/wl-test/web', { from: ['a=x:1'], to: ['a=x:2'] }), t),
    ).toContain('"to":"a=x:2"');
  });
});

describe('Events page', () => {
  const E = FIX.events;
  const to = Math.floor(E.at / 1000);
  const range = `from=${to - 3600}&to=${to}`;
  // Grouped pages ask for 300 events, ungrouped ones for 100: answer both.
  const bothLimits = (routes: Routes): Routes =>
    Object.fromEntries(
      Object.entries(routes).flatMap(([k, v]) =>
        k.includes('limit=100')
          ? [
              [k, v],
              [k.replace('limit=100', 'limit=300'), v],
            ]
          : [[k, v]],
      ),
    );
  const eventRoutes = (extra: Routes = {}): Routes =>
    bothLimits({
      ...clusters,
      [`GET ${base}/events/summary?types=Warning&${range}`]: {
        status: 200,
        body: E.warningsSummary,
      },
      [`GET ${base}/events?types=Warning&${range}&limit=100`]: { status: 200, body: E.warnings },
      [`GET ${base}/events/summary?${range}`]: { status: 200, body: E.allSummary },
      [`GET ${base}/events?${range}&limit=100`]: { status: 200, body: E.all },
      ...extra,
    });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: E.at });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows warnings by default: chart with markers, facets, grouped rows with hints', async () => {
    mockFetch(eventRoutes());
    const { wrapper: w } = await mountPage(EventsPage, '/events');
    expect(w.findAll('[data-testid="event-marker"]').map((m) => m.text())).toEqual([
      '3 nodes rebooted',
    ]);
    const facet = (f: string) =>
      w
        .findAll(`[data-testid="facet-${f}"] [data-testid="facet-value"]`)
        .map((x) => x.text().replace(/\s+/g, ' '));
    expect(facet('ns')).toContain('cluster-wide3');
    expect(facet('kinds')).toContain('Node3');
    expect(w.get('[data-testid="day"]').text()).toBe('Today');
    const groups = w.findAll('[data-testid="event-group"]').map((g) => g.text());
    expect(groups.some((g) => g.includes('All 3 nodes rebooted'))).toBe(true);
    // A single event: the object (an HPA, short) and the fix hint for its reason.
    const hpa = w
      .findAll('[data-testid="event-row"]')
      .find((r) => r.text().includes('FailedGetResourceMetric'))!;
    expect(hpa.get('[data-testid="event-object"]').text()).toBe('wl-test/web');
    expect(hpa.text()).toContain('HPA');
    expect(hpa.get('[data-testid="event-hint"]').text()).toContain('install metrics-server');
    // Opening the group lists its members: nodes without a namespace.
    const reboot = w
      .findAll('[data-testid="event-group"]')
      .find((g) => g.text().includes('rebooted'))!;
    await reboot.trigger('click');
    const members = w.get('[data-testid="group-members"]').text();
    expect(members).toContain('Node watchlog-worker');
    expect(members).not.toContain('default/');
    w.unmount();
  });

  it('lists each event when grouping is off, trimming boot IDs until opened', async () => {
    mockFetch(eventRoutes());
    const { wrapper: w, router } = await mountPage(EventsPage, '/events');
    await w.get('[data-testid="group-toggle"] input').setValue(false);
    await flushPromises();
    expect(router.currentRoute.value.query.group).toBe('0');
    expect(w.find('[data-testid="event-group"]').exists()).toBe(false);
    const rows = w.findAll('[data-testid="event-row"]');
    expect(rows).toHaveLength(E.warnings.events.length);
    const reboot = rows.find((r) => r.text().includes('Rebooted'))!;
    expect(reboot.get('[data-testid="event-message"]').text()).toMatch(/has been rebooted$/);
    expect(reboot.get('[data-testid="event-object"]').text()).not.toContain('/');
    await reboot.trigger('click');
    expect(w.get('[data-testid="event-detail"]').text()).toContain('boot id: 963e6014');
    w.unmount();
  });

  it('folds routine node start-up events, filters by facets and loads older pages', async () => {
    const older = { events: E.all.events.slice(-2), nextCursor: null };
    const { calls } = mockFetch(
      eventRoutes({
        [`GET ${base}/events?${range}&limit=100`]: {
          status: 200,
          body: { ...E.all, nextCursor: 'c1' },
        },
        [`GET ${base}/events?${range}&limit=100&cursor=c1`]: { status: 200, body: older },
        [`GET ${base}/events/summary?kinds=Node&${range}`]: { status: 200, body: E.allSummary },
        [`GET ${base}/events?kinds=Node&${range}&limit=100`]: {
          status: 200,
          body: {
            events: E.all.events.filter((e) => e.involvedKind === 'Node'),
            nextCursor: null,
          },
        },
      }),
    );
    const { wrapper: w, router } = await mountPage(EventsPage, '/events?type=all');
    const groups = w.findAll('[data-testid="event-group"]').map((g) => g.text());
    expect(groups.some((g) => /3 nodes reported healthy after start/.test(g))).toBe(true);
    const before = w.findAll('[data-testid="event-row"], [data-testid="event-group"]').length;
    await w.get('[data-testid="load-more"]').trigger('click');
    await flushPromises();
    expect(
      w.findAll('[data-testid="event-row"], [data-testid="event-group"]').length,
    ).toBeGreaterThanOrEqual(before);
    expect(w.get('[data-testid="events-end"]').text()).toContain(
      `All ${E.all.events.length + 2} events shown`,
    );

    const node = w
      .findAll('[data-testid="facet-kinds"] [data-testid="facet-value"]')
      .find((x) => x.text().startsWith('Node'))!;
    await node.get('input').setValue(true);
    await flushPromises();
    expect(router.currentRoute.value.query.kinds).toBe('Node');
    expect(calls.at(-1)?.path).toBe(`${base}/events?kinds=Node&${range}&limit=300`);
    w.unmount();
  });

  it("shows a Docker fleet's events with host and Compose project facets", async () => {
    const fleet = { ...FIX.cluster, kind: 'docker' };
    const ev = (name: string, host: string, ns: string | null) => ({
      type: 'Warning',
      reason: 'Died',
      message: 'Exited with code 1',
      count: 3,
      firstSeen: new Date(E.at - 60_000).toISOString(),
      lastSeen: new Date(E.at - 60_000).toISOString(),
      namespace: ns,
      involvedKind: 'Container',
      involvedName: name,
      reportingController: 'docker',
      host,
    });
    const summary = {
      ...E.warningsSummary,
      facets: {
        kinds: [{ value: 'Container', count: 6 }],
        namespaces: [
          { value: 'demo', count: 3 },
          { value: '-', count: 3 },
        ],
        reasons: [{ value: 'Died', type: 'Warning', count: 6 }],
        hosts: [{ value: 'h1', count: 6 }],
      },
    };
    mockFetch(
      bothLimits({
        'GET /api/v1/clusters': { status: 200, body: { clusters: [fleet] } },
        [`GET ${base}/events/summary?types=Warning&${range}`]: { status: 200, body: summary },
        [`GET ${base}/events?types=Warning&${range}&limit=100`]: {
          status: 200,
          body: {
            events: [ev('demo-web-1', 'h1', 'demo'), ev('solo', 'h1', null)],
            nextCursor: null,
          },
        },
      }),
    );
    const { wrapper: w } = await mountPage(EventsPage, '/events');
    const facets = w.get('[data-testid="event-facets"]').text();
    expect(facets).toContain('Host');
    expect(facets).toContain('Compose project');
    expect(facets).toContain('Standalone');
    expect(facets).not.toContain('cluster-wide');
    const row = w.findAll('[data-testid="event-row"]')[0]!;
    expect(row.text()).toContain('Container demo-web-1 on h1');
    expect(row.get('[data-testid="event-object"]').attributes('href')).toBe(
      '/containers/h1/demo-web-1',
    );
    w.unmount();
  });

  it('zooms into a dragged range and back', async () => {
    const from = to - 1800;
    const zoomed = `from=${from}&to=${to - 600}`;
    mockFetch(
      eventRoutes({
        [`GET ${base}/events/summary?types=Warning&${zoomed}`]: {
          status: 200,
          body: E.warningsSummary,
        },
        [`GET ${base}/events?types=Warning&${zoomed}&limit=100`]: {
          status: 200,
          body: { events: [], nextCursor: null },
        },
      }),
    );
    const { wrapper: w, router } = await mountPage(EventsPage, '/events');
    const chart = w.findComponent({ name: 'EventHistogram' });
    chart.vm.$emit('zoom', from, to - 600);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({
      from: String(from),
      to: String(to - 600),
    });
    expect(w.get('[data-testid="no-events"]').text()).toContain('No events match');
    await w.get('[data-testid="reset-zoom"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.from).toBeUndefined();
    w.unmount();
  });
});

describe('Namespace filter', () => {
  it('lists namespaces with pod counts and keeps the selection in the URL', async () => {
    mockFetch({ ...clusters, [`GET ${base}/namespaces`]: { status: 200, body: FIX.namespaces } });
    const { wrapper: w, router } = await mountPage(NamespaceFilter, '/workloads');
    const input = () => w.get('[data-testid="namespace-filter"] [role="combobox"]');
    expect(input().attributes('placeholder')).toBe('All namespaces');
    await input().trigger('focus');
    await input().trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(listedOptions().map((o) => o.split(/\d+ pods?|no pods/)[0])).toEqual(
      FIX.namespaces.namespaces.map((n) => n.name),
    );
    await chooseOption(w, 'namespace-filter', 'wl-test');
    expect(router.currentRoute.value.query.ns).toBe('wl-test');
    expect(w.findAll('[data-testid="combobox-chip"]').map((c) => c.text())).toEqual(['wl-test']);
    await chooseOption(w, 'namespace-filter', 'kube-system');
    expect(router.currentRoute.value.query.ns).toBe('kube-system,wl-test');
    expect(w.findAll('[data-testid="combobox-chip"]')).toHaveLength(2);
    w.unmount();
  });
});
