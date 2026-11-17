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
  /**
   * The OS's own (systemd, ssh, cron, journald, containerd, shells, apt…) and WatchLog's own
   * agent and collector, told by unit and binary or by image, never by a process's name:
   * hidden by default on the page.
   */
  system: boolean;
  /** What it runs: the executable's base name (node, php-fpm8.2), never a command line. */
  runs: string | null;
  /** CPUQuota in cores: a service's, or its unit's for a process group. */
  cpuLimitCores: number | null;
  /** Unix seconds of its last change: the executable replaced, or the unit (re)started. */
  changedAt: number | null;
  /** Instances its manager expects (systemd's one main process); null when unknown. */
  expected: number | null;
  /**
   * The workload it is nested under on the page: a group's service (`service:<unit>`), pm2's
   * or supervisord's own group for apps started outside systemd (`process:pm2`), a container's
   * Compose project (`compose:<project>`); null at the top.
   */
  parent: string | null;
}

export interface WorkloadProblem {
  kind:
    | 'failed'
    | 'crash_looping'
    | 'oom_killed'
    | 'unhealthy'
    | 'exited'
    | 'restarting'
    | 'gone'
    | 'memory_near';
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
];

/**
 * Process groups that are the OS's own, by the executable they're named after (ADR-208's
 * last rule): never a product's, whatever it calls itself.
 */
const SYSTEM_GROUPS =
  /^(systemd(-.+)?|\(sd-pam\)|sshd(-session)?|cron|crond|atd|containerd(-shim.*)?|bash|dash|sh|zsh|sudo|su|apt|apt-get|apt-check|dpkg|needrestart|unattended-upgr.*|agetty|login|polkitd|dbus-daemon|rsyslogd|snapd|multipathd|udisksd|packagekitd|journalctl)$/;

/** A user's own systemd instance (`user@0.service`): their session, not a service to nest under. */
const USER_MANAGER = /^user@\d+\.service$/;

/** WatchLog's own images (docker run): told by the image, never the container's name. */
const OWN_IMAGE = /(^|\/)watchlog-light\/(agent|integrations|cluster-agent)(:|@|$)/;

