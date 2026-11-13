// SPDX-License-Identifier: AGPL-3.0-only
// The connect flow (v0.3 slice 4, ADR-133, ADR-134): access sealed and bound to its row,
// key rotation, probes the collector tries and reports, the three ways to connect on
// Kubernetes and Docker, write-only access, the settings drawer's log, roles, demo mode.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import {
  checkSecretKey,
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  rotateSecretKey,
  usePreviousSecretKey,
} from '../src/lib/secrets.js';
import { buildCollectorConfig } from '../src/modules/integrations/collector-config.js';
import { connectCommand, generatePassword } from '../src/modules/integrations/credentials.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  TEST_SECRET_KEY,
  type TestContext,
} from './helpers.js';

const KEY = parseSecretKey(TEST_SECRET_KEY);
const NEW_KEY = Buffer.alloc(32, 9);

describe('sealed access', () => {
  afterEach(() => usePreviousSecretKey(undefined));

  it('is bound to its row and refuses a tampered or moved ciphertext', () => {
    const ct = encryptSecret(KEY, 'wl_mon_secret', 'row-a');
    expect(decryptSecret(KEY, ct, 'row-a')).toBe('wl_mon_secret');
    expect(() => decryptSecret(KEY, ct, 'row-b')).toThrow(/cannot be decrypted/);
    expect(() => decryptSecret(KEY, ct)).toThrow(/cannot be decrypted/);
    const [v, iv, data] = ct.split(':');
    const raw = Buffer.from(data!, 'base64url');
    raw[0] = raw[0]! ^ 1;
    expect(() => decryptSecret(KEY, `${v}:${iv}:${raw.toString('base64url')}`, 'row-a')).toThrow();
    expect(() => decryptSecret(NEW_KEY, ct, 'row-a')).toThrow();
    // During a rotation the previous key still opens it.
    usePreviousSecretKey(KEY);
    expect(decryptSecret(NEW_KEY, ct, 'row-a')).toBe('wl_mon_secret');
  });

  it('generates 32-character passwords and the exact commands', () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^wl_mon_[A-Za-z0-9]{25}$/);
    expect(generatePassword()).not.toBe(pw);
    const sts = {
      kind: 'workload' as const,
      namespace: 'shop',
      workload_kind: 'StatefulSet',
      workload: 'postgres',
      port: 5432,
    };
    expect(connectCommand('postgres', sts, pw)).toBe(
      `kubectl exec -n shop statefulset/postgres -- psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE watchlog LOGIN PASSWORD '${pw}'" -c "GRANT pg_monitor TO watchlog"`,
    );
    const compose = {
      kind: 'compose' as const,
      host: 'docker-01',
      compose_project: 'shop',
      compose_service: 'cache',
      port: 6379,
    };
    expect(connectCommand('redis', compose, pw, { container: 'shop-cache-1' })).toBe(
      `docker exec shop-cache-1 redis-cli ACL SETUSER watchlog reset on '>${pw}' '~*' +info +ping +slowlog +latency '+config|get' '+client|list' '+memory|stats' '+memory|usage' +scan`,
    );
    expect(connectCommand('nginx', compose, pw)).toBeNull();
    // MySQL and MariaDB (ADR-163): one form, root's password asked at the prompt; the
    // statements as tested on MySQL 8.4 and MariaDB 11.4.
    const grants = `CREATE USER \`watchlog\`@\`%\` IDENTIFIED BY "${pw}" WITH MAX_USER_CONNECTIONS 2; GRANT PROCESS, REPLICATION CLIENT /*M!100509 , SLAVE MONITOR */ ON *.* TO \`watchlog\`@\`%\`; GRANT SELECT ON performance_schema.* TO \`watchlog\`@\`%\`; GRANT SELECT ON mysql.innodb_table_stats TO \`watchlog\`@\`%\``;
    expect(connectCommand('mysql', { ...sts, workload: 'mysql', port: 3306 }, pw)).toBe(
      `kubectl exec -it -n shop statefulset/mysql -- sh -c 'exec "$(command -v mariadb || command -v mysql)" -uroot -p -e "$0"' '${grants}'`,
    );
    expect(connectCommand('mysql', { kind: 'address', address: 'db:3306' }, pw)).toBe(
      `mysql -uroot -p -e '${grants}'`,
    );
    // MongoDB (ADR-164): clusterMonitor only, root's password asked at the prompt; run for
    // real on 7.0 and 8.0.
    const mongo = `db.getSiblingDB("admin").createUser({ user: "watchlog", pwd: "${pw}", roles: [{ role: "clusterMonitor", db: "admin" }] })`;
    expect(connectCommand('mongodb', { ...sts, workload: 'mongo', port: 27017 }, pw)).toBe(
      `kubectl exec -it -n shop statefulset/mongo -- mongosh -u root -p --authenticationDatabase admin --quiet --eval '${mongo}'`,
    );
    expect(connectCommand('mongodb', { kind: 'address', address: 'db:27017' }, pw)).toBe(
      `mongosh "mongodb://db:27017/?directConnection=true" -u root -p --authenticationDatabase admin --quiet --eval '${mongo}'`,
    );
  });
});

