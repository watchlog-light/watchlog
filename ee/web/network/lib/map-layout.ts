// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network map's layout (ADR-233), pure and computed once per data change: horizontal
// bands top to bottom (Internet, Edge, Core, Access, Devices), each device in its kind's band,
// placed under the device it reaches the Internet through so its subtree stays together and
// tree links don't cross. Servers and nodes hang under their switch in the Devices band;
// unknown endpoints only with the endpoints layer, grouped per device ("+38 more") until
// expanded. Saved positions (MapData.layout) are applied by the component, by these node ids.
// Access points, NASes, recorders and UPSes are leaves under their switch port's device (0.17,
// ADR-234); an access point with only a wireless backhaul (mesh) sits next to its mesh peer, and
// the mesh itself is drawn as dotted edges between access points.
import type { Device, DeviceKind, Endpoint, Link, MapData, NodeRef } from '../api';
import { bandOf, statusTone } from './format';

export type Band = 0 | 1 | 2 | 3 | 4;
export type Tone = 'ok' | 'warning' | 'critical' | 'neutral';
export type MapDevice = Device & { gateway: string | null };

export interface MapNode {
  id: string;
  type: 'internet' | 'device' | 'host' | 'group' | 'endpoint';
  /** KindIcon's kind. */
  kind: DeviceKind | 'internet' | 'server' | 'node' | 'endpoint';
  band: Band;
  x: number;
  y: number;
  name: string;
  sub: string;
  tone: Tone;
  /** The node it reaches the Internet through (the Internet node for a gateway). */
  parent: string | null;
  /** Open problems on it. */
  alerts: number;
  /** Endpoints seen behind it (a device), or in it (a group). */
  behind: number;
  device?: MapDevice;
  host?: NodeRef & { endpoints: Endpoint[] };
  group?: { deviceId: string; endpoints: Endpoint[] };
  endpoint?: Endpoint;
}

export type MeshLink = MapData['mesh'][number];
export type IscsiSession = MapData['iscsi'][number];

export interface MapEdge {
  id: string;
  type: 'link' | 'internet' | 'endpoint' | 'mesh';
  from: string;
  to: string;
  link?: Link;
  /** Wireless backhaul between two access points: dotted, with its signal and rate. */
  mesh?: MeshLink;
  /** A server's or node's switch port is down (ADR-233): drawn red and dashed. */
  down?: boolean;
  /** Sideways offset in px, so parallel links between the same two devices stay apart. */
  offset: number;
}

export interface MapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  byId: Map<string, MapNode>;
  /** The y of each band that has nodes, for its label. */
  bands: { band: Band; y: number }[];
}

export interface LayoutOptions {
  /** The endpoints layer: unknown endpoints (not a WatchLog server or node) shown. */
  endpoints: boolean;
  /** Devices whose unknown endpoints are shown one by one instead of as one bubble. */
  expanded?: ReadonlySet<string>;
}

/** Horizontal room per node, and the bands' and Devices rows' heights. */
export const SLOT = 132;
export const BAND_Y: Record<Band, number> = { 0: 0, 1: 140, 2: 280, 3: 420, 4: 570 };
export const ROW = 112;
/** Leaves per row under one device. */
export const COLS = 4;
/** More unknown endpoints than this on one device become one "+N more" bubble. */
export const GROUP_OVER = 3;

export const INTERNET = 'internet';
export const deviceNodeId = (id: string) => `d:${id}`;
export const hostNodeId = (n: Pick<NodeRef, 'kind' | 'clusterId' | 'name'>) =>
  `h:${n.kind}:${n.clusterId}:${n.name}`;
