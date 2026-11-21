// SPDX-License-Identifier: AGPL-3.0-only
// get_all_clusters (ADR-226): "is anything wrong anywhere?" through MCP. Pro answers the
// page's summary with merged problems for both kinds; Free gets the Pro refusal; Community
// doesn't list the tool.
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { newId } from '../src/lib/ids.js';
import { insertCluster } from '../src/modules/clusters/service.js';
import { ALL_CLUSTERS_REFUSAL, statusSentence } from '../src/modules/mcp/tools/allclusters.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';
import { mcpClient, type McpTestClient } from './support/mcp.js';

const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;

let ctx: TestContext | undefined;
let mcp: McpTestClient | undefined;
afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  accounts: { turnstile: {}, supportEmail: 'support@watchlog.io', sampleUrl: 'https://x' },
};
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

async function cloudOrg(free = false) {
  ctx = await createTestContext(CLOUD, { fetch: offline, now: () => NOW });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: `owner-${newId()}@acme.example`, password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/me',
    cookies: { wl_session: cookie },
  });
  const orgId = me.json().user.org.id as string;
  if (!free) await ctx.app.entitlements!.put(orgId, { plan: 'pro', source: 'staff' });
  mcp = await mcpClient(ctx, cookie);
  return { c: ctx, orgId, mcp };
}

async function firing(
  c: TestContext,
  orgId: string,
  clusterId: string,
  ruleKey: string,
  labels: Record<string, string>,
  minAgo: number,
) {
  const ruleId = newId();
  await c.db
    .insertInto('alert_rules')
    .values({
      id: ruleId,
      org_id: orgId,
      name: ruleKey,
      type: 'default',
      rule_key: ruleKey,
      severity: 'critical',
    })
    .execute();
  await c.db
    .insertInto('alert_states')
    .values({
      id: newId(),
      org_id: orgId,
      rule_id: ruleId,
      cluster_id: clusterId,
      fingerprint: newId(),
      state: 'firing',
      severity: 'critical',
      labels: JSON.stringify(labels),
      details: '{}',
      started_at: new Date(NOW - minAgo * MIN),
      fired_at: new Date(NOW - minAgo * MIN),
    })
    .execute();
}

describe('get_all_clusters', () => {
  it('Pro: the status sentence, problems with their places, the table rows', async () => {
    const { c, orgId, mcp } = await cloudOrg();
    const prod = await insertCluster(c.db, orgId, 'acme-prod', 'kubernetes');
    const fleet = await insertCluster(c.db, orgId, 'shop-servers', 'server');
    await insertCluster(c.db, orgId, 'eu-edge', 'kubernetes');
    await firing(c, orgId, prod.id, 'k8s.pod.crashloop', { namespace: 'shop', workload: 'api' }, 5);
    await firing(
      c,
      orgId,
      fleet.id,
      'server.unit.failed',
      { host: 'web-1', unit: 'nginx.service' },
      9,
    );
    const r = await mcp.call('get_all_clusters', {});
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe(
      '2 of 3 clusters and fleets need attention: acme-prod, shop-servers.',
    );
    expect(r.data.counts).toMatchObject({ clusters: 2, fleets: 1 });
    expect(r.data.problems).toHaveLength(2);
    expect(r.data.problems[0].places[0].cluster).toMatchObject({
      name: 'acme-prod',
      kind: 'kubernetes',
    });
    expect(r.data.problems[1].places[0].cluster).toMatchObject({
      name: 'shop-servers',
      kind: 'server',
    });
    expect(r.data.clusters.map((x: { name: string }) => x.name)).toEqual([
      'acme-prod',
      'shop-servers',
      'eu-edge',
    ]);
    expect(r.data.clusters[0]).not.toHaveProperty('points');
    const servers = await mcp.call('get_all_clusters', { kind: 'server' });
    expect(servers.data.clusters.map((x: { name: string }) => x.name)).toEqual(['shop-servers']);
  });

  it('Free: the Pro refusal', async () => {
    const { mcp } = await cloudOrg(true);
    const r = await mcp.call('get_all_clusters', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain(ALL_CLUSTERS_REFUSAL);
  });

  it('Community: not listed', async () => {
    ctx = await createTestContext();
    const cookie = await setupAdmin(ctx.app);
    mcp = await mcpClient(ctx, cookie);
    const tools = await mcp.client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('get_all_clusters');
  });

  it('the status sentence for none, one and all healthy', () => {
    const row = (name: string, status: string) => ({ name, status }) as never;
    expect(statusSentence({ counts: { all: 0, kubernetes: 0, server: 0 }, clusters: [] })).toMatch(
      /no Kubernetes cluster or Server fleet/,
    );
    expect(
      statusSentence({
        counts: { all: 1, kubernetes: 1, server: 0 },
        clusters: [row('a', 'healthy')],
      }),
    ).toBe('The one cluster or fleet is healthy.');
    expect(
      statusSentence({
        counts: { all: 2, kubernetes: 1, server: 1 },
        clusters: [row('a', 'warning'), row('b', 'healthy')],
      }),
    ).toBe('1 of 2 clusters and fleets needs attention: a.');
  });
});
