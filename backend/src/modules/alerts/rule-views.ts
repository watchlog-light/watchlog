// SPDX-License-Identifier: AGPL-3.0-only
// Alert rules as the API shows them, and validation of changes (ADR-083, ADR-085).
import type { Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { AlertRules } from '../../db/types.js';
import { metricUnit } from '../query/catalog.js';
import type { Condition } from './defaults.js';
import { conditionError, metricKinds } from './conditions.js';
import { DEFAULT_RULES } from './rules.js';

export type RuleRowView = Selectable<AlertRules>;

const BY_KEY = new Map(DEFAULT_RULES.map((r) => [r.key, r]));

export function ruleView(r: RuleRowView, firing: number) {
  const def = r.rule_key ? BY_KEY.get(r.rule_key) : undefined;
  const metricRule = def ? !!def.condition : true;
  const unit = def ? (def.unit ?? null) : r.metric ? metricUnit(r.metric) : null;
  const cond = r.condition as Partial<Condition>;
  return {
    id: r.id,
    type: r.type as 'default' | 'threshold',
    ruleKey: r.rule_key,
    name: r.name,
    source: (metricRule ? 'metric' : 'state') as 'metric' | 'state',
    unit,
    metric: r.metric,
    clusterId: r.cluster_id,
    appliesTo: def ? [...def.evaluator.kinds] : r.metric ? metricKinds(r.metric) : [],
    scope: (r.scope ?? {}) as Record<string, never>,
    condition:
      metricRule && cond.op && typeof cond.value === 'number'
        ? {
            op: cond.op,
            value: cond.value,
            ...(typeof cond.critical === 'number' ? { critical: cond.critical } : {}),
          }
        : null,
    forSeconds: r.for_seconds,
    renotifySeconds: r.renotify_seconds,
    severity: r.severity as 'warning' | 'critical',
    enabled: r.enabled,
    channelIds: r.channel_ids,
    firing,
    evalError: r.eval_error,
  };
}

export interface RuleChange {
  name?: string;
  enabled?: boolean;
  forSeconds?: number;
  renotifySeconds?: number;
  severity?: 'warning' | 'critical';
  condition?: Condition;
  channelIds?: string[];
  clusterId?: string | null;
  scope?: Record<string, unknown>;
}

/** Checks a change against the rule and the org; returns the columns to set. */
export async function validateRuleChange(
  db: Database,
  orgId: string,
  rule: RuleRowView,
  body: RuleChange,
): Promise<{ set: Partial<Record<string, unknown>> } | { error: string }> {
  const view = ruleView(rule, 0);
  const set: Record<string, unknown> = {};
  if (body.name !== undefined && body.name !== rule.name) {
    if (rule.type === 'default') return { error: 'Default rules keep their name' };
    set.name = body.name;
  }
  if (body.condition !== undefined) {
    if (view.source !== 'metric') return { error: 'This rule has no threshold to change' };
    const err = conditionError(body.condition, view.unit);
    if (err) return { error: err };
    set.condition = JSON.stringify(body.condition);
  }
  if (body.scope !== undefined) {
    if (rule.type === 'default') return { error: 'Default rules apply to whole clusters' };
    set.scope = JSON.stringify(body.scope);
  }
  if (body.channelIds !== undefined) {
    const ids = [...new Set(body.channelIds)];
    if (ids.length) {
      const found = await db
        .selectFrom('alert_channels')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', 'in', ids)
        .execute();
      if (found.length !== ids.length) return { error: 'Unknown channel' };
    }
    set.channel_ids = ids;
  }
  if (body.clusterId !== undefined) {
    if (body.clusterId !== null) {
      const c = await db
        .selectFrom('clusters')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', body.clusterId)
        .executeTakeFirst();
      if (!c) return { error: 'Unknown cluster' };
    }
    set.cluster_id = body.clusterId;
  }
  if (body.enabled !== undefined) set.enabled = body.enabled;
  if (body.forSeconds !== undefined) set.for_seconds = body.forSeconds;
  if (body.renotifySeconds !== undefined) set.renotify_seconds = body.renotifySeconds;
  if (body.severity !== undefined) set.severity = body.severity;
  if (Object.keys(set).length) set.eval_error = null;
  return { set };
}
