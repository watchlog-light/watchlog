// SPDX-License-Identifier: AGPL-3.0-only
// Right-sizing hints (ADR-168, SPEC §4.3): a container's requests and limits against what it
// used over the window. Pure functions: queries.ts reads the use, routes.ts the settings.
// Each hint is a code with facts, rendered in words by the dashboard (ADR-147): no score,
// no "efficiency" percentage, no money.

export const CORE_STEP = 0.01; // suggestions round up to 10m
export const MIB = 2 ** 20;
export const MEMORY_STEP = 16 * MIB; // and to 16 MiB
export const HEADROOM = 1.25;
/** A request at least this many times the use is too high… */
export const HIGH_FACTOR = 2;
/** …when at least this much would be given back. */
export const CPU_SPARE_CORES = 0.1;
export const MEMORY_SPARE_BYTES = 128 * MIB;
/** The peak working set at or above this share of the limit is an OOM risk. */
export const TIGHT_SHARE = 0.9;
/** Throttled at least this share of the time at p95 (ADR-160's share). */
export const THROTTLED_SHARE = 0.1;
/** Docker: no memory limit matters once the container used this share of the host. */
export const HOST_SHARE = 0.25;
/** The 5-minute subqueries' step: one sample is five minutes of history. */
export const SAMPLE_S = 300;

export type Platform = 'kubernetes' | 'docker';
export type Resource = 'cpu' | 'memory';
export type HintCode =
  | 'memory_limit_oom'
  | 'memory_limit_tight'
  | 'cpu_limit_throttled'
  | 'memory_request_low'
  | 'cpu_request_low'
  | 'memory_reservation_low'
  | 'cpu_request_high'
  | 'memory_request_high'
  | 'memory_reservation_high'
  | 'cpu_no_request'
  | 'memory_no_request'
  | 'memory_no_limit';

/** The order hints are listed in: OOM risk first, then what holds a container back. */
const RANK: Record<HintCode, number> = {
  memory_limit_oom: 0,
  memory_limit_tight: 1,
  cpu_limit_throttled: 2,
  memory_request_low: 3,
  memory_reservation_low: 3,
  cpu_request_low: 4,
  cpu_request_high: 5,
  memory_request_high: 5,
  memory_reservation_high: 5,
  cpu_no_request: 6,
  memory_no_request: 6,
  memory_no_limit: 6,
};

export const OOM_RISK: ReadonlySet<HintCode> = new Set(['memory_limit_oom', 'memory_limit_tight']);
export const GIVE_BACK: ReadonlySet<HintCode> = new Set([
  'cpu_request_high',
  'memory_request_high',
  'memory_reservation_high',
]);

/** A Kubernetes workload, or a Docker container (with its Compose service when it has one). */
export interface HintObject {
  kind: string;
  name: string;
  namespace?: string;
  host?: string;
  composeProject?: string;
  composeService?: string;
}

/** What a container used over the window, from VictoriaMetrics (the busiest pod's on Kubernetes). */
export interface Usage {
  /** p95 of the 5-minute CPU rate, cores. */
  cpuP95: number | null;
  /** The highest working set, bytes. */
  memoryPeak: number | null;
  /** p95 of the working set, bytes. */
  memoryP95: number | null;
  /** p95 of the share of the time throttled (0–1). */
  throttledP95: number | null;
  /** 5-minute samples of history in the window. */
  samples: number;
  /** The first sample in the window (unix seconds). */
  from: number | null;
  /** OOM kills in the window, and the last one when it is known. */
  oomKills: number;
  lastOomAt?: string | null;
}

export interface KubeSettings {
  cpuRequest: number | null;
  cpuLimit: number | null;
  memoryRequest: number | null;
  memoryLimit: number | null;
}

export interface DockerSettings {
  cpuLimit: number | null;
  memoryLimit: number | null;
  memoryReservation: number | null;
  /** The host's memory, bytes. */
  hostMemory: number | null;
}

export type Facts = Record<string, string | number | boolean | null>;

export interface BasedOn {
  /** The window asked for, in hours (168 = 7 days). */
  windowHours: number;
  /** The history it had: from the first sample to `to`. */
  from: string | null;
  to: string;
  samples: number;
  hours: number;
}

export interface Hint {
  object: HintObject;
  /** The container in the pod (Kubernetes); null on Docker. */
  container: string | null;
  resource: Resource;
  code: HintCode;
  facts: Facts;
  /** The value that would cover the use (cores or bytes); null when there is none to give. */
  suggestion: number | null;
  /** CPU (cores) or memory (bytes) all replicas would give back; 0 for other hints. */
  giveBack: number;
  basedOn: BasedOn;
}

export interface NotEnoughHistory {
  object: HintObject;
  container: string | null;
  hours: number;
  needed: number;
}

export const roundUp = (v: number, step: number) =>
  Math.max(step, Math.ceil((v * HEADROOM) / step - 1e-9) * step);
