// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The 0.17 pages' API (ADR-234): Network → Wireless (access points, clients, the traffic with its
// usual band) and Network → Storage (recorders and their three signals, the NAS, its iSCSI
// sessions, UPSes), a UPS's "feeds" setting, and what the summary and the map add for them.
import type { EeHost, FastifyInstance, FastifyReply } from '../../../../backend/src/ee-contract.js';
import { WEAK_DBM } from './kinds.js';
import { daysLeft, recordingDisks, type RecordingState } from './recording.js';
import type { NAS, Radio, RecorderDisk, UPS } from './report.js';

type Db = EeHost['db'];
const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: Date | string | number | null | undefined) =>
  v == null ? null : new Date(v).toISOString();
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export interface KindHelpers {
  read: object;
  write: object;
  tags: string[];
  orgOf(r: unknown): string;
  problem(reply: FastifyReply, status: number, detail: string): unknown;
  deviceRows(orgId: string): Promise<any[]>;
  deviceView(
    d: any,
    openAlerts?: number,
  ): { id: string; name: string; poller: unknown } & Record<string, unknown>;
  openAlerts(orgId: string): Promise<{ byDevice: Map<string, number>; list: any[] }>;
}

/** The kinds the org has: the Wireless and Storage tabs show only where there are some. */
export function kindCounts(devices: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of devices) out[d.kind] = (out[d.kind] ?? 0) + 1;
  return out;
}

/** A recorder's card, from its row: recording, the three signals, cameras, disk, rate. */
export function recorderView(d: any, sessions: any[]) {
  const r = (d.recording ?? {}) as Partial<RecordingState>;
  const h = (d.health?.recorder ?? {}) as {
    disks?: RecorderDisk[];
    cameras?: { channel: number; name: string; online: boolean; since: number }[];
    daysLeft?: number | null;
    full?: boolean;
  };
  const disks = h.disks ?? [];
  const cams = h.cameras ?? [];
  const left = daysLeft(disks, r.rate ?? null);
  const mine = sessions.filter((s) => s.recorder_id === d.id);
  return {
    id: d.id,
    name: d.name,
    model: d.model,
    firmware: d.firmware,
    address: d.address,
    status: d.status,
    recording: d.status === 'ok' ? (r.recording ?? null) : null,
    since: r.since ? iso(r.since) : null,
    failed: r.failed ?? [],
    signals: (['recorder', 'disk', 'rate'] as const).map((k) => ({
      key: k,
      ok: r.signals?.[k]?.ok ?? null,
      why: r.signals?.[k]?.why ?? '',
      since: r.signals?.[k]?.since ? iso(r.signals[k].since) : null,
    })),
    cameras: {
      online: cams.filter((c) => c.online).length,
      total: cams.length,
      list: cams.map((c) => ({ ...c, since: iso(c.since) })),
    },
    disks: recordingDisks(disks).map((k) => ({
      name: k.name,
      iscsi: k.iscsi,
      state: k.state,
      healthy: k.healthy,
      total: k.total,
      used: k.used,
      session: (() => {
        const s = mine.find((x) => x.disk === k.name);
        return s ? { nasId: s.nas_id, nas: s.nas_name, lun: s.lun } : null;
      })(),
    })),
    free: left.free,
    total: left.total,
    daysLeft: left.days,
    full: left.full,
    rate: r.rate ?? null,
    usual: r.usual ?? null,
    rateFrom: r.rateFrom ?? null,
  };
}

/** The org's links as a graph: the shortest path between two devices (the iSCSI layer). */
export function pathBetween(
  links: { id: string; a: { deviceId: string }; b: { deviceId: string } }[],
  from: string,
  to: string,
): { devices: string[]; links: string[] } | null {
  const adj = new Map<string, { to: string; link: string }[]>();
  for (const l of links) {
    const [a, b] = [l.a.deviceId, l.b.deviceId];
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, link: l.id });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, link: l.id });
  }
  const prev = new Map<string, { from: string; link: string }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const x = queue.shift()!;
    if (x === to) break;
    for (const e of adj.get(x) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: x, link: e.link });
      queue.push(e.to);
    }
  }
  if (!seen.has(to) || from === to) return null;
  const devices = [to];
  const ls: string[] = [];
  for (let x = to; x !== from;) {
    const p = prev.get(x)!;
    ls.unshift(p.link);
    devices.unshift(p.from);
    x = p.from;
  }
  return { devices, links: ls };
}

