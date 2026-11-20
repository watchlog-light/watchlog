// SPDX-License-Identifier: AGPL-3.0-only
// A server's or a cluster's certificates and scheduled jobs (0.10.0, ADR-222 to ADR-224): one
// snapshot from its agent on the objects endpoint, `source: "inventory"`, when it changed and
// every 10 minutes. The agent works out each job's state; the backend keeps what it saw:
// every certificate under an identity (renewals), each job's runs and their hourly counts.
import { Type, type Static } from 'typebox';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const Str = (max: number) => Type.String({ maxLength: max });
const Hex = (n: number) => Type.String({ pattern: `^[0-9a-f]{${n}}$` });
const Unix = Type.Integer({ minimum: 0, maximum: 32503680000 });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Optional(Type.Union([t, Type.Null()]));

const Endpoint = Type.Object({
  kind: Str(32),
  workload: Str(512),
  port: Type.Integer({ minimum: 0, maximum: 65535 }),
  proto: Str(16),
  sni: Type.Optional(Str(253)),
  fingerprint: Hex(64),
  notAfter: Unix,
});

const Certificate = Type.Object({
  id: Hex(16),
  names: Type.Array(Str(253), { minItems: 1, maxItems: 100 }),
  subject: Str(512),
  issuer: Str(512),
  issuerOrg: Type.Optional(Str(512)),
  serial: Str(128),
  notBefore: Unix,
  notAfter: Unix,
  fingerprint: Hex(64),
  keyType: Str(16),
  keyBits: Type.Integer({ minimum: 0, maximum: 65536 }),
  chain: Type.Union([
    Type.Literal('complete'),
    Type.Literal('incomplete'),
    Type.Literal('private'),
    Type.Literal('self-signed'),
  ]),
  nameMismatch: Nullable(Type.Array(Str(253), { maxItems: 100 })),
  endpoints: Nullable(Type.Array(Endpoint, { maxItems: 100 })),
});

const Run = Type.Object({
  start: Unix,
  end: Type.Optional(Unix),
  code: Type.Optional(Type.Integer({ minimum: -1024, maximum: 1024 })),
  result: Type.Union([
    Type.Literal('success'),
    Type.Literal('failed'),
    Type.Literal('running'),
    Type.Literal('unknown'),
  ]),
});

const Job = Type.Object({
  id: Hex(16),
  kind: Type.Union([Type.Literal('timer'), Type.Literal('cron'), Type.Literal('cronjob')]),
  name: Type.String({ minLength: 1, maxLength: 512 }),
  unit: Type.Optional(Str(256)),
  schedule: Type.Optional(Str(256)),
  source: Type.Optional(Str(256)),
  enabled: Type.Boolean(),
  persistent: Type.Optional(Type.Boolean()),
  randomDelaySec: Type.Optional(Type.Integer({ minimum: 0, maximum: 31_536_000 })),
  next: Type.Optional(Unix),
  runs: Nullable(Type.Array(Run, { maxItems: 30 })),
  every: Type.Optional(Type.Integer({ minimum: 0, maximum: 31_622_400 })),
  state: Type.Union([
    Type.Literal('working'),
    Type.Literal('failed'),
    Type.Literal('missed'),
    Type.Literal('slow'),
    Type.Literal('running'),
    Type.Literal('disabled'),
    Type.Literal('new'),
  ]),
  failedStreak: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  lastGood: Type.Optional(Unix),
  missedRuns: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  missedWhy: Type.Optional(
    Type.Union([
      Type.Literal('not-run'),
      Type.Literal('server-off'),
      Type.Literal('timer-off'),
      Type.Literal('agent-stopped'),
    ]),
  ),
  missedAt: Type.Optional(Unix),
  usualSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  frequent: Type.Optional(Type.Boolean()),
});

const Coverage = Type.Object({}, { additionalProperties: true, maxProperties: 32 });

export const InventoryBody = Type.Object({
  source: Type.Literal('inventory'),
  node: Type.String({ maxLength: 253 }),
  certificates: Nullable(Type.Array(Certificate, { maxItems: 100 })),
  certificateCoverage: Nullable(Coverage),
  jobs: Nullable(Type.Array(Job, { maxItems: 100 })),
  jobCoverage: Nullable(Coverage),
});
export type Inventory = Static<typeof InventoryBody>;