export const suggestCores = (cores: number) => +roundUp(cores, CORE_STEP).toFixed(2);
export const suggestBytes = (bytes: number) => roundUp(bytes, MEMORY_STEP);

const hoursOf = (samples: number) => Math.round(((samples * SAMPLE_S) / 3600) * 10) / 10;

export function basedOn(u: Usage, windowHours: number, to: number): BasedOn {
  return {
    windowHours,
    from: u.from !== null ? new Date(u.from * 1000).toISOString() : null,
    to: new Date(to * 1000).toISOString(),
    samples: u.samples,
    hours: Math.min(windowHours, hoursOf(u.samples)),
  };
}

/** True when the use has enough history to judge (ADR-168: 24 hours). */
export function enoughHistory(u: Usage, minHours: number): boolean {
  return hoursOf(u.samples) >= minHours;
}

const pos = (v: number | null | undefined): v is number => typeof v === 'number' && v > 0;
const known = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

interface Ctx {
  object: HintObject;
  container: string | null;
  name: string;
  based: BasedOn;
  replicas: number;
}

function hint(
  c: Ctx,
  resource: Resource,
  code: HintCode,
  facts: Facts,
  suggestion: number | null,
  giveBack = 0,
): Hint {
  return {
    object: c.object,
    container: c.container,
    resource,
    code,
    facts: {
      name: c.name,
      ...(c.container ? { container: c.container } : {}),
      hours: c.based.hours,
      ...facts,
    },
    suggestion,
    giveBack,
    basedOn: c.based,
  };
}

/** The memory limit: an OOM kill in the window, or a peak within 10 % of the limit. */
function memoryLimitHints(c: Ctx, u: Usage, limit: number | null): Hint[] {
  if (!pos(limit)) return [];
  if (u.oomKills > 0) {
    return [
      hint(
        c,
        'memory',
        'memory_limit_oom',
        {
          limitBytes: limit,
          peakBytes: u.memoryPeak,
          oomKills: u.oomKills,
          lastOomAt: u.lastOomAt ?? null,
        },
        suggestBytes(Math.max(limit, u.memoryPeak ?? 0)),
      ),
    ];
  }
  if (known(u.memoryPeak) && u.memoryPeak >= TIGHT_SHARE * limit) {
    return [
      hint(
        c,
        'memory',
        'memory_limit_tight',
        { limitBytes: limit, peakBytes: u.memoryPeak },
        suggestBytes(u.memoryPeak),
      ),
    ];
  }
  return [];
}

function throttleHints(c: Ctx, u: Usage, limit: number | null): Hint[] {
  if (!pos(limit) || !known(u.throttledP95) || u.throttledP95 < THROTTLED_SHARE) return [];
  return [
    hint(
      c,
      'cpu',
      'cpu_limit_throttled',
      { limitCores: limit, throttledShare: +u.throttledP95.toFixed(2), usedCores: u.cpuP95 },
      null,
    ),
  ];
}

/**
 * A Kubernetes workload container: its pod template's requests and limits against the busiest
 * pod's use. A request left out while a limit is set is the limit (Kubernetes's own default).
 */
export function kubeHints(
  object: HintObject,
  container: string,
  s: KubeSettings,
  u: Usage,
  based: BasedOn,
  replicas: number,
): Hint[] {
  const c: Ctx = { object, container, name: object.name, based, replicas };
  const out: Hint[] = [];
  out.push(...memoryLimitHints(c, u, s.memoryLimit));
  out.push(...throttleHints(c, u, s.cpuLimit));
  const cpuRequest = pos(s.cpuRequest) ? s.cpuRequest : pos(s.cpuLimit) ? s.cpuLimit : null;
  const memRequest = pos(s.memoryRequest)
    ? s.memoryRequest
    : pos(s.memoryLimit)
      ? s.memoryLimit
      : null;
  if (known(u.cpuP95)) {
    const suggestion = suggestCores(u.cpuP95);
    if (cpuRequest === null) {
      out.push(hint(c, 'cpu', 'cpu_no_request', { usedCores: u.cpuP95 }, suggestion));
    } else if (u.cpuP95 > cpuRequest) {
      out.push(
        hint(
          c,
          'cpu',
          'cpu_request_low',
          { requestCores: cpuRequest, usedCores: u.cpuP95 },
          suggestion,
        ),
      );
    } else if (
      cpuRequest >= HIGH_FACTOR * u.cpuP95 &&
      cpuRequest - u.cpuP95 >= CPU_SPARE_CORES &&
      suggestion < cpuRequest
    ) {
      out.push(
        hint(
          c,
          'cpu',
          'cpu_request_high',
          { requestCores: cpuRequest, usedCores: u.cpuP95, replicas },
          suggestion,
          +((cpuRequest - suggestion) * replicas).toFixed(3),
        ),
      );
    }
  }
  if (known(u.memoryPeak)) {
    const suggestion = suggestBytes(u.memoryPeak);
    if (memRequest === null) {
      out.push(hint(c, 'memory', 'memory_no_request', { peakBytes: u.memoryPeak }, suggestion));
    } else if (known(u.memoryP95) && u.memoryP95 > memRequest) {
      out.push(
        hint(
          c,
          'memory',
          'memory_request_low',
          { requestBytes: memRequest, p95Bytes: u.memoryP95, peakBytes: u.memoryPeak },
          suggestion,
        ),
      );
    } else if (
      memRequest >= HIGH_FACTOR * u.memoryPeak &&
      memRequest - u.memoryPeak >= MEMORY_SPARE_BYTES &&
      suggestion < memRequest
    ) {
      out.push(
        hint(
          c,
          'memory',
          'memory_request_high',
          { requestBytes: memRequest, peakBytes: u.memoryPeak, replicas },
          suggestion,
          (memRequest - suggestion) * replicas,
        ),
      );
    }
    if (!pos(s.memoryLimit)) {
      out.push(hint(c, 'memory', 'memory_no_limit', { peakBytes: u.memoryPeak }, suggestion));
    }
  }
  return out;
}

