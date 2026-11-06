// SPDX-License-Identifier: AGPL-3.0-only
// One evaluation of an org's rules (ADR-072…ADR-077): evaluate each enabled rule per
// cluster, step every fingerprint through the state machine and write the new
// states and their outbox rows in one transaction per rule and cluster.
import { sql, type Selectable } from 'kysely';
import { isUniqueViolation, type Database } from '../../db/index.js';
import type { AlertRules, AlertStates } from '../../db/types.js';
import { newId } from '../../lib/ids.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { clusterReporting, holdFor } from './holding.js';
import { buildOutboxRows, type Transition } from './outbox.js';
import { isSilenced, silenceTarget, type ActiveSilence, type SilenceMatchers } from './silences.js';
import {
  FLAP_WINDOW_MS,
  step,
  type Episode,
  type Observation,
  type Severity,
} from './state-machine.js';
import { INGEST_FAILING_RULE } from './defaults.js';

export type RuleRow = Selectable<AlertRules>;
export type ClusterKind = 'kubernetes' | 'docker';

export interface ClusterRef {
  id: string;
  name: string;
  kind: ClusterKind;
}

export interface EvalContext {
  db: Database;
  victoria?: VictoriaQueryClient;
  rule: RuleRow;
  cluster: ClusterRef;
  now: number;
  /** Shares one load (all pods of a cluster) between the rules of one org cycle. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export interface RuleEvaluator {
  /** Cluster kinds the rule applies to. */
  kinds: readonly ClusterKind[];
  /** The conditions that hold now. Throws when the source cannot be read. */
  evaluate(ctx: EvalContext): Promise<Observation[]>;
}

/** Finds the evaluator of a rule: by rule_key for defaults, by metric for thresholds. */
export type EvaluatorLookup = (rule: RuleRow) => RuleEvaluator | undefined;

export interface EngineDeps {
  db: Database;
  victoria?: VictoriaQueryClient;
  evaluators: EvaluatorLookup;
}

export interface OrgCycleResult {
  evaluated: number;
  transitions: number;
  notifications: number;
  errors: string[];
}

/** Another worker changed a state row after we read it; the rule is retried next cycle. */
class ConcurrentUpdate extends Error {}

export async function evaluateOrg(
  deps: EngineDeps,
  orgId: string,
  now: number,
  stillOwned: () => boolean,
): Promise<OrgCycleResult> {
  const { db } = deps;
  const result: OrgCycleResult = { evaluated: 0, transitions: 0, notifications: 0, errors: [] };
  const [rules, clusters, silences, channels] = await Promise.all([
    db.selectFrom('alert_rules').selectAll().where('org_id', '=', orgId).execute(),
    db
      .selectFrom('clusters')
      .select(['id', 'name', 'kind'])
      .where('org_id', '=', orgId)
      .execute() as Promise<ClusterRef[]>,
    loadSilences(db, orgId, now),
    db.selectFrom('alert_channels').select('id').where('org_id', '=', orgId).execute(),
  ]);
  const channelIds = new Set(channels.map((c) => c.id));
  const loads = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!loads.has(key)) loads.set(key, load());
    return loads.get(key) as Promise<T>;
  };

  await closeDisabledRules(
    db,
    rules.filter((r) => !r.enabled).map((r) => r.id),
    now,
  );

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const evaluator = deps.evaluators(rule);
    if (!evaluator) continue;
    const targets = clusters.filter(
      (c) =>
        (rule.cluster_id === null || rule.cluster_id === c.id) && evaluator.kinds.includes(c.kind),
    );
    let ruleError: string | null = null;
    for (const cluster of targets) {
      if (!stillOwned()) return result;
      // A silent cluster's data is stale: its alerts are held, not evaluated (ADR-094).
      const reporting = await clusterReporting({ db, cluster, now, memo });
      const hold = holdFor(rule.rule_key, reporting);
      let observations: Observation[] = [];
      // Ingest failing explains silent agents (their heartbeats fail), so it is evaluated too.
      if (
        !reporting.allSilent ||
        rule.rule_key === 'agent.not_reporting' ||
        rule.rule_key === INGEST_FAILING_RULE
      ) {
        try {
          observations = await evaluator.evaluate({
            db,
            victoria: deps.victoria,
            rule,
            cluster,
            now,
            memo,
          });
        } catch (err) {
          // A failed source never counts as "condition false" (ADR-072).
          ruleError = `${cluster.name}: ${(err as Error).message}`.slice(0, 500);
          result.errors.push(`${rule.rule_key ?? rule.id} ${ruleError}`);
          continue;
        }
        result.evaluated++;
      }
      try {
        const applied = await applyObservations(
          db,
          orgId,
          { ...rule, channel_ids: rule.channel_ids.filter((id) => channelIds.has(id)) },
          cluster,
          observations,
          silences,
          now,
          hold,
        );
        result.transitions += applied.transitions;
        result.notifications += applied.notifications;
      } catch (err) {
        if (!(err instanceof ConcurrentUpdate)) throw err;
        result.errors.push(`${rule.rule_key ?? rule.id} ${cluster.name}: concurrent update`);
      }
    }
    if (ruleError !== rule.eval_error) {
      await db
        .updateTable('alert_rules')
        .set({ eval_error: ruleError })
        .where('id', '=', rule.id)
        .execute();
    }
  }
  return result;
}

