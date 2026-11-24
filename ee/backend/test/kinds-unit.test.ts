// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The 0.17 kinds without a database (ADR-234): the three recording signals and every
// combination of them, the 5-minute rule, days of recording left, which NAS and LUN a
// recorder's disk is, 2.4 GHz overlap, leaves on the map, the iSCSI path, and each new alert
// against generated devices with an injected clock.
import { describe, expect, it } from 'vitest';
import type { EeHost, Observation } from '../../../backend/src/ee-contract.js';
import { channel24, kindRules, overlaps } from '../src/network/alerts-kinds.js';
import {
  apStatus,
  camerasNow,
  matchSession,
  smartState,
  upsState,
  volumeState,
} from '../src/network/kinds.js';
import { mergeLinks, type DevRef } from '../src/network/links.js';
import {
  daysLeft,
  diskSignal,
  NOT_RECORDING_MS,
  rateSignal,
  recorderSignal,
  SIGNALS,
  stepRecording,
  type SignalKey,
} from '../src/network/recording.js';
import type { Recorder, RecorderDisk } from '../src/network/report.js';
import { pathBetween } from '../src/network/routes-kinds.js';

const T0 = Date.UTC(2026, 10, 24, 10, 0);
const MIN = 60_000;
const TB = 1e12;
const local: RecorderDisk = {
  name: '/dev/sda',
  iscsi: false,
  state: 'Success',
  healthy: true,
  total: 2 * TB,
  used: 1.4 * TB,
};
const iscsi: RecorderDisk = {
  name: '/dev/iscsi0',
  iscsi: true,
  state: 'Success',
  healthy: true,
  total: 16 * TB,
  used: 10 * TB,
};
const rec = (disks: RecorderDisk[], active: Recorder['active'] = []): Recorder => ({
  disks,
  cameras: [],
  active,
  stream: true,
});

