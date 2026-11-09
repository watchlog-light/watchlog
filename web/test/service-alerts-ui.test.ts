// SPDX-License-Identifier: AGPL-3.0-only
// Alerts for a service (v0.3 slice 5): the block on the service page lists the rules
// scoped to it, switches them in place, and "+ Add rule" opens the rule editor with the
// service chosen and its metrics only; Viewers read.
import { flushPromises, mount } from '@vue/test-utils';
import type { AlertRule, Application } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceAlerts from '@/components/applications/ServiceAlerts.vue';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER } from './fetch-mock';
import { createPlugins } from './helpers';

vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(() => {
  document.body.innerHTML = '';
});

const K8S = {
  id: '01a1c000-0000-7000-8000-000000000001',
  name: 'prod-eu',
  kind: 'kubernetes' as const,
};
const APP: Application = {
  id: '01a1c000-0000-7000-8000-0000000000aa',
  type: 'redis',
  name: 'shop/redis',
  version: '7.2',
  cluster: K8S,
  where: { group: 'shop', host: null, address: null },
  target: {
    kind: 'workload',
    namespace: 'shop',
    workload_kind: 'StatefulSet',
    workload: 'redis',
    port: 6379,
  },
  health: 'warning',
  reason: { code: 'connected', facts: { up: 1, members: 2 } },
  members: { up: 1, total: 2 },
  monitoredSince: '2026-11-09T10:00:00.000Z',
  lastReportAt: '2026-11-09T10:01:00.000Z',
};
const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: 'r1',
  type: 'threshold',
  ruleKey: null,
  name: 'Service unreachable',
  source: 'metric',
  unit: 'ratio',
  metric: 'service.reachable.ratio',
  clusterId: K8S.id,
  appliesTo: ['kubernetes', 'docker'],
  scope: { service: APP.id } as never,
  condition: { op: '<', value: 1, critical: 0.01 },
  forSeconds: 120,
  renotifySeconds: 14400,
  severity: 'warning',
  enabled: true,
  channelIds: [],
  firing: 1,
  evalError: null,
  service: { id: APP.id, name: APP.name, type: 'redis' },
  ...over,
});
const RULES = [
  rule({}),
  rule({
    id: 'r2',
    name: 'Service slow to connect',
    metric: 'service.connect.time',
    unit: 'seconds',
    condition: { op: '>', value: 0.5 },
    enabled: false,
    firing: 0,
  }),
  rule({
    id: 'r3',
    name: 'Other service',
    scope: { service: 'other' } as never,
    service: { id: 'other', name: 'x', type: 'redis' },
  }),
  rule({
    id: 'r4',
    type: 'default',
    name: 'Node CPU high',
    metric: null,
    scope: {} as never,
    service: undefined,
  }),
];
const CLUSTERS = {
  clusters: [{ ...K8S, status: 'active', nodeCount: 3, lastSeenAt: null, ingestFailure: null }],
};

async function mountBlock(role = 'owner') {
  const plugins = await createPlugins('/applications');
  useAuthStore().user = { ...USER, role: role as typeof USER.role };
  const w = mount(ServiceAlerts, {
    props: { app: APP },
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

describe('alerts for a service', () => {
  it('lists its rules, switches one, and adds a rule with the service chosen', async () => {
    const { calls } = mockFetch({
      'GET /api/v1/alert-rules': { status: 200, body: { rules: RULES } },
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [] } },
      'GET /api/v1/clusters': { status: 200, body: CLUSTERS },
      'PATCH /api/v1/alert-rules/r2': { status: 200, body: rule({ id: 'r2' }) },
      'POST /api/v1/alert-rules/preview': {
        status: 200,
        body: { samples: [], series: [], firing: [], thresholds: [] },
      },
      'POST /api/v1/alert-rules': { status: 201, body: rule({ id: 'r5' }) },
    });
    const w = await mountBlock();
    const rows = w.findAll('[data-testid="service-rule"]');
    expect(rows.map((r) => r.find('button span').text())).toEqual([
      'Service unreachable',
      'Service slow to connect',
    ]);
    expect(rows[0]!.text()).toContain('1 firing');
    expect(rows[0]!.text()).toContain('shop/redis');
    expect(rows[1]!.text()).toContain('off');

    await rows[1]!.get('input[type="checkbox"]').setValue(true);
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ enabled: true });

    await w.get('[data-testid="add-rule"]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid="drawer-service"]')!.textContent).toBe(
      'shop/redis',
    );
    expect(document.body.querySelector('[data-testid="drawer-cluster"]')).toBeNull();
    (document.body.querySelector('[data-testid="drawer-threshold"]') as HTMLInputElement).value =
      '100';
    document.body
      .querySelector('[data-testid="drawer-threshold"]')!
      .dispatchEvent(new Event('input'));
    await flushPromises();
    (document.body.querySelector('[data-testid="drawer-save"]') as HTMLButtonElement).click();
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/alert-rules');
    expect(post?.body).toMatchObject({
      metric: 'service.reachable.ratio',
      clusterId: K8S.id,
      scope: { service: APP.id },
    });
    w.unmount();
  });

  it('lets Viewers read the rules, with the switches and Add rule locked', async () => {
    mockFetch({
      'GET /api/v1/alert-rules': { status: 200, body: { rules: RULES } },
      'GET /api/v1/clusters': { status: 200, body: CLUSTERS },
    });
    const w = await mountBlock('viewer');
    expect(w.findAll('[data-testid="service-rule"]')).toHaveLength(2);
    expect(w.get('[data-testid="add-rule"]').element.closest('fieldset')?.disabled).toBe(true);
    const switches = w.findAll('input[type="checkbox"]');
    expect(switches).toHaveLength(2);
    expect(switches.every((s) => s.element.closest('fieldset')?.disabled)).toBe(true);
    w.unmount();
  });
});
