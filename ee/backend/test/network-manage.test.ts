// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Changing and undoing on the network pages (1.0.2), through the real app, with a Kubernetes
// cluster and a server of a fleet as pollers: a credential profile edited (a secret kept, a
// secret replaced, the protocol refused), deleted (unused; in use; after its devices moved),
// tried against an address (what the collector reports becomes one of the outcomes the page
// words); a device's address, pause and return after removal; an accepted certificate undone;
// a poller's devices moved; who may do it, the read-only demo, and the audit trail without a
// secret. The collector is played here: its configuration is read and its reports are posted
// as ee/collector sends them (its own tests hold the probe against the simulators).
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../backend/src/config.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from '../../../backend/test/helpers.js';
import { licenseKey, TEST_KEYS } from '../../../backend/test/license-keys.js';
import { outcomeOf } from '../src/network/routes-manage.js';

/** A row or a JSON object whose shape the test reads field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const NOW = Math.floor(Date.now() / 60_000) * 60_000;
let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface World {
  call: (
    method: Method,
    url: string,
    payload?: object,
    as?: string,
  ) => ReturnType<TestContext['app']['inject']>;
  cookie: string;
  orgId: string;
  clusterId: string;
  /** The poller's host: '' for a cluster's collector, a server's name on a fleet. */
  host: string;
  config: () => Promise<{ devices: Row[]; discover: Row[] }>;
  report: (body: object) => Promise<number>;
}

