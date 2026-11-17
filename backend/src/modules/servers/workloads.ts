// SPDX-License-Identifier: AGPL-3.0-only
// A server's workloads (ADR-207): its systemd services, process groups and containers, as one
// list with the same fields, from the agent's series (ADR-208) and the container objects.
import type { QuerySeries } from '../../lib/victoria.js';

export type WorkloadSource = 'service' | 'process' | 'container';

export interface Workload {
  /** `service:<unit>`, `process:<group>` or `container:<name>`. */
  id: string;
  source: WorkloadSource;
  name: string;
  /** The systemd unit a process group runs in (pm2-app.service), else null. */
  unit: string | null;
  /**
   * How it was found: a group's naming rule (pm2, supervisord, php-fpm, gunicorn, java,
   * script, exe, rule), `compose:<project>` for a container; null for a service.
   */
  note: string | null;
  /** systemd's state (active · running), the group's instances, the container's state. */
  state: string;
  /** What is wrong, worst first; null when fine. */
  problem: WorkloadProblem | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  instances: number | null;
  /** TCP ports it listens on. */
  ports: number[];
  /** systemd's restarts, a group's failed exits, a container's restarts: last 24 h. */
  restarts24h: number | null;
  lastExitCode: number | null;
  /** The OS's own services (ssh, cron, journald…) and WatchLog's: folded on the page. */
  system: boolean;
}

export interface WorkloadProblem {
  kind: 'failed' | 'crash_looping' | 'oom_killed' | 'unhealthy' | 'exited' | 'restarting';
  severity: 'critical' | 'warning';
  /** Exit code of the last failed exit, when known. */
  code: number | null;
}

/** A crash loop: at least 3 crashes or restarts in 10 minutes (ADR-208). */
export const CRASH_LOOP = 3;

const SYSTEM_UNITS = [
  /^systemd-/,
  /^(ssh|sshd|cron|crond|atd|dbus|dbus-broker|polkit|rsyslog|syslog|auditd|chronyd|chrony|ntp|ntpd)\.service$/,
  /^(getty|serial-getty|user|user-runtime-dir)@/,
  /^(snapd|multipathd|ModemManager|NetworkManager|networkd-dispatcher|udisks2|upower|irqbalance|accounts-daemon|firewalld|tuned|packagekit|unattended-upgrades|apt-daily|apt-daily-upgrade|dnf-makecache|rngd|lvm2-|blk-availability|kdump|qemu-guest-agent|open-vm-tools|vmtoolsd|cloud-|lima-|google-|walinuxagent|amazon-ssm-agent|waagent|sssd|gssproxy|nscd|polkit|rtkit|avahi|cups|bluetooth|wpa_supplicant|thermald|fwupd|smartd|mdmonitor|iscsid|lxcfs|containerd)/,
  /^watchlog-/,
];

export function isSystemUnit(unit: string): boolean {
  return SYSTEM_UNITS.some((r) => r.test(unit));
}

/** Instant query results the assembly reads, each `sum by (host, …)` already. */
export interface WorkloadSeries {
  serviceState: QuerySeries[];
  serviceCpu: QuerySeries[];
  serviceMemory: QuerySeries[];
  serviceMemoryLimit: QuerySeries[];
  serviceRestarts10m: QuerySeries[];
  serviceRestarts24h: QuerySeries[];
  serviceFailedExits10m: QuerySeries[];
  serviceOom10m: QuerySeries[];
  serviceLastExit: QuerySeries[];
  groupInstances: QuerySeries[];
  groupCpu: QuerySeries[];
  groupMemory: QuerySeries[];
  groupFailedExits10m: QuerySeries[];
  groupFailedExits24h: QuerySeries[];
  groupOom10m: QuerySeries[];
  listen: QuerySeries[];
  containerCpu: QuerySeries[];
  containerRestarts24h: QuerySeries[];
}

export interface ContainerRow {
  node: string | null;
  name: string;
  status: {
    state?: string;
    health?: string;
    restart_count?: number;
    exit_code?: number;
    oom_killed?: boolean;
    restarting?: boolean;
  };
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  ports: number[];
  /** Compose's project, shown as the container's note. */
  compose: string | null;
}

const val = (s: QuerySeries) => s.points[0]?.[1] ?? null;
const key = (...parts: (string | undefined)[]) => parts.map((p) => p ?? '').join('\u0000');

function index(series: QuerySeries[], ...labels: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const s of series) out.set(key(...labels.map((l) => s.labels[l])), val(s));
  return out;
}

