// SPDX-License-Identifier: AGPL-3.0-only
// Seeded clusters for the MCP tool tests, through the ingest API as agents send them: the
// kind cluster's objects and events (captured after `helm install`), and Docker fleets
// from inventories.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { TEST_VM_URL, type TestContext } from '../helpers.js';
import { encode, type TestSeries } from './remote-write.js';

const objects = JSON.parse(
  readFileSync(new URL('../fixtures/kind-objects.json', import.meta.url), 'utf8'),
) as { kind: string }[];
const rawEvents = JSON.parse(
  readFileSync(new URL('../fixtures/kind-events.json', import.meta.url), 'utf8'),
) as { first_ts: string; last_ts: string }[];

/** The fixture's events moved to "now", so day partitions and retention accept them. */
function recentEvents() {
  const shift = Date.now() - Math.max(...rawEvents.map((e) => Date.parse(e.last_ts))) - 60_000;
  return rawEvents.map((e) => ({
    ...e,
    first_ts: new Date(Date.parse(e.first_ts) + shift).toISOString(),
    last_ts: new Date(Date.parse(e.last_ts) + shift).toISOString(),
  }));
}

/** A label on every series these tests write, to delete them afterwards. */
export const RUN = `mcp-${Date.now()}`;

export async function deleteTestSeries(): Promise<void> {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
}

/** A cluster of a kind, made through the API, with its agents' ingest calls. */
export async function addCluster(
  ctx: TestContext,
  cookie: string,
  name: string,
  kind: 'kubernetes' | 'docker',
) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name, kind },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  const token = res.json().token.value as string;
  const ingest = async (path: string, body: object, agent = 'cluster-agent') => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/ingest/v1/${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': agent,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify(body)),
    });
    if (r.statusCode !== 204) throw new Error(`${path}: ${r.statusCode} ${r.body}`);
  };
  const heartbeat = (agent: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/heartbeat',
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': agent },
      payload: {
        agent_version: 'dev',
        mode: kind === 'docker' ? 'docker' : 'cluster',
        node: agent,
        capabilities: {},
        series: 10,
      },
    });
  /** Samples as an agent writes them; searchable at once. */
  const write = async (series: TestSeries[], agent = 'cluster-agent') => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/write',
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': agent,
        'content-type': 'application/x-protobuf',
        'content-encoding': 'snappy',
      },
      payload: encode(series.map((s) => ({ ...s, labels: { ...s.labels, run: RUN } }))),
    });
    if (r.statusCode !== 204) throw new Error(`write: ${r.statusCode} ${r.body}`);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);
  };
  return { id: res.json().cluster.id as string, token, ingest, heartbeat, write };
}

/** The kind cluster: the wl-test failure pods (crashloop, oom), the web Deployment, 3 nodes. */
export async function kindCluster(ctx: TestContext, cookie: string, name = 'kind') {
  const c = await addCluster(ctx, cookie, name, 'kubernetes');
  await c.ingest('objects', {
    source: 'kubernetes',
    kind: 'snapshot',
    snapshot_id: 's1',
    objects,
    final: true,
    kinds: [...new Set(objects.map((o) => o.kind))],
  });
  await c.ingest('events', { events: recentEvents() });
  return c;
}

export const container = (id: string, name: string, extra: object = {}) => ({
  id: id.repeat(64).slice(0, 64),
  name,
  image: 'nginx:1.29',
  state: 'running',
  status: 'Up 5 minutes',
  restart_count: 0,
  exit_code: 0,
  oom_killed: false,
  created_at: 1793400000,
  compose_project: 'shop',
  compose_service: name,
  ...extra,
});

/** A Docker fleet whose hosts report these containers. */
export async function dockerFleet(
  ctx: TestContext,
  cookie: string,
  hosts: Record<string, object[]>,
  name = 'fleet',
) {
  const c = await addCluster(ctx, cookie, name, 'docker');
  const snapshot = (host: string, containers: object[]) =>
    c.ingest(
      'objects',
      {
        kind: 'snapshot',
        source: 'docker',
        node: host,
        inventory: {
          host: {
            docker_version: '29.9.2',
            api_version: '1.56',
            os: 'linux',
            arch: 'arm64',
            kernel_version: '6.8',
          },
          containers,
        },
      },
      host,
    );
  for (const [host, containers] of Object.entries(hosts)) {
    await c.heartbeat(host);
    await snapshot(host, containers);
  }
  return { ...c, snapshot };
}

/** Docker events about containers, a minute ago. */
export const dockerEvents = (
  host: string,
  list: { name: string; reason: string; message: string }[],
) => {
  const t = new Date(Date.now() - 60_000).toISOString();
  return {
    events: list.map((e) => ({
      uid: `${e.name}:${e.reason}`,
      host,
      involved: { kind: 'Container', name: e.name },
      type: 'Warning',
      reason: e.reason,
      message: e.message,
      count: 2,
      first_ts: t,
      last_ts: t,
    })),
  };
};

/** Every string in a value, with the key it sits under. */
export function strings(value: unknown, key = ''): { key: string; value: string }[] {
  if (typeof value === 'string') return [{ key, value }];
  if (Array.isArray(value)) return value.flatMap((v) => strings(v, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, k));
  }
  return [];
}
