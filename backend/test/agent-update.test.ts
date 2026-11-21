// SPDX-License-Identifier: AGPL-3.0-only
// Updating the agents from the panel (ADR-227): which agents are out of date, each install
// method's command, the SSH loop, Helm with and without the release the chart reports, and
// GET /clusters/:id/agents for a fleet and a Kubernetes cluster.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import {
  helmUpdateCommand,
  installMethodOf,
  oneLine,
  serverUpdateCommands,
  sshLoop,
  updateAvailable,
} from '../src/modules/clusters/agent-update.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

describe('updateAvailable', () => {
  it('older is out of date; equal and newer are not; unknown is', () => {
    expect(updateAvailable('0.10.1', '0.11.1')).toBe(true);
    expect(updateAvailable('0.11.0', '0.11.1')).toBe(true);
    expect(updateAvailable('0.11.1', '0.11.1')).toBe(false);
    expect(updateAvailable('v0.11.1', '0.11.1')).toBe(false);
    expect(updateAvailable('0.12.0', '0.11.1')).toBe(false);
    expect(updateAvailable('0.11.1-rc.1', '0.11.1')).toBe(true);
    expect(updateAvailable('0.9.10', '0.11.1')).toBe(true);
    expect(updateAvailable('1.0.0', '0.11.1')).toBe(false);
    expect(updateAvailable('', '0.11.1')).toBe(true);
    expect(updateAvailable(null, '0.11.1')).toBe(true);
    expect(updateAvailable('dev', '0.11.1')).toBe(true);
  });
  it('never against a development build of the backend', () => {
    expect(updateAvailable('0.1.0', '0.0.0-dev')).toBe(false);
    expect(updateAvailable('0.1.0', '1.2.3-test')).toBe(false);
  });
  it('reads only the four install methods', () => {
    expect(installMethodOf({ install_method: 'deb' })).toBe('deb');
    expect(installMethodOf({ install_method: 'docker' })).toBe('docker');
    expect(installMethodOf({ install_method: 'snap' })).toBeNull();
    expect(installMethodOf({})).toBeNull();
    expect(installMethodOf(null)).toBeNull();
  });
});

