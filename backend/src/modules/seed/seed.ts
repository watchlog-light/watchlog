// SPDX-License-Identifier: AGPL-3.0-only
// Configuration applied at start from a file (WATCHLOG_SEED_FILE, ADR-122), not through
// the API: how the read-only demo, which refuses every change, gets its alert rules and
// its public MCP token (ADR-130, modules/demo/mcp-token.ts).
// Each rule is created once, matched by name, and never overwritten; a rule named in
// `retiredRules` is deleted at start, with its alerts (ADR-229).
import { ClusterKindInput, normalizeKind } from '../clusters/schemas.js';
import { readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { Type, type Static } from 'typebox';
import Value from 'typebox/value';
import type { Database } from '../../db/index.js';
import { ConditionSchema, Severity, ThresholdScopeSchema } from '../alerts/schemas.js';
import { insertThresholdRule } from '../alerts/rules.js';
import { validateThreshold } from '../alerts/threshold.js';
import { SeedOwnMetricsSchema } from './own-metrics.js';
import { SeedServiceSchema } from './services.js';
import { ensureTokenCluster } from '../clusters/bootstrap.js';

/** A threshold rule as POST /alert-rules takes it; the cluster by id or by name, no channels. */
const SeedRuleSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    metric: Type.String({ minLength: 1, maxLength: 100 }),
    /** null: every cluster; else a cluster's id or name. */
    clusterId: Type.Union([Type.String({ minLength: 1, maxLength: 63 }), Type.Null()]),
    scope: ThresholdScopeSchema,
    condition: ConditionSchema,
    forSeconds: Type.Integer({ minimum: 0, maximum: 86400 }),
    renotifySeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604800 })),
    severity: Severity,
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** The live demo's public MCP token and its limits (ADR-130); used only in demo mode. */
const SeedDemoMcpSchema = Type.Object(
  {
    /** A token value as API tokens have it: published, so any value of that shape. */
    token: Type.String({ pattern: '^wl_pat_[A-Za-z0-9_-]{43}$' }),
    visitorCallsPerMinute: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    totalCallsPerMinute: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

/**
 * The live demo's guided tour (1.3.0, ADR-246): its stories in the order the tour tries them,
 * each a scripted failure the demo runs, found among the open alerts by its rule (key or name)
 * and label values; the first open one with a Likely cause is told, else the story marked as
 * the fallback (a failure that never heals). `another` lists the stories offered at the end.
 * The words are the web's (i18n, by story id); used only in demo mode.
 */
const SeedTourStorySchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }),
    kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]),
    /** The alert rule's key or, for rules without one, its name. */
    rules: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 5 }),
    labels: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z_]{1,40}$' }), Type.String({ maxLength: 200 })),
    ),
    fallback: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const SeedDemoTourSchema = Type.Object(
  {
    stories: Type.Array(SeedTourStorySchema, { minItems: 1, maxItems: 20 }),
    another: Type.Optional(
      Type.Array(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }), { maxItems: 6 }),
    ),
  },
  { additionalProperties: false },
);
export type DemoTour = Static<typeof SeedDemoTourSchema>;

/**
 * A cluster or Docker fleet the seed registers with its agents' token (ADR-170): the
 * demo's Docker host, whose agents run outside the chart. Only the token's SHA-256 and
 * its prefix are in the seed; the token stays with the agents.
 */
const SeedClusterSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' }),
    kind: ClusterKindInput,
    /** The cluster token's SHA-256, 64 hex characters. */
    tokenSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    /** The 8 characters after `wl_ct_`, which find the token. */
    tokenPrefix: Type.String({ pattern: '^[A-Za-z0-9_-]{8}$' }),
  },
  { additionalProperties: false },
);

export const SeedSchema = Type.Object(
  {
    clusters: Type.Optional(Type.Array(SeedClusterSchema, { maxItems: 20 })),
    alertRules: Type.Optional(Type.Array(SeedRuleSchema, { maxItems: 200 })),
    /**
     * Names of threshold rules an earlier seed created and this one retires (ADR-229): deleted
     * at every start, with their alerts. Seeded rules are never overwritten, so this is how a
     * seeded install drops one without starting over.
     */
    retiredRules: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 }),
    ),
    /** Services to monitor once the agents report them (ADR-142): seed/services.ts. */
    services: Type.Optional(Type.Array(SeedServiceSchema, { maxItems: 100 })),
    demoMcp: Type.Optional(SeedDemoMcpSchema),
    demoTour: Type.Optional(SeedDemoTourSchema),
    /** Own metrics (ADR-236): a write-only token, dashboards, pins, watching and alert rules. */
    ownMetrics: Type.Optional(SeedOwnMetricsSchema),
    /**
     * Enterprise modules' sections (ADR-233), by module name: each module checks its own
     * (the demo's network devices). Ignored without ee/.
     */
    modules: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z][a-z0-9-]*$' }), Type.Unknown()),
    ),
  },
  { additionalProperties: false },
);
export type Seed = Static<typeof SeedSchema>;

export class SeedFileError extends Error {}

/**
 * Reads and checks the seed file (JSON). An unreadable or invalid file is an error that
 * names the path and the problem: the backend then does not start.
 */
