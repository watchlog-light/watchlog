// SPDX-License-Identifier: AGPL-3.0-only
// The probable-cause panel (v0.4 slice 6, ADR-146 to ADR-148, ADR-156) in every state, from
// GET /causes answers replayed from the kind and Docker e2e recordings (slices 1 to 5):
// likely with its chain, "Also possible", possible only, no clear cause (checks open),
// loading, network flows off, a resolved alert ("was likely"), the compact form, an error
// that never breaks the page, "Copy as text", and the Needs-attention line.
import type { Causes, OverviewProblem } from '@watchlog/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CausePanel from '@/components/causes/CausePanel.vue';
import AttentionCard from '@/components/overview/AttentionCard.vue';
import {
  causesText,
  checksSummary,
  mcpTool,
  panelState,
  possibleLine,
  problemCause,
  say,
} from '@/lib/causes';
import type { Overview } from '@/lib/overview';
import { mockFetch, type Route } from './fetch-mock';
import { createPlugins } from './helpers';
import kubeDep from './fixtures/causes/kube-dependency-down.json';
import dockerDep from './fixtures/causes/docker-dependency-down.json';
import kubeRabbit from './fixtures/causes/kube-rabbit-consumer-oom.json';
import dockerRabbit from './fixtures/causes/docker-rabbit-consumer-oom.json';
import dockerDns from './fixtures/causes/docker-dns-typo.json';
import kubeDrain from './fixtures/causes/kube-node-drain.json';
import dockerSilent from './fixtures/causes/docker-host-silent.json';
import kubeThrottle from './fixtures/causes/kube-cpu-throttle.json';
// Captured live from the e2e backend (GET /causes, the Docker host renamed docker-01).
import liveGreedy from './fixtures/causes/kube-greedy-also.json';
import livePossible from './fixtures/causes/kube-alert-possible.json';
import liveNone from './fixtures/causes/kube-alert-none.json';
import liveWasKube from './fixtures/causes/kube-alert-resolved.json';
import liveWasDocker from './fixtures/causes/docker-alert-resolved.json';

const answer = (a: unknown) => a as Causes;
const KUBE = answer(kubeDep).cluster.id;
const DOCKER = answer(dockerDep).cluster.id;
const url = (cluster: string, subject: string) =>
  `GET /api/v1/causes?cluster=${encodeURIComponent(cluster)}&subject=${encodeURIComponent(subject)}`;
const subjectOf = (a: Causes) => `${a.subject.kind}:${a.subject.ref}`;

/** Every cause possible: the "possible" state as the engine gives it (ADR-147). */
function possible(a: Causes): Causes {
  return {
    ...a,
    state: 'possible',
    headline: { code: 'possible', facts: { name: a.subject.name, n: 2 } },
    causes: [
      ...a.causes.map((c) => ({ ...c, strength: 'possible' as const })),
      ...answer(kubeThrottle).causes.map((c) => ({ ...c, strength: 'possible' as const })),
    ],
    checks: a.checks.map((c) => (c.result === 'explains' ? { ...c, result: 'possible' } : c)),
  };
}

/** No clear cause: nothing matched, what was checked is open. */
function none(a: Causes): Causes {
  return {
    ...a,
    state: 'none',
    headline: { code: 'none_found', facts: { name: a.subject.name, n: a.checks.length, found: 1 } },
    causes: [],
    checks: a.checks.map((c) => (c.result === 'explains' ? { ...c, result: 'possible' } : c)),
  };
}

