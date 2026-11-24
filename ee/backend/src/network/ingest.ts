// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The poller's reports (POST /ingest/v1/network/report, ADR-233): each device's state,
// health and ports every round, and its inventory every 5 minutes. From them: the device's
// row, its ports, its events (on its page, and in the Events list of the servers and nodes
// behind the port), the certificate pinned on first contact, and, when an inventory came,
// the org's links and endpoints merged again.
import type { EeHost, FastifyInstance } from '../../../../backend/src/ee-contract.js';
import { FEATURE } from './collector.js';
import { mergeLinks, placeEndpoints, type DevRef, type MacIn, type NeighbourIn } from './links.js';
import { vendorOf } from './oui.js';
import {
  applyNAS,
  applyRecorder,
  applyUPS,
  applyWireless,
  macOrNull,
  type KindEvent,
  type KindRow,
} from './kinds.js';
import type { DeviceReport, Inventory, Report } from './report.js';

/** Errors that stop growing for this long have stopped ("errors started" can fire again). */
export const ERRORS_QUIET_MS = 10 * 60_000;
/** Kinds that hang off a switch port and read no MAC table: a NAS, a recorder, a UPS, an AP. */
const LEAF_KINDS = new Set(['nas', 'nvr', 'ups', 'ap']);
/** Endpoints not seen for a day are forgotten. */
export const ENDPOINT_KEPT_MS = 24 * 3600_000;
const MAX_REPORT_BYTES = 16 << 20;

export function speedText(mbps: number | null | undefined): string {
  if (!mbps) return '';
  if (mbps >= 1000) return `${Number((mbps / 1000).toFixed(1))} Gb/s`;
  return `${mbps} Mb/s`;
}

interface Owner {
  orgId: string;
  clusterId: string;
}

