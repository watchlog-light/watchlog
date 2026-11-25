// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The 0.17 kinds through the real app (ADR-234), polled from a Kubernetes cluster and from a
// fleet's server: CAPsMAN's access points (free), clients and mesh; a NAS, its LUNs and the
// recorder's iSCSI session; a recorder's three signals going from recording to not
// recording; a UPS on battery in the Events of the server it feeds. The clock is injected.
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

const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const MIN = 60_000;
let clock = NOW;
let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
  clock = NOW;
});

async function app() {
  ctx = await createTestContext(
    { license: { key: licenseKey(NOW, { features: ['network'] }) } } as Partial<Config>,
    { licenseTest: { trusted: [TEST_KEYS.x], now: () => NOW }, now: () => clock },
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
  return { call };
}

async function place(call: Awaited<ReturnType<typeof app>>['call'], name: string, kind: string) {
  const created = await call('POST', '/clusters', { name, kind });
  const clusterId = created.json().cluster.id as string;
  const token = created.json().token.value as string;
  const ingest = (method: 'GET' | 'POST', url: string, body?: object) =>
    ctx!.app.inject({
      method,
      url: `/ingest/v1${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-watchlog-agent': 'collector',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { payload: body } : {}),
    });
  return { clusterId, ingest };
}

const TB = 1e12;
const disks = (iscsiHealthy: boolean) => [
  {
    name: '/dev/sda',
    iscsi: false,
    state: 'Success',
    healthy: true,
    total: 2 * TB,
    used: 1.4 * TB,
  },
  {
    name: '/dev/iscsi0',
    iscsi: true,
    state: iscsiHealthy ? 'Success' : 'Error',
    healthy: iscsiHealthy,
    total: iscsiHealthy ? 16 * TB : 0,
    used: iscsiHealthy ? 10 * TB : 0,
  },
];
const cameras = (offline: number[] = []) =>
  Array.from({ length: 16 }, (_, i) => ({
    channel: i,
    name: `cam-${i + 1}`,
    online: !offline.includes(i),
  }));
const recorder = (id: string, iscsiHealthy = true, offline: number[] = []) => ({
  id,
  state: 'ok',
  polledAt: clock,
  profile: 'dahua',
  system: {
    name: 'nvr-1',
    uptimeS: 0,
    model: 'NVR5364',
    vendor: 'Dahua',
    kind: 'nvr',
    firmware: '4.003',
    mac: '3c:ef:8c:00:00:01',
  },
  recorder: {
    disks: disks(iscsiHealthy),
    cameras: cameras(offline),
    active: iscsiHealthy ? [] : [{ code: 'StorageNotExist', action: 'Start', index: 1, at: clock }],
    stream: true,
  },
});
const ups = (id: string, status = 'online') => ({
  id,
  state: 'ok',
  polledAt: clock,
  profile: 'apc-ups',
  system: { name: 'ups-1', uptimeS: 86400, vendor: 'APC', kind: 'ups' },
  ups: {
    status,
    chargePercent: status === 'online' ? 100 : 82,
    runtimeS: status === 'online' ? 2400 : 480,
    loadPercent: 41,
    inputVolts: status === 'online' ? 230 : 0,
    outputVolts: 230,
    replaceBattery: false,
  },
});

describe('Wi-Fi, storage, recording and a UPS polled from a cluster', () => {
  it('shows them, judges recording, alerts and counts APs free', async () => {
    const { call } = await app();
    const { clusterId, ingest } = await place(call, 'office', 'kubernetes');
    await ingest('POST', '/integrations/status', {
      host: '',
      mode: 'kubernetes',
      version: '0.17.0',
      config_version: '',
      self: {},
      targets: [],
    });

    const cred = async (body: object) =>
      (await call('POST', '/network/credentials', body)).json().id as string;
    const snmp = await cred({
      name: 'snmp',
      protocol: 'snmp',
      settings: { version: '2c' },
      secret: { community: 'c-office' },
    });
    const ros = await cred({
      name: 'ros',
      protocol: 'routeros',
      settings: { user: 'watchlog' },
      secret: { password: 'ros-pass' },
    });
    expect(
      (
        await call('POST', '/network/credentials', {
          name: 'nvr',
          protocol: 'dahua',
          settings: { user: 'watchlog' },
        })
      ).statusCode,
    ).toBe(400);
    const dahua = await cred({
      name: 'nvr',
      protocol: 'dahua',
      settings: { user: 'watchlog' },
      secret: { password: 'nvr-pass' },
    });
    expect(
      (
        await call('POST', '/network/discoveries', {
          clusterId,
          host: '',
          seeds: ['10.0.10.50'],
          credentialIds: [dahua],
        })
      ).statusCode,
    ).toBe(400);
    const added = (
      await call('POST', '/network/devices', {
        clusterId,
        host: '',
        devices: [
          { address: '10.0.150.1', name: 'edge-1', credentialId: ros },
          { address: '10.0.0.12', name: 'sw-access-2', credentialId: snmp },
          { address: '10.0.10.40', name: 'nas-1', credentialId: snmp, profile: 'qnap' },
          { address: '10.0.10.41', name: 'ups-1', credentialId: snmp },
          { address: '10.0.10.50', name: 'nvr-1', credentialId: dahua },
        ],
      })
    ).json().added as string[];
    const [edge, sw, nas, upsId, nvr] = added as [string, string, string, string, string];
    // The recorder's read-only user reaches only its poller.
    const cfg = (await ingest('GET', '/integrations/config')).json().modules.network.devices;
    expect(cfg.find((d: { id: string }) => d.id === nvr)).toMatchObject({
      protocol: 'dahua',
      dahua: { user: 'watchlog', password: 'nvr-pass' },
    });

    const ap = (name: string, mac: string, ch: number, state = 'running') => ({
      name,
      mac,
      address: `10.0.150.${mac.slice(-1)}`,
      model: 'cAP ax',
      version: '7.18.2',
      state,
      uptimeS: 7200,
      generation: 'wifi',
      radios: [
        {
          interface: `${name}-2g`,
          ssid: 'office',
          band: '2ghz-ax',
          channel: ch,
          frequencyMhz: 2407 + 5 * ch,
          clients: 3,
          running: true,
        },
        {
          interface: `${name}-5g`,
          ssid: 'office',
          band: '5ghz-ax',
          channel: 36,
          frequencyMhz: 5180,
          clients: 2,
          running: true,
        },
      ],
    });
    const client = (n: number, apName: string, signal: number) => ({
      mac: `a4:83:e7:00:00:${n.toString(16).padStart(2, '0')}`,
      ap: apName,
      ssid: 'office',
      band: '5ghz-ax',
      signalDbm: signal,
      txRate: '866Mbps',
      rxRate: '650Mbps',
      uptimeS: 600,
      bytesTx: 1e6,
      bytesRx: 2e6,
    });
    const wireless = (warehouseUp = true) => ({
      generations: ['wifi'],
      aps: [
        ap('ap-lobby', '48:a9:8a:10:00:01', 1),
        ap('ap-office', '48:a9:8a:10:00:02', 6),
        ...(warehouseUp ? [ap('ap-warehouse', '48:a9:8a:10:00:03', 3)] : []),
      ],
      clients: [
        ...[1, 2, 3, 4, 5].map((n) => client(n, 'ap-lobby', -80)),
        ...[6, 7].map((n) => client(n, 'ap-lobby', -55)),
        ...[8, 9, 10].map((n) => client(n, 'ap-office', -60)),
      ],
      mesh: warehouseUp
        ? [{ from: 'ap-warehouse', to: 'ap-office', signalDbm: -58, rate: '780Mbps' }]
        : [],
    });
    const iface = (index: number, name: string, mac?: string) => ({
      index,
      name,
      descr: name,
      kind: 'ethernet',
      adminUp: true,
      operUp: true,
      speedMbps: 1000,
      ...(mac ? { mac } : {}),
    });
    const report = (
      o: {
        warehouse?: boolean;
        iscsi?: boolean;
        offline?: number[];
        ups?: string;
        inventory?: boolean;
      } = {},
    ) => ({
      host: '',
      devices: [
        {
          id: edge,
          state: 'ok',
          polledAt: clock,
          profile: 'mikrotik',
          system: {
            name: 'edge-1',
            uptimeS: 90000,
            vendor: 'MikroTik',
            model: 'CCR2004',
            kind: 'router',
          },
          health: { cpu: 0.05, ports: [] },
          wireless: wireless(o.warehouse ?? true),
        },
        {
          id: sw,
          state: 'ok',
          polledAt: clock,
          profile: 'cisco-ios',
          system: { name: 'sw-access-2', uptimeS: 90000, vendor: 'Cisco', kind: 'switch' },
          health: { ports: [] },
          ...(o.inventory
            ? {
                inventory: {
                  interfaces: [
                    iface(1, 'Gi1/0/20'),
                    iface(2, 'Gi1/0/40'),
                    iface(3, 'Gi1/0/44'),
                    iface(4, 'Te1/1/1', '00:1b:00:00:00:03'),
                  ],
                  neighbours: [],
                  macs: [
                    { port: 'Gi1/0/20', mac: '24:5e:be:00:00:40' },
                    { port: 'Gi1/0/40', mac: '3c:ef:8c:00:00:01' },
                    { port: 'Gi1/0/44', mac: '48:a9:8a:10:00:01' },
                  ],
                  arp: [],
                },
              }
            : {}),
        },
        {
          id: nas,
          state: 'ok',
          polledAt: clock,
          profile: 'qnap',
          system: { name: 'nas-1', uptimeS: 90000, vendor: 'QNAP', model: 'TS-433', kind: 'nas' },
          health: { temperature: 41, sensors: [{ name: 'CPU', celsius: 41 }] },
          nas: {
            disks: [1, 2, 3, 4].map((i) => ({
              index: i,
              name: `Disk ${i}`,
              model: 'WD Red Plus 12TB',
              capacity: 12 * TB,
              celsius: 36 + i,
              smart: 'good',
              status: 'ready',
            })),
            volumes: [
              {
                name: 'DataVol1',
                total: 32.7 * TB,
                free: 3.1 * TB,
                status: 'Ready',
                raid: 'RAID 5',
              },
            ],
            pools: [
              {
                name: 'Storage Pool 1',
                total: 32.7 * TB,
                free: 3.1 * TB,
                status: 'ready',
                raid: 'RAID 5',
              },
            ],
            luns: [
              {
                name: 'nvr-1-rec',
                capacity: 16 * TB,
                usedPercent: 62,
                status: 'enabled',
                mapped: true,
              },
              {
                name: 'nvr-2-rec',
                capacity: 16 * TB,
                usedPercent: 40,
                status: 'enabled',
                mapped: true,
              },
            ],
            targets: [
              {
                name: 'nvr-1',
                iqn: 'iqn.2004-04.com.qnap:ts-433:iscsi.nvr-1',
                connected: o.iscsi ?? true,
                status: o.iscsi === false ? 'ready' : 'connected',
              },
              {
                name: 'nvr-2',
                iqn: 'iqn.2004-04.com.qnap:ts-433:iscsi.nvr-2',
                connected: false,
                status: 'ready',
              },
            ],
          },
          ...(o.inventory
            ? {
                inventory: {
                  interfaces: [iface(1, 'lo'), iface(2, 'eth0', '24:5e:be:00:00:40')],
                  neighbours: [],
                  macs: [],
                  arp: [],
                },
              }
            : {}),
        },
        ups(upsId, o.ups),
        recorder(nvr, o.iscsi ?? true, o.offline),
      ],
    });
    expect((await ingest('POST', '/network/report', report({ inventory: true }))).statusCode).toBe(
      204,
    );

    // Access points are devices of their controller, free of units.
    const summary = (await call('GET', '/network/summary')).json();
    expect(summary.kinds).toMatchObject({ ap: 3, nas: 1, nvr: 1, ups: 1, router: 1 });
    expect(summary.wifiClients).toBe(10);
    expect(summary.tiles.oldestFirmware?.name).not.toBe('nvr-1');
    expect(summary.recording).toEqual([
      expect.objectContaining({
        name: 'nvr-1',
        recording: true,
        cameras: { online: 16, total: 16 },
      }),
    ]);
    expect([...(await currentDevices(ctx!.db)).values()]).toEqual([5]);
    expect((await call('GET', '/network/kinds')).json()).toMatchObject({
      kinds: { ap: 3, nas: 1, nvr: 1, ups: 1 },
      devices: 8,
      wifiClients: 10,
    });

    const wifi = (await call('GET', '/network/wireless')).json();
    expect(wifi.tiles).toMatchObject({
      aps: 3,
      apsUp: 3,
      clients: 10,
      weak: 5,
      busiest: { name: 'ap-lobby', clients: 7 },
    });
    expect(wifi.mesh).toEqual([
      expect.objectContaining({ from: 'ap-warehouse', to: 'ap-office', signalDbm: -58 }),
    ]);
    const lobby = wifi.aps.find((a: { name: string }) => a.name === 'ap-lobby');
    expect(lobby).toMatchObject({
      controller: 'edge-1',
      managedAp: true,
      clients: 7,
      weak: 5,
      switchPort: { device: 'sw-access-2', port: 'Gi1/0/44' },
    });
    // The device page's facts for kinds without CPU, memory or ports (0.17.1).
    const apPage = (await call('GET', `/network/devices/${lobby.id}`)).json();
    expect(apPage.kind.ap).toMatchObject({ clients: 7, weak: 5, weakDbm: -75 });
    expect(apPage.kind.ap.radios).toHaveLength(2);
    expect(apPage.device.parentName).toBe('edge-1');
    expect((await call('GET', `/network/devices/${upsId}`)).json().kind.ups).toMatchObject({
      status: 'online',
    });
    expect((await call('GET', `/network/devices/${nvr}`)).json().kind.recorder).toMatchObject({
      recording: true,
      camerasOnline: 16,
      camerasTotal: 16,
    });
    expect((await call('GET', `/network/devices/${sw}`)).json().kind).toEqual({});
    expect(
      Object.keys(
        (await call('GET', `/network/devices/${lobby.id}/series?range=3600`)).json().kind,
      ),
    ).toEqual(['clients']);
    expect(
      Object.keys((await call('GET', `/network/devices/${upsId}/series?range=3600`)).json().kind),
    ).toEqual(['charge', 'runtime', 'load']);
    expect(wifi.clients.find((c: { mac: string }) => c.mac === 'a4:83:e7:00:00:08')).toMatchObject({
      ap: 'ap-office',
      signalDbm: -60,
    });

    // Storage: the recorder's card, the NAS, the session it derives (seen from the recorder).
    const storage = (await call('GET', '/network/storage')).json();
    const card = storage.recorders[0];
    expect(card).toMatchObject({
      name: 'nvr-1',
      recording: true,
      cameras: { online: 16, total: 16 },
    });
    expect(card.signals.map((s: { key: string; ok: boolean | null }) => [s.key, s.ok])).toEqual([
      ['recorder', true],
      ['disk', true],
      ['rate', null],
    ]);
    expect(storage.sessions).toEqual([
      expect.objectContaining({
        recorder: 'nvr-1',
        disk: '/dev/iscsi0',
        nas: 'nas-1',
        lun: 'nvr-1-rec',
        target: 'nvr-1',
        connected: true,
        seenFrom: 'recorder',
      }),
    ]);
    expect(storage.nases[0].luns[0]).toMatchObject({
      name: 'nvr-1-rec',
      session: { recorder: 'nvr-1', connected: true },
    });
    expect(storage.upses[0]).toMatchObject({ name: 'ups-1', ups: { status: 'online' } });

    // The map: the recorder and the NAS behind their ports, the iSCSI path between them.
    const map = (await call('GET', '/network/map')).json();
    expect(map.iscsi).toEqual([
      expect.objectContaining({
        recorderId: nvr,
        nasId: nas,
        connected: true,
        path: expect.objectContaining({ devices: [nvr, sw, nas] }),
      }),
    ]);
    expect(map.mesh).toHaveLength(1);

    // A minute on: ap-warehouse drops off CAPsMAN, the recorder loses its iSCSI disk, a camera
    // goes, the UPS goes on battery.
    clock += MIN;
    await ingest(
      'POST',
      '/network/report',
      report({ warehouse: false, iscsi: false, offline: [3], ups: 'on-battery' }),
    );
    let card2 = (await call('GET', '/network/storage')).json().recorders[0];
    // Not yet 5 minutes: still recording, the disk signal failing.
    expect(card2).toMatchObject({ recording: true });
    expect(card2.signals[1]).toMatchObject({ key: 'disk', ok: false });
    for (let i = 2; i <= 6; i++) {
      clock = NOW + i * MIN;
      await ingest(
        'POST',
        '/network/report',
        report({ warehouse: false, iscsi: false, offline: [3], ups: 'on-battery' }),
      );
    }
    card2 = (await call('GET', '/network/storage')).json().recorders[0];
    expect(card2).toMatchObject({ recording: false, failed: ['recorder', 'disk'] });
    expect((await call('GET', '/network/summary')).json().recording[0]).toMatchObject({
      recording: false,
      why: expect.stringContaining('/dev/iscsi0'),
    });

    // The place's Events: not recording, the disk lost, the AP gone (cameras stay on the page).
    const events = (await call('GET', `/clusters/${clusterId}/events?kinds=NetworkDevice`)).json()
      .events;
    expect(events.map((e: { reason: string }) => e.reason)).toEqual(
      expect.arrayContaining([
        'NotRecording',
        'ISCSIDiskLost',
        'APDisconnected',
        'UPSOnBattery',
        'ISCSIDisconnected',
      ]),
    );
    expect(events.map((e: { reason: string }) => e.reason)).not.toContain('CameraOffline');
    const page = (await call('GET', `/network/devices/${nvr}`)).json();
    expect(page.events.map((e: { reason: string }) => e.reason)).toEqual(
      expect.arrayContaining(['CameraOffline', 'NotRecording']),
    );

    // The alerts, evaluated for the cluster.
    const rule = (key: string) => moduleRules().find((r) => r.key === key)!;
    await call('GET', '/alert-rules');
    const evaluate = async (key: string) => {
      const row = await ctx!.db
        .selectFrom('alert_rules')
        .selectAll()
        .where('rule_key', '=', key)
        .executeTakeFirstOrThrow();
      const memo = new Map<string, Promise<unknown>>();
      return rule(key).evaluator.evaluate({
        db: ctx!.db,
        rule: row,
        cluster: { id: clusterId, name: 'office', kind: 'kubernetes' },
        now: clock,
        memo: (k, load) => (memo.get(k) ?? memo.set(k, load()).get(k)!) as never,
      } as never);
    };
    expect((await evaluate('network.recorder.not_recording'))[0]?.details.title).toBe(
      'nvr-1 is not recording',
    );
    expect(await evaluate('network.recorder.iscsi_lost')).toHaveLength(1);
    expect((await evaluate('network.iscsi.session_lost'))[0]?.details.why).toMatch(
      /^seen from the recorder/,
    );
    expect((await evaluate('network.recorder.camera_offline'))[0]?.details.title).toBe(
      'nvr-1: camera cam-4 is offline',
    );
    expect((await evaluate('network.ap.disconnected')).map((o) => o.labels.device)).toEqual([
      'ap-warehouse',
    ]);
    expect((await evaluate('network.ap.weak_clients'))[0]?.details.why).toBe(
      '5 of 7 clients below -75 dBm',
    );
    expect(await evaluate('network.ap.channel_overlap')).toEqual([]); // ap-warehouse (ch 3) is gone
    expect((await evaluate('network.ups.on_battery'))[0]?.details.title).toBe(
      'ups-1 is on battery',
    );
    expect(await evaluate('network.ups.runtime_low')).toHaveLength(1);
    // The recorder gives no uptime (0): not a reboot.
    expect((await evaluate('network.device.rebooted')).map((o) => o.labels.device)).not.toContain(
      'nvr-1',
    );

    // The disk comes back: recording again at once, the session reconnected.
    clock = NOW + 7 * MIN;
    await ingest('POST', '/network/report', report({ ups: 'online' }));
    const back = (await call('GET', '/network/storage')).json();
    expect(back.recorders[0]).toMatchObject({ recording: true, failed: [] });
    expect(back.sessions[0]).toMatchObject({ connected: true });

    // Another org's UPS, recorder, session and client: never seen here, its UPS not changeable.
    const other = crypto.randomUUID();
    const otherCluster = crypto.randomUUID();
    const db = ctx!.db as unknown as import('../../../backend/src/ee-contract.js').EeDb;
    await db
      .insertInto('orgs')
      .values({ id: other, name: 'Other', slug: `other-${other.slice(0, 8)}`, plan: 'pro' })
      .execute();
    await db
      .insertInto('clusters')
      .values({ id: otherCluster, org_id: other, name: 'theirs', kind: 'server' })
      .execute();
    const theirUps = crypto.randomUUID();
    const theirNvr = crypto.randomUUID();
    for (const [id, kind] of [
      [theirUps, 'ups'],
      [theirNvr, 'nvr'],
    ])
      await db
        .insertInto('network_devices')
        .values({
          id,
          org_id: other,
          cluster_id: otherCluster,
          name: `their-${kind}`,
          address: `10.9.9.${kind === 'ups' ? 1 : 2}`,
          protocol: kind === 'nvr' ? 'dahua' : 'snmp',
          kind,
          status: 'ok',
        })
        .execute();
    await db
      .insertInto('network_iscsi_sessions')
      .values({
        org_id: other,
        recorder_id: theirNvr,
        disk: '/dev/iscsi0',
        connected: true,
        seen_at: new Date(clock),
      })
      .execute();
    await db
      .insertInto('network_wifi_clients')
      .values({
        org_id: other,
        mac: 'a4:83:e7:99:99:99',
        controller_id: theirUps,
        ap: 'theirs',
        seen_at: new Date(clock),
      })
      .execute();
    const mine = (await call('GET', '/network/storage')).json();
    expect(JSON.stringify(mine)).not.toContain('their-');
    expect(mine.sessions).toHaveLength(1);
    expect(
      (await call('GET', '/network/wireless')).json().clients.map((c: { mac: string }) => c.mac),
    ).not.toContain('a4:83:e7:99:99:99');
    expect((await call('GET', '/network/kinds')).json().wifiClients).toBe(10);
    expect(
      (await call('PUT', `/network/devices/${theirUps}/feeds`, { feeds: [] })).statusCode,
    ).toBe(404);
    expect((await call('GET', `/network/devices/${theirNvr}`)).statusCode).toBe(404);

    // Removing the controller removes its access points.
    expect((await call('DELETE', `/network/devices/${edge}`)).statusCode).toBe(204);
    expect((await call('GET', '/network/summary')).json().kinds.ap).toBeUndefined();
  });
});

describe('a recorder and a UPS polled from a server of a fleet', () => {
  it("puts the UPS's battery in the Events of the server it feeds, the rest in the fleet's", async () => {
    const { call } = await app();
    const { clusterId, ingest } = await place(call, 'site', 'server');
    const orgId = (
      await ctx!.db
        .selectFrom('clusters')
        .select('org_id')
        .where('id', '=', clusterId)
        .executeTakeFirstOrThrow()
    ).org_id;
    for (const node of ['web-1', 'db-1'])
      await ctx!.db
        .insertInto('agent_instances')
        .values({
          id: crypto.randomUUID(),
          cluster_id: clusterId,
          org_id: orgId,
          node,
          mode: 'docker',
          agent_version: '0.17.0',
          last_seen_at: new Date(NOW),
        } as never)
        .execute();
    await ingest('POST', '/integrations/status', {
      host: 'web-1',
      mode: 'docker',
      version: '0.17.0',
      config_version: '',
      self: {},
      targets: [],
    });
    const snmp = (
      await call('POST', '/network/credentials', {
        name: 'snmp',
        protocol: 'snmp',
        settings: { version: '2c' },
        secret: { community: 'c' },
      })
    ).json().id;
    const dahua = (
      await call('POST', '/network/credentials', {
        name: 'nvr',
        protocol: 'dahua',
        settings: { user: 'watchlog', https: true },
        secret: { password: 'p' },
      })
    ).json().id;
    const res = await call('POST', '/network/devices', {
      clusterId,
      host: 'web-1',
      devices: [
        { address: '10.1.0.41', name: 'ups-1', credentialId: snmp },
        { address: '10.1.0.50', name: 'nvr-1', credentialId: dahua },
      ],
    });
    const [upsId, nvr] = res.json().added as [string, string];
    const cfg = (await ingest('GET', '/integrations/config?host=web-1')).json();
    const devs = cfg.modules?.network?.devices ?? [];
    if (devs.length)
      expect(devs.find((d: { id: string }) => d.id === nvr).dahua).toMatchObject({ https: true });

    const round = (status: string, iscsi: boolean) => ({
      host: 'web-1',
      devices: [ups(upsId, status), recorder(nvr, iscsi)],
    });
    await ingest('POST', '/network/report', round('online', true));
    // The UPS feeds db-1 (set on its page); only a UPS can.
    expect(
      (await call('PUT', `/network/devices/${nvr}/feeds`, { feeds: [{ clusterId, node: 'db-1' }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call('PUT', `/network/devices/${upsId}/feeds`, {
          feeds: [{ clusterId, node: 'db-1' }],
        })
      ).statusCode,
    ).toBe(204);

    for (let i = 1; i <= 6; i++) {
      clock = NOW + i * MIN;
      await ingest('POST', '/network/report', round('on-battery', false));
    }
    const events = (await call('GET', `/clusters/${clusterId}/events?kinds=NetworkDevice`)).json()
      .events as { reason: string; host: string; message: string }[];
    const battery = events.find((e) => e.reason === 'UPSOnBattery');
    expect(battery).toMatchObject({ host: 'db-1' });
    expect(battery!.message).toMatch(/It feeds db-1\.$/);
    expect(events.find((e) => e.reason === 'NotRecording')).toMatchObject({ host: null });
    const storage = (await call('GET', '/network/storage')).json();
    expect(storage.recorders[0]).toMatchObject({
      recording: false,
      poller: { kind: 'server', host: 'web-1' },
    });
    expect(storage.upses[0].feeds).toEqual([
      expect.objectContaining({ node: 'db-1', cluster: 'site', kind: 'server' }),
    ]);
  });
});
