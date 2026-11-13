// SPDX-License-Identifier: AGPL-3.0-only
// The cross-org isolation suite's world (ADR-182): the backend in Cloud mode, its request
// path connected as watchlog_app under Row-Level Security, and two orgs, each with a
// Kubernetes cluster and a Docker fleet, objects, events, metrics, alerts, channels,
// services, tokens, invites and users. Everything of org A carries the marker `zzalpha`
// (or is one of A's ids); org B's carries `zzbeta`. No agent is needed: the clusters'
// data arrives through the ingest API with each cluster's token, as agents send it.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import type { FastifyInstance, RouteOptions } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Resolver } from '../../src/lib/egress.js';
import { grantAppRole } from '../../src/db/app-role.js';
import { createDb, type Database } from '../../src/db/index.js';
import { withOrg } from '../../src/db/org-context.js';
import { newId } from '../../src/lib/ids.js';
import { randomToken, sha256 } from '../../src/lib/tokens.js';
import { createSession } from '../../src/modules/auth/sessions.js';
import { ensureDefaultRules } from '../../src/modules/alerts/rules.js';
import { SetupState } from '../../src/modules/setup/service.js';
import { TEST_SETUP_CODE, TEST_VM_URL, testConfig } from '../helpers.js';
import { encode, type TestSeries } from '../support/remote-write.js';

export const APP_ROLE = 'watchlog_app';
const APP_PASSWORD = 'watchlog_app_test';

/** A label on every series the suite writes, to delete them afterwards. */
export const RUN = `isolation-${Date.now()}`;

export interface TableRoute {
  /** `METHOD /url`, as the classification names it. */
  key: string;
  /** The route's options, read after every onRoute hook ran (config.cloudOnly etc.). */
  opts: RouteOptions;
}

export interface CloudWorld {
  app: FastifyInstance;
  /** Fastify's route table, as the app registered it (HEAD left out: GET's twin). */
  routes: TableRoute[];
  /** The owner's connection: seeding and checks only. */
  owner: Database;
  /** watchlog_app with the org per checkout, as the backend's request path. */
  appDb: Database;
  ownerUrl: string;
  appUrl: string;
  close(): Promise<void>;
}

/** The test database's URL as watchlog_app. */
function appUrlOf(ownerUrl: string): string {
  const u = new URL(ownerUrl);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

/**
 * Creates watchlog_app once (the Cloud kit's documented step; roles are per server) and
 * grants it the tables as `migrate` does in Cloud.
 */
export async function ensureAppRole(ownerUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
  } finally {
    await client.end();
  }
  await grantAppRole(ownerUrl, APP_ROLE);
}

/**
 * Cloud's egress policy (ADR-181) resolves channel hosts: the suite never asks real DNS.
 * Every name is a public address, except names under `.internal.test` (10.0.0.1).
 */
export const testResolver: Resolver = async (host) =>
  host.endsWith('.internal.test')
    ? [{ address: '10.0.0.1', family: 4 }]
    : [{ address: '93.184.215.14', family: 4 }];