describe('the commands', () => {
  const cloud = {
    endpoint: 'https://ingest.watchlog.io',
    version: '0.11.1',
    image: 'ghcr.io/watchlog-light/agent:0.11.1',
  };
  const selfHosted = {
    endpoint: 'http://10.0.0.5:8080',
    version: '0.11.1',
    image: 'ghcr.io/watchlog-light/agent:0.11.1',
  };

  it('servers: the script, the packages of this release, Docker without a new token', () => {
    const c = serverUpdateCommands(cloud);
    expect(c.script).toBe(
      'curl -fsSL https://ingest.watchlog.io/install.sh | sudo sh -s -- --upgrade',
    );
    expect(serverUpdateCommands(selfHosted).script).toBe(
      'curl -fsSL http://10.0.0.5:8080/install.sh | sudo sh -s -- --upgrade',
    );
    expect(c.deb).toContain('v=0.11.1; a=$(dpkg --print-architecture)');
    expect(c.deb).toContain('releases/download/v$v/watchlog-agent_${v}_$a.deb');
    expect(c.deb).toContain('sudo apt-get install -y "./watchlog-agent_${v}_$a.deb"');
    expect(c.deb).not.toMatch(/WATCHLOG_TOKEN/);
    expect(c.rpm).toContain('sudo dnf install -y');
    expect(c.rpm).toContain('watchlog-agent-$v-1.$a.rpm');
    expect(c.rpm).not.toMatch(/WATCHLOG_TOKEN=/);
    // Docker: the token comes from the running container, never from the panel.
    expect(c.docker).toContain(
      "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' watchlog-agent",
    );
    expect(c.docker).toContain('docker rm -f watchlog-agent');
    expect(c.docker).toContain('-e WATCHLOG_TOKEN \\');
    expect(c.docker).toContain('ghcr.io/watchlog-light/agent:0.11.1');
    expect(c.docker).toContain('WATCHLOG_ENDPOINT=https://ingest.watchlog.io');
  });

  it('servers on a development build: no packages', () => {
    const c = serverUpdateCommands({ ...cloud, version: '0.0.0-dev' });
    expect(c.deb).toBeUndefined();
    expect(c.rpm).toBeUndefined();
    expect(c.script).toBeDefined();
  });

  it('an SSH loop over the out-of-date servers, any method as one line', () => {
    const c = serverUpdateCommands(cloud);
    expect(sshLoop(['web-01', 'web-02'], c.script!)).toBe(
      `for h in web-01 web-02; do ssh "$h" 'curl -fsSL https://ingest.watchlog.io/install.sh | sudo sh -s -- --upgrade'; done`,
    );
    expect(oneLine(c.deb!)).toBe(
      'v=0.11.1; a=$(dpkg --print-architecture) && curl -fsSLO "https://github.com/watchlog-light/watchlog/releases/download/v$v/watchlog-agent_${v}_$a.deb" && sudo apt-get install -y "./watchlog-agent_${v}_$a.deb"',
    );
    expect(oneLine(c.docker!)).not.toMatch(/\\\n|\n/);
    expect(sshLoop(["it's"], 'echo hi')).toBe(`for h in 'it'"'"'s'; do ssh "$h" 'echo hi'; done`);
  });

  it('Kubernetes: the chart the cluster runs, its release and namespace when known', () => {
    expect(
      helmUpdateCommand({ version: '0.11.1', release: 'monitoring/wl', chart: 'watchlog-agent' }),
    ).toEqual({
      command:
        'helm upgrade wl oci://ghcr.io/watchlog-light/charts/watchlog-agent --version 0.11.1 -n monitoring --reuse-values',
      known: true,
    });
    expect(
      helmUpdateCommand({ version: '0.11.1', release: 'watchlog/watchlog', chart: 'watchlog' })
        .command,
    ).toBe(
      'helm upgrade watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version 0.11.1 -n watchlog --reuse-values',
    );
    expect(helmUpdateCommand({ version: '0.11.1' })).toEqual({
      command:
        'helm upgrade watchlog-agent oci://ghcr.io/watchlog-light/charts/watchlog-agent --version 0.11.1 -n watchlog --reuse-values',
      known: false,
    });
    expect(helmUpdateCommand({ version: '0.11.1', release: 'not valid; rm -rf /' }).known).toBe(
      false,
    );
  });
});

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  version: '0.11.1',
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};

async function agent(
  c: TestContext,
  clusterId: string,
  node: string,
  mode: string,
  version: string,
  caps: object,
) {
  await c.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: clusterId,
      node,
      mode,
      agent_version: version,
      capabilities: JSON.stringify(caps),
      last_seen_at: new Date(),
    })
    .execute();
}