async function loadSilences(db: Database, orgId: string, now: number): Promise<ActiveSilence[]> {
  const rows = await db
    .selectFrom('silences')
    .select(['matchers', 'starts_at', 'ends_at'])
    .where('org_id', '=', orgId)
    .where('ends_at', '>', new Date(now))
    .where('starts_at', '<=', new Date(now))
    .execute();
  return rows.map((r) => ({
    matchers: r.matchers as SilenceMatchers,
    startsAt: new Date(r.starts_at).getTime(),
    endsAt: new Date(r.ends_at).getTime(),
  }));
}

/** A disabled rule's open alerts end without a message; pending ones are dropped. */
async function closeDisabledRules(db: Database, ruleIds: string[], now: number): Promise<void> {
  if (ruleIds.length === 0) return;
  await db
    .deleteFrom('alert_states')
    .where('rule_id', 'in', ruleIds)
    .where('state', '=', 'pending')
    .execute();
  await db
    .updateTable('alert_states')
    .set({ state: 'resolved', resolved_at: new Date(now), version: sql`version + 1` })
    .where('rule_id', 'in', ruleIds)
    .where('state', '=', 'firing')
    .execute();
}

const ms = (t: Date | string | null) => (t === null ? null : new Date(t).getTime());
const date = (t: number | null) => (t === null ? null : new Date(t));

function toEpisode(row: Selectable<AlertStates>): Episode {
  return {
    state: row.state as Episode['state'],
    severity: row.severity as Severity,
    labels: row.labels as Record<string, string>,
    details: row.details as Record<string, unknown>,
    startedAt: ms(row.started_at)!,
    firedAt: ms(row.fired_at),
    resolvedAt: ms(row.resolved_at),
    falseSince: ms(row.false_since),
    falseCycles: row.false_cycles,
    lastNotifiedAt: ms(row.last_notified_at),
    notifiedFiring: row.notified_firing,
    silenced: row.silenced,
    flapping: row.flapping,
    notifySeq: row.notify_seq,
  };
}

/** JSON with sorted keys: jsonb reorders keys, so this makes stored and fresh values comparable. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function episodeColumns(ep: Episode) {
  return {
    state: ep.state,
    severity: ep.severity,
    labels: canonicalJson(ep.labels),
    details: canonicalJson(ep.details),
    started_at: new Date(ep.startedAt),
    fired_at: date(ep.firedAt),
    resolved_at: date(ep.resolvedAt),
    false_since: date(ep.falseSince),
    false_cycles: ep.falseCycles,
    last_notified_at: date(ep.lastNotifiedAt),
    notified_firing: ep.notifiedFiring,
    silenced: ep.silenced,
    flapping: ep.flapping,
    notify_seq: ep.notifySeq,
  };
}

/**
 * The rule as this alert was evaluated (alert detail page): its chart draws these
 * thresholds and says "Rule changed since" when the rule differs now.
 */
export interface RuleSnapshot {
  name: string;
  condition: unknown;
  forSeconds: number;
  severity: string;
  metric: string | null;
  scope: unknown;
}
export function ruleSnapshot(rule: RuleRow): RuleSnapshot {
  return {
    name: rule.name,
    condition: rule.condition,
    forSeconds: rule.for_seconds,
    severity: rule.severity,
    metric: rule.metric,
    scope: rule.scope,
  };
}

/** True when stepping changed nothing worth a write (a quiet firing alert). */
function unchanged(row: Selectable<AlertStates>, ep: Episode): boolean {
  const before = episodeColumns(toEpisode(row));
  const after = episodeColumns(ep);
  return (Object.keys(after) as (keyof typeof after)[]).every(
    (k) => String(before[k]) === String(after[k]),
  );
}