export const groupNodeId = (deviceId: string) => `g:${deviceId}`;
export const endpointNodeId = (mac: string) => `e:${mac}`;
export const linkEdgeId = (linkId: string) => `l:${linkId}`;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function layoutMap(data: MapData, opts: LayoutOptions): MapLayout {
  const expanded = opts.expanded ?? new Set<string>();
  const devices = [...data.devices].sort(byName);
  const devById = new Map(devices.map((d) => [d.id, d]));
  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const children = new Map<string, string[]>();
  const addChild = (parent: string, id: string) => {
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  };

  for (const d of devices) {
    const band = bandOf(d.kind);
    nodes.set(deviceNodeId(d.id), {
      id: deviceNodeId(d.id),
      type: 'device',
      kind: d.kind,
      band,
      x: 0,
      y: BAND_Y[band],
      name: d.name,
      sub: d.model,
      tone: statusTone(d.status, d.openAlerts),
      parent: null,
      alerts: d.openAlerts,
      behind: 0,
      device: d,
    });
  }

  // Links between known devices; parallel ones get offsets around the centre line.
  const adjacent = new Map<string, Set<string>>();
  const pairs = new Map<string, Link[]>();
  for (const l of data.links) {
    if (!devById.has(l.a.deviceId) || !devById.has(l.b.deviceId)) continue;
    if (l.a.deviceId === l.b.deviceId) continue;
    const [p, q] = [l.a.deviceId, l.b.deviceId].sort() as [string, string];
    const key = `${p}|${q}`;
    pairs.set(key, [...(pairs.get(key) ?? []), l]);
    for (const [x, y] of [
      [p, q],
      [q, p],
    ] as const) {
      const set = adjacent.get(x) ?? new Set<string>();
      set.add(y);
      adjacent.set(x, set);
    }
  }
  for (const list of pairs.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    list.forEach((l, i) =>
      edges.push({
        id: linkEdgeId(l.id),
        type: 'link',
        from: deviceNodeId(l.a.deviceId),
        to: deviceNodeId(l.b.deviceId),
        link: l,
        offset: (i - (list.length - 1) / 2) * 7,
      }),
    );
  }

  // Each device's parent: the way it reaches the Internet, by fewest hops from the gateways
  // (the routers with a default gateway); among equal choices the higher band, then the name.
  const rank = (id: string) => {
    const d = devById.get(id)!;
    return [bandOf(d.kind), d.name] as const;
  };
  const before = (a: string, b: string) => {
    const [ba, na] = rank(a);
    const [bb, nb] = rank(b);
    return ba !== bb ? ba - bb : na < nb ? -1 : na > nb ? 1 : 0;
  };
  const gateways = devices.filter((d) => d.gateway).map((d) => d.id);
  const dist = new Map<string, number>();
  const parentOf = new Map<string, string>();
  const roots: string[] = [];
  const walk = (sources: string[]) => {
    let wave = sources;
    for (const s of sources) dist.set(s, 0);
    roots.push(...sources);
    let depth = 0;
    while (wave.length) {
      const next: string[] = [];
      for (const u of wave)
        for (const v of adjacent.get(u) ?? [])
          if (!dist.has(v)) {
            dist.set(v, depth + 1);
            next.push(v);
          }
      for (const v of next) {
        let best: string | undefined;
        for (const u of adjacent.get(v) ?? [])
          if (dist.get(u) === depth && (!best || before(u, best) < 0)) best = u;
        if (best) parentOf.set(v, best);
      }
      wave = next.sort(before);
      depth++;
    }
  };
  if (gateways.length) walk([...gateways].sort(before));
  else if (devices.length) {
    const top = Math.min(...devices.map((d) => bandOf(d.kind)));
    walk(
      devices
        .filter((d) => bandOf(d.kind) === top)
        .map((d) => d.id)
        .sort(before),
    );
  }
  // Wireless backhaul: one dotted edge per pair of access points. An access point with no wired
  // link reaches the network through its mesh peer: it hangs where the peer hangs, next to it.
  const meshPeers = new Map<string, string[]>();
  const meshPairs = new Set<string>();
  for (const m of data.mesh ?? []) {
    if (!devById.has(m.fromId) || !devById.has(m.toId) || m.fromId === m.toId) continue;
    const key = [m.fromId, m.toId].sort().join('|');
    if (meshPairs.has(key)) continue;
    meshPairs.add(key);
    meshPeers.set(m.fromId, [...(meshPeers.get(m.fromId) ?? []), m.toId]);
    meshPeers.set(m.toId, [...(meshPeers.get(m.toId) ?? []), m.fromId]);
    edges.push({
      id: `m:${key}`,
      type: 'mesh',
      from: deviceNodeId(m.fromId),
      to: deviceNodeId(m.toId),
      mesh: m,
      offset: 0,
    });
  }
  const meshAnchor = new Map<string, string>();
  const meshOnly = (id: string) => !adjacent.has(id) && meshPeers.has(id);
  const anchor = () => {
    for (let grew = true; grew;) {
      grew = false;
      for (const d of devices) {
        if (dist.has(d.id) || !meshOnly(d.id)) continue;
        const peer = meshPeers
          .get(d.id)!
          .filter((p) => dist.has(p))
          .sort(before)[0];
        if (!peer) continue;
        dist.set(d.id, dist.get(peer)! + 1);
        meshAnchor.set(d.id, peer);
        grew = true;
      }
    }
  };
  anchor();
  // Islands (no way to a gateway) get their own trees; mesh-only access points wait for theirs.
  const rest = [...devices].sort((a, b) => before(a.id, b.id));
  for (const d of rest)
    if (!dist.has(d.id) && !meshOnly(d.id)) {
      walk([d.id]);
      anchor();
    }
  for (const d of rest)
    if (!dist.has(d.id)) {
      walk([d.id]);
      anchor();
    }

  const hasInternet = gateways.length > 0;
  if (hasInternet) {
    nodes.set(INTERNET, {
      id: INTERNET,
      type: 'internet',
      kind: 'internet',
      band: 0,
      x: 0,
      y: BAND_Y[0],
      name: '',
      sub: '',
      tone: 'neutral',
      parent: null,
      alerts: 0,
      behind: 0,
    });
    for (const g of gateways)
      edges.push({
        id: `i:${g}`,
        type: 'internet',
        from: INTERNET,
        to: deviceNodeId(g),
        offset: 0,
      });
  }
  // Where each node is placed (its block of leaves or subtrees): its parent's, except a
  // mesh-only access point, which is placed beside its peer, sorted right after it.
  const placedUnder = new Map<string, string>();
  const sortName = new Map<string, string>();
  for (const d of devices) {
    const node = nodes.get(deviceNodeId(d.id))!;
    const p = parentOf.get(d.id);
    if (p) {
      node.parent = deviceNodeId(p);
      placedUnder.set(node.id, node.parent);
      addChild(node.parent, node.id);
    } else if (d.gateway && hasInternet) node.parent = INTERNET;
  }
  for (const [apId, peerId] of meshAnchor) {
    const node = nodes.get(deviceNodeId(apId))!;
    const peer = nodes.get(deviceNodeId(peerId))!;
    node.parent = peer.id;
    const under = placedUnder.get(peer.id) ?? peer.id;
    placedUnder.set(node.id, under);
    sortName.set(node.id, `${sortName.get(peer.id) ?? peer.name}\u0001${node.name}`);
    addChild(under, node.id);
  }

  // Endpoints: WatchLog servers and nodes always, as one node each (under the most
  // access-side device they're seen on); the rest with the endpoints layer.
  const unknown = new Map<string, Endpoint[]>();
  const hosts = new Map<string, MapNode & { host: NodeRef & { endpoints: Endpoint[] } }>();
  for (const e of data.endpoints) {
    const dev = devById.get(e.deviceId);
    if (!dev) continue;
    nodes.get(deviceNodeId(dev.id))!.behind++;
    if (e.node) {
      const id = hostNodeId(e.node);
      const h = hosts.get(id);
      if (h) h.host.endpoints.push(e);
      else
        hosts.set(id, {
          id,
          type: 'host',
          kind: e.node.kind === 'kubernetes' ? 'node' : 'server',
          band: 4,
          x: 0,
          y: BAND_Y[4],
          name: e.node.name,
          sub: e.node.cluster,
          tone: 'neutral',
          parent: null,
          alerts: 0,
          behind: 0,
          host: { ...e.node, endpoints: [e] },
        });
    } else if (opts.endpoints) {
      const list = unknown.get(dev.id);
      if (list) list.push(e);
      else unknown.set(dev.id, [e]);
    }
  }
  for (const h of [...hosts.values()].sort(byName)) {
    const seenOn = [...new Set(h.host.endpoints.map((e) => e.deviceId))].sort((a, b) =>
      before(b, a),
    );
    h.parent = deviceNodeId(seenOn[0]!);
    nodes.set(h.id, h);
    addChild(h.parent, h.id);
    for (const dId of seenOn)
      edges.push({
        id: `x:${dId}>${h.id}`,
        type: 'endpoint',
        from: deviceNodeId(dId),
        to: h.id,
        offset: 0,
        ...(h.host.endpoints.some((e) => e.deviceId === dId && e.portUp === false)
          ? { down: true }
          : {}),
      });
  }
  for (const [dId, list] of [...unknown.entries()].sort(([a], [b]) => before(a, b))) {
    const parent = deviceNodeId(dId);
    list.sort((a, b) => (a.port + a.mac < b.port + b.mac ? -1 : 1));
    if (list.length > GROUP_OVER && !expanded.has(dId)) {
      const id = groupNodeId(dId);
      nodes.set(id, {
        id,
        type: 'group',
        kind: 'endpoint',
        band: 4,
        x: 0,
        y: BAND_Y[4],
        name: '',
        sub: '',
        tone: 'neutral',
        parent,
        alerts: 0,
        behind: list.length,
        group: { deviceId: dId, endpoints: list },
      });
      addChild(parent, id);
      edges.push({ id: `x:${dId}>${id}`, type: 'endpoint', from: parent, to: id, offset: 0 });
      continue;
    }
    for (const e of list) {
      const id = endpointNodeId(e.mac);
      if (nodes.has(id)) continue;
      nodes.set(id, {
        id,
        type: 'endpoint',
        kind: 'endpoint',
        band: 4,
        x: 0,
        y: BAND_Y[4],
        name: e.ip ?? e.mac,
        sub: e.vendor || e.port,
        tone: 'neutral',
        parent,
        alerts: 0,
        behind: 0,
        endpoint: e,
      });
      addChild(parent, id);
      edges.push({ id: `x:${dId}>${id}`, type: 'endpoint', from: parent, to: id, offset: 0 });
    }
  }

  // Widths in slots, then left to right: a device's leaves (Devices-band children without
  // children of their own) in a block of up to COLS per row, then its subtrees.
  const kids = (id: string) => children.get(id) ?? [];
  const isLeaf = (id: string) => nodes.get(id)!.band === 4 && !kids(id).length;
  const order = (id: string) => {
    const list = kids(id);
    const leaves = list.filter(isLeaf).sort((a, b) => leafRank(a) - leafRank(b) || cmp(a, b, true));
    const subs = list.filter((c) => !isLeaf(c)).sort((a, b) => cmp(a, b));
    return { leaves, subs };
  };
  const leafRank = (id: string) => {
    const t = nodes.get(id)!.type;
    return t === 'device' ? 0 : t === 'host' ? 1 : t === 'endpoint' ? 2 : 3;
  };
  const cmp = (a: string, b: string, beside = false) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    if (na.band !== nb.band) return na.band - nb.band;
    const sa = (beside && sortName.get(a)) || na.name;
    const sb = (beside && sortName.get(b)) || nb.name;
    return sa < sb ? -1 : sa > sb ? 1 : a < b ? -1 : 1;
  };
  const width = new Map<string, number>();
  const measure = (id: string): number => {
    const { leaves, subs } = order(id);
    let w = Math.min(leaves.length, COLS);
    for (const s of subs) w += measure(s);
    w = Math.max(1, w);
    width.set(id, w);
    return w;
  };
  const place = (id: string, left: number) => {
    const node = nodes.get(id)!;
    const { leaves, subs } = order(id);
    let cursor = left;
    const cols = Math.min(leaves.length, COLS);
    if (leaves.length) {
      const top = node.band === 4 ? node.y + ROW : BAND_Y[4];
      leaves.forEach((c, i) => {
        const leaf = nodes.get(c)!;
        leaf.x = (cursor + (i % COLS) + 0.5) * SLOT;
        leaf.y = top + Math.floor(i / COLS) * ROW;
      });
      cursor += cols;
    }
    for (const s of subs) {
      place(s, cursor);
      cursor += width.get(s)!;
    }
    node.x = (left + width.get(id)! / 2) * SLOT;
  };
  const treeRoots = roots.map(deviceNodeId);
  let cursor = 0;
  for (const r of treeRoots) {
    if (placedUnder.has(r)) continue;
    measure(r);
    place(r, cursor);
    cursor += width.get(r)!;
  }

  // A device under another one of its own band (switches daisy-chained) can land on it:
  // push each band apart left to right, then centre the band back on where it wanted to be.
  for (const band of [1, 2, 3, 4] as Band[]) {
    const row = [...nodes.values()].filter(
      (n) => n.type === 'device' && n.band === band && !(band === 4 && isLeaf(n.id)),
    );
    if (row.length < 2) continue;
    row.sort((a, b) => a.x - b.x);
    const wanted = row.map((n) => n.x);
    for (let i = 1; i < row.length; i++) row[i]!.x = Math.max(row[i]!.x, row[i - 1]!.x + SLOT);
    let moved = 0;
    row.forEach((n, i) => (moved += n.x - wanted[i]!));
    const shift = Math.min(0, -moved / row.length);
    if (shift) for (const n of row) n.x += shift;
  }

  if (hasInternet) {
    const xs = gateways.map((g) => nodes.get(deviceNodeId(g))!.x);
    nodes.get(INTERNET)!.x = xs.reduce((s, x) => s + x, 0) / xs.length;
  }

  const list = [...nodes.values()];
  const bands = ([0, 1, 2, 3, 4] as Band[])
    .filter((b) => list.some((n) => n.band === b))
    .map((band) => ({ band, y: BAND_Y[band] }));
  return { nodes: list, edges, byId: nodes, bands };
}

