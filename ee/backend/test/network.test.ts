// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network module through the real app (ADR-233): the gate, adding devices, the
// collector's configuration with credentials, the poller's reports (links, endpoints matched
// to a node, the port line, events in the place's list), the default alerts, the unit count.
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../backend/src/config.js';
import { moduleRules } from '../../../backend/src/modules/alerts/module-rules.js';
import { currentDevices } from '../../../backend/src/modules/license/units.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from '../../../backend/test/helpers.js';
import { licenseKey, TEST_KEYS } from '../../../backend/test/license-keys.js';

// The real clock: events land in today's partitions, as the other suites expect.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

async function app(features: string[] | null) {
  ctx = await createTestContext(
    (features ? { license: { key: licenseKey(NOW, { features }) } } : {}) as Partial<Config>,
    { licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW }, now: () => NOW },
  );
  const cookie = await setupAdmin(ctx.app);
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    ctx!.app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { wl_session: cookie },
      ...(payload ? { payload } : {}),
    });
  return { cookie, call };
}

describe('the gate', () => {
  it('answers 404 without a licence that lists network, and 200 with one', async () => {
    for (const [features, status] of [
      [null, 404],
      [['pro'], 404],
      [['network'], 200],
    ] as const) {
      if (ctx) await closeTestContext(ctx);
      const { call } = await app(features as string[] | null);
      expect((await call('GET', '/network/summary')).statusCode).toBe(status);
      expect(
        (
          await call(
            'GET',
            '/network/attachments?cluster=00000000-0000-0000-0000-000000000000&node=x',
          )
        ).statusCode,
      ).toBe(status);
    }
  });
});

