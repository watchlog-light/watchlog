// SPDX-License-Identifier: AGPL-3.0-only
// Default rules for certificates and scheduled jobs (0.10.0, ADR-225), Kubernetes and Servers
// alike: the agents' series through the rules engine like any metric rule, each hit enriched
// from what the backend stored (names, expiry, where served, exit code, last good run), so the
// message says what, where, since when and what to do. One alert per certificate identity
// and problem, per job; the next good run or a new certificate resolves it.
import type { Database } from '../../db/index.js';
import type { MetricKey } from '../query/catalog.js';
import type { DefaultRule } from './defaults.js';
import type { EvalContext, RuleEvaluator } from './engine.js';
import { queryThreshold, type ThresholdHit } from './metric-rules.js';
import type { Observation } from './state-machine.js';
import type { Condition } from './defaults.js';

const DAY = 86_400;

interface CertRow {
  node: string;
  cert_id: string;
  names: string[];
  issuer: string;
  issuer_org: string;
  not_after: Date;
  chain: string;
  name_mismatch: string[];
  endpoints: unknown;
}

interface JobRow {
  node: string;
  job_id: string;
  name: string;
  kind: string;
  schedule: string;
  frequent: boolean;
  failed_streak: number;
  last_good_at: Date | null;
  missed_at: Date | null;
  missed_why: string | null;
  usual_seconds: number | null;
  every_sec: string | number | bigint;
}

function certs(ctx: EvalContext): Promise<Map<string, CertRow>> {
  return ctx.memo(`certs:${ctx.cluster.id}`, async () => {
    const rows = await ctx.db
      .selectFrom('certificates')
      .select([
        'node',
        'cert_id',
        'names',
        'issuer',
        'issuer_org',
        'not_after',
        'chain',
        'name_mismatch',
        'endpoints',
      ])
      .where('cluster_id', '=', ctx.cluster.id)
      .where('current', '=', true)
      .limit(20_000)
      .execute();
    return new Map(rows.map((r) => [`${r.node}/${r.cert_id}`, r as CertRow]));
  });
}

function jobs(ctx: EvalContext): Promise<Map<string, JobRow>> {
  return ctx.memo(`jobs:${ctx.cluster.id}`, () => loadJobs(ctx.db, ctx.cluster.id));
}

async function loadJobs(db: Database, clusterId: string): Promise<Map<string, JobRow>> {
  const rows = await db
    .selectFrom('scheduled_jobs')
    .select([
      'node',
      'job_id',
      'name',
      'kind',
      'schedule',
      'frequent',
      'failed_streak',
      'last_good_at',
      'missed_at',
      'missed_why',
      'usual_seconds',
      'every_sec',
    ])
    .where('cluster_id', '=', clusterId)
    .where('gone_at', 'is', null)
    .limit(20_000)
    .execute();
  return new Map(rows.map((r) => [`${r.node}/${r.job_id}`, r as JobRow]));
}

/** The last ended run of a job, for its exit code and duration. */
async function lastRun(ctx: EvalContext, node: string, jobId: string) {
  return ctx.db
    .selectFrom('job_runs')
    .select(['started_at', 'ended_at', 'code', 'result'])
    .where('cluster_id', '=', ctx.cluster.id)
    .where('node', '=', node)
    .where('job_id', '=', jobId)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);

/** Where a certificate is served, for the message: "nginx.service :443", "shop/web (shop.wl.test)". */
function servedAt(eps: unknown): string[] {
  if (!Array.isArray(eps)) return [];
  return eps
    .slice(0, 3)
    .map((e: { kind?: string; workload?: string; port?: number; sni?: string }) =>
      e.kind === 'Ingress'
        ? `Ingress ${e.workload ?? '?'}${e.sni ? ` (${e.sni})` : ''}`
        : `${e.workload ?? '?'} :${e.port ?? '?'}`,
    );
}

