// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network pages' API (ADR-233), under /api/v1/network, every route behind the `network`
// feature (404 where it isn't licensed, as What changed's). Reading: any signed-in user.
// Adding, changing and removing devices and credential profiles: Owners and Admins.
// Accepting a RouterOS device's new certificate: Owners.
import type {
  EeHost,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from '../../../../backend/src/ee-contract.js';
import { FEATURE } from './collector.js';
import { credentialView, sealSecret, type CredentialRow } from './credentials.js';
import { speedText } from './ingest.js';
import { RangeError, validRange } from './range.js';
import { setupCommands, type Platform } from './setup.js';

const ID = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
};
const IdParams = { type: 'object', required: ['id'], properties: { id: ID } };
const NAME = { type: 'string', minLength: 1, maxLength: 64 };
const ADDRESS = { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.:_-]+$' };
const HOST = { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9._-]*$' };
const DISCOVERY_MS = 30 * 60_000;
const MAX_DEVICES_ADDED = 200;

type Req = FastifyRequest & { user: { id: string; role: string; org: { id: string } } | null };
const orgOf = (r: FastifyRequest) => (r as Req).user!.org.id;
const problem = (reply: FastifyReply, status: number, detail: string) =>
  reply.code(status).type('application/problem+json').send({ title: detail, status, detail });

const num = (v: unknown) => (v == null ? null : Number(v));