describe('connect flow', () => {
  let ctx: TestContext;
  let cookie: string;
  let orgId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
  });
  afterEach(() => closeTestContext(ctx));

  const api = (method: string, url: string, payload?: object, as = cookie) =>
    ctx.app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      cookies: { wl_session: as },
      ...(payload ? { payload } : {}),
    });

  async function cluster(name: string, kind: 'kubernetes' | 'docker') {
    const res = await api('POST', '/clusters', { name, kind });
    expect(res.statusCode).toBe(201);
    return { id: res.json().cluster.id as string, token: res.json().token.value as string };
  }

  const ingest = (token: string, method: 'GET' | 'POST', path: string, payload?: object) =>
    ctx.app.inject({
      method,
      url: `/ingest/v1/integrations/${path}`,
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
      ...(payload ? { payload } : {}),
    });

  async function postgresPod(clusterId: string) {
    await ctx.db
      .insertInto('objects')
      .values({
        id: newId(),
        cluster_id: clusterId,
        source: 'kubernetes',
        kind: 'Pod',
        namespace: 'billing',
        name: 'postgres-0',
        uid: newId(),
        node: 'w1',
        spec_summary: JSON.stringify({ workload: { kind: 'StatefulSet', name: 'postgres' } }),
        status_summary: JSON.stringify({ pod_ip: '10.244.1.9', phase: 'Running' }),
      })
      .execute();
  }
  const PG = {
    kind: 'workload',
    namespace: 'billing',
    workload_kind: 'StatefulSet',
    workload: 'postgres',
    port: 5432,
  };

  it('generates a user, lets the collector try it, and moves it to the service (Kubernetes)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await postgresPod(k8s.id);
    const res = await api('POST', '/applications/probes', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      access: { method: 'generated' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { probe, command } = res.json();
    const password = /PASSWORD '(wl_mon_[A-Za-z0-9]{25})'/.exec(command)![1]!;
    expect(command).toMatch(/^kubectl exec -n billing statefulset\/postgres -- psql/);
    expect(probe).toMatchObject({
      status: 'pending',
      method: 'generated',
      username: 'watchlog',
      result: null,
    });
    // Stored sealed, never in clear.
    const stored = await ctx.db
      .selectFrom('integration_probes')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain(password);

    // The collector gets the probe with the password, tries it, and reports.
    const cfg = await ingest(k8s.token, 'GET', 'config');
    expect(cfg.headers['cache-control']).toBe('no-store');
    expect(cfg.json().probes).toEqual([
      {
        id: probe.id,
        type: 'postgres',
        members: [{ name: 'postgres-0', address: '10.244.1.9:5432' }],
        credential: { username: 'watchlog', password },
        requested: expect.any(String),
      },
    ]);
    // Nothing for another cluster's collector.
    const other = await cluster('other', 'kubernetes');
    expect((await ingest(other.token, 'GET', 'config')).json().probes).toEqual([]);

    expect(
      (
        await ingest(k8s.token, 'POST', 'probes', {
          host: '',
          results: [
            {
              id: probe.id,
              ok: false,
              code: 'auth_failed',
              error: 'password authentication failed',
            },
          ],
        })
      ).statusCode,
    ).toBe(204);
    expect((await api('GET', `/applications/probes/${probe.id}`)).json().probe).toMatchObject({
      status: 'pending',
      attempts: 1,
      result: { ok: false, code: 'auth_failed', error: 'password authentication failed' },
    });
    // Another cluster can't report on it.
    await ingest(other.token, 'POST', 'probes', {
      host: '',
      results: [{ id: probe.id, ok: true }],
    });
    expect((await api('GET', `/applications/probes/${probe.id}`)).json().probe.status).toBe(
      'pending',
    );

    // Check now: requested again, the collector sees the change.
    const before = cfg.json().probes[0].requested;
    await new Promise((r) => setTimeout(r, 5));
    expect((await api('POST', `/applications/probes/${probe.id}/check`)).statusCode).toBe(200);
    expect((await ingest(k8s.token, 'GET', 'config')).json().probes[0].requested).not.toBe(before);

    await ingest(k8s.token, 'POST', 'probes', {
      host: '',
      results: [
        {
          id: probe.id,
          ok: true,
          code: 'ok',
          version: '16.4',
          facts: { databases: 3 },
          excess: [],
        },
      ],
    });
    expect((await api('GET', `/applications/probes/${probe.id}`)).json().probe).toMatchObject({
      status: 'ok',
      result: { ok: true, version: '16.4', facts: { databases: 3 } },
    });
    // A probe that worked leaves the configuration.
    expect((await ingest(k8s.token, 'GET', 'config')).json().probes).toEqual([]);

    // Start monitoring with it: the credential moves to the service, re-bound to its id.
    const created = await api('POST', '/applications', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      probeId: probe.id,
      queryText: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().application.id as string;
    const cred = await ctx.db
      .selectFrom('integration_credentials')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(cred).toMatchObject({ integration_id: id, method: 'generated', username: 'watchlog' });
    expect(cred.verified_at).not.toBeNull();
    expect(decryptSecret(KEY, cred.ciphertext!, id)).toBe(password);
    expect(() => decryptSecret(KEY, cred.ciphertext!, probe.id)).toThrow();
    expect(await ctx.db.selectFrom('integration_probes').selectAll().execute()).toEqual([]);

    const config = (await ingest(k8s.token, 'GET', 'config')).json();
    expect(config.targets[0]).toMatchObject({
      id,
      settings: { query_text: false },
      credential: { username: 'watchlog', password },
    });

    // The settings drawer: who set it, never the password.
    const access = await api('GET', `/applications/${id}/access`);
    expect(access.json()).toMatchObject({
      access: {
        method: 'generated',
        username: 'watchlog',
        setBy: 'Ada Admin',
        verifiedAt: expect.any(String),
      },
      settings: { queryText: false, paused: false },
    });
    expect(access.json().events.map((e: { action: string }) => e.action)).toEqual([
      'credential_set',
      'monitored',
    ]);
    expect(access.body).not.toContain(password);
  });

  it('references a Secret on Kubernetes and a file on Docker, and replaces access', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await postgresPod(k8s.id);
    // The collector reported where it runs.
    await ingest(k8s.token, 'POST', 'status', {
      host: '',
      mode: 'kubernetes',
      version: '0.3.0',
      config_version: '',
      self: { namespace: 'monitoring', service_account: 'wl-watchlog-agent-integrations' },
      targets: [],
    });
    const ref = await api('POST', '/applications/probes', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      access: {
        method: 'reference',
        username: 'monitor',
        secret: { name: 'billing-db', key: 'password' },
      },
    });
    expect(ref.statusCode, ref.body).toBe(201);
    expect(ref.json().commands).toEqual([
      'kubectl create role watchlog-read-billing-db -n monitoring --verb=get --resource=secrets --resource-name=billing-db',
      'kubectl create rolebinding watchlog-read-billing-db -n monitoring --role=watchlog-read-billing-db --serviceaccount=monitoring:wl-watchlog-agent-integrations',
    ]);
    expect((await ingest(k8s.token, 'GET', 'config')).json().probes[0].credential).toEqual({
      username: 'monitor',
      secret: { namespace: 'monitoring', name: 'billing-db', key: 'password' },
    });
    // A Secret needs a name; a file is for Docker.
    expect(
      (
        await api('POST', '/applications/probes', {
          clusterId: k8s.id,
          type: 'postgres',
          target: PG,
          access: { method: 'reference', file: 'x' },
        })
      ).statusCode,
    ).toBe(400);

    const fleet = await cluster('docker-01', 'docker');
    const cache = { kind: 'container', host: 'docker-01', container: 'cache', port: 6379 };
    const file = await api('POST', '/applications/probes', {
      clusterId: fleet.id,
      type: 'redis',
      target: cache,
      access: { method: 'reference', username: 'default', file: 'cache-redis' },
    });
    expect(file.statusCode, file.body).toBe(201);
    expect(file.json().mount).toBe('-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro');
    const dockerCfg = (await ingest(fleet.token, 'GET', 'config?host=docker-01')).json();
    expect(dockerCfg.probes[0]).toMatchObject({
      credential: { username: 'default', file: 'cache-redis' },
    });
    // Path tricks are refused.
    for (const bad of ['../etc/passwd', 'a/b', '.hidden']) {
      const r = await api('POST', '/applications/probes', {
        clusterId: fleet.id,
        type: 'redis',
        target: cache,
        access: { method: 'reference', file: bad },
      });
      expect(r.statusCode, bad).toBe(400);
    }

    // Monitor it with no access, then give it an entered user through a probe.
    const created = await api('POST', '/applications', {
      clusterId: fleet.id,
      type: 'redis',
      target: cache,
    });
    const id = created.json().application.id as string;
    const entered = await api('POST', '/applications/probes', {
      clusterId: fleet.id,
      type: 'redis',
      target: cache,
      integrationId: id,
      access: { method: 'entered', username: 'ops', password: 'hunter2-entered-password' },
    });
    expect(entered.statusCode).toBe(201);
    expect(entered.body).not.toContain('hunter2');
    expect(
      (await api('PUT', `/applications/${id}/access`, { probeId: entered.json().probe.id }))
        .statusCode,
    ).toBe(204);
    // A probe of another service can't be adopted.
    const pg = await api('POST', '/applications', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      probeId: ref.json().probe.id,
    });
    expect(pg.statusCode).toBe(201);
    expect(
      (await api('PUT', `/applications/${id}/access`, { probeId: file.json().probe.id }))
        .statusCode,
    ).toBe(204);
    const replaced = await api('GET', `/applications/${id}/access`);
    expect(replaced.json().access).toMatchObject({
      method: 'reference',
      reference: { file: 'cache-redis' },
    });
    expect(replaced.json().events.map((e: { action: string }) => e.action)).toEqual([
      'credential_replaced',
      'credential_set',
      'monitored',
    ]);
    // Remove it, pause, switch query text.
    expect((await api('DELETE', `/applications/${id}/access`)).statusCode).toBe(204);
    expect(
      (await api('PATCH', `/applications/${id}`, { paused: true, queryText: false })).statusCode,
    ).toBe(204);
    const after = (await api('GET', `/applications/${id}/access`)).json();
    expect(after.access).toBeNull();
    expect(after.settings).toEqual({ queryText: false, paused: true });
    expect(
      after.events
        .slice(0, 3)
        .map((e: { action: string }) => e.action)
        .sort(),
    ).toEqual(['credential_removed', 'paused', 'settings_changed']);
    // Paused: the collector no longer gets it.
    expect((await ingest(fleet.token, 'GET', 'config?host=docker-01')).json().targets).toEqual([]);
    // Removing the service keeps its log.
    expect((await api('DELETE', `/applications/${id}`)).statusCode).toBe(204);
    const log = await ctx.db
      .selectFrom('integration_events')
      .select('action')
      .where('integration_id', '=', id)
      .execute();
    expect(log.map((e) => e.action)).toContain('removed');
  });

  it('never returns a password, from any route a user can read', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await postgresPod(k8s.id);
    const secret = 'entered-password-0123456789';
    const probe = await api('POST', '/applications/probes', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      access: { method: 'entered', username: 'ops', password: secret },
    });
    const created = await api('POST', '/applications', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      probeId: probe.json().probe.id,
    });
    const id = created.json().application.id as string;
    const generated = await api('POST', '/applications/probes', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      integrationId: id,
      access: { method: 'generated' },
    });
    const genPassword = /PASSWORD '([^']+)'/.exec(generated.json().command)![1]!;
    const viewer = (await createUserSession(ctx.db, { role: 'viewer', orgId })).cookie;
    const reads = [
      '/applications',
      `/applications/${id}`,
      `/applications/${id}/access`,
      `/applications/${id}/panels`,
      '/applications/discovered',
      '/applications/collectors',
      '/applications/metrics',
      `/applications/probes/${generated.json().probe.id}`,
    ];
    for (const as of [cookie, viewer]) {
      for (const url of reads) {
        const r = await api('GET', url, undefined, as);
        expect(r.body, url).not.toContain(secret);
        expect(r.body, url).not.toContain(genPassword);
      }
    }
    // Viewers see the access but not who did what from where.
    const seen = (await api('GET', `/applications/${id}/access`, undefined, viewer)).json();
    expect(seen.access).toMatchObject({ method: 'entered', username: 'ops' });
    expect(seen.events[0].ip).toBeUndefined();
    // And can change nothing.
    for (const [method, url, body] of [
      [
        'POST',
        '/applications/probes',
        { clusterId: k8s.id, type: 'postgres', target: PG, access: { method: 'none' } },
      ],
      ['PUT', `/applications/${id}/access`, { probeId: generated.json().probe.id }],
      ['DELETE', `/applications/${id}/access`],
      ['PATCH', `/applications/${id}`, { paused: true }],
      ['POST', `/applications/probes/${generated.json().probe.id}/check`],
    ] as const) {
      expect(
        (await api(method, url, body as object | undefined, viewer)).statusCode,
        `${method} ${url}`,
      ).toBe(403);
    }
  });

  it('rotates every secret to a new key in one go', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    await postgresPod(k8s.id);
    await checkSecretKey(ctx.db, KEY);
    const probe = await api('POST', '/applications/probes', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      access: { method: 'entered', username: 'ops', password: 'before-rotation' },
    });
    const created = await api('POST', '/applications', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      probeId: probe.json().probe.id,
    });
    const id = created.json().application.id as string;
    const pending = await api('POST', '/applications/probes', {
      clusterId: k8s.id,
      type: 'postgres',
      target: PG,
      integrationId: id,
      access: { method: 'generated' },
    });
    await expect(rotateSecretKey(ctx.db, NEW_KEY, KEY)).rejects.toThrow(
      /not the key this database/,
    );
    expect(await rotateSecretKey(ctx.db, KEY, NEW_KEY)).toMatchObject({
      integrations: 1,
      probes: 1,
    });
    const cred = await ctx.db
      .selectFrom('integration_credentials')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(decryptSecret(NEW_KEY, cred.ciphertext!, id)).toBe('before-rotation');
    await expect(checkSecretKey(ctx.db, NEW_KEY)).resolves.toBeUndefined();
    await expect(checkSecretKey(ctx.db, KEY)).rejects.toThrow();
    // A backend still on the old key with the new one as previous (rolling restart) works.
    usePreviousSecretKey(NEW_KEY);
    const cfg = await buildCollectorConfig(ctx.db, k8s.id, '', KEY);
    expect(cfg.targets[0]!.credential).toEqual({ username: 'ops', password: 'before-rotation' });
    usePreviousSecretKey(undefined);
    // Without it, the credential is left out rather than breaking the configuration.
    const broken = await buildCollectorConfig(ctx.db, k8s.id, '', KEY);
    expect(broken.targets[0]!.credential).toBeUndefined();
    expect(broken.probes.map((p) => p.id)).toEqual([pending.json().probe.id]);
  });

  it('refuses the connect flow in demo mode', async () => {
    await ctx.app.close();
    ctx = await createTestContext({ demoMode: true });
    const owner = (await createUserSession(ctx.db, { role: 'owner' })).cookie;
    const r = await api(
      'POST',
      '/applications/probes',
      {
        clusterId: newId(),
        type: 'redis',
        target: { kind: 'address', address: 'x:1' },
        access: { method: 'none' },
      },
      owner,
    );
    expect(r.statusCode).toBe(403);
  });
});