describe('a network polled from a cluster', () => {
  it('adds devices, configures the collector, merges reports, matches a node, alerts', async () => {
    const { call } = await app(['network']);
    const created = await call('POST', '/clusters', { name: 'prod', kind: 'kubernetes' });
    const clusterId = created.json().cluster.id as string;
    const token = created.json().token.value as string;
    const ingest = (method: 'GET' | 'POST', url: string, body?: object, gzip = false) =>
      ctx!.app.inject({
        method,
        url: `/ingest/v1${url}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-watchlog-agent': 'collector',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
        ...(body ? { payload: gzip ? gzipSync(JSON.stringify(body)) : body } : {}),
      });
    // The node's network card, from its agent's inventory.
    const inv = await ingest(
      'POST',
      '/objects',
      {
        source: 'inventory',
        node: 'db-1',
        interfaces: [
          {
            name: 'eno1',
            mac: '3c:ec:ef:00:00:14',
            addresses: ['10.0.10.21'],
            speedMbps: 1000,
            up: true,
          },
        ],
      },
      true,
    );
    expect(inv.statusCode).toBe(204);
    // The collector heartbeats, so the cluster is a poller.
    await ingest('POST', '/integrations/status', {
      host: '',
      mode: 'kubernetes',
      version: '0.16.0',
      config_version: '',
      self: {},
      targets: [],
    });

    // A credential profile: write-only.
    const bad = await call('POST', '/network/credentials', {
      name: 'office-ro',
      protocol: 'snmp',
      settings: { version: '3', user: 'watchlog' },
      secret: { authKey: 'auth-key-1' },
    });
    expect(bad.statusCode).toBe(400);
    const cred = await call('POST', '/network/credentials', {
      name: 'office-ro',
      protocol: 'snmp',
      settings: { version: '3', user: 'watchlog', authProto: 'SHA256', privProto: 'AES' },
      secret: { authKey: 'auth-key-123', privKey: 'priv-key-123' },
    });
    expect(cred.statusCode).toBe(201);
    const credId = cred.json().id as string;
    const listed = (await call('GET', '/network/credentials')).json().credentials;
    expect(listed[0]).toMatchObject({ name: 'office-ro', secretSet: true });
    expect(JSON.stringify(listed)).not.toContain('auth-key-123');
    const stored = await ctx!.db
      .selectFrom('network_credentials' as never)
      .select('ciphertext' as never)
      .executeTakeFirst();
    expect(JSON.stringify(stored)).not.toContain('auth-key-123');

    const add = await call('POST', '/network/devices', {
      clusterId,
      host: '',
      devices: [
        { address: '10.0.0.2', name: 'core-1', credentialId: credId },
        { address: '10.0.0.12', name: 'sw-access-2', credentialId: credId },
      ],
    });
    expect(add.statusCode).toBe(201);
    const [coreId, swId] = add.json().added as string[];
    expect(
      (
        await call('POST', '/network/devices', {
          clusterId,
          host: 'web-1',
          devices: [{ address: '10.0.0.3', credentialId: credId }],
        })
      ).statusCode,
    ).toBe(400);
    // The network's alert rules joined the org's list.
    const rules = (await call('GET', '/alert-rules')).json();
    expect(JSON.stringify(rules)).toContain('Uplink down');

    // The collector's configuration: its devices, with the credential opened for it alone.
    const cfg = (await ingest('GET', '/integrations/config')).json();
    expect(cfg.modules.network.devices).toHaveLength(2);
    expect(cfg.modules.network.devices[0]).toMatchObject({
      address: '10.0.0.2',
      protocol: 'snmp',
      snmp: {
        version: '3',
        user: 'watchlog',
        authKey: 'auth-key-123',
        privKey: 'priv-key-123',
        authProto: 'SHA256',
      },
    });

    const port = (name: string, up: boolean, extra: object = {}) => ({
      index: 1,
      name,
      adminUp: true,
      operUp: up,
      speedMbps: 1000,
      errors: 0,
      ...extra,
    });
    const ifc = (index: number, name: string, mac?: string) => ({
      index,
      name,
      descr: name,
      kind: name.startsWith('Te') || name.startsWith('Eth') ? 'sfp' : 'ethernet',
      adminUp: true,
      operUp: true,
      speedMbps: name.startsWith('Gi') ? 1000 : 10000,
      ...(mac ? { mac } : {}),
    });
    const report = (
      round: number,
      swPorts: object[],
      inventory: boolean,
      uptime = 86400 + round * 60,
    ) => ({
      host: '',
      devices: [
        {
          id: coreId,
          state: 'ok',
          polledAt: NOW + round * 60_000,
          profile: 'cisco-nxos',
          system: {
            name: 'core-1',
            uptimeS: 900000,
            model: 'N3K-C3064PQ-10GX',
            firmware: '7.0(3)I7(9)',
            vendor: 'Cisco',
            kind: 'l3switch',
          },
          health: {
            cpu: 0.11,
            memUsed: 47,
            memTotal: 100,
            temperature: 46,
            ports: [port('Ethernet1/48', true, { speedMbps: 10000 })],
          },
          ...(inventory
            ? {
                inventory: {
                  interfaces: [ifc(1, 'Ethernet1/48', '00:1b:00:00:00:01')],
                  neighbours: [
                    {
                      localPort: 'Ethernet1/48',
                      protocol: 'cdp',
                      remoteName: 'sw-access-2',
                      remotePort: 'TenGigabitEthernet1/1/1',
                      remoteAddr: '10.0.0.12',
                    },
                  ],
                  macs: [],
                  arp: [{ mac: '3c:ec:ef:00:00:14', ip: '10.0.10.21' }],
                },
              }
            : {}),
        },
        {
          id: swId,
          state: 'ok',
          polledAt: NOW + round * 60_000,
          profile: 'cisco-ios',
          system: {
            name: 'sw-access-2',
            uptimeS: uptime,
            model: 'WS-C3850-48P',
            firmware: '16.12.9',
            vendor: 'Cisco',
            kind: 'switch',
          },
          health: {
            cpu: 0.08,
            ports: swPorts,
            fans: [{ name: 'Fan 1', state: 'ok' }],
            stack: [
              { number: 1, role: 'active', state: 'ready' },
              { number: 2, role: 'standby', state: 'ready' },
            ],
          },
          ...(inventory
            ? {
                inventory: {
                  interfaces: [
                    ifc(1, 'Gi1/0/14'),
                    ifc(2, 'Gi1/0/15'),
                    ifc(3, 'Te1/1/1', '00:1b:00:00:00:03'),
                  ],
                  neighbours: [
                    {
                      localPort: 'Te1/1/1',
                      protocol: 'lldp',
                      remoteName: 'core-1',
                      remotePort: 'Ethernet1/48',
                    },
                  ],
                  macs: [
                    { port: 'Gi1/0/14', mac: '3c:ec:ef:00:00:14', vlan: 10 },
                    { port: 'Gi1/0/15', mac: '00:1b:2b:00:00:99', vlan: 20 },
                  ],
                  arp: [],
                },
              }
            : {}),
        },
      ],
    });
    const ok = [
      port('Gi1/0/14', true),
      port('Gi1/0/15', true),
      port('Te1/1/1', true, { speedMbps: 10000 }),
    ];
    expect((await ingest('POST', '/network/report', report(0, ok, true))).statusCode).toBe(204);

    // One link from CDP on one end and LLDP on the other; the node behind Gi1/0/14.
    const map = (await call('GET', '/network/map')).json();
    expect(map.links).toHaveLength(1);
    expect(map.links[0].via).toEqual(['cdp', 'lldp']);
    const db1 = map.endpoints.find((e: { mac: string }) => e.mac === '3c:ec:ef:00:00:14');
    expect(db1).toMatchObject({
      deviceId: swId,
      port: 'Gi1/0/14',
      ip: '10.0.10.21',
      node: { clusterId, name: 'db-1', kind: 'kubernetes' },
    });
    expect(
      map.endpoints.find((e: { mac: string }) => e.mac === '00:1b:2b:00:00:99').vendor,
    ).toMatch(/Cisco/);
    const line = (await call('GET', `/network/attachments?cluster=${clusterId}&node=db-1`)).json();
    expect(line.attachments).toEqual([
      expect.objectContaining({
        device: 'sw-access-2',
        port: 'Gi1/0/14',
        speed: '1 Gb/s',
        up: true,
      }),
    ]);

    // The node's port goes down: on the device's page, in the cluster's Events for db-1, and
    // "Uplink down" (a WatchLog node is behind it); a desk port going down doesn't alert.
    const down = [
      port('Gi1/0/14', false),
      port('Gi1/0/15', false),
      port('Te1/1/1', true, { speedMbps: 10000 }),
    ];
    expect((await ingest('POST', '/network/report', report(1, down, false))).statusCode).toBe(204);
    const detail = (await call('GET', `/network/devices/${swId}`)).json();
    expect(
      detail.events.map((e: { reason: string; port: string }) => `${e.reason} ${e.port}`),
    ).toEqual(expect.arrayContaining(['PortDown Gi1/0/14', 'PortDown Gi1/0/15']));
    expect(detail.device).toMatchObject({
      model: 'WS-C3850-48P',
      firmware: '16.12.9',
      status: 'ok',
    });
    expect(
      detail.ports.find((p: { name: string }) => p.name === 'Te1/1/1').neighbour,
    ).toMatchObject({ device: 'core-1', port: 'Ethernet1/48' });
    const events = (await call('GET', `/clusters/${clusterId}/events?kinds=NetworkPort`)).json()
      .events;
    expect(events).toEqual([
      expect.objectContaining({
        reason: 'PortDown',
        host: 'db-1',
        involvedName: 'sw-access-2/Gi1/0/14',
      }),
    ]);

    const rule = (key: string) => moduleRules().find((r) => r.key === key)!;
    const memo = new Map<string, Promise<unknown>>();
    const evalCtx = async (key: string) => {
      const row = await ctx!.db
        .selectFrom('alert_rules')
        .selectAll()
        .where('rule_key', '=', key)
        .executeTakeFirstOrThrow();
      return rule(key).evaluator.evaluate({
        db: ctx!.db,
        rule: row,
        cluster: { id: clusterId, name: 'prod', kind: 'kubernetes' },
        now: NOW + 120_000,
        memo: (k, load) => (memo.get(k) ?? memo.set(k, load()).get(k)!) as never,
      } as never);
    };
    const uplink = await evalCtx('network.uplink.down');
    expect(uplink.map((o) => o.labels.port)).toEqual(['Gi1/0/14']);
    expect(uplink[0]!.details.why).toBe('db-1 is behind it');

    // A reboot and a lost stack member.
    await ingest('POST', '/network/report', {
      ...report(2, ok, false, 120),
      devices: report(2, ok, false, 120).devices.map((d) =>
        d.id === swId
          ? {
              ...d,
              health: { ...d.health, stack: [{ number: 1, role: 'active', state: 'ready' }] },
            }
          : d,
      ),
    });
    memo.clear();
    expect((await evalCtx('network.device.rebooted')).map((o) => o.labels.device)).toEqual([
      'sw-access-2',
    ]);
    expect((await evalCtx('network.stack.member_lost')).map((o) => o.details.why)).toEqual([
      '1 of 2 switches',
    ]);
    const reboots = (await call('GET', `/clusters/${clusterId}/events?kinds=NetworkDevice`)).json()
      .events;
    expect(reboots[0]).toMatchObject({ reason: 'DeviceRebooted', host: 'db-1' });

    // Unreachable after 3 failed polls; the others on that device held under it.
    for (let i = 1; i <= 3; i++) {
      await ingest('POST', '/network/report', {
        host: '',
        devices: [
          {
            id: coreId,
            state: 'unreachable',
            error: 'no answer',
            polledAt: NOW + (3 + i) * 60_000,
            failures: i,
          },
        ],
      });
    }
    memo.clear();
    expect((await evalCtx('network.device.unreachable')).map((o) => o.labels.device)).toEqual([
      'core-1',
    ]);
    expect(rule('network.uplink.down').heldUnder).toBe('network.device.unreachable');

    // Units: the devices; an access point a controller manages is free.
    await call('PATCH', `/network/devices/${coreId}`, { managedAp: true });
    const units = await currentDevices(ctx!.db);
    expect([...units.values()]).toEqual([1]);

    // Removing a device: gone from the map and from the collector's configuration.
    expect((await call('DELETE', `/network/devices/${swId}`)).statusCode).toBe(204);
    expect((await call('GET', '/network/map')).json().links).toHaveLength(0);
    expect(
      (await ingest('GET', '/integrations/config')).json().modules.network.devices,
    ).toHaveLength(1);
  });
});

describe('a network polled from a server of a fleet', () => {
  it("sends each server's collector only its own devices", async () => {
    const { call } = await app(['network']);
    const created = await call('POST', '/clusters', { name: 'fleet', kind: 'server' });
    const clusterId = created.json().cluster.id as string;
    const token = created.json().token.value as string;
    for (const node of ['web-1', 'web-2']) {
      await ctx!.db
        .insertInto('agent_instances')
        .values({
          id: crypto.randomUUID(),
          cluster_id: clusterId,
          org_id:
            created.json().cluster.orgId ??
            (
              await ctx!.db
                .selectFrom('clusters')
                .select('org_id')
                .where('id', '=', clusterId)
                .executeTakeFirstOrThrow()
            ).org_id,
          node,
          mode: 'docker',
          agent_version: '0.16.0',
          last_seen_at: new Date(NOW),
        })
        .execute();
    }
    const pollers = (await call('GET', '/network/pollers')).json().pollers;
    expect(pollers[0]).toMatchObject({
      kind: 'server',
      hosts: [
        { host: 'web-1', collector: false },
        { host: 'web-2', collector: false },
      ],
    });
    const cred = (
      await call('POST', '/network/credentials', {
        name: 'edge',
        protocol: 'routeros',
        settings: { user: 'watchlog' },
        secret: { password: 'pw-1' },
      })
    ).json().id;
    expect(
      (
        await call('POST', '/network/credentials', {
          name: 'plain',
          protocol: 'routeros',
          settings: { user: 'w', transport: 'api' },
          secret: { password: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    const add = await call('POST', '/network/devices', {
      clusterId,
      host: 'web-1',
      devices: [{ address: '10.0.0.1', name: 'edge-1', credentialId: cred }],
    });
    expect(add.statusCode).toBe(201);
    const config = (host: string) =>
      ctx!.app
        .inject({
          method: 'GET',
          url: `/ingest/v1/integrations/config?host=${host}`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json());
    expect((await config('web-1')).modules.network.devices[0]).toMatchObject({
      address: '10.0.0.1',
      protocol: 'routeros',
      profile: 'mikrotik',
      routeros: { user: 'watchlog', password: 'pw-1' },
    });
    expect((await config('web-2')).modules).toBeUndefined();
    // Trust on first use: the certificate is pinned, then sent with the credential.
    const id = add.json().added[0];
    const post = (body: object) =>
      ctx!.app.inject({
        method: 'POST',
        url: '/ingest/v1/network/report',
        headers: { authorization: `Bearer ${token}` },
        payload: body,
      });
    await post({
      host: 'web-1',
      devices: [
        {
          id,
          state: 'ok',
          polledAt: NOW,
          fingerprint: 'ab'.repeat(32),
          system: { uptimeS: 100, name: 'edge-1', kind: 'router' },
          health: {},
        },
      ],
    });
    expect((await config('web-1')).modules.network.devices[0].routeros.pin).toBe('ab'.repeat(32));
    // A changed certificate: paused until an Owner accepts it.
    await post({
      host: 'web-1',
      devices: [
        { id, state: 'cert_changed', polledAt: NOW + 60_000, fingerprint: 'cd'.repeat(32) },
      ],
    });
    expect((await config('web-1')).modules.network.devices[0].paused).toBe(true);
    expect((await call('POST', `/network/devices/${id}/accept-certificate`)).statusCode).toBe(204);
    const after = (await config('web-1')).modules.network.devices[0];
    expect(after.paused).toBeUndefined();
    expect(after.routeros.pin).toBe('cd'.repeat(32));
    // Another server's collector can't report for it.
    await post({
      host: 'web-2',
      devices: [{ id, state: 'unreachable', polledAt: NOW + 120_000, failures: 9 }],
    });
    expect((await call('GET', `/network/devices/${id}`)).json().device.status).toBe('pending');
    // Moving it to web-2.
    expect((await call('PATCH', `/network/devices/${id}`, { host: 'web-2' })).statusCode).toBe(204);
    expect((await config('web-2')).modules.network.devices).toHaveLength(1);
  });
});