function evaluator(
  key: MetricKey,
  observe: (ctx: EvalContext, hit: ThresholdHit) => Promise<Observation | null>,
): RuleEvaluator {
  return {
    kinds: ['kubernetes', 'server'],
    async evaluate(ctx) {
      const hits = await queryThreshold(ctx, key, {});
      const out: Observation[] = [];
      for (const hit of hits) {
        const o = await observe(ctx, hit);
        if (o) out.push(o);
      }
      return out;
    },
  };
}

function thresholds(ctx: EvalContext) {
  const c = ctx.rule.condition as unknown as Condition;
  return {
    threshold: c.value,
    ...(c.critical !== undefined ? { critical: c.critical } : {}),
    forSeconds: ctx.rule.for_seconds,
  };
}

/** A certificate's labels: the server it was read on (Servers), its first name. */
function certLabels(l: Record<string, string>) {
  return { ...(l.host ? { node: l.host } : {}), certificate: l.cert ?? '' };
}

/** A job's labels: its server and name (Servers), its namespace and CronJob (Kubernetes). */
function jobLabels(ctx: EvalContext, l: Record<string, string>): Record<string, string> {
  if (ctx.cluster.kind === 'kubernetes') {
    return { namespace: l.namespace ?? '', workload: l.job ?? '', workload_kind: 'CronJob' };
  }
  return { node: l.host ?? '', job: l.job ?? '' };
}

/** The stored job of a hit: a cluster's are stored under node '' and named namespace/name. */
async function jobOf(ctx: EvalContext, l: Record<string, string>) {
  const node = ctx.cluster.kind === 'kubernetes' ? '' : (l.host ?? '');
  return (await jobs(ctx)).get(`${node}/${l.job_id ?? ''}`) ?? null;
}