export function registerNetworkIngest(ingest: FastifyInstance, host: EeHost): void {
  ingest.post(
    '/network/report',
    {
      bodyLimit: MAX_REPORT_BYTES,
      schema: {
        summary: 'Network poller report (ADR-233)',
        tags: ['ingest'],
        hide: true,
        body: {
          type: 'object',
          required: ['host', 'devices'],
          properties: {
            host: { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9._-]*$' },
            devices: { type: 'array', maxItems: 2000 },
            discovery: { type: 'array', maxItems: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = (request as unknown as { ingestOwner: Owner }).ingestOwner;
      if (!(await host.hasFeature(owner.orgId, FEATURE))) {
        return reply
          .code(404)
          .type('application/problem+json')
          .send({ title: 'Not Found', status: 404 });
      }
      await applyReport(host, owner, request.body as Report, host.now());
      return reply.code(204).send();
    },
  );
}

interface DeviceRow extends KindRow {
  status: string;
  uptime_s: string | number | null;
  cert_pin: string | null;
  kind: string;
}

interface IfRow {
  name: string;
  oper_up: boolean;
  admin_up: boolean;
  speed_mbps: string | number | null;
  usual_speed_mbps: string | number | null;
  errors: number;
  errors_rising_since: Date | null;
  errors_last_rise: Date | null;
}

const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

/** Applies one report; returns whether links and endpoints were merged again. */
export async function applyReport(
  host: EeHost,
  owner: Owner,
  r: Report,
  nowMs: number,
): Promise<boolean> {
  const db = host.systemDb;
  const now = new Date(nowMs);
  const ids = r.devices.map((d) => d.id).filter((id) => /^[0-9a-f-]{36}$/.test(id));
  const rows: DeviceRow[] = ids.length
    ? await db
        .selectFrom('network_devices')
        .select([
          'id',
          'name',
          'status',
          'uptime_s',
          'cert_pin',
          'health',
          'kind',
          'cluster_id',
          'poller_host',
          'recording',
          'feeds',
          'sys_name',
        ])
        .where('org_id', '=', owner.orgId)
        .where('cluster_id', '=', owner.clusterId)
        .where('poller_host', '=', r.host)
        .where('removed_at', 'is', null)
        .where('id', 'in', ids)
        .execute()
    : [];
  const byId = new Map(rows.map((d) => [d.id, d]));
  let merged = false;
  let notify = false;
  for (const d of r.devices) {
    const row = byId.get(d.id);
    if (!row) continue; // not this poller's (moved, removed): ignored
    const res = await applyDevice(host, owner, row, d, now);
    merged ||= res.inventory;
    notify ||= res.pinned;
  }
  for (const disc of r.discovery ?? []) {
    await db
      .updateTable('network_discoveries')
      .set({ found: JSON.stringify(disc.found.slice(0, 512)), done: disc.done })
      .where('org_id', '=', owner.orgId)
      .where('cluster_id', '=', owner.clusterId)
      .where('id', '=', disc.id)
      .execute();
  }
  if (merged) await mergeOrg(host, owner.orgId, nowMs);
  if (notify) host.collector.notify(owner.clusterId);
  return merged;
}

/** The servers and nodes behind a device's ports (its endpoints matched to them). */
async function hostsBehind(host: EeHost, orgId: string, deviceId: string, port?: string) {
  let q = host.systemDb
    .selectFrom('network_endpoints')
    .select(['cluster_id', 'node', 'port'])
    .where('org_id', '=', orgId)
    .where('device_id', '=', deviceId)
    .where('node', 'is not', null);
  if (port !== undefined) q = q.where('port', '=', port);
  const rows = await q.execute();
  const seen = new Set<string>();
  return rows.filter((r: { cluster_id: string; node: string }) => {
    const k = `${r.cluster_id}/${r.node}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) as { cluster_id: string; node: string; port: string }[];
}

async function linkPorts(host: EeHost, orgId: string, deviceId: string): Promise<Set<string>> {
  const rows = await host.systemDb
    .selectFrom('network_links')
    .select(['a_device', 'a_port', 'b_device', 'b_port'])
    .where('org_id', '=', orgId)
    .where((eb: any) => eb.or([eb('a_device', '=', deviceId), eb('b_device', '=', deviceId)]))
    .execute();
  const out = new Set<string>();
  for (const l of rows) out.add(l.a_device === deviceId ? l.a_port : l.b_port);
  return out;
}

async function applyDevice(
  host: EeHost,
  owner: Owner,
  row: DeviceRow,
  d: DeviceReport,
  now: Date,
): Promise<{ inventory: boolean; pinned: boolean }> {
  const db = host.systemDb;
  const events: {
    port: string;
    reason: string;
    severity: string;
    message: string;
    hosts: 'port' | 'device';
  }[] = [];
  const set: Record<string, unknown> = {
    status: d.state,
    error: d.state === 'ok' ? null : (d.error ?? '').slice(0, 1024),
    failures: d.state === 'ok' ? 0 : (d.failures ?? 1),
    polled_at: new Date(d.polledAt || now.getTime()),
    updated_at: now,
  };
  if (d.profile) set.profile = d.profile;
  let pinned = false;
  if (d.fingerprint && !row.cert_pin && d.state === 'ok') {
    set.cert_pin = d.fingerprint; // trust on first use
    pinned = true;
  }
  if (d.state === 'cert_changed' && row.status !== 'cert_changed') {
    set.cert_seen = d.fingerprint ?? null;
    events.push({
      port: '',
      reason: 'CertificateChanged',
      severity: 'critical',
      message: `The certificate of ${row.name} changed since it was first seen; it isn't polled until an Owner accepts the new one.`,
      hosts: 'device',
    });
  }
  if (d.state === 'ok' && d.system) {
    const s = d.system;
    const prevUptime = num(row.uptime_s);
    // 0 is "not reported" (a recorder without a CGI uptime), never a fresh boot.
    if (prevUptime !== null && s.uptimeS > 0 && s.uptimeS < prevUptime && s.uptimeS < 3600) {
      events.push({
        port: '',
        reason: 'DeviceRebooted',
        severity: 'warning',
        message: `${row.name} rebooted (up ${Math.round(s.uptimeS / 60)} min).`,
        hosts: 'device',
      });
    }
    Object.assign(set, {
      last_seen: now,
      uptime_s: s.uptimeS > 0 ? s.uptimeS : null,
      ...(s.name ? { sys_name: s.name.slice(0, 253) } : {}),
      ...(s.descr ? { sys_descr: s.descr.slice(0, 1024) } : {}),
      ...(s.objectId ? { sys_object_id: s.objectId.slice(0, 128) } : {}),
      ...(s.location ? { location: s.location.slice(0, 253) } : {}),
      ...(s.vendor ? { vendor: s.vendor.slice(0, 64) } : {}),
      ...(s.model ? { model: s.model.slice(0, 128) } : {}),
      ...(s.serial ? { serial: s.serial.slice(0, 128) } : {}),
      ...(s.firmware ? { firmware: s.firmware.slice(0, 128) } : {}),
      ...(s.kind && row.kind === 'switch' ? { kind: s.kind } : {}),
      ...(macOrNull(s.mac) ? { mac: macOrNull(s.mac) } : {}),
    });
  }
  if (d.state === 'ok' && d.health) {
    const h = d.health;
    const prev = row.health as { stackExpected?: number; update?: unknown };
    set.health = JSON.stringify({
      cpu: h.cpu ?? null,
      memUsed: h.memUsed ?? null,
      memTotal: h.memTotal ?? null,
      temperature: h.temperature ?? null,
      sensors: (h.sensors ?? []).slice(0, 64),
      fans: (h.fans ?? []).slice(0, 32),
      psus: (h.psus ?? []).slice(0, 16),
      optics: (h.optics ?? []).slice(0, 128),
      stack: (h.stack ?? []).slice(0, 16),
      // The most members the stack had: one gone is "stack member lost".
      stackExpected: Math.max(prev.stackExpected ?? 0, (h.stack ?? []).length),
      update: d.system?.update ?? prev.update ?? null,
      portsUp: (h.ports ?? []).filter((p) => p.operUp).length,
      portsTotal: (h.ports ?? []).length,
    });
  }
  // 0.17's kinds (ADR-234): what each adds to the device's health, and its events.
  const kindEvents: KindEvent[] = [];
  const kindHealth: Record<string, unknown> = {};
  if (d.state === 'ok') {
    const nowMs = now.getTime();
    if (d.wireless) {
      const w = await applyWireless(host, owner.orgId, row, d.wireless, nowMs);
      kindEvents.push(...w.events);
      kindHealth.wireless = w.summary;
    }
    if (d.nas) {
      const n = applyNAS(row, d.nas);
      kindEvents.push(...n.events);
      Object.assign(kindHealth, n.health);
    }
    if (d.ups) {
      const u = applyUPS(row, d.ups);
      kindEvents.push(...u.events);
      Object.assign(kindHealth, u.health);
    }
    if (d.recorder) {
      const r = await applyRecorder(host, owner.orgId, row, d.recorder, nowMs);
      kindEvents.push(...r.events);
      Object.assign(kindHealth, r.health);
      set.recording = JSON.stringify(r.recording);
    }
  }
  if (Object.keys(kindHealth).length) {
    const base = typeof set.health === 'string' ? JSON.parse(set.health) : row.health;
    set.health = JSON.stringify({ ...base, ...kindHealth });
  }
  // Inventory first: the ports it lists, so the round's state lands on them.
  if (d.state === 'ok' && d.inventory)
    await storeInventory(host, owner.orgId, row.id, d.inventory, now);
  if (d.state === 'ok' && d.health?.ports?.length) {
    const ifs: IfRow[] = await db
      .selectFrom('network_interfaces')
      .select([
        'name',
        'oper_up',
        'admin_up',
        'speed_mbps',
        'usual_speed_mbps',
        'errors',
        'errors_rising_since',
        'errors_last_rise',
      ])
      .where('device_id', '=', row.id)
      .execute();
    const byName = new Map(ifs.map((i) => [i.name, i]));
    const uplinks = await linkPorts(host, owner.orgId, row.id);
    for (const p of d.health.ports) {
      const i = byName.get(p.name);
      if (!i) continue;
      const speed = p.speedMbps ?? null;
      const upd: Record<string, unknown> = {
        oper_up: p.operUp,
        admin_up: p.adminUp,
        updated_at: now,
      };
      if (i.oper_up !== p.operUp && p.adminUp) {
        upd.changed_at = now;
        events.push({
          port: p.name,
          reason: p.operUp ? 'PortUp' : 'PortDown',
          severity: p.operUp ? 'info' : uplinks.has(p.name) ? 'critical' : 'warning',
          message: `${row.name} · ${p.name} went ${p.operUp ? 'up' : 'down'}.`,
          hosts: 'port',
        });
      }
      if (p.operUp && speed) {
        const old = num(i.speed_mbps);
        if (i.oper_up && old && old !== speed) {
          events.push({
            port: p.name,
            reason: 'SpeedChanged',
            severity: speed < old ? 'warning' : 'info',
            message: `${row.name} · ${p.name} changed speed from ${speedText(old)} to ${speedText(speed)}.`,
            hosts: 'port',
          });
        }
        upd.speed_mbps = speed;
        upd.usual_speed_mbps = Math.max(num(i.usual_speed_mbps) ?? 0, speed);
      }
      const errors = p.errors ?? 0;
      // The first round after adding a device sets the baseline.
      if (errors > i.errors && row.status !== 'pending') {
        upd.errors_last_rise = now;
        if (!i.errors_rising_since) {
          upd.errors_rising_since = now;
          const uplink = uplinks.has(p.name);
          events.push({
            port: p.name,
            reason: uplink ? 'UplinkErrors' : 'ErrorsStarted',
            severity: 'warning',
            message: uplink
              ? `The uplink ${row.name} · ${p.name} is dropping packets.`
              : `Errors started on ${row.name} · ${p.name}.`,
            hosts: uplink ? 'device' : 'port',
          });
        }
      } else if (
        i.errors_rising_since &&
        i.errors_last_rise &&
        now.getTime() - i.errors_last_rise.getTime() > ERRORS_QUIET_MS
      ) {
        upd.errors_rising_since = null;
      }
      upd.errors = errors;
      await db
        .updateTable('network_interfaces')
        .set(upd)
        .where('device_id', '=', row.id)
        .where('name', '=', p.name)
        .execute();
    }
  }
  await db.updateTable('network_devices').set(set).where('id', '=', row.id).execute();
  for (const e of events) await recordEvents(host, owner.orgId, row, e, now);
  for (const e of kindEvents) await recordKindEvent(host, owner.orgId, row, e, now);
  return { inventory: d.state === 'ok' && !!d.inventory, pinned };
}

const PLACE_REASONS = new Set([
  'PortDown',
  'PortUp',
  'SpeedChanged',
  'ErrorsStarted',
  'UplinkErrors',
  'DeviceRebooted',
]);

/** One event: on the device's page, and in the Events list of each place behind it. */
async function recordEvents(
  host: EeHost,
  orgId: string,
  row: DeviceRow,
  e: { port: string; reason: string; severity: string; message: string; hosts: 'port' | 'device' },
  now: Date,
): Promise<void> {
  await host.systemDb
    .insertInto('network_events')
    .values({
      id: host.newId(),
      org_id: orgId,
      device_id: row.id,
      port: e.port,
      reason: e.reason,
      severity: e.severity,
      message: e.message,
      at: now,
    })
    .execute();
  if (!PLACE_REASONS.has(e.reason)) return;
  const behind = await hostsBehind(host, orgId, row.id, e.hosts === 'port' ? e.port : undefined);
  for (const b of behind) {
    const onPort = e.hosts === 'port';
    await host.events.record({
      orgId,
      clusterId: b.cluster_id,
      kind: onPort ? 'NetworkPort' : 'NetworkDevice',
      name: onPort
        ? `${row.name}/${e.port}`
        : e.reason === 'UplinkErrors'
          ? `${row.name}/${e.port}`
          : row.name,
      key: `net:${row.id}/${e.port}`,
      host: b.node,
      reason: e.reason,
      type: e.reason === 'PortUp' ? 'Normal' : 'Warning',
      message: onPort
        ? `${e.message} ${b.node} is behind it.`
        : `${e.message} ${b.node} is behind ${row.name} · ${b.port}.`,
      at: now.getTime(),
      source: 'watchlog-network',
    });
  }
}

/** Reasons of the 0.17 kinds that also go to a place's Events list (not cameras: noisy). */
const KIND_PLACE_REASONS = new Set([
  'NotRecording',
  'RecordingAgain',
  'ISCSIDiskLost',
  'ISCSIDiskBack',
  'ISCSIDisconnected',
  'ISCSIConnected',
  'VolumeDegraded',
  'VolumeReady',
  'DiskSMART',
  'UPSOnBattery',
  'UPSOnline',
  'UPSBypass',
  'APDisconnected',
  'APConnected',
  'APProvisioningFailed',
]);

/**
 * A 0.17 kind's event: on its device's page, and in a place's Events list: the servers and
 * nodes a UPS feeds, or else the place whose collector polls the device (ADR-234).
 */
async function recordKindEvent(
  host: EeHost,
  orgId: string,
  row: DeviceRow,
  e: KindEvent,
  now: Date,
): Promise<void> {
  const deviceId = e.deviceId ?? row.id;
  const name = e.deviceName ?? row.name;
  await host.systemDb
    .insertInto('network_events')
    .values({
      id: host.newId(),
      org_id: orgId,
      device_id: deviceId,
      port: e.port ?? '',
      reason: e.reason,
      severity: e.severity,
      message: e.message,
      at: now,
    })
    .execute();
  if (!KIND_PLACE_REASONS.has(e.reason)) return;
  const feeds = e.feeds ? (row.feeds ?? []) : [];
  const places = feeds.length
    ? feeds.map((f) => ({ clusterId: f.clusterId, host: f.node }))
    : [{ clusterId: row.cluster_id, host: '' }];
  for (const p of places) {
    await host.events.record({
      orgId,
      clusterId: p.clusterId,
      kind: 'NetworkDevice',
      name,
      key: `net:${deviceId}`,
      host: p.host,
      reason: e.reason,
      type: e.severity === 'info' ? 'Normal' : 'Warning',
      message: p.host && e.feeds ? `${e.message} It feeds ${p.host}.` : e.message,
      at: now.getTime(),
      source: 'watchlog-network',
    });
  }
}

/** Replaces a device's ports and keeps its tables for the merge. */
async function storeInventory(
  host: EeHost,
  orgId: string,
  deviceId: string,
  inv: Inventory,
  now: Date,
) {
  const db = host.systemDb;
  const ifs = inv.interfaces.slice(0, 2048);
  for (const i of ifs) {
    const v = {
      org_id: orgId,
      device_id: deviceId,
      if_index: i.index,
      name: i.name.slice(0, 128),
      descr: (i.descr ?? '').slice(0, 253),
      alias: (i.alias ?? '').slice(0, 253),
      kind: i.kind,
      mac: i.mac && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(i.mac) ? i.mac : null,
      speed_mbps: i.speedMbps || null,
      admin_up: i.adminUp,
      oper_up: i.operUp,
      vlans: (i.vlans ?? []).slice(0, 64),
      poe_watts: i.poeWatts ?? null,
      updated_at: now,
    };
    await db
      .insertInto('network_interfaces')
      .values(v)
      .onConflict((oc: any) =>
        oc.columns(['device_id', 'name']).doUpdateSet({
          if_index: v.if_index,
          descr: v.descr,
          alias: v.alias,
          kind: v.kind,
          mac: v.mac,
          vlans: v.vlans,
          poe_watts: v.poe_watts,
          updated_at: now,
        }),
      )
      .execute();
  }
  if (ifs.length) {
    await db
      .deleteFrom('network_interfaces')
      .where('device_id', '=', deviceId)
      .where(
        'name',
        'not in',
        ifs.map((i) => i.name.slice(0, 128)),
      )
      .execute();
  }
  await db
    .updateTable('network_devices')
    .set({
      inventory: JSON.stringify({
        neighbours: inv.neighbours.slice(0, 1024),
        macs: inv.macs.slice(0, 16384),
        arp: inv.arp.slice(0, 16384),
        ...(inv.routes != null ? { routes: inv.routes } : {}),
        ...(inv.gateway ? { gateway: inv.gateway } : {}),
      }),
      inventory_at: now,
    })
    .where('id', '=', deviceId)
    .execute();
}

/** The org's links and endpoints, merged again from every device's last inventory. */
export async function mergeOrg(host: EeHost, orgId: string, nowMs: number): Promise<void> {
  const db = host.systemDb;
  const now = new Date(nowMs);
  const devices = await db
    .selectFrom('network_devices')
    .select(['id', 'name', 'sys_name', 'address', 'inventory', 'mac', 'kind'])
    .where('org_id', '=', orgId)
    .where('removed_at', 'is', null)
    .execute();
  if (!devices.length) return;
  const ifs = await db
    .selectFrom('network_interfaces')
    .select(['device_id', 'name', 'descr', 'alias', 'mac', 'speed_mbps'])
    .where('org_id', '=', orgId)
    .execute();
  const refs: DevRef[] = devices.map((d: any) => ({
    id: d.id,
    name: d.name,
    sysName: d.sys_name,
    address: d.address,
    macs: new Set([
      ...ifs
        .filter((i: any) => i.device_id === d.id && i.mac)
        .map((i: any) => String(i.mac).toLowerCase()),
      ...(d.mac ? [String(d.mac).toLowerCase()] : []),
    ]),
    leaf: LEAF_KINDS.has(d.kind),
    ports: ifs
      .filter((i: any) => i.device_id === d.id)
      .map((i: any) => ({ name: i.name, descr: i.descr, alias: i.alias })),
  }));
  const neighbours: NeighbourIn[] = [];
  const macs: MacIn[] = [];
  const arp: { mac: string; ip: string }[] = [];
  for (const d of devices as any[]) {
    const inv = (d.inventory ?? {}) as Partial<Inventory>;
    for (const n of inv.neighbours ?? []) neighbours.push({ deviceId: d.id, ...n });
    for (const m of inv.macs ?? [])
      macs.push({ deviceId: d.id, port: m.port, mac: m.mac, vlan: m.vlan });
    for (const a of inv.arp ?? []) arp.push(a);
  }
  const links = mergeLinks(refs, neighbours, macs);
  const speed = new Map(ifs.map((i: any) => [`${i.device_id}/${i.name}`, num(i.speed_mbps)]));
  await db.transaction().execute(async (trx: any) => {
    const keep: string[] = [];
    for (const l of links) {
      const s = [speed.get(`${l.aDevice}/${l.aPort}`), speed.get(`${l.bDevice}/${l.bPort}`)].filter(
        (x): x is number => !!x,
      );
      const row = await trx
        .insertInto('network_links')
        .values({
          id: host.newId(),
          org_id: orgId,
          a_device: l.aDevice,
          a_port: l.aPort,
          b_device: l.bDevice,
          b_port: l.bPort,
          via: l.via,
          speed_mbps: s.length ? Math.min(...s) : null,
          first_seen: now,
          last_seen: now,
        })
        .onConflict((oc: any) =>
          oc.columns(['a_device', 'a_port', 'b_device', 'b_port']).doUpdateSet({
            via: l.via,
            speed_mbps: s.length ? Math.min(...s) : null,
            last_seen: now,
          }),
        )
        .returning('id')
        .executeTakeFirst();
      keep.push(row.id);
    }
    let del = trx.deleteFrom('network_links').where('org_id', '=', orgId);
    if (keep.length) del = del.where('id', 'not in', keep);
    await del.execute();
  });
  const eps = placeEndpoints(refs, links, macs, arp);
  // The servers and nodes whose agents reported these MAC addresses (core: host_interfaces).
  const hostIfs = eps.length
    ? await db
        .selectFrom('host_interfaces')
        .select(['mac', 'cluster_id', 'node', 'addresses'])
        .where('org_id', '=', orgId)
        .where(host.sql<boolean>`mac = any(${eps.map((e) => e.mac)}::macaddr[])`)
        .execute()
    : [];
  const nodeOf = new Map(hostIfs.map((h: any) => [String(h.mac).toLowerCase(), h]));
  for (const e of eps) {
    const n = nodeOf.get(e.mac) as
      { cluster_id: string; node: string; addresses: string[] } | undefined;
    const ip = e.ip ?? n?.addresses?.[0] ?? null;
    const v = {
      org_id: orgId,
      mac: e.mac,
      ip,
      vendor: vendorOf(e.mac),
      device_id: e.deviceId,
      port: e.port,
      vlan: e.vlan,
      cluster_id: n?.cluster_id ?? null,
      node: n?.node ?? null,
      first_seen: now,
      last_seen: now,
    };
    await db
      .insertInto('network_endpoints')
      .values(v)
      .onConflict((oc: any) =>
        oc.columns(['org_id', 'mac']).doUpdateSet({
          ip: v.ip,
          vendor: v.vendor,
          device_id: v.device_id,
          port: v.port,
          vlan: v.vlan,
          cluster_id: v.cluster_id,
          node: v.node,
          last_seen: now,
        }),
      )
      .execute();
  }
  await db
    .deleteFrom('network_endpoints')
    .where('org_id', '=', orgId)
    .where('last_seen', '<', new Date(nowMs - ENDPOINT_KEPT_MS))
    .execute();
}