/** Memory at or above this share of MemoryMax is "near its memory limit". */
export const MEMORY_NEAR = 0.9;

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
  /** Restarts in 24 h: the smaller of its starts and exits. */
  groupRestarts24h: QuerySeries[];
  groupOom10m: QuerySeries[];
  listen: QuerySeries[];
  containerCpu: QuerySeries[];
  containerRestarts24h: QuerySeries[];
  /** watchlog_service_exe_info: a unit's executable and whether it is WatchLog's own. */
  serviceExe?: QuerySeries[];
  serviceCpuLimit?: QuerySeries[];
  /** Unix seconds a unit last changed: its executable replaced, or (re)started. */
  serviceChanged?: QuerySeries[];
  groupChanged?: QuerySeries[];
  /** A group's most instances in the last 10 minutes: 0 means it is gone from the list. */
  groupRecent?: QuerySeries[];
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
  /** Its image: WatchLog's own agent and collector are told by it. */
  image?: string | null;
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
  const cpuLimit = index(s.serviceCpuLimit ?? [], 'host', 'unit');
  const changed = index(s.serviceChanged ?? [], 'host', 'unit');
  const exe = new Map<string, { exe: string | null; own: boolean }>();
  for (const e of s.serviceExe ?? [])
    exe.set(key(e.labels.host, e.labels.unit), {
      exe: e.labels.exe || null,
      own: e.labels.own === 'true',
    });
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
    const memNow = mem.get(k) ?? null;
    const memMax = memLimit.get(k) ?? null;
    const problem: WorkloadProblem | null =
      state === 'failed'
        ? { kind: 'failed', severity: 'critical', code }
        : crashes >= CRASH_LOOP
          ? { kind: 'crash_looping', severity: 'critical', code }
          : (oom10.get(k) ?? 0) >= 1
            ? { kind: 'oom_killed', severity: 'warning', code }
            : memNow != null && memMax && memNow / memMax >= MEMORY_NEAR
              ? { kind: 'memory_near', severity: 'warning', code: null }
              : null;
    const ex = exe.get(k);
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
      // systemd expects its main process: running or not.
      instances: sub === 'running' ? 1 : 0,
      ports: ports.get(key(host, 'service', unit)) ?? [],
      restarts24h: Math.round(restarts24.get(k) ?? 0),
      lastExitCode: code,
      system: (ex?.own ?? false) || isSystemUnit(unit),
      runs: ex?.exe ?? null,
      cpuLimitCores: cpuLimit.get(k) ?? null,
      changedAt: changed.get(k) ?? null,
      expected: 1,
      parent: null,
    });
  }

  const gCpu = index(s.groupCpu, 'host', 'group');
  const gMem = index(s.groupMemory, 'host', 'group');
  const gFailed10 = index(s.groupFailedExits10m, 'host', 'group');
  const gRestarts24 = index(s.groupRestarts24h, 'host', 'group');
  const gOom10 = index(s.groupOom10m, 'host', 'group');
  const gChanged = index(s.groupChanged ?? [], 'host', 'group');
  const gRecent = index(s.groupRecent ?? [], 'host', 'group');
  for (const g of s.groupInstances) {
    const host = g.labels.host;
    const group = g.labels.group;
    if (!host || !group) continue;
    const k = key(host, group);
    if (seen.has(`g${k}`)) continue;
    seen.add(`g${k}`);
    const instances = val(g) ?? 0;
    // A transient group (a cron job, a script that ended) leaves the list 10 minutes after
    // its last process; its history stays, and the server's events keep it.
    const recent = s.groupRecent ? (gRecent.get(k) ?? 0) : instances;
    if (instances === 0 && recent === 0) continue;
    const raw = g.labels.unit || null;
    // A user's own systemd instance is their session: not a service to nest under.
    const unit = raw && !USER_MANAGER.test(raw) ? raw : null;
    const uk = unit ? key(host, unit) : null;
    const memNow = gMem.get(k) ?? null;
    const memMax = uk ? (memLimit.get(uk) ?? null) : null;
    const crashes = gFailed10.get(k) ?? 0;
    const problem: WorkloadProblem | null =
      crashes >= CRASH_LOOP
        ? { kind: 'crash_looping', severity: 'critical', code: null }
        : (gOom10.get(k) ?? 0) >= 1
          ? { kind: 'oom_killed', severity: 'warning', code: null }
          : instances === 0
            ? { kind: 'gone', severity: 'warning', code: null }
            : memNow != null && memMax && memNow / memMax >= MEMORY_NEAR
              ? { kind: 'memory_near', severity: 'warning', code: null }
              : null;
    push(host, {
      id: `process:${group}`,
      source: 'process',
      name: group,
      unit,
      note: g.labels.by || null,
      state: String(instances),
      problem,
      cpuCores: gCpu.get(k) ?? null,
      memoryBytes: memNow,
      // Its unit's MemoryMax and CPUQuota: the limits it lives under.
      memoryLimitBytes: memMax,
      instances,
      ports: ports.get(key(host, 'process', group)) ?? [],
      // 0 when it neither started nor ended a process (its counters are sent from the first).
      restarts24h: Math.round(gRestarts24.get(k) ?? 0),
      lastExitCode: null,
      // The OS's by its executable's name; one inside a system unit (or WatchLog's own) with
      // its unit. A product's process is never system for its name alone.
      system:
        SYSTEM_GROUPS.test(group) ||
        (!!unit && (isSystemUnit(unit) || (exe.get(uk!)?.own ?? false))),
      runs: g.labels.exe || null,
      cpuLimitCores: uk ? (cpuLimit.get(uk) ?? null) : null,
      changedAt: gChanged.get(k) ?? null,
      expected: null,
      parent: null,
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
      // WatchLog's own containers by their image, never by their name.
      system: OWN_IMAGE.test(c.image ?? ''),
      runs: c.image ? shortImage(c.image) : null,
      cpuLimitCores: null,
      changedAt: null,
      expected: null,
      parent: c.compose ? `compose:${c.compose}` : null,
    });
  }
  for (const [host, list] of out) {
    nest(list);
    list.sort(byProblemThenCpu);
    out.set(host, list);
  }
  return out;
}

/** An image's name and tag without its registry (`ghcr.io/x/agent:0.9.0` → `agent:0.9.0`). */
function shortImage(image: string): string {
  const at = image.split('@')[0]!;
  return at.slice(at.lastIndexOf('/') + 1);
}

/**
 * Sets each process group's parent on one server: its unit's service when that service is
 * listed; else, for apps a process manager started outside systemd, the manager's own group
 * (pm2's God Daemon is the group `pm2`, supervisord's is `supervisord`).
 */
export function nest(list: Workload[]): void {
  const ids = new Set(list.map((w) => w.id));
  const managers: Record<string, string> = {
    pm2: 'process:pm2',
    supervisord: 'process:supervisord',
  };
  for (const w of list) {
    if (w.source !== 'process') continue;
    if (w.unit && ids.has(`service:${w.unit}`)) w.parent = `service:${w.unit}`;
    else if (
      !w.unit &&
      w.note &&
      managers[w.note] &&
      ids.has(managers[w.note]!) &&
      w.id !== managers[w.note]
    )
      w.parent = managers[w.note]!;
  }
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
