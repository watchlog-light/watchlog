// SPDX-License-Identifier: AGPL-3.0-only
// Expected destinations in the dashboard (ADR-186, v0.7 slice 4): "Mark expected" and "Undo"
// on the Egress page's rows and in "Talks to the internet" (for one source or every workload /
// container, this destination or a pattern, this port or any), the expectations list with
// Remove and Add, the "Expected" and "Expected · <pattern>" labels, the role gate (only Owners
// and Admins see the buttons), and "New" as the API counts it. Kubernetes and Docker.
import type { EgressExpectation, EgressRow } from '@watchlog/api-types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EgressBadges from '@/components/egress/EgressBadges.vue';
import EgressTable from '@/components/egress/EgressTable.vue';
import ExpectationsList from '@/components/egress/ExpectationsList.vue';
import TalksToInternet from '@/components/egress/TalksToInternet.vue';
import { showsPattern, sourceInput, suggestPattern } from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, problem, USER } from './fetch-mock';
import { createPlugins } from './helpers';

const NOW = Date.UTC(2026, 10, 15, 9, 30, 0);
const H = 3_600_000;
const D = 24 * H;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const K8S = '01a1de8d-e52d-7188-9878-62ee5fd5309d';
const FLEET = '01a1de8d-e52d-7188-9878-62ee5fd5309e';

const k8sSource = (workload = 'web') => ({
  namespace: 'shop',
  workloadKind: 'Deployment',
  workload,
  firstSeen: iso(9 * D),
  lastSeen: iso(0),
  new: false,
});
const composeSource = {
  composeProject: 'storefront',
  composeService: 'api',
  firstSeen: iso(9 * D),
  lastSeen: iso(0),
  new: false,
};

function row(destination: string, over: Partial<EgressRow> = {}): EgressRow {
  return {
    destination,
    port: 443,
    kind: 'name',
    class: 'name',
    private: false,
    sources: [k8sSource()],
    firstSeen: iso(9 * D),
    firstSeenBefore: false,
    lastSeen: iso(0),
    sent: 1000,
    received: 2000,
    connections: 10,
    failed: 0,
    failedRatio: 0,
    badges: [],
    expected: null,
    alertId: null,
    ...over,
  };
}
const expected = (pattern: string, ids = ['e1']) => ({
  pattern,
  at: iso(D),
  by: 'Ada Admin',
  ids,
});

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountWith(component: object, props: object, role = USER.role as string) {
  const plugins = await createPlugins('/egress');
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

/** The open dialog (teleported to the body). */
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (testid: string) =>
  document.querySelector<HTMLInputElement>(`[role="dialog"] [data-testid="${testid}"]`)!;
async function click(el: HTMLElement | null) {
  el!.click();
  await flushPromises();
}
async function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
}
const submit = async () => {
  document
    .querySelector<HTMLFormElement>('[role="dialog"] form')!
    .dispatchEvent(new Event('submit'));
  await flushPromises();
};