export async function loadSeedFile(path: string): Promise<Seed> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new SeedFileError(`cannot read seed file ${path}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new SeedFileError(`seed file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Value.Check(SeedSchema, value)) {
    const first = [...Value.Errors(SeedSchema, value)].find((e) => e.keyword !== 'boolean');
    const where = first?.instancePath || '/';
    throw new SeedFileError(`seed file ${path} is invalid at ${where}: ${first?.message}`);
  }
  const names = (value.alertRules ?? []).map((r) => r.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new SeedFileError(`seed file ${path} names the rule "${twice}" twice`);
  const retired = new Set(value.retiredRules ?? []);
  const both = names.find((n) => retired.has(n));
  if (both) {
    throw new SeedFileError(`seed file ${path} both seeds and retires the rule "${both}"`);
  }
  const clusters = (value.clusters ?? []).map((c) => c.name);
  const again = clusters.find((n, i) => clusters.indexOf(n) !== i);
  if (again) throw new SeedFileError(`seed file ${path} names the cluster "${again}" twice`);
  return value;
}

export interface SeedResult {
  created: string[];
  existing: string[];
  /** Rules deleted because the seed retires them (ADR-229). */
  retired: string[];
  failed: { name: string; reason: string }[];
  /** No org yet: nothing applied (first-run setup applies it). */
  waiting: boolean;
}

export interface SeedLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates each seeded rule the installation's org does not have yet (a threshold rule
 * with that name). A rule that cannot be created is logged and skipped; the rest go on.
 */
export async function applySeed(db: Database, seed: Seed, log: SeedLogger): Promise<SeedResult> {
  const result: SeedResult = {
    created: [],
    existing: [],
    retired: [],
    failed: [],
    waiting: false,
  };
  // Clusters first: a seeded rule may name one.
  for (const c of seed.clusters ?? []) {
    const outcome = await ensureTokenCluster(db, {
      name: c.name,
      kind: normalizeKind(c.kind),
      hash: Buffer.from(c.tokenSha256, 'hex'),
      prefix: c.tokenPrefix,
    });
    if (outcome === 'created') log.info({ cluster: c.name, kind: c.kind }, 'seed: cluster created');
    if (outcome === 'kind-mismatch') {
      log.error({ cluster: c.name }, `seed: a cluster of that name exists, not of kind ${c.kind}`);
    }
    if (outcome === 'revoked' || outcome === 'deleted') {
      log.info(
        { cluster: c.name, reason: outcome },
        'seed: token revoked or cluster deleted; not recreating it',
      );
    }
  }
  const rules = seed.alertRules ?? [];
  const retiredNames = seed.retiredRules ?? [];
  if (rules.length === 0 && retiredNames.length === 0) return result;
  await db.transaction().execute(async (trx) => {
    // Replicas starting together apply it once.
    await sql`SELECT pg_advisory_xact_lock(hashtext('watchlog:seed'))`.execute(trx);
    const org = await trx
      .selectFrom('orgs')
      .select('id')
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    if (!org) {
      result.waiting = true;
      return;
    }
    // Retired rules go first, with their alerts (the foreign key cascades): only threshold
    // rules, as the seed creates, never a default rule of the same name.
    if (retiredNames.length > 0) {
      const gone = await trx
        .deleteFrom('alert_rules')
        .where('org_id', '=', org.id)
        .where('type', '=', 'threshold')
        .where('name', 'in', retiredNames)
        .returning('name')
        .execute();
      result.retired.push(...gone.map((r) => r.name));
    }
    for (const rule of rules) {
      const exists = await trx
        .selectFrom('alert_rules')
        .select('id')
        .where('org_id', '=', org.id)
        .where('type', '=', 'threshold')
        .where('name', '=', rule.name)
        .executeTakeFirst();
      if (exists) {
        result.existing.push(rule.name);
        continue;
      }
      let clusterId: string | null = null;
      if (rule.clusterId !== null) {
        const ref = rule.clusterId;
        const cluster = await trx
          .selectFrom('clusters')
          .select('id')
          .where('org_id', '=', org.id)
          .where((eb) =>
            UUID.test(ref)
              ? eb.or([eb('id', '=', ref), eb('name', '=', ref)])
              : eb('name', '=', ref),
          )
          .executeTakeFirst();
        if (!cluster) {
          result.failed.push({ name: rule.name, reason: `no cluster "${ref}"` });
          continue;
        }
        clusterId = cluster.id;
      }
      const invalid = await validateThreshold(trx, org.id, {
        metric: rule.metric,
        clusterId,
        scope: rule.scope,
        condition: rule.condition,
      });
      if (invalid) {
        result.failed.push({ name: rule.name, reason: invalid });
        continue;
      }
      await insertThresholdRule(trx, org.id, { ...rule, clusterId, channelIds: [] });
      result.created.push(rule.name);
    }
  });
  if (result.waiting) log.info({}, 'seed: no org yet; the rules are applied after first-run setup');
  for (const name of result.created) log.info({ rule: name }, 'seed: alert rule created');
  for (const name of result.retired) {
    log.info({ rule: name }, 'seed: retired alert rule deleted, with its alerts');
  }
  for (const f of result.failed) {
    log.error({ rule: f.name, reason: f.reason }, 'seed: alert rule not created');
  }
  return result;
}
