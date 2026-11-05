// SPDX-License-Identifier: AGPL-3.0-only
// Why an agent has no eBPF flows and the exact command that fixes it (ADR-107): the
// service map shows this instead of "turned off".
import { dockerRecreateCommand, helmUpgradeCommand } from '../clusters/install.js';

/**
 * config: turned off; kernel: too old, no BTF or cgroup v1; permission: BPF or PERFMON
 * missing; load: the programs failed for another reason; outdated: an agent from before
 * the cause was reported (Phase 4), installed by a chart or command without eBPF.
 */
export type EbpfCause = 'config' | 'kernel' | 'permission' | 'load' | 'outdated';
const REPORTED = new Set(['config', 'kernel', 'permission', 'load']);

export interface AgentCapabilities {
  ebpf?: string;
  ebpf_reason?: string;
  ebpf_cause?: string;
  helm_release?: string;
  helm_chart?: string;
  container_id?: string;
}

export interface AgentEbpf {
  node: string;
  ebpf: string;
  reason: string | null;
  cause: EbpfCause | null;
  /** Shell command that turns eBPF on, when one can. */
  fix: string | null;
}

export function agentEbpf(
  node: string,
  mode: string,
  caps: AgentCapabilities,
  install: { endpoint: string; image: string; name?: string; version?: string },
): AgentEbpf {
  const ebpf = caps.ebpf ?? 'disabled';
  const reason = caps.ebpf_reason ?? null;
  if (ebpf === 'enabled') return { node, ebpf, reason, cause: null, fix: null };
  const cause = (
    caps.ebpf_cause && REPORTED.has(caps.ebpf_cause) ? caps.ebpf_cause : 'outdated'
  ) as EbpfCause;
  let fix: string | null = null;
  if (cause === 'config' || cause === 'permission' || cause === 'outdated') {
    fix =
      mode === 'docker'
        ? dockerRecreateCommand(install)
        : helmUpgradeCommand({
            release: caps.helm_release,
            chart: caps.helm_chart,
            set: cause === 'config' ? ['agent.networkFlows.enabled=true'] : [],
            version: install.version,
          });
  }
  return { node, ebpf, reason, cause, fix };
}

export interface DockerContainer {
  uid: string;
  name: string;
  image: string;
}

/**
 * The agent's own container on its host: by the ID newer agents report, else the only
 * container running a WatchLog agent image (agents from before Phase 4).
 */
export function agentContainer(containers: DockerContainer[], id?: string): string | undefined {
  if (id) {
    const own = containers.find((c) => c.uid === id);
    if (own) return own.name;
  }
  const agents = containers.filter((c) =>
    /watchlog[^/]*\/agent[:@]|watchlog-agent[:@]/.test(c.image),
  );
  return agents.length === 1 ? agents[0]!.name : undefined;
}
