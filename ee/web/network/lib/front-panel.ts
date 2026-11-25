// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// A device's ports as on its front (ADR-233): odd ports on top and even below, as switches
// number them, in blocks; the SFP cages to the right; one panel per stack member. The
// reference models get their own arrangement, any other model rows of ports in ifIndex order.
import type { Port } from '../api';

/** A port's colour on the panel. */
export type PortState = 'up' | 'errors' | 'down' | 'idle' | 'admin-down';

/**
 * Up; up with errors rising; down although a neighbour or a WatchLog server or node is behind
 * it (it went down: the backend's rule for ports with problems and the uplink-down alert); down
 * with nothing known behind it (not connected); shut by an administrator.
 */
export function portState(p: Port, served = false): PortState {
  if (!p.adminUp) return 'admin-down';
  if (!p.operUp) return p.neighbour || served ? 'down' : 'idle';
  return p.errorsRising ? 'errors' : 'up';
}

/** The ports a WatchLog server or node was learnt behind. */
export function servedPorts(endpoints: { port: string; node: unknown }[]): Set<string> {
  return new Set(endpoints.filter((e) => e.node != null).map((e) => e.port));
}

/** A state's look on the panel and in its legend (token classes). */
export const PORT_FILL: Record<PortState, string> = {
  up: 'border-ok/70 bg-ok/30 text-text',
  errors: 'border-warning bg-warning/45 text-text',
  down: 'border-critical bg-critical/45 text-text',
  idle: 'border-border bg-surface-3 text-text-subtle',
  'admin-down': 'border-dashed border-border-strong bg-surface-2 text-text-subtle',
};

/** Ports in pairs of columns: `top[i]` above `bottom[i]`. */
export interface PanelBlock {
  top: Port[];
  bottom: Port[];
}

export interface Panel {
  /** The stack member's number; null for a single switch. */
  member: number | null;
  /** Blocks of the main ports, left to right. */
  blocks: PanelBlock[];
  /** The SFP cages to the right; null when there are none. */
  cages: PanelBlock | null;
  /** The generic panel: rows of ports in ifIndex order instead of blocks. */
  rows: Port[][] | null;
}

export interface FrontPanel {
  /** The reference model it was drawn as, or null (generic). */
  model: string | null;
  panels: Panel[];
  /** Interfaces not on the panel: aggregates, VLANs, management ports. */
  others: Port[];
}

interface Model {
  name: string;
  match: RegExp;
  /** Main ports per member. */
  main: number;
  /** Ports per block (two rows). */
  block: number;
  /** Stacks (one panel per member, ports named Gi<member>/0/<n>). */
  stack: boolean;
  /** Its ports always carry a member number: one switch alone is still "member 1". */
  memberAlways?: boolean;
}

const MODELS: Model[] = [
  { name: 'Catalyst 2960X', match: /2960-?X/i, main: 48, block: 12, stack: true },
  { name: 'Catalyst 2960-Plus', match: /2960(\+|-?plus)/i, main: 48, block: 12, stack: false },
  { name: 'Catalyst 2960S', match: /2960-?S/i, main: 48, block: 12, stack: true },
  { name: 'Catalyst 3850', match: /3850/, main: 48, block: 12, stack: true, memberAlways: true },
  { name: 'Catalyst 9200L', match: /9200L/i, main: 48, block: 12, stack: true },
  { name: 'Catalyst 9300', match: /C?9300/i, main: 48, block: 12, stack: true, memberAlways: true },
  { name: 'Catalyst 1000', match: /C1000/i, main: 48, block: 12, stack: false },
  { name: 'Nexus 3064', match: /3064/, main: 48, block: 12, stack: false },
  { name: 'Nexus 9372PX', match: /9372PX/i, main: 48, block: 12, stack: false },
  { name: 'CCR2004-16G-2S+', match: /CCR2004-16G-2S/i, main: 16, block: 8, stack: false },
  { name: 'CCR2116-12G-4S+', match: /CCR2116-12G-4S/i, main: 13, block: 13, stack: false },
];

export function modelOf(model: string): Model | null {
  return MODELS.find((m) => m.match.test(model)) ?? null;
}

const SFP_NAME = /^(te|tengig|twe|twentyfive|fo|fortygig|hu|hundredgig|xe-|qsfp)|sfp/i;
const MGMT_NAME = /^(mgmt|management|fa0$|gi0\/0$|gigabitethernet0\/0$)/i;

/** "Gi1/0/12" → { prefix: "Gi", parts: [1, 0, 12] }; "ether3" → { "ether", [3] }. */
export function parseName(name: string): { prefix: string; parts: number[] } {
  const m = /^(.*?)(\d+(?:\/\d+)*)$/.exec(name);
  if (!m) return { prefix: name, parts: [] };
  return { prefix: m[1]!, parts: m[2]!.split('/').map(Number) };
}

/** Whether a port sits in an SFP cage: by its kind, its name, or an uplink module (Gi1/1/1). */
export function isCage(p: Port): boolean {
  if (p.kind === 'sfp' || SFP_NAME.test(p.name)) return true;
  const { parts } = parseName(p.name);
  return parts.length === 3 && parts[1]! > 0;
}