async function world(kind: 'kubernetes' | 'server', over: Partial<Config> = {}): Promise<World> {
  ctx = await createTestContext(
    { license: { key: licenseKey(NOW, { features: ['network'] }) }, ...over } as Partial<Config>,
    { licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW }, now: () => NOW },
  );
  const cookie = await setupAdmin(ctx.app);
  const call: World['call'] = (method, url, payload, as = cookie) =>
    ctx!.app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { wl_session: as },
      ...(payload ? { payload } : {}),
    });
  const created = await call('POST', '/clusters', {
    name: kind === 'server' ? 'fleet' : 'prod',
    kind,
  });
  const clusterId = created.json().cluster.id as string;
  const token = created.json().token.value as string;
  const orgId = (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;
  const host = kind === 'server' ? 'web-1' : '';
  if (kind === 'server') {
    for (const node of ['web-1', 'web-2'])
      await ctx.db
        .insertInto('agent_instances')
        .values({
          id: crypto.randomUUID(),
          cluster_id: clusterId,
          org_id: orgId,
          node,
          mode: 'docker',
          agent_version: '1.0.2',
          last_seen_at: new Date(NOW),
        })
        .execute();
  }
  const ingest = (method: 'GET' | 'POST', url: string, body?: object) =>
    ctx!.app.inject({
      method,
      url: `/ingest/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'collector' },
      ...(body ? { payload: body } : {}),
    });
  // The collector heartbeats, so the place (and on a fleet, the server) is a poller.
  for (const h of kind === 'server' ? ['web-1', 'web-2'] : [''])
    await ingest('POST', '/integrations/status', {
      host: h,
      mode: kind,
      version: '1.0.2',
      config_version: '',
      self: {},
      targets: [],
    });
  return {
    call,
    cookie,
    orgId,
    clusterId,
    host,
    config: async () =>
      (await ingest('GET', `/integrations/config${host ? `?host=${host}` : ''}`)).json().modules
        ?.network ?? { devices: [], discover: [] },
    report: async (body) =>
      (await ingest('POST', '/network/report', { host, devices: [], ...body })).statusCode,
  };
}

const V3 = {
  name: 'office-ro',
  protocol: 'snmp',
  settings: { version: '3', user: 'watchlog', authProto: 'SHA256', privProto: 'AES' },
  secret: { authKey: 'auth-key-123', privKey: 'priv-key-123' },
};
const ROS = {
  name: 'routers-ro',
  protocol: 'routeros',
  settings: { user: 'watchlog', transport: 'rest' },
  secret: { password: 'pw-1' },
};

const audit = async () =>
  (
    await ctx!.db
      .selectFrom('audit_events')
      .select(['action', 'details', 'actor_name'])
      .where('action', 'like', 'network_%')
      .orderBy('at')
      .orderBy('id')
      .execute()
  ).map((a) => ({ action: a.action, details: a.details as Record<string, unknown> }));

describe.each(['kubernetes', 'server'] as const)(
  'credential profiles, polled from a %s',
  (kind) => {
    it('edits a profile: the name and settings change, a secret left empty is kept, one typed replaces it, the protocol is refused', async () => {
      const w = await world(kind);
      const id = (await w.call('POST', '/network/credentials', V3)).json().id as string;
      const add = await w.call('POST', '/network/devices', {
        clusterId: w.clusterId,
        host: w.host,
        devices: [{ address: '10.0.0.2', name: 'core-1', credentialId: id }],
      });
      expect(add.statusCode).toBe(201);
      expect((await w.config()).devices[0]!.snmp).toMatchObject({
        user: 'watchlog',
        authKey: 'auth-key-123',
        privKey: 'priv-key-123',
      });

      // The name and a setting; no secret typed: both keys are kept.
      const renamed = await w.call('PATCH', `/network/credentials/${id}`, {
        name: 'office-readonly',
        settings: { user: 'wl-reader', authProto: 'SHA512' },
        secret: { authKey: '', privKey: '' },
      });
      expect(renamed.statusCode, renamed.body).toBe(204);
      expect((await w.config()).devices[0]!.snmp).toMatchObject({
        user: 'wl-reader',
        authProto: 'SHA512',
        privProto: 'AES',
        authKey: 'auth-key-123',
        privKey: 'priv-key-123',
      });
      // One key typed: it replaces its own, the other stays.
      expect(
        (
          await w.call('PATCH', `/network/credentials/${id}`, {
            secret: { authKey: 'new-auth-456' },
          })
        ).statusCode,
      ).toBe(204);
      expect((await w.config()).devices[0]!.snmp).toMatchObject({
        authKey: 'new-auth-456',
        privKey: 'priv-key-123',
      });
      const listed = (await w.call('GET', '/network/credentials')).json().credentials;
      expect(listed).toMatchObject([
        { id, name: 'office-readonly', protocol: 'snmp', secretSet: true, usedBy: 1 },
      ]);
      expect(JSON.stringify(listed)).not.toMatch(/auth-key|priv-key|new-auth/);

      // The protocol can't change, and a key that is too short is refused as on creation.
      const proto = await w.call('PATCH', `/network/credentials/${id}`, { protocol: 'routeros' });
      expect(proto.statusCode).toBe(400);
      expect(proto.json().detail).toMatch(/protocol can't change.*Make a new profile instead/);
      expect(
        (await w.call('PATCH', `/network/credentials/${id}`, { secret: { privKey: 'short' } }))
          .statusCode,
      ).toBe(400);
      // To v2c: its community is needed; the v3 keys go with the version.
      expect(
        (await w.call('PATCH', `/network/credentials/${id}`, { settings: { version: '2c' } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await w.call('PATCH', `/network/credentials/${id}`, {
            settings: { version: '2c' },
            secret: { community: 'public-ro' },
          })
        ).statusCode,
      ).toBe(204);
      expect((await w.config()).devices[0]!.snmp).toEqual({
        version: '2c',
        community: 'public-ro',
      });
      // A name another profile has.
      await w.call('POST', '/network/credentials', ROS);
      expect(
        (await w.call('PATCH', `/network/credentials/${id}`, { name: 'routers-ro' })).statusCode,
      ).toBe(409);
      expect(
        (await w.call('PATCH', `/network/credentials/${crypto.randomUUID()}`, {})).statusCode,
      ).toBe(404);

      // The trail says what changed, by name, and never a value of a secret.
      const trail = await audit();
      expect(trail.map((a) => a.action)).toEqual([
        'network_profile_added',
        'network_devices_added',
        'network_profile_changed',
        'network_profile_changed',
        'network_profile_changed',
        'network_profile_added',
      ]);
      expect(trail[2]!.details).toEqual({
        profile: 'office-readonly',
        changed: 'name, user, authProto',
        devices: 1,
      });
      expect(trail[3]!.details).toMatchObject({ changed: 'authentication key' });
      expect(trail[4]!.details).toMatchObject({ changed: 'version, community' });
      expect(JSON.stringify(trail)).not.toMatch(/auth-key|priv-key|new-auth|public-ro|pw-1/);
    });

    it('deletes an unused profile; one in use is refused with its devices, moved, then deleted', async () => {
      const w = await world(kind);
      const a = (await w.call('POST', '/network/credentials', V3)).json().id as string;
      const b = (await w.call('POST', '/network/credentials', { ...V3, name: 'office-new' })).json()
        .id as string;
      const ros = (await w.call('POST', '/network/credentials', ROS)).json().id as string;
      const unused = (
        await w.call('POST', '/network/credentials', { ...V3, name: 'mistake' })
      ).json().id as string;

      // Unused: gone.
      expect((await w.call('DELETE', `/network/credentials/${unused}`)).statusCode).toBe(204);
      expect((await w.call('DELETE', `/network/credentials/${unused}`)).statusCode).toBe(404);

      const added = (
        await w.call('POST', '/network/devices', {
          clusterId: w.clusterId,
          host: w.host,
          devices: [
            { address: '10.0.0.2', name: 'core-1', credentialId: a },
            { address: '10.0.0.12', name: 'sw-access-2', credentialId: a },
          ],
        })
      ).json().added as string[];
      // One of them failed with the old profile.
      await ctx!.db
        .updateTable('network_devices' as never)
        .set({ status: 'auth_failed', failures: 4 } as never)
        .where('id' as never, '=', added[1] as never)
        .execute();

      // In use: refused, with the devices to show.
      const refused = await w.call('DELETE', `/network/credentials/${a}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        detail: '2 devices use this profile; move them to another profile first',
        devices: [
          { id: added[0], name: 'core-1', address: '10.0.0.2' },
          { id: added[1], name: 'sw-access-2', address: '10.0.0.12' },
        ],
      });
      expect(
        (await w.call('GET', `/network/credentials/${a}/devices`)).json().devices,
      ).toHaveLength(2);

      // Only to another profile of the same protocol.
      expect((await w.call('POST', `/network/credentials/${a}/move`, { to: ros })).statusCode).toBe(
        400,
      );
      expect((await w.call('POST', `/network/credentials/${a}/move`, { to: a })).statusCode).toBe(
        400,
      );
      const moved = await w.call('POST', `/network/credentials/${a}/move`, { to: b });
      expect(moved.json()).toEqual({ moved: 2 });
      const devices = await ctx!.db
        .selectFrom('network_devices' as never)
        .select(['name', 'credential_id', 'status', 'failures'] as never)
        .orderBy('name' as never)
        .execute();
      expect(devices).toEqual([
        { name: 'core-1', credential_id: b, status: 'pending', failures: 0 },
        // Tried again at once with the new profile.
        { name: 'sw-access-2', credential_id: b, status: 'pending', failures: 0 },
      ]);
      expect((await w.config()).devices.map((d) => d.name)).toEqual(['core-1', 'sw-access-2']);

      // After the move, delete goes through.
      expect((await w.call('DELETE', `/network/credentials/${a}`)).statusCode).toBe(204);
      expect(
        (await w.call('GET', '/network/credentials'))
          .json()
          .credentials.map((c: Row) => [c.name, c.usedBy]),
      ).toEqual([
        ['office-new', 2],
        ['routers-ro', 0],
      ]);
      const trail = (await audit()).filter((x) => /removed|moved/.test(x.action));
      expect(trail).toEqual([
        { action: 'network_profile_removed', details: { profile: 'mistake', protocol: 'snmp' } },
        {
          action: 'network_devices_moved',
          details: { from: 'office-ro', to: 'office-new', devices: 2 },
        },
        { action: 'network_profile_removed', details: { profile: 'office-ro', protocol: 'snmp' } },
      ]);
    });

    it('tests a profile against an address: answered, wrong user or key, no answer, a certificate that isn’t the pinned one', async () => {
      const w = await world(kind);
      const start = (body: object) =>
        w.call('POST', '/network/credential-tests', {
          clusterId: w.clusterId,
          host: w.host,
          ...body,
        });
      // The values as typed, nothing saved: a profile with a mistake in its key.
      const typed = await start({ address: '10.0.0.2', ...without(V3, 'name') });
      expect(typed.statusCode, typed.body).toBe(201);
      const id = typed.json().id as string;
      expect((await w.call('GET', '/network/credentials')).json().credentials).toEqual([]);
      expect((await w.call('GET', `/network/credential-tests/${id}`)).json()).toEqual({
        id,
        done: false,
      });
      // The collector gets it as a discovery of one address with that one credential.
      const cfg = await w.config();
      expect(cfg.devices).toEqual([]);
      expect(cfg.discover).toEqual([
        {
          id,
          seeds: ['10.0.0.2'],
          neighbours: false,
          credentials: [
            {
              id,
              protocol: 'snmp',
              snmp: {
                version: '3',
                user: 'watchlog',
                authProto: 'SHA256',
                authKey: 'auth-key-123',
                privProto: 'AES',
                privKey: 'priv-key-123',
              },
            },
          ],
        },
      ]);
      // It isn't a discovery to read on the Add page.
      expect((await w.call('GET', `/network/discoveries/${id}`)).statusCode).toBe(404);

      // 1. Wrong user or key.
      await w.report({
        discovery: [
          {
            id,
            done: true,
            found: [
              {
                address: '10.0.0.2',
                answered: false,
                error: 'the device refused the SNMP credentials (unknown user name)',
              },
            ],
          },
        ],
      });
      expect((await w.call('GET', `/network/credential-tests/${id}`)).json()).toEqual({
        id,
        done: true,
        address: '10.0.0.2',
        outcome: 'refused',
      });
      // Read once: the row is gone, and the sealed values with it.
      expect((await w.call('GET', `/network/credential-tests/${id}`)).statusCode).toBe(404);
      expect((await w.config()).discover ?? []).toEqual([]);

      // 2. Answered, after the profile was saved and its key corrected in the form: the key
      //    left empty is the saved one.
      const saved = (await w.call('POST', '/network/credentials', V3)).json().id as string;
      const again = await start({
        address: '10.0.0.2',
        protocol: 'snmp',
        settings: { ...V3.settings, user: 'wl-reader' },
        secret: { authKey: 'fixed-auth-789', privKey: '' },
        credentialId: saved,
      });
      const id2 = again.json().id as string;
      expect((await w.config()).discover[0]!.credentials[0].snmp).toMatchObject({
        user: 'wl-reader',
        authKey: 'fixed-auth-789',
        privKey: 'priv-key-123',
      });
      await w.report({
        discovery: [
          {
            id: id2,
            done: true,
            found: [
              {
                address: '10.0.0.2',
                answered: true,
                name: 'core-1',
                model: 'C9300-48P',
                vendor: 'Cisco',
                credential: id2,
                protocol: 'snmp',
              },
            ],
          },
        ],
      });
      expect((await w.call('GET', `/network/credential-tests/${id2}`)).json()).toEqual({
        id: id2,
        done: true,
        address: '10.0.0.2',
        outcome: 'answered',
        name: 'core-1',
        model: 'C9300-48P',
        vendor: 'Cisco',
      });
      // Nothing was saved by testing: the profile still has its first user.
      expect(
        (await w.call('GET', '/network/credentials')).json().credentials[0].settings.user,
      ).toBe('watchlog');

      // 3. No answer.
      const id3 = (await start({ address: '10.0.0.99', ...without(V3, 'name') })).json().id;
      await w.report({
        discovery: [
          {
            id: id3,
            done: true,
            found: [
              {
                address: '10.0.0.99',
                answered: false,
                error: "the device didn't answer SNMP (request timeout)",
              },
            ],
          },
        ],
      });
      expect((await w.call('GET', `/network/credential-tests/${id3}`)).json()).toMatchObject({
        done: true,
        outcome: 'no_answer',
      });

      // 4. The certificate isn't the pinned one: a router already added at that address has a
      //    pin, and the test holds to it.
      const ros = (await w.call('POST', '/network/credentials', ROS)).json().id as string;
      const router = (
        await w.call('POST', '/network/devices', {
          clusterId: w.clusterId,
          host: w.host,
          devices: [{ address: '10.0.0.1', name: 'edge-1', credentialId: ros }],
        })
      ).json().added[0] as string;
      await w.report({
        devices: [
          {
            id: router,
            state: 'ok',
            polledAt: NOW,
            fingerprint: 'ab'.repeat(32),
            system: { uptimeS: 100, name: 'edge-1', kind: 'router' },
            health: {},
          },
        ],
      });
      const id4 = (
        await start({
          address: '10.0.0.1',
          protocol: 'routeros',
          settings: ROS.settings,
          secret: {},
          credentialId: ros,
        })
      ).json().id as string;
      const test = (await w.config()).discover.find((d) => d.id === id4)!;
      expect(test.credentials[0].routeros).toMatchObject({
        user: 'watchlog',
        password: 'pw-1',
        pin: 'ab'.repeat(32),
      });
      await w.report({
        discovery: [
          {
            id: id4,
            done: true,
            found: [
              {
                address: '10.0.0.1',
                answered: false,
                error: "the device's certificate changed since it was first seen",
              },
            ],
          },
        ],
      });
      expect((await w.call('GET', `/network/credential-tests/${id4}`)).json()).toMatchObject({
        outcome: 'certificate',
      });

      // What is refused before a poller is asked.
      expect(
        (await start({ address: '10.0.0.2', ...without(V3, 'name'), secret: {} })).statusCode,
      ).toBe(400);
      expect(
        (
          await start({
            address: '10.0.0.2',
            protocol: 'routeros',
            settings: ROS.settings,
            credentialId: saved,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await w.call('POST', '/network/credential-tests', {
            clusterId: crypto.randomUUID(),
            host: '',
            address: '10.0.0.2',
            ...without(V3, 'name'),
          })
        ).statusCode,
      ).toBe(400);
      // The poller never reported: said so once its time is up.
      const id5 = (await start({ address: '10.0.0.2', ...without(V3, 'name') })).json()
        .id as string;
      await ctx!.db
        .updateTable('network_discoveries' as never)
        .set({ expires_at: new Date(NOW - 1000) } as never)
        .where('id' as never, '=', id5 as never)
        .execute();
      expect((await w.call('GET', `/network/credential-tests/${id5}`)).json()).toMatchObject({
        done: true,
        outcome: 'poller_silent',
      });
      // Testing changes nothing, so it leaves no line in the trail.
      expect((await audit()).some((a) => /test/.test(a.action))).toBe(false);
    });

    it('a device: its address corrected, paused and resumed, removed and brought back as itself', async () => {
      const w = await world(kind);
      const cred = (await w.call('POST', '/network/credentials', ROS)).json().id as string;
      const add = (address: string, name: string) =>
        w.call('POST', '/network/devices', {
          clusterId: w.clusterId,
          host: w.host,
          devices: [{ address, name, credentialId: cred }],
        });
      const id = (await add('10.0.0.11', 'edge-1')).json().added[0] as string;
      const other = (await add('10.0.0.3', 'edge-2')).json().added[0] as string;
      const ok = (fingerprint: string) =>
        w.report({
          devices: [
            {
              id,
              state: 'ok',
              polledAt: NOW,
              fingerprint,
              system: { uptimeS: 100, name: 'edge-1', kind: 'router' },
              health: {},
            },
          ],
        });
      await ok('ab'.repeat(32));
      const row = () =>
        ctx!.db
          .selectFrom('network_devices' as never)
          .select(['address', 'status', 'cert_pin', 'removed_at', 'name'] as never)
          .where('id' as never, '=', id as never)
          .executeTakeFirstOrThrow() as Promise<Row>;
      expect(await row()).toMatchObject({ status: 'ok', cert_pin: 'ab'.repeat(32) });

      // An address typed wrong: corrected, tried at once, trusted anew; another device's is refused.
      const taken = await w.call('PATCH', `/network/devices/${id}`, { address: '10.0.0.3' });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().detail).toBe('edge-2 is already at 10.0.0.3');
      expect(
        (await w.call('PATCH', `/network/devices/${id}`, { address: '10.0.0.1' })).statusCode,
      ).toBe(204);
      expect(await row()).toMatchObject({ address: '10.0.0.1', status: 'pending', cert_pin: null });
      expect((await w.config()).devices.find((d) => d.id === id)).toMatchObject({
        address: '10.0.0.1',
      });

      // Paused: the collector is told not to poll it, a late report changes nothing, and it
      // comes back on resume.
      expect((await w.call('PATCH', `/network/devices/${id}`, { paused: true })).statusCode).toBe(
        204,
      );
      expect(await row()).toMatchObject({ status: 'paused' });
      expect((await w.config()).devices.find((d) => d.id === id)!.paused).toBe(true);
      await ok('cd'.repeat(32));
      expect(await row()).toMatchObject({ status: 'paused', cert_pin: null });
      expect((await w.call('GET', `/network/devices/${id}`)).json().device.status).toBe('paused');
      expect((await w.call('PATCH', `/network/devices/${id}`, { paused: false })).statusCode).toBe(
        204,
      );
      expect(await row()).toMatchObject({ status: 'pending' });
      expect((await w.config()).devices.find((d) => d.id === id)!.paused).toBeUndefined();

      // Removed, then found again and added: the same device (its id and so its history), with
      // the name it had.
      expect((await w.call('DELETE', `/network/devices/${id}`)).statusCode).toBe(204);
      expect((await row()).removed_at).not.toBeNull();
      const back = await w.call('POST', '/network/devices', {
        clusterId: w.clusterId,
        host: w.host,
        devices: [{ address: '10.0.0.1', credentialId: cred }],
      });
      expect(back.json()).toMatchObject({ added: [id], restored: [id], skipped: [] });
      expect(await row()).toMatchObject({ removed_at: null, status: 'pending', name: 'edge-1' });
      expect((await w.call('GET', '/network/devices')).json().devices).toHaveLength(2);
      expect(other).not.toBe(id);

      expect((await audit()).slice(3).map((a) => [a.action, a.details])).toEqual([
        ['network_device_changed', { device: 'edge-1', changed: 'address' }],
        ['network_device_changed', { device: 'edge-1', changed: 'paused' }],
        ['network_device_changed', { device: 'edge-1', changed: 'resumed' }],
        ['network_device_removed', { device: 'edge-1', address: '10.0.0.1' }],
        ['network_devices_added', { devices: 1, restored: 1 }],
      ]);
    });

    it('an accepted certificate is undone by an Owner; a poller’s devices move to another poller', async () => {
      const w = await world(kind);
      const cred = (await w.call('POST', '/network/credentials', ROS)).json().id as string;
      const id = (
        await w.call('POST', '/network/devices', {
          clusterId: w.clusterId,
          host: w.host,
          devices: [{ address: '10.0.0.1', name: 'edge-1', credentialId: cred }],
        })
      ).json().added[0] as string;
      const say = (state: string, fingerprint: string) =>
        w.report({
          devices: [
            {
              id,
              state,
              polledAt: NOW,
              fingerprint,
              ...(state === 'ok'
                ? { system: { uptimeS: 100, name: 'edge-1', kind: 'router' }, health: {} }
                : { error: 'the certificate changed' }),
            },
          ],
        });
      await say('ok', 'ab'.repeat(32));
      await say('cert_changed', 'cd'.repeat(32));
      const pin = async () =>
        (await ctx!.db
          .selectFrom('network_devices' as never)
          .select(['cert_pin', 'cert_prev', 'status'] as never)
          .where('id' as never, '=', id as never)
          .executeTakeFirstOrThrow()) as Row;
      // Nothing to undo before an accept.
      expect((await w.call('POST', `/network/devices/${id}/restore-certificate`)).statusCode).toBe(
        409,
      );
      expect((await w.call('POST', `/network/devices/${id}/accept-certificate`)).statusCode).toBe(
        204,
      );
      expect(await pin()).toEqual({
        cert_pin: 'cd'.repeat(32),
        cert_prev: 'ab'.repeat(32),
        status: 'pending',
      });
      expect((await w.call('GET', `/network/devices/${id}`)).json().device.certUndo).toBe(true);
      // An Admin can't undo it; an Owner can: the one before is pinned again.
      const admin = await createUserSession(ctx!.db, { role: 'admin', orgId: w.orgId });
      expect(
        (
          await w.call(
            'POST',
            `/network/devices/${id}/restore-certificate`,
            undefined,
            admin.cookie,
          )
        ).statusCode,
      ).toBe(403);
      expect((await w.call('POST', `/network/devices/${id}/restore-certificate`)).statusCode).toBe(
        204,
      );
      expect(await pin()).toEqual({
        cert_pin: 'ab'.repeat(32),
        cert_prev: null,
        status: 'pending',
      });
      expect((await w.config()).devices[0]!.routeros.pin).toBe('ab'.repeat(32));
      expect((await w.call('GET', `/network/devices/${id}`)).json().device.certUndo).toBe(false);

      // The poller's devices, to another poller.
      const pollers = (await w.call('GET', '/network/pollers')).json().pollers;
      expect(pollers[0].hosts.find((x: Row) => x.host === w.host)).toMatchObject({ devices: 1 });
      let to: { clusterId: string; host: string };
      if (kind === 'server') to = { clusterId: w.clusterId, host: 'web-2' };
      else {
        const second = await w.call('POST', '/clusters', { name: 'staging', kind: 'kubernetes' });
        to = { clusterId: second.json().cluster.id, host: '' };
      }
      const from = { clusterId: w.clusterId, host: w.host };
      expect((await w.call('POST', '/network/pollers/move', { from, to: from })).statusCode).toBe(
        400,
      );
      expect(
        (await w.call('POST', '/network/pollers/move', { from, to: { ...to, host: 'nowhere' } }))
          .statusCode,
      ).toBe(400);
      expect((await w.call('POST', '/network/pollers/move', { from, to })).json()).toEqual({
        moved: 1,
      });
      expect((await w.config()).devices).toEqual([]);
      const moved = (await w.call('GET', `/network/devices/${id}`)).json().device;
      expect(moved.poller).toMatchObject({ clusterId: to.clusterId, host: to.host });
      expect((await audit()).slice(-3).map((a) => a.action)).toEqual([
        'network_certificate_accepted',
        'network_certificate_restored',
        'network_poller_moved',
      ]);
    });

    it('only Owners and Admins change anything; a Viewer reads', async () => {
      const w = await world(kind);
      const id = (await w.call('POST', '/network/credentials', V3)).json().id as string;
      const viewer = await createUserSession(ctx!.db, { role: 'viewer', orgId: w.orgId });
      const admin = await createUserSession(ctx!.db, { role: 'admin', orgId: w.orgId });
      const writes: [Method, string, object?][] = [
        ['PATCH', `/network/credentials/${id}`, { name: 'x' }],
        ['DELETE', `/network/credentials/${id}`],
        ['POST', `/network/credentials/${id}/move`, { to: id }],
        [
          'POST',
          '/network/credential-tests',
          { clusterId: w.clusterId, host: w.host, address: '10.0.0.2', ...without(V3, 'name') },
        ],
        ['GET', `/network/credential-tests/${crypto.randomUUID()}`],
        [
          'POST',
          '/network/pollers/move',
          {
            from: { clusterId: w.clusterId, host: w.host },
            to: { clusterId: w.clusterId, host: 'x' },
          },
        ],
      ];
      for (const [method, url, body] of writes)
        expect(
          (await w.call(method, url, body, viewer.cookie)).statusCode,
          `${method} ${url}`,
        ).toBe(403);
      // A Viewer sees the profiles (never a secret) and which devices use one.
      expect(
        (await w.call('GET', '/network/credentials', undefined, viewer.cookie)).statusCode,
      ).toBe(200);
      expect(
        (
          await w.call('GET', `/network/credentials/${id}/devices`, undefined, viewer.cookie)
        ).json(),
      ).toEqual({ devices: [] });
      // An Admin edits and deletes.
      expect(
        (await w.call('PATCH', `/network/credentials/${id}`, { name: 'by-admin' }, admin.cookie))
          .statusCode,
      ).toBe(204);
      expect(
        (await w.call('DELETE', `/network/credentials/${id}`, undefined, admin.cookie)).statusCode,
      ).toBe(204);
    });
  },
);