/** Runs kept a job, and a frequent job's (ADR-224); runs and hours older than 30 days go. */
export const RUNS_KEPT = 100;
export const FREQUENT_RUNS_KEPT = 14;
const KEEP_DAYS = 30;
/** A job no longer sent is deleted with its runs a week later; old certificates in a year. */
const GONE_JOB_DAYS = 7;
const OLD_CERT_DAYS = 400;

const toDate = (s: number | undefined) => (s ? new Date(s * 1000) : null);

/**
 * Stores one snapshot. Certificates are replaced only once the agent has finished a round
 * (coverage `at` > 0), so its first snapshot after a start doesn't hide them; jobs when the
 * snapshot has a jobs list.
 */
export async function storeInventory(
  db: Database,
  clusterId: string,
  orgId: string,
  body: Inventory,
  now = new Date(),
): Promise<void> {
  const node = body.node;
  const certRound = Number((body.certificateCoverage as { at?: number } | null)?.at ?? 0) > 0;
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('inventory_coverage')
      .values({
        org_id: orgId,
        cluster_id: clusterId,
        node,
        certificates: certRound ? JSON.stringify(body.certificateCoverage) : null,
        jobs: body.jobCoverage ? JSON.stringify(body.jobCoverage) : null,
        received_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'node']).doUpdateSet((eb) => ({
          certificates: certRound
            ? eb.ref('excluded.certificates')
            : eb.ref('inventory_coverage.certificates'),
          jobs: eb.ref('excluded.jobs'),
          received_at: eb.ref('excluded.received_at'),
        })),
      )
      .execute();

    if (certRound)
      await storeCertificates(trx, clusterId, orgId, node, body.certificates ?? [], now);
    if (body.jobs) await storeJobs(trx, clusterId, orgId, node, body.jobs, now);
  });
}

async function storeCertificates(
  trx: Database,
  clusterId: string,
  orgId: string,
  node: string,
  certs: Static<typeof Certificate>[],
  now: Date,
): Promise<void> {
  const current = await trx
    .selectFrom('certificates')
    .select(['cert_id', 'fingerprint', 'not_after'])
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('current', '=', true)
    .execute();
  const known = new Set(current.map((c) => `${c.cert_id}/${c.fingerprint}`));
  const sent = new Set(certs.map((c) => `${c.id}/${c.fingerprint}`));
  for (const c of certs) {
    const row = {
      org_id: orgId,
      cluster_id: clusterId,
      node,
      cert_id: c.id,
      fingerprint: c.fingerprint,
      names: c.names,
      subject: c.subject,
      issuer: c.issuer,
      issuer_org: c.issuerOrg ?? '',
      serial: c.serial,
      not_before: new Date(c.notBefore * 1000),
      not_after: new Date(c.notAfter * 1000),
      key_type: c.keyType,
      key_bits: c.keyBits,
      chain: c.chain,
      name_mismatch: c.nameMismatch ?? [],
      endpoints: JSON.stringify(c.endpoints ?? []),
      last_seen: now,
      current: true,
    };
    // A new certificate under a known identity while an older one is current: a renewal.
    let renewal: { renewed_from: string; renewed_days_before: number } | null = null;
    if (!known.has(`${c.id}/${c.fingerprint}`)) {
      const prev = current.find(
        (p) =>
          p.cert_id === c.id &&
          p.fingerprint !== c.fingerprint &&
          !sent.has(`${p.cert_id}/${p.fingerprint}`) &&
          new Date(p.not_after).getTime() < c.notAfter * 1000,
      );
      if (prev) {
        renewal = {
          renewed_from: prev.fingerprint,
          renewed_days_before:
            Math.round(((new Date(prev.not_after).getTime() - now.getTime()) / 86_400_000) * 10) /
            10,
        };
      }
    }
    await trx
      .insertInto('certificates')
      .values({ ...row, ...(renewal ?? {}), first_seen: now })
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'node', 'cert_id', 'fingerprint']).doUpdateSet((eb) => ({
          names: eb.ref('excluded.names'),
          chain: eb.ref('excluded.chain'),
          name_mismatch: eb.ref('excluded.name_mismatch'),
          endpoints: eb.ref('excluded.endpoints'),
          last_seen: eb.ref('excluded.last_seen'),
          current: true,
        })),
      )
      .execute();
  }
  // What this round didn't see is no longer current; a year later it goes.
  const stale = current.filter((c) => !sent.has(`${c.cert_id}/${c.fingerprint}`));
  for (const c of stale) {
    await trx
      .updateTable('certificates')
      .set({ current: false })
      .where('cluster_id', '=', clusterId)
      .where('node', '=', node)
      .where('cert_id', '=', c.cert_id)
      .where('fingerprint', '=', c.fingerprint)
      .execute();
  }
  await trx
    .deleteFrom('certificates')
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('current', '=', false)
    .where('last_seen', '<', new Date(now.getTime() - OLD_CERT_DAYS * 86_400_000))
    .execute();
}

