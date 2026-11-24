// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Links and endpoints from what the switches and routers report (ADR-233). Pure, so the
// merge is tested on generated reports.
//
// A link is two ports of two WatchLog devices. It is learnt from CDP, LLDP or MNDP on either
// end (both ends report the same link: one row, the protocols joined), or, for switches that
// speak none of them, from the MAC tables: A sees B's address behind port P and B sees A's
// behind port Q, and neither port already has a learnt link.
//
// An endpoint is any other MAC address: placed on the one port nearest it, the port that
// isn't a link to another device and, of those, sees the fewest addresses (an unmanaged
// switch or an AP behind a port puts several there; the desk is behind the port anyway).

/** A device as the merge sees it. */
export interface DevRef {
  id: string;
  name: string;
  sysName: string;
  address: string;
  /** Its own MAC addresses (ports, chassis), lower-case. */
  macs: Set<string>;
  ports: { name: string; descr: string; alias: string }[];
}

export interface NeighbourIn {
  deviceId: string;
  localPort: string;
  protocol: string;
  remoteName?: string;
  remotePort?: string;
  remoteAddr?: string;
  remoteMac?: string;
}

export interface MacIn {
  deviceId: string;
  port: string;
  mac: string;
  vlan?: number;
}

export interface ArpIn {
  mac: string;
  ip: string;
}

export interface LinkOut {
  aDevice: string;
  aPort: string;
  bDevice: string;
  bPort: string;
  via: string[];
}

export interface EndpointOut {
  mac: string;
  ip: string | null;
  deviceId: string;
  port: string;
  vlan: number | null;
}

const LONG: [RegExp, string][] = [
  [/^hundredgig(abit)?e(thernet)?/i, 'hu'],
  [/^fortygig(abit)?e(thernet)?/i, 'fo'],
  [/^twentyfivegig(abit)?e(thernet)?/i, 'twe'],
  [/^tengig(abit)?e(thernet)?/i, 'te'],
  [/^gigabitethernet/i, 'gi'],
  [/^fastethernet/i, 'fa'],
  [/^port-channel/i, 'po'],
  [/^ethernet/i, 'eth'],
];

/** A port name in one spelling: "GigabitEthernet1/0/14", "Gi1/0/14", "gi1/0/14" → "gi1/0/14". */
export function portKey(name: string): string {
  let s = name.trim().toLowerCase().replace(/\s+/g, '');
  for (const [re, short] of LONG) {
    if (re.test(s)) {
      s = s.replace(re, short);
      break;
    }
  }
  return s;
}

/** A host name without its domain or a serial in brackets: "core-1.lan(FOX1)" → "core-1". */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\(.*$/, '').split('.')[0] ?? '';
}

/** The device a neighbour names: by address, MAC, then name. */
export function resolveDevice(devs: DevRef[], n: NeighbourIn): DevRef | undefined {
  if (n.remoteAddr) {
    const d = devs.find((d) => d.address === n.remoteAddr);
    if (d) return d;
  }
  if (n.remoteMac) {
    const m = n.remoteMac.toLowerCase();
    const d = devs.find((d) => d.macs.has(m));
    if (d) return d;
  }
  if (n.remoteName) {
    const k = nameKey(n.remoteName);
    return devs.find((d) => nameKey(d.sysName) === k || nameKey(d.name) === k);
  }
  return undefined;
}

/** The port of a device a name means, in the device's own spelling. */
export function resolvePort(d: DevRef, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const k = portKey(name);
  const p =
    d.ports.find((p) => portKey(p.name) === k) ??
    d.ports.find((p) => portKey(p.descr) === k) ??
    d.ports.find((p) => p.alias && portKey(p.alias) === k);
  return p?.name;
}