describe('the three recording signals', () => {
  it('signal 1: a healthy disk and no failure open on its stream', () => {
    expect(recorderSignal(rec([local, iscsi])).ok).toBe(true);
    expect(recorderSignal(rec([])).ok).toBe(false);
    expect(recorderSignal(rec([{ ...iscsi, healthy: false }])).ok).toBe(false);
    const failing = recorderSignal(
      rec([iscsi], [{ code: 'RecordFailure', action: 'Start', index: 0, at: T0 }]),
    );
    expect(failing).toEqual({ ok: false, why: 'it reports a record failure' });
    // A camera's video loss isn't a recording failure.
    expect(
      recorderSignal(rec([iscsi], [{ code: 'VideoLoss', action: 'Start', index: 3, at: T0 }])).ok,
    ).toBe(true);
  });

  it('signal 2: each iSCSI disk it has had, present and healthy', () => {
    expect(diskSignal(rec([local]), [])).toMatchObject({ ok: null, iscsi: [] });
    expect(diskSignal(rec([local, iscsi]), [])).toMatchObject({ ok: true, iscsi: ['/dev/iscsi0'] });
    // Gone from the list after it was seen: lost, not "never had".
    expect(diskSignal(rec([local]), ['/dev/iscsi0'])).toMatchObject({
      ok: false,
      why: 'its iSCSI disk /dev/iscsi0 is gone',
    });
    expect(
      diskSignal(rec([local, { ...iscsi, healthy: false, state: 'Error' }]), []),
    ).toMatchObject({ ok: false, why: 'its iSCSI disk /dev/iscsi0 is Error' });
  });

  it('signal 3: well under its usual band fails; learning or unmeasured is unknown', () => {
    const usual = { low: 5.5e6, median: 6.2e6 };
    expect(rateSignal(6.1e6, usual).ok).toBe(true);
    // Below the band but not under half the median: a quiet hour, not a stop.
    expect(rateSignal(5e6, usual).ok).toBe(true);
    expect(rateSignal(15e3, usual).ok).toBe(false);
    expect(rateSignal(null, usual).ok).toBe(null);
    expect(rateSignal(0, null).ok).toBe(null);
    expect(rateSignal(0, { ...usual, learning: true }).ok).toBe(null);
  });

  it('every combination: not recording only after one fails for 5 minutes, naming it', () => {
    const fails = { ok: false, why: 'x' } as const;
    const ok = { ok: true, why: 'fine' } as const;
    for (let mask = 0; mask < 8; mask++) {
      const now = Object.fromEntries(
        SIGNALS.map((k, i) => [k, mask & (1 << i) ? fails : ok]),
      ) as Record<SignalKey, { ok: boolean; why: string }>;
      const failing = SIGNALS.filter((_, i) => mask & (1 << i));
      let s = stepRecording(null, now, T0);
      expect(s.recording).toBe(true); // nothing has failed for 5 minutes yet
      s = stepRecording(s, now, T0 + 4 * MIN);
      expect(s.recording).toBe(true);
      s = stepRecording(s, now, T0 + NOT_RECORDING_MS);
      expect(s.recording).toBe(!failing.length);
      expect(s.failed).toEqual(failing);
      if (failing.length) expect(s.since).toBe(T0 + NOT_RECORDING_MS);
    }
  });

  it('a signal back to ok resets its clock; unknown signals never fail', () => {
    const fail = { ok: false, why: 'lost' } as const;
    const ok = { ok: true, why: 'ok' } as const;
    const unknown = { ok: null, why: 'learning' } as const;
    let s = stepRecording(null, { recorder: ok, disk: fail, rate: unknown }, T0);
    s = stepRecording(s, { recorder: ok, disk: ok, rate: unknown }, T0 + 3 * MIN);
    s = stepRecording(s, { recorder: ok, disk: fail, rate: unknown }, T0 + 4 * MIN);
    s = stepRecording(s, { recorder: ok, disk: fail, rate: unknown }, T0 + 8 * MIN);
    expect(s.recording).toBe(true);
    s = stepRecording(s, { recorder: ok, disk: fail, rate: unknown }, T0 + 9 * MIN);
    expect(s).toMatchObject({ recording: false, failed: ['disk'], since: T0 + 9 * MIN });
    // Once not recording, "since" stays while it lasts.
    s = stepRecording(s, { recorder: fail, disk: fail, rate: unknown }, T0 + 20 * MIN);
    expect(s.since).toBe(T0 + 9 * MIN);
    expect(
      stepRecording(null, { recorder: unknown, disk: unknown, rate: unknown }, T0).recording,
    ).toBe(null);
  });
});

describe('days of recording left', () => {
  it('is free space over the write rate, on its iSCSI disks', () => {
    // 6 TB free at 6 MB/s: about 11.6 days.
    expect(daysLeft([local, iscsi], 6e6).days).toBeCloseTo((6 * TB) / 6e6 / 86400, 5);
    expect(daysLeft([local], 2e6).days).toBeCloseTo((0.6 * TB) / 2e6 / 86400, 5);
    expect(daysLeft([iscsi], 0).days).toBe(null);
    expect(daysLeft([iscsi], null).days).toBe(null);
    expect(daysLeft([], 1e6)).toMatchObject({ days: null, total: 0 });
  });
  it('a full disk overwrites its oldest footage: no countdown', () => {
    expect(daysLeft([{ ...iscsi, used: iscsi.total * 0.995 }], 6e6)).toMatchObject({
      days: null,
      full: true,
    });
  });
});