export async function cloudWorld(opts: { resolve?: Resolver } = {}): Promise<CloudWorld> {
  const ownerUrl = inject('databaseUrl');
  await ensureAppRole(ownerUrl);
  const appUrl = appUrlOf(ownerUrl);
  const owner = createDb(ownerUrl);
  const appDb = createDb(appUrl, { orgScoped: true });
  await sql`TRUNCATE orgs, users, memberships, sessions, clusters, cluster_tokens, retired_cluster_tokens, agent_instances, objects, alert_worker_heartbeats, alerting_periods, secret_key_check, server_settings CASCADE`.execute(
    owner,
  );
  const setup = new SetupState(() => TEST_SETUP_CODE);
  await setup.initialize(owner, {}, { info: () => {}, warn: () => {} });
  const routes: TableRoute[] = [];
  const app = await buildApp(
    testConfig({ edition: 'cloud', databaseUrl: appUrl, databaseSystemUrl: ownerUrl }),
    {
      db: appDb,
      systemDb: owner,
      setup,
      // Turnstile is off (no secret) and the breached-password check is skipped: the suite
      // never reaches an outside service.
      fetch: offlineFetch,
      resolve: opts.resolve ?? testResolver,
      onRoute: (r) => {
        for (const m of [r.method].flat()) {
          if (m !== 'HEAD') routes.push({ key: `${m} ${r.url}`, opts: r });
        }
      },
    },
  );
  await app.ready();
  return {
    app,
    routes,
    owner,
    appDb,
    ownerUrl,
    appUrl,
    async close() {
      await fetch(
        `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
        { method: 'POST' },
      ).catch(() => undefined);
      await app.close();
      await appDb.destroy();
      await owner.destroy();
    },
  };
}

// ------------------------------------------------------------------------------- seeding

const fixtureObjects = readFileSync(
  new URL('../fixtures/kind-objects.json', import.meta.url),
  'utf8',
);
const fixtureEvents = readFileSync(
  new URL('../fixtures/kind-events.json', import.meta.url),
  'utf8',
);

/** The kind fixture with every uid replaced, so each org's objects have their own uids. */
function remapUids(text: string, map: Map<string, string>): string {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (uid) => map.get(uid) ?? (map.set(uid, newId()), map.get(uid)!),
  );
}

/** A `fetch` that never reaches the network (Cloud's outbound checks fail closed or skip). */
export const offlineFetch: typeof fetch = async () => {
  throw new Error('offline in tests');
};

export interface SeededOrg {
  label: 'zzalpha' | 'zzbeta';
  orgId: string;
  ownerId: string;
  viewerId: string;
  /** A fresh session of the org's Owner (signing out in the sweep ends earlier ones). */
  session(): Promise<string>;
  /** One more session of the Owner, kept: its id (Cloud's session routes) and token. */
  kept: { id: string; token: string };
  k8s: { id: string; token: string; tokenId: string };
  docker: { id: string; token: string };
  node: string;
  pod: { namespace: string; name: string };
  host: string;
  container: string;
  ruleId: string;
  alertId: string;
  channelId: string;
  silenceId: string;
  serviceId: string;
  probeId: string;
  ignoreId: string;
  apiToken: { id: string; value: string };
  inviteId: string;
  /** Strings and ids that only this org's data contains. */
  markers: string[];
}

async function ingest(
  app: FastifyInstance,
  token: string,
  path: string,
  body: object,
  agent = 'cluster-agent',
) {
  const r = await app.inject({
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
  if (r.statusCode !== 204) throw new Error(`ingest ${path}: ${r.statusCode} ${r.body}`);
}

/** Samples written through the ingest API with the cluster's token. */
export async function writeSeries(
  app: FastifyInstance,
  token: string,
  series: TestSeries[],
  agent = 'cluster-agent',
) {
  const r = await app.inject({
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
  return r;
}

/**
 * One org, seeded the way it would be in Cloud: its Owner signs up (rows), and everything
 * else goes through the API and ingest under watchlog_app, except a few rows only the alert
 * worker or a collector writes, inserted as the owner.
 */
export async function seedOrg(w: CloudWorld, label: 'zzalpha' | 'zzbeta'): Promise<SeededOrg> {
  const { app, owner } = w;
  const orgId = newId();
  const ownerId = newId();
  const viewerId = newId();
  await owner
    .insertInto('orgs')
    .values({ id: orgId, name: `${label} Org`, slug: `${label}-org`, plan: 'free' })
    .execute();
  await owner
    .insertInto('users')
    .values([
      { id: ownerId, email: `owner@${label}.test`, name: `${label} Owner`, password_hash: 'x' },
      { id: viewerId, email: `viewer@${label}.test`, name: `${label} Viewer`, password_hash: 'x' },
    ])
    .execute();
  await owner
    .insertInto('memberships')
    .values([
      { id: newId(), org_id: orgId, user_id: ownerId, role: 'owner' },
      { id: newId(), org_id: orgId, user_id: viewerId, role: 'viewer' },
    ])
    .execute();
  // Pro, set by staff (ADR-177): each org has a cluster and a fleet, over Free's one.
  await owner
    .insertInto('entitlements')
    .values({ org_id: orgId, plan: 'pro', source: 'staff', users: 10, retention_days: 30 })
    .execute();
  const session = async () => (await createSession(owner, ownerId)).token;
  const keptToken = (await createSession(owner, ownerId)).token;
  const kept = {
    token: keptToken,
    id: (
      await owner
        .selectFrom('sessions')
        .select('id')
        .where('token_hash', '=', sha256(keptToken))
        .executeTakeFirstOrThrow()
    ).id,
  };
  const cookie = await session();
  const api = async (method: string, url: string, payload?: object) => {
    const r = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: cookie },
      ...(payload ? { payload } : {}),
    });
    if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
    return r.json();
  };

  // A Kubernetes cluster: the kind fixture (B's with its own uids), events and metrics.
  const k8sRes = await api('POST', '/clusters', { name: `${label}-k8s`, kind: 'kubernetes' });
  const k8s = {
    id: k8sRes.cluster.id as string,
    token: k8sRes.token.value as string,
    tokenId: k8sRes.token.id as string,
  };
  const uids = new Map<string, string>();
  const objects = JSON.parse(
    label === 'zzalpha' ? fixtureObjects : remapUids(fixtureObjects, uids),
  ) as { kind: string; uid: string; name: string; namespace: string; node: string }[];
  const events = (
    JSON.parse(label === 'zzalpha' ? fixtureEvents : remapUids(fixtureEvents, uids)) as {
      first_ts: string;
      last_ts: string;
    }[]
  ).map((e) => {
    const shift = Date.now() - Date.parse(e.last_ts) - 60_000;
    return {
      ...e,
      first_ts: new Date(Date.parse(e.first_ts) + shift).toISOString(),
      last_ts: new Date(Date.now() - 60_000).toISOString(),
    };
  });
  await ingest(app, k8s.token, 'objects', {
    source: 'kubernetes',
    kind: 'snapshot',
    snapshot_id: 's1',
    objects,
    final: true,
    kinds: [...new Set(objects.map((o) => o.kind))],
  });
  await ingest(app, k8s.token, 'events', { events });
  const pod = objects.find((o) => o.kind === 'Pod' && o.namespace === 'wl-test')!;
  const node = objects.find((o) => o.kind === 'Node')!.name;
  const now = Date.now();
  const series: TestSeries[] = [];
  for (let i = 10; i >= 0; i--) {
    const t = now - i * 15_000;
    series.push(
      {
        labels: {
          __name__: 'watchlog_container_cpu_seconds_total',
          namespace: 'wl-test',
          pod: `${label}-pod`,
          container: `${label}-app`,
          node,
        },
        value: 100 + i,
        timestampMs: t,
      },
      {
        labels: {
          __name__: 'watchlog_node_cpu_seconds_total',
          node: `${label}-node`,
          mode: 'user',
        },
        value: 50 + i,
        timestampMs: t,
      },
    );
  }
  const wr = await writeSeries(app, k8s.token, series);
  if (wr.statusCode !== 204) throw new Error(`write: ${wr.statusCode} ${wr.body}`);

  // A Docker fleet: one host, one container.
  const dRes = await api('POST', '/clusters', { name: `${label}-fleet`, kind: 'docker' });
  const docker = { id: dRes.cluster.id as string, token: dRes.token.value as string };
  const host = `${label}-host`;
  const container = `${label}-web`;
  await app.inject({
    method: 'POST',
    url: '/ingest/v1/heartbeat',
    headers: { authorization: `Bearer ${docker.token}`, 'x-watchlog-agent': host },
    payload: { agent_version: 'dev', mode: 'docker', node: host, capabilities: {}, series: 10 },
  });
  await ingest(
    app,
    docker.token,
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
        containers: [
          {
            id: (label === 'zzalpha' ? 'a' : 'b').repeat(64),
            name: container,
            image: `${label}/web:1`,
            state: 'running',
            status: 'Up 5 minutes',
            restart_count: 0,
            exit_code: 0,
            oom_killed: false,
            created_at: 1793400000,
            compose_project: `${label}-shop`,
            compose_service: 'web',
          },
        ],
      },
    },
    host,
  );
  await writeSeries(
    app,
    docker.token,
    [0, 1, 2].map((i) => ({
      labels: {
        __name__: 'watchlog_container_cpu_seconds_total',
        host,
        container,
        compose_project: `${label}-shop`,
      },
      value: 10 + i,
      timestampMs: now - (2 - i) * 15_000,
    })),
    host,
  );
  await fetch(`${TEST_VM_URL}/internal/force_flush`);

  // Alerting: the default rules (as the worker makes them, inside withOrg under RLS), one
  // renamed with the marker, a firing alert, a webhook channel, a notification, a silence.
  await withOrg(orgId, () => ensureDefaultRules(w.appDb, orgId));
  const rule = await owner
    .selectFrom('alert_rules')
    .select('id')
    .where('org_id', '=', orgId)
    .where('rule_key', '=', 'k8s.pod.crashloop')
    .executeTakeFirstOrThrow();
  await owner
    .updateTable('alert_rules')
    .set({ name: `${label} crash rule` })
    .where('id', '=', rule.id)
    .execute();
  const alertId = newId();
  await owner
    .insertInto('alert_states')
    .values({
      id: alertId,
      org_id: orgId,
      rule_id: rule.id,
      cluster_id: k8s.id,
      fingerprint: `${label}-fp`,
      state: 'firing',
      severity: 'critical',
      labels: JSON.stringify({
        namespace: pod.namespace,
        pod: pod.name,
        workload: `${label}-workload`,
      }),
      details: JSON.stringify({ reason: `${label} reason` }),
      started_at: new Date(now - 600_000),
      fired_at: new Date(now - 540_000),
    })
    .execute();
  const channel = await api('POST', '/alert-channels', {
    type: 'webhook',
    name: `${label}-hook`,
    settings: { url: `https://${label}.example.com/hook` },
  });
  const channelId = (channel.channel?.id ?? channel.id) as string;
  await owner
    .insertInto('notifications')
    .values({
      id: newId(),
      org_id: orgId,
      channel_id: channelId,
      cluster_id: k8s.id,
      rule_id: rule.id,
      dedupe_key: `${label}-dedupe`,
      kind: 'firing',
      status: 'sent',
      payload: JSON.stringify({ title: `${label} notification` }),
      sent_at: new Date(),
    })
    .execute();
  const silenceId = newId();
  await owner
    .insertInto('silences')
    .values({
      id: silenceId,
      org_id: orgId,
      matchers: JSON.stringify({ workload: `${label}-workload` }),
      comment: `${label} silence`,
      starts_at: new Date(now - 60_000),
      ends_at: new Date(now + 3_600_000),
      created_by: ownerId,
    })
    .execute();

  // A monitored service, a probe and a discovery ignore (a collector and the wizard write
  // these), an API token and an invite through the API.
  const serviceId = newId();
  await owner
    .insertInto('integrations')
    .values({
      id: serviceId,
      org_id: orgId,
      cluster_id: docker.id,
      type: 'redis',
      name: `${label}-redis`,
      collector_host: host,
      target: JSON.stringify({
        kind: 'compose',
        host,
        compose_project: `${label}-shop`,
        compose_service: 'redis',
        port: 6379,
      }),
    })
    .execute();
  const probeId = newId();
  await owner
    .insertInto('integration_probes')
    .values({
      id: probeId,
      org_id: orgId,
      cluster_id: docker.id,
      integration_id: serviceId,
      method: 'none',
      target: JSON.stringify({
        kind: 'compose',
        host,
        compose_project: `${label}-shop`,
        compose_service: 'redis',
        port: 6379,
      }),
      type: 'redis',
      expires_at: new Date(now + 600_000),
    })
    .execute();
  const ignoreId = newId();
  await owner
    .insertInto('discovery_ignores')
    .values({
      id: ignoreId,
      org_id: orgId,
      cluster_id: k8s.id,
      service_key: `${label}-ignored`,
      label: `${label} ignored`,
    })
    .execute();
  const token = await api('POST', '/api-tokens', { name: `${label}-token` });
  const invite = await api('POST', '/users/invites', {
    email: `invitee@${label}.test`,
    role: 'viewer',
  });
  const inviteId = (invite.invite?.id ?? invite.id) as string;

  const markers = [label, orgId, k8s.id, docker.id, ruleId(rule.id), alertId, channelId, serviceId];
  if (label === 'zzalpha')
    markers.push(...objects.filter((o) => o.kind === 'Pod').map((o) => o.uid));
  return {
    label,
    orgId,
    ownerId,
    viewerId,
    session,
    kept,
    k8s,
    docker,
    node,
    pod: { namespace: pod.namespace, name: pod.name },
    host,
    container,
    ruleId: rule.id,
    alertId,
    channelId,
    silenceId,
    serviceId,
    probeId,
    ignoreId,
    apiToken: { id: token.token.id as string, value: token.value as string },
    inviteId,
    markers,
  };
}

const ruleId = (id: string) => id;

/** A random value shaped like a link token, which matches nothing. */
export const unknownLinkToken = () => randomToken();
export const hashOf = (v: string) => sha256(v);
