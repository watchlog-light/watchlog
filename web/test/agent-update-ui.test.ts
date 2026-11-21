// SPDX-License-Identifier: AGPL-3.0-only
// Updating the agents from the panel (ADR-227): the method tabs, the dialog for a fleet (one
// known method, unknown methods, the SSH loop, Docker's note) and for Kubernetes (the
// release known or not), the banner's words and the Settings section.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ClusterAgents } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentUpdateBanner from '@/components/agents/AgentUpdateBanner.vue';
import AgentUpdateDialog from '@/components/agents/AgentUpdateDialog.vue';
import AgentsSection from '@/components/agents/AgentsSection.vue';
import { createAppI18n } from '@/i18n';
import { agentChip, outOfDateLine, updateMethods } from '@/lib/agent-update';
import { mockFetch } from './fetch-mock';
import { createPlugins } from './helpers';

const i18n = createAppI18n();
const tr = (k: string, v?: Record<string, unknown>) => i18n.global.t(k, v ?? {});
const ID = '01a19300-0000-7000-8000-000000000001';
const at = '2026-11-21T10:00:00Z';

const COMMANDS = {
  script: 'curl -fsSL https://ingest.watchlog.io/install.sh | sudo sh -s -- --upgrade',
  deb: 'v=0.11.1; a=$(dpkg --print-architecture)\ncurl …\nsudo apt-get install -y …',
  rpm: 'v=0.11.1; a=$(uname -m)\nsudo dnf install -y …',
  docker:
    'export WATCHLOG_TOKEN="$(docker inspect …)" && \\\ndocker rm -f watchlog-agent && \\\ndocker run …',
};
const fleet = (over: Partial<ClusterAgents> = {}): ClusterAgents => ({
  latest: '0.11.1',
  kind: 'server',
  agents: [
    {
      host: 'web-01',
      version: '0.10.1',
      method: 'script',
      updateAvailable: true,
      active: true,
      lastSeenAt: at,
    },
    {
      host: 'web-02',
      version: '0.11.0',
      method: 'script',
      updateAvailable: true,
      active: true,
      lastSeenAt: at,
    },
    {
      host: 'web-03',
      version: '0.11.1',
      method: 'deb',
      updateAvailable: false,
      active: true,
      lastSeenAt: at,
    },
  ],
  outOfDate: 2,
  helm: null,
  server: {
    commands: COMMANDS,
    method: 'script',
    loop: `for h in web-01 web-02; do ssh "$h" 'curl …'; done`,
  },
  ...over,
});
const k8s = (known: boolean): ClusterAgents => ({
  latest: '0.11.1',
  kind: 'kubernetes',
  agents: [
    {
      host: 'n1',
      version: '0.11.0',
      method: null,
      updateAvailable: true,
      active: true,
      lastSeenAt: at,
    },
  ],
  outOfDate: 1,
  helm: {
    command:
      'helm upgrade watchlog-agent oci://ghcr.io/watchlog-light/charts/watchlog-agent --version 0.11.1 -n watchlog --reuse-values',
    known,
    chart: 'watchlog-agent',
  },
  server: null,
});