async function storeJobs(
  trx: Database,
  clusterId: string,
  orgId: string,
  node: string,
  jobs: Static<typeof Job>[],
  now: Date,
): Promise<void> {
  if (jobs.length > 0) {
    await trx
      .insertInto('scheduled_jobs')
      .values(
        jobs.map((j) => ({
          org_id: orgId,
          cluster_id: clusterId,
          node,
          job_id: j.id,
          kind: j.kind,
          name: j.name,
          unit: j.unit ?? '',
          schedule: j.schedule ?? '',
          source: j.source ?? '',
          enabled: j.enabled,
          persistent: j.persistent ?? false,
          random_delay_sec: j.randomDelaySec ?? 0,
          next_at: toDate(j.next),
          every_sec: j.every ?? 0,
          state: j.state,
          failed_streak: j.failedStreak,
          last_good_at: toDate(j.lastGood),
          missed_runs: j.missedRuns,
          missed_why: j.missedWhy ?? null,
          missed_at: toDate(j.missedAt),
          usual_seconds: j.usualSeconds ?? null,
          frequent: j.frequent ?? false,
          first_seen: now,
          updated_at: now,
          gone_at: null,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'node', 'job_id']).doUpdateSet((eb) => ({
          kind: eb.ref('excluded.kind'),
          name: eb.ref('excluded.name'),
          unit: eb.ref('excluded.unit'),
          schedule: eb.ref('excluded.schedule'),
          source: eb.ref('excluded.source'),
          enabled: eb.ref('excluded.enabled'),
          persistent: eb.ref('excluded.persistent'),
          random_delay_sec: eb.ref('excluded.random_delay_sec'),
          next_at: eb.ref('excluded.next_at'),
          every_sec: eb.ref('excluded.every_sec'),
          state: eb.ref('excluded.state'),
          failed_streak: eb.ref('excluded.failed_streak'),
          last_good_at: eb.ref('excluded.last_good_at'),
          missed_runs: eb.ref('excluded.missed_runs'),
          missed_why: eb.ref('excluded.missed_why'),
          missed_at: eb.ref('excluded.missed_at'),
          usual_seconds: eb.ref('excluded.usual_seconds'),
          frequent: eb.ref('excluded.frequent'),
          updated_at: eb.ref('excluded.updated_at'),
          gone_at: null,
        })),
      )
      .execute();
  }
  const ids = jobs.map((j) => j.id);
  // Jobs no longer sent: gone now, deleted with their runs a week later.
  let gone = trx
    .updateTable('scheduled_jobs')
    .set({ gone_at: now })
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('gone_at', 'is', null);
  if (ids.length > 0) gone = gone.where('job_id', 'not in', ids);
  await gone.execute();
  const expired = await trx
    .deleteFrom('scheduled_jobs')
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('gone_at', '<', new Date(now.getTime() - GONE_JOB_DAYS * 86_400_000))
    .returning('job_id')
    .execute();
  const deadIds = expired.map((e) => e.job_id);
  if (deadIds.length > 0) {
    for (const table of ['job_runs', 'job_run_hours'] as const) {
      await trx
        .deleteFrom(table)
        .where('cluster_id', '=', clusterId)
        .where('node', '=', node)
        .where('job_id', 'in', deadIds)
        .execute();
    }
  }
  if (ids.length > 0) await storeRuns(trx, clusterId, orgId, node, jobs, now);
}

/**
 * Only runs newer than the newest stored, or stored as running, are written: the agent
 * resends a job's last 30 every snapshot. A run counts in its hour when it is first seen ended.
 */
async function storeRuns(
  trx: Database,
  clusterId: string,
  orgId: string,
  node: string,
  jobs: Static<typeof Job>[],
  now: Date,
): Promise<void> {
  const ids = jobs.map((j) => j.id);
  const stored = await trx
    .selectFrom('job_runs')
    .select(['job_id', 'started_at', 'result'])
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('job_id', 'in', ids)
    .where((eb) =>
      eb.or([
        eb('result', '=', 'running'),
        eb(
          'started_at',
          '=',
          eb
            .selectFrom('job_runs as r2')
            .select((e) => e.fn.max('r2.started_at').as('m'))
            .whereRef('r2.cluster_id', '=', 'job_runs.cluster_id')
            .whereRef('r2.node', '=', 'job_runs.node')
            .whereRef('r2.job_id', '=', 'job_runs.job_id'),
        ),
      ]),
    )
    .execute();
  const newest = new Map<string, number>();
  const running = new Set<string>();
  for (const r of stored) {
    const t = new Date(r.started_at).getTime() / 1000;
    newest.set(r.job_id, Math.max(newest.get(r.job_id) ?? 0, t));
    if (r.result === 'running') running.add(`${r.job_id}/${t}`);
  }
  const write: {
    job: Static<typeof Job>;
    run: Static<typeof Run>;
    ended: boolean;
  }[] = [];
  for (const j of jobs) {
    for (const r of j.runs ?? []) {
      const key = `${j.id}/${r.start}`;
      const isNew = r.start > (newest.get(j.id) ?? 0);
      const wasRunning = running.has(key);
      if (!isNew && !(wasRunning && r.result !== 'running')) continue;
      write.push({ job: j, run: r, ended: r.result !== 'running' });
    }
  }
  if (write.length === 0) return;
  await trx
    .insertInto('job_runs')
    .values(
      write.map(({ job, run }) => ({
        org_id: orgId,
        cluster_id: clusterId,
        node,
        job_id: job.id,
        started_at: new Date(run.start * 1000),
        ended_at: toDate(run.end),
        code: run.code ?? null,
        result: run.result,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['cluster_id', 'node', 'job_id', 'started_at']).doUpdateSet((eb) => ({
        ended_at: eb.ref('excluded.ended_at'),
        code: eb.ref('excluded.code'),
        result: eb.ref('excluded.result'),
      })),
    )
    .execute();

  // Hourly counts of the runs that ended (by the hour they started).
  const hours = new Map<
    string,
    { job: string; hour: Date; runs: number; failures: number; longest: number }
  >();
  for (const { job, run, ended } of write) {
    if (!ended) continue;
    const hour = new Date(Math.floor(run.start / 3600) * 3600 * 1000);
    const k = `${job.id}/${hour.getTime()}`;
    const h = hours.get(k) ?? { job: job.id, hour, runs: 0, failures: 0, longest: 0 };
    h.runs++;
    if (run.result === 'failed') h.failures++;
    if (run.end) h.longest = Math.max(h.longest, run.end - run.start);
    hours.set(k, h);
  }
  if (hours.size > 0) {
    await trx
      .insertInto('job_run_hours')
      .values(
        [...hours.values()].map((h) => ({
          org_id: orgId,
          cluster_id: clusterId,
          node,
          job_id: h.job,
          hour: h.hour,
          runs: h.runs,
          failures: h.failures,
          longest_seconds: h.longest,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['cluster_id', 'node', 'job_id', 'hour']).doUpdateSet(() => ({
          runs: sql`job_run_hours.runs + excluded.runs`,
          failures: sql`job_run_hours.failures + excluded.failures`,
          longest_seconds: sql`greatest(job_run_hours.longest_seconds, excluded.longest_seconds)`,
        })),
      )
      .execute();
  }

  // Keep 100 runs a job (14 for a frequent one) and 30 days; hours 30 days.
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
  const touched = [...new Set(write.map((w) => w.job.id))];
  const frequent = new Set(jobs.filter((j) => j.frequent).map((j) => j.id));
  await sql`
    DELETE FROM job_runs r
     USING (
       SELECT cluster_id, node, job_id, started_at,
              row_number() OVER (PARTITION BY job_id ORDER BY started_at DESC) AS n
         FROM job_runs
        WHERE cluster_id = ${clusterId} AND node = ${node} AND job_id = ANY(${touched}::text[])
     ) old
     WHERE r.cluster_id = old.cluster_id AND r.node = old.node AND r.job_id = old.job_id
       AND r.started_at = old.started_at
       AND (old.started_at < ${cutoff}::timestamptz
            OR old.n > CASE WHEN old.job_id = ANY(${[...frequent]}::text[]) THEN ${FREQUENT_RUNS_KEPT}::int
                            ELSE ${RUNS_KEPT}::int END)`.execute(trx);
  await trx
    .deleteFrom('job_run_hours')
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('job_id', 'in', touched)
    .where('hour', '<', cutoff)
    .execute();
}