describe('matching a recorder to its NAS and LUN', () => {
  const nas = (id: string, luns: string[], targets: string[] = []) => ({
    id,
    name: id,
    luns: luns.map((name) => ({ name })),
    targets: targets.map((name) => ({ name, connected: true })),
  });
  it('by a LUN or target named after the recorder, else the only NAS with iSCSI', () => {
    expect(matchSession(['nvr-1'], [nas('a', ['nvr-1-rec', 'nvr-2-rec'], ['iqn.nvr-1'])])).toEqual({
      nasId: 'a',
      lun: 'nvr-1-rec',
      target: 'iqn.nvr-1',
    });
    expect(matchSession(['nvr-2'], [nas('a', ['x']), nas('b', ['nvr-2-rec'])])).toMatchObject({
      nasId: 'b',
      lun: 'nvr-2-rec',
    });
    expect(matchSession(['cam-box'], [nas('a', ['video'])])).toEqual({
      nasId: 'a',
      lun: '',
      target: '',
    });
    expect(matchSession(['cam-box'], [nas('a', ['video']), nas('b', ['other'])])).toBe(null);
  });
});

describe('Wi-Fi', () => {
  it('reads CAPsMAN states', () => {
    expect(apStatus('running')).toBe('ok');
    expect(apStatus('Ok')).toBe('ok');
    expect(apStatus('disconnected')).toBe('disconnected');
    expect(apStatus('provisioning failed')).toBe('provisioning');
  });
  it('finds 2.4 GHz channels 1–4 apart on one controller', () => {
    expect(
      channel24({ interface: 'w1', band: '2ghz-ax', channel: 6, clients: 0, running: true }),
    ).toBe(6);
    expect(channel24({ interface: 'w1', frequencyMhz: 2422, clients: 0, running: true })).toBe(3);
    expect(
      channel24({ interface: 'w1', band: '5ghz-ac', channel: 36, clients: 0, running: true }),
    ).toBe(null);
    const ap = (name: string, ch: number, parent = 'c') => ({
      id: name,
      name,
      parent,
      radios: [{ interface: 'w', band: '2ghz-n', channel: ch, clients: 0, running: true }],
    });
    expect(overlaps([ap('a', 1), ap('b', 6), ap('c', 11)])).toEqual([]);
    expect(overlaps([ap('a', 1), ap('b', 3)]).map((o) => [o.a.name, o.b.name])).toEqual([
      ['a', 'b'],
    ]);
    expect(overlaps([ap('a', 1), ap('b', 3, 'other')])).toEqual([]);
    // The same channel shares the air; it doesn't overlap.
    expect(overlaps([ap('a', 6), ap('b', 6)])).toEqual([]);
  });
  it("keeps each camera's since and gives its transitions", () => {
    const a = camerasNow(undefined, [{ channel: 0, name: 'cam-1', online: true }], T0);
    const b = camerasNow(a.cameras, [{ channel: 0, name: 'cam-1', online: false }], T0 + MIN);
    expect(b.went).toEqual([
      {
        cam: expect.objectContaining({ channel: 0, online: false, since: T0 + MIN }),
        online: false,
      },
    ]);
    const c = camerasNow(b.cameras, [{ channel: 0, online: false }], T0 + 2 * MIN);
    expect(c).toMatchObject({ went: [], cameras: [{ name: 'cam-1', since: T0 + MIN }] });
  });
});

describe('storage words', () => {
  it('SMART, volume and UPS states', () => {
    expect(['good', 'GOOD', 'warning', 'abnormal', 'error', '--'].map(smartState)).toEqual([
      'good',
      'good',
      'warning',
      'bad',
      'bad',
      'unknown',
    ]);
    expect(['Ready', 'Degraded', 'Rebuilding', 'warning', 'not-ready'].map(volumeState)).toEqual([
      'ready',
      'degraded',
      'rebuilding',
      'degraded',
      'error',
    ]);
    expect(['online', 'on-battery', 'bypass', 'weird'].map(upsState)).toEqual([
      'online',
      'on-battery',
      'bypass',
      'unknown',
    ]);
  });
});

