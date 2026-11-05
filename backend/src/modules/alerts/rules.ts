// SPDX-License-Identifier: AGPL-3.0-only
// The default rules of every org (ADR-084) and the evaluator lookup: by rule_key for
// defaults, by metric for threshold rules (ADR-085, slice 7).
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { STATE_RULES, type DefaultRule } from './defaults.js';
import type { EvaluatorLookup } from './engine.js';
import { METRIC_RULES } from './metric-rules.js';
import { thresholdEvaluator } from './threshold.js';

export const DEFAULT_RULES: DefaultRule[] = [...STATE_RULES, ...METRIC_RULES];
const BY_KEY = new Map(DEFAULT_RULES.map((r) => [r.key, r]));

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