async function render(
  a: Causes | Route | Route[],
  props: Partial<{ subject: string; clusterId: string; compact: boolean; quiet: boolean }> = {},
) {
  const isAnswer = (x: unknown): x is Causes => !!x && typeof x === 'object' && 'checks' in x;
  const cluster = props.clusterId ?? (isAnswer(a) ? a.cluster.id : KUBE);
  const subject = props.subject ?? (isAnswer(a) ? subjectOf(a) : 'pod:shop/web');
  const route = isAnswer(a) ? { status: 200, body: a } : a;
  const { calls } = mockFetch({ [url(cluster, subject)]: route });
  const plugins = await createPlugins();
  const w = mount(CausePanel, {
    props: { clusterId: cluster, subject, name: 'web', ...props },
    global: { plugins: [plugins.pinia, plugins.router, plugins.i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, calls };
}

/** A summary's words, its parts joined as a screen reader reads them. */
const said = (el: { findAll(s: string): { text(): string }[] }) =>
  el
    .findAll('span')
    .map((x) => x.text())
    .join(' ');
const texts = (w: ReturnType<typeof mount>, testid: string) =>
  w.findAll(`[data-testid="${testid}"]`).map((x) => x.text());

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the panel: likely, on Kubernetes and Docker', () => {
  it('kind dependency down: headline, three steps with connectors, where it starts, links, checks closed', async () => {
    const { w } = await render(answer(kubeDep));
    const panel = w.get('[data-testid="cause-panel"]');
    expect(panel.attributes('data-state')).toBe('likely');
    expect(w.get('[data-testid="cause-chip"]').text()).toBe('Likely');
    expect(w.get('h2').text()).toBe('Likely cause');
    // The section is named by its heading.
    expect(panel.attributes('aria-labelledby')).toBe(w.get('h2').attributes('id'));
    expect(w.get('[data-testid="cause-headline"]').text()).toBe(
      'web fails because api was scaled to 0: nothing answers its calls.',
    );
    const steps = w.findAll('[data-testid="cause-step"]');
    expect(steps).toHaveLength(3);
    expect(texts(w, 'cause-source')).toEqual(['service map', 'Kubernetes', 'change marker']);
    expect(texts(w, 'cause-hop')).toEqual(['calls', 'because']);
    expect(steps[0]!.text()).toContain('causes-e2e/web → causes-e2e/api');
    expect(steps[1]!.text()).toContain('Deployment');
    // Only the last step is where it starts.
    expect(steps.map((s) => s.find('[data-testid="cause-root"]').exists())).toEqual([
      false,
      false,
      true,
    ]);
    // Each step links to its object: the edge on the map, the workload, the change's workload.
    const links = w.findAll('[data-testid="cause-link"]');
    expect(links.map((l) => l.text())).toEqual([
      'Open in service map',
      'Open workload',
      'Open change',
    ]);
    expect(links[0]!.attributes('href')).toContain('/service-map');
    expect(links[1]!.attributes('href')).toContain('wname=api');
    // "What we checked": closed when a cause is likely, with its summary.
    const details = w.get('[data-testid="cause-checks"]');
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(said(details.get('summary'))).toBe('What we checked · 7 checks, 1 explains it');
    expect(w.findAll('[data-testid="cause-check"]')).toHaveLength(7);
    // The footer: no AI, and the MCP tool for anything but an alert.
    expect(w.get('[data-testid="cause-footer"]').text()).toContain('No AI, no scores.');
    expect(w.get('[data-testid="cause-footer"]').text()).toContain('explain_problem');
    // Every sentence was worded: no raw key, placeholder or null.
    expect(panel.text()).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
  });

  it('Docker dependency stopped: the Compose service, the lookup and the stopped container', async () => {
    const { w } = await render(answer(dockerDep));
    expect(w.get('[data-testid="cause-headline"]').text()).toContain('was stopped (exit code 0)');
    expect(texts(w, 'cause-source')).toEqual(['DNS', 'Docker']);
    expect(texts(w, 'cause-hop')).toEqual(['calls']);
    const links = w.findAll('[data-testid="cause-link"]');
    expect(links[1]!.attributes('href')).toContain('/containers/docker-01/causes-e2e-api-1');
    expect(w.text()).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
  });

  it.each([
    ['kind', kubeRabbit, 'consumed by'],
    ['Docker', dockerRabbit, 'consumed by'],
  ])(
    'RabbitMQ lost consumer on %s: the queue, then the consumer it links to',
    async (_, a, hop) => {
      const { w } = await render(answer(a));
      expect(w.get('[data-testid="cause-headline"]').text()).toMatch(
        /^orders is filling up because its consumer .+ is OOM-killed at its .+ memory limit\.$/,
      );
      expect(texts(w, 'cause-hop')).toEqual([hop]);
      expect(texts(w, 'cause-source')[0]).toBe('application');
      // The application's step carries the RabbitMQ logo.
      expect(w.find('[data-logo="rabbitmq"]').exists()).toBe(true);
    },
  );

  it.each([
    ['kind node drain', kubeDrain, 'node_or_host'],
    ['Docker DNS typo', dockerDns, 'dns_nxdomain'],
    ['Docker silent host', dockerSilent, 'node_or_host'],
  ])('%s: worded, the last step where it starts', async (_, a, rule) => {
    expect(answer(a).causes[0]!.rule).toBe(rule);
    const { w } = await render(answer(a));
    expect(w.findAll('[data-testid="cause-root"]')).toHaveLength(1);
    expect(w.text()).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
  });

  it('a second cause is "Also possible"', async () => {
    const a = answer(kubeDep);
    const two = {
      ...a,
      causes: [
        ...a.causes,
        ...answer(kubeThrottle).causes.map((c) => ({ ...c, strength: 'possible' as const })),
      ],
    };
    const { w } = await render(two);
    const also = w.get('[data-testid="cause-also"]');
    expect(also.get('h3').text()).toBe('Also possible');
    expect(also.findAll('[data-testid="cause-possible"]')).toHaveLength(1);
    expect(also.text()).toContain('CPU-throttled');
    expect(also.get('[data-testid="cause-chip"]').text()).toBe('Possible');
  });
});

describe('the other states', () => {
  it('possible only: the chip says Possible, no chain, the leads, checks closed', async () => {
    const { w } = await render(possible(answer(kubeDep)));
    expect(w.get('[data-testid="cause-panel"]').attributes('data-state')).toBe('possible');
    expect(w.get('header [data-testid="cause-chip"]').text()).toBe('Possible');
    expect(w.get('h2').text()).toBe('Possible causes');
    expect(w.get('[data-testid="cause-headline"]').text()).toBe(
      'Nothing proves one cause for causes-e2e/web. These 2 could explain it.',
    );
    expect(w.find('[data-testid="cause-chain"]').exists()).toBe(false);
    expect(w.get('[data-testid="cause-also"] h3').text()).toBe('Leads to check');
    expect(w.findAll('[data-testid="cause-possible"]')).toHaveLength(2);
    expect((w.get('[data-testid="cause-checks"]').element as HTMLDetailsElement).open).toBe(false);
  });

  it('no clear cause (Docker): checks open, every check worded', async () => {
    const { w } = await render(none(answer(dockerDns)));
    expect(w.get('[data-testid="cause-chip"]').text()).toBe('No clear cause');
    const details = w.get('[data-testid="cause-checks"]');
    expect((details.element as HTMLDetailsElement).open).toBe(true);
    expect(said(details.get('summary'))).toMatch(/^What we checked · 6 checks, 2 possible$/);
    expect(w.find('[data-testid="cause-chain"]').exists()).toBe(false);
    expect(w.text()).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
  });

  it('"What we checked" opens from the keyboard: a native disclosure with a summary', async () => {
    const { w } = await render(answer(kubeDep));
    const details = w.get('[data-testid="cause-checks"]').element as HTMLDetailsElement;
    const summary = details.querySelector('summary')!;
    // The summary is the details' first child: Enter and Space toggle it in every browser.
    expect(details.firstElementChild).toBe(summary);
    summary.click();
    expect(details.open).toBe(true);
  });

  it('loading: a skeleton, marked busy, for the first moments', async () => {
    let release!: (v: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = r))),
    );
    vi.useFakeTimers();
    const plugins = await createPlugins();
    const w = mount(CausePanel, {
      props: { clusterId: KUBE, subject: 'pod:shop/web', name: 'shop/web' },
      global: { plugins: [plugins.pinia, plugins.router, plugins.i18n] },
    });
    await vi.advanceTimersByTimeAsync(200);
    const loading = w.get('[data-testid="cause-loading"]');
    expect(loading.attributes('aria-busy')).toBe('true');
    expect(loading.text()).toContain('Checking shop/web and what is around it…');
    expect(loading.findAll('.skeleton').length).toBeGreaterThan(0);
    expect(w.find('[data-testid="cause-copy"]').exists()).toBe(false);
    release(
      new Response(JSON.stringify(kubeDep), { headers: { 'content-type': 'application/json' } }),
    );
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await flushPromises();
    expect(w.find('[data-testid="cause-loading"]').exists()).toBe(false);
    expect(w.get('[data-testid="cause-panel"]').attributes('data-state')).toBe('likely');
  });

  it('network flows off: the banner says the dependency rules could not run', async () => {
    const a = none(answer(kubeDep));
    const off: Causes = {
      ...a,
      headline: { code: 'none_flows_off', facts: { name: 'causes-e2e/web' } },
      flowsOff: [{ node: 'demo-worker', cause: 'kernel', reason: 'no BTF' }],
      checks: a.checks.map((c) =>
        c.topic === 'dependencies'
          ? { ...c, code: 'dependencies_flows_off', result: 'not_run' as const }
          : c,
      ),
    };
    const { w } = await render(off);
    const banner = w.get('[data-testid="cause-flows-off"]');
    expect(banner.text()).toContain('Network flows are off on demo-worker');
    expect(banner.get('a').text()).toBe('How to turn network flows on');
    expect(w.get('[data-testid="cause-headline"]').text()).toContain(
      "Without network flows we couldn't check the services it calls.",
    );
    expect(said(w.get('summary'))).toContain("1 couldn't run");
  });

  it('a resolved alert: "Was likely", the resolution line, explain_alert', async () => {
    const a = answer(kubeDep);
    const was: Causes = {
      ...a,
      subject: {
        kind: 'alert',
        ref: '01a1c74f-028f-74f2-8692-f1b4c3e65d7e',
        name: 'web cannot reach api',
        platform: 'kubernetes',
      },
      resolvedAt: '2026-11-10T19:45:00.000Z',
    };
    const { w } = await render(was);
    expect(w.get('[data-testid="cause-panel"]').attributes('data-state')).toBe('was');
    expect(w.get('[data-testid="cause-chip"]').text()).toBe('Was likely');
    expect(w.get('[data-testid="cause-resolved"]').text()).toMatch(/^Resolved at .+\.$/);
    expect(w.get('[data-testid="cause-meta"]').text()).toMatch(/^resolved /);
    expect(said(w.get('summary'))).toContain('1 explained it');
    expect(w.get('[data-testid="cause-footer"]').text()).toContain('explain_alert');
  });

  it('compact (the edge panel, a phone): the headline and the chain only', async () => {
    const { w } = await render(answer(kubeDep), { compact: true });
    expect(w.get('[data-testid="cause-panel"]').attributes('data-compact')).toBe('true');
    expect(w.findAll('[data-testid="cause-step"]')).toHaveLength(3);
    for (const gone of ['cause-checks', 'cause-footer', 'cause-copy', 'cause-also'])
      expect(w.find(`[data-testid="${gone}"]`).exists(), gone).toBe(false);
  });

  it('an error never breaks the page: one line and a retry that loads the answer', async () => {
    const { w, calls } = await render([
      { status: 500, body: { type: 'about:blank', title: 'Error', status: 500, detail: 'x' } },
      { status: 200, body: kubeDep },
    ]);
    expect(w.get('[data-testid="cause-panel"]').attributes('data-state')).toBe('error');
    expect(w.get('[data-testid="cause-error"]').text()).toContain("couldn't work out the cause");
    await w.get('[data-testid="cause-retry"]').trigger('click');
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(w.get('[data-testid="cause-panel"]').attributes('data-state')).toBe('likely');
  });

  it('quiet: nothing on an object with nothing to explain, nor on an error', async () => {
    const healthy: Causes = {
      ...none(answer(dockerDns)),
      symptomSince: null,
      headline: { code: 'none_no_changes', facts: { name: 'web', n: 6, minutes: 60 } },
      checks: answer(dockerDns).checks.map((c) => ({ ...c, result: 'ok' as const })),
    };
    expect(
      (await render(healthy, { quiet: true })).w.find('[data-testid="cause-panel"]').exists(),
    ).toBe(false);
    document.body.innerHTML = '';
    const err = await render(
      { status: 404, body: { status: 404, detail: 'gone' } },
      { quiet: true },
    );
    expect(err.w.find('[data-testid="cause-panel"]').exists()).toBe(false);
  });
});