describe('the map: leaves and the iSCSI path', () => {
  const dev = (id: string, macs: string[], leaf = false, ports: string[] = []): DevRef => ({
    id,
    name: id,
    sysName: id,
    address: id,
    macs: new Set(macs),
    ports: ports.map((name) => ({ name, descr: name, alias: '' })),
    leaf,
  });
  it("links a NAS, a recorder and an AP to their access ports, not the uplinks they're seen through", () => {
    const devs = [
      dev('core', ['00:00:00:00:00:01'], false, ['Eth1/48']),
      dev('sw2', ['00:00:00:00:00:02'], false, ['Te1/1/1', 'Gi1/0/40', 'Gi1/0/44']),
      dev('nvr', ['3c:ef:8c:00:00:01'], true),
      dev('ap', ['48:a9:8a:10:00:01'], true),
      dev('nas', ['02:00:00:00:00:20'], true, ['lo', 'eth0']),
    ];
    const links = mergeLinks(
      devs,
      [
        {
          deviceId: 'core',
          localPort: 'Eth1/48',
          protocol: 'lldp',
          remoteName: 'sw2',
          remotePort: 'Te1/1/1',
        },
      ],
      [
        { deviceId: 'core', port: 'Eth1/48', mac: '3c:ef:8c:00:00:01' },
        { deviceId: 'core', port: 'Eth1/48', mac: '48:a9:8a:10:00:01' },
        { deviceId: 'core', port: 'Eth1/10', mac: '02:00:00:00:00:20' },
        { deviceId: 'sw2', port: 'Gi1/0/40', mac: '3c:ef:8c:00:00:01' },
        { deviceId: 'sw2', port: 'Gi1/0/44', mac: '48:a9:8a:10:00:01' },
        { deviceId: 'sw2', port: 'Te1/1/1', mac: '02:00:00:00:00:20' },
      ],
    );
    const ends = links.map((l) => [l.aDevice, l.aPort, l.bDevice, l.bPort].join(' '));
    expect(ends).toEqual(
      expect.arrayContaining([
        'ap lan sw2 Gi1/0/44',
        'nvr lan sw2 Gi1/0/40',
        'core Eth1/10 nas eth0',
        'core Eth1/48 sw2 Te1/1/1',
      ]),
    );
    const views = links.map((l, i) => ({
      id: `l${i}`,
      a: { deviceId: l.aDevice },
      b: { deviceId: l.bDevice },
    }));
    expect(pathBetween(views, 'nvr', 'nas')?.devices).toEqual(['nvr', 'sw2', 'core', 'nas']);
    expect(pathBetween(views, 'nvr', 'nowhere')).toBe(null);
  });
});