/** A firmware version as numbers, to find the oldest: "15.2(7)E8" → [15, 2, 7, 8]. */
export function versionParts(v: string): number[] {
  return (v.match(/\d+/g) ?? []).map(Number);
}
export function olderVersion(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

export async function registerNetworkRoutes(api: FastifyInstance, host: EeHost): Promise<void> {
  const read = { preHandler: [host.requireUser(), host.requireFeature(FEATURE)] };
  const write = {
    preHandler: [
      host.requireUser(),
      host.requireFeature(FEATURE),
      host.requireRole('owner', 'admin'),
    ],
  };
  const owner = {
    preHandler: [host.requireUser(), host.requireFeature(FEATURE), host.requireRole('owner')],
  };
  const db = host.db;
  const tags = ['network'];

  /** The org's places, with each one's collectors (Kubernetes: one, host ''; servers: one each). */
  async function pollers(orgId: string) {
    const [clusters, collectors, servers] = await Promise.all([
      db
        .selectFrom('clusters')
        .select(['id', 'name', 'kind'])
        .where('org_id', '=', orgId)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('integration_collectors as c')
        .innerJoin('clusters as k', 'k.id', 'c.cluster_id')
        .select(['c.cluster_id', 'c.host', 'c.last_seen_at'])
        .where('k.org_id', '=', orgId)
        .execute(),
      db
        .selectFrom('agent_instances')
        .select(['cluster_id', 'node', 'last_seen_at'])
        .where('org_id', '=', orgId)
        .where('mode', '=', 'docker')
        .execute(),
    ]);
    const fresh = (t: Date | null) => !!t && host.now() - new Date(t).getTime() < 10 * 60_000;
    return clusters.map((c: { id: string; name: string; kind: string }) => {
      const cols = collectors.filter((x: { cluster_id: string }) => x.cluster_id === c.id);
      if (c.kind === 'kubernetes') {
        const col = cols.find((x: { host: string }) => x.host === '');
        return {
          clusterId: c.id,
          name: c.name,
          kind: 'kubernetes',
          hosts: [{ host: '', collector: !!col, reporting: fresh(col?.last_seen_at ?? null) }],
        };
      }
      const names = new Set<string>([
        ...servers
          .filter((s: { cluster_id: string }) => s.cluster_id === c.id)
          .map((s: { node: string }) => s.node),
        ...cols.map((x: { host: string }) => x.host).filter(Boolean),
      ]);
      return {
        clusterId: c.id,
        name: c.name,
        kind: 'server',
        hosts: [...names].sort().map((h) => {
          const col = cols.find((x: { host: string }) => x.host === h);
          return { host: h, collector: !!col, reporting: fresh(col?.last_seen_at ?? null) };
        }),
      };
    });
  }

  async function deviceRows(orgId: string) {
    return db
      .selectFrom('network_devices as d')
      .innerJoin('clusters as c', 'c.id', 'd.cluster_id')
      .select([
        'd.id',
        'd.name',
        'd.kind',
        'd.vendor',
        'd.model',
        'd.serial',
        'd.firmware',
        'd.address',
        'd.protocol',
        'd.profile',
        'd.status',
        'd.error',
        'd.failures',
        'd.uptime_s',
        'd.polled_at',
        'd.health',
        'd.cluster_id',
        'd.poller_host',
        'd.credential_id',
        'd.managed_ap',
        'd.sys_name',
        'd.location',
        'd.cert_pin',
        'd.cert_seen',
        'd.first_seen',
        'd.last_seen',
        'd.inventory',
        'c.name as cluster_name',
        'c.kind as cluster_kind',
      ])
      .where('d.org_id', '=', orgId)
      .where('d.removed_at', 'is', null)
      .orderBy('d.name')
      .execute();
  }

  function deviceView(d: any, openAlerts = 0) {
    const h = (d.health ?? {}) as Record<string, any>;
    const mem = h.memUsed != null && h.memTotal ? h.memUsed / h.memTotal : null;
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      vendor: d.vendor,
      model: d.model,
      serial: d.serial,
      firmware: d.firmware,
      address: d.address,
      protocol: d.protocol,
      profile: d.profile,
      status: d.status,
      error: d.error,
      uptimeS: num(d.uptime_s),
      polledAt: d.polled_at ? new Date(d.polled_at).toISOString() : null,
      cpu: h.cpu ?? null,
      memory: mem,
      temperature: h.temperature ?? null,
      portsUp: h.portsUp ?? null,
      portsTotal: h.portsTotal ?? null,
      update: h.update ?? null,
      managedAp: d.managed_ap,
      poller: {
        clusterId: d.cluster_id,
        name: d.cluster_name,
        kind: d.cluster_kind,
        host: d.poller_host,
      },
      openAlerts,
    };
  }

  /** Firing network alerts by device, and the list for "Needs attention". */
  async function openAlerts(orgId: string) {
    const rows = await db
      .selectFrom('alert_states as s')
      .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
      .select([
        's.id',
        's.severity',
        's.labels',
        's.details',
        's.started_at',
        'r.rule_key',
        'r.name',
      ])
      .where('r.org_id', '=', orgId)
      .where('s.state', '=', 'firing')
      .where('r.rule_key', 'like', 'network.%')
      .orderBy('s.started_at', 'desc')
      .limit(200)
      .execute();
    const byDevice = new Map<string, number>();
    const list = rows.map((r: any) => {
      const l = r.labels as Record<string, string>;
      byDevice.set(l.device_id!, (byDevice.get(l.device_id!) ?? 0) + 1);
      return {
        alertId: r.id,
        severity: r.severity,
        what: (r.details as { title?: string }).title ?? r.name,
        why: (r.details as { why?: string }).why ?? null,
        where: l.port ? `${l.device} · ${l.port}` : l.device,
        deviceId: l.device_id,
        port: l.port ?? null,
        since: new Date(r.started_at).toISOString(),
      };
    });
    return { byDevice, list };
  }

  /** Utilisation of every linked port, both ways, from the last 5 minutes. */
  async function utilisation(orgId: string, clusterIds: string[]) {
    const out = new Map<string, { in: number; out: number }>();
    if (!host.victoria || !clusterIds.length) return out;
    const q = (dir: 'in' | 'out') =>
      host
        .victoria!.query(
          orgId,
          clusterIds,
          `max by (device, ifname) (rate(watchlog_net_if_${dir}_bytes_total[5m])) * 8`,
        )
        .catch(() => []);
    const [i, o] = await Promise.all([q('in'), q('out')]);
    for (const [dir, rows] of [
      ['in', i],
      ['out', o],
    ] as const) {
      for (const r of rows) {
        const k = `${r.labels.device}/${r.labels.ifname}`;
        const v = r.points[0]?.[1] ?? 0;
        const e = out.get(k) ?? { in: 0, out: 0 };
        e[dir] = v ?? 0;
        out.set(k, e);
      }
    }
    return out;
  }

  async function linkViews(orgId: string, devices: any[]) {
    const [links, ifs] = await Promise.all([
      db.selectFrom('network_links').selectAll().where('org_id', '=', orgId).execute(),
      db
        .selectFrom('network_interfaces')
        .select(['device_id', 'name', 'oper_up', 'speed_mbps', 'errors_rising_since'])
        .where('org_id', '=', orgId)
        .execute(),
    ]);
    const ifOf = new Map(ifs.map((i: any) => [`${i.device_id}/${i.name}`, i]));
    const util = await utilisation(orgId, [...new Set(devices.map((d) => d.cluster_id as string))]);
    return links.map((l: any) => {
      const a = ifOf.get(`${l.a_device}/${l.a_port}`) as any;
      const b = ifOf.get(`${l.b_device}/${l.b_port}`) as any;
      const speed = num(l.speed_mbps) ?? num(a?.speed_mbps) ?? num(b?.speed_mbps);
      const ua = util.get(`${l.a_device}/${l.a_port}`);
      const bps = (speed ?? 0) * 1e6;
      // A→B is what A sends; B→A what A receives (or B's own counters when A has none).
      const ab = ua ? ua.out : (util.get(`${l.b_device}/${l.b_port}`)?.in ?? null);
      const ba = ua ? ua.in : (util.get(`${l.b_device}/${l.b_port}`)?.out ?? null);
      const down = (a && !a.oper_up) || (b && !b.oper_up);
      const errors = !!(a?.errors_rising_since || b?.errors_rising_since);
      const use = bps ? Math.max(ab ?? 0, ba ?? 0) / bps : null;
      return {
        id: l.id,
        a: { deviceId: l.a_device, port: l.a_port },
        b: { deviceId: l.b_device, port: l.b_port },
        via: l.via,
        speedMbps: speed,
        bpsAB: ab,
        bpsBA: ba,
        utilisation: use,
        errors,
        state: down ? 'down' : errors || (use ?? 0) > 0.8 ? 'warn' : 'ok',
        lastSeen: new Date(l.last_seen).toISOString(),
      };
    });
  }

  api.get('/network/summary', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = orgOf(request);
    const [devices, alerts] = await Promise.all([deviceRows(orgId), openAlerts(orgId)]);
    const links = await linkViews(orgId, devices);
    const problems = await db
      .selectFrom('network_interfaces as i')
      .select(host.sql<number>`count(*)::int`.as('n'))
      .where('i.org_id', '=', orgId)
      .where((eb: any) =>
        eb.or([
          // A port down with a learnt link, or a WatchLog server or node behind it.
          eb.and([
            eb('i.admin_up', '=', true),
            eb('i.oper_up', '=', false),
            host.sql<boolean>`exists (select 1 from network_endpoints e where e.device_id = i.device_id and e.port = i.name and e.node is not null)`,
          ]),
          eb.and([
            eb('i.admin_up', '=', true),
            eb('i.oper_up', '=', false),
            eb.exists(
              eb
                .selectFrom('network_links as l')
                .select('l.id')
                .where((e2: any) =>
                  e2.or([
                    e2.and([
                      e2('l.a_device', '=', eb.ref('i.device_id')),
                      e2('l.a_port', '=', eb.ref('i.name')),
                    ]),
                    e2.and([
                      e2('l.b_device', '=', eb.ref('i.device_id')),
                      e2('l.b_port', '=', eb.ref('i.name')),
                    ]),
                  ]),
                ),
            ),
          ]),
          eb('i.errors_rising_since', 'is not', null),
          eb.and([
            eb('i.oper_up', '=', true),
            host.sql<boolean>`i.speed_mbps < i.usual_speed_mbps`,
          ]),
        ]),
      )
      .executeTakeFirst();
    let oldest: { deviceId: string; name: string; firmware: string } | null = null;
    for (const d of devices as any[]) {
      if (!d.firmware) continue;
      if (!oldest || olderVersion(d.firmware, oldest.firmware))
        oldest = { deviceId: d.id, name: d.name, firmware: d.firmware };
    }
    const up = devices.filter((d: any) => d.status === 'ok').length;
    return {
      tiles: {
        devices: devices.length,
        up,
        down: devices.filter((d: any) => !['ok', 'pending'].includes(d.status)).length,
        pending: devices.filter((d: any) => d.status === 'pending').length,
        portsWithProblems: problems?.n ?? 0,
        busyLinks: links.filter((l: any) => (l.utilisation ?? 0) > 0.8).length,
        links: links.length,
        oldestFirmware: oldest,
      },
      attention: alerts.list,
      devices: devices.map((d: any) => deviceView(d, alerts.byDevice.get(d.id) ?? 0)),
    };
  });

  api.get('/network/devices', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = orgOf(request);
    const [devices, alerts] = await Promise.all([deviceRows(orgId), openAlerts(orgId)]);
    return { devices: devices.map((d: any) => deviceView(d, alerts.byDevice.get(d.id) ?? 0)) };
  });

  api.get(
    '/network/devices/:id',
    { ...read, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const devices = await deviceRows(orgId);
      const d = devices.find((x: any) => x.id === id) as any;
      if (!d) return problem(reply, 404, 'Device not found');
      const [ifs, eps, events, alerts, links, cred] = await Promise.all([
        db
          .selectFrom('network_interfaces')
          .selectAll()
          .where('device_id', '=', id)
          .orderBy('if_index')
          .execute(),
        db
          .selectFrom('network_endpoints as e')
          .leftJoin('clusters as c', 'c.id', 'e.cluster_id')
          .select([
            'e.mac',
            'e.ip',
            'e.vendor',
            'e.port',
            'e.vlan',
            'e.cluster_id',
            'e.node',
            'e.last_seen',
            'c.name as cluster_name',
            'c.kind as cluster_kind',
          ])
          .where('e.org_id', '=', orgId)
          .where('e.device_id', '=', id)
          .orderBy('e.port')
          .execute(),
        db
          .selectFrom('network_events')
          .select(['port', 'reason', 'severity', 'message', 'at'])
          .where('device_id', '=', id)
          .orderBy('at', 'desc')
          .limit(50)
          .execute(),
        openAlerts(orgId),
        linkViews(orgId, [d]),
        d.credential_id
          ? db
              .selectFrom('network_credentials')
              .select(['id', 'name', 'protocol'])
              .where('id', '=', d.credential_id)
              .executeTakeFirst()
          : null,
      ]);
      const name = new Map(devices.map((x: any) => [x.id, x.name]));
      const mine = links.filter((l: any) => l.a.deviceId === id || l.b.deviceId === id);
      const neighbourOf = new Map<
        string,
        { deviceId: string; device: string; port: string; linkId: string }
      >();
      for (const l of mine) {
        const [me, other] = l.a.deviceId === id ? [l.a, l.b] : [l.b, l.a];
        neighbourOf.set(me.port, {
          deviceId: other.deviceId,
          device: name.get(other.deviceId) ?? '',
          port: other.port,
          linkId: l.id,
        });
      }
      const h = (d.health ?? {}) as Record<string, any>;
      return {
        device: {
          ...deviceView(d, alerts.byDevice.get(id) ?? 0),
          sysName: d.sys_name,
          location: d.location,
          credential: cred ? { id: cred.id, name: cred.name, protocol: cred.protocol } : null,
          certificate: d.protocol === 'routeros' ? { pinned: d.cert_pin, seen: d.cert_seen } : null,
          routes: (d.inventory as { routes?: number })?.routes ?? null,
          gateway: (d.inventory as { gateway?: string })?.gateway ?? null,
          firstSeen: new Date(d.first_seen).toISOString(),
          lastSeen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
        },
        health: {
          sensors: h.sensors ?? [],
          fans: h.fans ?? [],
          psus: h.psus ?? [],
          optics: h.optics ?? [],
          stack: h.stack ?? [],
          stackExpected: h.stackExpected ?? 0,
        },
        ports: ifs.map((i: any) => ({
          index: i.if_index,
          name: i.name,
          descr: i.descr,
          alias: i.alias,
          kind: i.kind,
          speedMbps: num(i.speed_mbps),
          usualSpeedMbps: num(i.usual_speed_mbps),
          adminUp: i.admin_up,
          operUp: i.oper_up,
          vlans: i.vlans,
          poeWatts: i.poe_watts,
          errorsRising: !!i.errors_rising_since,
          changedAt: i.changed_at ? new Date(i.changed_at).toISOString() : null,
          neighbour: neighbourOf.get(i.name) ?? null,
        })),
        endpoints: eps.map((e: any) => ({
          mac: e.mac,
          ip: e.ip,
          vendor: e.vendor,
          port: e.port,
          vlan: e.vlan,
          node: e.node
            ? {
                clusterId: e.cluster_id,
                cluster: e.cluster_name,
                kind: e.cluster_kind,
                name: e.node,
              }
            : null,
          lastSeen: new Date(e.last_seen).toISOString(),
        })),
        links: mine,
        events: events.map((e: any) => ({ ...e, at: new Date(e.at).toISOString() })),
        alerts: alerts.list.filter((a: any) => a.deviceId === id),
      };
    },
  );

  api.get(
    '/network/devices/:id/series',
    {
      ...read,
      schema: {
        tags,
        hide: true,
        params: IdParams,
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'integer', minimum: 600, maximum: 7 * 86400 },
            port: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const { range = 3600, port } = request.query as { range?: number; port?: string };
      const d = await db
        .selectFrom('network_devices')
        .select(['id', 'cluster_id'])
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!d) return problem(reply, 404, 'Device not found');
      const end = Math.floor(host.now() / 1000);
      const step = Math.max(60, Math.round(range / 120));
      const sel = `device="${id}"`;
      const q = (expr: string) =>
        host.victoria
          ? host.victoria
              .queryRange(orgId, [d.cluster_id], expr, end - range, end, step)
              .then((r) => r[0]?.points ?? [])
              .catch(() => [])
          : Promise.resolve([]);
      const p = port ? `,ifname="${port.replace(/["\\]/g, '')}"` : '';
      const [cpu, memory, temperature, inBps, outBps, errors, discards] = await Promise.all([
        q(`max(watchlog_net_cpu_utilization{${sel}})`),
        q(`max(watchlog_net_memory_utilization{${sel}})`),
        q(`max(watchlog_net_temperature_celsius{${sel}})`),
        port
          ? q(`sum(rate(watchlog_net_if_in_bytes_total{${sel}${p}}[5m])) * 8`)
          : Promise.resolve([]),
        port
          ? q(`sum(rate(watchlog_net_if_out_bytes_total{${sel}${p}}[5m])) * 8`)
          : Promise.resolve([]),
        port
          ? q(
              `sum(rate(watchlog_net_if_in_errors_total{${sel}${p}}[5m]) + rate(watchlog_net_if_out_errors_total{${sel}${p}}[5m])) * 60`,
            )
          : Promise.resolve([]),
        port
          ? q(
              `sum(rate(watchlog_net_if_in_discards_total{${sel}${p}}[5m]) + rate(watchlog_net_if_out_discards_total{${sel}${p}}[5m])) * 60`,
            )
          : Promise.resolve([]),
      ]);
      return {
        range,
        step,
        cpu,
        memory,
        temperature,
        port: port ? { name: port, inBps, outBps, errors, discards } : null,
      };
    },
  );

  api.get('/network/map', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = orgOf(request);
    const [devices, alerts, layout, eps] = await Promise.all([
      deviceRows(orgId),
      openAlerts(orgId),
      db
        .selectFrom('network_layouts')
        .select('positions')
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
      db
        .selectFrom('network_endpoints as e')
        .leftJoin('clusters as c', 'c.id', 'e.cluster_id')
        .leftJoin('network_interfaces as i', (j: any) =>
          j.onRef('i.device_id', '=', 'e.device_id').onRef('i.name', '=', 'e.port'),
        )
        .select([
          'e.mac',
          'e.ip',
          'e.vendor',
          'e.device_id',
          'e.port',
          'e.cluster_id',
          'e.node',
          'c.name as cluster_name',
          'c.kind as cluster_kind',
          'i.oper_up as port_up',
        ])
        .where('e.org_id', '=', orgId)
        .orderBy('e.device_id')
        .limit(5000)
        .execute(),
    ]);
    const links = await linkViews(orgId, devices);
    return {
      devices: devices.map((d: any) => ({
        ...deviceView(d, alerts.byDevice.get(d.id) ?? 0),
        gateway: (d.inventory as { gateway?: string })?.gateway ?? null,
      })),
      links,
      endpoints: eps.map((e: any) => ({
        mac: e.mac,
        ip: e.ip,
        vendor: e.vendor,
        deviceId: e.device_id,
        port: e.port,
        portUp: e.port_up ?? null,
        node: e.node
          ? { clusterId: e.cluster_id, cluster: e.cluster_name, kind: e.cluster_kind, name: e.node }
          : null,
      })),
      layout: (layout?.positions ?? {}) as Record<string, { x: number; y: number }>,
    };
  });

  api.put(
    '/network/map/layout',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        body: {
          type: 'object',
          required: ['positions'],
          properties: {
            positions: {
              type: 'object',
              maxProperties: 2000,
              additionalProperties: {
                type: 'object',
                required: ['x', 'y'],
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { positions } = request.body as { positions: Record<string, unknown> };
      await db
        .insertInto('network_layouts')
        .values({
          org_id: orgId,
          id: 1,
          positions: JSON.stringify(positions),
          updated_at: new Date(host.now()),
        })
        .onConflict((oc: any) =>
          oc.columns(['org_id', 'id']).doUpdateSet({
            positions: JSON.stringify(positions),
            updated_at: new Date(host.now()),
          }),
        )
        .execute();
      return reply.code(204).send();
    },
  );

  // The core's server and node pages: "sw-access-2 · Gi1/0/14 · 1 Gb/s".
  api.get(
    '/network/attachments',
    {
      ...read,
      schema: {
        tags,
        hide: true,
        querystring: {
          type: 'object',
          required: ['cluster', 'node'],
          properties: { cluster: ID, node: { type: 'string', minLength: 1, maxLength: 253 } },
        },
      },
    },
    async (request) => {
      const orgId = orgOf(request);
      const { cluster, node } = request.query as { cluster: string; node: string };
      const rows = await db
        .selectFrom('network_endpoints as e')
        .innerJoin('network_devices as d', 'd.id', 'e.device_id')
        .leftJoin('network_interfaces as i', (j: any) =>
          j.onRef('i.device_id', '=', 'e.device_id').onRef('i.name', '=', 'e.port'),
        )
        .select([
          'e.mac',
          'e.device_id',
          'd.name',
          'e.port',
          'i.speed_mbps',
          'i.oper_up',
          'i.alias',
        ])
        .where('e.org_id', '=', orgId)
        .where('e.cluster_id', '=', cluster)
        .where('e.node', '=', node)
        .where('d.removed_at', 'is', null)
        .orderBy('d.name')
        .execute();
      return {
        attachments: rows.map((r: any) => ({
          mac: r.mac,
          deviceId: r.device_id,
          device: r.name,
          port: r.port,
          speedMbps: num(r.speed_mbps),
          speed: speedText(num(r.speed_mbps)),
          up: r.oper_up ?? null,
        })),
      };
    },
  );

  // ---- Adding devices.

  api.get('/network/pollers', { ...read, schema: { tags, hide: true } }, async (request) => ({
    pollers: await pollers(orgOf(request)),
  }));

  api.get('/network/credentials', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = orgOf(request);
    const [rows, used] = await Promise.all([
      db
        .selectFrom('network_credentials')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('network_devices')
        .select(['credential_id', host.sql<number>`count(*)::int`.as('n')])
        .where('org_id', '=', orgId)
        .where('removed_at', 'is', null)
        .groupBy('credential_id')
        .execute(),
    ]);
    const n = new Map(used.map((u: any) => [u.credential_id, u.n]));
    return {
      credentials: rows.map((r: any) => credentialView(r as CredentialRow, n.get(r.id) ?? 0)),
    };
  });

  const CredentialBody = {
    type: 'object',
    required: ['name', 'protocol', 'settings'],
    additionalProperties: false,
    properties: {
      name: NAME,
      protocol: { enum: ['snmp', 'routeros'] },
      settings: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { enum: ['3', '2c'] },
          user: { type: 'string', maxLength: 64 },
          authProto: { enum: ['SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'] },
          privProto: { enum: ['AES', 'AES192', 'AES256'] },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          transport: { enum: ['rest', 'api-ssl', 'api'] },
          allowPlain: { type: 'boolean' },
        },
      },
      secret: {
        type: 'object',
        additionalProperties: false,
        properties: {
          community: { type: 'string', minLength: 1, maxLength: 128 },
          authKey: { type: 'string', minLength: 8, maxLength: 128 },
          privKey: { type: 'string', minLength: 8, maxLength: 128 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  };

  function checkCredential(
    b: { protocol: string; settings: Record<string, unknown>; secret?: Record<string, unknown> },
    creating: boolean,
  ): string | null {
    const s = b.settings;
    if (b.protocol === 'snmp') {
      if (!s.version) return 'Choose SNMP v3 (recommended) or v2c';
      if (s.version === '3' && !s.user) return 'An SNMPv3 profile needs a user';
      if (creating && s.version === '3' && (!b.secret?.authKey || !b.secret?.privKey))
        return 'An SNMPv3 profile needs its authentication and privacy keys (authPriv)';
      if (creating && s.version === '2c' && !b.secret?.community)
        return 'A v2c profile needs its community';
    } else {
      if (!s.user) return 'A RouterOS profile needs a user';
      if (s.transport === 'api' && !s.allowPlain)
        return 'The plain API sends the password in clear: tick "allow unencrypted on this network" to use it';
      if (creating && !b.secret?.password) return 'A RouterOS profile needs its password';
    }
    return null;
  }

  api.post(
    '/network/credentials',
    { ...write, schema: { tags, hide: true, body: CredentialBody } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const b = request.body as {
        name: string;
        protocol: 'snmp' | 'routeros';
        settings: Record<string, unknown>;
        secret?: Record<string, string>;
      };
      const bad = checkCredential(b, true);
      if (bad) return problem(reply, 400, bad);
      const id = host.newId();
      try {
        await db
          .insertInto('network_credentials')
          .values({
            id,
            org_id: orgId,
            name: b.name,
            protocol: b.protocol,
            settings: JSON.stringify(b.settings),
            ciphertext: sealSecret(host, id, b.secret ?? {}),
          })
          .execute();
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          return problem(reply, 409, 'A profile with that name exists');
        throw err;
      }
      return reply.code(201).send({ id });
    },
  );

  api.patch(
    '/network/credentials/:id',
    {
      ...write,
      schema: { tags, hide: true, params: IdParams, body: { ...CredentialBody, required: [] } },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const row = await db
        .selectFrom('network_credentials')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return problem(reply, 404, 'Profile not found');
      const b = request.body as {
        name?: string;
        settings?: Record<string, unknown>;
        secret?: Record<string, string>;
      };
      const merged = {
        protocol: row.protocol,
        settings: { ...(row.settings as object), ...(b.settings ?? {}) },
      };
      const bad = checkCredential(merged, false);
      if (bad) return problem(reply, 400, bad);
      await db
        .updateTable('network_credentials')
        .set({
          ...(b.name ? { name: b.name } : {}),
          settings: JSON.stringify(merged.settings),
          ...(b.secret ? { ciphertext: sealSecret(host, id, b.secret) } : {}),
          updated_at: new Date(host.now()),
        })
        .where('id', '=', id)
        .execute();
      await notifyPollers(orgId, { credentialId: id });
      return reply.code(204).send();
    },
  );

  api.delete(
    '/network/credentials/:id',
    { ...write, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const used = await db
        .selectFrom('network_devices')
        .select('id')
        .where('org_id', '=', orgId)
        .where('credential_id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (used) return problem(reply, 409, 'Devices use this profile; give them another first');
      const r = await db
        .deleteFrom('network_credentials')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!Number(r.numDeletedRows)) return problem(reply, 404, 'Profile not found');
      return reply.code(204).send();
    },
  );

  async function notifyPollers(orgId: string, by: { credentialId?: string; deviceId?: string }) {
    let q = db
      .selectFrom('network_devices')
      .select('cluster_id')
      .distinct()
      .where('org_id', '=', orgId);
    if (by.credentialId) q = q.where('credential_id', '=', by.credentialId);
    if (by.deviceId) q = q.where('id', '=', by.deviceId);
    for (const r of await q.execute()) host.collector.notify(r.cluster_id);
  }

  /** The poller exists in the org: a cluster, and on a fleet one of its servers. */
  async function checkPoller(orgId: string, clusterId: string, h: string): Promise<string | null> {
    const ps = await pollers(orgId);
    const p = ps.find((x: any) => x.clusterId === clusterId);
    if (!p) return 'Choose a cluster or a server to poll from';
    if (p.kind === 'kubernetes' && h !== '')
      return "A cluster's collector polls with an empty host";
    if (p.kind === 'server' && !p.hosts.some((x: any) => x.host === h))
      return "Choose one of the fleet's servers";
    return null;
  }

  api.post(
    '/network/discoveries',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        body: {
          type: 'object',
          required: ['clusterId', 'host', 'credentialIds'],
          additionalProperties: false,
          properties: {
            clusterId: ID,
            host: HOST,
            seeds: { type: 'array', maxItems: 64, items: ADDRESS },
            range: { type: 'string', maxLength: 64 },
            neighbours: { type: 'boolean' },
            credentialIds: { type: 'array', minItems: 1, maxItems: 8, items: ID },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const b = request.body as {
        clusterId: string;
        host: string;
        seeds?: string[];
        range?: string;
        neighbours?: boolean;
        credentialIds: string[];
      };
      const bad = await checkPoller(orgId, b.clusterId, b.host);
      if (bad) return problem(reply, 400, bad);
      if (!b.seeds?.length && !b.range)
        return problem(reply, 400, 'Give at least one address or a range');
      if (b.range) {
        try {
          validRange(b.range);
        } catch (err) {
          if (err instanceof RangeError) return problem(reply, 400, err.message);
          throw err;
        }
      }
      const creds = await db
        .selectFrom('network_credentials')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', 'in', b.credentialIds)
        .execute();
      if (creds.length !== new Set(b.credentialIds).size)
        return problem(reply, 400, 'Unknown credential profile');
      const id = host.newId();
      await db
        .insertInto('network_discoveries')
        .values({
          id,
          org_id: orgId,
          cluster_id: b.clusterId,
          poller_host: b.host,
          request: JSON.stringify({
            seeds: b.seeds ?? [],
            range: b.range ?? '',
            neighbours: b.neighbours ?? true,
            credentialIds: b.credentialIds,
          }),
          expires_at: new Date(host.now() + DISCOVERY_MS),
        })
        .execute();
      host.collector.notify(b.clusterId);
      return reply.code(201).send({ id });
    },
  );

  api.get(
    '/network/discoveries/:id',
    { ...read, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const r = await db
        .selectFrom('network_discoveries')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!r) return problem(reply, 404, 'Discovery not found');
      const known = new Set(
        (
          await db
            .selectFrom('network_devices')
            .select('address')
            .where('org_id', '=', orgId)
            .where('removed_at', 'is', null)
            .execute()
        ).map((d: any) => d.address),
      );
      const expired = new Date(r.expires_at).getTime() < host.now();
      return {
        id,
        done: r.done || expired,
        expired: expired && !r.done,
        found: (r.found as any[]).map((f) => ({ ...f, added: known.has(f.address) })),
      };
    },
  );

  api.post(
    '/network/devices',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        body: {
          type: 'object',
          required: ['clusterId', 'host', 'devices'],
          additionalProperties: false,
          properties: {
            clusterId: ID,
            host: HOST,
            devices: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_DEVICES_ADDED,
              items: {
                type: 'object',
                required: ['address', 'credentialId'],
                additionalProperties: false,
                properties: {
                  address: ADDRESS,
                  name: { type: 'string', minLength: 1, maxLength: 253 },
                  credentialId: ID,
                  profile: { type: 'string', maxLength: 64, pattern: '^[a-z0-9-]*$' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const b = request.body as {
        clusterId: string;
        host: string;
        devices: { address: string; name?: string; credentialId: string; profile?: string }[];
      };
      const bad = await checkPoller(orgId, b.clusterId, b.host);
      if (bad) return problem(reply, 400, bad);
      const closed = await host.closedSince();
      if (closed !== null && closed <= host.now()) {
        return problem(
          reply,
          403,
          'Your licence has been over its units for 30 days: no new devices until it covers them. Devices already added keep working.',
        );
      }
      const creds = await db
        .selectFrom('network_credentials')
        .select(['id', 'protocol'])
        .where('org_id', '=', orgId)
        .execute();
      const protoOf = new Map(creds.map((c: any) => [c.id, c.protocol]));
      const existing = new Set(
        (
          await db
            .selectFrom('network_devices')
            .select('address')
            .where('org_id', '=', orgId)
            .where('removed_at', 'is', null)
            .execute()
        ).map((d: any) => d.address),
      );
      const added: string[] = [];
      const skipped: { address: string; reason: string }[] = [];
      for (const d of b.devices) {
        const protocol = protoOf.get(d.credentialId);
        if (!protocol) {
          skipped.push({ address: d.address, reason: 'unknown credential profile' });
          continue;
        }
        if (existing.has(d.address)) {
          skipped.push({ address: d.address, reason: 'already added' });
          continue;
        }
        const id = host.newId();
        await db
          .insertInto('network_devices')
          .values({
            id,
            org_id: orgId,
            cluster_id: b.clusterId,
            poller_host: b.host,
            name: d.name ?? d.address,
            address: d.address,
            protocol,
            profile: d.profile || (protocol === 'routeros' ? 'mikrotik' : null),
            credential_id: d.credentialId,
            kind: protocol === 'routeros' ? 'router' : 'switch',
          })
          .execute();
        existing.add(d.address);
        added.push(id);
      }
      if (added.length) {
        // The network's alert rules, the first time the org adds a device (ADR-233).
        await host.alerts.ensure(orgId);
        host.collector.notify(b.clusterId);
      }
      return reply.code(201).send({ added, skipped });
    },
  );

  api.patch(
    '/network/devices/:id',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        params: IdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 253 },
            clusterId: ID,
            host: HOST,
            credentialId: ID,
            kind: {
              enum: [
                'router',
                'l3switch',
                'switch',
                'ap',
                'nas',
                'nvr',
                'ups',
                'firewall',
                'other',
              ],
            },
            managedAp: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const b = request.body as {
        name?: string;
        clusterId?: string;
        host?: string;
        credentialId?: string;
        kind?: string;
        managedAp?: boolean;
      };
      const d = await db
        .selectFrom('network_devices')
        .select(['id', 'cluster_id', 'poller_host', 'protocol'])
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!d) return problem(reply, 404, 'Device not found');
      const set: Record<string, unknown> = { updated_at: new Date(host.now()) };
      if (b.name) set.name = b.name;
      if (b.kind) set.kind = b.kind;
      if (b.managedAp !== undefined) set.managed_ap = b.managedAp;
      if (b.clusterId !== undefined || b.host !== undefined) {
        const c = b.clusterId ?? d.cluster_id;
        const h = b.host ?? d.poller_host;
        const bad = await checkPoller(orgId, c, h);
        if (bad) return problem(reply, 400, bad);
        Object.assign(set, { cluster_id: c, poller_host: h, status: 'pending', failures: 0 });
      }
      if (b.credentialId) {
        const c = await db
          .selectFrom('network_credentials')
          .select(['id', 'protocol'])
          .where('org_id', '=', orgId)
          .where('id', '=', b.credentialId)
          .executeTakeFirst();
        if (!c || c.protocol !== d.protocol)
          return problem(reply, 400, 'Choose a profile of the same protocol');
        set.credential_id = b.credentialId;
      }
      await db.updateTable('network_devices').set(set).where('id', '=', id).execute();
      host.collector.notify(d.cluster_id);
      if (set.cluster_id && set.cluster_id !== d.cluster_id)
        host.collector.notify(set.cluster_id as string);
      return reply.code(204).send();
    },
  );

  // A RouterOS device's new certificate, accepted by an Owner: pinned, polled again.
  api.post(
    '/network/devices/:id/accept-certificate',
    { ...owner, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const d = await db
        .selectFrom('network_devices')
        .select(['id', 'cluster_id', 'cert_seen', 'status'])
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!d) return problem(reply, 404, 'Device not found');
      if (d.status !== 'cert_changed')
        return problem(reply, 409, "The device's certificate hasn't changed");
      // Without the new fingerprint (an older report), the next contact pins it again.
      await db
        .updateTable('network_devices')
        .set({
          cert_pin: d.cert_seen ?? null,
          cert_seen: null,
          status: 'pending',
          failures: 0,
          updated_at: new Date(host.now()),
        })
        .where('id', '=', id)
        .execute();
      await db
        .insertInto('network_events')
        .values({
          id: host.newId(),
          org_id: orgId,
          device_id: id,
          port: '',
          reason: 'CertificateAccepted',
          severity: 'info',
          message: 'An Owner accepted the new certificate.',
          at: new Date(host.now()),
        })
        .execute();
      host.collector.notify(d.cluster_id);
      return reply.code(204).send();
    },
  );

  api.delete(
    '/network/devices/:id',
    { ...write, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const d = await db
        .selectFrom('network_devices')
        .select(['id', 'cluster_id'])
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!d) return problem(reply, 404, 'Device not found');
      await db
        .updateTable('network_devices')
        .set({ removed_at: new Date(host.now()) })
        .where('id', '=', id)
        .execute();
      await db
        .deleteFrom('network_links')
        .where('org_id', '=', orgId)
        .where((eb: any) => eb.or([eb('a_device', '=', id), eb('b_device', '=', id)]))
        .execute();
      await db
        .deleteFrom('network_endpoints')
        .where('org_id', '=', orgId)
        .where('device_id', '=', id)
        .execute();
      host.collector.notify(d.cluster_id);
      return reply.code(204).send();
    },
  );

  api.get(
    '/network/setup-commands',
    {
      ...read,
      schema: {
        tags,
        hide: true,
        querystring: {
          type: 'object',
          required: ['platform', 'credentialId'],
          properties: {
            platform: { enum: ['ios', 'nxos', 'routeros'] },
            credentialId: ID,
            poller: { type: 'string', maxLength: 64, pattern: '^[0-9A-Fa-f.:]*$' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const q = request.query as { platform: Platform; credentialId: string; poller?: string };
      const c = await db
        .selectFrom('network_credentials')
        .select(['protocol', 'settings'])
        .where('org_id', '=', orgId)
        .where('id', '=', q.credentialId)
        .executeTakeFirst();
      if (!c) return problem(reply, 404, 'Profile not found');
      if ((q.platform === 'routeros') !== (c.protocol === 'routeros'))
        return problem(reply, 400, "Choose a profile of this platform's protocol");
      return { commands: setupCommands(q.platform, q.poller ?? '', c.settings as never) };
    },
  );
}