describe('live answers (captured from the e2e backend)', () => {
  it('kind greedy: likely unschedulable, the cordoned node "Also possible"', async () => {
    const { w } = await render(answer(liveGreedy));
    expect(w.get('[data-testid="cause-headline"]').text()).toMatch(
      /can't be scheduled: it requests 64 CPU/,
    );
    expect(w.get('[data-testid="cause-also"] h3').text()).toBe('Also possible');
    expect(w.get('[data-testid="cause-possible-fact"]').text()).toMatch(/cordoned/);
  });

  it('kind pinned alert: possible only, one lead', async () => {
    const { w } = await render(answer(livePossible));
    expect(w.get('header [data-testid="cause-chip"]').text()).toBe('Possible');
    expect(w.get('[data-testid="cause-headline"]').text()).toMatch(/This one could explain it\.$/);
    expect(w.findAll('[data-testid="cause-possible"]')).toHaveLength(1);
    expect(w.text()).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
  });

  it('kind hot alert: no clear cause, checks open, counted as the headline counts', async () => {
    const a = answer(liveNone);
    const { w } = await render(a);
    expect((w.get('[data-testid="cause-checks"]').element as HTMLDetailsElement).open).toBe(true);
    const n = a.checks.filter((c) => c.result !== 'not_applicable').length;
    expect(said(w.get('summary'))).toBe(`What we checked · ${n} checks, none explains it`);
    expect(w.get('[data-testid="cause-headline"]').text()).toContain(`We checked ${n} things`);
  });

  it.each([
    ['kind', liveWasKube],
    ['Docker', liveWasDocker],
  ])('%s resolved alert: was likely', async (_, a) => {
    const { w } = await render(answer(a));
    expect(w.get('[data-testid="cause-chip"]').text()).toBe('Was likely');
    expect(w.find('[data-testid="cause-resolved"]').exists()).toBe(true);
    expect(w.text()).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
  });
});