describe('the words', () => {
  it('suggests a pattern, builds the API source, and says when the label needs the pattern', () => {
    expect(suggestPattern({ destination: 's3.eu-central-1.amazonaws.com', class: 'name' })).toBe(
      '*.amazonaws.com',
    );
    expect(suggestPattern({ destination: 'stripe.com', class: 'name' })).toBe('stripe.com');
    expect(suggestPattern({ destination: '203.0.113.0/24', class: 'public_network' })).toBe(
      '203.0.113.0/24',
    );
    expect(suggestPattern({ destination: 'redis', class: 'local_name' })).toBe('redis');
    expect(sourceInput(k8sSource())).toEqual({
      namespace: 'shop',
      workloadKind: 'Deployment',
      workload: 'web',
    });
    expect(sourceInput(composeSource)).toEqual({
      composeProject: 'storefront',
      composeService: 'api',
    });
    expect(
      sourceInput({
        host: 'docker-02',
        container: 'cron',
        firstSeen: '',
        lastSeen: '',
        new: false,
      }),
    ).toEqual({ host: 'docker-02', container: 'cron' });
    expect(
      showsPattern({ destination: 'api.stripe.com', expected: expected('api.stripe.com') }),
    ).toBe(false);
    expect(
      showsPattern({ destination: 'x.amazonaws.com', expected: expected('*.amazonaws.com') }),
    ).toBe(true);
  });

  it('labels "Expected" for the destination itself, "Expected · <pattern>" for a pattern or CIDR', async () => {
    const label = async (r: EgressRow) =>
      (await mountWith(EgressBadges, { row: r })).get('[data-badge="expected"]').text();
    expect(
      await label(
        row('api.stripe.com', { badges: ['expected'], expected: expected('api.stripe.com') }),
      ),
    ).toBe('Expected');
    expect(
      await label(
        row('s3.amazonaws.com', { badges: ['expected'], expected: expected('*.amazonaws.com') }),
      ),
    ).toBe('Expected · *.amazonaws.com');
    const raw = await mountWith(EgressBadges, {
      row: row('203.0.113.0/24', {
        class: 'public_network',
        kind: 'network',
        badges: ['raw_ip', 'expected'],
        expected: expected('203.0.0.0/16'),
      }),
    });
    expect(raw.findAll('[data-badge]').map((b) => b.text())).toEqual([
      'Raw IP',
      'Expected · 203.0.0.0/16',
    ]);
    expect(raw.get('[data-badge="expected"]').attributes('title')).toBe(
      'Marked expected by Ada Admin',
    );
  });
});

const ROWS: EgressRow[] = [
  row('telemetry.example.net', { badges: ['new'], sources: [k8sSource(), k8sSource('worker')] }),
  row('api.stripe.com', { badges: ['expected'], expected: expected('api.stripe.com') }),
  row('s3.eu-central-1.amazonaws.com', {
    badges: ['expected'],
    expected: expected('*.amazonaws.com', ['e2', 'e3']),
  }),
  row('Internet', { port: 0, kind: 'internet', class: 'internet' }),
];

