// SPDX-License-Identifier: AGPL-3.0-only
// Settings → API tokens (ADR-125, v0.2 slice 2): the list, the empty state, creating a
// token and its one-time reveal, revoking, the detail with its history and MCP activity,
// the phone cards and the read-only demo's state (ADR-122, ADR-130).
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import type { ApiToken, ApiTokenDetail } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseUrl,
  callsLabel,
  expiryNote,
  lastUsedLabel,
  snippet,
  type McpCall,
} from '@/lib/api-tokens';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import ApiTokenPage from '@/views/ApiTokenPage.vue';
import SettingsPage from '@/views/SettingsPage.vue';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const NOW = Date.now();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const DAY = 86_400_000;
const VALUE = 'wl_pat_9fK2mQ7xTb4LhR8vN3cZ1sWd6YpE0aGuXyZ12345678';

const token = (over: Partial<ApiToken>): ApiToken => ({
  id: '01a1a000-0000-7000-8000-000000000001',
  name: 'Claude Code · laptop',
  prefix: 'wl_pat_7Kq2',
  scope: 'read',
  createdAt: iso(-6 * DAY),
  expiresAt: iso(84 * DAY),
  status: 'active',
  lastUsedAt: iso(-2 * 60_000),
  lastUsedIp: '203.0.113.42',
  lastUsedCountry: 'DE',
  usedRest: true,
  mcpCalls30d: 312,
  revokedAt: null,
  ...over,
});

const TOKENS: ApiToken[] = [
  token({}),
  token({
    id: '01a1a000-0000-7000-8000-000000000002',
    name: 'Cursor',
    prefix: 'wl_pat_Pq9d',
    expiresAt: iso(6 * DAY - 3_600_000),
    status: 'expires_soon',
    mcpCalls30d: 48,
  }),
  token({
    id: '01a1a000-0000-7000-8000-000000000003',
    name: 'CI smoke checks',
    prefix: 'wl_pat_c3Lm',
    expiresAt: null,
    status: 'never',
    mcpCalls30d: 0,
  }),
  token({
    id: '01a1a000-0000-7000-8000-000000000004',
    name: 'Grafana test',
    prefix: 'wl_pat_m0Vb',
    status: 'revoked',
    revokedAt: '2026-10-21T16:40:00.000Z',
    lastUsedIp: '198.51.100.0/24',
    lastUsedCountry: null,
    usedRest: false,
    mcpCalls30d: 0,
  }),
];

const GENERAL = { publicUrl: 'https://watchlog.example.com/', publicUrlSource: 'ui' };
const body = () => new DOMWrapper(document.body);