describe('the read-only demo', () => {
  it('refuses every change to a profile, a device and a poller', async () => {
    ctx = await createTestContext(
      {
        license: { key: licenseKey(NOW, { features: ['network'] }) },
        demoMode: true,
      } as Partial<Config>,
      { licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW }, now: () => NOW },
    );
    const owner = await createUserSession(ctx.db, { role: 'owner' });
    const id = crypto.randomUUID();
    const poller = { clusterId: id, host: '' };
    for (const [method, url, payload] of [
      ['PATCH', `/network/credentials/${id}`, { name: 'x' }],
      ['DELETE', `/network/credentials/${id}`, undefined],
      ['POST', `/network/credentials/${id}/move`, { to: id }],
      [
        'POST',
        '/network/credential-tests',
        { ...poller, address: '10.0.0.2', ...without(V3, 'name') },
      ],
      ['PATCH', `/network/devices/${id}`, { paused: true }],
      ['POST', `/network/devices/${id}/restore-certificate`, undefined],
      ['POST', '/network/pollers/move', { from: poller, to: { ...poller, host: 'x' } }],
    ] as [Method, string, object | undefined][]) {
      const res = await ctx.app.inject({
        method,
        url: `/api/v1${url}`,
        cookies: { wl_session: owner.cookie },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code, `${method} ${url}`).toBe('demo_read_only');
    }
  });
});

