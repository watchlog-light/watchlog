// SPDX-License-Identifier: AGPL-3.0-only
// What changed's cause card (ADR-199, the screen Main; v0.8 slice 3b) on Kubernetes and Docker:
// a likely cause (green, the checked facts, "Likely · where it starts"), no clear cause and
// couldn't run (the same card, neutral), the evidence (the panel's "What we checked"), "Copy as
// text" and "Ask your AI" (the MCP call). The answers are the e2e recordings the probable-cause
// panel's tests replay. And the rows' links to their objects' pages.
import type { Causes, WhatChangedRow } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WhatChangedCauseCard from '@/components/what-changed/WhatChangedCauseCard.vue';
import WhatChangedRows from '@/components/what-changed/WhatChangedRows.vue';
import { askCall, causeFacts, objectLink } from '@/lib/what-changed';
import { mockFetch, type Route } from './fetch-mock';
import { createPlugins } from './helpers';
import kubeDep from './fixtures/causes/kube-dependency-down.json';
import dockerDep from './fixtures/causes/docker-dependency-down.json';
import liveNone from './fixtures/causes/kube-alert-none.json';

const answer = (a: unknown) => a as Causes;
const subjectOf = (a: Causes) => `${a.subject.kind}:${a.subject.ref}`;
const url = (cluster: string, subject: string) =>
  `GET /api/v1/causes?cluster=${encodeURIComponent(cluster)}&subject=${encodeURIComponent(subject)}`;

/** No clear cause, as the engine gives it: nothing explains it. */
function none(a: Causes): Causes {
  return {
    ...a,
    state: 'none',
    headline: { code: 'none_found', facts: { name: a.subject.name, n: a.checks.length, found: 1 } },
    causes: [],
    checks: a.checks.map((c) => (c.result === 'explains' ? { ...c, result: 'possible' } : c)),
  };
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

async function card(
  a: Causes | Route | null,
  props: { clusterId: string; clusterName: string; subject: string | null },
  platform: 'kubernetes' | 'docker',
) {
  const isAnswer = (x: unknown): x is Causes => !!x && typeof x === 'object' && 'checks' in x;
  const { calls } = mockFetch(
    a && props.subject
      ? { [url(props.clusterId, props.subject)]: isAnswer(a) ? { status: 200, body: a } : a }
      : {},
  );
  const plugins = await createPlugins();
  const w = mount(WhatChangedCauseCard, {
    props: { ...props, platform },
    global: { plugins: [plugins.pinia, plugins.router, plugins.i18n] },
    attachTo: document.body,
  });
  mounted = w;
  await flushPromises();
  return { w, calls };
}
const of = (a: Causes, subject = subjectOf(a)) => ({
  clusterId: a.cluster.id,
  clusterName: a.cluster.name,
  subject,
});
const texts = (w: VueWrapper, id: string) =>
  w.findAll(`[data-testid="${id}"]`).map((x) => x.text());

describe('the cause card: a likely cause', () => {
  it('Kubernetes: green, the checked facts, the cause in large type, the three actions', async () => {
    const a = answer(kubeDep);
    const { w } = await card(a, of(a), 'kubernetes');
    const c = w.get('[data-testid="wc-cause"]');
    expect(c.attributes('data-state')).toBe('likely');
    expect(c.classes()).toContain('border-ok/40');
    expect(c.text()).toContain('Probable cause');
    expect(c.text()).toContain('Fixed rules · no AI · same answer every time');
    // What the answer checked: where it started, what explains it first, then what was fine.
    expect(texts(w, 'wc-cause-fact')).toEqual([
      'Started from what moved first',
      'Followed api on the service map',
      'No restarts or OOM kills on web',
    ]);
    expect(w.get('[data-testid="wc-cause-label"]').text()).toBe('Likely · where it starts');
    expect(w.get('[data-testid="wc-cause-sentence"]').text()).toMatch(/^web .*api/);
    expect(w.get('[data-testid="wc-cause-label"]').classes()).toContain('text-ok');

    // Open the evidence: the panel's "What we checked", open, every check.
    const toggle = w.get('[data-testid="wc-cause-evidence-toggle"]');
    expect(toggle.text()).toBe('Open the evidence');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(w.find('[data-testid="cause-checks"]').exists()).toBe(false);
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.text()).toBe('Hide the evidence');
    expect(w.get('[data-testid="cause-checks"]').attributes('open')).toBeDefined();
    expect(w.findAll('[data-testid="cause-check"]')).toHaveLength(a.checks.length);

    // Ask your AI: the MCP call that gives the same answer.
    await w.get('[data-testid="wc-cause-ask-toggle"]').trigger('click');
    expect(w.get('[data-testid="wc-cause-ask"] code').text()).toBe(
      'explain_problem(cluster: "kind", subject: "workload:causes-e2e/Deployment/web")',
    );
  });

  it('Docker: the Compose service, its findings first; "Copy as text" copies the answer', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const a = answer(dockerDep);
    const { w } = await card(a, of(a), 'docker');
    expect(w.get('[data-testid="wc-cause"]').attributes('data-state')).toBe('likely');
    const facts = texts(w, 'wc-cause-fact');
    expect(facts[0]).toBe('Started from what moved first');
    expect(facts).toHaveLength(3);
    // Both findings that explain it come first; one has no short form: what, then what was found.
    expect(w.findAll('[data-testid="wc-cause-fact"]')[1]!.attributes('data-result')).toBe(
      'explains',
    );
    expect(facts[2]).toMatch(/^DNS lookups from web: /);
    expect(w.get('[data-testid="wc-cause-label"]').text()).toBe('Likely · where it starts');
    await w.get('[data-testid="wc-cause-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain('causes-e2e-api-1');
    expect(w.get('[data-testid="wc-cause-copy"]').text()).toBe('Copied');
    await w.get('[data-testid="wc-cause-ask-toggle"]').trigger('click');
    expect(w.get('[data-testid="wc-cause-ask"] code').text()).toBe(
      'explain_problem(cluster: "fleet", subject: "compose_service:causes-e2e/web")',
    );
  });
});