describe('the words and the tabs', () => {
  it('one known method shows no tabs; unknown or mixed shows every one, the script first', () => {
    expect(updateMethods(fleet(), null)).toEqual(['script']);
    expect(updateMethods(fleet(), 'web-03')).toEqual(['deb']);
    const unknown = fleet({ server: { ...fleet().server!, method: null } });
    expect(updateMethods(unknown, null)).toEqual(['script', 'deb', 'rpm', 'docker']);
    const oldAgent = fleet({
      agents: [
        {
          host: 'x',
          version: '0.9.0',
          method: null,
          updateAvailable: true,
          active: true,
          lastSeenAt: at,
        },
      ],
    });
    expect(updateMethods(oldAgent, 'x')).toEqual(['script', 'deb', 'rpm', 'docker']);
    expect(updateMethods(k8s(true), null)).toEqual([]);
  });

  it('the banner and the chip', () => {
    expect(outOfDateLine('server', 4, 6, tr)).toBe('4 of 6 servers run an older agent');
    expect(outOfDateLine('server', 1, 6, tr)).toBe('1 of 6 servers runs an older agent');
    expect(outOfDateLine('kubernetes', 3, 12, tr)).toBe('3 of 12 nodes run an older agent');
    expect(agentChip('0.10.1', '0.11.1', true, tr)).toBe('Agent 0.10.1 · update to 0.11.1');
    expect(agentChip('0.11.1', '0.11.1', false, tr)).toBe('Agent 0.11.1');
    expect(agentChip(null, '0.11.1', true, tr)).toBe('Agent unknown version · update to 0.11.1');
  });
});

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function dialog(body: ClusterAgents, host?: string) {
  mockFetch({ [`GET /api/v1/clusters/${ID}/agents`]: { status: 200, body } });
  const plugins = await createPlugins('/');
  mounted = mount(AgentUpdateDialog, {
    props: { clusterId: ID, host: host ?? null, open: true },
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return document.body;
}
const text = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe('the dialog', () => {
  it('a fleet with one method: its command, the SSH loop, how the update behaves', async () => {
    const root = await dialog(fleet());
    expect(root.querySelector('[data-testid="agent-update-methods"]')).toBeNull();
    expect(text(root, 'agent-update-command')).toContain('install.sh | sudo sh -s -- --upgrade');
    expect(text(root, 'agent-update-loop')).toContain('for h in web-01 web-02');
    expect(text(root, 'agent-update-keeps')).toBe(
      'Updates keep the configuration and never need manual steps. After the update the version here changes within a minute.',
    );
    expect(root.textContent).toContain('this WatchLog is 0.11.1');
  });

  it('one server (its page): its own method, no loop', async () => {
    const root = await dialog(fleet(), 'web-03');
    expect(root.querySelector('[data-testid="agent-update-methods"]')).toBeNull();
    expect(text(root, 'agent-update-command')).toContain('apt-get install');
    expect(root.querySelector('[data-testid="agent-update-loop"]')).toBeNull();
  });

  it('unknown methods: tabs, the script first; Docker says it keeps the token', async () => {
    const root = await dialog(fleet({ server: { ...fleet().server!, method: null } }));
    const tabs = [...root.querySelectorAll('[data-testid="agent-update-methods"] button')];
    expect(tabs.map((b) => b.textContent?.trim())).toEqual(['One command', 'deb', 'rpm', 'Docker']);
    expect(tabs[0]!.getAttribute('aria-pressed')).toBe('true');
    (tabs[3] as HTMLButtonElement).click();
    await flushPromises();
    expect(text(root, 'agent-update-command')).toContain('docker inspect');
    expect(root.textContent).toContain('no new token');
  });

  it('Kubernetes: helm upgrade; the names line only when the release is not the cluster’s own', async () => {
    let root = await dialog(k8s(false));
    expect(text(root, 'agent-update-command')).toContain('helm upgrade watchlog-agent');
    expect(text(root, 'agent-update-names')).toContain('change them if yours differ');
    mounted?.unmount();
    document.body.innerHTML = '';
    root = await dialog(k8s(true));
    expect(root.querySelector('[data-testid="agent-update-names"]')).toBeNull();
  });
});

describe('where it shows', () => {
  it('the banner: only when some are older, and it opens the dialog', async () => {
    mockFetch({ [`GET /api/v1/clusters/${ID}/agents`]: { status: 200, body: fleet() } });
    const plugins = await createPlugins('/');
    const none = mount(AgentUpdateBanner, {
      props: { clusterId: ID, kind: 'server', old: 0, total: 6 },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    expect(none.find('[data-testid="agent-banner"]').exists()).toBe(false);
    none.unmount();
    mounted = mount(AgentUpdateBanner, {
      props: { clusterId: ID, kind: 'server', old: 4, total: 6 },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
      attachTo: document.body,
    });
    expect(mounted.get('[data-testid="agent-banner"]').text()).toContain(
      '4 of 6 servers run an older agent',
    );
    await mounted.get('[data-testid="agent-banner-update"]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid="agent-update-command"]')).not.toBeNull();
  });

  it('Settings: the versions found, also when every agent is current', async () => {
    const current = fleet({
      agents: [
        {
          host: 'a',
          version: '0.11.1',
          method: 'script',
          updateAvailable: false,
          active: true,
          lastSeenAt: at,
        },
      ],
      outOfDate: 0,
      server: { ...fleet().server!, loop: null },
    });
    mockFetch({ [`GET /api/v1/clusters/${ID}/agents`]: { status: 200, body: current } });
    const plugins = await createPlugins('/');
    mounted = mount(AgentsSection, {
      props: { clusterId: ID },
      global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
    });
    await flushPromises();
    const t = mounted.get('[data-testid="agents-section"]').text();
    expect(t).toContain('Versions found: 0.11.1 (1)');
    expect(t).toContain('Every agent runs 0.11.1. Re-run the command to repair an install.');
    expect(mounted.get('[data-testid="agents-open"]').text()).toBe('Show the command');
  });
});