describe('what a probe’s error means', () => {
  it('reads the collector’s own sentences, of any version', () => {
    for (const [error, protocol, outcome] of [
      ['the device refused the SNMP credentials (wrong digest)', 'snmp', 'refused'],
      [
        'the router refused the RouterOS user: invalid user name or password (6)',
        'routeros',
        'refused',
      ],
      ['the recorder refused the user', 'dahua', 'refused'],
      ["the device didn't answer SNMP (request timeout (after 0 retries))", 'snmp', 'no_answer'],
      ['dial tcp 10.0.0.9:443: i/o timeout', 'routeros', 'no_answer'],
      ['dial tcp 10.0.0.9:8729: connect: connection refused', 'routeros', 'no_answer'],
      [
        'Get "https://10.0.0.9/rest/system/identity": context deadline exceeded',
        'routeros',
        'no_answer',
      ],
      ["the device's certificate changed since it was first seen", 'routeros', 'certificate'],
      [
        "the plain RouterOS API sends the password in clear; it's used only when allowed for this device",
        'routeros',
        'plain_refused',
      ],
      // A collector older than 1.0.2 asked to test a recorder.
      ['no SNMP credential', 'dahua', 'unsupported'],
      ['no credential answered', 'snmp', 'error'],
      ['RouterOS REST system/identity answered 500', 'routeros', 'error'],
    ] as const)
      expect(outcomeOf(error, protocol), error).toBe(outcome);
  });
});

function without<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const rest = { ...o };
  delete rest[key];
  return rest;
}
