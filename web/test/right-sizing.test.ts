// SPDX-License-Identifier: AGPL-3.0-only
// Right-sizing hints (ADR-168) in the dashboard: every code becomes a sentence with every
// placeholder filled, the "not set" hints of a container read as one sentence, the panel's
// states (hints, fits, too new, error), and the overview card's counts, first three and
// "Show all". Answers recorded from the e2e stack (kind and Docker, 2026-11-13).
import type { RightSizing, RightSizingHint } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RightSizingCard from '@/components/rightsizing/RightSizingCard.vue';
import RightSizingPanel from '@/components/rightsizing/RightSizingPanel.vue';
import en from '@/i18n/en.json';
import { hintLines, period } from '@/lib/rightsizing';
import { mockFetch } from './fetch-mock';
import { createPlugins } from './helpers';

const CLUSTER = '01a1c446-a818-76d4-b058-f1b1aa7dc501';
const MIB = 2 ** 20;
const based = (hours = 20.6) => ({
  windowHours: 168,
  from: '2026-11-12T07:00:00.000Z',
  to: '2026-11-13T03:31:29.000Z',
  samples: Math.round(hours * 12),
  hours,
});
const kube = (name: string, ns = 'shop') => ({ kind: 'Deployment', namespace: ns, name });
const docker = (name: string) => ({ kind: 'container', host: 'lima-watchlog-iso', name });

function hint(
  object: RightSizingHint['object'],
  code: string,
  resource: 'cpu' | 'memory',
  facts: RightSizingHint['facts'],
  suggestion: number | null,
  giveBack = 0,
  container: string | null = object.host ? null : object.name,
): RightSizingHint {
  return {
    object,
    container,
    resource,
    code,
    facts: { name: object.name, hours: 20.6, ...facts },
    suggestion,
    giveBack,
    basedOn: based(),
  };
}

const IDLE_CPU = hint(
  kube('idle', 'rs-e2e'),
  'cpu_request_high',
  'cpu',
  { requestCores: 0.5, usedCores: 0, replicas: 2 },
  0.01,
  0.98,
);
const IDLE_MEM = hint(
  kube('idle', 'rs-e2e'),
  'memory_request_high',
  'memory',
  { requestBytes: 256 * MIB, peakBytes: 327680, replicas: 2 },
  16 * MIB,
  480 * MIB,
);
const ALL: RightSizingHint[] = [
  hint(
    kube('consumer', 'rabbitmq-e2e'),
    'memory_limit_oom',
    'memory',
    { limitBytes: 384 * MIB, peakBytes: 262533120, oomKills: 1, lastOomAt: '2026-11-13T03:27:36Z' },
    480 * MIB,
  ),
  hint(
    kube('tight'),
    'memory_limit_tight',
    'memory',
    { limitBytes: 32 * MIB, peakBytes: 30 * MIB },
    48 * MIB,
  ),
  hint(
    kube('hot', 'causes-e2e'),
    'cpu_limit_throttled',
    'cpu',
    { limitCores: 0.02, throttledShare: 0.88, usedCores: 0.02 },
    null,
  ),
  hint(
    kube('pg', 'causes-e2e'),
    'memory_request_low',
    'memory',
    { requestBytes: 64 * MIB, p95Bytes: 104760729.6, peakBytes: 111890432 },
    144 * MIB,
  ),
  hint(
    kube('pg', 'causes-e2e'),
    'cpu_request_low',
    'cpu',
    { requestCores: 0.01, usedCores: 0.0986 },
    0.13,
  ),
  IDLE_CPU,
  IDLE_MEM,
  hint(kube('cart'), 'cpu_no_request', 'cpu', { usedCores: 0.0078 }, 0.01, 0, 'podinfo'),
  hint(
    kube('cart'),
    'memory_no_request',
    'memory',
    { peakBytes: 46071808 },
    64 * MIB,
    0,
    'podinfo',
  ),
  hint(kube('cart'), 'memory_no_limit', 'memory', { peakBytes: 46071808 }, 64 * MIB, 0, 'podinfo'),
  hint(
    kube('db', 'wl-test'),
    'memory_no_limit',
    'memory',
    { peakBytes: 978944 },
    16 * MIB,
    0,
    'main',
  ),
  hint(
    docker('causes-e2e-hog-1'),
    'memory_limit_oom',
    'memory',
    { limitBytes: 48 * MIB, peakBytes: 48 * MIB, oomKills: 356 },
    64 * MIB,
  ),
  hint(
    docker('causes-e2e-hot-1'),
    'cpu_limit_throttled',
    'cpu',
    { limitCores: 0.02, throttledShare: 1, usedCores: 0.02 },
    null,
  ),
  hint(
    docker('rs-e2e-idle-1'),
    'memory_reservation_high',
    'memory',
    { reservationBytes: 256 * MIB, peakBytes: 327680 },
    16 * MIB,
    240 * MIB,
  ),
  hint(
    docker('db-1'),
    'memory_reservation_low',
    'memory',
    { reservationBytes: 32 * MIB, p95Bytes: 50 * MIB, peakBytes: 60 * MIB },
    80 * MIB,
  ),
  hint(
    docker('demo-worker'),
    'memory_no_limit',
    'memory',
    { peakBytes: 1597366272, hostMemoryBytes: 6198562816, host: 'lima-watchlog-iso' },
    2013265920,
  ),
];