describe('the cause card: no clear cause', () => {
  it('Kubernetes, around an alert: neutral, the honest sentence, explain_alert', async () => {
    const a = answer(liveNone);
    const { w } = await card(a, of(a), 'kubernetes');
    const c = w.get('[data-testid="wc-cause"]');
    expect(c.attributes('data-state')).toBe('none');
    expect(c.classes()).not.toContain('border-ok/40');
    expect(c.classes()).toContain('border-border');
    expect(w.get('[data-testid="wc-cause-label"]').text()).toBe('No clear cause');
    expect(w.get('[data-testid="wc-cause-label"]').classes()).not.toContain('text-ok');
    expect(w.get('[data-testid="wc-cause-sentence"]').text()).toContain('hot');
    expect(texts(w, 'wc-cause-fact')[0]).toBe('Started from the alert');
    expect(texts(w, 'wc-cause-fact')).toEqual([
      'Started from the alert',
      'No restarts or OOM kills on hot',
      'No warning events in the last 60 minutes',
    ]);
    await w.get('[data-testid="wc-cause-evidence-toggle"]').trigger('click');
    expect(w.findAll('[data-testid="cause-check"]')).toHaveLength(a.checks.length);
    await w.get('[data-testid="wc-cause-ask-toggle"]').trigger('click');
    expect(w.get('[data-testid="wc-cause-ask"] code').text()).toBe(
      `explain_alert(id: "${a.subject.ref}")`,
    );
  });

  it('Docker: neutral, nothing marked as explaining it', async () => {
    const a = none(answer(dockerDep));
    const { w } = await card(a, of(a), 'docker');
    expect(w.get('[data-testid="wc-cause"]').attributes('data-state')).toBe('none');
    expect(w.get('[data-testid="wc-cause-label"]').text()).toBe('No clear cause');
    expect(
      w.findAll('[data-testid="wc-cause-fact"]').map((f) => f.attributes('data-result')),
    ).not.toContain('explains');
    expect(w.find('[data-testid="wc-cause-actions"]').exists()).toBe(true);
  });
});