export async function sessionRows(db: Db, orgId: string) {
  return db
    .selectFrom('network_iscsi_sessions as s')
    .leftJoin('network_devices as n', 'n.id', 's.nas_id')
    .select([
      's.recorder_id',
      's.disk',
      's.nas_id',
      's.lun',
      's.target',
      's.connected',
      's.connected_since',
      's.lost_at',
      'n.name as nas_name',
    ])
    .where('s.org_id', '=', orgId)
    .execute() as Promise<any[]>;
}

/** What the map draws for 0.17: mesh links (dotted) and the iSCSI paths. */
export async function mapExtras(db: Db, orgId: string, links: any[]) {
  const [mesh, sessions] = await Promise.all([
    db
      .selectFrom('network_mesh_links')
      .select(['from_id', 'to_id', 'signal_dbm', 'rate'])
      .where('org_id', '=', orgId)
      .execute(),
    sessionRows(db, orgId),
  ]);
  return {
    mesh: mesh.map((m: any) => ({
      fromId: m.from_id,
      toId: m.to_id,
      signalDbm: m.signal_dbm,
      rate: m.rate,
    })),
    iscsi: sessions
      .filter((s) => s.nas_id)
      .map((s) => ({
        recorderId: s.recorder_id,
        nasId: s.nas_id,
        disk: s.disk,
        lun: s.lun,
        connected: s.connected,
        path: pathBetween(links, s.recorder_id, s.nas_id),
      })),
  };
}

/** The summary's additions: kinds present, the Recording card's lines, Wi-Fi clients now. */
export async function summaryExtras(db: Db, orgId: string, devices: any[]) {
  const recorders = devices.filter((d) => d.kind === 'nvr');
  const sessions = recorders.length ? await sessionRows(db, orgId) : [];
  const clients = devices.some((d) => d.kind === 'ap')
    ? await db
        .selectFrom('network_wifi_clients')
        .select(db.fn.countAll().as('n'))
        .where('org_id', '=', orgId)
        .executeTakeFirst()
    : null;
  return {
    kinds: kindCounts(devices),
    wifiClients: clients ? Number(clients.n) : 0,
    recording: recorders.map((d) => {
      const v = recorderView(d, sessions);
      return {
        id: v.id,
        name: v.name,
        recording: v.recording,
        status: v.status,
        since: v.since,
        why: v.failed.length
          ? v.signals
              .filter((s) => v.failed.includes(s.key))
              .map((s) => s.why)
              .join(' · ')
          : null,
        cameras: { online: v.cameras.online, total: v.cameras.total },
        disk: v.disks.find((k) => k.iscsi)?.session ?? null,
        daysLeft: v.daysLeft,
        full: v.full,
        rate: v.rate,
        usual: v.usual,
      };
    }),
  };
}