const answer = (
  hints: RightSizingHint[],
  short: RightSizing['notEnoughHistory'] = [],
): RightSizing => ({
  window: { hours: 168, minHistoryHours: 24 },
  computedAt: '2026-11-13T03:31:29.000Z',
  hints,
  notEnoughHistory: short,
  summary: { objects: 0, giveBackObjects: 0, giveBack: { cores: 0, bytes: 0 }, oomRisk: 0 },
});

describe('sentences', () => {
  it('every code and every "not set" combination is a sentence with no placeholder left', async () => {
    const { i18n } = await createPlugins('/');
    const t = i18n.global.t as unknown as (
      k: string,
      v: Record<string, unknown>,
      n: number,
    ) => string;
    const lines = hintLines(ALL, t);
    // cart's three "not set" hints are one sentence.
    expect(lines).toHaveLength(ALL.length - 2);
    for (const l of lines) {
      const text = t(l.message, l.values, typeof l.values.n === 'number' ? l.values.n : 1);
      expect(text, l.message).not.toMatch(/[{}]|undefined|NaN/);
      expect(text, l.message).not.toBe(l.message);
    }
    const said = (code: string, name: string) => {
      const l = lines.find((x) => x.hint.code === code && x.hint.object.name === name)!;
      return t(l.message, l.values, typeof l.values.n === 'number' ? l.values.n : 1);
    };
    expect(said('cpu_request_high', 'idle')).toBe(
      'idle asks for 500m CPU; its busiest pod used at most 1m (p95) over 21 hours. About 10m would cover it and give back 980m CPU in all.',
    );
    expect(said('cpu_no_request', 'cart')).toBe(
      'cart sets no requests and no memory limit; it used up to 8m CPU (p95) and peaked at 43.9 MiB over 21 hours. About 10m CPU and 64 MiB of memory would cover it.',
    );
    expect(said('memory_limit_oom', 'causes-e2e-hog-1')).toContain(
      'OOM-killed 356 times at its 48 MiB',
    );
    expect(said('cpu_limit_throttled', 'hot')).toContain('20m CPU limit 88% of the time');
    expect(said('memory_no_limit', 'demo-worker')).toContain(
      "more than a quarter of lima-watchlog-iso's 5.8 GiB",
    );
    // Every combination of the "not set" sentences exists.
    const unset = (en as { rightSizing: { k8s: { unset: Record<string, string> } } }).rightSizing
      .k8s.unset;
    expect(Object.keys(unset).sort()).toEqual(
      [
        'cpu',
        'cpu_limit',
        'cpu_memory',
        'cpu_memory_limit',
        'limit',
        'memory',
        'memory_limit',
      ].sort(),
    );
    expect(lines.find((l) => l.hint.code === 'memory_limit_oom')!.cause).toBe('oom_limit');
  });

  it('says days from 48 hours on, hours before', async () => {
    const { i18n } = await createPlugins('/');
    const t = i18n.global.t as unknown as (
      k: string,
      v: Record<string, unknown>,
      n: number,
    ) => string;
    expect(period(168, t)).toBe('7 days');
    expect(period(30, t)).toBe('30 hours');
    expect(period(1, t)).toBe('1 hour');
  });
});