/** Steps every fingerprint of one rule and cluster; one transaction. */
export async function applyObservations(
  db: Database,
  orgId: string,
  rule: RuleRow,
  cluster: ClusterRef,
  observations: Observation[],
  silences: ActiveSilence[],
  now: number,
  hold: ((fingerprint: string, labels: Record<string, string>) => boolean) | null = null,
): Promise<{ transitions: number; notifications: number }> {
  const [open, recent] = await Promise.all([
    db
      .selectFrom('alert_states')
      .selectAll()
      .where('rule_id', '=', rule.id)
      .where('cluster_id', '=', cluster.id)
      .where('state', '<>', 'resolved')
      .execute(),
    db
      .selectFrom('alert_states')
      .select(['fingerprint', (eb) => eb.fn.countAll<string>().as('n')])
      .where('rule_id', '=', rule.id)
      .where('cluster_id', '=', cluster.id)
      .where('fired_at', '>=', new Date(now - FLAP_WINDOW_MS))
      .groupBy('fingerprint')
      .execute(),
  ]);
  const openBy = new Map(open.map((r) => [r.fingerprint, r]));
  const recentBy = new Map(recent.map((r) => [r.fingerprint, Number(r.n)]));
  const obsBy = new Map(observations.map((o) => [o.fingerprint, o]));
  const fingerprints = new Set([...openBy.keys(), ...obsBy.keys()]);

  const forMs = rule.for_seconds * 1000;
  const snapshot = canonicalJson(ruleSnapshot(rule));
  const renotifyMs = rule.renotify_seconds * 1000;
  const silenced = (labels: Record<string, string>, severity: Severity) =>
    isSilenced(silences, silenceTarget(labels, rule.id, cluster.id, severity), now);

  return db
    .transaction()
    .execute(async (trx) => {
      const transitions: Transition[] = [];
      let changed = 0;
      for (const fp of fingerprints) {
        const row = openBy.get(fp);
        const labels = (obsBy.get(fp)?.labels ?? row?.labels ?? {}) as Record<string, string>;
        if (hold?.(fp, labels)) {
          // Held: kept as it is — not stepped, not notified, not resolved (ADR-094). A
          // condition that appears on a held scope waits until the hold ends.
          if (row && !row.held) {
            const upd = await trx
              .updateTable('alert_states')
              .set({ held: true, version: row.version + 1 })
              .where('id', '=', row.id)
              .where('version', '=', row.version)
              .executeTakeFirst();
            if (upd.numUpdatedRows !== 1n) throw new ConcurrentUpdate();
            changed++;
          }
          continue;
        }
        const res = step(row ? toEpisode(row) : null, obsBy.get(fp) ?? null, {
          now,
          forMs,
          renotifyMs,
          silenced,
          recentFirings: recentBy.get(fp) ?? 0,
        });
        if (res.action === 'none') continue;
        if (res.action === 'delete') {
          const del = await trx
            .deleteFrom('alert_states')
            .where('id', '=', row!.id)
            .where('version', '=', row!.version)
            .executeTakeFirst();
          if (del.numDeletedRows !== 1n) throw new ConcurrentUpdate();
          changed++;
          continue;
        }
        let id: string;
        if (res.action === 'insert') {
          id = newId();
          await trx
            .insertInto('alert_states')
            .values({
              id,
              org_id: orgId,
              rule_id: rule.id,
              cluster_id: cluster.id,
              fingerprint: fp,
              ...episodeColumns(res.episode),
              rule_snapshot: snapshot,
            })
            .execute();
        } else {
          id = row!.id;
          if (!res.notify && !row!.held && unchanged(row!, res.episode)) continue;
          const upd = await trx
            .updateTable('alert_states')
            .set({
              ...episodeColumns(res.episode),
              rule_snapshot: snapshot,
              held: false,
              version: row!.version + 1,
            })
            .where('id', '=', id)
            .where('version', '=', row!.version)
            .executeTakeFirst();
          if (upd.numUpdatedRows !== 1n) throw new ConcurrentUpdate();
        }
        if (res.action === 'insert' || res.episode.state !== row!.state || res.notify) changed++;
        if (res.notify) transitions.push({ alertId: id, episode: res.episode, notify: res.notify });
      }

      const rows = buildOutboxRows(orgId, rule, cluster, transitions, now);
      let notifications = 0;
      for (const r of rows) {
        const inserted = await trx
          .insertInto('notifications')
          .values({
            id: r.id,
            org_id: r.org_id,
            channel_id: r.channel_id,
            rule_id: r.rule_id,
            cluster_id: r.cluster_id,
            kind: r.kind,
            payload: JSON.stringify(r.payload),
            dedupe_key: r.dedupe_key,
            next_attempt_at: new Date(now),
          })
          .onConflict((oc) => oc.columns(['channel_id', 'dedupe_key']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!inserted) continue;
        notifications++;
        await trx
          .insertInto('notification_alerts')
          .values(r.alertIds.map((a) => ({ notification_id: r.id, alert_state_id: a })))
          .execute();
      }
      return { transitions: changed, notifications };
    })
    .catch((err: unknown) => {
      // Another worker inserted the same open alert first.
      throw isUniqueViolation(err) ? new ConcurrentUpdate() : err;
    });
}
