// SPDX-License-Identifier: AGPL-3.0-only
// Expected destinations (ADR-186): the matcher, and the inventory rows' copy of the
// expectation that covers them. A pattern is one of:
//   - an exact name (`api.stripe.com`), lower-cased, as the agent stores names (ADR-104);
//   - `*.` and a suffix of at least two labels (`*.amazonaws.com`): any name under it, at any
//     depth, never the suffix itself;
//   - a CIDR, at least /8 for IPv4 and /32 for IPv6, for raw networks it contains.
// No regular expressions: the pattern is parsed into one of these three shapes and compared
// label by label or bit by bit, so nothing a user types is ever compiled or run. Anything else
// is refused with a reason. Names match names (and local names), CIDRs match raw networks;
// "Internet" (beyond the agent's cap) names nothing and is never expected.
import { isIPv4, isIPv6 } from 'node:net';
import type { Database } from '../../db/index.js';
import type { DestinationClass, SourceIdentity } from './inventory.js';

/** At most this many expectations per cluster or fleet (bounds the matcher's work). */
export const EGRESS_EXPECTED_MAX = 1000;
export const EGRESS_PATTERN_MAX = 253;
const UPDATE_CHUNK = 500;

export type ParsedPattern =
  | { kind: 'name'; text: string }
  | { kind: 'suffix'; text: string; suffix: string }
  | { kind: 'cidr'; text: string; v: 4 | 6; base: bigint; prefix: number };

export type PatternResult = { ok: true; pattern: ParsedPattern } | { ok: false; reason: string };

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** A DNS name of letters, digits, `-` and `_` labels (1–63 each, 253 in all). */
function validName(name: string): boolean {
  if (!name || name.length > EGRESS_PATTERN_MAX) return false;
  return name.split('.').every((l) => LABEL.test(l));
}