describe('"Mark expected" and "Undo" on the Egress page rows', () => {
  it('Owners and Admins see them on every row but "Internet"; Viewers never', async () => {
    for (const role of ['owner', 'admin']) {
      const w = await mountWith(
        EgressTable,
        { rows: ROWS, clusterId: K8S, kind: 'kubernetes' },
        role,
      );
      const rows = w.findAll('[data-testid="egress-row"]');
      expect(rows.map((r) => r.find('[data-testid="expected-mark"]').exists())).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(rows.map((r) => r.find('[data-testid="expected-undo"]').exists())).toEqual([
        false,
        true,
        true,
        false,
      ]);
      expect(w.findAll('[data-testid="egress-card"] [data-testid="expected-mark"]')).toHaveLength(
        1,
      );
      mounted!.unmount();
      mounted = null;
    }
    const v = await mountWith(
      EgressTable,
      { rows: ROWS, clusterId: K8S, kind: 'kubernetes' },
      'viewer',
    );
    expect(v.find('[data-testid="expected-mark"]').exists()).toBe(false);
    expect(v.find('[data-testid="expected-undo"]').exists()).toBe(false);
    expect(v.text()).not.toContain('Actions');
  });

  it('Kubernetes: one workload, this destination and port', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/egress/expected': { status: 201, body: { expectation: {}, updated: 1 } },
    });
    const w = await mountWith(EgressTable, { rows: ROWS, clusterId: K8S, kind: 'kubernetes' });
    await w.get('[data-testid="egress-row"] [data-testid="expected-mark"]').trigger('click');
    await flushPromises();
    expect(dialog()!.textContent).toContain('telemetry.example.net:443');
    // Two sources: "every workload" is the default; pick one.
    expect(inDialog('scope-all').checked).toBe(true);
    const labels = [...dialog()!.querySelectorAll('label')].map((l) => l.textContent!.trim());
    expect(labels).toEqual(
      expect.arrayContaining(['Only shop / web', 'Only shop / worker', 'Every workload']),
    );
    await click(dialog()!.querySelector<HTMLInputElement>('input[name="scope"][value="1"]'));
    await submit();
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/egress/expected',
      body: {
        cluster: K8S,
        pattern: 'telemetry.example.net',
        port: 443,
        source: { namespace: 'shop', workloadKind: 'Deployment', workload: 'worker' },
      },
    });
    expect(w.emitted('changed')).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  it('Kubernetes: a pattern for every workload, any port; the server’s reason when refused', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/egress/expected': [
        problem(400, '*.net covers too much: give at least two labels'),
        { status: 201, body: { expectation: {}, updated: 3 } },
      ],
    });
    const w = await mountWith(EgressTable, { rows: ROWS, clusterId: K8S, kind: 'kubernetes' });
    await w.get('[data-testid="expected-mark"]').trigger('click');
    await flushPromises();
    await click(inDialog('what-pattern'));
    expect(inDialog('expected-pattern').querySelector('input')!.value).toBe('*.example.net');
    expect(inDialog('any-port').checked).toBe(true);
    await type(inDialog('expected-pattern').querySelector('input')!, '*.net');
    await submit();
    expect(inDialog('expected-error').textContent).toContain('Not accepted: *.net covers too much');
    expect(w.emitted('changed')).toBeUndefined();
    await type(inDialog('expected-pattern').querySelector('input')!, '*.example.net');
    await submit();
    expect(calls.at(-1)!.body).toEqual({ cluster: K8S, pattern: '*.example.net' });
    expect(w.emitted('changed')).toHaveLength(1);
  });

  it('Docker: one Compose service, in the fleet’s words', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/egress/expected': { status: 201, body: { expectation: {}, updated: 1 } },
    });
    const rows = [row('hooks.slack.com', { sources: [composeSource] })];
    const w = await mountWith(EgressTable, { rows, clusterId: FLEET, kind: 'server' });
    await w.get('[data-testid="expected-mark"]').trigger('click');
    await flushPromises();
    const labels = [...dialog()!.querySelectorAll('label')].map((l) => l.textContent!.trim());
    expect(labels).toEqual(
      expect.arrayContaining(['Only storefront · api', 'Every container or Compose service']),
    );
    // One source: it is the default.
    await submit();
    expect(calls.at(-1)!.body).toEqual({
      cluster: FLEET,
      pattern: 'hooks.slack.com',
      port: 443,
      source: { composeProject: 'storefront', composeService: 'api' },
    });
  });

  it('Undo removes every expectation that covers the row', async () => {
    const { calls } = mockFetch({
      'DELETE /api/v1/egress/expected/e2': { status: 204 },
      'DELETE /api/v1/egress/expected/e3': { status: 204 },
    });
    const w = await mountWith(EgressTable, { rows: ROWS, clusterId: K8S, kind: 'kubernetes' });
    const undo = w.findAll('[data-testid="egress-row"]')[2]!.get('[data-testid="expected-undo"]');
    expect(undo.attributes('title')).toContain('Removes *.amazonaws.com');
    await undo.trigger('click');
    await flushPromises();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/v1/egress/expected/e2',
      'DELETE /api/v1/egress/expected/e3',
    ]);
    expect(w.emitted('changed')).toHaveLength(1);
  });
});