/**
 * A Docker container: limits reserve nothing, so there is no "too high" on a limit (ADR-168);
 * a memory reservation is judged as a request is; no memory limit matters only once the
 * container used more than a quarter of its host's memory.
 */
export function dockerHints(
  object: HintObject,
  s: DockerSettings,
  u: Usage,
  based: BasedOn,
): Hint[] {
  const c: Ctx = { object, container: null, name: object.name, based, replicas: 1 };
  const out: Hint[] = [];
  out.push(...memoryLimitHints(c, u, s.memoryLimit));
  out.push(...throttleHints(c, u, s.cpuLimit));
  if (known(u.memoryPeak)) {
    const suggestion = suggestBytes(u.memoryPeak);
    const r = s.memoryReservation;
    if (pos(r)) {
      if (known(u.memoryP95) && u.memoryP95 > r) {
        out.push(
          hint(
            c,
            'memory',
            'memory_reservation_low',
            { reservationBytes: r, p95Bytes: u.memoryP95, peakBytes: u.memoryPeak },
            suggestion,
          ),
        );
      } else if (
        r >= HIGH_FACTOR * u.memoryPeak &&
        r - u.memoryPeak >= MEMORY_SPARE_BYTES &&
        suggestion < r
      ) {
        out.push(
          hint(
            c,
            'memory',
            'memory_reservation_high',
            { reservationBytes: r, peakBytes: u.memoryPeak },
            suggestion,
            r - suggestion,
          ),
        );
      }
    }
    if (!pos(s.memoryLimit) && pos(s.hostMemory) && u.memoryPeak > HOST_SHARE * s.hostMemory) {
      out.push(
        hint(
          c,
          'memory',
          'memory_no_limit',
          { peakBytes: u.memoryPeak, hostMemoryBytes: s.hostMemory, host: object.host ?? null },
          suggestion,
        ),
      );
    }
  }
  return out;
}

/** CPU and memory on one scale for ordering what to give back: 1 core ≈ 4 GiB. */
const BYTES_PER_CORE = 4 * 2 ** 30;
const weight = (h: Hint) => (h.resource === 'cpu' ? h.giveBack : h.giveBack / BYTES_PER_CORE);

/** OOM risk first, then what holds containers back, then the most to give back. */
export function sortHints(hints: Hint[]): Hint[] {
  return [...hints].sort(
    (a, b) =>
      RANK[a.code] - RANK[b.code] ||
      weight(b) - weight(a) ||
      objectKey(a.object).localeCompare(objectKey(b.object)) ||
      (a.container ?? '').localeCompare(b.container ?? ''),
  );
}

export const objectKey = (o: HintObject) =>
  o.host !== undefined ? `${o.host}/${o.name}` : `${o.namespace}/${o.kind}/${o.name}`;

export interface Summary {
  /** Workloads or containers with at least one hint. */
  objects: number;
  /** Those that could give CPU or memory back, and how much in all. */
  giveBackObjects: number;
  giveBack: { cores: number; bytes: number };
  /** Those at risk of an OOM kill. */
  oomRisk: number;
}

export function summarize(hints: Hint[]): Summary {
  const all = new Set<string>();
  const back = new Set<string>();
  const oom = new Set<string>();
  let cores = 0;
  let bytes = 0;
  for (const h of hints) {
    const k = objectKey(h.object);
    all.add(k);
    if (GIVE_BACK.has(h.code)) {
      back.add(k);
      if (h.resource === 'cpu') cores += h.giveBack;
      else bytes += h.giveBack;
    }
    if (OOM_RISK.has(h.code)) oom.add(k);
  }
  return {
    objects: all.size,
    giveBackObjects: back.size,
    giveBack: { cores: +cores.toFixed(3), bytes },
    oomRisk: oom.size,
  };
}