/** Links from neighbour tables and MAC tables, merged from both ends. */
export function mergeLinks(devs: DevRef[], neighbours: NeighbourIn[], macs: MacIn[]): LinkOut[] {
  const byId = new Map(devs.map((d) => [d.id, d]));
  const out = new Map<string, LinkOut>();
  const linkedPorts = new Set<string>();
  const add = (aDev: string, aPort: string, bDev: string, bPort: string, via: string) => {
    // One row per pair: the lower device id first.
    const [x, y] =
      aDev < bDev
        ? [
            [aDev, aPort],
            [bDev, bPort],
          ]
        : [
            [bDev, bPort],
            [aDev, aPort],
          ];
    const key = `${x[0]}/${x[1]}|${y[0]}/${y[1]}`;
    const l = out.get(key);
    if (l) {
      if (!l.via.includes(via)) l.via = [...l.via, via].sort();
    } else {
      out.set(key, { aDevice: x[0]!, aPort: x[1]!, bDevice: y[0]!, bPort: y[1]!, via: [via] });
    }
    linkedPorts.add(`${aDev}/${aPort}`);
    linkedPorts.add(`${bDev}/${bPort}`);
  };
  for (const n of neighbours) {
    const a = byId.get(n.deviceId);
    if (!a) continue;
    const aPort = resolvePort(a, n.localPort) ?? n.localPort;
    const b = resolveDevice(devs, n);
    if (!b || b.id === a.id) continue;
    const bPort = resolvePort(b, n.remotePort);
    if (!bPort) continue;
    add(a.id, aPort, b.id, bPort, n.protocol);
  }
  // MAC tables: both ends see each other, on ports without a learnt link.
  const seen = new Map<string, Map<string, Set<string>>>(); // device → mac → ports
  const count = new Map<string, number>(); // device/port → addresses
  for (const m of macs) {
    const mac = m.mac.toLowerCase();
    let d = seen.get(m.deviceId);
    if (!d) seen.set(m.deviceId, (d = new Map()));
    let s = d.get(mac);
    if (!s) d.set(mac, (s = new Set()));
    s.add(m.port);
    count.set(`${m.deviceId}/${m.port}`, (count.get(`${m.deviceId}/${m.port}`) ?? 0) + 1);
  }
  const portSeeing = (a: DevRef, b: DevRef): string | undefined => {
    const table = seen.get(a.id);
    if (!table) return undefined;
    const ports = new Set<string>();
    for (const mac of b.macs) for (const p of table.get(mac) ?? []) ports.add(p);
    const free = [...ports].filter((p) => !linkedPorts.has(`${a.id}/${p}`));
    free.sort((x, y) => (count.get(`${a.id}/${x}`) ?? 0) - (count.get(`${a.id}/${y}`) ?? 0));
    return free[0];
  };
  const pairs: [DevRef, string, DevRef, string, number][] = [];
  for (let i = 0; i < devs.length; i++) {
    for (let j = i + 1; j < devs.length; j++) {
      const a = devs[i]!;
      const b = devs[j]!;
      const p = portSeeing(a, b);
      const q = portSeeing(b, a);
      if (p && q)
        pairs.push([
          a,
          p,
          b,
          q,
          (count.get(`${a.id}/${p}`) ?? 0) + (count.get(`${b.id}/${q}`) ?? 0),
        ]);
    }
  }
  // The pairs whose ports see the fewest addresses are the direct ones; a port is used once.
  pairs.sort((x, y) => x[4] - y[4]);
  for (const [a, p, b, q] of pairs) {
    if (linkedPorts.has(`${a.id}/${p}`) || linkedPorts.has(`${b.id}/${q}`)) continue;
    add(a.id, p, b.id, q, 'mac');
  }
  return [...out.values()].sort((x, y) =>
    `${x.aDevice}${x.aPort}${x.bDevice}`.localeCompare(`${y.aDevice}${y.aPort}${y.bDevice}`),
  );
}

/** Endpoints: every address that isn't a device's, on the port nearest it. */
export function placeEndpoints(
  devs: DevRef[],
  links: LinkOut[],
  macs: MacIn[],
  arp: ArpIn[],
): EndpointOut[] {
  const own = new Set<string>();
  for (const d of devs) for (const m of d.macs) own.add(m);
  const linkPorts = new Set<string>();
  for (const l of links) {
    linkPorts.add(`${l.aDevice}/${l.aPort}`);
    linkPorts.add(`${l.bDevice}/${l.bPort}`);
  }
  const count = new Map<string, number>();
  for (const m of macs)
    count.set(`${m.deviceId}/${m.port}`, (count.get(`${m.deviceId}/${m.port}`) ?? 0) + 1);
  const ipOf = new Map<string, string>();
  for (const a of arp) if (!ipOf.has(a.mac.toLowerCase())) ipOf.set(a.mac.toLowerCase(), a.ip);
  const best = new Map<string, MacIn>();
  for (const m of macs) {
    const mac = m.mac.toLowerCase();
    if (own.has(mac) || linkPorts.has(`${m.deviceId}/${m.port}`)) continue;
    const b = best.get(mac);
    const n = count.get(`${m.deviceId}/${m.port}`) ?? 0;
    if (!b || n < (count.get(`${b.deviceId}/${b.port}`) ?? 0)) best.set(mac, m);
  }
  return [...best.entries()]
    .map(([mac, m]) => ({
      mac,
      ip: ipOf.get(mac) ?? null,
      deviceId: m.deviceId,
      port: m.port,
      vlan: m.vlan ?? null,
    }))
    .sort((a, b) => a.mac.localeCompare(b.mac));
}