describe('"Talks to the internet": marking from a source page', () => {
  const month = `GET /api/v1/egress?cluster=${FLEET}&project=storefront&service=api&from=${NOW / 1000 - 30 * 86_400}`;
  const today = `GET /api/v1/egress?cluster=${FLEET}&project=storefront&service=api`;
  const answer = (rows: EgressRow[]) => ({
    cluster: { id: FLEET, kind: 'server' },
    range: { from: iso(D), to: iso(0) },
    learning: {
      since: iso(41 * D),
      until: iso(34 * D),
      learning: false,
      days: 41,
      firstSeenPending: false,
    },
    traffic: true,
    summary: { destinations: rows.length, sources: 1, new: 0, rawIp: 0, failing: 0 },
    rows,
    total: rows.length,
    truncated: false,
  });

  it('Docker Compose service: marks for that service, then reloads; Viewers see no button', async () => {
    const rows = [row('hooks.slack.com', { sources: [composeSource] })];
    const marked = [
      row('hooks.slack.com', {
        sources: [composeSource],
        badges: ['expected'],
        expected: expected('hooks.slack.com'),
      }),
    ];
    const { calls } = mockFetch({
      [month]: [
        { status: 200, body: answer(rows) },
        { status: 200, body: answer(marked) },
      ],
      [today]: [
        { status: 200, body: answer(rows) },
        { status: 200, body: answer(marked) },
      ],
      'POST /api/v1/egress/expected': { status: 201, body: { expectation: {}, updated: 1 } },
    });
    const props = {
      clusterId: FLEET,
      kind: 'server',
      query: { project: 'storefront', service: 'api' },
      now: NOW,
    };
    const w = await mountWith(TalksToInternet, props);
    await w.get('[data-testid="talks-row"] [data-testid="expected-mark"]').trigger('click');
    await flushPromises();
    const radios = dialog()!.querySelectorAll('input[name="scope"]');
    expect(radios).toHaveLength(2);
    await submit();
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      source: { composeProject: 'storefront', composeService: 'api' },
    });
    expect(w.get('[data-testid="talks-row"]').text()).toContain('Expected');
    expect(w.find('[data-testid="expected-undo"]').exists()).toBe(true);
    mounted!.unmount();
    mounted = null;

    mockFetch({
      [month]: { status: 200, body: answer(rows) },
      [today]: { status: 200, body: answer(rows) },
    });
    const v = await mountWith(TalksToInternet, props, 'viewer');
    expect(v.findAll('[data-testid="talks-row"]')).toHaveLength(1);
    expect(v.find('[data-testid="expected-mark"]').exists()).toBe(false);
  });

  it('Kubernetes workload: the workload is the only source offered', async () => {
    const kMonth = `GET /api/v1/egress?cluster=${K8S}&namespace=shop&kind=Deployment&workload=web&from=${NOW / 1000 - 30 * 86_400}`;
    const kToday = `GET /api/v1/egress?cluster=${K8S}&namespace=shop&kind=Deployment&workload=web`;
    const rows = [row('api.github.com')];
    const { calls } = mockFetch({
      [kMonth]: { status: 200, body: answer(rows) },
      [kToday]: { status: 200, body: answer(rows) },
      'POST /api/v1/egress/expected': { status: 201, body: { expectation: {}, updated: 1 } },
    });
    const w = await mountWith(TalksToInternet, {
      clusterId: K8S,
      kind: 'kubernetes',
      query: { namespace: 'shop', kind: 'Deployment', workload: 'web' },
      now: NOW,
    });
    await w.get('[data-testid="expected-mark"]').trigger('click');
    await flushPromises();
    expect(dialog()!.textContent).toContain('Only shop / web');
    await click(inDialog('scope-all'));
    await submit();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      cluster: K8S,
      pattern: 'api.github.com',
      port: 443,
    });
  });
});