/** Every server's workloads, by server name. */
export function assembleWorkloads(
  s: WorkloadSeries,
  containers: ContainerRow[],
): Map<string, Workload[]> {
  const out = new Map<string, Workload[]>();
  const push = (host: string, w: Workload) => {
    const list = out.get(host) ?? [];
    list.push(w);
    out.set(host, list);
  };
  const ports = new Map<string, number[]>();
  for (const l of s.listen) {
    const k = key(l.labels.host, l.labels.source, l.labels.workload);
    const port = Number(l.labels.port);
    if (!Number.isFinite(port)) continue;
    const list = ports.get(k) ?? [];
    if (!list.includes(port)) list.push(port);
    ports.set(
      k,
      list.sort((a, b) => a - b),
    );
  }

  const cpu = index(s.serviceCpu, 'host', 'unit');
  const mem = index(s.serviceMemory, 'host', 'unit');
  const memLimit = index(s.serviceMemoryLimit, 'host', 'unit');
  const restarts10 = index(s.serviceRestarts10m, 'host', 'unit');
  const restarts24 = index(s.serviceRestarts24h, 'host', 'unit');
  const failed10 = index(s.serviceFailedExits10m, 'host', 'unit');
  const oom10 = index(s.serviceOom10m, 'host', 'unit');
  const lastExit = index(s.serviceLastExit, 'host', 'unit');
  const seen = new Set<string>();
  for (const st of s.serviceState) {
    const host = st.labels.host;
    const unit = st.labels.unit;
    if (!host || !unit || val(st) !== 1) continue;
    const k = key(host, unit);
    if (seen.has(k)) continue; // one state at a time; a change mid-window keeps the first
    seen.add(k);
    const state = st.labels.state ?? '';
    const sub = st.labels.sub ?? '';
    const code = lastExit.get(k) ?? null;
    const crashes = Math.max(restarts10.get(k) ?? 0, failed10.get(k) ?? 0);
    const problem: WorkloadProblem | null =
      state === 'failed'
        ? { kind: 'failed', severity: 'critical', code }
        : crashes >= CRASH_LOOP
          ? { kind: 'crash_looping', severity: 'critical', code }
          : (oom10.get(k) ?? 0) >= 1
            ? { kind: 'oom_killed', severity: 'warning', code }
            : null;
    push(host, {
      id: `service:${unit}`,
      source: 'service',
      name: unit,
      unit: null,
      note: null,
      state: sub && sub !== state ? `${state} · ${sub}` : state,
      problem,
      cpuCores: cpu.get(k) ?? null,
      memoryBytes: mem.get(k) ?? null,
      memoryLimitBytes: memLimit.get(k) ?? null,
      instances: null,
      ports: ports.get(key(host, 'service', unit)) ?? [],
      restarts24h: restarts24.get(k) ?? null,
      lastExitCode: code,
      system: isSystemUnit(unit),
    });
  }

  const gCpu = index(s.groupCpu, 'host', 'group');
  const gMem = index(s.groupMemory, 'host', 'group');
  const gFailed10 = index(s.groupFailedExits10m, 'host', 'group');
  const gFailed24 = index(s.groupFailedExits24h, 'host', 'group');
  const gOom10 = index(s.groupOom10m, 'host', 'group');
  for (const g of s.groupInstances) {
    const host = g.labels.host;
    const group = g.labels.group;
    if (!host || !group) continue;
    const k = key(host, group);
    if (seen.has(`g${k}`)) continue;
    seen.add(`g${k}`);
    const instances = val(g) ?? 0;
    const crashes = gFailed10.get(k) ?? 0;
    const problem: WorkloadProblem | null =
      crashes >= CRASH_LOOP
        ? { kind: 'crash_looping', severity: 'critical', code: null }
        : (gOom10.get(k) ?? 0) >= 1
          ? { kind: 'oom_killed', severity: 'warning', code: null }
          : null;
    push(host, {
      id: `process:${group}`,
      source: 'process',
      name: group,
      unit: g.labels.unit || null,
      note: g.labels.by || null,
      state: String(instances),
      problem,
      cpuCores: gCpu.get(k) ?? null,
      memoryBytes: gMem.get(k) ?? null,
      memoryLimitBytes: null,
      instances,
      ports: ports.get(key(host, 'process', group)) ?? [],
      restarts24h: gFailed24.get(k) ?? null,
      lastExitCode: null,
      system: false,
    });
  }

  const cCpu = index(s.containerCpu, 'host', 'container');
  const cRestarts = index(s.containerRestarts24h, 'host', 'container');
  for (const c of containers) {
    if (!c.node) continue;
    const st = c.status;
    const k = key(c.node, c.name);
    const state = [st.state ?? 'unknown', st.health].filter(Boolean).join(' · ');
    const problem: WorkloadProblem | null = st.oom_killed
      ? { kind: 'oom_killed', severity: 'critical', code: st.exit_code ?? null }
      : st.restarting || st.state === 'restarting'
        ? { kind: 'restarting', severity: 'critical', code: st.exit_code ?? null }
        : st.health === 'unhealthy'
          ? { kind: 'unhealthy', severity: 'warning', code: null }
          : st.state === 'exited' && (st.exit_code ?? 0) !== 0
            ? { kind: 'exited', severity: 'warning', code: st.exit_code ?? null }
            : null;
    push(c.node, {
      id: `container:${c.name}`,
      source: 'container',
      name: c.name,
      unit: null,
      note: c.compose ? `compose:${c.compose}` : null,
      state,
      problem,
      cpuCores: cCpu.get(k) ?? null,
      memoryBytes: c.memoryBytes,
      memoryLimitBytes: c.memoryLimitBytes,
      instances: null,
      ports: c.ports,
      restarts24h: cRestarts.get(k) ?? null,
      lastExitCode: st.exit_code ?? null,
      system: c.name.startsWith('watchlog-'),
    });
  }
  for (const list of out.values()) list.sort(byProblemThenCpu);
  return out;
}

const SEVERITY = { critical: 0, warning: 1 } as const;

/** Problems first, then the busiest; a unit's process groups right after the unit. */
export function byProblemThenCpu(a: Workload, b: Workload): number {
  const pa = a.problem ? SEVERITY[a.problem.severity] : 2;
  const pb = b.problem ? SEVERITY[b.problem.severity] : 2;
  if (pa !== pb) return pa - pb;
  return (b.cpuCores ?? 0) - (a.cpuCores ?? 0) || a.name.localeCompare(b.name);
}

/** The ids are `service:<unit>`, `process:<group>` or `container:<name>`. */
export function parseWorkloadId(id: string): { source: WorkloadSource; name: string } | null {
  const i = id.indexOf(':');
  if (i < 0) return null;
  const source = id.slice(0, i);
  const name = id.slice(i + 1);
  if (!name || name.length > 256) return null;
  if (source !== 'service' && source !== 'process' && source !== 'container') return null;
  return { source, name };
}