describe('Copy as text', () => {
  it('copies the headline and the chain, then says Copied', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { w } = await render(answer(kubeDep));
    const button = w.get('[data-testid="cause-copy"]');
    expect(button.attributes('aria-label')).toBe('Copy the headline and the chain as text');
    await button.trigger('click');
    await flushPromises();
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'Likely cause: web fails because api was scaled to 0: nothing answers its calls.',
    );
    expect(lines[1]).toMatch(
      /^1\. causes-e2e\/web → causes-e2e\/api \(connection, service map\): /,
    );
    expect(lines[2]).toBe('   ↓ calls');
    expect(lines.find((l) => l.startsWith('3. '))).toMatch(/— where it starts$/);
    expect(text).not.toMatch(/causes\.|\{\w+\}|undefined|null/);
    expect(button.text()).toBe('Copied');
  });

  it('possible causes are listed when none is likely', () => {
    const t = (k: string, v?: Record<string, unknown>) => `${k}${v ? JSON.stringify(v) : ''}`;
    const text = causesText(possible(answer(dockerDep)), t, (x) => x);
    expect(text.split('\n').filter((l) => l.startsWith('causes.text.possible'))).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('panelState, mcpTool, checksSummary', () => {
    expect(panelState({ state: 'likely', resolvedAt: 'x' })).toBe('was');
    expect(panelState({ state: 'none', resolvedAt: 'x' })).toBe('none');
    expect(mcpTool('alert:1')).toBe('explain_alert');
    expect(mcpTool('edge:a>b:80')).toBe('explain_problem');
    expect(checksSummary([{ result: 'ok' }, { result: 'not_run' }]).map((l) => l.key)).toEqual([
      'causes.panel.checksSummary',
      'causes.panel.summary.notRun',
      'causes.panel.summary.none',
    ]);
  });
});