/** What stays bright when a node or link is picked: its way up to the Internet, and below. */
export function focusOf(
  layout: MapLayout,
  sel: { type: 'node' | 'link'; id: string },
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const up = (id: string | null) => {
    for (let c = id; c && !nodes.has(c); c = layout.byId.get(c)?.parent ?? null) nodes.add(c);
  };
  const below = new Map<string, string[]>();
  for (const n of layout.nodes)
    if (n.parent) below.set(n.parent, [...(below.get(n.parent) ?? []), n.id]);
  const down = (id: string) => {
    for (const c of below.get(id) ?? [])
      if (!nodes.has(c)) {
        nodes.add(c);
        down(c);
      }
  };
  const edges = new Set<string>();
  if (sel.type === 'node') {
    up(sel.id);
    down(sel.id);
  } else {
    const e = layout.edges.find((x) => x.id === sel.id);
    if (e) {
      up(e.from);
      up(e.to);
      edges.add(e.id);
    }
  }
  for (const e of layout.edges) if (nodes.has(e.from) && nodes.has(e.to)) edges.add(e.id);
  return { nodes, edges };
}

/** A link's stroke width by its speed: 100M thin … 10G and more thick. */
export function linkWidth(speedMbps: number | null): number {
  if (!speedMbps || speedMbps <= 100) return 1.5;
  if (speedMbps < 2000) return 2.5;
  if (speedMbps < 10000) return 3.5;
  return 5;
}

