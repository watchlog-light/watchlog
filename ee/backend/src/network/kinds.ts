// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The 0.17 device kinds in a poller's report (ADR-234): a CAPsMAN controller's access points,
// clients and mesh links; a NAS's disks, volumes, LUNs and iSCSI targets; a recorder's disks,
// cameras, events and its three recording signals; a UPS. Each adds to the device's `health`
// and gives its events, which ingest.ts records like a port's.
import type { EeHost } from '../../../../backend/src/ee-contract.js';
import { nameKey } from './links.js';
import { vendorOf } from './oui.js';
import {
  daysLeft,
  diskSignal,
  notRecordingWhy,
  rateSignal,
  rateText,
  recorderSignal,
  stepRecording,
  type RecordingState,
} from './recording.js';
import type { AP, NAS, Recorder, UPS, Wireless } from './report.js';

export interface KindRow {
  id: string;
  name: string;
  cluster_id: string;
  poller_host: string;
  health: Record<string, unknown>;
  recording: Partial<RecordingState> | null;
  feeds: { clusterId: string; node: string }[] | null;
  sys_name: string;
}

/** An event a kind gives: on the device's page, and in the Events of the places it concerns. */
export interface KindEvent {
  deviceId?: string;
  deviceName?: string;
  port?: string;
  reason: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  /** Also in the Events list of the servers and nodes the UPS feeds. */
  feeds?: boolean;
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
export const macOrNull = (m: string | undefined | null) => {
  const s = (m ?? '').toLowerCase();
  return MAC_RE.test(s) ? s : null;
};
const clip = (s: string | undefined | null, n: number) => (s ?? '').slice(0, n);

// ---------------------------------------------------------------- Wi-Fi (CAPsMAN)

/** An access point's status from its CAPsMAN state. */
export function apStatus(state: string): 'ok' | 'disconnected' | 'provisioning' {
  const s = state.toLowerCase();
  if (s === 'running' || s === 'ok' || s === 'run') return 'ok';
  if (s.includes('provision') || s.includes('fail')) return 'provisioning';
  return 'disconnected';
}

/**
 * The controller's access points as devices (free: managed_ap), its clients replaced, its mesh
 * links. Access points it no longer lists are disconnected.
 */
export async function applyWireless(
  host: EeHost,
  orgId: string,
  ctrl: KindRow,
  w: Wireless,
  nowMs: number,
): Promise<{ events: KindEvent[]; summary: Record<string, unknown> }> {
  const db = host.systemDb;
  const now = new Date(nowMs);
  const events: KindEvent[] = [];
  const existing: { id: string; name: string; status: string; address: string }[] = await db
    .selectFrom('network_devices')
    .select(['id', 'name', 'status', 'address'])
    .where('org_id', '=', orgId)
    .where('parent_id', '=', ctrl.id)
    .where('removed_at', 'is', null)
    .execute();
  const byName = new Map(existing.map((a) => [a.name, a]));
  const ids = new Map<string, string>();
  const aps = w.aps.slice(0, 1024);
  for (const ap of aps) {
    const name = clip(ap.name, 253) || clip(ap.mac, 64);
    if (!name) continue;
    const status = apStatus(ap.state);
    const health = {
      ap: {
        generation: ap.generation,
        state: ap.state,
        radios: (ap.radios ?? []).slice(0, 16),
        clients: (ap.radios ?? []).reduce((s, r) => s + (r.clients ?? 0), 0),
      },
    };
    const fields = {
      model: clip(ap.model, 128),
      serial: clip(ap.serial, 128),
      firmware: clip(ap.version, 128),
      vendor: 'MikroTik',
      mac: macOrNull(ap.mac),
      uptime_s: ap.uptimeS ?? null,
      health: JSON.stringify(health),
      polled_at: now,
      updated_at: now,
      ...(status === 'ok' ? { last_seen: now } : {}),
    };
    const old = byName.get(name);
    if (old) {
      await db
        .updateTable('network_devices')
        .set({
          ...fields,
          status,
          ...(old.status !== status ? { status_since: now } : {}),
          ...(ap.address &&
          old.address !== ap.address &&
          !(await addressTaken(host, orgId, ap.address))
            ? { address: ap.address }
            : {}),
        })
        .where('id', '=', old.id)
        .execute();
      ids.set(name, old.id);
      if (old.status !== status) events.push(apEvent(old.id, name, ctrl.name, status, ap));
    } else {
      const id = host.newId();
      const address =
        ap.address && !(await addressTaken(host, orgId, ap.address))
          ? ap.address
          : `${name}@${ctrl.name}`.slice(0, 253);
      await db
        .insertInto('network_devices')
        .values({
          id,
          org_id: orgId,
          cluster_id: ctrl.cluster_id,
          poller_host: ctrl.poller_host,
          parent_id: ctrl.id,
          name,
          address,
          protocol: 'capsman',
          kind: 'ap',
          managed_ap: true,
          status,
          status_since: now,
          ...fields,
        })
        .execute();
      ids.set(name, id);
    }
  }
  // Listed no more: disconnected (the new CAPsMAN drops a remote CAP's row when it goes).
  for (const a of existing) {
    if (ids.has(a.name) || a.status === 'disconnected') continue;
    await db
      .updateTable('network_devices')
      .set({ status: 'disconnected', status_since: now, updated_at: now })
      .where('id', '=', a.id)
      .execute();
    events.push(apEvent(a.id, a.name, ctrl.name, 'disconnected'));
  }
  for (const a of existing) if (!ids.has(a.name)) ids.set(a.name, a.id);

  // Clients: the registration tables now, replacing the last round's.
  const clients = w.clients.slice(0, 8192).filter((c) => macOrNull(c.mac));
  await db.transaction().execute(async (trx: EeHost['systemDb']) => {
    let del = trx
      .deleteFrom('network_wifi_clients')
      .where('org_id', '=', orgId)
      .where('controller_id', '=', ctrl.id);
    if (clients.length)
      del = del.where(
        host.sql<boolean>`mac <> all(${clients.map((c) => macOrNull(c.mac)!)}::macaddr[])`,
      );
    await del.execute();
    for (const c of clients) {
      const v = {
        org_id: orgId,
        mac: macOrNull(c.mac)!,
        controller_id: ctrl.id,
        ap_id: ids.get(c.ap) ?? null,
        ap: clip(c.ap, 253),
        interface: clip(c.interface, 128),
        ssid: clip(c.ssid, 64),
        band: clip(c.band, 32),
        vendor: vendorOf(macOrNull(c.mac)!),
        signal_dbm: c.signalDbm ?? null,
        tx_rate: clip(c.txRate, 64),
        rx_rate: clip(c.rxRate, 64),
        uptime_s: c.uptimeS ?? null,
        bytes_tx: c.bytesTx ?? 0,
        bytes_rx: c.bytesRx ?? 0,
        seen_at: now,
      };
      await trx
        .insertInto('network_wifi_clients')
        .values(v)
        .onConflict((oc: any) =>
          oc.columns(['org_id', 'mac']).doUpdateSet({ ...v, org_id: undefined, mac: undefined }),
        )
        .execute();
    }
  });

  // Mesh: the wireless backhaul between this controller's access points.
  const apIds = [...ids.values()];
  if (apIds.length) {
    const keep: string[] = [];
    for (const m of (w.mesh ?? []).slice(0, 256)) {
      const from = ids.get(m.from);
      const to = ids.get(m.to);
      if (!from || !to || from === to) continue;
      keep.push(`${from}/${to}`);
      const v = {
        org_id: orgId,
        from_id: from,
        to_id: to,
        signal_dbm: m.signalDbm ?? null,
        rate: clip(m.rate, 64),
        seen_at: now,
      };
      await db
        .insertInto('network_mesh_links')
        .values(v)
        .onConflict((oc: any) =>
          oc
            .columns(['from_id', 'to_id'])
            .doUpdateSet({ signal_dbm: v.signal_dbm, rate: v.rate, seen_at: now }),
        )
        .execute();
    }
    let del = db.deleteFrom('network_mesh_links').where('from_id', 'in', apIds);
    if (keep.length)
      del = del.where(
        host.sql<boolean>`(from_id::text || '/' || to_id::text) <> all(${keep}::text[])`,
      );
    await del.execute();
  }
  const weak = clients.filter((c) => c.signalDbm != null && c.signalDbm < WEAK_DBM).length;
  return {
    events,
    summary: {
      generations: w.generations,
      aps: aps.length,
      apsUp: aps.filter((a) => apStatus(a.state) === 'ok').length,
      clients: clients.length,
      weak,
    },
  };
}

/** A client below this signal is weak (the Wireless page's tile, the alert). */
export const WEAK_DBM = -75;

async function addressTaken(host: EeHost, orgId: string, address: string): Promise<boolean> {
  const r = await host.systemDb
    .selectFrom('network_devices')
    .select('id')
    .where('org_id', '=', orgId)
    .where('address', '=', address)
    .where('removed_at', 'is', null)
    .executeTakeFirst();
  return !!r;
}

function apEvent(id: string, name: string, ctrl: string, status: string, ap?: AP): KindEvent {
  if (status === 'ok')
    return {
      deviceId: id,
      deviceName: name,
      reason: 'APConnected',
      severity: 'info',
      message: `${name} connected to CAPsMAN on ${ctrl}.`,
    };
  if (status === 'provisioning')
    return {
      deviceId: id,
      deviceName: name,
      reason: 'APProvisioningFailed',
      severity: 'warning',
      message: `${name}'s provisioning by CAPsMAN on ${ctrl} failed${ap?.state ? ` (${ap.state})` : ''}.`,
    };
  return {
    deviceId: id,
    deviceName: name,
    reason: 'APDisconnected',
    severity: 'warning',
    message: `${name} disconnected from CAPsMAN on ${ctrl}.`,
  };
}

// ---------------------------------------------------------------- NAS

const lower = (s: string | undefined) => (s ?? '').toLowerCase();
/** A volume, pool or RAID group status: ready, degraded, rebuilding, or another word. */
export function volumeState(
  status: string,
): 'ready' | 'degraded' | 'rebuilding' | 'error' | 'other' {
  const s = lower(status);
  if (s.includes('rebuild') || s.includes('resync') || s.includes('sync')) return 'rebuilding';
  if (s.includes('degrad') || s === 'warning') return 'degraded';
  if (s.includes('error') || s.includes('fail') || s === 'not-ready' || s.includes('crash'))
    return 'error';
  if (s === 'ready' || s === 'ok' || s === 'good' || s === 'normal' || s === 'unknown' || !s)
    return 'ready';
  return 'other';
}

/** A disk's SMART in WatchLog's words: good, warning, bad, or unknown. */
export function smartState(smart: string): 'good' | 'warning' | 'bad' | 'unknown' {
  const s = lower(smart);
  if (s === 'good' || s === 'ok' || s === 'normal') return 'good';
  if (s === 'warning') return 'warning';
  if (s === 'error' || s === 'abnormal' || s === 'bad' || s.includes('fail')) return 'bad';
  return 'unknown';
}

export function applyNAS(
  row: KindRow,
  nas: NAS,
): { events: KindEvent[]; health: Record<string, unknown> } {
  const prev = (row.health.nas ?? {}) as Partial<NAS>;
  const events: KindEvent[] = [];
  const prevDisk = new Map((prev.disks ?? []).map((d) => [d.index, d]));
  for (const d of nas.disks ?? []) {
    const was = prevDisk.get(d.index);
    if (
      was &&
      smartState(was.smart) !== smartState(d.smart) &&
      smartState(d.smart) !== 'good' &&
      smartState(d.smart) !== 'unknown'
    )
      events.push({
        reason: 'DiskSMART',
        severity: smartState(d.smart) === 'bad' ? 'critical' : 'warning',
        message: `${row.name}'s disk ${d.name || d.index} reports SMART ${d.smart}.`,
      });
  }
  const prevVol = new Map([...(prev.volumes ?? []), ...(prev.pools ?? [])].map((v) => [v.name, v]));
  for (const v of [...(nas.volumes ?? []), ...(nas.pools ?? [])]) {
    const was = prevVol.get(v.name);
    if (!was || volumeState(was.status) === volumeState(v.status)) continue;
    const st = volumeState(v.status);
    events.push({
      reason: st === 'ready' ? 'VolumeReady' : 'VolumeDegraded',
      severity: st === 'ready' ? 'info' : st === 'rebuilding' ? 'warning' : 'critical',
      message:
        st === 'ready'
          ? `${row.name} · ${v.name} is ready again.`
          : `${row.name} · ${v.name} is ${lower(v.status)}.`,
    });
  }
  const prevTarget = new Map((prev.targets ?? []).map((t) => [t.name, t]));
  for (const t of nas.targets ?? []) {
    const was = prevTarget.get(t.name);
    if (was && was.connected !== t.connected)
      events.push({
        reason: t.connected ? 'ISCSIConnected' : 'ISCSIDisconnected',
        severity: t.connected ? 'info' : 'warning',
        message: t.connected
          ? `The iSCSI target ${t.name} on ${row.name} has a session again.`
          : `The iSCSI target ${t.name} on ${row.name} lost its session.`,
      });
  }
  return {
    events,
    health: {
      nas: {
        disks: (nas.disks ?? []).slice(0, 64),
        volumes: (nas.volumes ?? []).slice(0, 64),
        pools: (nas.pools ?? []).slice(0, 32),
        luns: (nas.luns ?? []).slice(0, 256),
        targets: (nas.targets ?? []).slice(0, 256),
      },
    },
  };
}

// ---------------------------------------------------------------- UPS

export function upsState(status: string): 'online' | 'on-battery' | 'bypass' | 'off' | 'unknown' {
  const s = lower(status);
  if (s === 'online' || s === 'on-battery' || s === 'bypass' || s === 'off') return s;
  return 'unknown';
}

export function applyUPS(
  row: KindRow,
  ups: UPS,
): { events: KindEvent[]; health: Record<string, unknown> } {
  const prev = (row.health.ups ?? null) as UPS | null;
  const events: KindEvent[] = [];
  const now = upsState(ups.status);
  if (prev && upsState(prev.status) !== now) {
    if (now === 'on-battery')
      events.push({
        reason: 'UPSOnBattery',
        severity: 'critical',
        feeds: true,
        message: `${row.name} is on battery${ups.runtimeS != null ? `, ${Math.round(ups.runtimeS / 60)} min left` : ''}${ups.chargePercent != null ? ` (${Math.round(ups.chargePercent)}% charge)` : ''}.`,
      });
    else if (upsState(prev.status) === 'on-battery')
      events.push({
        reason: 'UPSOnline',
        severity: 'info',
        feeds: true,
        message: `${row.name} is back on mains power${now === 'bypass' ? ' (bypass)' : ''}.`,
      });
    else if (now === 'bypass' || now === 'off')
      events.push({
        reason: 'UPSBypass',
        severity: 'warning',
        feeds: true,
        message: `${row.name} is ${now === 'off' ? 'off' : 'on bypass'}: its load isn't protected.`,
      });
  }
  if (prev && !prev.replaceBattery && ups.replaceBattery)
    events.push({
      reason: 'UPSReplaceBattery',
      severity: 'warning',
      message: `${row.name}'s battery needs replacing.`,
    });
  return { events, health: { ups } };
}

// ---------------------------------------------------------------- Recorders

/** The rate a recorder writes toward its NAS now and its usual band (ADR-234, signal 3). */
export interface RateReading {
  rate: number | null;
  usual: { low: number; high: number; median: number; learning: boolean } | null;
  from: { device: string; port: string; side: 'recorder' | 'nas' } | null;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Its switch port's traffic in (what the recorder sends: its writes to the NAS, most of it), or
 * when its port isn't known, the NAS's switch port out. The band is the hour's usual.
 */
export async function recorderRate(
  host: EeHost,
  orgId: string,
  recorderId: string,
  nasId: string | null,
  nowMs: number,
): Promise<RateReading> {
  const none: RateReading = { rate: null, usual: null, from: null };
  if (!host.victoria) return none;
  const port =
    (await attachedPort(host, orgId, recorderId)) ??
    (nasId ? await attachedPort(host, orgId, nasId) : null);
  if (!port) return none;
  const side = port.leaf === recorderId ? 'recorder' : 'nas';
  const metric =
    side === 'recorder' ? 'watchlog_net_if_in_bytes_total' : 'watchlog_net_if_out_bytes_total';
  const expr = `sum(rate(${metric}{device="${esc(port.device)}",ifname="${esc(port.port)}"}[5m]))`;
  const from = { device: port.deviceName, port: port.port, side } as const;
  try {
    const [now] = await host.victoria.query(orgId, [port.cluster], expr, Math.floor(nowMs / 1000));
    const rate = now?.points[0]?.[1] ?? null;
    const [band] = await host.baseline.bands(
      orgId,
      [port.cluster],
      expr,
      nowMs,
      nowMs,
      'bytes_per_second',
    );
    return {
      rate,
      usual: band
        ? { low: band.low, high: band.high, median: band.median, learning: band.learning }
        : null,
      from,
    };
  } catch (err) {
    host.log.warn({ err: (err as Error).message }, 'network: reading a recorder write rate failed');
    return { ...none, from };
  }
}

/** The switch port a leaf device (a recorder, a NAS) is behind: the other end of its link. */
async function attachedPort(host: EeHost, orgId: string, leaf: string) {
  const l = await host.systemDb
    .selectFrom('network_links as l')
    .innerJoin('network_devices as d', (j: any) =>
      j.on(
        host.sql<boolean>`d.id = case when l.a_device = ${leaf}::uuid then l.b_device else l.a_device end`,
      ),
    )
    .select([
      'd.id as device',
      'd.name as name',
      'd.cluster_id as cluster',
      host.sql<string>`case when l.a_device = ${leaf}::uuid then l.b_port else l.a_port end`.as(
        'port',
      ),
    ])
    .where('l.org_id', '=', orgId)
    .where((eb: any) => eb.or([eb('l.a_device', '=', leaf), eb('l.b_device', '=', leaf)]))
    .where('d.kind', 'not in', ['nvr', 'nas', 'ups', 'ap'])
    .executeTakeFirst();
  return l
    ? {
        device: l.device as string,
        deviceName: l.name as string,
        cluster: l.cluster as string,
        port: l.port as string,
        leaf,
      }
    : null;
}

/** A camera with since when it is in its state (ms). */
export interface CameraState {
  channel: number;
  name: string;
  online: boolean;
  since: number;
}

/** The recorder's cameras with since when each is online or offline, and their transitions. */
export function camerasNow(
  prev: CameraState[] | undefined,
  cams: Recorder['cameras'],
  nowMs: number,
): { cameras: CameraState[]; went: { cam: CameraState; online: boolean }[] } {
  const before = new Map((prev ?? []).map((c) => [c.channel, c]));
  const went: { cam: CameraState; online: boolean }[] = [];
  const cameras = (cams ?? []).slice(0, 512).map((c) => {
    const b = before.get(c.channel);
    const cam = {
      channel: c.channel,
      name: clip(c.name, 128) || b?.name || `Channel ${c.channel + 1}`,
      online: c.online,
      since: b && b.online === c.online ? b.since : nowMs,
    };
    if (b && b.online !== c.online) went.push({ cam, online: c.online });
    return cam;
  });
  return { cameras, went };
}

export async function applyRecorder(
  host: EeHost,
  orgId: string,
  row: KindRow,
  rec: Recorder,
  nowMs: number,
): Promise<{ events: KindEvent[]; health: Record<string, unknown>; recording: RecordingState }> {
  const prevRec = (row.health.recorder ?? {}) as {
    cameras?: CameraState[];
    disks?: Recorder['disks'];
  };
  const events: KindEvent[] = [];
  const disks = rec.disks ?? prevRec.disks ?? null;
  // Cameras: their own alert, not "not recording" (ADR-234).
  const cams = rec.cameras
    ? camerasNow(prevRec.cameras, rec.cameras, nowMs)
    : { cameras: prevRec.cameras ?? [], went: [] };
  for (const w of cams.went)
    events.push({
      reason: w.online ? 'CameraOnline' : 'CameraOffline',
      severity: w.online ? 'info' : 'warning',
      message: `${row.name}: camera ${w.cam.name} (channel ${w.cam.channel + 1}) ${w.online ? 'is back online' : 'went offline'}.`,
    });
  for (const e of (rec.events ?? []).slice(0, 64)) {
    const words = RECORDER_EVENT[e.code];
    if (!words || e.action === 'Stop') continue;
    events.push({
      reason: `Recorder${e.code}`,
      severity: words[1],
      message: `${row.name} ${words[0]}${e.index >= 0 ? ` (#${e.index + 1})` : ''}.`,
    });
  }
  const prev = row.recording ?? null;
  const sigRecorder = rec.disks
    ? recorderSignal({ ...rec, disks: rec.disks })
    : { ok: null, why: "its disks couldn't be read" };
  const sigDisk = rec.disks
    ? diskSignal({ ...rec, disks: rec.disks }, prev?.iscsi ?? [])
    : { ok: null, why: "its disks couldn't be read", iscsi: prev?.iscsi ?? [] };
  const nas = await sessionNAS(host, orgId, row);
  const r = await recorderRate(host, orgId, row.id, nas, nowMs);
  const sigRate = rateSignal(r.rate, r.usual);
  const state = stepRecording(
    prev,
    { recorder: sigRecorder, disk: { ok: sigDisk.ok, why: sigDisk.why }, rate: sigRate },
    nowMs,
    {
      iscsi: sigDisk.iscsi,
      rate: r.rate,
      usual:
        r.usual && !r.usual.learning
          ? { low: r.usual.low, high: r.usual.high, median: r.usual.median }
          : null,
      rateFrom: r.from,
    },
  );
  if (state.recording === false && prev?.recording !== false)
    events.push({
      reason: 'NotRecording',
      severity: 'critical',
      message: `${row.name} is not recording: ${notRecordingWhy(state)}.`,
    });
  if (state.recording === true && prev?.recording === false)
    events.push({
      reason: 'RecordingAgain',
      severity: 'info',
      message: `${row.name} is recording again.`,
    });
  if (disks) await syncSessions(host, orgId, row, disks, state.iscsi, nowMs, events);
  const left = disks ? daysLeft(disks, r.rate) : null;
  return {
    events,
    recording: state,
    health: {
      recorder: {
        disks: disks ?? [],
        cameras: cams.cameras,
        active: (rec.active ?? []).slice(0, 64),
        stream: rec.stream,
        daysLeft: left?.days ?? null,
        full: left?.full ?? false,
        free: left?.free ?? null,
        total: left?.total ?? null,
      },
    },
  };
}

const RECORDER_EVENT: Record<string, [string, 'info' | 'warning' | 'critical']> = {
  StorageFailure: ['reports a storage failure', 'critical'],
  StorageNotExist: ['reports a disk missing', 'critical'],
  StorageLowSpace: ['reports its storage nearly full', 'warning'],
  RecordFailure: ['reports a record failure', 'critical'],
  NetAbort: ['reports its network disconnected', 'warning'],
};

/** The NAS a recorder's iSCSI sessions go to, as last matched. */
async function sessionNAS(host: EeHost, orgId: string, row: KindRow): Promise<string | null> {
  const s = await host.systemDb
    .selectFrom('network_iscsi_sessions')
    .select('nas_id')
    .where('org_id', '=', orgId)
    .where('recorder_id', '=', row.id)
    .where('nas_id', 'is not', null)
    .executeTakeFirst();
  return (s?.nas_id as string | undefined) ?? null;
}

interface NasRef {
  id: string;
  name: string;
  luns: { name: string }[];
  targets: { name: string; iqn?: string; connected: boolean }[];
}

/**
 * Which NAS and LUN a recorder's iSCSI disk is (QTS has no session table over SNMP, ADR-234):
 * a LUN or target named after the recorder, else the only NAS with iSCSI targets.
 */
export function matchSession(
  names: string[],
  nases: NasRef[],
): { nasId: string; lun: string; target: string } | null {
  const keys = names.map(nameKey).filter((k) => k.length >= 2);
  const has = (s: string | undefined) => {
    const v = (s ?? '').toLowerCase();
    return keys.some((k) => v.includes(k));
  };
  for (const n of nases) {
    const t = n.targets.find((t) => has(t.name) || has(t.iqn));
    const l = n.luns.find((l) => has(l.name));
    if (t || l) return { nasId: n.id, lun: l?.name ?? '', target: t?.name ?? '' };
  }
  const withTargets = nases.filter((n) => n.targets.length || n.luns.length);
  return withTargets.length === 1 ? { nasId: withTargets[0]!.id, lun: '', target: '' } : null;
}

async function syncSessions(
  host: EeHost,
  orgId: string,
  row: KindRow,
  disks: Recorder['disks'] & object,
  iscsi: string[],
  nowMs: number,
  events: KindEvent[],
): Promise<void> {
  if (!iscsi.length) return;
  const db = host.systemDb;
  const now = new Date(nowMs);
  const nasRows = await db
    .selectFrom('network_devices')
    .select(['id', 'name', 'health'])
    .where('org_id', '=', orgId)
    .where('kind', '=', 'nas')
    .where('removed_at', 'is', null)
    .execute();
  const nases: NasRef[] = nasRows.map((n: { id: string; name: string; health: { nas?: NAS } }) => ({
    id: n.id,
    name: n.name,
    luns: n.health.nas?.luns ?? [],
    targets: n.health.nas?.targets ?? [],
  }));
  const m = matchSession([row.name, row.sys_name].filter(Boolean), nases);
  const prev = new Map(
    (
      await db
        .selectFrom('network_iscsi_sessions')
        .select(['disk', 'connected', 'connected_since'])
        .where('recorder_id', '=', row.id)
        .execute()
    ).map((s: { disk: string; connected: boolean; connected_since: Date | null }) => [s.disk, s]),
  );
  const byName = new Map(disks.map((d) => [d.name, d]));
  const nasName = nases.find((n) => n.id === m?.nasId)?.name;
  for (const name of iscsi.slice(0, 32)) {
    const d = byName.get(name);
    const connected = !!d && d.healthy;
    const was = prev.get(name);
    const v = {
      org_id: orgId,
      recorder_id: row.id,
      disk: name.slice(0, 253),
      nas_id: m?.nasId ?? null,
      lun: m?.lun ?? '',
      target: m?.target ?? '',
      connected,
      connected_since: connected
        ? was?.connected && was.connected_since
          ? was.connected_since
          : now
        : null,
      ...(was && was.connected && !connected ? { lost_at: now } : {}),
      seen_at: now,
    };
    await db
      .insertInto('network_iscsi_sessions')
      .values(v)
      .onConflict((oc: any) =>
        oc
          .columns(['recorder_id', 'disk'])
          .doUpdateSet({ ...v, org_id: undefined, recorder_id: undefined, disk: undefined }),
      )
      .execute();
    if (was && was.connected !== connected) {
      const where = [m?.lun, nasName].filter(Boolean).join(' on ');
      events.push({
        reason: connected ? 'ISCSIDiskBack' : 'ISCSIDiskLost',
        severity: connected ? 'info' : 'critical',
        message: connected
          ? `${row.name}'s iSCSI disk ${name}${where ? ` (${where})` : ''} is back.`
          : `${row.name} lost its iSCSI disk ${name}${where ? ` (${where})` : ''}.`,
      });
    }
  }
}

export { rateText };
