// SPDX-License-Identifier: AGPL-3.0-only
// The suggested egress policy (ADR-190, ADR-191; v0.7 slice 7): on a Kubernetes workload the
// two flavours as tabs, the detected one first, the note per flavour and Cilium state, the
// window, the copy button and "WatchLog never applies it"; no running pod and errors; on the
// Docker container and Compose service pages the reason there is none.
import type { EgressPolicy as Policy } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EgressPolicy from '@/components/egress/EgressPolicy.vue';
import { mockFetch, problem } from './fetch-mock';
import { createPlugins } from './helpers';

const K8S = '01a1de8d-e52d-7188-9878-62ee5fd5309d';
const FLEET = '01a1de8d-e52d-7188-9878-62ee5fd5309e';
const URL_ = `GET /api/v1/egress/policy?cluster=${K8S}&workload=shop%2FDeployment%2Fcheckout`;
const workload = { namespace: 'shop', kind: 'Deployment', name: 'checkout' };

const CIL = 'apiVersion: cilium.io/v2\nkind: CiliumNetworkPolicy\n';
const STD = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\n';

function policy(cilium: boolean | null, over: Partial<Policy> = {}): Policy {
  const both = [
    { flavour: 'cilium' as const, yaml: CIL, notes: [] },
    { flavour: 'kubernetes' as const, yaml: STD, notes: [] },
  ];
  return {
    cluster: { id: K8S, kind: 'kubernetes' },
    workload,
    cilium,
    window: {
      to: '2026-11-15T09:30:00.000Z',
      inCluster: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-15T09:30:00.000Z' },
      external: { from: '2026-10-16T09:30:00.000Z', to: '2026-11-15T09:30:00.000Z' },
    },
    counts: { inCluster: 2, names: 3, networks: 1, expected: 1, skipped: 0, unresolved: 0 },
    policies: cilium === true ? both : [both[1]!, both[0]!],
    ...over,
  };
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(props: {
  clusterId: string;
  kind: 'kubernetes' | 'server';
  workload?: typeof workload;
}) {
  const plugins = await createPlugins('/workloads');
  const w = mount(EgressPolicy, {
    props,
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  mounted = w;
  await flushPromises();
  return w;
}

const tabs = (w: VueWrapper) => w.findAll('[role="tab"]').map((t) => t.text());

describe('the suggested policy on a Kubernetes workload', () => {
  it('Cilium detected: its tab first, the note, the window, the YAML, never applied', async () => {
    const { calls } = mockFetch({ [URL_]: { status: 200, body: policy(true) } });
    const w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    expect(calls.map((c) => c.path)).toEqual([URL_.slice(4)]);
    expect(tabs(w)).toEqual(['Cilium: by name', 'Standard NetworkPolicy']);
    expect(w.get('[data-testid="policy-tab-cilium"]').attributes('aria-selected')).toBe('true');
    expect(w.get('[data-testid="policy-yaml"]').text()).toContain('kind: CiliumNetworkPolicy');
    expect(w.get('[data-testid="policy-note"]').text()).toContain(
      'Cilium is installed on this cluster, so the policy can allow exactly the names checkout used',
    );
    expect(w.get('[data-testid="policy-window"]').text()).toBe(
      'In-cluster destinations from 2026-11-01 (the flow series: 30 days, or the metrics retention if shorter) and external destinations from 2026-10-16, up to 2026-11-15.',
    );
    expect(w.get('[data-testid="policy-never"]').text()).toContain(
      'WatchLog never applies it: copy it, review it, try it in staging first.',
    );
    expect(w.text()).toContain('Server fleets don’t get this section');
  });

  it('switches tabs by click and arrow keys; the note follows', async () => {
    mockFetch({ [URL_]: { status: 200, body: policy(true) } });
    const w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    await w.get('[data-testid="policy-tab-kubernetes"]').trigger('click');
    expect(w.get('[data-testid="policy-tab-kubernetes"]').attributes('aria-selected')).toBe('true');
    expect(w.get('[data-testid="policy-tab-cilium"]').attributes('tabindex')).toBe('-1');
    expect(w.get('[data-testid="policy-yaml"]').text()).toContain('kind: NetworkPolicy');
    expect(w.get('[data-testid="policy-note"]').text()).toContain(
      'Standard NetworkPolicy can only match addresses, not DNS names.',
    );
    await w.get('[data-testid="policy-tab-kubernetes"]').trigger('keydown', { key: 'ArrowRight' });
    expect(w.get('[data-testid="policy-tab-cilium"]').attributes('aria-selected')).toBe('true');
    expect(document.activeElement?.id).toBe('policy-tab-cilium');
    expect(w.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('policy-tab-cilium');
  });

  it('Cilium not detected or unknown: the standard tab first, and the Cilium tab says so', async () => {
    mockFetch({
      [URL_]: [
        { status: 200, body: policy(false) },
        { status: 200, body: policy(null) },
      ],
    });
    let w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    expect(tabs(w)).toEqual(['Standard NetworkPolicy', 'Cilium: by name']);
    expect(w.get('[data-testid="policy-yaml"]').text()).toContain('kind: NetworkPolicy');
    await w.get('[data-testid="policy-tab-cilium"]').trigger('click');
    expect(w.get('[data-testid="policy-note"]').text()).toContain(
      "Cilium wasn't detected on this cluster.",
    );
    mounted!.unmount();
    w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    await w.get('[data-testid="policy-tab-cilium"]').trigger('click');
    expect(w.get('[data-testid="policy-note"]').text()).toContain(
      "WatchLog doesn't know yet whether Cilium is installed",
    );
  });

  it('copies the shown YAML, and says when copying fails', async () => {
    mockFetch({ [URL_]: { status: 200, body: policy(true) } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    expect(w.get('[data-testid="policy-copy"]').text()).toBe('Copy YAML');
    await w.get('[data-testid="policy-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(CIL);
    expect(w.get('[data-testid="policy-copy"]').text()).toBe('Copied');
    await w.get('[data-testid="policy-tab-kubernetes"]').trigger('click');
    await w.get('[data-testid="policy-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(STD);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    await w.get('[data-testid="policy-copy"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="policy-copy"]').text()).toContain('Copy failed');
  });

  it('no in-cluster flow series: the window says so', async () => {
    const p = policy(true);
    mockFetch({
      [URL_]: { status: 200, body: { ...p, window: { ...p.window, inCluster: null } } },
    });
    const w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    expect(w.get('[data-testid="policy-window"]').text()).toBe(
      'No in-cluster flow series retained; external destinations from 2026-10-16 to 2026-11-15.',
    );
  });

  it('no running pod, and an error with Retry', async () => {
    mockFetch({
      [URL_]: [
        problem(409, 'No running pod of this workload'),
        problem(503, 'Metrics storage temporarily unavailable'),
        { status: 200, body: policy(null) },
      ],
    });
    let w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    expect(w.get('[data-testid="policy-no-pods"]').text()).toContain(
      'No running pod of this workload',
    );
    expect(w.find('[data-testid="policy-copy"]').exists()).toBe(false);
    mounted!.unmount();
    w = await mountWith({ clusterId: K8S, kind: 'kubernetes', workload });
    expect(w.get('[data-testid="policy-error"]').text()).toContain(
      "Couldn't build the suggested policy.",
    );
    await w.get('[data-testid="policy-error"] button').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="policy-yaml"]').exists()).toBe(true);
  });
});

describe('Docker: why there is no policy', () => {
  it('explains it without asking the API', async () => {
    const { calls } = mockFetch({});
    const w = await mountWith({ clusterId: FLEET, kind: 'server' });
    expect(calls).toEqual([]);
    const s = w.get('[data-testid="egress-policy-docker"]');
    expect(s.text()).toContain('No egress policy for Docker');
    expect(s.text()).toContain('Docker has no standard egress policy object');
    expect(s.text()).toContain('internal: true');
    expect(s.text()).toContain('DOCKER-USER');
    expect(w.find('[role="tab"]').exists()).toBe(false);
  });
});
