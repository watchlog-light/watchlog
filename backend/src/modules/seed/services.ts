// SPDX-License-Identifier: AGPL-3.0-only
// Services a seed file monitors (ADR-142): the demo's Redis and PostgreSQL on its kind
// cluster and Docker host, monitored as soon as the agents report them, with passwords
// referenced from a Secret or a host file (ADR-133), never in the seed. Each entry is
// applied once per cluster where it is found: a service someone stops monitoring isn't
// added back, and one already monitored by hand keeps its access, unless it has none.
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { createServiceRules } from '../integrations/alert-defaults.js';
import type { IntegrationTarget, IntegrationType } from '../integrations/collector-config.js';
import { INTEGRATION_TYPES } from '../integrations/collector-config.js';
import { collectorIdentity } from '../integrations/connect.js';
import { recordEvent } from '../integrations/credentials.js';
import { discover, targetKey } from '../integrations/discovery.js';
import type { ConfigNotifier } from '../integrations/notifier.js';

const Name = Type.String({ minLength: 1, maxLength: 253 });

export const SeedServiceSchema = Type.Object(
  {
    /** The kind of cluster it runs on. */
    clusterKind: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
    /** A cluster's name or id; left out, every cluster of that kind where it is found. */
    cluster: Type.Optional(Name),
    /** redis, postgres, …; checked against the integration types when applied. */
    type: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z]+$' }),
    /** As the Applications page lists it: "shop/postgres", "storefront/db". */
    name: Name,
    /** A password kept outside WatchLog (ADR-134 option c): never the password itself. */
    access: Type.Optional(
      Type.Object(
        {
          username: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
          /** Kubernetes: a Secret in the collector's namespace. */
          secret: Type.Optional(
            Type.Object({ name: Name, key: Name }, { additionalProperties: false }),
          ),
          /** Docker: a file under /etc/watchlog/secrets on the host. */
          file: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 128,
              pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]*$',
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    /** Default alert keys that start on (the rest are created off). */
    defaultAlerts: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
  },
  { additionalProperties: false },
);
export type SeedService = Static<typeof SeedServiceSchema>;

export interface SeedServicesResult {
  monitored: string[];
  accessAdded: string[];
  failed: { name: string; reason: string }[];
}

export interface SeedServicesLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const entryKey = (s: SeedService) => `${s.clusterKind}/${s.cluster ?? '*'}/${s.type}/${s.name}`;

/** Monitors each seeded service found and not applied yet; safe to run again and again. */
export async function applySeedServices(
  db: Database,
  services: SeedService[],
  notifier: ConfigNotifier | undefined,
  log: SeedServicesLogger,
): Promise<SeedServicesResult> {
  const result: SeedServicesResult = { monitored: [], accessAdded: [], failed: [] };
  if (services.length === 0) return result;
  const org = await db
    .selectFrom('orgs')
    .select('id')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!org) return result;
  const applied = new Set(
    (
      await db.selectFrom('seed_services').select('seed_key').where('org_id', '=', org.id).execute()
    ).map((r) => r.seed_key),
  );
  const found = await discover(db, org.id);
  const monitored = await db
    .selectFrom('integrations as i')
    .leftJoin('integration_credentials as c', 'c.integration_id', 'i.id')
    .select(['i.id', 'i.cluster_id', 'i.type', 'i.target', 'i.name', 'c.method'])
    .where('i.org_id', '=', org.id)
    .execute();
  const clusters = await db
    .selectFrom('clusters')
    .select(['id', 'name', 'kind'])
    .where('org_id', '=', org.id)
    .execute();

  for (const s of services) {
    if (!(INTEGRATION_TYPES as readonly string[]).includes(s.type)) {
      result.failed.push({ name: s.name, reason: `no integration type ${s.type}` });
      continue;
    }
    const type = s.type as IntegrationType;
    const inScope = clusters.filter(
      (c) =>
        c.kind === s.clusterKind && (s.cluster === undefined || [c.id, c.name].includes(s.cluster)),
    );
    for (const c of inScope) {
      const key = `${entryKey(s)}@${c.id}`;
      if (applied.has(key)) continue;
      // Monitored by hand already: keep it; give it the seeded access only if it has none.
      const mine = monitored.find(
        (m) => m.cluster_id === c.id && m.type === type && m.name === s.name,
      );
      if (mine) {
        if (s.access && !mine.method) {
          await addAccess(db, c.id, mine.id, s.access);
          await recordEvent(db, {
            orgId: org.id,
            integrationId: mine.id,
            action: 'credential_set',
            details: { method: 'reference', via: 'seed' },
          });
          result.accessAdded.push(s.name);
          notifier?.notify(c.id);
        }
        await markApplied(db, org.id, key, mine.id);
        continue;
      }
      const d = found.find((x) => x.clusterId === c.id && x.type === type && x.name === s.name);
      if (!d) continue; // not reported yet, or ignored: tried again on the next round
      const target = d.target as IntegrationTarget;
      if (targetKey(c.id, type, target) !== d.key) continue;
      const id = newId();
      await db
        .insertInto('integrations')
        .values({
          id,
          org_id: org.id,
          cluster_id: c.id,
          type,
          name: d.name,
          target: JSON.stringify(target),
          collector_host:
            target.kind === 'compose' || target.kind === 'container' ? target.host : '',
        })
        .execute();
      if (s.access) await addAccess(db, c.id, id, s.access);
      await recordEvent(db, {
        orgId: org.id,
        integrationId: id,
        action: 'monitored',
        details: { via: 'seed' },
      });
      await createServiceRules(db, org.id, { id, clusterId: c.id, type }, s.defaultAlerts ?? []);
      await markApplied(db, org.id, key, id);
      notifier?.notify(c.id);
      result.monitored.push(`${c.name} ${d.name}`);
    }
  }
  for (const m of result.monitored) log.info({ service: m }, 'seed: service monitored');
  for (const m of result.accessAdded)
    log.info({ service: m }, 'seed: access added to a monitored service');
  for (const f of result.failed)
    log.warn({ service: f.name, reason: f.reason }, 'seed: service skipped');
  return result;
}

async function addAccess(
  db: Database,
  clusterId: string,
  integrationId: string,
  a: NonNullable<SeedService['access']>,
) {
  const reference = a.secret
    ? { secret: { namespace: (await collectorIdentity(db, clusterId)).namespace, ...a.secret } }
    : a.file
      ? { file: a.file }
      : null;
  await db
    .insertInto('integration_credentials')
    .values({
      integration_id: integrationId,
      method: 'reference',
      username: a.username ?? null,
      ciphertext: null,
      reference: reference ? JSON.stringify(reference) : null,
      set_by: null,
    })
    .onConflict((oc) => oc.column('integration_id').doNothing())
    .execute();
}

async function markApplied(db: Database, orgId: string, key: string, integrationId: string) {
  await db
    .insertInto('seed_services')
    .values({ org_id: orgId, seed_key: key, integration_id: integrationId })
    .onConflict((oc) => oc.columns(['org_id', 'seed_key']).doNothing())
    .execute();
}
