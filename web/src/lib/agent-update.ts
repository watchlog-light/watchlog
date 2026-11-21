// SPDX-License-Identifier: AGPL-3.0-only
// Updating the agents (ADR-227): which method tabs the dialog shows, and the words of the
// banners and chips. Pure, so every state is tested without mounting.
import type { ClusterAgents } from '@watchlog/api-types';

export type UpdateMethod = 'script' | 'deb' | 'rpm' | 'docker';
const ORDER: UpdateMethod[] = ['script', 'deb', 'rpm', 'docker'];

type Tr = (key: string, values?: Record<string, unknown>) => string;

/**
 * The method tabs of a fleet's dialog: the one method the agent (or every out-of-date agent)
 * reported, else every method this WatchLog has a command for, the script's first. A
 * Kubernetes cluster has none: one helm command.
 */
export function updateMethods(a: ClusterAgents, host: string | null): UpdateMethod[] {
  if (!a.server) return [];
  const available = ORDER.filter((m) => !!a.server!.commands[m]);
  const known = host ? (a.agents.find((x) => x.host === host)?.method ?? null) : a.server.method;
  return known && available.includes(known) ? [known] : available;
}

/** "4 of 6 servers run an older agent" / "3 of 12 nodes run an older agent". */
export function outOfDateLine(
  kind: 'kubernetes' | 'server',
  old: number,
  total: number,
  tr: Tr,
): string {
  return tr(kind === 'server' ? 'agents.banner.servers' : 'agents.banner.nodes', {
    n: old,
    total,
  });
}

/** "Agent 0.10.1 · update to 0.11.1", or "Agent 0.11.1" when it is current. */
export function agentChip(
  version: string | null,
  latest: string,
  updateAvailable: boolean,
  tr: Tr,
): string {
  const v = version ?? tr('agents.unknownVersion');
  return updateAvailable
    ? tr('agents.chipUpdate', { version: v, latest })
    : tr('agents.chip', { version: v });
}
