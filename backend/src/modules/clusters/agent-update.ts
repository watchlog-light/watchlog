// SPDX-License-Identifier: AGPL-3.0-only
// Updating the agents from the panel (ADR-227): which agents are out of date, and the one
// command that updates each kind of install, filled in. "Latest" is this backend's own
// version; an agent is out of date when its version is lower (semver), or unknown.
import type { Database } from '../../db/index.js';
import { chartSource, dockerRecreateCommand, shellQuote } from './install.js';

export type InstallMethod = 'script' | 'deb' | 'rpm' | 'docker';
export const INSTALL_METHODS: readonly InstallMethod[] = ['script', 'deb', 'rpm', 'docker'];

const RELEASE = /^v?\d+\.\d+\.\d+$/;
const RELEASES = 'https://github.com/watchlog-light/watchlog/releases/download';

/** Whether version `a` is older than `b` (numeric parts; a pre-release before its release). */
export function olderVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return x.pre !== null && y.pre === null;
}

/**
 * Whether an agent should be updated: never against a development build of the backend (it
 * has no release to update to); always when the agent's version is unknown or not a version.
 */
export function updateAvailable(agentVersion: string | null | undefined, backend: string): boolean {
  if (!RELEASE.test(backend)) return false;
  const v = (agentVersion ?? '').trim();
  if (!/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) return true;
  return olderVersion(v, backend);
}

/** The method an agent reported, or null when it reported none (agents before 0.11.1). */
export function installMethodOf(capabilities: unknown): InstallMethod | null {
  const m = (capabilities as { install_method?: unknown } | null)?.install_method;
  return typeof m === 'string' && (INSTALL_METHODS as readonly string[]).includes(m)
    ? (m as InstallMethod)
    : null;
}

export interface ServerUpdateInput {
  /** The address the install dialog uses (installTarget's endpointFor). */
  endpoint: string;
  /** The backend's version: the packages and the image of this release. */
  version: string;
  /** The agent image of this release. */
  image: string;
}

/**
 * A server's update commands, one per install method. The script and the packages keep
 * /etc/watchlog/agent.env (the token stays on the server); the Docker command re-creates the
 * container with the token it already has (`docker inspect`), so no new token is issued.
 * The packages exist for releases only.
 */
export function serverUpdateCommands({ endpoint, version, image }: ServerUpdateInput) {
  const out: Partial<Record<InstallMethod, string>> = {
    script: `curl -fsSL ${shellQuote(`${endpoint}/install.sh`)} | sudo sh -s -- --upgrade`,
    docker: dockerRecreateCommand({ endpoint, image }),
  };
  if (RELEASE.test(version)) {
    const v = version.replace(/^v/, '');
    out.deb = [
      `v=${v}; a=$(dpkg --print-architecture)`,
      `curl -fsSLO "${RELEASES}/v$v/watchlog-agent_\${v}_$a.deb"`,
      `sudo apt-get install -y "./watchlog-agent_\${v}_$a.deb"`,
    ].join('\n');
    out.rpm = [
      `v=${v}; a=$(uname -m)`,
      `sudo dnf install -y "${RELEASES}/v$v/watchlog-agent-$v-1.$a.rpm"`,
    ].join('\n');
  }
  return out;
}

/** A multi-line command as one line: continuation lines joined, separate commands with &&. */
export function oneLine(command: string): string {
  const lines = command.split('\n').map((l) => l.trim());
  let out = '';
  for (const [i, line] of lines.entries()) {
    const continues = line.endsWith('\\');
    out += continues
      ? line.slice(0, -1).trimEnd() + ' '
      : line + (i < lines.length - 1 ? ' && ' : '');
  }
  return out.trim();
}

/** Host names safe to put in a shell loop unquoted would be most; quote them anyway. */
export function sshLoop(hosts: string[], command: string): string {
  return `for h in ${hosts.map(shellQuote).join(' ')}; do ssh "$h" ${shellQuote(oneLine(command))}; done`;
}

export interface HelmUpdateInput {
  version: string;
  /** namespace/release, as the agent chart reports it (WATCHLOG_HELM_RELEASE). */
  release?: string | null;
  /** watchlog (the full chart) or watchlog-agent (agents only), as the chart reports it. */
  chart?: string | null;
}

/**
 * A Kubernetes cluster's update: `helm upgrade` of the chart it runs, to this release, keeping
 * its values. Without the release the agents report, the names our own install commands use
 * (`watchlog-agent`, or `watchlog` for the full chart, in `watchlog`) and a line to change them.
 */
export function helmUpdateCommand({ version, release, chart }: HelmUpdateInput): {
  command: string;
  known: boolean;
} {
  const [namespace, name] =
    release && /^[a-z0-9.-]+\/[a-z0-9.-]+$/.test(release) ? release.split('/') : [];
  const which = chart === 'watchlog' ? 'watchlog' : 'watchlog-agent';
  const source = chartSource(which, version);
  const command = [
    ...(source.prepare ? [source.prepare] : []),
    `helm upgrade ${name ?? which} ${source.ref} -n ${namespace ?? 'watchlog'} --reuse-values`,
  ].join('\n');
  return { command, known: !!name };
}

/** Agents seen within this window are a cluster's; one removed longer ago drops out. */
export const AGENT_WINDOW_MS = 7 * 86_400_000;

/**
 * The clusters (of those given) with at least one node or server agent older than this
 * WatchLog, seen within AGENT_WINDOW_MS: one query.
 */
export async function clustersWithOldAgents(
  db: Database,
  clusterIds: string[],
  version: string,
  nowMs = Date.now(),
): Promise<Set<string>> {
  if (!clusterIds.length || !RELEASE.test(version)) return new Set();
  const rows = await db
    .selectFrom('agent_instances')
    .select(['cluster_id', 'agent_version'])
    .where('cluster_id', 'in', clusterIds)
    .where('mode', 'in', ['node', 'docker'])
    .where('last_seen_at', '>=', new Date(nowMs - AGENT_WINDOW_MS))
    .execute();
  return new Set(
    rows.filter((r) => updateAvailable(r.agent_version, version)).map((r) => r.cluster_id),
  );
}