export const CERT_JOB_RULES: DefaultRule[] = [
  {
    key: 'cert.expiring',
    metric: 'cert.expires_in',
    metrics: { kubernetes: 'cert.expires_in', server: 'cert.expires_in' },
    unit: 'seconds',
    name: 'Certificate expiring',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '<', value: 14 * DAY, critical: 3 * DAY },
    evaluator: evaluator('cert.expires_in', async (ctx, hit) => {
      const l = hit.labels;
      if (!l.cert_id) return null;
      const row = (await certs(ctx)).get(`${l.host ?? ''}/${l.cert_id}`);
      const notAfter = row ? new Date(row.not_after).getTime() / 1000 : ctx.now / 1000 + hit.value;
      return {
        fingerprint: `cert:${l.host ?? ''}/${l.cert_id}`,
        labels: certLabels(l),
        severity: hit.severity,
        details: {
          summary: hit.value < 0 ? 'expired' : `expires in ${Math.round(hit.value / DAY)} days`,
          value: hit.value,
          ...thresholds(ctx),
          notAfter: new Date(notAfter * 1000).toISOString(),
          names: row?.names.slice(0, 5) ?? [l.cert ?? ''],
          issuer: row ? row.issuer_org || row.issuer : undefined,
          servedAt: servedAt(row?.endpoints),
          certId: l.cert_id,
        },
      };
    }),
  },
  {
    key: 'cert.problem',
    metric: 'cert.problem',
    metrics: { kubernetes: 'cert.problem', server: 'cert.problem' },
    unit: 'count',
    name: 'Certificate name or chain wrong',
    severity: 'warning',
    forSeconds: 600,
    condition: { op: '>', value: 0 },
    evaluator: evaluator('cert.problem', async (ctx, hit) => {
      const l = hit.labels;
      if (!l.cert_id || (l.problem !== 'name' && l.problem !== 'chain')) return null;
      const row = (await certs(ctx)).get(`${l.host ?? ''}/${l.cert_id}`);
      return {
        fingerprint: `certproblem:${l.host ?? ''}/${l.cert_id}/${l.problem}`,
        labels: { ...certLabels(l), problem: l.problem },
        severity: hit.severity,
        details: {
          summary: l.problem === 'name' ? 'name mismatch' : 'chain incomplete',
          value: hit.value,
          ...thresholds(ctx),
          mismatch: row?.name_mismatch.slice(0, 5) ?? [],
          servedAt: servedAt(row?.endpoints),
          certId: l.cert_id,
        },
      };
    }),
  },
  {
    key: 'job.failed',
    metric: 'job.failed_streak',
    metrics: { kubernetes: 'job.failed_streak', server: 'job.failed_streak' },
    unit: 'count',
    name: 'Scheduled job failed',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '>', value: 0, critical: 2 },
    evaluator: evaluator('job.failed_streak', async (ctx, hit) => {
      const l = hit.labels;
      if (!l.job_id) return null;
      const job = await jobOf(ctx, l);
      // A job every 5 minutes or more often alerts on 3 failures in a row only (ADR-225).
      if (job?.frequent && hit.value < 3) return null;
      const run = job ? await lastRun(ctx, job.node, job.job_id) : undefined;
      return {
        fingerprint: `job:${l.host ?? l.namespace ?? ''}/${l.job_id}`,
        labels: jobLabels(ctx, l),
        severity: hit.severity,
        details: {
          summary: `failed ${Math.round(hit.value)} time(s) in a row`,
          value: hit.value,
          ...thresholds(ctx),
          streak: Math.round(hit.value),
          exitCode: run?.code ?? undefined,
          lastGood: iso(job?.last_good_at),
          everySeconds: job ? Number(job.every_sec) : undefined,
          jobKind: l.kind,
          jobId: l.job_id,
        },
      };
    }),
  },
  {
    key: 'job.missed',
    metric: 'job.missed_runs',
    metrics: { kubernetes: 'job.missed_runs', server: 'job.missed_runs' },
    unit: 'count',
    name: 'Scheduled job missed',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '>', value: 0 },
    evaluator: evaluator('job.missed_runs', async (ctx, hit) => {
      const l = hit.labels;
      if (!l.job_id) return null;
      const job = await jobOf(ctx, l);
      return {
        fingerprint: `jobmissed:${l.host ?? l.namespace ?? ''}/${l.job_id}`,
        labels: jobLabels(ctx, l),
        severity: hit.severity,
        details: {
          summary: `missed ${Math.round(hit.value)} run(s)`,
          value: hit.value,
          ...thresholds(ctx),
          missed: Math.round(hit.value),
          expectedAt: iso(job?.missed_at),
          schedule: job?.schedule,
          lastGood: iso(job?.last_good_at),
          jobKind: l.kind,
          jobId: l.job_id,
        },
      };
    }),
  },
  {
    key: 'job.slow',
    metric: 'job.slow',
    metrics: { kubernetes: 'job.slow', server: 'job.slow' },
    unit: 'count',
    name: 'Scheduled job slow',
    severity: 'warning',
    forSeconds: 0,
    condition: { op: '>', value: 0 },
    evaluator: evaluator('job.slow', async (ctx, hit) => {
      const l = hit.labels;
      if (!l.job_id) return null;
      const job = await jobOf(ctx, l);
      const run = job ? await lastRun(ctx, job.node, job.job_id) : undefined;
      const started = run ? new Date(run.started_at).getTime() : null;
      const ended = run?.ended_at ? new Date(run.ended_at).getTime() : null;
      return {
        fingerprint: `jobslow:${l.host ?? l.namespace ?? ''}/${l.job_id}`,
        labels: jobLabels(ctx, l),
        severity: hit.severity,
        details: {
          summary: 'far longer than usual',
          value: hit.value,
          ...thresholds(ctx),
          running: run?.result === 'running',
          seconds: started === null ? undefined : Math.round(((ended ?? ctx.now) - started) / 1000),
          usualSeconds: job?.usual_seconds ?? undefined,
          jobKind: l.kind,
          jobId: l.job_id,
        },
      };
    }),
  },
];
