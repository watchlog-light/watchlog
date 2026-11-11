// SPDX-License-Identifier: AGPL-3.0-only
// Containers that stopped because their host or its Docker daemon restarted, not because
// their process ended (ADR-159). What WatchLog knows, measured on the e2e Docker host
// (2026-11-11): each container's state, exit code and finish time; the host's boot time
// (`watchlog_node_boot_time_seconds`, the kernel's btime, every report) and so when it
// last reported before that boot. The agent reports no restart policy and no daemon start.
//   - A clean reboot: the daemon stops every container as the host shuts down (exit 0,
//     130, 137, 143…), within seconds of the agent's own last report; then the host boots.
//   - A hard reboot or a killed daemon: the daemon finds the containers dead when it starts
//     and marks them exit 255, a few seconds after the boot (measured: 4–6 s).
//   - Docker then starts again only the containers whose restart policy says so; one still
//     stopped after the host came back is one its policy leaves stopped (`no`, or
//     `on-failure` and `unless-stopped` that don't apply), so it is no problem.
// Without a reboot, a daemon that was killed leaves the same exit-255 marks on every
// container it ran, within seconds of each other: that group is the daemon's restart. A
// clean `systemctl restart docker` without a reboot leaves nothing to tell it from the
// containers being stopped one by one, and isn't recognised.
import type { QuerySeries } from '../../lib/victoria.js';

/** A host's current boot and, when it reported before it, its last report before (unix s). */
export interface HostBoot {
  bootAt: number;
  downAt: number | null;
}

/** Why a container stopped: its host rebooted, or its Docker daemon restarted, at `at`. */
export interface StoppedWithHost {
  how: 'host' | 'docker';
  at: string;
}

/** Boots older than this can't explain a problem (exited containers count for a day). */
export const BOOT_RECENT_S = 25 * 3600;
/** A clean shutdown stops the containers around the agent's last report (15 s reports). */
export const BEFORE_DOWN_S = 60;
/** The daemon marks the containers it found dead this soon after the boot. */
export const AFTER_BOOT_S = 120;
/** A killed daemon's marks on its containers fall within this many seconds of each other. */
export const DAEMON_GROUP_S = 10;
/** …on at least this many other containers of the host. */
export const DAEMON_GROUP_MIN = 2;
/** Exit code Docker gives a container it found dead when it started. */
export const DEAD_AT_START = 255;

export const BOOT_QUERY = 'max by (host) (watchlog_node_boot_time_seconds)';

const quote = (s: string) => s.replace(/["\\]/g, '');

/** The host's last report before its boot: the newest boot-time sample older than it. */
export function downQuery(host: string, bootAt: number, now: number): string {
  const offset = Math.max(1, Math.ceil(now - bootAt) + 5);
  return `max(tlast_over_time(watchlog_node_boot_time_seconds{host="${quote(host)}"}[1d] offset ${offset}s))`;
}

/** Each host's recent boot and its last report before it; hosts that booted long ago are left out. */
export async function hostBoots(
  query: (expr: string) => Promise<QuerySeries[]>,
  now: number,
  hosts?: Set<string>,
): Promise<Map<string, HostBoot>> {
  const out = new Map<string, HostBoot>();
  const boots = await query(BOOT_QUERY).catch(() => [] as QuerySeries[]);
  await Promise.all(
    boots.map(async (s) => {
      const host = s.labels.host;
      const bootAt = s.points[0]?.[1];
      if (!host || bootAt == null || (hosts && !hosts.has(host))) return;
      if (now - bootAt > BOOT_RECENT_S) return;
      const down = await query(downQuery(host, bootAt, now)).catch(() => [] as QuerySeries[]);
      const downAt = down[0]?.points[0]?.[1] ?? null;
      out.set(host, { bootAt, downAt: downAt !== null && downAt < bootAt ? downAt : null });
    }),
  );
  return out;
}

interface Row {
  node: string;
  name: string;
  status_summary: unknown;
}
interface Status {
  state?: string;
  exit_code?: number;
  finished_at?: string;
}

const finishedS = (st: Status) => {
  if (st.state === 'running' || st.state === 'restarting') return null;
  const t = Date.parse(st.finished_at ?? '');
  // Docker's zero time (never finished) parses to year 1.
  return Number.isFinite(t) && t > 0 ? t / 1000 : null;
};

/**
 * The stopped containers whose stop came with their host's reboot or their daemon's
 * restart, keyed `host\u0000name`. Running containers are left out: the agent reports a
 * finish time only for a stopped one, and Docker's starts at boot add no restart (their
 * restart count stays), so no rule reads them as a crash.
 */
export function stoppedWithHost(
  rows: Row[],
  boots: Map<string, HostBoot>,
): Map<string, StoppedWithHost> {
  const out = new Map<string, StoppedWithHost>();
  const byHost = new Map<string, { row: Row; st: Status; at: number }[]>();
  for (const row of rows) {
    const st = (row.status_summary ?? {}) as Status;
    const at = finishedS(st);
    if (at === null) continue;
    byHost.set(row.node, [...(byHost.get(row.node) ?? []), { row, st, at }]);
  }
  for (const [host, list] of byHost) {
    const boot = boots.get(host);
    for (const { row, st, at } of list) {
      const key = `${host}\u0000${row.name}`;
      const dead = st.exit_code === DEAD_AT_START;
      if (boot) {
        const from = boot.downAt !== null ? boot.downAt - BEFORE_DOWN_S : null;
        const shutdown = from !== null && at >= from && at < boot.bootAt;
        const markedAtStart = at >= boot.bootAt && at <= boot.bootAt + AFTER_BOOT_S;
        // After the boot, only the daemon's own mark: a container its policy started again
        // that then failed (a publisher whose broker didn't come back) failed by itself.
        if (shutdown || (markedAtStart && dead)) {
          out.set(key, { how: 'host', at: new Date(boot.bootAt * 1000).toISOString() });
          continue;
        }
      }
      if (dead) {
        const others = list.filter(
          (o) => o.row !== row && Math.abs(o.at - at) <= DAEMON_GROUP_S,
        ).length;
        if (others >= DAEMON_GROUP_MIN)
          out.set(key, { how: 'docker', at: new Date(at * 1000).toISOString() });
      }
    }
  }
  return out;
}