async function mountTokens(routes: Routes, opts: { demo?: boolean; demoToken?: string } = {}) {
  const plugins = await createPlugins('/settings?tab=tokens');
  const auth = useAuthStore();
  auth.user = { ...USER, role: 'viewer' };
  auth.demoMode = !!opts.demo;
  auth.demoMcpToken = opts.demoToken ?? null;
  const { calls } = mockFetch(routes);
  const wrapper = mount(SettingsPage, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { wrapper, calls, router: plugins.router };
}

/** Phones: (max-width: 767px) matches. */
function phone() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('767') || q.includes('1023'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

describe('API token helpers', () => {
  it('builds each app snippet from the public address and the token', () => {
    const url = baseUrl('https://watchlog.example.com/', 'http://localhost:4088');
    expect(url).toBe('https://watchlog.example.com');
    expect(baseUrl(null, 'http://localhost:4088')).toBe('http://localhost:4088');
    expect(snippet('code', url, VALUE)).toBe(
      `claude mcp add --transport http watchlog https://watchlog.example.com/mcp \\\n  --header "Authorization: Bearer ${VALUE}"`,
    );
    const desktop = JSON.parse(snippet('desktop', url, VALUE));
    expect(desktop.mcpServers.watchlog).toEqual({
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        'https://watchlog.example.com/mcp',
        '--header',
        'Authorization: Bearer ${WATCHLOG_TOKEN}',
      ],
      env: { WATCHLOG_TOKEN: VALUE },
    });
    expect(JSON.parse(snippet('cursor', url, VALUE))).toEqual({
      mcpServers: {
        watchlog: {
          url: 'https://watchlog.example.com/mcp',
          headers: { Authorization: `Bearer ${VALUE}` },
        },
      },
    });
    expect(snippet('rest', url, VALUE)).toContain('https://watchlog.example.com/api/v1/clusters');
  });

  it('says when a token expires, how it was used and when', () => {
    expect(expiryNote(TOKENS[0]!, NOW)).toMatchObject({ values: { n: 84 }, warn: false });
    expect(expiryNote(TOKENS[1]!, NOW)).toMatchObject({ values: { n: 6 }, warn: true });
    expect(expiryNote(TOKENS[2]!, NOW)).toMatchObject({ key: 'apiTokens.note.never', warn: true });
    expect(expiryNote(TOKENS[3]!, NOW)).toMatchObject({
      key: 'apiTokens.note.revoked',
      values: { date: 'Oct 21, 2026' },
    });
    expect(callsLabel(TOKENS[0]!)).toEqual({ key: 'apiTokens.calls.mcp', n: 312 });
    expect(callsLabel(TOKENS[2]!)).toEqual({ key: 'apiTokens.calls.restOnly' });
    expect(callsLabel(TOKENS[3]!)).toEqual({ key: 'apiTokens.calls.none' });
    expect(lastUsedLabel(iso(-2 * 60_000), NOW)).toBe('2 minutes ago');
    expect(lastUsedLabel(iso(-3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(lastUsedLabel(iso(-30 * 3_600_000), NOW)).toBe('yesterday');
  });
});

describe('Settings → API tokens', () => {
  it('lists the tokens with their status, expiry, last use and calls', async () => {
    const { wrapper } = await mountTokens({
      'GET /api/v1/api-tokens': { status: 200, body: { tokens: TOKENS } },
      'GET /api/v1/settings/general': { status: 200, body: GENERAL },
    });
    expect(wrapper.get('[data-testid="settings-tab-tokens"]').attributes('aria-selected')).toBe(
      'true',
    );
    const rows = wrapper.findAll('[data-testid="api-token-table"] tbody tr');
    expect(rows).toHaveLength(4);
    const first = rows[0]!.text();
    expect(first).toContain('Claude Code · laptop');
    expect(first).toContain('wl_pat_7Kq2…');
    expect(first).toContain('in 84 days');
    expect(first).toContain('2 minutes ago');
    expect(first).toContain('203.0.113.42 · DE');
    expect(first).toContain('312 calls');
    expect(first).toContain('Active');
    expect(rows[1]!.text()).toContain('Expires soon');
    expect(rows[1]!.find('.text-warning').text()).toBe('in 6 days');
    expect(rows[2]!.text()).toContain('No expiry');
    expect(rows[2]!.text()).toContain('REST only');
    expect(rows[2]!.text()).toContain('Never');
    // Revoked: no Revoke button, the date it was revoked, the shortened address.
    expect(rows[3]!.text()).toContain('revoked Oct 21, 2026');
    expect(rows[3]!.text()).toContain('198.51.100.0/24');
    expect(rows[3]!.find('[data-testid="api-token-revoke"]').exists()).toBe(false);
    expect(rows[0]!.get('a').attributes('href')).toBe(`/settings/api-tokens/${TOKENS[0]!.id}`);
    expect(wrapper.text()).toContain('stay in the list for 30 days');
  });

  it('shows the empty state with a button to create the first token', async () => {
    const { wrapper } = await mountTokens({
      'GET /api/v1/api-tokens': { status: 200, body: { tokens: [] } },
      'GET /api/v1/settings/general': { status: 200, body: GENERAL },
    });
    const empty = wrapper.get('[data-testid="api-tokens-empty"]');
    expect(empty.text()).toContain('No API tokens yet');
    await empty.get('[data-testid="api-token-create-first"]').trigger('click');
    await flushPromises();
    expect(body().find('[data-testid="api-token-create-form"]').exists()).toBe(true);
  });

  it('creates a token and shows it once, with a snippet per app, until the user stored it', async () => {
    const created = token({
      id: '01a1a000-0000-7000-8000-000000000009',
      name: 'Claude Code on my laptop',
      prefix: 'wl_pat_9fK2',
      expiresAt: iso(365 * DAY),
      lastUsedAt: null,
      lastUsedIp: null,
      lastUsedCountry: null,
      usedRest: false,
      mcpCalls30d: 0,
    });
    const { wrapper, calls } = await mountTokens({
      'GET /api/v1/api-tokens': [
        { status: 200, body: { tokens: TOKENS } },
        { status: 200, body: { tokens: [created, ...TOKENS] } },
      ],
      'GET /api/v1/settings/general': { status: 200, body: GENERAL },
      'POST /api/v1/api-tokens': { status: 201, body: { value: VALUE, token: created } },
    });
    await wrapper.get('[data-testid="api-token-create"]').trigger('click');
    await flushPromises();
    const submit = body().get('[data-testid="api-token-create-submit"]');
    expect(submit.attributes('disabled')).toBeDefined(); // no name yet
    await body().get('[data-testid="api-token-name"] input').setValue('Claude Code on my laptop');
    const choices = body().findAll('[data-testid="api-token-expiry"] button');
    expect(choices.map((c) => c.text())).toEqual(['30 days', '90 days', '1 year', 'Never']);
    expect(choices[1]!.attributes('aria-pressed')).toBe('true'); // 90 days by default
    await choices[3]!.trigger('click');
    expect(body().text()).toContain('This token never expires.');
    expect(body().text()).toContain('A token without expiry works until you revoke it');
    await choices[2]!.trigger('click');
    expect(body().get('[data-testid="api-token-expiry-line"]').text()).toMatch(
      /^Expires on \w{3} \d{1,2}, \d{4}\. You get an email 7 days before\.$/,
    );
    await body().get('[data-testid="api-token-create-form"]').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Claude Code on my laptop',
      expiresInDays: 365,
    });

    // The reveal: the value, Claude Code first, the address from the public URL.
    const reveal = body().get('[data-testid="api-token-reveal"]');
    expect(body().text()).toContain('Token created: Claude Code on my laptop');
    expect(body().text()).toContain("Copy it now. It won't be shown again.");
    expect(reveal.get('[data-testid="api-token-value"]').text()).toBe(VALUE);
    expect(reveal.get('[data-testid="snippet"]').text()).toBe(
      snippet('code', 'https://watchlog.example.com', VALUE),
    );
    await reveal.get('[data-testid="snippet-tab-cursor"]').trigger('click');
    expect(reveal.get('[data-testid="snippet-tab-cursor"]').attributes('aria-selected')).toBe(
      'true',
    );
    expect(reveal.get('[data-testid="snippet"]').text()).toContain(
      '"url": "https://watchlog.example.com/mcp"',
    );
    expect(reveal.text()).toContain('Add to ~/.cursor/mcp.json');
    // Arrow keys move between the tabs.
    await reveal
      .get('[data-testid="snippet-tab-cursor"]')
      .trigger('keydown', { key: 'ArrowRight' });
    expect(reveal.get('[data-testid="snippet"]').text()).toContain('curl -H');

    // Escape doesn't lose the token; Done waits for the tick.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushPromises();
    expect(body().find('[data-testid="api-token-reveal"]').exists()).toBe(true);
    const done = body().get('[data-testid="api-token-done"]');
    expect(done.attributes('disabled')).toBeDefined();
    await body().get('[data-testid="api-token-ack"]').setValue(true);
    expect(done.attributes('disabled')).toBeUndefined();
    await done.trigger('click');
    await flushPromises();
    expect(body().find('[data-testid="api-token-reveal"]').exists()).toBe(false);
    expect(body().text()).not.toContain(VALUE);
    expect(wrapper.findAll('[data-testid="api-token-table"] tbody tr')).toHaveLength(5);
  });

  it("shows the server's message when the user has 10 active tokens", async () => {
    const detail = 'You can have at most 10 active API tokens. Revoke one first.';
    const { wrapper } = await mountTokens({
      'GET /api/v1/api-tokens': { status: 200, body: { tokens: TOKENS } },
      'GET /api/v1/settings/general': { status: 200, body: GENERAL },
      'POST /api/v1/api-tokens': {
        status: 409,
        body: { type: 'urn:watchlog:problem:token-limit', title: 'Conflict', status: 409, detail },
      },
    });
    await wrapper.get('[data-testid="api-token-create"]').trigger('click');
    await flushPromises();
    await body().get('[data-testid="api-token-name"] input').setValue('One too many');
    await body().get('[data-testid="api-token-create-form"]').trigger('submit');
    await flushPromises();
    expect(body().get('[role="alert"]').text()).toBe(detail);
    expect(body().find('[data-testid="api-token-reveal"]').exists()).toBe(false);
  });

  it('revokes a token after confirming', async () => {
    const { wrapper, calls } = await mountTokens({
      'GET /api/v1/api-tokens': [
        { status: 200, body: { tokens: TOKENS } },
        {
          status: 200,
          body: {
            tokens: [
              token({ status: 'revoked', revokedAt: new Date(NOW).toISOString() }),
              ...TOKENS.slice(1),
            ],
          },
        },
      ],
      'GET /api/v1/settings/general': { status: 200, body: GENERAL },
      [`DELETE /api/v1/api-tokens/${TOKENS[1]!.id}`]: { status: 204 },
    });
    await wrapper.findAll('[data-testid="api-token-revoke"]')[1]!.trigger('click');
    await flushPromises();
    expect(body().text()).toContain('Revoke “Cursor”?');
    const summary = body().get('[data-testid="api-token-revoke-summary"]').text();
    expect(summary).toContain('wl_pat_Pq9d…');
    expect(summary).toContain('48 calls');
    await body().get('[data-testid="api-token-revoke-confirm"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(body().find('[data-testid="api-token-revoke-summary"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="api-token-table"] tbody tr')[0]!.text()).toContain(
      'Revoked',
    );
  });

  it('shows cards on a phone', async () => {
    phone();
    const { wrapper } = await mountTokens({
      'GET /api/v1/api-tokens': { status: 200, body: { tokens: TOKENS } },
      'GET /api/v1/settings/general': { status: 200, body: GENERAL },
    });
    expect(wrapper.find('[data-testid="api-token-table"]').exists()).toBe(false);
    const cards = wrapper.findAll('[data-testid="api-token-cards"] > li');
    expect(cards).toHaveLength(4);
    expect(cards[0]!.text()).toContain('wl_pat_7Kq2… · 312 calls');
    expect(cards[0]!.text()).toContain('Last used 2 minutes ago · 203.0.113.42 · DE');
  });

  it('in the read-only demo, offers the public MCP token and Install instead of creating', async () => {
    const { wrapper, calls } = await mountTokens({}, { demo: true, demoToken: 'wl_demo_public' });
    expect(calls).toEqual([]); // nothing to list, nothing to create
    expect(wrapper.find('[data-testid="api-token-create"]').exists()).toBe(false);
    const demo = wrapper.get('[data-testid="api-tokens-demo"]');
    expect(demo.text()).toContain("You can't create tokens in the live demo.");
    expect(demo.get('[data-testid="api-tokens-demo-command"]').text()).toBe(
      `claude mcp add --transport http watchlog-demo ${window.location.origin}/mcp \\\n  --header "Authorization: Bearer wl_demo_public"`,
    );
    expect(demo.get('[data-testid="api-tokens-demo-install"]').attributes('href')).toBe(
      LINKS.install,
    );
  });

  it('in a demo without a public token yet, shows only the way to get your own', async () => {
    const { wrapper } = await mountTokens({}, { demo: true });
    expect(wrapper.find('[data-testid="api-tokens-demo-try"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="api-tokens-demo"]').text()).toContain('Install WatchLog');
  });

  it('learns the demo token from GET /setup in demo mode only', async () => {
    mockFetch({
      'GET /api/v1/setup': [
        { status: 200, body: { required: false, demoMode: true, demoMcpToken: 'wl_demo_x' } },
      ],
      'GET /api/v1/me': { status: 200, body: { user: USER } },
    });
    await createPlugins('/setup');
    const auth = useAuthStore();
    await auth.ensureLoaded();
    expect(auth.demoMcpToken).toBe('wl_demo_x');
  });
});

describe('API token detail', () => {
  const calls: McpCall[] = [
    {
      at: iso(-60_000),
      tool: 'get_problems',
      args: 'cluster prod-eu',
      status: 'ok',
      durationMs: 182,
      bytes: 3174,
    },
    {
      at: iso(-50_000),
      tool: 'query_metric',
      args: 'shop/api · cpu · last 1h',
      status: 'truncated',
      durationMs: 410,
      bytes: 16384,
    },
    {
      at: iso(-40_000),
      tool: 'get_events',
      args: 'prod-eu · last 30 min',
      status: 'rate_limited',
      durationMs: 2,
      bytes: 100,
    },
  ];
  const detail = (over: Partial<ApiTokenDetail> = {}): ApiTokenDetail => ({
    token: TOKENS[0]!,
    history: [
      { at: iso(-DAY), kind: 'new_ip', ip: '198.51.100.7', country: 'NL' },
      { at: iso(-6 * DAY + 360_000), kind: 'first_use', ip: '203.0.113.42', country: 'DE' },
      {
        at: iso(-6 * DAY),
        kind: 'created',
        ip: null,
        country: null,
        expiresAt: TOKENS[0]!.expiresAt,
        by: { id: USER.id, name: USER.name },
      },
    ],
    activity: calls as unknown as ApiTokenDetail['activity'],
    ...over,
  });

  async function mountDetail(d: ApiTokenDetail | null) {
    const id = TOKENS[0]!.id;
    const plugins = await createPlugins(`/settings/api-tokens/${id}`);
    useAuthStore().user = USER;
    mockFetch({
      [`GET /api/v1/api-tokens/${id}`]: d
        ? { status: 200, body: d }
        : {
            status: 404,
            body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'nope' },
          },
    });
    const wrapper = mount(ApiTokenPage, {
      attachTo: document.body,
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    return wrapper;
  }

  it('shows the history, newest first, and the MCP calls', async () => {
    const wrapper = await mountDetail(detail());
    expect(wrapper.text()).toContain('Claude Code · laptop');
    expect(wrapper.text()).toContain('read only · created');
    const events = wrapper.findAll('[data-testid="api-token-history"] li');
    expect(events.map((e) => e.attributes('data-kind'))).toEqual([
      'new_ip',
      'first_use',
      'created',
    ]);
    expect(events[0]!.text()).toContain('First use from a new IP · 198.51.100.7 (NL)');
    expect(events[1]!.text()).toContain('First use · from 203.0.113.42 (DE)');
    expect(events[2]!.text()).toMatch(/Created by you · read only · expires \w{3} \d+, \d{4}/);
    const rows = wrapper.findAll('[data-testid="api-token-calls"] tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('get_problems');
    expect(rows[0]!.text()).toContain('OK');
    expect(rows[0]!.text()).toContain('182 ms');
    expect(rows[1]!.text()).toContain('Truncated');
    expect(rows[2]!.text()).toContain('Rate limited');
    expect(wrapper.text()).toContain('outputs are never stored');
  });

  it('says when a token has only been used with the REST API', async () => {
    const wrapper = await mountDetail(detail({ activity: [] }));
    expect(wrapper.get('[data-testid="api-token-activity"]').text()).toContain(
      'It has only been used with the REST API.',
    );
  });

  it('offers no revoke for a revoked token and says when a token is gone', async () => {
    const revoked = await mountDetail(detail({ token: TOKENS[3]!, activity: [], history: [] }));
    expect(revoked.find('[data-testid="api-token-revoke"]').exists()).toBe(false);
    expect(revoked.text()).toContain('Revoked');
    revoked.unmount();
    const gone = await mountDetail(null);
    expect(gone.find('[data-testid="api-token-not-found"]').exists()).toBe(true);
  });

  it('lists the calls as cards on a phone', async () => {
    phone();
    const wrapper = await mountDetail(detail());
    expect(wrapper.find('table').exists()).toBe(false);
    const cards = wrapper.findAll('[data-testid="api-token-calls"] > li');
    expect(cards).toHaveLength(3);
    expect(cards[1]!.text()).toContain('query_metric');
    expect(cards[1]!.text()).toContain('Truncated');
  });
});