describe('Needs attention: one line under each problem (ADR-156)', () => {
  const base: OverviewProblem = {
    id: 'p',
    source: 'alert',
    severity: 'critical',
    type: 'connections',
    title: 'web cannot reach api',
    why: null,
    since: null,
    alertId: 'a1',
    object: null,
    related: 0,
  };
  const a = answer(kubeDep);
  const items: OverviewProblem[] = [
    {
      ...base,
      id: 'likely',
      causeState: 'likely',
      likelyCause: {
        rule: 'dependency_down',
        code: a.causes[0]!.code,
        facts: a.causes[0]!.facts,
        since: a.causes[0]!.since,
        headline: a.headline,
        subject: 'workload:causes-e2e/Deployment/web',
      },
    },
    {
      ...base,
      id: 'possible',
      causeState: 'possible',
      // Where each starts, as the overview sends it (a rollout, the throttled container).
      possibleCauses: [
        {
          rule: 'bad_change',
          code: 'bad_change',
          facts: { name: 'slow' },
          since: null,
          where: { code: 'rolled_out', facts: { from: '1', to: '2' }, name: 'backend' },
        },
        {
          rule: 'cpu_throttled',
          code: 'cpu_throttled',
          facts: { pct: 35 },
          since: null,
          where: {
            code: 'cpu_throttled',
            facts: { container: 'backend', pct: 100, limitCores: 0.1 },
            name: 'backend',
          },
        },
      ],
    },
    { ...base, id: 'none', causeState: 'none' },
    { ...base, id: 'later' },
  ];

  it('problemCause: likely, possible joined, none, nothing when not worked out', () => {
    const t = (k: string) => k;
    expect(items.map((p) => problemCause(p)?.state ?? null)).toEqual([
      'likely',
      'possible',
      'none',
      null,
    ]);
    expect(problemCause(items[1]!)!.line.map((l) => l.key)).toEqual([
      'causes.step.rolled_out',
      'causes.step.cpu_throttled',
    ]);
    // An answer without a step falls back to the rule's one-line cause.
    expect(
      say(t, possibleLine({ rule: 'bad_change', code: 'bad_change', facts: {}, since: null })),
    ).toBe('causes.cause.bad_change');
  });

  it('possibleLine: names the object unless its sentence does, without the full stop', async () => {
    const { global: i18n } = (await createPlugins()).i18n;
    const t = (k: string, v?: Record<string, unknown>, n?: number) =>
      n === undefined ? i18n.t(k, v ?? {}) : i18n.t(k, v ?? {}, n);
    const [rollout, throttled] = items[1]!.possibleCauses!.map((c) => say(t, possibleLine(c)));
    expect(rollout).toBe('backend: Rolled out: revision 1 → 2');
    expect(throttled).toBe('backend is throttled 100% of the time at its 100m CPU limit');
  });

  it.each(['kubernetes', 'docker'] as const)(
    'renders the chips and sentences (%s)',
    async (kind) => {
      const plugins = await createPlugins();
      const overview = {
        kind,
        health: 'critical',
        problems: { items, critical: 4, warning: 0, types: [], silenced: 0, oldestSince: null },
      } as unknown as Overview;
      const w = mount(AttentionCard, {
        props: { overview },
        global: { plugins: [plugins.pinia, plugins.router, plugins.i18n] },
      });
      const lines = w.findAll('[data-testid="attention-cause"]');
      expect(lines).toHaveLength(3);
      expect(lines.map((l) => l.get('[data-testid="cause-chip"]').text())).toEqual([
        'Likely',
        'Possible',
        'No clear cause',
      ]);
      expect(lines[0]!.text()).toContain('was scaled to 0: nothing answers its calls.');
      expect(lines[1]!.text()).toContain(
        'backend: Rolled out: revision 1 → 2 · backend is throttled 100% of the time at its 100m CPU limit',
      );
      expect(lines[1]!.text()).not.toContain('The new version fails');
      expect(lines[2]!.text()).toContain('Nothing we checked explains it.');
    },
  );
});

// The Docker fleet's answers carry their own cluster id.
it('fixtures: kind and Docker answers', () => {
  expect(KUBE).not.toBe(DOCKER);
  expect(answer(dockerDep).cluster.kind).toBe('docker');
});