async function mountPanel(body: RightSizing | null, status = 200) {
  const url = `/api/v1/clusters/${CLUSTER}/right-sizing?namespace=rs-e2e&kind=Deployment&workload=idle&system=true`;
  mockFetch({ [`GET ${url}`]: { status, body: body ?? { title: 'x', status } } });
  const { pinia, router, i18n } = await createPlugins('/');
  const w = mount(RightSizingPanel, {
    props: {
      clusterId: CLUSTER,
      query: { namespace: 'rs-e2e', kind: 'Deployment', workload: 'idle', system: 'true' },
      name: 'idle',
    },
    global: { plugins: [pinia, router, i18n] },
  });
  await flushPromises();
  return w;
}

describe('RightSizingPanel', () => {
  it('lists the hints with what they are based on', async () => {
    const w = await mountPanel(answer([IDLE_CPU, IDLE_MEM]));
    expect(w.findAll('[data-testid="rightsizing-hint"]')).toHaveLength(2);
    expect(w.find('[data-testid="rightsizing-based"]').text()).toBe('Use over 21 hours');
    expect(w.text()).toContain('Could give back');
  });

  it('says when they fit, when it is too new, and when it failed', async () => {
    expect((await mountPanel(answer([]))).find('[data-testid="rightsizing-fits"]').text()).toBe(
      "idle's requests and limits fit what it used over 7 days.",
    );
    const young = await mountPanel(
      answer([], [{ object: kube('idle', 'rs-e2e'), container: 'idle', hours: 0.3, needed: 24 }]),
    );
    expect(young.find('[data-testid="rightsizing-new"]').text()).toContain('0.3 of 24 hours');
    expect((await mountPanel(null, 503)).find('[data-testid="rightsizing-error"]').exists()).toBe(
      true,
    );
  });
});

describe('RightSizingCard', () => {
  it('counts what could give back and the OOM risk, shows three, then all', async () => {
    mockFetch({
      [`GET /api/v1/clusters/${CLUSTER}/right-sizing`]: {
        status: 200,
        body: answer(ALL.slice(0, 11)),
      },
    });
    const { pinia, router, i18n } = await createPlugins('/');
    const w = mount(RightSizingCard, {
      props: { clusterId: CLUSTER, kind: 'kubernetes' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    const summary = w.find('[data-testid="rightsizing-summary"]').text();
    expect(summary).toContain('1 workload could give back 980m CPU and 480 MiB of memory.');
    expect(summary).toContain(
      '2 workloads are close to their memory limit or were OOM-killed there.',
    );
    expect(w.findAll('[data-testid="rightsizing-hint"]')).toHaveLength(3);
    const more = w.find('[data-testid="rightsizing-more"]');
    expect(more.attributes('aria-expanded')).toBe('false');
    expect(more.text()).toContain('Show all (7 workloads)');
    await more.trigger('click');
    expect(more.attributes('aria-expanded')).toBe('true');
    expect(w.findAll('[data-testid="rightsizing-hint"]')).toHaveLength(9);
    // The namespace filter of the top bar.
    await w.setProps({ namespaces: ['rs-e2e'] });
    expect(w.findAll('[data-testid="rightsizing-hint"]')).toHaveLength(2);
  });
});