const physical = (p: Port) =>
  (p.kind === 'ethernet' || p.kind === 'sfp') && !MGMT_NAME.test(p.name);

/**
 * Front-panel order: by the name's numbers within a name prefix, the prefixes in ifIndex order
 * (a 2960-Plus's Fa0/1-48 before its Gi0/1-2).
 */
export function inPanelOrder(ports: Port[]): Port[] {
  const rank = new Map<string, number>();
  for (const p of [...ports].sort((a, b) => a.index - b.index)) {
    const { prefix } = parseName(p.name);
    if (!rank.has(prefix)) rank.set(prefix, rank.size);
  }
  return [...ports].sort((a, b) => {
    const x = parseName(a.name);
    const y = parseName(b.name);
    const r = rank.get(x.prefix)! - rank.get(y.prefix)!;
    if (r) return r;
    for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
      const d = (x.parts[i] ?? -1) - (y.parts[i] ?? -1);
      if (d) return d;
    }
    return a.index - b.index;
  });
}

/** Odd positions on top, even below: [1, 2, 3, 4] → top [1, 3], bottom [2, 4]. */
export function pairRows(ports: Port[]): PanelBlock {
  return {
    top: ports.filter((_, i) => i % 2 === 0),
    bottom: ports.filter((_, i) => i % 2 === 1),
  };
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Stack members by the first number of a three-part name; null for other names. */
export function memberOf(p: Port): number | null {
  const { parts } = parseName(p.name);
  return parts.length === 3 ? parts[0]! : null;
}

function memberPanel(ports: Port[], model: Model, member: number | null): Panel {
  const ordered = inPanelOrder(ports);
  let main = ordered.filter((p) => !isCage(p));
  let cages = ordered.filter(isCage);
  if (main.length === 0) {
    // All cages (a fixed Nexus): the first are the main block, the rest the uplinks (QSFP).
    main = ordered.slice(0, model.main);
    cages = ordered.slice(model.main);
  } else if (main.length > model.main) {
    // SFP ports named like copper ones (a 2960X's Gi1/0/49-52) are past the main count.
    cages = [...main.slice(model.main), ...cages];
    main = main.slice(0, model.main);
  }
  return {
    member,
    blocks: chunk(main, model.block).map(pairRows),
    cages: cages.length ? pairRows(cages) : null,
    rows: null,
  };
}

/** The ports in the generic arrangement: rows of `perRow` in ifIndex order. */
export function genericRows(ports: Port[], perRow = 24): Port[][] {
  return chunk(
    [...ports].sort((a, b) => a.index - b.index),
    perRow,
  );
}

export function frontPanel(model: string, ports: Port[]): FrontPanel {
  const onPanel = ports.filter(physical);
  const others = ports.filter((p) => !physical(p)).sort((a, b) => a.index - b.index);
  const m = modelOf(model);
  if (!m || !onPanel.length) {
    return {
      model: null,
      panels: onPanel.length
        ? [{ member: null, blocks: [], cages: null, rows: genericRows(onPanel) }]
        : [],
      others,
    };
  }
  const members = new Map<number | null, Port[]>();
  for (const p of onPanel) {
    const k = m.stack ? memberOf(p) : null;
    members.set(k, [...(members.get(k) ?? []), p]);
  }
  // A stack shows its member numbers; a single switch (one member, or names without one) not.
  const stacked = m.stack && (members.size > 1 || (!!m.memberAlways && !members.has(null)));
  const keys = [...members.keys()].sort((a, b) => (a ?? 0) - (b ?? 0));
  return {
    model: m.name,
    panels: keys.map((k) => memberPanel(members.get(k)!, m, stacked ? k : null)),
    others,
  };
}

export type Tone = 'ok' | 'warning' | 'critical' | 'neutral';

/** A fan's, power supply's or stack member's state as the device words it, as a tone. */
export function healthTone(state: string): Tone {
  const s = state.trim().toLowerCase();
  if (/^(ok|normal|up|on|ready|running|good|active|present)$/.test(s)) return 'ok';
  if (/fail|critical|down|shut|not ?present|removed|absent|error|bad|missing|mismatch/.test(s))
    return 'critical';
  if (/warn|degraded|high|low|marginal/.test(s)) return 'warning';
  return 'neutral';
}

/**
 * An optic's light level against its thresholds: outside them critical, within 1 dB of one a
 * warning. "-5.2 dBm" with the range "-14.0 to 0.5" when both thresholds are known.
 */
export function opticReading(
  key: string,
  dbm: number | undefined,
  low: number | undefined,
  high: number | undefined,
): { key: string; value: string; tone: Tone; range: string } {
  const range =
    low != null && high != null
      ? `${low.toFixed(1)} … ${high.toFixed(1)}`
      : low != null
        ? `≥ ${low.toFixed(1)}`
        : high != null
          ? `≤ ${high.toFixed(1)}`
          : '';
  if (dbm == null) return { key, value: '–', tone: 'neutral', range };
  let tone: Tone = 'ok';
  if ((low != null && dbm < low) || (high != null && dbm > high)) tone = 'critical';
  else if ((low != null && dbm < low + 1) || (high != null && dbm > high - 1)) tone = 'warning';
  return { key, value: `${dbm.toFixed(1)} dBm`, tone, range };
}