export function linkTone(l: Link): 'ok' | 'warning' | 'critical' {
  return l.state === 'down' ? 'critical' : l.state === 'warn' ? 'warning' : 'ok';
}

/**
 * The moving dashes for a link's traffic: their direction (1: A to B, the busier way) and one
 * dash cycle's duration in seconds, shorter the more bits per second; none when it's down
 * or idle.
 */
export function flowOf(l: Link): { dir: 1 | -1; dur: number } | null {
  if (l.state === 'down') return null;
  const ab = l.bpsAB ?? 0;
  const ba = l.bpsBA ?? 0;
  const bps = Math.max(ab, ba);
  if (bps <= 0) return null;
  const dur = Math.min(2.8, Math.max(0.4, 2.8 - (Math.log10(bps) - 4) * 0.4));
  return { dir: ab >= ba ? 1 : -1, dur: Math.round(dur * 100) / 100 };
}

export interface SearchHit {
  /** The node to focus; for an unknown endpoint, shown once its device is expanded. */
  nodeId: string;
  /** The device to expand for an unknown endpoint. */
  expand: string | null;
  label: string;
  detail: string;
  kind: 'device' | 'server' | 'node' | 'endpoint';
}

const macKey = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '');

/** Devices and endpoints by name, IP, MAC (any separators) or model; starts-with first. */
export function searchMap(data: MapData, query: string, limit = 8): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qMac = macKey(q);
  const score = (fields: (string | null | undefined)[], mac?: string): number => {
    let best = 0;
    for (const f of fields) {
      const v = (f ?? '').toLowerCase();
      if (!v) continue;
      if (v === q) return 3;
      if (v.startsWith(q)) best = Math.max(best, 2);
      else if (v.includes(q)) best = Math.max(best, 1);
    }
    if (mac && qMac.length >= 4) {
      const m = macKey(mac);
      if (m.startsWith(qMac)) best = Math.max(best, 2);
      else if (m.includes(qMac)) best = Math.max(best, 1);
    }
    return best;
  };
  const hits: (SearchHit & { s: number; o: number })[] = [];
  for (const d of data.devices) {
    const s = score([d.name, d.address, d.model]);
    if (s)
      hits.push({
        nodeId: deviceNodeId(d.id),
        expand: null,
        label: d.name,
        detail: d.address,
        kind: 'device',
        s,
        o: 0,
      });
  }
  const names = new Map(data.devices.map((d) => [d.id, d.name]));
  const seen = new Set<string>();
  for (const e of data.endpoints) {
    if (!names.has(e.deviceId)) continue;
    const s = score([e.ip, e.node?.name, e.vendor], e.mac);
    if (!s) continue;
    const nodeId = e.node ? hostNodeId(e.node) : endpointNodeId(e.mac);
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    hits.push({
      nodeId,
      expand: e.node ? null : e.deviceId,
      label: e.node?.name ?? e.ip ?? e.mac,
      detail: `${names.get(e.deviceId)} · ${e.port}`,
      kind: e.node ? (e.node.kind === 'kubernetes' ? 'node' : 'server') : 'endpoint',
      s,
      o: 1,
    });
  }
  return hits
    .sort((a, b) => b.s - a.s || a.o - b.o || (a.label < b.label ? -1 : 1))
    .slice(0, limit)
    .map((h) => ({
      nodeId: h.nodeId,
      expand: h.expand,
      label: h.label,
      detail: h.detail,
      kind: h.kind,
    }));
}