describe('the expectations list', () => {
  const list = (cluster: string) => `GET /api/v1/egress/expected?cluster=${cluster}`;
  const item = (over: Partial<EgressExpectation>): EgressExpectation => ({
    id: 'e1',
    pattern: '*.amazonaws.com',
    port: null,
    source: null,
    comment: null,
    createdAt: iso(2 * H),
    createdBy: 'Ada Admin',
    matches: 3,
    ...over,
  });

  it('Kubernetes: patterns, ports, sources and who; Remove and Add', async () => {
    const { calls } = mockFetch({
      [list(K8S)]: [
        {
          status: 200,
          body: {
            items: [
              item({}),
              item({
                id: 'e2',
                pattern: 'api.stripe.com',
                port: 443,
                source: { namespace: 'shop', workloadKind: 'Deployment', workload: 'orders' },
                matches: 1,
              }),
            ],
          },
        },
        { status: 200, body: { items: [item({ id: 'e2', pattern: 'api.stripe.com' })] } },
        { status: 200, body: { items: [] } },
      ],
      'DELETE /api/v1/egress/expected/e1': { status: 204 },
      'POST /api/v1/egress/expected': [
        problem(400, 'A CIDR is at least /8 for IPv4: this covers too much'),
        { status: 201, body: { expectation: {}, updated: 0 } },
      ],
    });
    const w = await mountWith(ExpectationsList, { clusterId: K8S, kind: 'kubernetes', now: NOW });
    const items = w.findAll('[data-testid="expectation"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toContain('*.amazonaws.com · any port');
    expect(items[0]!.text()).toContain('Every workload');
    expect(items[0]!.text()).toContain('covers 3 destinations now');
    expect(items[0]!.text()).toContain('by Ada Admin, 2 h ago');
    expect(items[1]!.text()).toContain('api.stripe.com:443');
    expect(items[1]!.text()).toContain('shop / orders');
    expect(items[1]!.text()).toContain('covers 1 destination now');
    expect(w.get('[data-testid="expectations-count"]').text()).toBe('2');

    await items[0]!.get('[data-testid="expectation-remove"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/e1'))).toBe(true);
    expect(w.findAll('[data-testid="expectation"]')).toHaveLength(1);
    expect(w.emitted('changed')).toHaveLength(1);

    // Add: a bad port is caught here; the server's reason is shown; then it goes through.
    await w.get('[data-testid="expectations-pattern"] input').setValue('10.0.0.0/7');
    await w.get('[data-testid="expectations-port"] input').setValue('99999');
    await w.get('[data-testid="expectations-add"]').trigger('submit');
    await flushPromises();
    expect(w.get('[data-testid="expectations-error"]').text()).toContain('1 to 65535');
    await w.get('[data-testid="expectations-port"] input').setValue('');
    await w.get('[data-testid="expectations-add"]').trigger('submit');
    await flushPromises();
    expect(w.get('[data-testid="expectations-error"]').text()).toContain('at least /8');
    await w.get('[data-testid="expectations-pattern"] input').setValue('10.0.0.0/8');
    await w.get('[data-testid="expectations-port"] input').setValue('5432');
    await w.get('[data-testid="expectations-add"]').trigger('submit');
    await flushPromises();
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({
      cluster: K8S,
      pattern: '10.0.0.0/8',
      port: 5432,
    });
    expect(w.get('[data-testid="expectations-empty"]').text()).toContain('*.amazonaws.com');
  });

  it('Docker: the fleet’s words; a Viewer reads it with no Remove and no Add', async () => {
    mockFetch({
      [list(FLEET)]: {
        status: 200,
        body: {
          items: [
            item({ source: { composeProject: 'storefront', composeService: 'api' } }),
            item({ id: 'e2', pattern: 'hooks.slack.com', source: null }),
          ],
        },
      },
    });
    const w = await mountWith(
      ExpectationsList,
      { clusterId: FLEET, kind: 'server', now: NOW },
      'viewer',
    );
    const items = w.findAll('[data-testid="expectation"]');
    expect(items[0]!.text()).toContain('storefront · api');
    expect(items[1]!.text()).toContain('Every container or Compose service');
    expect(w.find('[data-testid="expectation-remove"]').exists()).toBe(false);
    expect(w.find('[data-testid="expectations-add"]').exists()).toBe(false);
  });
});

describe('"New" as the API counts it (private networks and local names never New)', () => {
  it('shows New only where the API says so; private and local rows carry their label only', async () => {
    const rows = [
      row('fresh.example.org', { badges: ['new'] }),
      row('10.244.1.0/24', { class: 'private_network', kind: 'network', private: true }),
      row('redis', { class: 'local_name', port: 6379 }),
    ];
    const w = await mountWith(EgressTable, { rows, clusterId: K8S, kind: 'kubernetes' }, 'viewer');
    const badges = w
      .findAll('[data-testid="egress-row"]')
      .map((r) => r.findAll('[data-badge],[data-class]').map((b) => b.text()));
    expect(badges).toEqual([['New'], ['Private network'], ['Local name']]);
  });
});
