// SPDX-License-Identifier: AGPL-3.0-only
// The egress policy for addresses users give us (ADR-181), Cloud only: Slack and webhook
// channel URLs, and any later server-side fetch to a user's address. Community keeps any
// http(s) URL (ADR-091 item 2): self-hosters post to their own networks.
//
// How it holds:
//   - at save time the route resolves the host and refuses (400) a URL whose host is, or
//     resolves to, an address that isn't public: loopback, private, link-local, CGNAT,
//     multicast, unspecified, documentation, benchmarking, reserved, and the cloud metadata
//     addresses; IPv4 and IPv6, IPv4-mapped and the other IPv6 forms that carry an IPv4;
//   - at send time the same check runs again, and the connection itself resolves through
//     `lookup` below, which checks every address it returns: the socket connects only to an
//     address that passed, so a DNS answer that changes between the check and the connect
//     (rebinding) can't reach an internal address;
//   - redirects are never followed (the HTTP client sets `redirect: 'error'`), and these
//     requests never go through the outbound proxy (it would resolve the name again).
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';

/** One resolved address, as `dns.lookup` with `all: true` answers. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to all its addresses (the system resolver by default; tests swap it). */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

// ---------------------------------------------------------------- address classes

/** Why an address is refused (the words in the 400), or null for a public address. */
export type BlockReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared (CGNAT)'
  | 'multicast'
  | 'unspecified'
  | 'documentation'
  | 'metadata'
  | 'reserved';

type V4Range = [base: number, bits: number, reason: BlockReason];

const v4 = (s: string): number =>
  s.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;

// Ordered: the more specific (metadata) before the range that holds it.
const V4_BLOCKED: V4Range[] = (
  [
    ['169.254.169.254', 32, 'metadata'], // AWS, GCP, Azure, OpenStack, DigitalOcean …
    ['100.100.100.200', 32, 'metadata'], // Alibaba Cloud
    ['192.0.0.192', 32, 'metadata'], // Oracle Cloud
    ['0.0.0.0', 8, 'unspecified'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'shared (CGNAT)'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local'],
    ['172.16.0.0', 12, 'private'],
    ['192.0.0.0', 24, 'reserved'],
    ['192.0.2.0', 24, 'documentation'],
    ['192.88.99.0', 24, 'reserved'],
    ['192.168.0.0', 16, 'private'],
    ['198.18.0.0', 15, 'reserved'],
    ['198.51.100.0', 24, 'documentation'],
    ['203.0.113.0', 24, 'documentation'],
    ['224.0.0.0', 4, 'multicast'],
    ['240.0.0.0', 4, 'reserved'], // and 255.255.255.255
  ] as [string, number, BlockReason][]
).map(([base, bits, reason]) => [v4(base), bits, reason]);

function classifyV4(n: number): BlockReason | null {
  for (const [base, bits, reason] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === base) return reason;
  }
  return null;
}