describe('the new alerts', () => {
  const band = { t: T0, median: 9, low: 2, high: 16, learning: false };
  const host = { baseline: { bands: async () => [band] }, sql: () => '' } as unknown as EeHost;
  const rules = new Map(kindRules(host).map((r) => [r.key, r]));
  const base = {
    failures: 0,
    uptime_s: 3600,
    error: null,
    polled_at: new Date(T0),
    status_since: new Date(T0 - 10 * MIN),
    recording: null,
    parent_id: null,
    status: 'ok',
  };
  const run = async (
    key: string,
    devices: object[],
    condition: object = {},
  ): Promise<Observation[]> =>
    rules.get(key)!.evaluator.evaluate({
      db: {} as never,
      rule: { id: 'r', condition, for_seconds: 0, org_id: 'o' },
      cluster: { id: 'c', name: 'office', kind: 'kubernetes' },
      now: T0,
      memo: async (_k, load) =>
        _k.startsWith('network:devices')
          ? (devices.map((d) => ({ ...base, ...d })) as never)
          : load(),
    });

  it('Wi-Fi: disconnected, no clients when it usually has them', async () => {
    expect(
      (
        await run('network.ap.disconnected', [
          { id: 'a', name: 'ap-lobby', kind: 'ap', status: 'disconnected', health: {} },
        ])
      )[0]?.details.title,
    ).toBe('ap-lobby is disconnected from CAPsMAN');
    const ap = {
      id: 'a',
      name: 'ap-lobby',
      kind: 'ap',
      parent_id: 'ctrl',
      health: { ap: { clients: 0 } },
    };
    expect((await run('network.ap.no_clients', [ap]))[0]?.details.why).toBe(
      'it usually has 9 at this time of the week',
    );
    expect(await run('network.ap.no_clients', [{ ...ap, health: { ap: { clients: 4 } } }])).toEqual(
      [],
    );
    expect(await run('network.ap.no_clients', [ap], { value: 10 })).toEqual([]);
    const r = (ch: number) => ({
      ap: { radios: [{ interface: 'w', band: '2ghz-n', channel: ch, clients: 3, running: true }] },
    });
    const overlap = await run('network.ap.channel_overlap', [
      { id: 'a', name: 'ap-lobby', kind: 'ap', parent_id: 'ctrl', health: r(1) },
      { id: 'b', name: 'ap-warehouse', kind: 'ap', parent_id: 'ctrl', health: r(3) },
    ]);
    expect(overlap[0]?.details).toMatchObject({
      title: 'ap-lobby and ap-warehouse overlap on 2.4 GHz',
    });
  });

  it('storage: SMART, hot disks, RAID, volumes and LUNs over 90%', async () => {
    const nas = (n: object) => [
      {
        id: 'n',
        name: 'nas-1',
        kind: 'nas',
        health: { nas: { disks: [], volumes: [], pools: [], luns: [], ...n } },
      },
    ];
    const disk = (smart: string, celsius = 40) => ({
      index: 1,
      name: 'Disk 1',
      smart,
      status: 'ready',
      celsius,
    });
    expect(await run('network.nas.disk_smart', nas({ disks: [disk('good')] }))).toEqual([]);
    expect(
      (await run('network.nas.disk_smart', nas({ disks: [disk('warning')] })))[0]?.severity,
    ).toBe('warning');
    expect(
      (await run('network.nas.disk_smart', nas({ disks: [disk('abnormal')] })))[0]?.severity,
    ).toBe('critical');
    expect(
      (await run('network.nas.disk_hot', nas({ disks: [disk('good', 57)] })))[0]?.severity,
    ).toBe('warning');
    expect(
      (await run('network.nas.disk_hot', nas({ disks: [disk('good', 61)] })))[0]?.severity,
    ).toBe('critical');
    expect(await run('network.nas.disk_hot', nas({ disks: [disk('good', 50)] }))).toEqual([]);
    const vol = (status: string, free = 5) => ({
      name: 'DataVol1',
      total: 100,
      free,
      status,
      raid: 'RAID 5',
    });
    expect((await run('network.nas.raid', nas({ volumes: [vol('Degraded')] })))[0]?.severity).toBe(
      'critical',
    );
    expect((await run('network.nas.raid', nas({ pools: [vol('Rebuilding')] })))[0]?.severity).toBe(
      'warning',
    );
    expect(await run('network.nas.raid', nas({ volumes: [vol('Ready')] }))).toEqual([]);
    const full = await run(
      'network.nas.volume_full',
      nas({
        volumes: [vol('Ready', 8)],
        luns: [{ name: 'nvr-1-rec', capacity: 1, usedPercent: 97, mapped: true }],
      }),
    );
    expect(full.map((o) => [o.details.title, o.severity])).toEqual([
      ['nas-1 · DataVol1 is 92% full', 'warning'],
      ['The LUN nvr-1-rec on nas-1 is 97% full', 'critical'],
    ]);
  });

  it('recording: not recording names the signal; iSCSI lost; full soon; cameras grouped', async () => {
    const state = stepRecording(
      stepRecording(
        null,
        {
          recorder: { ok: true, why: '' },
          disk: { ok: false, why: 'its iSCSI disk /dev/iscsi0 is gone' },
          rate: { ok: null, why: '' },
        },
        T0 - 6 * MIN,
      ),
      {
        recorder: { ok: true, why: '' },
        disk: { ok: false, why: 'its iSCSI disk /dev/iscsi0 is gone' },
        rate: { ok: null, why: '' },
      },
      T0,
    );
    const nvr = { id: 'r', name: 'nvr-1', kind: 'nvr', recording: state, health: {} };
    expect((await run('network.recorder.not_recording', [nvr]))[0]).toMatchObject({
      severity: 'critical',
      labels: { signal: 'disk' },
      details: { title: 'nvr-1 is not recording', why: 'its iSCSI disk /dev/iscsi0 is gone' },
    });
    expect((await run('network.recorder.iscsi_lost', [nvr]))[0]?.details.title).toBe(
      'nvr-1 lost its iSCSI disk',
    );
    // An unreachable recorder isn't judged.
    expect(
      await run('network.recorder.not_recording', [{ ...nvr, status: 'unreachable' }]),
    ).toEqual([]);
    const soon = (days: number) => [
      { id: 'r', name: 'nvr-1', kind: 'nvr', health: { recorder: { daysLeft: days } } },
    ];
    expect((await run('network.recorder.full_soon', soon(2.5)))[0]?.severity).toBe('warning');
    expect((await run('network.recorder.full_soon', soon(0.5)))[0]?.severity).toBe('critical');
    expect(await run('network.recorder.full_soon', soon(4))).toEqual([]);
    const cams = [
      { channel: 0, name: 'cam-1', online: false, since: T0 - 6 * MIN },
      { channel: 4, name: 'cam-5', online: false, since: T0 - 7 * MIN },
      { channel: 7, name: 'cam-8', online: false, since: T0 - 2 * MIN },
      { channel: 9, name: 'cam-10', online: true, since: T0 - 60 * MIN },
    ];
    const off = await run('network.recorder.camera_offline', [
      { id: 'r', name: 'nvr-1', kind: 'nvr', health: { recorder: { cameras: cams } } },
    ]);
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({
      details: {
        title: 'nvr-1: 2 cameras are offline',
        why: 'cam-1 (channel 1), cam-5 (channel 5)',
      },
      since: T0 - 7 * MIN,
    });
  });

  it('UPS: on battery, runtime, replace, overload', async () => {
    const ups = (u: object) => [
      {
        id: 'u',
        name: 'ups-1',
        kind: 'ups',
        health: { ups: { status: 'online', replaceBattery: false, ...u } },
      },
    ];
    expect(
      (
        await run(
          'network.ups.on_battery',
          ups({ status: 'on-battery', chargePercent: 81, runtimeS: 1500 }),
        )
      )[0]?.details,
    ).toMatchObject({ title: 'ups-1 is on battery', why: '81% charge · 25 min left' });
    expect(await run('network.ups.on_battery', ups({}))).toEqual([]);
    expect((await run('network.ups.runtime_low', ups({ runtimeS: 480 })))[0]?.details.title).toBe(
      'ups-1 has 8 min of battery',
    );
    expect(await run('network.ups.runtime_low', ups({ runtimeS: 900 }))).toEqual([]);
    expect(await run('network.ups.replace_battery', ups({ replaceBattery: true }))).toHaveLength(1);
    expect((await run('network.ups.overload', ups({ loadPercent: 95 })))[0]?.severity).toBe(
      'warning',
    );
    expect((await run('network.ups.overload', ups({ loadPercent: 104 })))[0]?.severity).toBe(
      'critical',
    );
  });

  it('every new rule waits under its device being unreachable, the session under the disk', () => {
    for (const r of kindRules(host)) {
      if (r.key.startsWith('network.ap.')) continue; // an AP isn't polled: its controller is
      if (r.key === 'network.iscsi.session_lost')
        expect(r.heldUnder).toBe('network.recorder.iscsi_lost');
      else expect(r.heldUnder, r.key).toBe('network.device.unreachable');
    }
  });
});