export function registerKindRoutes(api: FastifyInstance, host: EeHost, h: KindHelpers): void {
  const db = host.db;
  const { read, write, tags } = h;

  // The tabs' answer (Wireless and Storage show only where there are such devices): cheap.
  api.get('/network/kinds', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = h.orgOf(request);
    const [rows, clients] = await Promise.all([
      db
        .selectFrom('network_devices')
        .select(['kind', db.fn.countAll().as('n')])
        .where('org_id', '=', orgId)
        .where('removed_at', 'is', null)
        .groupBy('kind')
        .execute(),
      db
        .selectFrom('network_wifi_clients')
        .select(db.fn.countAll().as('n'))
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    ]);
    const kinds = Object.fromEntries(rows.map((r: any) => [r.kind, Number(r.n)]));
    return {
      kinds,
      devices: Object.values(kinds).reduce((a: number, b) => a + (b as number), 0),
      wifiClients: Number(clients?.n ?? 0),
    };
  });

  api.get('/network/wireless', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = h.orgOf(request);
    const [devices, alerts] = await Promise.all([h.deviceRows(orgId), h.openAlerts(orgId)]);
    const aps = devices.filter((d) => d.kind === 'ap');
    const byId = new Map(devices.map((d) => [d.id, d]));
    const controllers = [...new Set(aps.map((a) => a.parent_id).filter(Boolean))].map((id) => {
      const c = byId.get(id);
      return {
        id,
        name: c?.name ?? '',
        generations: (c?.health?.wireless?.generations as string[] | undefined) ?? [],
      };
    });
    const [clients, mesh, links] = await Promise.all([
      db
        .selectFrom('network_wifi_clients')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('ap')
        .limit(5000)
        .execute(),
      db
        .selectFrom('network_mesh_links')
        .select(['from_id', 'to_id', 'signal_dbm', 'rate'])
        .where('org_id', '=', orgId)
        .execute(),
      aps.length
        ? db
            .selectFrom('network_links')
            .select(['a_device', 'a_port', 'b_device', 'b_port'])
            .where('org_id', '=', orgId)
            .where((eb: any) =>
              eb.or([
                eb(
                  'a_device',
                  'in',
                  aps.map((a) => a.id),
                ),
                eb(
                  'b_device',
                  'in',
                  aps.map((a) => a.id),
                ),
              ]),
            )
            .execute()
        : [],
    ]);
    // Each AP's switch port: the map's link to it.
    const portOf = new Map<string, { deviceId: string; device: string; port: string }>();
    for (const l of links as any[]) {
      const [ap, sw, port] =
        byId.get(l.a_device)?.kind === 'ap'
          ? [l.a_device, l.b_device, l.b_port]
          : [l.b_device, l.a_device, l.a_port];
      if (byId.get(sw) && byId.get(sw).kind !== 'ap')
        portOf.set(ap, { deviceId: sw, device: byId.get(sw).name, port });
    }
    const end = host.now();
    const start = end - 24 * 3600_000;
    const step = 1800;
    const spark = new Map<string, number[]>();
    let traffic: [number, number | null][] = [];
    let band: { t: string; low: number; high: number; median: number }[] = [];
    if (host.victoria && aps.length) {
      const clusters = [...new Set(aps.map((a) => a.cluster_id as string))];
      const ctrl = controllers.map((c) => esc(c.id)).join('|');
      try {
        const rows = await host.victoria.queryRange(
          orgId,
          clusters,
          `sum by (device, ap) (watchlog_net_wifi_clients{device=~"${ctrl}"})`,
          Math.floor(start / 1000),
          Math.floor(end / 1000),
          step,
        );
        for (const r of rows)
          spark.set(
            `${r.labels.device}/${r.labels.ap}`,
            r.points.map(([, v]) => v ?? 0),
          );
      } catch (err) {
        host.log.warn({ err: (err as Error).message }, 'network: AP sparklines failed');
      }
      // The traffic: the APs' switch ports both ways (what goes through the access points).
      const groups = [...portOf.values()].map(
        (p) =>
          `__name__=~"watchlog_net_if_(in|out)_bytes_total",device="${esc(p.deviceId)}",ifname="${esc(p.port)}"`,
      );
      if (groups.length) {
        const expr = `sum(rate({${groups.join(' or ')}}[5m]))`;
        const swClusters = [
          ...new Set([...portOf.values()].map((p) => byId.get(p.deviceId)?.cluster_id as string)),
        ];
        try {
          const [series] = await host.victoria.queryRange(
            orgId,
            swClusters,
            expr,
            Math.floor(start / 1000),
            Math.floor(end / 1000),
            300,
          );
          traffic = (series?.points ?? []).map(([t, v]) => [t * 1000, v]);
          band = (
            await host.baseline.bands(orgId, swClusters, expr, start, end, 'bytes_per_second')
          )
            .filter((b) => !b.learning)
            .map((b) => ({ t: iso(b.t)!, low: b.low, high: b.high, median: b.median }));
        } catch (err) {
          host.log.warn({ err: (err as Error).message }, 'network: wireless traffic failed');
        }
      }
    }
    const perAp = new Map<string, { n: number; weak: number }>();
    for (const c of clients as any[]) {
      const k = c.ap_id ?? '';
      const e = perAp.get(k) ?? { n: 0, weak: 0 };
      e.n++;
      if (c.signal_dbm != null && c.signal_dbm < WEAK_DBM) e.weak++;
      perAp.set(k, e);
    }
    const apViews = aps.map((a) => {
      const ap = (a.health?.ap ?? {}) as { radios?: Radio[]; generation?: string; state?: string };
      return {
        ...h.deviceView(a, alerts.byDevice.get(a.id) ?? 0),
        controllerId: a.parent_id,
        controller: byId.get(a.parent_id)?.name ?? '',
        generation: ap.generation ?? '',
        state: ap.state ?? '',
        statusSince: iso(a.status_since),
        radios: ap.radios ?? [],
        clients: perAp.get(a.id)?.n ?? 0,
        weak: perAp.get(a.id)?.weak ?? 0,
        switchPort: portOf.get(a.id) ?? null,
        spark: spark.get(`${a.parent_id}/${a.name}`) ?? [],
      };
    });
    const busiest = [...apViews].sort((x, y) => y.clients - x.clients)[0];
    return {
      controllers,
      tiles: {
        aps: aps.length,
        apsUp: aps.filter((a) => a.status === 'ok').length,
        clients: clients.length,
        weak: (clients as any[]).filter((c) => c.signal_dbm != null && c.signal_dbm < WEAK_DBM)
          .length,
        busiest:
          busiest && busiest.clients
            ? { id: busiest.id as string, name: busiest.name as string, clients: busiest.clients }
            : null,
      },
      weakDbm: WEAK_DBM,
      aps: apViews,
      clients: (clients as any[]).map((c) => ({
        mac: c.mac,
        vendor: c.vendor,
        apId: c.ap_id,
        ap: c.ap,
        ssid: c.ssid,
        band: c.band,
        signalDbm: c.signal_dbm,
        txRate: c.tx_rate,
        rxRate: c.rx_rate,
        uptimeS: num(c.uptime_s),
        bytes: Number(c.bytes_tx) + Number(c.bytes_rx),
      })),
      mesh: mesh.map((m: any) => ({
        fromId: m.from_id,
        from: byId.get(m.from_id)?.name ?? '',
        toId: m.to_id,
        to: byId.get(m.to_id)?.name ?? '',
        signalDbm: m.signal_dbm,
        rate: m.rate,
      })),
      traffic: { points: traffic, band, stepS: 300 },
      attention: alerts.list.filter((a: any) => aps.some((x) => x.id === a.deviceId)),
    };
  });

  api.get('/network/storage', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = h.orgOf(request);
    const [devices, alerts, sessions] = await Promise.all([
      h.deviceRows(orgId),
      h.openAlerts(orgId),
      sessionRows(db, orgId),
    ]);
    const byId = new Map(devices.map((d) => [d.id, d]));
    const mine = devices.filter((d) => ['nvr', 'nas', 'ups'].includes(d.kind));
    const recorders = devices.filter((d) => d.kind === 'nvr');
    const feedPlaces = await db
      .selectFrom('clusters')
      .select(['id', 'name', 'kind'])
      .where('org_id', '=', orgId)
      .execute();
    const placeName = new Map(feedPlaces.map((c: any) => [c.id, c]));
    return {
      recorders: recorders.map((d) => ({
        ...recorderView(d, sessions),
        openAlerts: alerts.byDevice.get(d.id) ?? 0,
        poller: h.deviceView(d).poller,
      })),
      nases: devices
        .filter((d) => d.kind === 'nas')
        .map((d) => {
          const nas = (d.health?.nas ?? {}) as Partial<NAS>;
          return {
            ...h.deviceView(d, alerts.byDevice.get(d.id) ?? 0),
            sensors: d.health?.sensors ?? [],
            fans: d.health?.fans ?? [],
            psus: d.health?.psus ?? [],
            disks: nas.disks ?? [],
            volumes: nas.volumes ?? [],
            pools: nas.pools ?? [],
            luns: (nas.luns ?? []).map((l) => {
              const s = sessions.find((x) => x.nas_id === d.id && x.lun === l.name);
              return {
                ...l,
                session: s
                  ? {
                      recorderId: s.recorder_id,
                      recorder: byId.get(s.recorder_id)?.name ?? '',
                      connected: s.connected,
                      since: iso(s.connected_since),
                    }
                  : null,
              };
            }),
            targets: nas.targets ?? [],
          };
        }),
      sessions: sessions
        .filter((s) => byId.has(s.recorder_id))
        .map((s) => {
          const r = byId.get(s.recorder_id);
          const rec = (r.recording ?? {}) as Partial<RecordingState>;
          return {
            recorderId: s.recorder_id,
            recorder: r.name,
            disk: s.disk,
            nasId: s.nas_id,
            nas: s.nas_name,
            lun: s.lun,
            target: s.target,
            connected: s.connected,
            since: iso(s.connected_since),
            lostAt: iso(s.lost_at),
            throughputBps: s.connected ? (rec.rate ?? null) : 0,
            throughputFrom: rec.rateFrom ?? null,
            // QTS gives no session table over SNMP (ADR-234): seen from the recorder and the
            // switch ports, not from the NAS.
            seenFrom: 'recorder',
          };
        }),
      upses: devices
        .filter((d) => d.kind === 'ups')
        .map((d) => ({
          ...h.deviceView(d, alerts.byDevice.get(d.id) ?? 0),
          ups: (d.health?.ups ?? null) as UPS | null,
          feeds: ((d.feeds ?? []) as { clusterId: string; node: string }[]).map((f) => ({
            ...f,
            cluster: placeName.get(f.clusterId)?.name ?? '',
            kind: placeName.get(f.clusterId)?.kind ?? '',
          })),
        })),
      attention: alerts.list.filter((a: any) => mine.some((x) => x.id === a.deviceId)),
    };
  });

  // The servers and nodes a UPS can feed: those whose agents report.
  api.get('/network/feed-options', { ...read, schema: { tags, hide: true } }, async (request) => {
    const orgId = h.orgOf(request);
    const rows = await db
      .selectFrom('host_interfaces as i')
      .innerJoin('clusters as c', 'c.id', 'i.cluster_id')
      .select(['i.cluster_id', 'i.node', 'c.name', 'c.kind'])
      .distinct()
      .where('i.org_id', '=', orgId)
      .orderBy('c.name')
      .orderBy('i.node')
      .limit(2000)
      .execute();
    return {
      hosts: rows.map((r: any) => ({
        clusterId: r.cluster_id,
        cluster: r.name,
        kind: r.kind,
        node: r.node,
      })),
    };
  });

  api.put(
    '/network/devices/:id/feeds',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } },
        },
        body: {
          type: 'object',
          required: ['feeds'],
          additionalProperties: false,
          properties: {
            feeds: {
              type: 'array',
              maxItems: 128,
              items: {
                type: 'object',
                required: ['clusterId', 'node'],
                additionalProperties: false,
                properties: {
                  clusterId: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
                  node: { type: 'string', minLength: 1, maxLength: 253 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = h.orgOf(request);
      const { id } = request.params as { id: string };
      const { feeds } = request.body as { feeds: { clusterId: string; node: string }[] };
      const d = await db
        .selectFrom('network_devices')
        .select(['id', 'kind'])
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!d) return h.problem(reply, 404, 'Device not found');
      if (d.kind !== 'ups') return h.problem(reply, 400, 'Only a UPS feeds servers and nodes');
      const ids = [...new Set(feeds.map((f) => f.clusterId))];
      if (ids.length) {
        const mineIds = await db
          .selectFrom('clusters')
          .select('id')
          .where('org_id', '=', orgId)
          .where('id', 'in', ids)
          .execute();
        if (mineIds.length !== ids.length) return h.problem(reply, 400, 'Unknown cluster or fleet');
      }
      const unique = [...new Map(feeds.map((f) => [`${f.clusterId}/${f.node}`, f])).values()];
      await db
        .updateTable('network_devices')
        .set({ feeds: JSON.stringify(unique), updated_at: new Date(host.now()) })
        .where('id', '=', id)
        .execute();
      return reply.code(204).send();
    },
  );
}