function v4ToBig(addr: string): bigint {
  return addr.split('.').reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

function v6ToBig(addr: string): bigint | null {
  let a = addr;
  // An IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v = v4ToBig(tail[1]!);
    a = `${a.slice(0, -tail[1]!.length)}${(v >> 16n).toString(16)}:${(v & 0xffffn).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

function bigToV4(v: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join('.');
}

/** The canonical IPv6 text: no leading zeros, the longest run of zero groups as `::`. */
function bigToV6(v: bigint): string {
  const g = Array.from({ length: 8 }, (_, i) => Number((v >> BigInt((7 - i) * 16)) & 0xffffn));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** A network as (family, base, prefix): `1.2.3.0/24`, `2001:db8::/48`, or one address. */
function parseNetwork(text: string): { v: 4 | 6; addr: bigint; prefix: number } | null {
  const slash = text.indexOf('/');
  const addr = slash < 0 ? text : text.slice(0, slash);
  const bits = isIPv4(addr) ? 32 : isIPv6(addr) ? 128 : 0;
  if (!bits) return null;
  let prefix = bits;
  if (slash >= 0) {
    const p = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > bits) return null;
  }
  const value = bits === 32 ? v4ToBig(addr) : v6ToBig(addr);
  if (value === null) return null;
  return { v: bits === 32 ? 4 : 6, addr: value, prefix };
}

const maskOf = (bits: number, prefix: number) =>
  prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);

/** Parses what someone typed into one of the three shapes, or says why it can't be one. */
export function parsePattern(input: string): PatternResult {
  const raw = input.trim().toLowerCase().replace(/\.$/, '');
  if (!raw) return { ok: false, reason: 'Type a name, a *. pattern or a CIDR' };
  if (raw.length > EGRESS_PATTERN_MAX) {
    return { ok: false, reason: `At most ${EGRESS_PATTERN_MAX} characters` };
  }
  const slash = raw.indexOf('/');
  const addrPart = slash < 0 ? raw : raw.slice(0, slash);
  if (isIPv4(addrPart) || isIPv6(addrPart)) {
    const n = parseNetwork(raw);
    if (!n) return { ok: false, reason: 'Not a valid CIDR' };
    const bits = n.v === 4 ? 32 : 128;
    const min = n.v === 4 ? 8 : 32;
    if (slash < 0) {
      return {
        ok: false,
        reason:
          n.v === 4
            ? 'Raw destinations are /24 networks: write it as a CIDR, such as 203.0.113.0/24'
            : 'Raw destinations are /48 networks: write it as a CIDR, such as 2001:db8:1::/48',
      };
    }
    if (n.prefix < min) {
      return {
        ok: false,
        reason: `A CIDR is at least /${min} for IPv${n.v}: this covers too much`,
      };
    }
    const base = n.addr & maskOf(bits, n.prefix);
    const text = `${n.v === 4 ? bigToV4(base) : bigToV6(base)}/${n.prefix}`;
    return { ok: true, pattern: { kind: 'cidr', text, v: n.v, base, prefix: n.prefix } };
  }
  if (raw.startsWith('*.')) {
    const suffix = raw.slice(2);
    if (!validName(suffix)) {
      return { ok: false, reason: 'After *. comes a DNS name, such as *.amazonaws.com' };
    }
    if (!suffix.includes('.')) {
      return {
        ok: false,
        reason: `*.${suffix} covers too much: give at least two labels, such as *.example.${suffix}`,
      };
    }
    return { ok: true, pattern: { kind: 'suffix', text: raw, suffix } };
  }
  if (raw.includes('*')) {
    return { ok: false, reason: 'Only a leading *. is allowed, such as *.amazonaws.com' };
  }
  if (!validName(raw)) {
    return { ok: false, reason: 'Not a DNS name: letters, digits, - and _ between dots' };
  }
  return { ok: true, pattern: { kind: 'name', text: raw } };
}

/** Does a pattern cover a destination of this class? */
export function patternMatches(
  p: ParsedPattern,
  destination: string,
  cls: DestinationClass | string,
): boolean {
  if (cls === 'internet') return false;
  const isNetwork = cls === 'public_network' || cls === 'private_network';
  if (p.kind === 'cidr') {
    if (!isNetwork) return false;
    const n = parseNetwork(destination);
    if (!n || n.v !== p.v || n.prefix < p.prefix) return false;
    const bits = p.v === 4 ? 32 : 128;
    return (n.addr & maskOf(bits, p.prefix)) === p.base;
  }
  if (isNetwork) return false;
  const name = destination.toLowerCase();
  if (p.kind === 'name') return name === p.text;
  return name.endsWith(`.${p.suffix}`);
}

export interface Expectation {
  id: string;
  pattern: string;
  port: number | null;
  source: SourceIdentity | null;
  created_by: string | null;
  created_at: Date;
  comment: string | null;
}

export type ParsedExpectation = Expectation & { parsed: ParsedPattern };

/** A source's key whatever its key order (jsonb reorders keys). */
export const identityKey = (s: SourceIdentity) =>
  JSON.stringify(
    Object.keys(s)
      .sort()
      .map((k) => [k, s[k]]),
  );

const asIdentity = (s: unknown): SourceIdentity | null =>
  s === null || s === undefined
    ? null
    : ((typeof s === 'string' ? JSON.parse(s) : s) as SourceIdentity);

export interface CoverableRow {
  source: SourceIdentity;
  destination: string;
  port: number;
  destination_class: string;
}

/** Does an expectation cover a row (its source or every source, its port or any)? */
export function covers(e: ParsedExpectation, r: CoverableRow): boolean {
  if (e.port !== null && e.port !== r.port) return false;
  if (e.source && identityKey(e.source) !== identityKey(r.source)) return false;
  return patternMatches(e.parsed, r.destination, r.destination_class);
}

/** How specific an expectation is: one source, one port, exact, longer suffix, longer prefix. */
function specificity(e: ParsedExpectation): number[] {
  const p = e.parsed;
  return [
    e.source ? 1 : 0,
    e.port !== null ? 1 : 0,
    p.kind === 'name' ? 1 : 0,
    p.kind === 'suffix' ? p.suffix.length : p.kind === 'cidr' ? p.prefix : 0,
    -e.created_at.getTime(),
  ];
}

/** The most specific expectation covering a row, or null. */
export function bestExpectation(
  list: ParsedExpectation[],
  r: CoverableRow,
): ParsedExpectation | null {
  let best: ParsedExpectation | null = null;
  let bestSpec: number[] = [];
  for (const e of list) {
    if (!covers(e, r)) continue;
    const s = specificity(e);
    const i = s.findIndex((v, j) => v !== bestSpec[j]);
    if (!best || (i >= 0 && s[i]! > bestSpec[i]!)) {
      best = e;
      bestSpec = s;
    }
  }
  return best;
}

/** A cluster's expectations, parsed (a row that no longer parses is skipped). */
export async function loadExpectations(
  db: Database,
  orgId: string,
  clusterId: string,
): Promise<ParsedExpectation[]> {
  const rows = await db
    .selectFrom('egress_expected')
    .select(['id', 'pattern', 'port', 'source', 'created_by', 'created_at', 'comment'])
    .where('org_id', '=', orgId)
    .where('cluster_id', '=', clusterId)
    .orderBy('created_at')
    .execute();
  const out: ParsedExpectation[] = [];
  for (const r of rows) {
    const parsed = parsePattern(r.pattern);
    if (!parsed.ok) continue;
    out.push({
      id: r.id,
      pattern: r.pattern,
      port: r.port,
      source: asIdentity(r.source),
      created_by: r.created_by,
      created_at: r.created_at,
      comment: r.comment,
      parsed: parsed.pattern,
    });
  }
  return out;
}

/** The copy an inventory row keeps of the expectation that covers it (ADR-185, ADR-186). */
export function copyOf(e: ParsedExpectation | null) {
  return {
    pattern: e?.pattern ?? null,
    approved_by: e?.created_by ?? null,
    approved_at: e?.created_at ?? null,
  };
}

/**
 * Brings every inventory row of a cluster in line with its expectations: a covered row gets
 * the most specific expectation's pattern, who marked it and when; an uncovered one gets
 * nothing. Called after each change to the expectations; the minute job fills new rows as it
 * inserts them. Returns how many rows changed.
 */
export async function syncExpected(
  db: Database,
  orgId: string,
  clusterId: string,
  list?: ParsedExpectation[],
): Promise<number> {
  const expectations = list ?? (await loadExpectations(db, orgId, clusterId));
  const rows = await db
    .selectFrom('egress_destinations')
    .select([
      'id',
      'source',
      'destination',
      'port',
      'destination_class',
      'pattern',
      'approved_by',
      'approved_at',
    ])
    .where('org_id', '=', orgId)
    .where('cluster_id', '=', clusterId)
    .execute();
  const groups = new Map<string, { copy: ReturnType<typeof copyOf>; ids: string[] }>();
  for (const r of rows) {
    const source = asIdentity(r.source)!;
    const copy = copyOf(bestExpectation(expectations, { ...r, source }));
    if (
      copy.pattern === r.pattern &&
      copy.approved_by === r.approved_by &&
      (copy.approved_at?.getTime() ?? null) === (r.approved_at?.getTime() ?? null)
    )
      continue;
    const k = JSON.stringify(copy);
    if (!groups.has(k)) groups.set(k, { copy, ids: [] });
    groups.get(k)!.ids.push(r.id);
  }
  let changed = 0;
  for (const { copy, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      const chunk = ids.slice(i, i + UPDATE_CHUNK);
      await db
        .updateTable('egress_destinations')
        .set(copy)
        .where('org_id', '=', orgId)
        .where('cluster_id', '=', clusterId)
        .where('id', 'in', chunk)
        .execute();
      changed += chunk.length;
    }
  }
  return changed;
}
