// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's plan line (0.10.1, design/cloud Sidebar): one compact row instead of the
// plan card. Cloud only; Community has no plan, so no row. The numbers are GET /plan's, which
// the shell already reads every minute: no new request.
//   - Free: "Free · 3 of 5 nodes", a thin bar (warning from 4 of 5) and "Upgrade →";
//   - Pro (and any plan without a node limit): a "Pro" label and "9 servers · 30 days of
//     data", "nodes" when every cluster of the org is a Kubernetes cluster. No bar, no upsell.
import type { PlanInfo } from '@/api/cloud';

/** From this share of the node limit the bar is in the warning colour (4 of 5). */
export const PLAN_WARN_SHARE = 0.8;

export type PlanLine =
  | {
      kind: 'limited';
      plan: PlanInfo['plan'];
      used: number;
      max: number;
      /** 0..1, for the bar. */
      share: number;
      warn: boolean;
    }
  | {
      kind: 'unlimited';
      plan: PlanInfo['plan'];
      count: number;
      unit: 'servers' | 'nodes';
      days: number;
    };

/**
 * The line for the org's plan, or null without one (Community, or the plan not read yet).
 * `kinds`: the kinds of the org's clusters, from the clusters list the shell already has.
 */
export function planLine(
  info: PlanInfo | null | undefined,
  kinds: readonly string[],
): PlanLine | null {
  if (!info) return null;
  const max = info.limits.nodes;
  if (max !== null && max > 0) {
    const used = info.usage.nodes;
    const share = Math.min(1, used / max);
    return { kind: 'limited', plan: info.plan, used, max, share, warn: share >= PLAN_WARN_SHARE };
  }
  const onlyKubernetes = kinds.length > 0 && kinds.every((k) => k === 'kubernetes');
  return {
    kind: 'unlimited',
    plan: info.plan,
    count: info.usage.nodes,
    unit: onlyKubernetes ? 'nodes' : 'servers',
    days: info.limits.retentionDays,
  };
}