export interface IscsiPath {
  key: string;
  recorderId: string;
  nasId: string;
  /** The recorder's disk and the NAS's LUN. */
  disk: string;
  lun: string;
  connected: boolean;
  /** The map's edge ids along the path (linkEdgeId). */
  edges: string[];
}

/**
 * The iSCSI layer (ADR-234): each recorder → NAS session and the map edges its traffic takes;
 * the edge state per edge, a lost session winning over a connected one that shares a link.
 */
export function iscsiPaths(data: MapData): {
  paths: IscsiPath[];
  edges: Map<string, 'ok' | 'lost'>;
  nodes: Set<string>;
} {
  const paths: IscsiPath[] = [];
  const edges = new Map<string, 'ok' | 'lost'>();
  const nodes = new Set<string>();
  for (const s of data.iscsi ?? []) {
    const ids = (s.path?.links ?? []).map(linkEdgeId);
    paths.push({
      key: `${s.recorderId}|${s.nasId}|${s.disk}|${s.lun}`,
      recorderId: s.recorderId,
      nasId: s.nasId,
      disk: s.disk,
      lun: s.lun,
      connected: s.connected,
      edges: ids,
    });
    for (const id of ids)
      if (!s.connected || !edges.has(id)) edges.set(id, s.connected ? 'ok' : 'lost');
    nodes.add(deviceNodeId(s.recorderId));
    nodes.add(deviceNodeId(s.nasId));
  }
  return { paths, edges, nodes };
}