describe("the cause card: couldn't run", () => {
  it('the answer failed: the same card, neutral, the sentence and a retry (both platforms)', async () => {
    for (const [a, platform] of [
      [answer(kubeDep), 'kubernetes'],
      [answer(dockerDep), 'docker'],
    ] as const) {
      const fail: Route = {
        status: 500,
        body: { type: 'about:blank', title: 'Internal Server Error', status: 500 },
      };
      const { w, calls } = await card(fail, of(a), platform);
      expect(w.get('[data-testid="wc-cause"]').attributes('data-state')).toBe('error');
      expect(w.get('[data-testid="wc-cause-label"]').text()).toBe("Couldn't run");
      expect(w.get('[data-testid="wc-cause-sentence"]').text()).toContain(
        "WatchLog couldn't work out the cause right now",
      );
      expect(w.find('[data-testid="wc-cause-actions"]').exists()).toBe(false);
      expect(w.find('[data-testid="wc-cause-retry"]').exists()).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      mounted!.unmount();
      mounted = null;
    }
  });

  it('no row probable cause explains: the platform’s sentence, and nothing asked', async () => {
    let { w, calls } = await card(
      null,
      { clusterId: 'k', clusterName: 'acme-prod', subject: null },
      'kubernetes',
    );
    expect(w.get('[data-testid="wc-cause"]').attributes('data-state')).toBe('noSubject');
    expect(w.get('[data-testid="wc-cause-label"]').text()).toBe("Couldn't run");
    expect(w.get('[data-testid="wc-cause-sentence"]').text()).toContain('workloads and pods');
    expect(calls).toHaveLength(0);
    mounted!.unmount();
    ({ w, calls } = await card(
      null,
      { clusterId: 'd', clusterName: 'acme-hosts', subject: null },
      'docker',
    ));
    expect(w.get('[data-testid="wc-cause-sentence"]').text()).toContain('Compose services');
    expect(w.find('[data-testid="wc-cause-actions"]').exists()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('the pure parts: at most 3 facts, explains first; the MCP call', () => {
    const checks = answer(kubeDep).checks;
    expect(causeFacts(checks, false, 2).map((f) => f.lines[0]!.key)).toEqual([
      'whatChanged.cause.fact.first',
      'whatChanged.cause.fact.dependencies_failing',
    ]);
    expect(causeFacts([], true)).toHaveLength(1);
    expect(askCall('alert:42', 'x')).toBe('explain_alert(id: "42")');
    expect(askCall('container:docker-01/shop-db-1', 'acme "hosts"')).toBe(
      'explain_problem(cluster: "acme \\"hosts\\"", subject: "container:docker-01/shop-db-1")',
    );
  });
});

describe('the rows link to their objects', () => {
  const row = (object: WhatChangedRow['object'], id: string): WhatChangedRow =>
    ({
      id,
      since: '2026-11-17T14:00:00Z',
      until: null,
      key: 'workload.cpu.usage',
      unit: 'cores',
      subject: {},
      object,
      peer: null,
      usualLow: 0.3,
      usualHigh: 0.5,
      value: 0.9,
      peakScore: 8,
      peakAt: '2026-11-17T14:02:00Z',
    }) as WhatChangedRow;

  async function rows(list: WhatChangedRow[], clusterId?: string) {
    const plugins = await createPlugins();
    const w = mount(WhatChangedRows, {
      props: { rows: list, ...(clusterId ? { clusterId } : {}) },
      global: { plugins: [plugins.pinia, plugins.router, plugins.i18n] },
    });
    mounted = w;
    return w;
  }
  const hrefs = (w: VueWrapper) =>
    w.findAll('[data-testid="wc-row"]').map((r) => r.find('a').attributes('href') ?? null);

  it('Kubernetes: a workload to its pods, a node to its page, a monitored service to its own', async () => {
    const w = await rows(
      [
        row(
          { kind: 'workload', name: 'checkout', namespace: 'shop', workloadKind: 'Deployment' },
          'a',
        ),
        row({ kind: 'node', name: 'kind-worker' }, 'b'),
        row({ kind: 'service', name: 'shop/postgres', id: '01a1-pg' }, 'c'),
      ],
      'k8s',
    );
    expect(hrefs(w)).toEqual([
      '/workloads?cluster=k8s&view=pods&wkind=Deployment&wname=checkout&wns=shop',
      '/nodes/kind-worker?cluster=k8s',
      '/applications/01a1-pg',
    ]);
    // Keyboard: real links, with the focus ring.
    for (const a of w.findAll('[data-testid="wc-row-link"]')) {
      expect(a.element.tagName).toBe('A');
      expect(a.classes()).toContain('focus-visible:outline-primary');
    }
    expect(w.findAll('[data-testid="wc-name"]')[2]!.text()).toBe('shop/postgres');
  });

  it('Docker: a container to its page, a host to its page; a Compose service without its host', async () => {
    const w = await rows(
      [
        row(
          {
            kind: 'container',
            name: 'shop-db-1',
            host: 'docker-01',
            composeProject: 'shop',
            composeService: 'db',
          },
          'a',
        ),
        row({ kind: 'host', name: 'docker-01' }, 'b'),
        row(
          { kind: 'container', name: 'shop-web-1', composeProject: 'shop', composeService: 'web' },
          'c',
        ),
      ],
      'fleet',
    );
    expect(hrefs(w)).toEqual([
      '/containers/docker-01/shop-db-1?cluster=fleet',
      '/hosts/docker-01?cluster=fleet',
      '/containers?cluster=fleet&project=shop&service=web',
    ]);
  });

  it('nothing to open: plain text (no host, no Compose service, no id; or no cluster given)', async () => {
    expect(objectLink({ kind: 'container', name: 'x' }, 'c')).toBeUndefined();
    expect(objectLink({ kind: 'service', name: 'redis' }, 'c')).toBeUndefined();
    expect(objectLink({ kind: 'workload', name: 'x' }, 'c')).toBeUndefined();
    const w = await rows([row({ kind: 'node', name: 'n1' }, 'a')]);
    expect(w.find('[data-testid="wc-row-link"]').exists()).toBe(false);
    expect(w.find('a').exists()).toBe(false);
  });
});
