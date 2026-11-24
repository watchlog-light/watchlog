// SPDX-License-Identifier: AGPL-3.0-only
// The default rules of every org (ADR-084) and the evaluator lookup: by rule_key for
// defaults, by metric for threshold rules (ADR-085, slice 7).
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { STATE_RULES, type DefaultRule } from './defaults.js';
import type { EvaluatorLookup } from './engine.js';
import { METRIC_RULES } from './metric-rules.js';
import { CERT_JOB_RULES } from './certs-jobs-rules.js';
import { EGRESS_RULES } from '../egress/rules.js';
import { ANOMALY_RULE } from '../anomaly/alerts.js';
import { thresholdEvaluator, type ThresholdScope } from './threshold.js';
import { addModuleRules } from './module-rules.js';
import type { Condition } from './defaults.js';

/** The default rules every org gets. */
export const DEFAULT_RULES: DefaultRule[] = [
  ...STATE_RULES,
  ...METRIC_RULES,
  ...CERT_JOB_RULES,
  ...EGRESS_RULES,
];
/**
 * Every default rule by key, with the ones only some orgs get: the anomaly rule, added only
 * to orgs with What changed by its own upkeep (ADR-200).
 */
const BY_KEY = new Map([...DEFAULT_RULES, ANOMALY_RULE].map((r) => [r.key, r]));

/** Default rules from Enterprise modules (ADR-233, module-rules.ts), by key too. */
export function registerModuleRules(rules: DefaultRule[]): void {
  addModuleRules(rules);
  for (const r of rules) BY_KEY.set(r.key, r);
}
export const defaultRuleOf = (key: string | null | undefined): DefaultRule | undefined =>
  key ? BY_KEY.get(key) : undefined;

export const lookupEvaluator: EvaluatorLookup = (rule) => {
  if (rule.rule_key) return BY_KEY.get(rule.rule_key)?.evaluator;
  return rule.type === 'threshold' && rule.metric ? thresholdEvaluator(rule.metric) : undefined;
};

/**
 * Inserts the default rules an org does not have yet, enabled and without channels.
 * Existing rows are left alone, so the user's edits stay; defaults added by a later
 * version appear on the next cycle.
 */
export async function ensureDefaultRules(
  db: Database,
  orgId: string,
  rules: DefaultRule[] = DEFAULT_RULES,
): Promise<void> {
  if (rules.length === 0) return;
  await db
    .insertInto('alert_rules')
    .values(
      rules.map((r) => ({
        id: newId(),
        org_id: orgId,
        name: r.name,
        type: 'default',
        rule_key: r.key,
        metric: r.metric ?? null,
        condition: JSON.stringify(r.condition ?? {}),
        for_seconds: r.forSeconds,
        severity: r.severity,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['org_id', 'rule_key']).where('rule_key', 'is not', null).doNothing(),
    )
    .execute();
}

/** A custom threshold rule as POST /alert-rules and the seed file (ADR-122) give it. */
export interface ThresholdRuleInput {
  name: string;
  metric: string;
  clusterId: string | null;
  scope: ThresholdScope;
  condition: Condition;
  forSeconds: number;
  renotifySeconds?: number;
  severity: 'warning' | 'critical';
  enabled?: boolean;
  channelIds: string[];
  /** A monitored service's default this rule came from, for "Reset to default". */
  defaultKey?: string;
}

/** Inserts a threshold rule that is already validated; returns its id. */
export async function insertThresholdRule(
  db: Database,
  orgId: string,
  b: ThresholdRuleInput,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('alert_rules')
    .values({
      id,
      org_id: orgId,
      cluster_id: b.clusterId,
      name: b.name,
      type: 'threshold',
      metric: b.metric,
      scope: JSON.stringify(b.scope),
      condition: JSON.stringify(b.condition),
      for_seconds: b.forSeconds,
      renotify_seconds: b.renotifySeconds ?? 14400,
      severity: b.severity,
      enabled: b.enabled ?? true,
      channel_ids: b.channelIds,
      default_key: b.defaultKey ?? null,
    })
    .execute();
  return id;
}
