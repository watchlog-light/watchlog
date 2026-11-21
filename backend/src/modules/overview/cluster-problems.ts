// SPDX-License-Identifier: AGPL-3.0-only
// One cluster's or fleet's Needs attention, built the same way wherever it shows: its own
// Overview (ADR-110, ADR-159) and All clusters and fleets (ADR-226, amended by ADR-227), so
// the two always list the same problems with the same text.
import type { HostBoot } from '../docker/host-restart.js';
import { stoppedWithHost } from '../docker/host-restart.js';
import { needsAttention, type ObjectRow, type PodSpec } from '../kubernetes/views.js';
import { dockerProblems } from './docker-problems.js';
import { buildProblems, type FiringAlert, type Problems } from './problems.js';

export interface PvcUsage {
  namespace: string;
  name: string;
  ratio: number;
}

/** "namespace/pod" → the pod's workload name. */
export function podWorkloads(pods: ObjectRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pods) {
    const spec = p.spec_summary as PodSpec & { workload?: { kind: string; name: string } };
    if (spec.workload?.name) out.set(`${p.namespace}/${p.name}`, spec.workload.name);
  }
  return out;
}

/** A Kubernetes cluster's problems: firing alerts, then nodes, pods and volumes no alert covers. */
export function kubernetesProblems(input: {
  alerts: FiringAlert[];
  nodes: ObjectRow[];
  pods: ObjectRow[];
  pvc: PvcUsage[];
  clusterName: string;
  now: number;
  podWorkload?: Map<string, string>;
}): Problems {
  const attention = needsAttention(
    input.nodes,
    input.pods,
    input.pvc,
    input.now,
    Number.POSITIVE_INFINITY,
  ).items;
  return buildProblems({
    alerts: input.alerts,
    attention,
    podWorkload: input.podWorkload ?? podWorkloads(input.pods),
    clusterName: input.clusterName,
    now: input.now,
  });
}

/** Container rows as the server problems read them. */
export interface ContainerRow {
  node: string;
  name: string;
  namespace: string | null;
  spec_summary: unknown;
  status_summary: unknown;
}

/** A Server fleet's problems: firing alerts, then containers no alert covers. */
export function serverProblems(input: {
  alerts: FiringAlert[];
  containers: ContainerRow[];
  /** Hosts whose agent reports now. */
  liveHosts: Set<string>;
  /** Recent host reboots (docker/host-restart.ts's hostBoots). */
  boots: Map<string, HostBoot>;
  clusterName: string;
  now: number;
}): Problems {
  const withHost = stoppedWithHost(input.containers as never, input.boots);
  return buildProblems({
    alerts: input.alerts,
    attention: [],
    podWorkload: new Map(),
    clusterName: input.clusterName,
    now: input.now,
    objects: dockerProblems(
      input.containers as never,
      input.alerts,
      input.clusterName,
      input.now,
      undefined,
      input.liveHosts,
      withHost,
    ),
  });
}