describe('GET /clusters/:id/agents', () => {
  it('a fleet: versions, methods, the commands, the loop; the server and cluster objects', async () => {
    ctx = await createTestContext({ version: '0.11.1' });
    const cookie = await setupAdmin(ctx.app);
    const orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
    const fleet = await insertCluster(ctx.db, orgId, 'shop', 'server');
    await agent(ctx, fleet.id, 'web-01', 'docker', '0.10.1', { install_method: 'script' });
    await agent(ctx, fleet.id, 'web-02', 'docker', '0.11.0', { install_method: 'script' });
    await agent(ctx, fleet.id, 'web-03', 'docker', '0.11.1', { install_method: 'deb' });
    const get = (url: string) =>
      ctx!.app.inject({ method: 'GET', url, cookies: { wl_session: cookie } });
    const a = (await get(`/api/v1/clusters/${fleet.id}/agents`)).json();
    expect(a.latest).toBe('0.11.1');
    expect(a.outOfDate).toBe(2);
    expect(
      a.agents.map((x: { host: string; updateAvailable: boolean; method: string }) => [
        x.host,
        x.updateAvailable,
        x.method,
      ]),
    ).toEqual([
      ['web-01', true, 'script'],
      ['web-02', true, 'script'],
      ['web-03', false, 'deb'],
    ]);
    expect(a.helm).toBeNull();
    expect(a.server.method).toBe('script');
    expect(a.server.commands.script).toMatch(/install\.sh \| sudo sh -s -- --upgrade$/);
    expect(a.server.loop).toMatch(/^for h in web-01 web-02; do ssh "\$h" 'curl -fsSL /);
    const cluster = (await get(`/api/v1/clusters/${fleet.id}`)).json().cluster;
    expect(cluster.updateAvailable).toBe(true);
    const list = (await get('/api/v1/clusters')).json().clusters;
    expect(list[0].updateAvailable).toBe(true);
    const server = (await get(`/api/v1/clusters/${fleet.id}/servers/web-01`)).json().server;
    expect(server).toMatchObject({
      agentVersion: '0.10.1',
      installMethod: 'script',
      updateAvailable: true,
    });
    const current = (await get(`/api/v1/clusters/${fleet.id}/servers/web-03`)).json().server;
    expect(current).toMatchObject({ installMethod: 'deb', updateAvailable: false });
  });

  it('a fleet with mixed or unknown methods gives no method; one out of date, no loop', async () => {
    ctx = await createTestContext({ version: '0.11.1' });
    const cookie = await setupAdmin(ctx.app);
    const orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
    const fleet = await insertCluster(ctx.db, orgId, 'mixed', 'server');
    await agent(ctx, fleet.id, 'a', 'docker', '0.10.0', {});
    const a = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/clusters/${fleet.id}/agents`,
        cookies: { wl_session: cookie },
      })
    ).json();
    expect(a.server.method).toBeNull();
    expect(a.server.loop).toBeNull();
    expect(Object.keys(a.server.commands).sort()).toEqual(['deb', 'docker', 'rpm', 'script']);
  });

  it('Kubernetes: the release the chart reports; Cloud defaults to the agents-only chart', async () => {
    ctx = await createTestContext(CLOUD, {
      fetch: (async () => new Response('offline', { status: 599 })) as typeof fetch,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: `o-${newId()}@acme.example`, password: 'a long enough password' },
    });
    const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { wl_session: cookie },
    });
    const orgId = me.json().user.org.id as string;
    const k8s = await insertCluster(ctx.db, orgId, 'prod', 'kubernetes');
    await agent(ctx, k8s.id, 'n1', 'node', '0.11.0', {
      helm_release: 'ops/wl-agent',
      helm_chart: 'watchlog-agent',
    });
    await agent(ctx, k8s.id, 'cluster-agent', 'cluster', '0.11.0', {
      helm_release: 'ops/wl-agent',
    });
    const get = (url: string) =>
      ctx!.app.inject({ method: 'GET', url, cookies: { wl_session: cookie } });
    const a = (await get(`/api/v1/clusters/${k8s.id}/agents`)).json();
    expect(a.agents.map((x: { host: string }) => x.host)).toEqual(['n1']);
    expect(a.helm).toEqual({
      command:
        'helm upgrade wl-agent oci://ghcr.io/watchlog-light/charts/watchlog-agent --version 0.11.1 -n ops --reuse-values',
      known: true,
      chart: 'watchlog-agent',
    });
    expect(a.server).toBeNull();
    const k8s2 = await insertCluster(ctx.db, orgId, 'old', 'kubernetes');
    await agent(ctx, k8s2.id, 'n9', 'node', '0.8.0', {});
    const b = (await get(`/api/v1/clusters/${k8s2.id}/agents`)).json();
    expect(b.helm).toMatchObject({ known: false, chart: 'watchlog-agent' });
    expect(b.helm.command).toContain('helm upgrade watchlog-agent ');
  });
});