/** An IPv6 address as eight 16-bit groups, or null when it isn't one. */
function parseV6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  // A trailing dotted IPv4 (::ffff:10.0.0.1) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4(dotted[1]!);
    s = `${s.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const embeddedV4 = (g: number[], at: number) => ((g[at]! << 16) | g[at + 1]!) >>> 0;

function classifyV6(g: number[]): BlockReason | null {
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return 'unspecified';
  if (zeroTo(7) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d): the IPv4 decides.
  if (zeroTo(5) && g[5] === 0xffff) return classifyV4(embeddedV4(g, 6));
  if (zeroTo(4) && g[4] === 0xffff && g[5] === 0) return classifyV4(embeddedV4(g, 6));
  // IPv4-compatible (::a.b.c.d, deprecated): never a public destination.
  if (zeroTo(6)) return 'reserved';
  // NAT64's well-known prefix 64:ff9b::/96 reaches the IPv4 it carries.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return classifyV4(embeddedV4(g, 6));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'reserved'; // local-use NAT64
  // 6to4 (2002::/16) reaches the IPv4 in its next 32 bits.
  if (g[0] === 0x2002) return classifyV4(embeddedV4(g, 1));
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254)
    return 'metadata'; // AWS's IPv6 metadata endpoint fd00:ec2::254
  if ((g[0]! & 0xfe00) === 0xfc00) return 'private'; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'private'; // site-local, deprecated
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return 'documentation'; // 3fff::/20
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return 'reserved'; // discard
  // 2001::/23: IETF protocol assignments (Teredo, ORCHID, benchmarking).
  if (g[0] === 0x2001 && g[1]! < 0x0200) return 'reserved';
  // Only global unicast (2000::/3) is a destination at all.
  if ((g[0]! & 0xe000) !== 0x2000) return 'reserved';
  return null;
}

/** Why an IP address isn't a public destination, or null when it is. */
export function blockReason(address: string): BlockReason | null {
  const bare = address.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) return classifyV4(v4(bare));
  const g = parseV6(bare);
  return g ? classifyV6(g) : 'reserved';
}

// ---------------------------------------------------------------- the policy

export class EgressRefused extends Error {
  constructor(
    message: string,
    readonly reason: BlockReason | 'unresolved' | 'scheme',
  ) {
    super(message);
    this.name = 'EgressRefused';
  }
}

export type EgressCheck =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; reason: BlockReason | 'unresolved' | 'scheme'; message: string };

const describe = (host: string, address: string, reason: BlockReason) =>
  host === address
    ? `${address} is a ${reason} address`
    : `${host} resolves to ${address}, a ${reason} address`;

export class EgressPolicy {
  /** The agent for requests to users' addresses: every connection resolves through `lookup`. */
  readonly dispatcher: Dispatcher;

  constructor(
    private readonly resolve: Resolver = systemResolver,
    /** Test hook: the classification (a test lets loopback through to its own server). */
    private readonly classify: (address: string) => BlockReason | null = blockReason,
  ) {
    this.dispatcher = new Agent({ connect: { lookup: this.lookup } });
  }

  /** Resolves a host and checks every address; refused when any of them isn't public. */
  async checkHost(host: string): Promise<EgressCheck> {
    const bare = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (isIP(bare)) {
      const reason = this.classify(bare);
      return reason
        ? { ok: false, reason, message: describe(bare, bare, reason) }
        : { ok: true, addresses: [{ address: bare, family: isIP(bare) === 6 ? 6 : 4 }] };
    }
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolve(bare);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) {
      return { ok: false, reason: 'unresolved', message: `${bare} does not resolve` };
    }
    for (const a of addresses) {
      const reason = this.classify(a.address);
      if (reason) return { ok: false, reason, message: describe(bare, a.address, reason) };
    }
    return { ok: true, addresses };
  }

  /** The check for a whole URL: http(s) only, then its host. */
  async checkUrl(url: string): Promise<EgressCheck> {
    if (!URL.canParse(url)) return { ok: false, reason: 'scheme', message: 'not a valid URL' };
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: 'scheme', message: 'only http and https URLs are allowed' };
    }
    return this.checkHost(u.hostname);
  }

  /** Throws EgressRefused when the URL may not be fetched. */
  async assertUrl(url: string): Promise<void> {
    const c = await this.checkUrl(url);
    if (!c.ok) throw new EgressRefused(c.message, c.reason);
  }

  /**
   * net.connect's `lookup` for the dispatcher: resolves with the same resolver and hands the
   * socket only addresses that passed the check, so the address connected to is a checked
   * one. (IP literals skip lookup; checkUrl runs before every request for those.)
   */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    this.checkHost(hostname).then(
      (c) => {
        if (!c.ok) {
          const err = Object.assign(new EgressRefused(c.message, c.reason), {
            code: 'EGRESS_REFUSED',
          });
          callback(err as NodeJS.ErrnoException, '', 4);
          return;
        }
        const wanted = typeof options === 'object' ? options.family : options;
        const list =
          wanted === 4 || wanted === 6
            ? c.addresses.filter((a) => a.family === wanted)
            : c.addresses;
        if (list.length === 0) {
          const err = Object.assign(new Error(`${hostname}: no address of family ${wanted}`), {
            code: 'ENOTFOUND',
          });
          callback(err as NodeJS.ErrnoException, '', 4);
          return;
        }
        if (typeof options === 'object' && options.all) {
          (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, list);
        } else {
          callback(null, list[0]!.address, list[0]!.family);
        }
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, '', 4),
    );
  };

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

/** The 400's words at save time. */
export function egressMessage(c: Extract<EgressCheck, { ok: false }>): string {
  if (c.reason === 'scheme') return `This URL can't be used: ${c.message}.`;
  if (c.reason === 'unresolved') {
    return `WatchLog can't send to this URL: ${c.message}. Check the host name.`;
  }
  return `WatchLog Cloud doesn't send to internal addresses: ${c.message}. Use a public URL.`;
}
